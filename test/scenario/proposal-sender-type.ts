import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPub,
} from '../../src/create-commit.js'
import { createProposal } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import {
    proposeAddExternal,
    proposeExternal,
} from '../../src/external-proposal.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import type {
    IncomingMessageCallback,
} from '../../src/incoming-message-action.js'
import type { SenderTypeName } from '../../src/sender.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of sampleCiphersuites()) {
    test('proposal callback sees sender type ' + cs, async (t) => {
        try {
            await senderTypeTest(t, cs)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

function recorder (seen:(SenderTypeName|undefined)[]):IncomingMessageCallback {
    return (incoming) => {
        if (incoming.kind === 'proposal') {
            seen.push(incoming.proposal.senderType)
        } else {
            for (const p of incoming.proposals) seen.push(p.senderType)
        }
        return 'accept'
    }
}

async function kp (name:string, impl:any) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

function asPublic (m:MLSMessage) {
    if (m.wireformat !== 'mls_public_message') {
        throw new Error('expected public message')
    }
    return m
}

async function senderTypeTest (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const alice = await kp('alice', impl)
    const bob = await kp('bob', impl)
    const carol = await kp('carol', impl)
    const dave = await kp('dave', impl)
    const eve = await kp('eve', impl)
    const extCred:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('carol'),
    }
    const ext = {
        extensionType: 'external_senders' as const,
        extensionData: encodeExternalSenders([{
            credential: extCred,
            signaturePublicKey: carol.publicPackage.leafNode.signaturePublicKey,
        }]),
    }

    let aliceGroup = await createGroup(
        new TextEncoder().encode('group1'),
        alice.publicPackage,
        alice.privatePackage,
        [ext],
        impl,
        testClientConfig,
    )
    const addBob = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    aliceGroup = addBob.newState
    const bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig,
    )

    // member proposal
    const bobProp = await createProposal(
        bobGroup,
        true,
        { proposalType: 'remove', remove: { removed: 0 } },
        impl,
    )
    const seenMember:(SenderTypeName|undefined)[] = []
    await processMessage(
        asPublic(bobProp.message),
        aliceGroup,
        emptyPskIndex,
        recorder(seenMember),
        impl,
    )
    t.deepEqual(seenMember, ['member'], 'member proposal reports member')

    const groupInfo = await createGroupInfoWithExternalPub(
        aliceGroup, [], impl)

    // external sender proposal
    const extProp = asPublic(await proposeExternal(
        groupInfo,
        { proposalType: 'add', add: { keyPackage: dave.publicPackage } },
        carol.publicPackage.leafNode.signaturePublicKey,
        carol.privatePackage.signaturePrivateKey,
        impl,
    ))
    const seenExt:(SenderTypeName|undefined)[] = []
    const withExt = await processMessage(
        extProp, aliceGroup, emptyPskIndex, recorder(seenExt), impl)
    t.deepEqual(seenExt, ['external'], 'external proposal reports external')

    // new_member_proposal
    const selfAdd = asPublic(await proposeAddExternal(
        groupInfo, eve.publicPackage, eve.privatePackage, impl))
    const seenNew:(SenderTypeName|undefined)[] = []
    const withNew = await processMessage(
        selfAdd, withExt.newState, emptyPskIndex, recorder(seenNew), impl)
    t.deepEqual(seenNew, ['new_member_proposal'],
        'self-signed add reports new_member_proposal')

    // commit input reports each proposal's sender type
    const bobExt = await processMessage(
        extProp, bobGroup, emptyPskIndex, acceptAll, impl)
    const bobNew = await processMessage(
        selfAdd, bobExt.newState, emptyPskIndex, acceptAll, impl)
    const commit = await createCommit(
        { state: withNew.newState, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: withNew.newState.groupContext.extensions,
                },
            }],
        },
    )
    const seenCommit:(SenderTypeName|undefined)[] = []
    await processMessage(
        commit.commit as any,
        bobNew.newState,
        emptyPskIndex,
        recorder(seenCommit),
        impl,
    )
    t.deepEqual(
        [...seenCommit].sort(),
        ['external', 'member', 'new_member_proposal'],
        'commit input reports each proposal sender type',
    )

    // default callback rejects new_member_proposal
    const bobDefaultExt = await processMessage(
        extProp, bobGroup, emptyPskIndex, undefined, impl)
    t.equal(bobDefaultExt.kind === 'newState' &&
        bobDefaultExt.actionTaken, 'accept',
    'default accepts external sender proposal')
    const bobDefaultMember = await processMessage(
        asPublic(bobProp.message), aliceGroup, emptyPskIndex, undefined, impl)
    t.equal(bobDefaultMember.kind === 'newState' &&
        bobDefaultMember.actionTaken, 'accept',
    'default accepts member proposal')
    const aliceDefault = await processMessage(
        selfAdd, aliceGroup, emptyPskIndex, undefined, impl)
    t.equal(aliceDefault.kind === 'newState' && aliceDefault.actionTaken,
        'reject', 'default rejects new_member_proposal')
    const afterDefault = await createCommit(
        { state: aliceDefault.newState, cipherSuite: impl })
    t.equal(afterDefault.welcome, undefined, 'no Welcome is produced')
    t.equal(afterDefault.newState.ratchetTree.length,
        aliceGroup.ratchetTree.length, 'nobody was added')

    // acceptAll admits the self-add
    const aliceOpen = await processMessage(
        selfAdd, aliceGroup, emptyPskIndex, acceptAll, impl)
    const afterOpen = await createCommit(
        { state: aliceOpen.newState, cipherSuite: impl })
    t.ok(afterOpen.welcome !== undefined, 'acceptAll produces a Welcome')
    await joinGroup(
        afterOpen.welcome!,
        eve.publicPackage,
        eve.privatePackage,
        emptyPskIndex,
        impl,
        afterOpen.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    t.ok(true, 'the proposer joins')
}

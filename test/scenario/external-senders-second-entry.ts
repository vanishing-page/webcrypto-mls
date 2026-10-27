import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPub,
} from '../../src/create-commit.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import { proposeExternal } from '../../src/external-proposal.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { testCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

// Ported from upstream ts-mls: every other external-proposal scenario
// lists one external sender, so a sender index other than 0 is never
// resolved. Here the group lists two, and the second one proposes.

for (const cs of testCiphersuites()) {
    test('a proposal signed by the second of two external senders is ' +
        'accepted and committed - ' + cs, async (t) => {
        let impl:CiphersuiteImpl
        try {
            impl = await getCipherSuite(getCiphersuiteFromName(
                cs as CiphersuiteName))
            await member('probe', impl)
        } catch (error:any) {
            if (error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }

        const a = await member('alice', impl)
        const b = await member('bob', impl)
        const first = await member('first-sender', impl)
        const second = await member('second-sender', impl)
        const eve = await member('eve', impl)

        const solo = await createGroup(new TextEncoder().encode('group'),
            a.publicPackage, a.privatePackage, [{
                extensionType: 'external_senders',
                extensionData: encodeExternalSenders([first, second].map(
                    (s) => ({
                        credential: s.publicPackage.leafNode.credential,
                        signaturePublicKey:
                            s.publicPackage.leafNode.signaturePublicKey,
                    }))),
            }], impl, testClientConfig)
        const addBob = await createCommit(
            { state: solo, cipherSuite: impl },
            {
                extraProposals: [{
                    proposalType: 'add',
                    add: { keyPackage: b.publicPackage },
                }],
                ratchetTreeExtension: true,
            },
        )
        let alice = addBob.newState
        let bob = await joinGroup(addBob.welcome!, b.publicPackage,
            b.privatePackage, emptyPskIndex, impl, undefined, undefined,
            testClientConfig)

        const proposal = await proposeExternal(
            await createGroupInfoWithExternalPub(alice, [], impl),
            { proposalType: 'add', add: { keyPackage: eve.publicPackage } },
            second.publicPackage.leafNode.signaturePublicKey,
            second.privatePackage.signaturePrivateKey,
            impl,
        )
        if (proposal.wireformat !== 'mls_public_message') {
            throw new Error('expected a public message')
        }
        t.deepEqual(proposal.publicMessage.content.sender,
            { senderType: 'external', senderIndex: 1 },
            'the proposal names the second external sender')

        alice = await receive(alice, proposal, impl)
        bob = await receive(bob, proposal, impl)

        const commit = await createCommit(
            { state: alice, cipherSuite: impl },
            { ratchetTreeExtension: true },
        )
        alice = commit.newState
        bob = await receive(bob, commit.commit, impl)
        t.equal(bob.groupContext.epoch, alice.groupContext.epoch,
            'the other member processes the commit')

        t.ok(commit.welcome !== undefined,
            'the commit carries a Welcome for the proposed member')
        const eveState = await joinGroup(commit.welcome!, eve.publicPackage,
            eve.privatePackage, emptyPskIndex, impl, undefined, undefined,
            testClientConfig)
        t.equal(eveState.groupContext.epoch, alice.groupContext.epoch,
            'the proposed member joins the same epoch')

        await testEveryoneCanMessageEveryone([alice, bob, eveState],
            impl, t)
    })
}

async function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

async function receive (
    state:ClientState,
    msg:MLSMessage,
    impl:CiphersuiteImpl,
):Promise<ClientState> {
    if (msg.wireformat !== 'mls_public_message' &&
        msg.wireformat !== 'mls_private_message') {
        throw new Error('expected a framed message')
    }
    const result = await processMessage(msg, state, emptyPskIndex,
        acceptAll, impl)
    return result.newState
}

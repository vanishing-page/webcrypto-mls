import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPubAndRatchetTree,
    joinGroupExternal,
} from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import type { CiphersuiteImpl } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

for (const cs of sampleCiphersuites()) {
    test(`processMessage reports the sender ${cs}`, async (t) => {
        try {
            await reportsSender(cs as CiphersuiteName, t)
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

async function keyPackage (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

async function reportsSender (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))
    const alice = await keyPackage('alice', impl)
    const bob = await keyPackage('bob', impl)
    const charlie = await keyPackage('charlie', impl)
    const dave = await keyPackage('dave', impl)

    let aliceGroup = await createGroup(
        new TextEncoder().encode('sender-group'),
        alice.publicPackage,
        alice.privatePackage,
        [],
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
    let bobGroup = await joinGroup(
        addBob.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
        undefined,
        testClientConfig,
    )

    // bob (leaf 1) commits the add of charlie, so the committer is not
    // the group creator
    const addCharlie = await createCommit(
        { state: bobGroup, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: charlie.publicPackage },
            }],
        },
    )
    bobGroup = addCharlie.newState
    if (addCharlie.commit.wireformat !== 'mls_private_message') {
        throw new Error('expected a private message commit')
    }
    const aliceSeesCommit = await processMessage(
        addCharlie.commit,
        aliceGroup,
        makePskIndex(aliceGroup, {}),
        acceptAll,
        impl,
    )
    if (aliceSeesCommit.kind !== 'newState') {
        throw new Error('expected newState')
    }
    t.deepEqual(
        aliceSeesCommit.committer,
        { senderType: 'member', leafIndex: 1 },
        'a member commit reports the committer leaf index',
    )
    aliceGroup = aliceSeesCommit.newState

    let charlieGroup:ClientState = await joinGroup(
        addCharlie.welcome!,
        charlie.publicPackage,
        charlie.privatePackage,
        emptyPskIndex,
        impl,
        bobGroup.ratchetTree,
        undefined,
        testClientConfig,
    )

    const authenticatedData = new TextEncoder().encode('aad from charlie')
    const fromCharlie = await createApplicationMessage(
        charlieGroup,
        new TextEncoder().encode('hello'),
        impl,
        authenticatedData,
    )
    charlieGroup = fromCharlie.newState
    const aliceReads = await processMessage(
        {
            wireformat: 'mls_private_message',
            privateMessage: fromCharlie.privateMessage,
        },
        aliceGroup,
        makePskIndex(aliceGroup, {}),
        acceptAll,
        impl,
    )
    if (aliceReads.kind !== 'applicationMessage') {
        throw new Error('expected applicationMessage')
    }
    t.deepEqual(
        aliceReads.sender,
        { senderType: 'member', leafIndex: 2 },
        'an application message reports its sender',
    )
    t.deepEqual(
        aliceReads.authenticatedData,
        authenticatedData,
        'an application message reports its authenticated data',
    )
    aliceGroup = aliceReads.newState

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        aliceGroup,
        [],
        impl,
    )
    const daveJoin = await joinGroupExternal(
        groupInfo,
        dave.publicPackage,
        dave.privatePackage,
        false,
        impl,
        undefined,
        testClientConfig,
    )
    const aliceSeesJoin = await processMessage(
        {
            wireformat: 'mls_public_message',
            publicMessage: daveJoin.publicMessage,
        },
        aliceGroup,
        makePskIndex(aliceGroup, {}),
        acceptAll,
        impl,
    )
    if (aliceSeesJoin.kind !== 'newState') {
        throw new Error('expected newState')
    }
    t.deepEqual(
        aliceSeesJoin.committer,
        { senderType: 'new_member_commit', leafIndex: 3 },
        'an external commit reports new_member_commit and the joiner leaf',
    )
}

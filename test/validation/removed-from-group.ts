/**
 * Once a commit removes this client, its `ClientState` is frozen at the
 * old epoch: the group context never advanced, only `groupActiveState`
 * flipped to `removedFromGroup`. Nothing used to gate inbound traffic on
 * that flag, so a remaining member could feed the removed client a
 * *different* commit built from the same epoch and resurrect it into a
 * fork, or replay the removing commit indefinitely.
 *
 * See security-audit.md L3.
 */
import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import {
    processMessage,
    processPrivateMessage
} from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd, ProposalRemove } from '../../src/proposal.js'
import type { PrivateMessage } from '../../src/private-message.js'
import type { MLSMessage } from '../../src/message.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' || error?.name === 'DependencyError'
}

for (const cs of sampleCiphersuites()) {
    test('a removed client rejects all further inbound traffic ' + cs, async (t) => {
        try {
            await removedClientRejectsTraffic(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function makeMember (name:string, impl:any) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }

    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl
    )
}

function privateMessage (message:MLSMessage):PrivateMessage {
    if (message.wireformat !== 'mls_private_message') {
        throw new Error('Expected a private message')
    }

    return message.privateMessage
}

async function removedClientRejectsTraffic (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const charlie = await makeMember('charlie', impl)

    const groupId = new TextEncoder().encode('removed-from-group')

    const created = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig
    )

    const addBob:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: bob.publicPackage },
    }

    const addCharlie:ProposalAdd = {
        proposalType: 'add',
        add: { keyPackage: charlie.publicPackage },
    }

    const addResult = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: [addBob, addCharlie] },
    )

    // epoch 1: alice, bob and charlie are all members
    const aliceEpoch1:ClientState = addResult.newState

    const bobEpoch1 = await joinGroup(
        addResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceEpoch1.ratchetTree,
        undefined,
        testClientConfig
    )

    // an application message alice sent at epoch 1, before the removal
    const preRemovalMessage = await createApplicationMessage(
        aliceEpoch1,
        new TextEncoder().encode('still a member here'),
        impl,
    )

    // the commit that removes bob
    const removeBob:ProposalRemove = {
        proposalType: 'remove',
        remove: { removed: bobEpoch1.privatePath.leafIndex },
    }

    const removeResult = await createCommit(
        { state: aliceEpoch1, cipherSuite: impl },
        { extraProposals: [removeBob] },
    )

    // an alternative commit built from the very same epoch-1 state, which
    // keeps bob in the group. This is the fork a remaining member would
    // use to resurrect him.
    const forkResult = await createCommit({
        state: aliceEpoch1,
        cipherSuite: impl,
    })

    const removedBob = (await processPrivateMessage(
        bobEpoch1,
        privateMessage(removeResult.commit),
        makePskIndex(bobEpoch1, {}),
        impl,
    )).newState

    t.deepEqual(
        removedBob.groupActiveState,
        { kind: 'removedFromGroup' },
        'bob should be removed from the group'
    )

    await t.throws(async () => {
        await processPrivateMessage(
            removedBob,
            privateMessage(forkResult.commit),
            makePskIndex(removedBob, {}),
            impl,
        )
    }, /removed from the group/, 'an alternative commit at the same epoch is rejected')

    await t.throws(async () => {
        await processPrivateMessage(
            removedBob,
            privateMessage(removeResult.commit),
            makePskIndex(removedBob, {}),
            impl,
        )
    }, /removed from the group/, 'replaying the removing commit is rejected')

    await t.throws(async () => {
        await processMessage(
            {
                wireformat: 'mls_private_message',
                privateMessage: preRemovalMessage.privateMessage,
            },
            removedBob,
            makePskIndex(removedBob, {}),
            acceptAll,
            impl,
        )
    }, /removed from the group/, 'an application message at the stale epoch is rejected')
}

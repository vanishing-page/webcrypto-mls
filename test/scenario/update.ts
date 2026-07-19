import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/key-match.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Update ' + cs, async (t) => {
        try {
            await update(t, cs as CiphersuiteName)
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError') {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

async function update (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl
    )

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(
        bobCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const addBobProposal:ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: bob.publicPackage,
        },
    }

    const addBobCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addBobProposal],
        },
    )

    aliceGroup = addBobCommitResult.newState

    let bobGroup = await joinGroup(
        addBobCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'should match')

    const emptyCommitResult = await createCommit({
        state: aliceGroup,
        cipherSuite: impl,
    })

    if (emptyCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    aliceGroup = emptyCommitResult.newState

    const bobProcessCommitResult = await processPrivateMessage(
        bobGroup,
        emptyCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = bobProcessCommitResult.newState

    const emptyCommitResult3 = await createCommit({
        state: bobGroup,
        cipherSuite: impl,
    })

    if (emptyCommitResult3.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    bobGroup = emptyCommitResult3.newState

    const aliceProcessCommitResult3 = await processPrivateMessage(
        aliceGroup,
        emptyCommitResult3.commit.privateMessage,
        makePskIndex(aliceGroup, {}),
        impl,
    )

    aliceGroup = aliceProcessCommitResult3.newState

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], impl, t)
}

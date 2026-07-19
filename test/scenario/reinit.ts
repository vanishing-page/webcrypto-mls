import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { processPrivateMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { joinGroupFromReinit, reinitCreateNewGroup, reinitGroup } from '../../src/resumption.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/key-match.js'
import { getRandomElement, testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { UsageError as _UsageError } from '../../src/mls-error.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Reinit ' + cs, async (t) => {
        try {
            await reinit(t, cs as CiphersuiteName)
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

async function reinit (t:any, cipherSuite:CiphersuiteName) {
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

    const commitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [addBobProposal],
        },
    )

    aliceGroup = commitResult.newState

    let bobGroup = await joinGroup(
        commitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    const newCiphersuite = getRandomElement(Object.keys(ciphersuites)) as CiphersuiteName

    const newGroupId = new TextEncoder().encode('new-group1')

    const reinitCommitResult = await reinitGroup(aliceGroup, newGroupId, 'mls10', newCiphersuite, [], impl)

    aliceGroup = reinitCommitResult.newState

    if (reinitCommitResult.commit.wireformat !== 'mls_private_message') throw new Error('Expected private message')

    const processReinitResult = await processPrivateMessage(
        bobGroup,
        reinitCommitResult.commit.privateMessage,
        makePskIndex(bobGroup, {}),
        impl,
    )

    bobGroup = processReinitResult.newState

    t.equal(bobGroup.groupActiveState.kind, 'suspendedPendingReinit', 'bob should be suspended pending reinit')
    t.equal(aliceGroup.groupActiveState.kind, 'suspendedPendingReinit', 'alice should be suspended pending reinit')

    // creating a message will fail now
    await t.throws(async () => {
        await createCommit({
            state: aliceGroup,
            cipherSuite: impl,
        })
    }, 'should throw UsageError when suspended')

    const newImpl = await getCipherSuite(getCiphersuiteFromName(newCiphersuite))

    const bobNewKeyPackage = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], newImpl)

    const aliceNewKeyPackage = await generateKeyPackage(
        aliceCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        newImpl,
    )

    const resumeGroupResult = await reinitCreateNewGroup(
        aliceGroup,
        aliceNewKeyPackage.publicPackage,
        aliceNewKeyPackage.privatePackage,
        [bobNewKeyPackage.publicPackage],
        newGroupId,
        newCiphersuite,
        [],
    )

    aliceGroup = resumeGroupResult.newState

    bobGroup = await joinGroupFromReinit(
        bobGroup,
        resumeGroupResult.welcome!,
        bobNewKeyPackage.publicPackage,
        bobNewKeyPackage.privatePackage,
        aliceGroup.ratchetTree,
    )

    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], newImpl, t)
    await checkHpkeKeysMatch(aliceGroup, newImpl, t)
    await checkHpkeKeysMatch(bobGroup, newImpl, t)
}

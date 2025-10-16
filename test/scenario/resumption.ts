import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import { branchGroup, joinGroupFromBranch } from '../../src/resumption.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites, getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { checkHpkeKeysMatch } from '../crypto/keyMatch.js'
import { testEveryoneCanMessageEveryone } from './common.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/defaultCapabilities.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Resumption ' + cs, async (t) => {
        await resumption(t, cs as CiphersuiteName)
    })
}

async function resumption (t: any, cipherSuite: CiphersuiteName) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
    const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const addBobProposal: ProposalAdd = {
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

    const bobNewKeyPackage = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const aliceNewKeyPackage = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const newGroupId = new TextEncoder().encode('new-group1')

    const branchCommitResult = await branchGroup(
        aliceGroup,
        aliceNewKeyPackage.publicPackage,
        aliceNewKeyPackage.privatePackage,
        [bobNewKeyPackage.publicPackage],
        newGroupId,
        impl,
    )

    aliceGroup = branchCommitResult.newState

    bobGroup = await joinGroupFromBranch(
        bobGroup,
    branchCommitResult.welcome!,
    bobNewKeyPackage.publicPackage,
    bobNewKeyPackage.privatePackage,
    aliceGroup.ratchetTree,
    impl,
    )

    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], impl, t)
    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
}

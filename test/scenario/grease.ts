import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
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
import { defaultGreaseConfig, greaseExtensions } from '../../src/grease.js'
import type { Capabilities } from '../../src/capabilities.js'
import { extensionTypeToNumber } from '../../src/extension.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`Grease ${cs}`, async (t) => {
        await greaseTest(cs as CiphersuiteName, t)
    })
}

async function greaseTest (cipherSuite: CiphersuiteName, t: any) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const greased = greaseExtensions(defaultGreaseConfig)
    const caps: Capabilities = {
        ...defaultCapabilities(),
        extensions: greased.map((n) => extensionTypeToNumber(n.extensionType)),
    }
    const alice = await generateKeyPackage(aliceCredential, caps, defaultLifetime, greased, impl)

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

    const bobGroup = await joinGroup(
    addBobCommitResult.welcome!,
    bob.publicPackage,
    bob.privatePackage,
    emptyPskIndex,
    impl,
    aliceGroup.ratchetTree,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob should have matching epoch authenticator')

    await checkHpkeKeysMatch(aliceGroup, impl, t)
    await checkHpkeKeysMatch(bobGroup, impl, t)
    await testEveryoneCanMessageEveryone([aliceGroup, bobGroup], impl, t)
}

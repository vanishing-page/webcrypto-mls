import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/clientState.js'
import { createCommit } from '../../src/createCommit.js'
import { emptyPskIndex } from '../../src/pskIndex.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName, ciphersuites } from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteImpl } from '../../src/crypto/getCiphersuiteImpl.js'
import { generateKeyPackage } from '../../src/keyPackage.js'
import type { ProposalAdd } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension } from '../../src/extension.js'
import type { RequiredCapabilities } from '../../src/requiredCapabilities.js'
import { encodeRequiredCapabilities } from '../../src/requiredCapabilities.js'
import { ValidationError as _ValidationError } from '../../src/mlsError.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Required Capabilities extension ' + cs, async (t) => {
        await requiredCapatabilitiesTest(t, cs as CiphersuiteName)
    })
}

async function requiredCapatabilitiesTest (t: any, cipherSuite: CiphersuiteName) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const requiredCapabilities: RequiredCapabilities = {
        extensionTypes: [7, 8],
        credentialTypes: ['x509', 'basic'],
        proposalTypes: [],
    }

    const capabilities: Capabilities = {
        extensions: [7, 8, 9],
        credentials: ['x509', 'basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    const requiredCapabilitiesExtension: Extension = {
        extensionType: 'required_capabilities',
        extensionData: encodeRequiredCapabilities(requiredCapabilities),
    }

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [requiredCapabilitiesExtension],
        impl,
    )

    const bobCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime, [], impl)

    const minimalCapabilites: Capabilities = {
        extensions: [],
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const charlieCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('charlie') }
    const charlie = await generateKeyPackage(charlieCredential, minimalCapabilites, defaultLifetime, [], impl)

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

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'epoch authenticators should match')

    const addCharlieProposal: ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: charlie.publicPackage,
        },
    }

    await t.throws(async () => {
        await createCommit(
            {
                state: aliceGroup,
                cipherSuite: impl,
            },
            {
                extraProposals: [addCharlieProposal],
            },
        )
    }, 'should throw ValidationError for insufficient capabilities')
}

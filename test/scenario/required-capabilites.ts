import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
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
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension } from '../../src/extension.js'
import type { RequiredCapabilities } from '../../src/required-capabilities.js'
import { encodeRequiredCapabilities } from '../../src/required-capabilities.js'
import { ValidationError as _ValidationError } from '../../src/mls-error.js'

for (const cs of Object.keys(ciphersuites)) {
    test('Required Capabilities extension ' + cs, async (t) => {
        try {
            await requiredCapatabilitiesTest(t, cs as CiphersuiteName)
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

async function requiredCapatabilitiesTest (t:any, cipherSuite:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const requiredCapabilities:RequiredCapabilities = {
        extensionTypes: [7, 8],
        credentialTypes: ['x509', 'basic'],
        proposalTypes: [],
    }

    const capabilities:Capabilities = {
        extensions: [7, 8, 9],
        credentials: ['x509', 'basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    const requiredCapabilitiesExtension:Extension = {
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

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime, [], impl)

    const minimalCapabilites:Capabilities = {
        extensions: [],
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const charlieCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('charlie')
    }
    const charlie = await generateKeyPackage(charlieCredential, minimalCapabilites, defaultLifetime, [], impl)

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

    const bobGroup = await joinGroup(
        addBobCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        aliceGroup.ratchetTree,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'epoch authenticators should match')

    const addCharlieProposal:ProposalAdd = {
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

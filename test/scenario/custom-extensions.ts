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
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension, ExtensionType } from '../../src/extension.js'
import { ValidationError } from '../../src/mls-error.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`Custom Extensions ${cs}`, async (t) => {
        try {
            await customExtensionTest(cs as CiphersuiteName, t)
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

async function customExtensionTest (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const customExtensionType:ExtensionType = 7

    const capabilities:Capabilities = {
        extensions: [customExtensionType],
        credentials: ['basic'],
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

    const extensionData = new TextEncoder().encode('custom extension data')

    const customExtension:Extension = {
        extensionType: customExtensionType,
        extensionData,
    }

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [customExtension], impl)

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob')
    }
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime, [], impl)

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

    t.deepEqual(
        bobGroup.groupContext.extensions.find((e) => e.extensionType === customExtensionType),
        customExtension,
        'bob should receive the custom extension in group context'
    )

    // Charlie doesn't support the custom extension
    const charlieCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('charlie')
    }
    const charlie = await generateKeyPackage(
        charlieCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
    )

    const addCharlieProposal:ProposalAdd = {
        proposalType: 'add',
        add: {
            keyPackage: charlie.publicPackage,
        },
    }

    let errorThrown = false
    try {
        await createCommit(
            {
                state: aliceGroup,
                cipherSuite: impl,
            },
            { extraProposals: [addCharlieProposal] },
        )
    } catch (error) {
        errorThrown = error instanceof ValidationError
    }
    t.ok(errorThrown, 'should throw ValidationError when adding member without custom extension support')
}

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
import { defaultCapabilities } from '../../src/defaultCapabilities.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Extension, ExtensionType } from '../../src/extension.js'
import { ValidationError } from '../../src/mlsError.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`Custom Extensions ${cs}`, async (t) => {
        await customExtensionTest(cs as CiphersuiteName, t)
    })
}

async function customExtensionTest (cipherSuite: CiphersuiteName, t: any) {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite))

    const customExtensionType: ExtensionType = 7

    const capabilities: Capabilities = {
        extensions: [customExtensionType],
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    const extensionData = new TextEncoder().encode('custom extension data')

    const customExtension: Extension = {
        extensionType: customExtensionType,
        extensionData,
    }

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [customExtension], impl)

    const bobCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime, [], impl)

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

    t.deepEqual(
        bobGroup.groupContext.extensions.find((e) => e.extensionType === customExtensionType),
        customExtension,
        'bob should receive the custom extension in group context'
    )

    // Charlie doesn't support the custom extension
    const charlieCredential: Credential = { credentialType: 'basic', identity: new TextEncoder().encode('charlie') }
    const charlie = await generateKeyPackage(charlieCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const addCharlieProposal: ProposalAdd = {
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

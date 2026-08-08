import { test } from '@substrate-system/tapzero'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createContentCommitSignature } from '../../src/framed-content.js'
import { signLeafNodeCommit } from '../../src/leaf-node.js'
import type { LeafNodeTBSCommit } from '../../src/leaf-node.js'
import { protectPublicMessage } from '../../src/message-protection-public.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import type { Capabilities } from '../../src/capabilities.js'
import type { Proposal } from '../../src/proposal.js'
import type { RequiredCapabilities } from '../../src/required-capabilities.js'
import { encodeRequiredCapabilities } from '../../src/required-capabilities.js'
import { ValidationError } from '../../src/mls-error.js'
import { testCiphersuites } from '../helpers/suite-filter.js'

for (const cs of testCiphersuites()) {
    test('Commit adding required_capabilities the committer\'s own ' +
      'update-path leaf does not support is rejected by the receiver ' + cs, async (t) => {
        try {
            await committerLeafDoesNotSupportOwnRequiredCapabilities(t, cs as CiphersuiteName)
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

async function committerLeafDoesNotSupportOwnRequiredCapabilities (
    t:any,
    cipherSuite:CiphersuiteName,
):Promise<void> {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    // Both members' pre-commit capabilities support extension 8, so the
    // applyProposals-level "everyone remaining supports the new
    // required_capabilities" check (which looks at the pre-commit tree, not
    // the committer's freshly signed update-path leaf) passes honestly.
    const capabilities:Capabilities = {
        extensions: [8],
        credentials: ['basic'],
        proposals: [],
        versions: ['mls10'],
        ciphersuites: [cipherSuite],
    }

    const aliceCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice'),
    }
    const alice = await generateKeyPackage(aliceCredential, capabilities, defaultLifetime(), [], impl)

    const bobCredential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode('bob'),
    }
    const bob = await generateKeyPackage(bobCredential, capabilities, defaultLifetime(), [], impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(
        groupId,
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
    )

    const addBobCommitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            extraProposals: [{ proposalType: 'add', add: { keyPackage: bob.publicPackage } }],
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

    const requiredCapabilities:RequiredCapabilities = {
        extensionTypes: [8],
        credentialTypes: ['basic'],
        proposalTypes: [],
    }

    const gceProposal:Proposal = {
        proposalType: 'group_context_extensions',
        groupContextExtensions: {
            extensions: [
                {
                    extensionType: 'required_capabilities',
                    extensionData: encodeRequiredCapabilities(requiredCapabilities),
                },
            ],
        },
    }

    const commitResult = await createCommit(
        {
            state: aliceGroup,
            cipherSuite: impl,
        },
        {
            wireAsPublicMessage: true,
            extraProposals: [gceProposal],
        },
    )

    if (commitResult.commit.wireformat !== 'mls_public_message') {
        throw new Error('Expected public message')
    }

    const pm = commitResult.commit.publicMessage
    if (pm.content.contentType !== 'commit' || pm.content.commit.path === undefined) {
        throw new Error('Expected a commit with an update path')
    }
    if (pm.auth.contentType !== 'commit') {
        throw new Error('Expected commit auth data')
    }

    const originalPath = pm.content.commit.path
    const originalLeaf = originalPath.leafNode

    // Simulate a buggy/malicious committer whose actual signed update-path
    // leaf no longer supports extension 8, even though the pre-commit tree
    // (used by applyProposals' capability check) did.
    const tamperedCapabilities:Capabilities = { ...originalLeaf.capabilities, extensions: [] }

    const tamperedLeafTbs:LeafNodeTBSCommit = {
        leafNodeSource: 'commit',
        hpkePublicKey: originalLeaf.hpkePublicKey,
        extensions: originalLeaf.extensions,
        capabilities: tamperedCapabilities,
        credential: originalLeaf.credential,
        signaturePublicKey: originalLeaf.signaturePublicKey,
        parentHash: originalLeaf.parentHash,
        info: {
            leafNodeSource: 'commit',
            groupId,
            leafIndex: aliceGroup.privatePath.leafIndex,
        },
    }

    const tamperedLeaf = await signLeafNodeCommit(
        tamperedLeafTbs,
        alice.privatePackage.signaturePrivateKey,
        impl.signature,
    )

    const tamperedPath = { ...originalPath, leafNode: tamperedLeaf }

    const { framedContent, signature } = await createContentCommitSignature(
        aliceGroup.groupContext,
        'mls_public_message',
        { proposals: pm.content.commit.proposals, path: tamperedPath },
        pm.content.sender,
        pm.content.authenticatedData,
        alice.privatePackage.signaturePrivateKey,
        impl.signature,
    )

    const tamperedPublicMessage = await protectPublicMessage(
        aliceGroup.keySchedule.membershipKey,
        aliceGroup.groupContext,
        {
            wireformat: 'mls_public_message',
            content: framedContent,
            auth: {
                contentType: 'commit',
                signature,
                confirmationTag: pm.auth.confirmationTag,
            },
        },
        impl,
    )

    let thrown:unknown
    try {
        await processPublicMessage(bobGroup, tamperedPublicMessage, makePskIndex(bobGroup, {}), impl)
    } catch (error) {
        thrown = error
    }

    t.ok(
        thrown instanceof ValidationError,
        'receiver rejects a commit whose committer leaf fails the required_capabilities it introduces',
    )
}

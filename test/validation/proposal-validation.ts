import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup } from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPub
} from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    ciphersuites,
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type {
    Proposal,
    ProposalAdd,
    ProposalRemove
} from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { CodecError, ValidationError } from '../../src/mls-error.js'
import { encodeRequiredCapabilities } from '../../src/required-capabilities.js'
import { encodeExternalSenders } from '../../src/external-sender.js'
import type { AuthenticationService } from '../../src/authentication-service.js'
import { constantTimeEqual } from '../../src/util/constant-time-compare.js'
import { createCustomCredential } from '../../src/custom-credential.js'
import type { Extension } from '../../src/extension.js'
import type { LeafNode } from '../../src/leaf-node.js'
import { proposeExternal } from '../../src/index.js'

function withAuthService (
    state:ClientState,
    authService:AuthenticationService
) {
    return {
        ...state,
        clientConfig: { ...state.clientConfig, authService }
    }
}

// Convert test.concurrent.each to individual tests
for (const cs of Object.keys(ciphersuites)) {
    test(`Proposal Validation - ${cs}`, async (t) => {
        try {
            const cipherSuite = cs as CiphersuiteName
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

            const addBobProposal:ProposalAdd = {
                proposalType: 'add',
                add: {
                    keyPackage: bob.publicPackage,
                },
            }

            const addCharlieProposal:ProposalAdd = {
                proposalType: 'add',
                add: {
                    keyPackage: charlie.publicPackage,
                },
            }

            const addBobAndCharlieCommitResult = await createCommit(
                {
                    state: aliceGroup,
                    cipherSuite: impl,
                },
                {
                    extraProposals: [addBobProposal, addCharlieProposal],
                },
            )

            aliceGroup = addBobAndCharlieCommitResult.newState

            const bobGroup = await joinGroup(
                addBobAndCharlieCommitResult.welcome!,
                bob.publicPackage,
                bob.privatePackage,
                emptyPskIndex,
                impl,
                aliceGroup.ratchetTree,
            )

            t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob should have same epoch authenticator as alice')

            const charlieGroup = await joinGroup(
                addBobAndCharlieCommitResult.welcome!,
                charlie.publicPackage,
                charlie.privatePackage,
                emptyPskIndex,
                impl,
                aliceGroup.ratchetTree,
            )

            t.deepEqual(charlieGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'charlie should have same epoch authenticator as alice')

            const removeBobProposal:ProposalRemove = {
                proposalType: 'remove',
                remove: {
                    removed: bobGroup.privatePath.leafIndex,
                },
            }

            const removeBobProposal2:ProposalRemove = {
                proposalType: 'remove',
                remove: {
                    removed: bobGroup.privatePath.leafIndex,
                },
            }

            // can't remove same leaf node twice
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [removeBobProposal, removeBobProposal2],
                    },
                )
                t.fail('should have thrown ValidationError for duplicate remove')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when removing same leaf node twice')
            }

            // can't add someone already in the group
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [addBobProposal],
                    },
                )
                t.fail('should have thrown ValidationError for adding existing member')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when adding someone already in the group')
            }

            const proposalInvalidRequiredCapabilities:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [{ extensionType: 'required_capabilities', extensionData: new Uint8Array([1, 2]) }],
                },
            }

            // can't add groupContextExtensions with invalid requiredCapabilities
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [proposalInvalidRequiredCapabilities],
                    },
                )
                t.fail('should have thrown CodecError for invalid requiredCapabilities')
            } catch (error) {
                t.ok(error instanceof CodecError, 'should throw CodecError for invalid requiredCapabilities')
            }

            const proposalRequiredCapabilities:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [
                        {
                            extensionType: 'required_capabilities',
                            extensionData: encodeRequiredCapabilities({ extensionTypes: [], proposalTypes: [99], credentialTypes: [] }),
                        },
                    ],
                },
            }

            // can't add groupContextExtensions with requiredCapabilities that members don't support
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [proposalRequiredCapabilities],
                    },
                )
                t.fail('should have thrown ValidationError for unsupported capability')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when members do not support requiredCapabilities')
            }

            const dianaCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('diana')
            }
            const diana = await generateKeyPackage(
                dianaCredential,
                { ...defaultCapabilities(), credentials: ['basic'] },
                defaultLifetime,
                [],
                impl,
            )

            const addDiana:Proposal = {
                proposalType: 'add',
                add: {
                    keyPackage: diana.publicPackage,
                },
            }

            const proposalRequiredCapabilitiesX509:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [
                        {
                            extensionType: 'required_capabilities',
                            extensionData: encodeRequiredCapabilities({
                                extensionTypes: [],
                                proposalTypes: [],
                                credentialTypes: ['x509'],
                            }),
                        },
                    ],
                },
            }

            // can't add groupContextExtensions with requiredCapabilities that newly added member doesn't support
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [addDiana, proposalRequiredCapabilitiesX509],
                    },
                )
                t.fail('should have thrown ValidationError for new member missing capability')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when newly added member does not support requiredCapabilities')
            }

            const proposalInvalidExternalSenders:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [{ extensionType: 'external_senders', extensionData: new Uint8Array([1, 2]) }],
                },
            }

            // can't add groupContextExtensions with invalid requiredCapabilities
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [proposalInvalidExternalSenders],
                    },
                )
                t.fail('should have thrown CodecError for invalid externalSenders')
            } catch (error) {
                t.ok(error instanceof CodecError, 'should throw CodecError for invalid externalSenders')
            }

            const badCredential = { credentialType: 'basic' as const, identity: new TextEncoder().encode('NOT GOOD') }

            const proposalUnauthenticatedExternalSenders:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [
                        {
                            extensionType: 'external_senders',
                            extensionData: encodeExternalSenders([{ credential: badCredential, signaturePublicKey: new Uint8Array() }]),
                        },
                    ],
                },
            }

            const authService:AuthenticationService = {
                async validateCredential (c, _pk) {
                    if (c.credentialType === 'basic' && constantTimeEqual(c.identity, badCredential.identity)) return false
                    return true
                },
            }

            // can't add groupContextExtensions with external senders that can't be auth'd
            try {
                await createCommit(
                    {
                        state: withAuthService(aliceGroup, authService),
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [proposalUnauthenticatedExternalSenders],
                    },
                )
                t.fail('should have thrown ValidationError for unauthenticated external sender')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when external senders cannot be authenticated')
            }

            const edwardCredential = { credentialType: 'basic' as const, identity: new TextEncoder().encode('edward') }
            const edward = await generateKeyPackage(
                edwardCredential,
                { ...defaultCapabilities(), credentials: ['basic'] },
                defaultLifetime,
                [],
                impl,
            )

            const addEdward:Proposal = {
                proposalType: 'add',
                add: {
                    keyPackage: edward.publicPackage,
                },
            }

            const authServiceEdward:AuthenticationService = {
                async validateCredential (c, _pk) {
                    if (c.credentialType === 'basic' && constantTimeEqual(c.identity, edwardCredential.identity)) return false
                    return true
                },
            }

            // can't add a member with invalid credentials
            try {
                await createCommit(
                    {
                        state: withAuthService(aliceGroup, authServiceEdward),
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [addEdward],
                    },
                )
                t.fail('should have thrown ValidationError for invalid credentials')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when adding a member with invalid credentials')
            }

            const frankCredential:Credential = createCustomCredential(5, new Uint8Array([1, 2]))
            const frank = await generateKeyPackage(
                frankCredential,
                defaultCapabilities(),
                defaultLifetime,
                [],
                impl
            )

            const addFrank:Proposal = {
                proposalType: 'add',
                add: { keyPackage: frank.publicPackage },
            }

            // can't add leafNode with an unsupported credentialType
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [addFrank],
                    },
                )
                t.fail('should have thrown ValidationError for unsupported credentialType')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when adding leafNode with unsupported credentialType')
            }

            const georgeCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('george')
            }
            const georgeExtension:Extension = { extensionType: 8545, extensionData: new Uint8Array() }
            const george = await generateKeyPackage(
                georgeCredential,
                defaultCapabilities(),
                defaultLifetime,
                [georgeExtension],
                impl,
            )

            const addGeorge:Proposal = {
                proposalType: 'add',
                add: { keyPackage: george.publicPackage },
            }

            // can't add leafNode with an unsupported extension
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [addGeorge],
                    },
                )
                t.fail('should have thrown ValidationError for unsupported extension')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when adding leafNode with unsupported extension')
            }

            const updateLeafNode:LeafNode = {
                leafNodeSource: 'update',
                signaturePublicKey: alice.publicPackage.leafNode.signaturePublicKey,
                hpkePublicKey: alice.publicPackage.leafNode.hpkePublicKey,
                credential: alice.publicPackage.leafNode.credential,
                capabilities: alice.publicPackage.leafNode.capabilities,
                extensions: alice.publicPackage.leafNode.extensions,
                signature: new Uint8Array(),
            }

            const updateProposal:Proposal = {
                proposalType: 'update',
                update: {
                    leafNode: updateLeafNode,
                },
            }

            // commiter can't update themselves
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [updateProposal],
                    },
                )
                t.fail('should have thrown ValidationError for committer updating themselves')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when committer tries to update themselves')
            }

            const removeProposal:ProposalRemove = {
                proposalType: 'remove',
                remove: {
                    removed: 0,
                },
            }

            // committer can't remove themselves
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [removeProposal],
                    },
                )
                t.fail('should have thrown ValidationError for committer removing themselves')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when committer tries to remove themselves')
            }

            const hannahCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('bob')
            }
            const hannah = await generateKeyPackage(
                hannahCredential,
                defaultCapabilities(),
                defaultLifetime,
                [],
                impl
            )

            const addHannahProposal:ProposalAdd = {
                proposalType: 'add',
                add: {
                    keyPackage: hannah.publicPackage,
                },
            }

            // can't add the same  keypackage twice
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [addHannahProposal, addHannahProposal],
                    },
                )
                t.fail('should have thrown ValidationError for duplicate keypackage')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when adding the same keypackage twice')
            }

            const pskId = new Uint8Array([1, 2, 3, 4])
            const pskProposal:Proposal = {
                proposalType: 'psk',
                psk: {
                    preSharedKeyId: {
                        psktype: 'external',
                        pskId,
                        pskNonce: new Uint8Array([5, 6, 7, 8]),
                    },
                },
            }

            // can't reference the same psk in multiple proposals
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [pskProposal, pskProposal],
                    },
                )
                t.fail('should have thrown ValidationError for duplicate psk')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when referencing the same psk in multiple proposals')
            }

            const groupContextExtensionsProposal:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [],
                },
            }

            // can't use multiple group_context_extensions proposals
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [groupContextExtensionsProposal, groupContextExtensionsProposal],
                    },
                )
                t.fail('should have thrown ValidationError for multiple group_context_extensions')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when using multiple group_context_extensions proposals')
            }

            const groupContextExtensionsUnsupportedByMemberProposal:Proposal = {
                proposalType: 'group_context_extensions',
                groupContextExtensions: {
                    extensions: [{ extensionType: 9821, extensionData: new Uint8Array() }],
                },
            }

            // can't add a groupContextExtensions proposal for an extension that
            // an existing member's capabilities don't list support for
            try {
                await createCommit(
                    {
                        state: aliceGroup,
                        cipherSuite: impl,
                    },
                    {
                        extraProposals: [groupContextExtensionsUnsupportedByMemberProposal],
                    },
                )
                t.fail('should have thrown ValidationError for existing member not supporting new extension')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when an existing member does not support a proposed group context extension')
            }

            // external pub not really necessary here
            const groupInfo = await createGroupInfoWithExternalPub(aliceGroup, [], impl)

            // can't use proposeExternal on a group without external_senders
            try {
                await proposeExternal(
                    groupInfo,
                    removeBobProposal,
                    charlie.publicPackage.leafNode.signaturePublicKey,
                    charlie.privatePackage.signaturePrivateKey,
                    impl,
                )
                t.fail('should have thrown ValidationError for proposeExternal without external_senders')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when using proposeExternal on a group without external_senders')
            }

            // can't use proposeExternal on a group with malformed external_senders
            try {
                await proposeExternal(
                    {
                        ...groupInfo,
                        groupContext: {
                            ...groupInfo.groupContext,
                            extensions: [{ extensionType: 'external_senders', extensionData: new Uint8Array([1, 2, 3]) }],
                        },
                    },
                    removeBobProposal,
                    charlie.publicPackage.leafNode.signaturePublicKey,
                    charlie.privatePackage.signaturePrivateKey,
                    impl,
                )
                t.fail('should have thrown ValidationError for malformed external_senders')
            } catch (error) {
                t.ok(error instanceof ValidationError, 'should throw ValidationError when using proposeExternal on a group with malformed external_senders')
            }
        } catch (error:any) {
            // Skip ciphersuites not supported in the current environment (e.g., X448/Ed448 in browsers)
            if (error?.name === 'NotSupportedError' || error?.name === 'DependencyError' || error?.name === 'CryptoError' || error?.name === 'DeriveKeyPairError' || error?.message?.includes('SubtleCrypto') || error?.message?.includes('Unrecognized name')) {
                t.comment(`Skipping ${cs}: ${error.message}`)
                return
            }
            throw error
        }
    })
}

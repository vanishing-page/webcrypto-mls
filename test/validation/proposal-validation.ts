import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex
} from '../../src/client-state.js'
import {
    createCommit,
    createGroupInfoWithExternalPub
} from '../../src/create-commit.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName
} from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import {
    generateKeyPackage,
    signKeyPackage
} from '../../src/key-package.js'
import type {
    KeyPackage,
    PrivateKeyPackage
} from '../../src/key-package.js'
import {
    proposeAddExternal
} from '../../src/external-proposal.js'
import {
    createApplicationMessage,
    createProposal
} from '../../src/create-message.js'
import { processMessage } from '../../src/process-messages.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import type { MLSMessage } from '../../src/message.js'
import {
    protectExternalProposalPublic,
    protectProposalPublic
} from '../../src/message-protection-public.js'
import type { SenderNonMember } from '../../src/sender.js'
import { signWithLabel } from '../../src/crypto/signature.js'
import type { LeafNodeUpdate } from '../../src/leaf-node.js'
import {
    encodeLeafNodeTBS,
    signLeafNodeKeyPackage
} from '../../src/leaf-node.js'
import type { PskIndex } from '../../src/psk-index.js'
import { bytesToBase64 } from '../../src/util/byte-array.js'
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
import {
    sampleCiphersuites,
    testCiphersuites
} from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

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
for (const cs of testCiphersuites()) {
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
                defaultLifetime(),
                [],
                impl
            )

            const groupId = new TextEncoder().encode('group1')

            let aliceGroup = await createGroup(
                groupId,
                alice.publicPackage,
                alice.privatePackage,
                [],
                impl,
                testClientConfig
            )

            const bobCredential:Credential = {
                credentialType: 'basic',
                identity: new TextEncoder().encode('bob')
            }
            const bob = await generateKeyPackage(
                bobCredential,
                defaultCapabilities(),
                defaultLifetime(),
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
                defaultLifetime(),
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
                undefined,
                testClientConfig
            )

            t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob should have same epoch authenticator as alice')

            const charlieGroup = await joinGroup(
                addBobAndCharlieCommitResult.welcome!,
                charlie.publicPackage,
                charlie.privatePackage,
                emptyPskIndex,
                impl,
                aliceGroup.ratchetTree,
                undefined,
                testClientConfig
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
                defaultLifetime(),
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
                defaultLifetime(),
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
                defaultLifetime(),
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
                defaultLifetime(),
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
                defaultLifetime(),
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
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

/**
 * Proposals that can never be committed are rejected when they arrive,
 * not when the next commit trips over them. Each test below has a hostile
 * peer build a correctly signed proposal message that no honest client
 * would send -- bypassing `createProposal`, which refuses the same input
 * -- and asserts that the receiver rejects it and can still commit.
 */
for (const cs of sampleCiphersuites()) {
    receiptTest('received Remove of a blank leaf is rejected', cs,
        async (t, f) => {
            // alice removes bob, leaving leaf 1 blank between alice and
            // charlie
            const removeBob = await createCommit(
                { state: f.aliceGroup, cipherSuite: f.impl },
                {
                    extraProposals: [{
                        proposalType: 'remove',
                        remove: { removed: 1 }
                    }]
                }
            )
            const charlieGroup = await receive(
                f.charlieGroup,
                removeBob.commit,
                f.impl
            )

            const msg = await memberProposal(charlieGroup, f.charlie, {
                proposalType: 'remove',
                remove: { removed: 1 },
            }, f.impl)

            const aliceGroup = await expectRejected(
                t,
                removeBob.newState,
                msg,
                f.impl,
                'Remove naming a blank leaf'
            )

            await expectCanStillCommit(t, aliceGroup, f.impl)

            for (const publicMessage of [true, false]) {
                let localError:unknown
                try {
                    await createProposal(charlieGroup, publicMessage, {
                        proposalType: 'remove',
                        remove: { removed: 1 },
                    }, f.impl)
                } catch (error) {
                    localError = error
                }
                t.ok(
                    localError instanceof ValidationError,
                    'createProposal refuses the same Remove ' +
                        `(publicMessage ${publicMessage})`
                )
            }
        })
}

for (const cs of sampleCiphersuites()) {
    receiptTest('received Remove beyond the tree is rejected', cs,
        async (t, f) => {
            const msg = await memberProposal(f.bobGroup, f.bob, {
                proposalType: 'remove',
                remove: { removed: 1000 },
            }, f.impl)

            const aliceGroup = await expectRejected(
                t,
                f.aliceGroup,
                msg,
                f.impl,
                'Remove naming a leaf index beyond the tree'
            )

            await expectCanStillCommit(t, aliceGroup, f.impl)
        })
}

for (const cs of sampleCiphersuites()) {
    receiptTest('received Add with an unimportable initKey is rejected', cs,
        async (t, f) => {
            const dave = await makeMember('dave', f.impl)
            // a correctly signed KeyPackage whose init key is not a
            // public key under any ciphersuite
            const badKeyPackage = await resignKeyPackage(
                dave,
                { initKey: new Uint8Array(7).fill(1) },
                f.impl
            )
            await expectAddRejectedFromEverySender(
                t,
                f,
                { ...dave, publicPackage: badKeyPackage },
                'Add whose initKey does not import'
            )
        })
}

for (const cs of sampleCiphersuites()) {
    receiptTest('received Add with a bad KeyPackage signature is rejected',
        cs, async (t, f) => {
            const dave = await makeMember('dave', f.impl)
            const signature = dave.publicPackage.signature.slice()
            signature[0] ^= 0xff
            await expectAddRejectedFromEverySender(
                t,
                f,
                {
                    ...dave,
                    publicPackage: { ...dave.publicPackage, signature },
                },
                'Add whose KeyPackage signature does not verify'
            )
        })

    receiptTest('received Add with an expired KeyPackage is rejected', cs,
        async (t, f) => {
            const now = BigInt(Math.floor(Date.now() / 1000))
            const dave = await makeMember('dave', f.impl, {
                notBefore: now - 7200n,
                notAfter: now - 3600n,
            })
            await expectAddRejectedFromEverySender(
                t,
                f,
                dave,
                'Add whose KeyPackage lifetime has expired'
            )
        })

    receiptTest(
        'received Add with a KeyPackage for another ciphersuite is rejected',
        cs,
        async (t, f) => {
            const dave = await makeMember('dave', f.impl)
            const other:CiphersuiteName =
                cs === 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256' ?
                    'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' :
                    'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
            const otherSuite = await resignKeyPackage(
                dave,
                { cipherSuite: other },
                f.impl
            )
            await expectAddRejectedFromEverySender(
                t,
                f,
                { ...dave, publicPackage: otherSuite },
                'Add whose KeyPackage names another ciphersuite'
            )
        }
    )
}

for (const cs of sampleCiphersuites()) {
    receiptTest('received ExternalInit is rejected from any sender', cs,
        async (t, f) => {
            // the KEM output is never reached: an ExternalInit is invalid
            // outside a new_member_commit whatever it carries
            const externalInit:Proposal = {
                proposalType: 'external_init',
                externalInit: { kemOutput: new Uint8Array(32).fill(2) },
            }

            const fromMember = await memberProposal(
                f.bobGroup,
                f.bob,
                externalInit,
                f.impl
            )
            // proposeExternal refuses to build these, so sign them directly
            const fromExternal = await externalProposal(
                f.aliceGroup,
                f.externalSender,
                externalInit,
                { senderType: 'external', senderIndex: 0 },
                f.impl
            )
            const fromNewMember = await externalProposal(
                f.aliceGroup,
                f.bob,
                externalInit,
                { senderType: 'new_member_proposal' },
                f.impl
            )

            for (const [sender, msg] of [
                ['member', fromMember],
                ['external', fromExternal],
                ['new_member_proposal', fromNewMember],
            ] as const) {
                const aliceGroup = await expectRejected(
                    t,
                    f.aliceGroup,
                    msg,
                    f.impl,
                    `ExternalInit (${sender} sender)`
                )
                await expectCanStillCommit(t, aliceGroup, f.impl)
            }
        })
}

for (const cs of sampleCiphersuites()) {
    receiptTest('received Update with an invalid leaf is rejected', cs,
        async (t, f) => {
            // correctly signed, but carrying an extension its own
            // capabilities do not list
            const leaf = await updateLeaf(f.bobGroup, f.bob, f.impl, [
                { extensionType: 8545, extensionData: new Uint8Array() },
            ])
            const msg = await memberProposal(f.bobGroup, f.bob, {
                proposalType: 'update',
                update: { leafNode: leaf },
            }, f.impl)

            const aliceGroup = await expectRejected(
                t,
                f.aliceGroup,
                msg,
                f.impl,
                'Update whose leaf fails leaf validation'
            )
            await expectCanStillCommit(t, aliceGroup, f.impl)
        })
}

for (const cs of sampleCiphersuites()) {
    receiptTest('valid proposals of every type are accepted and committed ' +
        'by reference', cs, async (t, f) => {
        const { impl } = f
        const pskId = new Uint8Array([9, 9, 9])
        const pskIndex = makePskIndex(undefined, {
            [bytesToBase64(pskId)]: new Uint8Array(impl.kdf.size).fill(7),
        })

        // Honest proposals go through createProposal, which applies the
        // same checks, so the proposer stores them too.
        let alice = f.aliceGroup
        let bob = f.bobGroup
        let charlie = f.charlieGroup

        const deliver = async (msg:MLSMessage) => {
            alice = await receive(alice, msg, impl, pskIndex)
            bob = await receive(bob, msg, impl, pskIndex)
        }
        const propose = async (publicMessage:boolean, proposal:Proposal) => {
            const result = await createProposal(
                charlie,
                publicMessage,
                proposal,
                impl
            )
            charlie = result.newState
            await deliver(result.message)
        }

        // 1. Add, PreSharedKey and GroupContextExtensions from a member,
        //    over both wire formats, plus a new_member_proposal Add
        const dave = await makeMember('dave', impl)
        const erin = await makeMember('erin', impl)
        await propose(true, {
            proposalType: 'add',
            add: { keyPackage: dave.publicPackage },
        })
        await propose(false, {
            proposalType: 'psk',
            psk: {
                preSharedKeyId: {
                    psktype: 'external',
                    pskId,
                    pskNonce: impl.rng.randomBytes(impl.kdf.size),
                },
            },
        })
        await propose(true, {
            proposalType: 'group_context_extensions',
            groupContextExtensions: {
                extensions: alice.groupContext.extensions,
            },
        })
        const groupInfo = await createGroupInfoWithExternalPub(
            alice,
            [],
            impl
        )
        await deliver(await proposeAddExternal(
            groupInfo,
            erin.publicPackage,
            erin.privatePackage,
            impl
        ))

        t.equal(
            Object.keys(alice.unappliedProposals).length,
            4,
            'every valid proposal is stored'
        )

        const first = await createCommit({
            state: alice,
            cipherSuite: impl,
            pskIndex
        })
        alice = first.newState
        bob = await receive(bob, first.commit, impl, pskIndex)
        t.deepEqual(
            bob.keySchedule.epochAuthenticator,
            alice.keySchedule.epochAuthenticator,
            'a peer accepts the commit of Add, PSK and GCE by reference'
        )
        let daveGroup = await joinGroup(
            first.welcome!,
            dave.publicPackage,
            dave.privatePackage,
            pskIndex,
            impl,
            alice.ratchetTree,
            undefined,
            testClientConfig
        )
        t.deepEqual(
            daveGroup.keySchedule.epochAuthenticator,
            alice.keySchedule.epochAuthenticator,
            'the Added member joins'
        )

        // 2. Remove from an external sender, alongside an Add re-admitting
        //    the removed member under the same signature key
        const charlieAgain = await reissueKeyPackage(f.charlie, impl)
        const nextInfo = await createGroupInfoWithExternalPub(alice, [], impl)
        for (const proposal of [
            { proposalType: 'remove', remove: { removed: 2 } },
            { proposalType: 'add', add: { keyPackage: charlieAgain } },
        ] satisfies Proposal[]) {
            const msg = await proposeExternal(
                nextInfo,
                proposal,
                f.externalSender.publicPackage.leafNode.signaturePublicKey,
                f.externalSender.privatePackage.signaturePrivateKey,
                impl
            )
            await deliver(msg)
            daveGroup = await receive(daveGroup, msg, impl)
        }
        const second = await createCommit({ state: alice, cipherSuite: impl })
        alice = second.newState
        bob = await receive(bob, second.commit, impl)
        daveGroup = await receive(daveGroup, second.commit, impl)
        t.deepEqual(
            bob.keySchedule.epochAuthenticator,
            alice.keySchedule.epochAuthenticator,
            'a peer accepts the commit of external Remove and re-Add'
        )

        // 3. Update from a member. The proposer here keeps no private key
        //    for its new leaf, so dave, not bob, checks the commit.
        const update = await createProposal(bob, true, {
            proposalType: 'update',
            update: { leafNode: await updateLeaf(bob, f.bob, impl) },
        }, impl)
        alice = await receive(alice, update.message, impl)
        daveGroup = await receive(daveGroup, update.message, impl)
        const third = await createCommit({ state: alice, cipherSuite: impl })
        alice = third.newState
        daveGroup = await receive(daveGroup, third.commit, impl)
        t.deepEqual(
            daveGroup.keySchedule.epochAuthenticator,
            alice.keySchedule.epochAuthenticator,
            'a peer accepts the commit of the Update by reference'
        )

        // 4. ReInit from a member
        const reinit = await createProposal(daveGroup, true, {
            proposalType: 'reinit',
            reinit: {
                groupId: new TextEncoder().encode('receipt-group-2'),
                version: 'mls10',
                cipherSuite: cs,
                extensions: [],
            },
        }, impl)
        alice = await receive(alice, reinit.message, impl)
        const fourth = await createCommit({ state: alice, cipherSuite: impl })
        daveGroup = await receive(reinit.newState, fourth.commit, impl)
        t.equal(
            daveGroup.groupActiveState.kind,
            'suspendedPendingReinit',
            'a peer accepts the commit of the ReInit by reference'
        )
    })
}

interface Member {
    publicPackage:KeyPackage
    privatePackage:PrivateKeyPackage
}

interface ReceiptFixture {
    impl:CiphersuiteImpl
    alice:Member
    bob:Member
    charlie:Member
    externalSender:Member
    aliceGroup:ClientState
    bobGroup:ClientState
    charlieGroup:ClientState
}

function receiptTest (
    name:string,
    cs:CiphersuiteName,
    fn:(t:any, f:ReceiptFixture) => Promise<void>
):void {
    test(`${name} - ${cs}`, async (t) => {
        let fixture:ReceiptFixture
        try {
            fixture = await makeReceiptFixture(cs)
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError'
            ) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
        await fn(t, fixture)
    })
}

async function makeMember (
    name:string,
    impl:CiphersuiteImpl,
    lifetime = defaultLifetime(),
):Promise<Member> {
    return generateKeyPackage(
        { credentialType: 'basic', identity: new TextEncoder().encode(name) },
        defaultCapabilities(),
        lifetime,
        [],
        impl
    )
}

/**
 * alice (leaf 0), bob (leaf 1) and charlie (leaf 2) in one group, with an
 * `external_senders` extension naming a fourth key pair.
 */
async function makeReceiptFixture (
    cs:CiphersuiteName
):Promise<ReceiptFixture> {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)
    const charlie = await makeMember('charlie', impl)
    const externalSender = await makeMember('external', impl)

    const externalSenders:Extension = {
        extensionType: 'external_senders',
        extensionData: encodeExternalSenders([{
            credential: externalSender.publicPackage.leafNode.credential,
            signaturePublicKey:
                externalSender.publicPackage.leafNode.signaturePublicKey,
        }]),
    }

    const created = await createGroup(
        new TextEncoder().encode('receipt-group'),
        alice.publicPackage,
        alice.privatePackage,
        [externalSenders],
        impl,
        testClientConfig
    )

    const addBoth = await createCommit(
        { state: created, cipherSuite: impl },
        {
            extraProposals: [
                { proposalType: 'add', add: { keyPackage: bob.publicPackage } },
                {
                    proposalType: 'add',
                    add: { keyPackage: charlie.publicPackage }
                },
            ],
        }
    )

    const join = (m:Member) => joinGroup(
        addBoth.welcome!,
        m.publicPackage,
        m.privatePackage,
        emptyPskIndex,
        impl,
        addBoth.newState.ratchetTree,
        undefined,
        testClientConfig
    )

    return {
        impl,
        alice,
        bob,
        charlie,
        externalSender,
        aliceGroup: addBoth.newState,
        bobGroup: await join(bob),
        charlieGroup: await join(charlie),
    }
}

/**
 * Re-signs `member`'s KeyPackage after applying `changes`, so the only
 * thing wrong with the result is the change itself.
 */
async function resignKeyPackage (
    member:Member,
    changes:Partial<Omit<KeyPackage, 'signature'>>,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const { signature: _signature, ...tbs } = member.publicPackage
    return signKeyPackage(
        { ...tbs, ...changes },
        member.privatePackage.signaturePrivateKey,
        impl.signature
    )
}

/**
 * A fresh KeyPackage for `member` -- new init and encryption keys -- under
 * the same credential and signature key, as a client re-joining would
 * publish.
 */
async function reissueKeyPackage (
    member:Member,
    impl:CiphersuiteImpl,
):Promise<KeyPackage> {
    const { signature: _leafSignature, ...leafTbs } =
        member.publicPackage.leafNode
    if (leafTbs.leafNodeSource !== 'key_package') {
        throw new Error('expected a key_package leaf')
    }
    const hpke = await impl.hpke.generateKeyPair()
    const init = await impl.hpke.generateKeyPair()
    const signKey = member.privatePackage.signaturePrivateKey
    const leafNode = await signLeafNodeKeyPackage({
        ...leafTbs,
        hpkePublicKey: await impl.hpke.exportPublicKey(hpke.publicKey),
        info: { leafNodeSource: 'key_package' },
    }, signKey, impl.signature)
    return resignKeyPackage(member, {
        initKey: await impl.hpke.exportPublicKey(init.publicKey),
        leafNode,
    }, impl)
}

/**
 * Sends an Add of `joiner` to alice three ways -- from bob, from the
 * group's external sender, and as the joiner's own new_member_proposal --
 * and expects each to be rejected, leaving alice able to commit.
 */
async function expectAddRejectedFromEverySender (
    t:any,
    f:ReceiptFixture,
    joiner:Member,
    what:string,
):Promise<void> {
    const add:Proposal = {
        proposalType: 'add',
        add: { keyPackage: joiner.publicPackage },
    }
    const groupInfo = await createGroupInfoWithExternalPub(
        f.aliceGroup,
        [],
        f.impl
    )

    const fromMember = await memberProposal(f.bobGroup, f.bob, add, f.impl)
    const fromExternal = await proposeExternal(
        groupInfo,
        add,
        f.externalSender.publicPackage.leafNode.signaturePublicKey,
        f.externalSender.privatePackage.signaturePrivateKey,
        f.impl
    )
    const fromNewMember = await proposeAddExternal(
        groupInfo,
        joiner.publicPackage,
        joiner.privatePackage,
        f.impl
    )

    for (const [sender, msg] of [
        ['member', fromMember],
        ['external', fromExternal],
        ['new_member_proposal', fromNewMember],
    ] as const) {
        const aliceGroup = await expectRejected(
            t,
            f.aliceGroup,
            msg,
            f.impl,
            `${what} (${sender} sender)`
        )
        await expectCanStillCommit(t, aliceGroup, f.impl)
    }
}

/**
 * A member's proposal, signed and MACed exactly as `createProposal` would,
 * but without the local validation `createProposal` applies.
 */
async function memberProposal (
    state:ClientState,
    member:Member,
    proposal:Proposal,
    impl:CiphersuiteImpl,
):Promise<MLSMessage> {
    const { publicMessage } = await protectProposalPublic(
        member.privatePackage.signaturePrivateKey,
        state.keySchedule.membershipKey,
        state.groupContext,
        new Uint8Array(),
        proposal,
        state.privatePath.leafIndex,
        impl
    )
    return { wireformat: 'mls_public_message', version: 'mls10', publicMessage }
}

async function receive (
    state:ClientState,
    msg:MLSMessage,
    impl:CiphersuiteImpl,
    pskIndex:PskIndex = emptyPskIndex,
):Promise<ClientState> {
    if (
        msg.wireformat !== 'mls_public_message' &&
        msg.wireformat !== 'mls_private_message'
    ) {
        throw new Error('expected a handshake message')
    }
    const result = await processMessage(
        msg,
        state,
        pskIndex,
        acceptAll,
        impl
    )
    return result.newState
}

/**
 * A signed update-source leaf for `member` at its current leaf index, with
 * a fresh encryption key.
 */
async function updateLeaf (
    state:ClientState,
    member:Member,
    impl:CiphersuiteImpl,
    extensions:Extension[] = member.publicPackage.leafNode.extensions,
):Promise<LeafNodeUpdate> {
    const fresh = await impl.hpke.generateKeyPair()
    const tbs = {
        ...member.publicPackage.leafNode,
        leafNodeSource: 'update' as const,
        hpkePublicKey: await impl.hpke.exportPublicKey(fresh.publicKey),
        extensions,
        info: {
            leafNodeSource: 'update' as const,
            groupId: state.groupContext.groupId,
            leafIndex: state.privatePath.leafIndex,
        },
    }
    const { lifetime: _lifetime, signature: _signature, ...rest } = tbs
    const signed = {
        ...rest,
        signature: await signWithLabel(
            member.privatePackage.signaturePrivateKey,
            'LeafNodeTBS',
            encodeLeafNodeTBS(rest),
            impl.signature
        ),
    }
    const { info: _info, ...leaf } = signed
    return leaf
}

async function externalProposal (
    state:ClientState,
    signer:Member,
    proposal:Proposal,
    sender:SenderNonMember,
    impl:CiphersuiteImpl,
):Promise<MLSMessage> {
    const { publicMessage } = await protectExternalProposalPublic(
        signer.privatePackage.signaturePrivateKey,
        state.groupContext,
        new Uint8Array(),
        proposal,
        sender,
        impl
    )
    return { wireformat: 'mls_public_message', version: 'mls10', publicMessage }
}

/**
 * Hands `msg` to the receiver and asserts a `ValidationError`. Returns the
 * state the receiver carries on with: its own, if the message was
 * rejected, or whatever processing produced, if it was (wrongly) stored --
 * so the follow-up commit exercises the state a stored proposal leaves.
 */
async function expectRejected (
    t:any,
    state:ClientState,
    msg:MLSMessage,
    impl:CiphersuiteImpl,
    what:string,
):Promise<ClientState> {
    try {
        const newState = await receive(state, msg, impl)
        t.fail(`${what} should be rejected on receipt`)
        return newState
    } catch (error) {
        t.ok(
            error instanceof ValidationError,
            `${what} is rejected on receipt with ValidationError`
        )
        return state
    }
}

async function expectCanStillCommit (
    t:any,
    state:ClientState,
    impl:CiphersuiteImpl,
):Promise<void> {
    let commitError:unknown
    try {
        await createCommit({ state, cipherSuite: impl })
    } catch (error) {
        commitError = error
    }
    t.equal(commitError, undefined, 'receiver can still create a commit')

    let appError:unknown
    try {
        await createApplicationMessage(
            state,
            new TextEncoder().encode('hi'),
            impl
        )
    } catch (error) {
        appError = error
    }
    t.equal(appError, undefined, 'receiver can still send application data')
}

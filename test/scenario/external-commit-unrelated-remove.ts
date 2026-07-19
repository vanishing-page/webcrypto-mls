import { test } from '@substrate-system/tapzero'
import type { ClientState } from '../../src/client-state.js'
import {
    createGroup,
    joinGroup,
    makePskIndex,
    exportSecret,
    validateRatchetTree,
    throwIfDefined,
    nextEpochContext,
} from '../../src/client-state.js'
import {
    createGroupInfoWithExternalPubAndRatchetTree,
    createCommit,
} from '../../src/create-commit.js'
import { processPublicMessage } from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import type { Credential } from '../../src/credential.js'
import type { CiphersuiteImpl, CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import {
    getCiphersuiteFromName,
    ciphersuites
} from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { generateKeyPackage } from '../../src/key-package.js'
import type { KeyPackage, PrivateKeyPackage } from '../../src/key-package.js'
import type { ProposalAdd, Proposal, ProposalExternalInit } from '../../src/proposal.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import type { GroupInfo } from '../../src/group-info.js'
import {
    ratchetTreeFromExtension,
    verifyGroupInfoSignature,
} from '../../src/group-info.js'
import {
    addLeafNode,
    getCredentialFromLeafIndex,
    getSignaturePublicKeyFromLeafIndex,
    removeLeafNode,
} from '../../src/ratchet-tree.js'
import { createUpdatePath } from '../../src/update-path.js'
import { updateLeafKey, toPrivateKeyPath } from '../../src/private-key-path.js'
import { pathToPathSecrets } from '../../src/path-secrets.js'
import { deriveSecret } from '../../src/crypto/kdf.js'
import { createContentCommitSignature, createConfirmationTag } from '../../src/framed-content.js'
import type { AuthenticatedContentCommit } from '../../src/authenticated-content.js'
import { treeHashRoot } from '../../src/tree-hash.js'
import type { LeafIndex } from '../../src/treemath.js'
import { leafWidth, nodeToLeafIndex, toLeafIndex } from '../../src/treemath.js'
import { initializeEpoch } from '../../src/key-schedule.js'
import { createSecretTree } from '../../src/secret-tree.js'
import { protectPublicMessage } from '../../src/message-protection-public.js'
import { defaultClientConfig } from '../../src/client-config.js'
import { CryptoVerificationError, UsageError, ValidationError } from '../../src/mls-error.js'

for (const cs of Object.keys(ciphersuites)) {
    test(`External commit Remove targeting unrelated member is rejected ${cs}`, async (t) => {
        try {
            await externalCommitUnrelatedRemoveTest(cs as CiphersuiteName, t)
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

/**
 * Forges a `new_member_commit` external-join PublicMessage whose Remove
 * proposal targets an arbitrary leaf, regardless of whether that leaf
 * actually belongs to the joiner (unlike `joinGroupExternal`'s `resync`
 * flag, which only ever targets a leaf that matches the joiner's own
 * key package). Used to simulate H5's "forged new_member_commit" attack.
 */
async function forgeExternalCommitWithRemove (
    groupInfo:GroupInfo,
    keyPackage:KeyPackage,
    privateKeys:PrivateKeyPackage,
    removedLeafIndex:LeafIndex,
    cs:CiphersuiteImpl,
) {
    const externalPub = groupInfo.extensions.find((ex) => ex.extensionType === 'external_pub')
    if (externalPub === undefined) throw new UsageError('Could not find external_pub extension')

    const { enc, secret: initSecret } = await exportSecret(externalPub.extensionData, cs)

    const ratchetTree = ratchetTreeFromExtension(groupInfo)
    if (ratchetTree === undefined) throw new UsageError('No ratchet_tree extension')

    throwIfDefined(
        await validateRatchetTree(
            ratchetTree,
            groupInfo.groupContext,
            defaultClientConfig.lifetimeConfig,
            defaultClientConfig.authService,
            groupInfo.groupContext.treeHash,
            cs,
        ),
    )

    const signaturePublicKey = getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer))
    const signerCredential = getCredentialFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer))
    const credentialVerified = await defaultClientConfig.authService.validateCredential(signerCredential, signaturePublicKey)
    if (!credentialVerified) throw new ValidationError('Could not validate credential')

    const groupInfoSignatureVerified = await verifyGroupInfoSignature(groupInfo, signaturePublicKey, cs.signature)
    if (!groupInfoSignatureVerified) throw new CryptoVerificationError('Could not verify groupInfo Signature')

    // Unlike the real resync flow, target `removedLeafIndex` unconditionally
    // -- this is the forged attack, not a legitimate resync.
    const updatedTree = removeLeafNode(ratchetTree, removedLeafIndex)

    const [treeWithNewLeafNode, newLeafNodeIndex] = addLeafNode(updatedTree, keyPackage.leafNode)

    const [newTree, updatePath, pathSecrets, newPrivateKey] = await createUpdatePath(
        treeWithNewLeafNode,
        nodeToLeafIndex(newLeafNodeIndex),
        groupInfo.groupContext,
        privateKeys.signaturePrivateKey,
        cs,
    )

    const privateKeyPath = updateLeafKey(
        await toPrivateKeyPath(pathToPathSecrets(pathSecrets), nodeToLeafIndex(newLeafNodeIndex), cs),
        await cs.hpke.exportPrivateKey(newPrivateKey),
    )

    const lastPathSecret = pathSecrets.at(-1)
    const commitSecret = lastPathSecret === undefined
        ? new Uint8Array(cs.kdf.size)
        : await deriveSecret(lastPathSecret.secret, 'path', cs.kdf)

    const externalInitProposal:ProposalExternalInit = {
        proposalType: 'external_init',
        externalInit: { kemOutput: enc },
    }
    const proposals:Proposal[] = [
        { proposalType: 'remove', remove: { removed: removedLeafIndex } },
        externalInitProposal,
    ]

    const pskSecret = new Uint8Array(cs.kdf.size)

    const { signature, framedContent } = await createContentCommitSignature(
        groupInfo.groupContext,
        'mls_public_message',
        { proposals: proposals.map((p) => ({ proposalOrRefType: 'proposal' as const, proposal: p })), path: updatePath },
        { senderType: 'new_member_commit' },
        new Uint8Array(),
        privateKeys.signaturePrivateKey,
        cs.signature,
    )

    const treeHash = await treeHashRoot(newTree, cs.hash)

    const groupContext = await nextEpochContext(
        groupInfo.groupContext,
        'mls_public_message',
        framedContent,
        signature,
        treeHash,
        groupInfo.confirmationTag,
        cs.hash,
    )

    const epochSecrets = await initializeEpoch(initSecret, commitSecret, groupContext, pskSecret, cs.kdf)

    const confirmationTag = await createConfirmationTag(
        epochSecrets.keySchedule.confirmationKey,
        groupContext.confirmedTranscriptHash,
        cs.hash,
    )

    const state:ClientState = {
        ratchetTree: newTree,
        groupContext,
        secretTree: await createSecretTree(leafWidth(newTree.length), epochSecrets.keySchedule.encryptionSecret, cs.kdf),
        privatePath: privateKeyPath,
        confirmationTag,
        historicalReceiverData: new Map(),
        signaturePrivateKey: privateKeys.signaturePrivateKey,
        keySchedule: epochSecrets.keySchedule,
        unappliedProposals: {},
        groupActiveState: { kind: 'active' },
        clientConfig: defaultClientConfig,
    }

    const authenticatedContent:AuthenticatedContentCommit = {
        content: framedContent,
        auth: { signature, confirmationTag, contentType: 'commit' },
        wireformat: 'mls_public_message',
    }

    const msg = await protectPublicMessage(epochSecrets.keySchedule.membershipKey, groupContext, authenticatedContent, cs)

    return { publicMessage: msg, newState: state }
}

async function externalCommitUnrelatedRemoveTest (cipherSuite:CiphersuiteName, t:any) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cipherSuite))

    const aliceCredential:Credential = { credentialType: 'basic', identity: new TextEncoder().encode('alice') }
    const alice = await generateKeyPackage(aliceCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const groupId = new TextEncoder().encode('group1')

    let aliceGroup = await createGroup(groupId, alice.publicPackage, alice.privatePackage, [], impl)

    const bobCredential:Credential = { credentialType: 'basic', identity: new TextEncoder().encode('bob') }
    const bob = await generateKeyPackage(bobCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const addBobProposal:ProposalAdd = { proposalType: 'add', add: { keyPackage: bob.publicPackage } }

    const addBobCommitResult = await createCommit(
        { state: aliceGroup, cipherSuite: impl },
        { extraProposals: [addBobProposal], ratchetTreeExtension: true },
    )

    aliceGroup = addBobCommitResult.newState

    const bobGroup = await joinGroup(
        addBobCommitResult.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
    )

    t.deepEqual(bobGroup.keySchedule.epochAuthenticator, aliceGroup.keySchedule.epochAuthenticator, 'bob should have matching epoch authenticator')

    // mallory is an outsider who is not a member of the group, and has no
    // relation to bob's leaf whatsoever.
    const malloryCredential:Credential = { credentialType: 'basic', identity: new TextEncoder().encode('mallory') }
    const mallory = await generateKeyPackage(malloryCredential, defaultCapabilities(), defaultLifetime, [], impl)

    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(aliceGroup, [], impl)

    // mallory forges an external join commit whose Remove proposal targets
    // bob's leaf (index 1), even though bob's leaf has nothing to do with
    // mallory's own identity/credential -- this is the H5 attack.
    const forgedResult = await forgeExternalCommitWithRemove(
        groupInfo,
        mallory.publicPackage,
        mallory.privatePackage,
        toLeafIndex(1),
        impl,
    )

    let threw = false
    try {
        await processPublicMessage(
            aliceGroup,
            forgedResult.publicMessage,
            makePskIndex(aliceGroup, {}),
            impl,
        )
    } catch (error:any) {
        threw = true
        t.equal(error.name, 'ValidationError', 'rejects external commit Remove targeting an unrelated member with a ValidationError')
    }
    t.ok(threw, 'alice rejects the forged external commit that evicts bob')

    // bob (the would-be victim) is still a member -- processing the forged
    // commit must not have removed him.
    threw = false
    try {
        await processPublicMessage(
            bobGroup,
            forgedResult.publicMessage,
            makePskIndex(bobGroup, {}),
            impl,
        )
    } catch (error:any) {
        threw = true
        t.equal(error.name, 'ValidationError', 'bob also rejects the forged commit that would evict him')
    }
    t.ok(threw, 'bob rejects the forged external commit that evicts him')
}

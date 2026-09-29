import { emptyUnappliedProposals } from './unapplied-proposals.js'
import type {
    ClientState,
    ApplyProposalsResult,
    GroupActiveState
} from './client-state.js'
import {
    addHistoricalReceiverData, makePskIndex, throwIfDefined, validateRatchetTree,
    applyProposals,
    nextEpochContext,
    exportSecret,
    checkCanSendHandshakeMessages,
    validateExternalSenders,
    validateProposalOnReceipt
} from './client-state.js'
import type { AuthenticatedContentCommit } from './authenticated-content.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import { decryptWithLabel } from './crypto/hpke.js'
import { deriveSecret } from './crypto/kdf.js'
import type {
    FramedContentAuthDataCommit,
    FramedContentCommit
} from './framed-content.js'
import {
    createContentCommitSignature,
    createConfirmationTag
} from './framed-content.js'
import type { GroupContext } from './group-context.js'
import { encodeGroupContext } from './group-context.js'
import type {
    GroupInfo,
    GroupInfoTBS
} from './group-info.js'
import {
    ratchetTreeFromExtension,
    signGroupInfo,
    verifyGroupInfoSignature,
} from './group-info.js'
import type { KeyPackage, PrivateKeyPackage } from './key-package.js'
import { makeKeyPackageRef } from './key-package.js'
import type { EpochSecrets } from './key-schedule.js'
import { initializeEpoch } from './key-schedule.js'
import type { MLSMessage } from './message.js'
import { protect } from './message-protection.js'
import { protectPublicMessage } from './message-protection-public.js'
import { pathToPathSecrets } from './path-secrets.js'
import type { PrivateKeyPath } from './private-key-path.js'
import { mergePrivateKeyPaths, pruneBlankedNodes, updateLeafKey, toPrivateKeyPath } from './private-key-path.js'
import type { Proposal, ProposalExternalInit } from './proposal.js'
import { encodeProposal } from './proposal.js'
import type { ProposalOrRef } from './proposal-or-ref-type.js'
import type { PskIndex } from './psk-index.js'
import type { RatchetTree } from './ratchet-tree.js'
import {
    addLeafNode,
    encodeRatchetTree,
    getCredentialFromLeafIndex,
    getSignaturePublicKeyFromLeafIndex,
    removeLeafNode,
} from './ratchet-tree.js'
import type { SecretTree } from './secret-tree.js'
import { createSecretTree } from './secret-tree.js'
import { treeHashRoot } from './tree-hash.js'
import type { LeafIndex, NodeIndex } from './treemath.js'
import { leafToNodeIndex, leafWidth, nodeToLeafIndex, toLeafIndex, toNodeIndex } from './treemath.js'
import type { PathSecret, UpdatePath } from './update-path.js'
import {
    createUpdatePath,
    filterNewLeaves,
    firstCommonAncestor,
    firstMatchAncestor,
    zeroPathSecretsArray
} from './update-path.js'
import { base64ToBytes, bytesToBase64 } from './util/byte-array.js'
import type { Welcome, EncryptedGroupSecrets } from './welcome.js'
import { encryptGroupInfo, encryptGroupSecrets } from './welcome.js'
import {
    CryptoVerificationError,
    UsageError,
    ValidationError,
} from './mls-error.js'
import type { ClientConfig } from './client-config.js'
import { defaultClientConfig } from './client-config.js'
import type { Extension } from './extension.js'
import { extensionsSupportedByCapabilities } from './extension.js'

export interface MLSContext {
    state:ClientState
    cipherSuite:CiphersuiteImpl
    pskIndex?:PskIndex
}

export interface CreateCommitResult {
    newState:ClientState
    welcome:Welcome | undefined
    commit:MLSMessage
}

export interface CreateCommitOptions {
    wireAsPublicMessage?:boolean
    extraProposals?:Proposal[]
    ratchetTreeExtension?:boolean
    groupInfoExtensions?:Extension[]
    authenticatedData?:Uint8Array
}

export async function createCommit (context:MLSContext, options?:CreateCommitOptions):Promise<CreateCommitResult> {
    const { state, pskIndex = makePskIndex(state, {}), cipherSuite } = context
    const {
        wireAsPublicMessage = false,
        extraProposals = [],
        ratchetTreeExtension = false,
        authenticatedData = new Uint8Array(),
        groupInfoExtensions = [],
    } = options ?? {}

    checkCanSendHandshakeMessages(state)

    const wireformat = wireAsPublicMessage ? 'mls_public_message' : 'mls_private_message'

    const allProposals = bundleAllProposals(
        await filterPendingProposals(state, cipherSuite),
        extraProposals,
    )

    const res = await applyProposals(
        state,
        allProposals,
        toLeafIndex(state.privatePath.leafIndex),
        pskIndex,
        true,
        cipherSuite,
    )

    if (res.additionalResult.kind === 'externalCommit') throw new UsageError('Cannot create externalCommit as a member')

    const suspendedPendingReinit = res.additionalResult.kind === 'reinit' ? res.additionalResult.reinit : undefined

    const addedLeafNodeIndices:NodeIndex[] =
        res.additionalResult.kind === 'memberCommit'
            ? res.additionalResult.addedLeafNodes.map((l) => leafToNodeIndex(l[0]))
            : []

    const updatedExtensions =
        res.additionalResult.kind === 'memberCommit' && res.additionalResult.hasGroupContextExtensionsProposal
            ? res.additionalResult.extensions
            : state.groupContext.extensions

    const groupContextWithExtensions = { ...state.groupContext, extensions: updatedExtensions }

    const [tree, updatePath, pathSecrets, newPrivateKey] = res.needsUpdatePath
        ? await createUpdatePath(
            res.tree,
            toLeafIndex(state.privatePath.leafIndex),
            groupContextWithExtensions,
            state.signaturePrivateKey,
            cipherSuite,
            addedLeafNodeIndices,
        )
        : [res.tree, undefined, [] as PathSecret[], undefined]

    const lastPathSecret = pathSecrets.at(-1)

    const commitSecret =
        lastPathSecret === undefined
            ? new Uint8Array(cipherSuite.kdf.size)
            : await deriveSecret(lastPathSecret.secret, 'path', cipherSuite.kdf)

    const { signature, framedContent } = await createContentCommitSignature(
        state.groupContext,
        wireformat,
        { proposals: allProposals, path: updatePath },
        { senderType: 'member', leafIndex: state.privatePath.leafIndex },
        authenticatedData,
        state.signaturePrivateKey,
        cipherSuite.signature,
    )

    const treeHash = await treeHashRoot(tree, cipherSuite.hash)

    const updatedGroupContext = await nextEpochContext(
        groupContextWithExtensions,
        wireformat,
        framedContent,
        signature,
        treeHash,
        state.confirmationTag,
        cipherSuite.hash,
    )

    const epochSecrets = await initializeEpoch(
        state.keySchedule.initSecret,
        commitSecret,
        updatedGroupContext,
        res.pskSecret,
        cipherSuite.kdf,
    )

    const confirmationTag = await createConfirmationTag(
        epochSecrets.keySchedule.confirmationKey,
        updatedGroupContext.confirmedTranscriptHash,
        cipherSuite.hash,
    )

    const authData:FramedContentAuthDataCommit = {
        contentType: framedContent.contentType,
        signature,
        confirmationTag,
    }

    const [commit] = await protectCommit(
        wireAsPublicMessage,
        state,
        authenticatedData,
        framedContent,
        authData,
        cipherSuite,
    )

    const welcome:Welcome | undefined = await createWelcome(
        ratchetTreeExtension,
        updatedGroupContext,
        confirmationTag,
        state,
        tree,
        cipherSuite,
        epochSecrets,
        res,
        pathSecrets,
        groupInfoExtensions,
    )

    // built only once every step that can throw has run, so a failed
    // commit leaves nothing of itself in the private path
    const privateKeys = pruneBlankedNodes(
        mergePrivateKeyPaths(
            newPrivateKey !== undefined ?
                updateLeafKey(
                    state.privatePath,
                    await cipherSuite.hpke.exportPrivateKey(newPrivateKey)
                ) :
                state.privatePath,
            await toPrivateKeyPath(
                pathToPathSecrets(pathSecrets),
                state.privatePath.leafIndex,
                cipherSuite
            ),
        ),
        tree,
    )

    // zeroize only once every consumer -- including createWelcome, which
    // encrypts each new member's share of these same secrets, and the
    // private path above -- has read from pathSecrets; doing this any
    // earlier would hand new joiners an all-zero pathSecret instead of the
    // real one.
    zeroPathSecretsArray(pathSecrets)

    const groupActiveState:GroupActiveState = res.selfRemoved
        ? { kind: 'removedFromGroup' }
        : suspendedPendingReinit !== undefined
            ? { kind: 'suspendedPendingReinit', reinit: suspendedPendingReinit }
            : { kind: 'active' }

    const secretTree = await createSecretTree(
        leafWidth(tree.length),
        epochSecrets.encryptionSecret,
        cipherSuite.kdf,
    )
    epochSecrets.encryptionSecret.fill(0)

    const newState:ClientState = {
        groupContext: updatedGroupContext,
        ratchetTree: tree,
        secretTree,
        keySchedule: epochSecrets.keySchedule,
        privatePath: privateKeys,
        unappliedProposals: emptyUnappliedProposals(),
        historicalReceiverData: addHistoricalReceiverData(state),
        confirmationTag,
        signaturePrivateKey: state.signaturePrivateKey,
        groupActiveState,
        clientConfig: state.clientConfig,
    }

    return { newState, welcome, commit }
}

function bundleAllProposals (
    pendingRefs:Uint8Array[],
    extraProposals:Proposal[],
):ProposalOrRef[] {
    const refs:ProposalOrRef[] = pendingRefs.map((reference) => ({
        proposalOrRefType: 'reference',
        reference,
    }))

    const proposals:ProposalOrRef[] = extraProposals.map((p) => ({ proposalOrRefType: 'proposal', proposal: p }))

    return [...refs, ...proposals]
}

/**
 * The references of the pending proposals this client may commit, per
 * RFC 9420 section 12.2. A pending proposal is dropped when it is
 * invalid against the tree the kept proposals leave (so a second Remove
 * of one leaf names a blank leaf), when it Updates a leaf being removed
 * or the committer's own leaf, or when it repeats a kept proposal.
 * Removes are placed first because every other check depends on which
 * leaves they blank. A dropped proposal is simply not committed; the
 * committed state starts the new epoch with no pending proposals.
 */
async function filterPendingProposals (
    state:ClientState,
    cs:CiphersuiteImpl,
):Promise<Uint8Array[]> {
    const own = state.privatePath.leafIndex
    const pending = Object.entries(state.unappliedProposals)
    const ordered = [
        ...pending.filter(([, p]) => p.proposal.proposalType === 'remove'),
        ...pending.filter(([, p]) => p.proposal.proposalType !== 'remove'),
    ]

    let tree = state.ratchetTree
    const removed = new Set<number>()
    const seen = new Set<string>()
    const kept:Uint8Array[] = []

    for (const [ref, { proposal, senderLeafIndex }] of ordered) {
        const encoded = bytesToBase64(encodeProposal(proposal))
        if (seen.has(encoded)) continue

        if (proposal.proposalType === 'update' &&
            (senderLeafIndex === own ||
                (senderLeafIndex !== undefined &&
                    removed.has(senderLeafIndex)))) {
            continue
        }

        const err = await validateProposalOnReceipt(
            { ...state, ratchetTree: tree },
            proposal,
            senderLeafIndex,
            senderLeafIndex === own,
            cs,
        )
        if (err !== undefined) continue

        if (proposal.proposalType === 'remove') {
            removed.add(proposal.remove.removed)
            tree = removeLeafNode(tree, toLeafIndex(proposal.remove.removed))
        }

        seen.add(encoded)
        kept.push(base64ToBytes(ref))
    }

    return kept
}

async function createWelcome (
    ratchetTreeExtension:boolean,
    groupContext:GroupContext,
    confirmationTag:Uint8Array,
    state:ClientState,
    tree:RatchetTree,
    cs:CiphersuiteImpl,
    epochSecrets:EpochSecrets,
    res:ApplyProposalsResult,
    pathSecrets:PathSecret[],
    extensions:Extension[],
):Promise<Welcome | undefined> {
    const groupInfo = ratchetTreeExtension
        ? await createGroupInfoWithRatchetTree(groupContext, confirmationTag, state, tree, extensions, cs)
        : await createGroupInfo(groupContext, confirmationTag, state, extensions, cs)

    const encryptedGroupInfo = await encryptGroupInfo(groupInfo, epochSecrets.welcomeSecret, cs)

    const encryptedGroupSecrets:EncryptedGroupSecrets[] =
        res.additionalResult.kind === 'memberCommit'
            ? await Promise.all(
                res.additionalResult.addedLeafNodes.map(([leafNodeIndex, keyPackage]) => {
                    return createEncryptedGroupSecrets(
                        tree,
                        leafNodeIndex,
                        state,
                        pathSecrets,
                        cs,
                        keyPackage,
                        encryptedGroupInfo,
                        epochSecrets,
                        res,
                    )
                }),
            )
            : []

    return encryptedGroupSecrets.length > 0
        ? {
            cipherSuite: groupContext.cipherSuite,
            secrets: encryptedGroupSecrets,
            encryptedGroupInfo,
        }
        : undefined
}

async function createEncryptedGroupSecrets (
    tree:RatchetTree,
    leafNodeIndex:LeafIndex,
    state:ClientState,
    pathSecrets:PathSecret[],
    cs:CiphersuiteImpl,
    keyPackage:KeyPackage,
    encryptedGroupInfo:Uint8Array,
    epochSecrets:EpochSecrets,
    res:ApplyProposalsResult,
) {
    const nodeIndex = firstCommonAncestor(tree, leafNodeIndex, toLeafIndex(state.privatePath.leafIndex))
    const pathSecret = pathSecrets.find((ps) => ps.nodeIndex === nodeIndex)
    const pk = await cs.hpke.importPublicKey(keyPackage.initKey)
    const egs = await encryptGroupSecrets(
        pk,
        encryptedGroupInfo,
        { joinerSecret: epochSecrets.joinerSecret, pathSecret: pathSecret?.secret, psks: res.pskIds },
        cs.hpke,
    )

    const ref = await makeKeyPackageRef(keyPackage, cs.hash)

    return { newMember: ref, encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct } }
}

export async function createGroupInfo (
    groupContext:GroupContext,
    confirmationTag:Uint8Array,
    state:ClientState,
    extensions:Extension[],
    cs:CiphersuiteImpl,
):Promise<GroupInfo> {
    const groupInfoTbs:GroupInfoTBS = {
        groupContext,
        extensions,
        confirmationTag,
        signer: state.privatePath.leafIndex,
    }

    return signGroupInfo(groupInfoTbs, state.signaturePrivateKey, cs.signature)
}

export async function createGroupInfoWithRatchetTree (
    groupContext:GroupContext,
    confirmationTag:Uint8Array,
    state:ClientState,
    tree:RatchetTree,
    extensions:Extension[],
    cs:CiphersuiteImpl,
):Promise<GroupInfo> {
    const encodedTree = encodeRatchetTree(tree)

    const gi = await createGroupInfo(
        groupContext,
        confirmationTag,
        state,
        [...extensions, { extensionType: 'ratchet_tree', extensionData: encodedTree }],
        cs,
    )

    return gi
}

export async function createGroupInfoWithExternalPub (
    state:ClientState,
    extensions:Extension[],
    cs:CiphersuiteImpl,
):Promise<GroupInfo> {
    const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret)
    const externalPub = await cs.hpke.exportPublicKey(externalKeyPair.publicKey)

    const gi = await createGroupInfo(
        state.groupContext,
        state.confirmationTag,
        state,
        [...extensions, { extensionType: 'external_pub', extensionData: externalPub }],
        cs,
    )

    return gi
}

export async function createGroupInfoWithExternalPubAndRatchetTree (
    state:ClientState,
    extensions:Extension[],
    cs:CiphersuiteImpl,
):Promise<GroupInfo> {
    const encodedTree = encodeRatchetTree(state.ratchetTree)

    const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret)
    const externalPub = await cs.hpke.exportPublicKey(externalKeyPair.publicKey)

    const gi = await createGroupInfo(
        state.groupContext,
        state.confirmationTag,
        state,
        [
            ...extensions,
            { extensionType: 'external_pub', extensionData: externalPub },
            { extensionType: 'ratchet_tree', extensionData: encodedTree },
        ],
        cs,
    )

    return gi
}

async function protectCommit (
    publicMessage:boolean,
    state:ClientState,
    authenticatedData:Uint8Array,
    content:FramedContentCommit,
    authData:FramedContentAuthDataCommit,
    cs:CiphersuiteImpl,
):Promise<[MLSMessage, SecretTree]> {
    const wireformat = publicMessage ? 'mls_public_message' : 'mls_private_message'

    const authenticatedContent:AuthenticatedContentCommit = {
        wireformat,
        content,
        auth: authData,
    }

    if (publicMessage) {
        const msg = await protectPublicMessage(
            state.keySchedule.membershipKey,
            state.groupContext,
            authenticatedContent,
            cs,
        )

        return [{ version: 'mls10', wireformat: 'mls_public_message', publicMessage: msg }, state.secretTree]
    } else {
        const res = await protect(
            state.keySchedule.senderDataSecret,
            authenticatedData,
            state.groupContext,
            state.secretTree,
            { ...content, auth: authData },
            state.privatePath.leafIndex,
            state.clientConfig.paddingConfig,
            cs,
        )

        return [{ version: 'mls10', wireformat: 'mls_private_message', privateMessage: res.privateMessage }, res.tree]
    }
}

export async function applyUpdatePathSecret (
    tree:RatchetTree,
    privatePath:PrivateKeyPath,
    senderLeafIndex:LeafIndex,
    gc:GroupContext,
    path:UpdatePath,
    excludeNodes:NodeIndex[],
    cs:CiphersuiteImpl,
):Promise<{ nodeIndex:NodeIndex; pathSecret:Uint8Array }> {
    const {
        nodeIndex: ancestorNodeIndex,
        resolution,
        updateNode,
    } = firstMatchAncestor(tree, toLeafIndex(privatePath.leafIndex), senderLeafIndex, path)

    if (updateNode === undefined) {
        throw new ValidationError('UpdatePath is missing an UpdatePathNode for the common ancestor')
    }

    const filteredResolution = filterNewLeaves(resolution, excludeNodes)

    if (updateNode.encryptedPathSecret.length !== filteredResolution.length) {
        throw new ValidationError(
            'UpdatePathNode encrypted_path_secret count does not match the copath resolution',
        )
    }

    for (const [i, nodeIndex] of filteredResolution.entries()) {
        if (privatePath.privateKeys[nodeIndex] !== undefined) {
            const key = await cs.hpke.importPrivateKey(privatePath.privateKeys[nodeIndex])
            const ct = updateNode.encryptedPathSecret[i]

            const pathSecret = await decryptWithLabel(
                key,
                'UpdatePathNode',
                encodeGroupContext(gc),
                ct.kemOutput,
                ct.ciphertext,
                cs.hpke,
            )
            return { nodeIndex: ancestorNodeIndex, pathSecret }
        }
    }

    throw new ValidationError(
        'No overlap between provided private keys and update path')
}

export async function joinGroupExternal (
    groupInfo:GroupInfo,
    keyPackage:KeyPackage,
    privateKeys:PrivateKeyPackage,
    resync:boolean,
    cs:CiphersuiteImpl,
    tree?:RatchetTree,
    clientConfig:ClientConfig = defaultClientConfig,
    authenticatedData:Uint8Array = new Uint8Array(),
) {
    const externalPub = groupInfo.extensions.find((ex) => ex.extensionType === 'external_pub')

    if (externalPub === undefined) throw new UsageError('Could not find external_pub extension')

    const allExtensionsSupported = extensionsSupportedByCapabilities(
        groupInfo.groupContext.extensions,
        keyPackage.leafNode.capabilities,
    )
    if (!allExtensionsSupported) throw new UsageError('client does not support every extension in the GroupContext')

    throwIfDefined(
        await validateExternalSenders(
            groupInfo.groupContext.extensions,
            clientConfig.authService,
        ),
    )

    const { enc, secret: initSecret } = await exportSecret(externalPub.extensionData, cs)

    const ratchetTree = ratchetTreeFromExtension(groupInfo) ?? tree

    if (ratchetTree === undefined) throw new UsageError('No RatchetTree passed and no ratchet_tree extension')

    throwIfDefined(
        await validateRatchetTree(
            ratchetTree,
            groupInfo.groupContext,
            clientConfig.lifetimeConfig,
            clientConfig.authService,
            groupInfo.groupContext.treeHash,
            cs,
        ),
    )

    const signaturePublicKey = getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer))

    const signerCredential = getCredentialFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer))

    const credentialVerified = await clientConfig.authService.validateCredential(signerCredential, signaturePublicKey)

    if (!credentialVerified) throw new ValidationError('Could not validate credential')

    const groupInfoSignatureVerified = await verifyGroupInfoSignature(groupInfo, signaturePublicKey, cs.signature)

    if (!groupInfoSignatureVerified) throw new CryptoVerificationError('Could not verify groupInfo Signature')

    const formerLeafIndex = resync
        ? (() => {
            const foundNodeIndex = ratchetTree.findIndex((n) => {
                if (n !== undefined && n.nodeType === 'leaf') {
                    return clientConfig.keyPackageEqualityConfig.compareKeyPackageToLeafNode(keyPackage, n.leaf)
                }
                return false
            })
            if (foundNodeIndex === -1) {
                throw new ValidationError(
                    'resync external join: no prior leaf matches this credential',
                )
            }
            return nodeToLeafIndex(toNodeIndex(foundNodeIndex))
        })()
        : undefined

    const updatedTree = formerLeafIndex !== undefined ? removeLeafNode(ratchetTree, formerLeafIndex) : ratchetTree

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

    const commitSecret =
        lastPathSecret === undefined
            ? new Uint8Array(cs.kdf.size)
            : await deriveSecret(lastPathSecret.secret, 'path', cs.kdf)

    zeroPathSecretsArray(pathSecrets)

    const externalInitProposal:ProposalExternalInit = {
        proposalType: 'external_init',
        externalInit: { kemOutput: enc },
    }
    const proposals:Proposal[] =
        formerLeafIndex !== undefined
            ? [{ proposalType: 'remove', remove: { removed: formerLeafIndex } }, externalInitProposal]
            : [externalInitProposal]

    const pskSecret = new Uint8Array(cs.kdf.size)

    const { signature, framedContent } = await createContentCommitSignature(
        groupInfo.groupContext,
        'mls_public_message',
        { proposals: proposals.map((p) => ({ proposalOrRefType: 'proposal', proposal: p })), path: updatePath },
        {
            senderType: 'new_member_commit',
        },
        authenticatedData,
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

    const secretTree = await createSecretTree(
        leafWidth(newTree.length),
        epochSecrets.encryptionSecret,
        cs.kdf,
    )
    epochSecrets.encryptionSecret.fill(0)

    const state:ClientState = {
        ratchetTree: newTree,
        groupContext,
        secretTree,
        privatePath: privateKeyPath,
        confirmationTag,
        historicalReceiverData: new Map(),
        signaturePrivateKey: privateKeys.signaturePrivateKey,
        keySchedule: epochSecrets.keySchedule,
        unappliedProposals: emptyUnappliedProposals(),
        groupActiveState: { kind: 'active' },
        clientConfig,
    }

    const authenticatedContent:AuthenticatedContentCommit = {
        content: framedContent,
        auth: { signature, confirmationTag, contentType: 'commit' },
        wireformat: 'mls_public_message',
    }

    const msg = await protectPublicMessage(epochSecrets.keySchedule.membershipKey, groupContext, authenticatedContent, cs)

    return { publicMessage: msg, newState: state }
}

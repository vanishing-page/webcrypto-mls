import type { AuthenticatedContent } from './authenticated-content.js'
import { makeProposalRef } from './authenticated-content.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import { getCiphersuiteFromName } from './crypto/ciphersuite.js'
import { isSmallOrderSignatureKey } from './crypto/small-order.js'
import type { Hash } from './crypto/hash.js'
import type { Hpke } from './crypto/hpke.js'
import type { SignatureSecretKey } from './crypto/signature.js'
import type { Extension } from './extension.js'
import { extensionsEqual, extensionsSupportedByCapabilities } from './extension.js'
import type { FramedContentCommit } from './framed-content.js'
import { createConfirmationTag } from './framed-content.js'
import type { GroupContext } from './group-context.js'
import { ratchetTreeFromExtension, verifyGroupInfoConfirmationTag, verifyGroupInfoSignature } from './group-info.js'
import type { KeyPackage, PrivateKeyPackage } from './key-package.js'
import { makeKeyPackageRef, verifyKeyPackage } from './key-package.js'
import type { KeySchedule } from './key-schedule.js'
import { deriveEpochKeys, deriveKeySchedule } from './key-schedule.js'
import type { PreSharedKeyID, PreSharedKeyIdResumption } from './presharedkey.js'
import { encodePskId } from './presharedkey.js'

import type { RatchetTree } from './ratchet-tree.js'
import {
    addLeafNode,
    findBlankLeafNodeIndexOrExtend,
    findLeafIndex,
    getHpkePublicKey,
    removeLeafNode,
    updateLeafNode
} from './ratchet-tree.js'
import type { SecretTree } from './secret-tree.js'
import { createSecretTree, stripHandshakeRatchets } from './secret-tree.js'
import { createConfirmedHash, createInterimHash } from './transcript-hash.js'
import { treeHashRoot } from './tree-hash.js'
import type { LeafIndex, NodeIndex } from './treemath.js'
import {
    directPath,
    isLeaf,
    leafToNodeIndex,
    leafWidth,
    nodeToLeafIndex,
    toLeafIndex,
    toNodeIndex,
} from './treemath.js'
import { firstCommonAncestor } from './update-path.js'
import { bytesToBase64 } from './util/byte-array.js'
import { constantTimeEqual } from './util/constant-time-compare.js'
import type { Welcome } from './welcome.js'
import { decryptGroupInfo, decryptGroupSecrets } from './welcome.js'
import type { WireformatName } from './wireformat.js'
import type { ProposalOrRef } from './proposal-or-ref-type.js'
import type {
    Proposal,
    ProposalAdd,
    ProposalExternalInit,
    ProposalGroupContextExtensions,
    ProposalPSK,
    ProposalReinit,
    ProposalRemove,
    ProposalUpdate,
    Reinit,
    Remove,
} from './proposal.js'
import type { PrivateKeyPath } from './private-key-path.js'
import { deriveWelcomePrivateKeyPath } from './private-key-path.js'
import type { UnappliedProposals, ProposalWithSender } from './unapplied-proposals.js'
import {
    addUnappliedProposal,
    checkPendingCapacity,
    emptyUnappliedProposals,
    findUnappliedProposal
} from './unapplied-proposals.js'
import type { PskIndex } from './psk-index.js'
import { accumulatePskSecret } from './psk-index.js'
import type { SenderTypeName } from './sender.js'
import { getSenderLeafNodeIndex } from './sender.js'
import { addToMap } from './util/add-to-map.js'
import type { MlsError } from './mls-error.js'
import {
    CryptoVerificationError,
    CodecError,
    InternalError,
    UsageError,
    ValidationError
} from './mls-error.js'
import type { Signature } from './crypto/signature.js'
import type {
    LeafNode,
    LeafNodeCommit,
    LeafNodeKeyPackage,
    LeafNodeUpdate
} from './leaf-node.js'
import {
    verifyLeafNodeSignature,
    verifyLeafNodeSignatureKeyPackage,
} from './leaf-node.js'
import { protocolVersions } from './protocol-version.js'
import type { RequiredCapabilities } from './required-capabilities.js'
import { decodeRequiredCapabilities } from './required-capabilities.js'
import type { Capabilities } from './capabilities.js'
import { verifyParentHashes } from './parent-hash.js'
import type { AuthenticationService } from './authentication-service.js'
import type { Credential } from './credential.js'
import type { LifetimeConfig } from './lifetime-config.js'
import type { KeyPackageEqualityConfig } from './key-package-equality-config.js'
import { sameMemberLeafNodes } from './key-package-equality-config.js'
import type { ClientConfig } from './client-config.js'
import { defaultClientConfig } from './client-config.js'
import { decodeExternalSenders } from './external-sender.js'

export type GroupActiveState =
  | { kind:'active' }
  | { kind:'suspendedPendingReinit'; reinit:Reinit }
  | { kind:'removedFromGroup' }

/**
 * This type contains everything necessary to receieve application messages for an earlier epoch
 */
export interface EpochReceiverData {
    resumptionPsk:Uint8Array
    secretTree:SecretTree
    ratchetTree:RatchetTree
    senderDataSecret:Uint8Array
    groupContext:GroupContext
}

export interface ClientState {
    groupContext:GroupContext
    keySchedule:KeySchedule
    secretTree:SecretTree
    ratchetTree:RatchetTree
    privatePath:PrivateKeyPath
    signaturePrivateKey:SignatureSecretKey
    unappliedProposals:UnappliedProposals
    confirmationTag:Uint8Array
    historicalReceiverData:Map<bigint, EpochReceiverData>
    groupActiveState:GroupActiveState
    clientConfig:ClientConfig
}

export function checkCanSendApplicationMessages (state:ClientState):void {
    if (Object.keys(state.unappliedProposals).length !== 0) { throw new UsageError('Cannot send application message with unapplied proposals') }

    checkCanSendHandshakeMessages(state)
}

export function checkCanSendHandshakeMessages (state:ClientState):void {
    if (state.groupActiveState.kind === 'suspendedPendingReinit') { throw new UsageError('Cannot send messages while Group is suspended pending reinit') } else if (state.groupActiveState.kind === 'removedFromGroup') { throw new UsageError('Cannot send messages after being removed from group') }
}

export interface Proposals {
    add:{ senderLeafIndex:number | undefined; proposal:ProposalAdd }[]
    update:{ senderLeafIndex:number | undefined; proposal:ProposalUpdate }[]
    remove:{ senderLeafIndex:number | undefined; proposal:ProposalRemove }[]
    psk:{ senderLeafIndex:number | undefined; proposal:ProposalPSK }[]
    reinit:{ senderLeafIndex:number | undefined; proposal:ProposalReinit }[]
    external_init:{ senderLeafIndex:number | undefined; proposal:ProposalExternalInit }[]
    group_context_extensions:{ senderLeafIndex:number | undefined; proposal:ProposalGroupContextExtensions }[]
}

const emptyProposals:Proposals = {
    add: [],
    update: [],
    remove: [],
    psk: [],
    reinit: [],
    external_init: [],
    group_context_extensions: [],
}

function flattenExtensions (groupContextExtensions:{ proposal:ProposalGroupContextExtensions }[]):Extension[] {
    return groupContextExtensions.reduce((acc, { proposal }) => {
        return [...acc, ...proposal.groupContextExtensions.extensions]
    }, [] as Extension[])
}

function validateNoDuplicatePskIds (psk:{ proposal:ProposalPSK }[]):ValidationError | undefined {
    const multiplePskWithSamePskId = psk.some((a, indexA) =>
        psk.some(
            (b, indexB) =>
                constantTimeEqual(encodePskId(a.proposal.psk.preSharedKeyId), encodePskId(b.proposal.psk.preSharedKeyId)) &&
        indexA !== indexB,
        ),
    )

    if (multiplePskWithSamePskId) return new ValidationError('Commit cannot contain PreSharedKey proposals that reference the same PreSharedKeyID')
}

async function validateProposals (
    p:Proposals,
    committerLeafIndex:number | undefined,
    groupContext:GroupContext,
    config:KeyPackageEqualityConfig,
    authService:AuthenticationService,
    tree:RatchetTree,
):Promise<MlsError | undefined> {
    const containsUpdateByCommitter = p.update.some(
        (o) => o.senderLeafIndex !== undefined && o.senderLeafIndex === committerLeafIndex,
    )

    if (containsUpdateByCommitter) { return new ValidationError('Commit cannot contain an update proposal sent by committer') }

    const containsRemoveOfCommitter = p.remove.some((o) => o.proposal.remove.removed === committerLeafIndex)

    if (containsRemoveOfCommitter) { return new ValidationError('Commit cannot contain a remove proposal removing committer') }

    const multipleUpdateRemoveForSameLeaf =
        p.update.some(
            ({ senderLeafIndex: a }, indexA) =>
                p.update.some(({ senderLeafIndex: b }, indexB) => a === b && indexA !== indexB) ||
        p.remove.some((r) => r.proposal.remove.removed === a),
        ) ||
    p.remove.some(
        (a, indexA) =>
            p.remove.some((b, indexB) => b.proposal.remove.removed === a.proposal.remove.removed && indexA !== indexB) ||
        p.update.some(({ senderLeafIndex }) => a.proposal.remove.removed === senderLeafIndex),
    )

    if (multipleUpdateRemoveForSameLeaf) {
        return new ValidationError(
            'Commit cannot contain multiple update and/or remove proposals that apply to the same leaf',
        )
    }

    const multipleAddsContainSameKeypackage = p.add.some(({ proposal: a }, indexA) =>
        p.add.some(
            ({ proposal: b }, indexB) => config.compareKeyPackages(a.add.keyPackage, b.add.keyPackage) && indexA !== indexB,
        ),
    )

    if (multipleAddsContainSameKeypackage) {
        return new ValidationError(
            'Commit cannot contain multiple Add proposals that contain KeyPackages that represent the same client',
        )
    }

    // checks if there is an Add proposal with a KeyPackage that matches a client already in the group
    // unless there is a Remove proposal in the list removing the matching client from the group.
    const addsContainExistingKeypackage = p.add.some(({ proposal }) =>
        tree.some(
            (node, nodeIndex) =>
                node !== undefined &&
        node.nodeType === 'leaf' &&
        config.compareKeyPackageToLeafNode(proposal.add.keyPackage, node.leaf) &&
        p.remove.every((r) => r.proposal.remove.removed !== nodeToLeafIndex(toNodeIndex(nodeIndex))),
        ),
    )

    if (addsContainExistingKeypackage) { return new ValidationError('Commit cannot contain an Add proposal for someone already in the group') }

    // an Add joins the group under the extensions the commit leaves in
    // place: the proposed ones if a GroupContextExtensions proposal is
    // present, otherwise the current ones
    const extensionsAfterCommit = p.group_context_extensions.length > 0 ?
        flattenExtensions(p.group_context_extensions) :
        groupContext.extensions

    const everyLeafSupportsGroupExtensions = p.add.every(({ proposal }) =>
        extensionsSupportedByCapabilities(
            extensionsAfterCommit,
            proposal.add.keyPackage.leafNode.capabilities,
        ),
    )

    if (!everyLeafSupportsGroupExtensions) { return new ValidationError("Added leaf node that doesn't support extension in GroupContext") }

    const duplicatePskError = validateNoDuplicatePskIds(p.psk)
    if (duplicatePskError !== undefined) return duplicatePskError

    const pskProposalError = validatePskProposals(p.psk.map((o) => o.proposal.psk.preSharedKeyId), groupContext)

    if (pskProposalError !== undefined) return pskProposalError

    const multipleGroupContextExtensions = p.group_context_extensions.length > 1

    if (multipleGroupContextExtensions) { return new ValidationError('Commit cannot contain multiple GroupContextExtensions proposals') }

    const allExtensions = flattenExtensions(p.group_context_extensions)
    const remainingCapabilities = postMutationLeafCapabilities(tree, p)

    if (allExtensions.length > 0) {
        const everyRemainingLeafSupportsNewExtensions = remainingCapabilities.every(
            (caps) => extensionsSupportedByCapabilities(allExtensions, caps),
        )

        if (!everyRemainingLeafSupportsNewExtensions) { return new ValidationError("Existing member doesn't support extension in proposed GroupContextExtensions") }
    }

    const requiredCapabilities = allExtensions.find((e) => e.extensionType === 'required_capabilities')

    if (requiredCapabilities !== undefined) {
        const caps = decodeRequiredCapabilities(requiredCapabilities.extensionData, 0)
        if (caps === undefined) return new CodecError('Could not decode required_capabilities')

        const everyLeafSupportsCapabilities = remainingCapabilities
            .every((leafCaps) => capabiltiesAreSupported(caps[0], leafCaps))

        if (!everyLeafSupportsCapabilities) return new ValidationError('Not all members support required capabilities')

        const allAdditionsSupportCapabilities = p.add.every((a) =>
            capabiltiesAreSupported(caps[0], a.proposal.add.keyPackage.leafNode.capabilities),
        )

        if (!allAdditionsSupportCapabilities) { return new ValidationError('Commit contains add proposals of member without required capabilities') }
    }

    return await validateExternalSenders(allExtensions, authService)
}

/**
 * RFC 9420 SS12.1.8.2: every identity listed in an `external_senders`
 * GroupContext extension may sign proposals into the group, so it has to
 * clear the same credential bar as a member. `createGroup` checks the
 * extension it is given; `joinGroup`/`joinGroupExternal` check the one
 * they find in the group they are joining, so a joiner never inherits an
 * external signer its own `AuthenticationService` would refuse.
 */
export async function validateExternalSenders (
    extensions:Extension[],
    authService:AuthenticationService,
):Promise<MlsError | undefined> {
    const externalSendersExtension = extensions.find((e) => e.extensionType === 'external_senders')
    if (externalSendersExtension === undefined) return undefined

    const decoded = decodeExternalSenders(externalSendersExtension.extensionData, 0)
    if (decoded === undefined) return new CodecError('Could not decode external_senders')

    for (const externalSender of decoded[0]) {
        const validCredential = await authService.validateCredential(externalSender.credential, externalSender.signaturePublicKey)
        if (!validCredential) return new ValidationError('Could not validate external credential')
    }
}

/**
 * The capabilities of every leaf that will remain in the tree once `p`'s
 * add/update/remove proposals are applied: removed leaves are excluded, and
 * updated leaves report the capabilities from their update proposal rather
 * than their current (pre-commit) leaf node. Extension-support checks over
 * this list run against the post-mutation membership instead of the stale
 * pre-commit tree.
 */
function postMutationLeafCapabilities (tree:RatchetTree, p:Proposals):Capabilities[] {
    return tree.reduce((acc, n, nodeIndex) => {
        if (n === undefined || n.nodeType !== 'leaf') return acc

        const leafIndex = nodeToLeafIndex(toNodeIndex(nodeIndex))
        if (p.remove.some((r) => r.proposal.remove.removed === leafIndex)) return acc

        const update = p.update.find((u) => u.senderLeafIndex === leafIndex)
        acc.push(update !== undefined ? update.proposal.update.leafNode.capabilities : n.leaf.capabilities)
        return acc
    }, [] as Capabilities[])
}

function capabiltiesAreSupported (caps:RequiredCapabilities, cs:Capabilities):boolean {
    return (
        caps.credentialTypes.every((c) => cs.credentials.includes(c)) &&
    caps.extensionTypes.every((e) => cs.extensions.includes(e)) &&
    caps.proposalTypes.every((p) => cs.proposals.includes(p))
    )
}

/**
 * RFC 9420 SS7.9: each entry in a parent node's unmerged_leaves must be a
 * leaf index whose leaf node is non-blank AND a descendant of that parent
 * (either failing condition makes the entry invalid), and every non-blank
 * intermediate node on the path between that leaf and the parent must also
 * list the leaf in its own unmerged_leaves (membership, not array equality --
 * different nodes on the same path may carry different unmerged_leaves sets).
 */
export function validateUnmergedLeaves (tree:RatchetTree):MlsError | undefined {
    for (const [parentIndex, n] of tree.entries()) {
        if (n?.nodeType === 'parent') {
            for (const unmergedLeaf of n.parent.unmergedLeaves) {
                const leafIndex = toLeafIndex(unmergedLeaf)
                const dp = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length))
                const nodeIndex = leafToNodeIndex(leafIndex)
                if (tree[nodeIndex]?.nodeType !== 'leaf' || !dp.includes(toNodeIndex(parentIndex))) { return new ValidationError('Unmerged leaf did not represent a non-blank descendant leaf node') }

                // only the nodes strictly between the leaf and the parent
                // under inspection are constrained; `dp` runs leaf-ward to
                // root-ward, so everything before `parentIndex` is "between".
                const between = dp.slice(0, dp.indexOf(toNodeIndex(parentIndex)))

                for (const parentIdx of between) {
                    const dpNode = tree[parentIdx]

                    if (dpNode !== undefined) {
                        if (dpNode.nodeType !== 'parent') return new InternalError('Expected parent node')

                        if (!dpNode.parent.unmergedLeaves.includes(unmergedLeaf)) { return new ValidationError('non-blank intermediate node must list leaf node in its unmerged_leaves') }
                    }
                }
            }
        }
    }
}

export async function validateRatchetTree (
    tree:RatchetTree,
    groupContext:GroupContext,
    config:LifetimeConfig,
    authService:AuthenticationService,
    treeHash:Uint8Array,
    cs:CiphersuiteImpl,
):Promise<MlsError | undefined> {
    const treeIsStructurallySound = tree.every((n, index) =>
        isLeaf(toNodeIndex(index)) ? n === undefined || n.nodeType === 'leaf' : n === undefined || n.nodeType === 'parent',
    )

    if (!treeIsStructurallySound) return new ValidationError('Received Ratchet Tree is not structurally sound')

    const parentHashesVerified = await verifyParentHashes(tree, cs.hash)

    if (!parentHashesVerified) return new CryptoVerificationError('Unable to verify parent hash')

    if (!constantTimeEqual(treeHash, await treeHashRoot(tree, cs.hash))) { return new ValidationError('Unable to verify tree hash') }

    const unmergedLeavesError = validateUnmergedLeaves(tree)

    if (unmergedLeavesError) return unmergedLeavesError

    const duplicateHpkeKeys = hasDuplicateUint8Arrays(
        tree.map((n) => (n !== undefined ? getHpkePublicKey(n) : undefined)),
    )

    if (duplicateHpkeKeys) return new ValidationError('Multiple public keys with the same value')

    // validate all leaf nodes
    for (const [index, n] of tree.entries()) {
        if (n?.nodeType === 'leaf') {
            const err =
                n.leaf.leafNodeSource === 'key_package'
                    ? await validateLeafNodeKeyPackage(
                        n.leaf,
                        groupContext,
                        tree,
                        false,
                        config,
                        authService,
                        nodeToLeafIndex(toNodeIndex(index)),
                        cs.signature,
                    )
                    : await validateLeafNodeUpdateOrCommit(
                        n.leaf,
                        nodeToLeafIndex(toNodeIndex(index)),
                        groupContext,
                        tree,
                        authService,
                        cs.signature,
                    )

            if (err !== undefined) return err
        }
    }
}

function hasDuplicateUint8Arrays (byteArrays:(Uint8Array | undefined)[]):boolean {
    const seen = new Set<string>()

    for (const data of byteArrays) {
        if (data === undefined) continue

        const key = bytesToBase64(data)
        if (seen.has(key)) {
            return true
        }
        seen.add(key)
    }

    return false
}

export async function validateLeafNodeUpdateOrCommit (
    leafNode:LeafNodeCommit | LeafNodeUpdate,
    leafIndex:number,
    groupContext:GroupContext,
    tree:RatchetTree,
    authService:AuthenticationService,
    s:Signature,
    // overrides the credential read from `tree`, for an external resync
    // whose Remove has already blanked the replaced leaf
    priorCredential:Credential | undefined = credentialAtLeaf(tree, leafIndex),
):Promise<MlsError | undefined> {
    // Checked before the signature: a small-order key makes a forged
    // signature verify, so it has to fail as a key (audit M4).
    if (hasSmallOrderSignatureKey(leafNode, groupContext)) {
        return new ValidationError('Signature key is of small order')
    }

    const signatureValid = await verifyLeafNodeSignature(leafNode, groupContext.groupId, leafIndex, s)

    if (!signatureValid) return new CryptoVerificationError('Could not verify leaf node signature')

    const commonError = await validateLeafNodeCommon(
        leafNode,
        groupContext,
        tree,
        authService,
        leafIndex,
        priorCredential,
    )

    if (commonError !== undefined) return commonError
}

/**
 * RFC 9420 SS12.1.2: an Update carries a new encryption key. One that keeps
 * the sender's current key is rejected; `validateLeafNodeUpdateOrCommit`
 * cannot catch it, because its uniqueness check skips the leaf being
 * replaced.
 */
function validateUpdateRotatesKey (
    leafNode:LeafNodeUpdate,
    leafIndex:number,
    tree:RatchetTree,
):MlsError | undefined {
    const current = tree[leafToNodeIndex(toLeafIndex(leafIndex))]

    if (
        current?.nodeType === 'leaf' &&
        constantTimeEqual(current.leaf.hpkePublicKey, leafNode.hpkePublicKey)
    ) {
        return new ValidationError(
            'Update must carry a new encryption key',
        )
    }
}

/**
 * The credential a leaf carries *before* the replacement being validated. An
 * Update proposal and a commit's UpdatePath are both checked against the tree
 * as it stands before the new leaf is merged, so this is the outgoing
 * identity. Blank leaf (an external commit joining at a free index) means
 * nothing is being replaced.
 */
function credentialAtLeaf (tree:RatchetTree, leafIndex:number):Credential | undefined {
    const node = tree[leafToNodeIndex(toLeafIndex(leafIndex))]

    if (node === undefined || node.nodeType !== 'leaf') return undefined

    return node.leaf.credential
}

export function throwIfDefined (err:MlsError | undefined):void {
    if (err !== undefined) throw err
}

function hasSmallOrderSignatureKey (
    leafNode:LeafNode,
    groupContext:GroupContext,
):boolean {
    const alg = getCiphersuiteFromName(groupContext.cipherSuite).signature
    return isSmallOrderSignatureKey(alg, leafNode.signaturePublicKey)
}

async function validateLeafNodeCommon (
    leafNode:LeafNode,
    groupContext:GroupContext,
    tree:RatchetTree,
    authService:AuthenticationService,
    leafIndex?:number,
    priorCredential?:Credential,
) {
    const credentialValid = await authService.validateCredential(
        leafNode.credential,
        leafNode.signaturePublicKey,
        priorCredential,
    )

    if (!credentialValid) return new ValidationError('Could not validate credential')

    const requiredCapabilities = groupContext.extensions.find((e) => e.extensionType === 'required_capabilities')

    if (requiredCapabilities !== undefined) {
        const caps = decodeRequiredCapabilities(requiredCapabilities.extensionData, 0)
        if (caps === undefined) return new CodecError('Could not decode required_capabilities')

        const leafSupportsCapabilities = capabiltiesAreSupported(caps[0], leafNode.capabilities)

        if (!leafSupportsCapabilities) return new ValidationError('LeafNode does not support required capabilities')
    }

    const credentialUnsupported = tree.some(
        (node) =>
            node !== undefined &&
      node.nodeType === 'leaf' &&
      !node.leaf.capabilities.credentials.includes(leafNode.credential.credentialType),
    )

    if (credentialUnsupported) { return new ValidationError('LeafNode has credential that is not supported by member of the group') }

    // RFC 9420 7.3 states the credential-support rule in both directions.
    // The check above is one half: every member must support this leaf's
    // credential type. This is the other half: this leaf must support every
    // credential type already in use. Without it a joining or rotating
    // member can quietly lower the group's credential floor and then present
    // a credential the rest of the group is entitled to expect it can check.
    // The leaf's own index is skipped because the leaf there is the one being
    // replaced; its own credential type is already covered by the check above,
    // which does not skip it.
    const inUseCredentialUnsupported = tree.some(
        (node, nodeIndex) =>
            node !== undefined &&
      node.nodeType === 'leaf' &&
      leafIndex !== nodeToLeafIndex(toNodeIndex(nodeIndex)) &&
      !leafNode.capabilities.credentials.includes(node.leaf.credential.credentialType),
    )

    if (inUseCredentialUnsupported) { return new ValidationError('LeafNode does not support a credential type in use by a member of the group') }

    const extensionsSupported = extensionsSupportedByCapabilities(leafNode.extensions, leafNode.capabilities)

    if (!extensionsSupported) return new ValidationError('LeafNode contains extension not listed in capabilities')

    const keysAreNotUnique = tree.some(
        (node, nodeIndex) =>
            node !== undefined &&
      node.nodeType === 'leaf' &&
      (constantTimeEqual(node.leaf.hpkePublicKey, leafNode.hpkePublicKey) ||
        constantTimeEqual(node.leaf.signaturePublicKey, leafNode.signaturePublicKey)) &&
      leafIndex !== nodeToLeafIndex(toNodeIndex(nodeIndex)),
    )

    if (keysAreNotUnique) return new ValidationError('hpke and signature keys not unique')

    // A leaf's encryption key has to be distinct from *every* node key, not
    // just the other leaves' -- `validateRatchetTree` above rejects any
    // duplicate across the whole tree at join time, so accepting a
    // leaf/parent collision here would build a tree this library itself
    // refuses, wedging all future joins.
    const collidesWithParentKey = tree.some(
        (node) =>
            node !== undefined &&
      node.nodeType === 'parent' &&
      constantTimeEqual(node.parent.hpkePublicKey, leafNode.hpkePublicKey),
    )

    if (collidesWithParentKey) return new ValidationError('hpke key matches an existing parent node key')
}

async function validateLeafNodeKeyPackage (
    leafNode:LeafNodeKeyPackage,
    groupContext:GroupContext,
    tree:RatchetTree,
    sentByClient:boolean,
    config:LifetimeConfig,
    authService:AuthenticationService,
    leafIndex:number | undefined,
    s:Signature,
):Promise<MlsError | undefined> {
    // Checked before the signature: a small-order key makes a forged
    // signature verify, so it has to fail as a key (audit M4).
    if (hasSmallOrderSignatureKey(leafNode, groupContext)) {
        return new ValidationError('Signature key is of small order')
    }

    const signatureValid = await verifyLeafNodeSignatureKeyPackage(leafNode, s)
    if (!signatureValid) return new CryptoVerificationError('Could not verify leaf node signature')

    // verify lifetime
    if (sentByClient || config.validateLifetimeOnReceive) {
        if (leafNode.leafNodeSource === 'key_package') {
            const currentTime = BigInt(Math.floor(Date.now() / 1000))
            if (leafNode.lifetime.notBefore > currentTime || leafNode.lifetime.notAfter < currentTime) { return new ValidationError('Current time not within Lifetime') }

            if (leafNode.lifetime.notAfter - leafNode.lifetime.notBefore > config.maximumTotalLifetime) {
                return new ValidationError('LeafNode lifetime exceeds maximumTotalLifetime')
            }
        }
    }

    const commonError = await validateLeafNodeCommon(leafNode, groupContext, tree, authService, leafIndex)

    if (commonError !== undefined) return commonError
}

async function validateKeyPackage (
    kp:KeyPackage,
    groupContext:GroupContext,
    tree:RatchetTree,
    sentByClient:boolean,
    config:LifetimeConfig,
    authService:AuthenticationService,
    s:Signature,
    hpke:Hpke,
):Promise<MlsError | undefined> {
    if (kp.cipherSuite !== groupContext.cipherSuite) return new ValidationError('Invalid CipherSuite')

    if (kp.version !== groupContext.version) return new ValidationError('Invalid mls version')

    const leafNodeError = await validateLeafNodeKeyPackage(
        kp.leafNode,
        groupContext,
        tree,
        sentByClient,
        config,
        authService,
        undefined,
        s,
    )
    if (leafNodeError !== undefined) return leafNodeError

    const signatureValid = await verifyKeyPackage(kp, s)
    if (!signatureValid) return new CryptoVerificationError('Invalid keypackage signature')

    if (constantTimeEqual(kp.initKey, kp.leafNode.hpkePublicKey)) { return new ValidationError('Cannot have identicial init and encryption keys') }

    // every committer encrypts the Welcome to this key, so one that does
    // not import makes every commit carrying the Add throw
    try {
        await hpke.importPublicKey(kp.initKey)
    } catch {
        return new ValidationError(
            'KeyPackage initKey is not a public key for the ciphersuite',
        )
    }
}

function validateReinit (
    allProposals:ProposalWithSender[],
    reinit:Reinit,
    gc:GroupContext,
):ValidationError | undefined {
    if (allProposals.length !== 1) return new ValidationError('Reinit proposal needs to be commited by itself')

    if (protocolVersions[reinit.version] < protocolVersions[gc.version]) { return new ValidationError('A ReInit proposal cannot use a version less than the version for the current group') }
}

function validateExternalInitSenderType (
    senderType:SenderTypeName,
    externalInitCount:number,
):ValidationError | undefined {
    if (externalInitCount > 0 && senderType !== 'new_member_commit') {
        return new ValidationError('external_init proposal is only permitted in a commit from a new_member_commit sender')
    }

    if (senderType === 'new_member_commit' && externalInitCount !== 1) {
        return new ValidationError('A commit from a new_member_commit sender must contain exactly one external_init proposal')
    }
}

function validateExternalInit (grouped:Proposals):ValidationError | undefined {
    if (grouped.external_init.length > 1) { return new ValidationError('Cannot contain more than one external_init proposal') }

    if (grouped.remove.length > 1) return new ValidationError('Cannot contain more than one remove proposal')

    if (
        grouped.add.length > 0 ||
    grouped.group_context_extensions.length > 0 ||
    grouped.reinit.length > 0 ||
    grouped.update.length > 0
    ) { return new ValidationError('Invalid proposals') }
}

function validateRemove (remove:Remove, tree:RatchetTree):MlsError | undefined {
    if (tree[leafToNodeIndex(toLeafIndex(remove.removed))] === undefined) { return new ValidationError('Tried to remove empty leaf node') }
}

/**
 * RFC 9420 SS12.1.5/11.1/11.2: a PreSharedKey proposal's PreSharedKeyID must
 * reference either an external PSK, or a resumption PSK. Resumption PSKs
 * with usage `reinit`/`branch` are only valid in the commit that creates the
 * new group's first epoch as part of a ReInit/Branch operation (i.e. the
 * committer's group is still at epoch 0); every other commit must use
 * resumption PSKs with usage `application`.
 */
function validatePskProposals (pskIds:PreSharedKeyID[], groupContext:GroupContext):MlsError | undefined {
    const disallowed = pskIds.some(
        (id) => id.psktype === 'resumption' && id.usage !== 'application' && groupContext.epoch !== 0n,
    )

    if (disallowed) {
        return new ValidationError(
            'PreSharedKey proposal must reference an external PSK, an application-usage resumption PSK, ' +
            'or a reinit/branch-usage resumption PSK in the group-creating commit',
        )
    }
}

export type ApplyProposalsData =
  | {
      kind:'memberCommit'
      addedLeafNodes:[LeafIndex, KeyPackage][]
      extensions:Extension[]
      hasGroupContextExtensionsProposal:boolean
  }
  | {
      kind:'externalCommit'
      externalInitSecret:Uint8Array
      newMemberLeafIndex:LeafIndex
      // the credential of the leaf a resync Remove replaces, if any
      priorCredential?:Credential
  }
  | { kind:'reinit'; reinit:Reinit }

export interface ApplyProposalsResult {
    tree:RatchetTree
    pskSecret:Uint8Array
    pskIds:PreSharedKeyID[]
    needsUpdatePath:boolean
    additionalResult:ApplyProposalsData
    selfRemoved:boolean
    allProposals:ProposalWithSender[]
}

export async function applyProposals (
    state:ClientState,
    proposals:ProposalOrRef[],
    committerLeafIndex:LeafIndex | undefined,
    pskSearch:PskIndex,
    sentByClient:boolean,
    cs:CiphersuiteImpl,
    newMemberLeafNode?:LeafNode,
    senderType:SenderTypeName = committerLeafIndex !== undefined ? 'member' : 'new_member_commit',
):Promise<ApplyProposalsResult> {
    const allProposals = proposals.reduce((acc, cur) => {
        if (cur.proposalOrRefType === 'proposal') {
            return [...acc, {
                proposal: cur.proposal,
                senderLeafIndex: committerLeafIndex,
                senderType,
            }]
        }

        const p = findUnappliedProposal(
            cur.reference,
            state.unappliedProposals
        )
        if (p === undefined) throw new ValidationError('Could not find proposal with supplied reference')
        return [...acc, p]
    }, [] as ProposalWithSender[])

    const unsupportedCustomProposal = allProposals.find(
        (cur) =>
            typeof cur.proposal.proposalType === 'number' &&
            !state.clientConfig.supportedCustomProposalTypes.includes(cur.proposal.proposalType),
    )
    if (unsupportedCustomProposal !== undefined) {
        throw new ValidationError(
            `Cannot process commit referencing unsupported custom proposal type ${unsupportedCustomProposal.proposal.proposalType}`,
        )
    }

    const grouped = allProposals.reduce((acc, cur) => {
    // this skips any (opted-in) custom proposals -- they are not applied to the tree
        if (typeof cur.proposal.proposalType === 'number') return acc
        const proposal = acc[cur.proposal.proposalType] ?? []
        return { ...acc, [cur.proposal.proposalType]: [...proposal, cur] }
    }, emptyProposals)

    const zeroes:Uint8Array = new Uint8Array(cs.kdf.size)

    const isExternalInit = grouped.external_init.length > 0

    throwIfDefined(validateExternalInitSenderType(senderType, grouped.external_init.length))

    if (!isExternalInit) {
        if (grouped.reinit.length > 0) {
            const reinit = grouped.reinit.at(0)!.proposal.reinit

            throwIfDefined(validateReinit(allProposals, reinit, state.groupContext))

            return {
                tree: state.ratchetTree,
                pskSecret: zeroes,
                pskIds: [],
                needsUpdatePath: false,
                additionalResult: {
                    kind: 'reinit',
                    reinit,
                },
                selfRemoved: false,
                allProposals,
            }
        }

        throwIfDefined(
            await validateProposals(
                grouped,
                committerLeafIndex,
                state.groupContext,
                state.clientConfig.keyPackageEqualityConfig,
                state.clientConfig.authService,
                state.ratchetTree,
            ),
        )

        const newExtensions = flattenExtensions(grouped.group_context_extensions)

        const [mutatedTree, addedLeafNodes] = await applyTreeMutations(
            state.ratchetTree,
            grouped,
            state.groupContext,
            sentByClient,
            state.clientConfig.authService,
            state.clientConfig.lifetimeConfig,
            cs,
        )

        const [updatedPskSecret, pskIds] = await accumulatePskSecret(
            grouped.psk.map((p) => p.proposal.psk.preSharedKeyId),
            pskSearch,
            cs,
            zeroes,
        )

        const selfRemoved = mutatedTree[leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))] === undefined

        // RFC 9420 SS12.4: a commit needs an UpdatePath unless every proposal
        // it covers is an add, a psk or a reinit. Custom (numeric) proposal
        // types are not among those exceptions, so a custom-only commit still
        // has to rotate key material.
        const hasCustomProposal = allProposals.some(
            (p) => typeof p.proposal.proposalType === 'number',
        )

        const needsUpdatePath =
            allProposals.length === 0 ||
            grouped.update.length > 0 ||
            grouped.remove.length > 0 ||
            grouped.group_context_extensions.length > 0 ||
            hasCustomProposal

        return {
            tree: mutatedTree,
            pskSecret: updatedPskSecret,
            additionalResult: {
                kind: 'memberCommit' as const,
                addedLeafNodes,
                extensions: newExtensions,
                hasGroupContextExtensionsProposal: grouped.group_context_extensions.length > 0,
            },
            pskIds,
            needsUpdatePath,
            selfRemoved,
            allProposals,
        }
    } else {
        // RFC 9420 12.4.3.2: an external commit's proposals must all be provided
        // by value -- a by-reference proposal would let the joiner smuggle in
        // whatever another member's cached unappliedProposals happens to hold.
        if (proposals.some((p) => p.proposalOrRefType === 'reference')) {
            throw new ValidationError('External commit cannot contain proposals by reference')
        }

        throwIfDefined(validateExternalInit(grouped))

        throwIfDefined(validatePskProposals(grouped.psk.map((o) => o.proposal.psk.preSharedKeyId), state.groupContext))

        throwIfDefined(validateNoDuplicatePskIds(grouped.psk))

        const externalRemove = grouped.remove.at(0)
        let priorCredential:Credential | undefined

        if (externalRemove !== undefined) {
            throwIfDefined(validateRemove(externalRemove.proposal.remove, state.ratchetTree))

            const removedNode = state.ratchetTree[leafToNodeIndex(toLeafIndex(externalRemove.proposal.remove.removed))]

            if (
                newMemberLeafNode === undefined ||
                removedNode?.nodeType !== 'leaf' ||
                !constantTimeEqual(removedNode.leaf.signaturePublicKey, newMemberLeafNode.signaturePublicKey)
            ) {
                throw new ValidationError('External commit Remove must target the joiner\'s own prior leaf (resync)')
            }

            priorCredential = removedNode.leaf.credential
        }

        const treeAfterRemove = grouped.remove.reduce((acc, { proposal }) => {
            return removeLeafNode(acc, toLeafIndex(proposal.remove.removed))
        }, state.ratchetTree)

        const zeroes:Uint8Array = new Uint8Array(cs.kdf.size)

        const [updatedPskSecret, pskIds] = await accumulatePskSecret(
            grouped.psk.map((p) => p.proposal.psk.preSharedKeyId),
            pskSearch,
            cs,
            zeroes,
        )

        const initProposal = grouped.external_init.at(0)!

        const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret)

        const externalInitSecret = await importSecret(
            await cs.hpke.exportPrivateKey(externalKeyPair.privateKey),
            initProposal.proposal.externalInit.kemOutput,
            cs,
        )

        return {
            needsUpdatePath: true,
            tree: treeAfterRemove,
            pskSecret: updatedPskSecret,
            pskIds,
            additionalResult: {
                kind: 'externalCommit',
                externalInitSecret,
                newMemberLeafIndex: nodeToLeafIndex(findBlankLeafNodeIndexOrExtend(treeAfterRemove)),
                priorCredential,
            },
            selfRemoved: false,
            allProposals,
        }
    }
}

export function makePskIndex (state:ClientState | undefined, externalPsks:Record<string, Uint8Array>):PskIndex {
    return {
        findPsk (preSharedKeyId) {
            if (preSharedKeyId.psktype === 'external') {
                // Own-property lookup: a pskId that spells an
                // Object.prototype member is an ordinary unknown id.
                const id = bytesToBase64(preSharedKeyId.pskId)
                return Object.hasOwn(externalPsks, id) ?
                    externalPsks[id] :
                    undefined
            }

            if (state !== undefined && constantTimeEqual(preSharedKeyId.pskGroupId, state.groupContext.groupId)) {
                if (preSharedKeyId.pskEpoch === state.groupContext.epoch) return state.keySchedule.resumptionPsk
                else return state.historicalReceiverData.get(preSharedKeyId.pskEpoch)?.resumptionPsk
            }
        },
    }
}

export async function nextEpochContext (
    groupContext:GroupContext,
    wireformat:WireformatName,
    content:FramedContentCommit,
    signature:Uint8Array,
    updatedTreeHash:Uint8Array,
    confirmationTag:Uint8Array,
    h:Hash,
):Promise<GroupContext> {
    const interimTranscriptHash = groupContext.epoch === 0n ?
        new Uint8Array() :
        await createInterimHash(groupContext.confirmedTranscriptHash, confirmationTag, h)
    const newConfirmedHash = await createConfirmedHash(interimTranscriptHash, { wireformat, content, signature }, h)

    return {
        ...groupContext,
        epoch: groupContext.epoch + 1n,
        treeHash: updatedTreeHash,
        confirmedTranscriptHash: newConfirmedHash,
    }
}

async function deriveUpdatedPrivateKeyPath (
    tree:RatchetTree,
    committerLeafIndex:LeafIndex,
    ancestorNodeIndex:NodeIndex,
    pathSecret:Uint8Array | undefined,
    privateKeyPath:PrivateKeyPath,
    cs:CiphersuiteImpl,
):Promise<PrivateKeyPath> {
    if (pathSecret === undefined) return privateKeyPath

    return deriveWelcomePrivateKeyPath(
        tree,
        committerLeafIndex,
        ancestorNodeIndex,
        pathSecret,
        privateKeyPath,
        cs,
    )
}

/**
 * RFC 9420 SS11.3: every member of a branched group is a member of the
 * group it branched from.
 */
function branchMembersMatch (
    newTree:RatchetTree,
    oldTree:RatchetTree,
    equality:KeyPackageEqualityConfig,
):ValidationError | undefined {
    const oldLeaves = oldTree.flatMap((n) =>
        n?.nodeType === 'leaf' ? [n.leaf] : [])
    for (const node of newTree) {
        if (node?.nodeType !== 'leaf') continue
        const known = oldLeaves.some((old) =>
            sameMemberLeafNodes(equality, node.leaf, old))
        if (!known) {
            return new ValidationError(
                'Branch Welcome contains a member not in the old group',
            )
        }
    }
    return undefined
}

/**
 * Consumes `privateKeys.initPrivateKey`: RFC 9420 SS16.8 requires an init
 * key never be reused for a second Welcome, so on success this function
 * zeroizes the caller's `initPrivateKey` buffer in place. A thrown
 * validation error leaves it intact so the caller can retry.
 */
export async function joinGroup (
    welcome:Welcome,
    keyPackage:KeyPackage,
    privateKeys:PrivateKeyPackage,
    pskSearch:PskIndex,
    cs:CiphersuiteImpl,
    ratchetTree?:RatchetTree,
    resumingFromState?:ClientState,
    clientConfig:ClientConfig = defaultClientConfig,
):Promise<ClientState> {
    const keyPackageRef = await makeKeyPackageRef(keyPackage, cs.hash)
    const privKey = await cs.hpke.importPrivateKey(privateKeys.initPrivateKey)
    const groupSecrets = await decryptGroupSecrets(privKey, keyPackageRef, welcome, cs.hpke)

    if (groupSecrets === undefined) throw new CodecError('Could not decode group secrets')

    const zeroes:Uint8Array = new Uint8Array(cs.kdf.size)

    const [pskSecret, pskIds] = await accumulatePskSecret(groupSecrets.psks, pskSearch, cs, zeroes)

    const gi = await decryptGroupInfo(welcome, groupSecrets.joinerSecret, pskSecret, cs)
    if (gi === undefined) throw new CodecError('Could not decode group info')

    // RFC 9420 SS12.4.3: application-usage resumption PSKs carry no group-
    // continuity guarantee (unlike reinit/branch) -- they are resolved via
    // pskSearch just like external PSKs, so they're excluded here.
    const resumptionPsksRequiringPriorState = pskIds.filter(
        (id):id is PreSharedKeyIdResumption => id.psktype === 'resumption' && id.usage !== 'application',
    )

    for (const resumptionPsk of resumptionPsksRequiringPriorState) {
        if (resumingFromState === undefined) throw new ValidationError('No prior state passed for resumption')

        if (resumptionPsk.pskEpoch !== resumingFromState.groupContext.epoch) throw new ValidationError('Epoch mismatch')

        if (!constantTimeEqual(resumptionPsk.pskGroupId, resumingFromState.groupContext.groupId)) { throw new ValidationError('old groupId mismatch') }

        if (gi.groupContext.epoch !== 1n) throw new ValidationError('Resumption must be started at epoch 1')

        if (resumptionPsk.usage === 'reinit') {
            if (resumingFromState.groupActiveState.kind !== 'suspendedPendingReinit') { throw new ValidationError('Found reinit psk but no old suspended clientState') }

            if (!constantTimeEqual(resumingFromState.groupActiveState.reinit.groupId, gi.groupContext.groupId)) { throw new ValidationError('new groupId mismatch') }

            if (resumingFromState.groupActiveState.reinit.version !== gi.groupContext.version) { throw new ValidationError('Version mismatch') }

            if (resumingFromState.groupActiveState.reinit.cipherSuite !== gi.groupContext.cipherSuite) { throw new ValidationError('Ciphersuite mismatch') }

            if (!extensionsEqual(resumingFromState.groupActiveState.reinit.extensions, gi.groupContext.extensions)) { throw new ValidationError('Extensions mismatch') }
        }

        // RFC 9420 SS11.3: a branch keeps the old group's version and
        // suite, and carries exactly one resumption PSK
        if (resumptionPsk.usage === 'branch') {
            const old = resumingFromState.groupContext
            if (gi.groupContext.version !== old.version) {
                throw new ValidationError('Version mismatch')
            }
            if (gi.groupContext.cipherSuite !== old.cipherSuite) {
                throw new ValidationError('Ciphersuite mismatch')
            }
            if (resumptionPsksRequiringPriorState.length !== 1) {
                throw new ValidationError(
                    'A branch Welcome must carry exactly one resumption PSK',
                )
            }
        }
    }

    const allExtensionsSupported = extensionsSupportedByCapabilities(
        gi.groupContext.extensions,
        keyPackage.leafNode.capabilities,
    )
    // the committer admitted a KeyPackage that cannot support the group:
    // a peer-caused condition, so a ValidationError and not a UsageError
    if (!allExtensionsSupported) {
        throw new ValidationError(
            'client does not support every extension in the GroupContext',
        )
    }

    throwIfDefined(
        await validateExternalSenders(
            gi.groupContext.extensions,
            clientConfig.authService,
        ),
    )

    const tree = ratchetTreeFromExtension(gi) ?? ratchetTree

    if (tree === undefined) throw new UsageError('No RatchetTree passed and no ratchet_tree extension')

    const signerNode = tree[leafToNodeIndex(toLeafIndex(gi.signer))]

    if (signerNode === undefined) {
        throw new ValidationError('Could not find signer leafNode')
    }
    if (signerNode.nodeType === 'parent') throw new ValidationError('Expected non blank leaf node')

    const credentialVerified = await clientConfig.authService.validateCredential(
        signerNode.leaf.credential,
        signerNode.leaf.signaturePublicKey,
    )

    if (!credentialVerified) throw new ValidationError('Could not validate credential')

    const groupInfoSignatureVerified = await verifyGroupInfoSignature(
        gi,
        signerNode.leaf.signaturePublicKey,
        cs.signature,
    )

    if (!groupInfoSignatureVerified) throw new CryptoVerificationError('Could not verify groupInfo signature')

    if (gi.groupContext.cipherSuite !== keyPackage.cipherSuite) { throw new ValidationError('cipher suite in the GroupInfo does not match the cipher_suite in the KeyPackage') }

    // The committer is supposed to have run this check when it validated
    // the Add (see `validateKeyPackage`), but a joiner cannot assume the
    // committer is honest: a group running a different protocol version
    // than this KeyPackage advertises must never be joined.
    if (gi.groupContext.version !== keyPackage.version) { throw new ValidationError('version in the GroupInfo does not match the version in the KeyPackage') }

    throwIfDefined(
        await validateRatchetTree(
            tree,
            gi.groupContext,
            clientConfig.lifetimeConfig,
            clientConfig.authService,
            gi.groupContext.treeHash,
            cs,
        ),
    )

    const branchPsk = resumptionPsksRequiringPriorState.find(
        (id) => id.usage === 'branch',
    )
    if (branchPsk !== undefined && resumingFromState !== undefined) {
        throwIfDefined(branchMembersMatch(
            tree,
            resumingFromState.ratchetTree,
            clientConfig.keyPackageEqualityConfig,
        ))
    }

    const newLeaf = findLeafIndex(tree, keyPackage.leafNode)

    if (newLeaf === undefined) throw new ValidationError('Could not find own leaf when processing welcome')

    const privateKeyPath:PrivateKeyPath = {
        leafIndex: newLeaf,
        privateKeys: { [leafToNodeIndex(newLeaf)]: privateKeys.hpkePrivateKey },
    }

    const committerLeafIndex = toLeafIndex(gi.signer)
    const ancestorNodeIndex = firstCommonAncestor(tree, newLeaf, committerLeafIndex)

    // RFC 9420 SS12.4.3.1: a joiner whose common ancestor with the
    // signer is non-blank and does not list it as unmerged cannot follow
    // the next path commit without a path_secret.
    const ancestor = tree[ancestorNodeIndex]
    if (groupSecrets.pathSecret === undefined &&
        ancestor?.nodeType === 'parent' &&
        !ancestor.parent.unmergedLeaves.includes(newLeaf)) {
        throw new ValidationError('Welcome is missing a required path_secret')
    }

    const updatedPkp = await deriveUpdatedPrivateKeyPath(
        tree,
        committerLeafIndex,
        ancestorNodeIndex,
        groupSecrets.pathSecret,
        privateKeyPath,
        cs,
    )

    const { keySchedule, encryptionSecret } = await deriveKeySchedule(
        groupSecrets.joinerSecret, pskSecret, gi.groupContext, cs.kdf)

    const confirmationTagVerified = await verifyGroupInfoConfirmationTag(gi, groupSecrets.joinerSecret, pskSecret, cs)

    if (!confirmationTagVerified) throw new CryptoVerificationError('Could not verify confirmation tag')

    const secretTree = await createSecretTree(
        leafWidth(tree.length), encryptionSecret, cs.kdf)
    encryptionSecret.fill(0)

    privateKeys.initPrivateKey.fill(0)

    return {
        groupContext: gi.groupContext,
        ratchetTree: tree,
        privatePath: updatedPkp,
        signaturePrivateKey: privateKeys.signaturePrivateKey,
        confirmationTag: gi.confirmationTag,
        unappliedProposals: emptyUnappliedProposals(),
        keySchedule,
        secretTree,
        historicalReceiverData: new Map(),
        groupActiveState: { kind: 'active' },
        clientConfig,
    }
}

export async function createGroup (
    groupId:Uint8Array,
    keyPackage:KeyPackage,
    privateKeyPackage:PrivateKeyPackage,
    extensions:Extension[],
    cs:CiphersuiteImpl,
    clientConfig:ClientConfig = defaultClientConfig,
):Promise<ClientState> {
    const ratchetTree:RatchetTree = [{ nodeType: 'leaf', leaf: keyPackage.leafNode }]

    const privatePath:PrivateKeyPath = {
        leafIndex: 0,
        privateKeys: { 0: privateKeyPackage.hpkePrivateKey },
    }

    const confirmedTranscriptHash = new Uint8Array()

    const groupContext:GroupContext = {
        version: 'mls10',
        cipherSuite: cs.name,
        epoch: 0n,
        treeHash: await treeHashRoot(ratchetTree, cs.hash),
        groupId,
        extensions,
        confirmedTranscriptHash,
    }

    throwIfDefined(await validateExternalSenders(extensions, clientConfig.authService))

    const epochSecret = cs.rng.randomBytes(cs.kdf.size)

    const { keySchedule, encryptionSecret } = await deriveEpochKeys(
        epochSecret, cs.kdf)

    const confirmationTag = await createConfirmationTag(keySchedule.confirmationKey, confirmedTranscriptHash, cs.hash)

    const secretTree = await createSecretTree(1, encryptionSecret, cs.kdf)
    encryptionSecret.fill(0)

    return {
        ratchetTree,
        keySchedule,
        secretTree,
        privatePath,
        signaturePrivateKey: privateKeyPackage.signaturePrivateKey,
        unappliedProposals: emptyUnappliedProposals(),
        historicalReceiverData: new Map(),
        groupContext,
        confirmationTag,
        groupActiveState: { kind: 'active' },
        clientConfig,
    }
}

export async function exportSecret (
    publicKey:Uint8Array,
    cs:CiphersuiteImpl,
):Promise<{ enc:Uint8Array; secret:Uint8Array }> {
    return cs.hpke.exportSecret(
        await cs.hpke.importPublicKey(publicKey),
        new TextEncoder().encode('MLS 1.0 external init secret'),
        cs.kdf.size,
        new Uint8Array(),
    )
}

async function importSecret (privateKey:Uint8Array, kemOutput:Uint8Array, cs:CiphersuiteImpl):Promise<Uint8Array> {
    return cs.hpke.importSecret(
        await cs.hpke.importPrivateKey(privateKey),
        new TextEncoder().encode('MLS 1.0 external init secret'),
        kemOutput,
        cs.kdf.size,
        new Uint8Array(),
    )
}

async function applyTreeMutations (
    ratchetTree:RatchetTree,
    grouped:Proposals,
    gc:GroupContext,
    sentByClient:boolean,
    authService:AuthenticationService,
    lifetimeConfig:LifetimeConfig,
    cs:CiphersuiteImpl,
):Promise<[RatchetTree, [LeafIndex, KeyPackage][]]> {
    const treeAfterUpdate = await grouped.update.reduce(async (acc, { senderLeafIndex, proposal }) => {
        if (senderLeafIndex === undefined) throw new InternalError('No sender index found for update proposal')

        // validate against the tree as it stands after the preceding
        // Updates, as the Adds below are: otherwise two Updates in the same
        // commit are never compared to each other, and can share an
        // encryption key or break the pairwise credential rule
        const tree = await acc
        throwIfDefined(
            validateUpdateRotatesKey(
                proposal.update.leafNode,
                senderLeafIndex,
                ratchetTree,
            ),
        )
        throwIfDefined(
            await validateLeafNodeUpdateOrCommit(
                proposal.update.leafNode,
                senderLeafIndex,
                gc,
                tree,
                authService,
                cs.signature,
            ),
        )
        return updateLeafNode(
            tree,
            proposal.update.leafNode,
            toLeafIndex(senderLeafIndex),
        )
    }, Promise.resolve(ratchetTree))

    const treeAfterRemove = grouped.remove.reduce((acc, { proposal }) => {
        throwIfDefined(validateRemove(proposal.remove, ratchetTree))

        return removeLeafNode(acc, toLeafIndex(proposal.remove.removed))
    }, treeAfterUpdate)

    const [treeAfterAdd, addedLeafNodes] = await grouped.add.reduce(
        async (acc, { proposal }) => {
            const [tree, ws] = await acc

            // validate against the tree as it stands after the preceding
            // proposals, not the pre-mutation one: otherwise two Adds in the
            // same commit are never compared to each other and can share an
            // encryption key
            throwIfDefined(
                await validateKeyPackage(
                    proposal.add.keyPackage,
                    gc,
                    tree,
                    sentByClient,
                    lifetimeConfig,
                    authService,
                    cs.signature,
                    cs.hpke,
                ),
            )

            const [updatedTree, leafNodeIndex] = addLeafNode(tree, proposal.add.keyPackage.leafNode)
            return [
                updatedTree,
                [...ws, [nodeToLeafIndex(leafNodeIndex), proposal.add.keyPackage] as [LeafIndex, KeyPackage]],
            ]
        },
        Promise.resolve([treeAfterRemove, []] as [RatchetTree, [LeafIndex, KeyPackage][]]),
    )

    return [treeAfterAdd, addedLeafNodes]
}

/**
 * Rejects a proposal that can never be valid in the current epoch, before
 * it is stored. A stored proposal is bundled by reference into the next
 * commit, so one that `applyProposals` would refuse wedges the group: no
 * one can commit, and no one can send application data while it is
 * pending. The checks here are the ones that depend only on the proposal
 * and the current epoch; the ones that depend on what else a commit
 * carries stay in `applyProposals`.
 */
export async function validateProposalOnReceipt (
    state:ClientState,
    proposal:Proposal,
    senderLeafIndex:number | undefined,
    sentByClient:boolean,
    cs:CiphersuiteImpl,
):Promise<MlsError | undefined> {
    const { authService, lifetimeConfig, keyPackageEqualityConfig } =
        state.clientConfig

    switch (proposal.proposalType) {
        case 'remove':
            return validateRemove(proposal.remove, state.ratchetTree)
        case 'add': {
            const kp = proposal.add.keyPackage
            // An Add of a current member is valid when the same commit
            // removes them (see `validateProposals`), so it is checked
            // against the tree without them rather than refused here.
            const tree = withoutLeavesMatching(
                state.ratchetTree,
                (leaf) =>
                    keyPackageEqualityConfig.compareKeyPackageToLeafNode(
                        kp,
                        leaf,
                    ),
            )
            return asValidationError(await validateKeyPackage(
                kp,
                state.groupContext,
                tree,
                sentByClient,
                lifetimeConfig,
                authService,
                cs.signature,
                cs.hpke,
            ))
        }
        case 'update':
            if (senderLeafIndex === undefined) {
                return new ValidationError(
                    'update proposal can only be sent by a member',
                )
            }
            return validateUpdateRotatesKey(
                proposal.update.leafNode,
                senderLeafIndex,
                state.ratchetTree,
            ) ?? asValidationError(await validateLeafNodeUpdateOrCommit(
                proposal.update.leafNode,
                senderLeafIndex,
                state.groupContext,
                state.ratchetTree,
                authService,
                cs.signature,
            ))
        case 'external_init':
            // only ever valid by value, inside a new_member_commit
            return new ValidationError(
                'external_init is only valid by value in an external commit',
            )
    }
}

/**
 * The message carrying the proposal has already authenticated; a failed
 * signature *inside* the proposal (a KeyPackage's, a leaf's) makes the
 * proposal invalid content, which the error contract reports as a
 * `ValidationError`.
 */
function asValidationError (
    err:MlsError | undefined,
):MlsError | undefined {
    if (err instanceof CryptoVerificationError) {
        return new ValidationError(err.message)
    }
    return err
}

function withoutLeavesMatching (
    tree:RatchetTree,
    matches:(leaf:LeafNode) => boolean,
):RatchetTree {
    return tree.reduce<RatchetTree>((acc, node, nodeIndex) => {
        if (node?.nodeType !== 'leaf' || !matches(node.leaf)) return acc
        return removeLeafNode(acc, nodeToLeafIndex(toNodeIndex(nodeIndex)))
    }, tree)
}

export async function processProposal (
    state:ClientState,
    content:AuthenticatedContent,
    proposal:Proposal,
    cs:CiphersuiteImpl,
):Promise<ClientState> {
    const senderLeafIndex = getSenderLeafNodeIndex(content.content.sender)

    throwIfDefined(checkPendingCapacity(
        state.unappliedProposals,
        state.clientConfig.maxPendingProposals,
    ))

    throwIfDefined(await validateProposalOnReceipt(
        state,
        proposal,
        senderLeafIndex,
        false,
        cs,
    ))

    const ref = await makeProposalRef(content, cs.hash)
    return {
        ...state,
        unappliedProposals: addUnappliedProposal(
            ref,
            state.unappliedProposals,
            proposal,
            senderLeafIndex,
            content.content.sender.senderType,
        ),
    }
}

export function addHistoricalReceiverData (state:ClientState):Map<bigint, EpochReceiverData> {
    const max = state.clientConfig.keyRetentionConfig.retainKeysForEpochs

    if (max <= 0) return new Map()

    // NOTE: applicationExportSecret is deliberately not retained.
    // Attachment CEK derivation (src/attachment/keys.ts:attachmentCek)
    // depends on applicationExportSecret from the current epoch, so
    // receivers cannot decrypt attachments from prior epochs after
    // epoch advance. This is an open design decision; see
    // docs/design-plans/2026-08-19-random-access-attachments.md
    // "Known Limitations" section for implications.
    const withNew = addToMap(state.historicalReceiverData, state.groupContext.epoch, {
        secretTree: stripHandshakeRatchets(state.secretTree),
        ratchetTree: state.ratchetTree,
        senderDataSecret: state.keySchedule.senderDataSecret,
        groupContext: state.groupContext,
        resumptionPsk: state.keySchedule.resumptionPsk,
    })

    const epochs = [...withNew.keys()]

    const result =
        epochs.length >= max
            ? removeOldHistoricalReceiverData(withNew, max)
            : withNew

    return result
}

function removeOldHistoricalReceiverData (
    historicalReceiverData:Map<bigint, EpochReceiverData>,
    max:number,
):Map<bigint, EpochReceiverData> {
    if (max <= 0) return new Map()

    const sortedEpochs = [...historicalReceiverData.keys()].sort((a, b) => (a < b ? -1 : 1))

    return new Map(sortedEpochs.slice(-max).map((epoch) => [epoch, historicalReceiverData.get(epoch)!]))
}

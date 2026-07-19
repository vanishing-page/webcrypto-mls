import type { AuthenticatedContentCommit } from './authenticated-content.js'
import type {
    ClientState,
    GroupActiveState
} from './client-state.js'
import {
    addHistoricalReceiverData,
    applyProposals,
    nextEpochContext,
    processProposal,
    throwIfDefined,
    validateLeafNodeUpdateOrCommit,
} from './client-state.js'
import { applyUpdatePathSecret } from './create-commit.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { Kdf } from './crypto/kdf.js'
import { deriveSecret } from './crypto/kdf.js'
import { verifyConfirmationTag } from './framed-content.js'
import type { GroupContext } from './group-context.js'
import type {
    IncomingMessageAction,
    IncomingMessageCallback
} from './incoming-message-action.js'
import { acceptAll } from './incoming-message-action.js'
import { initializeEpoch } from './key-schedule.js'
import type { MlsPrivateMessage, MlsPublicMessage } from './message.js'
import { unprotectPrivateMessage } from './message-protection.js'
import { unprotectPublicMessage } from './message-protection-public.js'
import {
    CryptoVerificationError,
    InternalError,
    ValidationError
} from './mls-error.js'
import { pathSecretsAlongFilteredPath, zeroPathSecrets } from './path-secrets.js'
import type { PrivateKeyPath } from './private-key-path.js'
import { mergePrivateKeyPaths, toPrivateKeyPath } from './private-key-path.js'
import type { PrivateMessage } from './private-message.js'
import type { PskIndex } from './psk-index.js'
import type { PublicMessage } from './public-message.js'
import type { RatchetTree } from './ratchet-tree.js'
import { findBlankLeafNodeIndex, addLeafNode } from './ratchet-tree.js'
import { createSecretTree } from './secret-tree.js'
import type { Sender } from './sender.js'
import { getSenderLeafNodeIndex } from './sender.js'
import { treeHashRoot } from './tree-hash.js'
import type {
    LeafIndex,
    NodeIndex
} from './treemath.js'
import {
    leafToNodeIndex,
    leafWidth,
    nodeToLeafIndex,
    toLeafIndex,
    toNodeIndex,
} from './treemath.js'
import type { UpdatePath } from './update-path.js'
import { applyUpdatePath } from './update-path.js'
import { addToMap } from './util/add-to-map.js'
import { constantTimeEqual } from './util/constant-time-compare.js'
import type { WireformatName } from './wireformat.js'

export type ProcessMessageResult =
  | {
      kind:'newState'
      newState:ClientState
      actionTaken:IncomingMessageAction
  }
  | { kind:'applicationMessage'; message:Uint8Array; newState:ClientState }

/**
 * Process private message and apply proposal or commit and return the updated ClientState or return an application message
 */
export async function processPrivateMessage (
    state:ClientState,
    pm:PrivateMessage,
    pskSearch:PskIndex,
    cs:CiphersuiteImpl,
    onMessage:IncomingMessageCallback = acceptAll,
):Promise<ProcessMessageResult> {
    if (!constantTimeEqual(pm.groupId, state.groupContext.groupId)) {
        throw new ValidationError('Cannot process message, groupId does not match')
    }

    if (pm.epoch < state.groupContext.epoch) {
        const receiverData = state.historicalReceiverData.get(pm.epoch)

        if (receiverData !== undefined) {
            // commits/proposals from a former epoch are rejected outright,
            // and are checked before decrypting (not after) because the
            // historical secretTree's handshake ratchet is zeroized once the
            // epoch is superseded (see stripHandshakeRatchets) -- decrypting
            // handshake-ratcheted content here is neither possible nor
            // needed.
            if (pm.contentType !== 'application') {
                throw new ValidationError('Cannot process commit or proposal from former epoch')
            }

            const result = await unprotectPrivateMessage(
                receiverData.senderDataSecret,
                pm,
                receiverData.secretTree,
                receiverData.ratchetTree,
                receiverData.groupContext,
                state.clientConfig.keyRetentionConfig,
                cs,
            )

            const newHistoricalReceiverData = addToMap(state.historicalReceiverData, pm.epoch, {
                ...receiverData,
                secretTree: result.tree,
            })

            const newState = { ...state, historicalReceiverData: newHistoricalReceiverData }

            if (result.content.content.contentType !== 'application') {
                throw new InternalError('Decrypted content type does not match the message envelope')
            }

            return { kind: 'applicationMessage', message: result.content.content.applicationData, newState }
        } else {
            throw new ValidationError('Cannot process message, epoch too old')
        }
    }

    const result = await unprotectPrivateMessage(
        state.keySchedule.senderDataSecret,
        pm,
        state.secretTree,
        state.ratchetTree,
        state.groupContext,
        state.clientConfig.keyRetentionConfig,
        cs,
    )

    const updatedState = { ...state, secretTree: result.tree }

    if (result.content.content.contentType === 'application') {
        return { kind: 'applicationMessage', message: result.content.content.applicationData, newState: updatedState }
    } else if (result.content.content.contentType === 'commit') {
        const { newState, actionTaken } = await processCommit(
            updatedState,
            result.content as AuthenticatedContentCommit,
            'mls_private_message',
            pskSearch,
            onMessage,
            cs,
        ) // todo solve with types
        return {
            kind: 'newState',
            newState,
            actionTaken,
        }
    } else {
        const action = onMessage({
            kind: 'proposal',
            proposal: {
                proposal: result.content.content.proposal,
                senderLeafIndex: getSenderLeafNodeIndex(result.content.content.sender),
            },
        })
        if (action === 'reject') {
            return {
                kind: 'newState',
                newState: updatedState,
                actionTaken: action,
            }
        } else {
            return {
                kind: 'newState',
                newState: await processProposal(updatedState, result.content, result.content.content.proposal, cs.hash),
                actionTaken: action,
            }
        }
    }
}

export interface NewStateWithActionTaken {
    newState:ClientState
    actionTaken:IncomingMessageAction
}

export async function processPublicMessage (
    state:ClientState,
    pm:PublicMessage,
    pskSearch:PskIndex,
    cs:CiphersuiteImpl,
    onMessage:IncomingMessageCallback = acceptAll,
):Promise<NewStateWithActionTaken> {
    if (!constantTimeEqual(pm.content.groupId, state.groupContext.groupId)) {
        throw new ValidationError('Cannot process message, groupId does not match')
    }

    if (pm.content.epoch < state.groupContext.epoch) throw new ValidationError('Cannot process message, epoch too old')

    const content = await unprotectPublicMessage(
        state.keySchedule.membershipKey,
        state.groupContext,
        state.ratchetTree,
        pm,
        cs,
    )

    if (content.content.contentType === 'proposal') {
        const action = onMessage({
            kind: 'proposal',
            proposal: { proposal: content.content.proposal, senderLeafIndex: getSenderLeafNodeIndex(content.content.sender) },
        })
        if (action === 'reject') {
            return {
                newState: state,
                actionTaken: action,
            }
        } else {
            return {
                newState: await processProposal(state, content, content.content.proposal, cs.hash),
                actionTaken: action,
            }
        }
    } else {
        return processCommit(state, content as AuthenticatedContentCommit, 'mls_public_message', pskSearch, onMessage, cs) // todo solve with types
    }
}

async function processCommit (
    state:ClientState,
    content:AuthenticatedContentCommit,
    wireformat:WireformatName,
    pskSearch:PskIndex,
    onMessage:IncomingMessageCallback,
    cs:CiphersuiteImpl,
):Promise<NewStateWithActionTaken> {
    if (content.content.epoch !== state.groupContext.epoch) throw new ValidationError('Could not validate epoch')

    const senderLeafIndex =
        content.content.sender.senderType === 'member' ? toLeafIndex(content.content.sender.leafIndex) : undefined

    const result = await applyProposals(
        state,
        content.content.commit.proposals,
        senderLeafIndex,
        pskSearch,
        false,
        cs,
        content.content.commit.path?.leafNode,
        content.content.sender.senderType,
    )

    const action = onMessage({ kind: 'commit', proposals: result.allProposals })

    if (action === 'reject') {
        return { newState: state, actionTaken: action }
    }

    if (content.content.commit.path !== undefined) {
        const committerLeafIndex =
            senderLeafIndex ??
      (result.additionalResult.kind === 'externalCommit' ? result.additionalResult.newMemberLeafIndex : undefined)

        if (committerLeafIndex === undefined) { throw new ValidationError('Cannot verify commit leaf node because no commiter leaf index found') }

        throwIfDefined(
            await validateLeafNodeUpdateOrCommit(
                content.content.commit.path.leafNode,
                committerLeafIndex,
                state.groupContext,
                result.tree,
                state.clientConfig.authService,
                cs.signature,
            ),
        )
    }

    if (result.needsUpdatePath && content.content.commit.path === undefined) { throw new ValidationError('Update path is required') }

    if (result.selfRemoved) {
        return {
            newState: {
                ...state,
                unappliedProposals: {},
                groupActiveState: { kind: 'removedFromGroup' },
            },
            actionTaken: action,
        }
    }

    const groupContextWithExtensions =
        result.additionalResult.kind === 'memberCommit' && result.additionalResult.extensions.length > 0
            ? { ...state.groupContext, extensions: result.additionalResult.extensions }
            : state.groupContext

    const [pkp, commitSecret, tree] = await applyTreeUpdate(
        content.content.commit.path,
        content.content.sender,
        result.tree,
        cs,
        state,
        groupContextWithExtensions,
        result.additionalResult.kind === 'memberCommit'
            ? result.additionalResult.addedLeafNodes.map((l) => leafToNodeIndex(toLeafIndex(l[0])))
            : [findBlankLeafNodeIndex(result.tree) ?? toNodeIndex(result.tree.length + 1)],
        cs.kdf,
    )

    const newTreeHash = await treeHashRoot(tree, cs.hash)

    if (content.auth.contentType !== 'commit') throw new ValidationError('Received content as commit, but not auth') // todo solve this with types?
    const updatedGroupContext = await nextEpochContext(
        groupContextWithExtensions,
        wireformat,
        content.content,
        content.auth.signature,
        newTreeHash,
        state.confirmationTag,
        cs.hash,
    )

    const initSecret =
        result.additionalResult.kind === 'externalCommit'
            ? result.additionalResult.externalInitSecret
            : state.keySchedule.initSecret

    const epochSecrets = await initializeEpoch(initSecret, commitSecret, updatedGroupContext, result.pskSecret, cs.kdf)

    const confirmationTagValid = await verifyConfirmationTag(
        epochSecrets.keySchedule.confirmationKey,
        content.auth.confirmationTag,
        updatedGroupContext.confirmedTranscriptHash,
        cs.hash,
    )

    if (!confirmationTagValid) throw new CryptoVerificationError('Could not verify confirmation tag')

    const secretTree = await createSecretTree(leafWidth(tree.length), epochSecrets.keySchedule.encryptionSecret, cs.kdf)

    const suspendedPendingReinit = result.additionalResult.kind === 'reinit' ? result.additionalResult.reinit : undefined

    const groupActiveState:GroupActiveState = result.selfRemoved
        ? { kind: 'removedFromGroup' }
        : suspendedPendingReinit !== undefined
            ? { kind: 'suspendedPendingReinit', reinit: suspendedPendingReinit }
            : { kind: 'active' }

    return {
        newState: {
            ...state,
            secretTree,
            ratchetTree: tree,
            privatePath: pkp,
            groupContext: updatedGroupContext,
            keySchedule: epochSecrets.keySchedule,
            confirmationTag: content.auth.confirmationTag,
            historicalReceiverData: addHistoricalReceiverData(state),
            unappliedProposals: {},
            groupActiveState,
        },
        actionTaken: action,
    }
}

async function applyTreeUpdate (
    path:UpdatePath | undefined,
    sender:Sender,
    tree:RatchetTree,
    cs:CiphersuiteImpl,
    state:ClientState,
    groupContext:GroupContext,
    excludeNodes:NodeIndex[],
    kdf:Kdf,
):Promise<[PrivateKeyPath, Uint8Array, RatchetTree]> {
    if (path === undefined) return [state.privatePath, new Uint8Array(kdf.size), tree] as const
    if (sender.senderType === 'member') {
        const updatedTree = await applyUpdatePath(tree, toLeafIndex(sender.leafIndex), path, cs.hash)

        const [pkp, commitSecret] = await updatePrivateKeyPath(
            updatedTree,
            state,
            toLeafIndex(sender.leafIndex),
            { ...groupContext, treeHash: await treeHashRoot(updatedTree, cs.hash), epoch: groupContext.epoch + 1n },
            path,
            excludeNodes,
            cs,
        )
        return [pkp, commitSecret, updatedTree] as const
    } else {
        const [treeWithLeafNode, leafNodeIndex] = addLeafNode(tree, path.leafNode)

        const senderLeafIndex = nodeToLeafIndex(leafNodeIndex)
        const updatedTree = await applyUpdatePath(treeWithLeafNode, senderLeafIndex, path, cs.hash, true)

        const [pkp, commitSecret] = await updatePrivateKeyPath(
            updatedTree,
            state,
            senderLeafIndex,
            { ...groupContext, treeHash: await treeHashRoot(updatedTree, cs.hash), epoch: groupContext.epoch + 1n },
            path,
            excludeNodes,
            cs,
        )
        return [pkp, commitSecret, updatedTree] as const
    }
}

async function updatePrivateKeyPath (
    tree:RatchetTree,
    state:ClientState,
    leafNodeIndex:LeafIndex,
    groupContext:GroupContext,
    path:UpdatePath,
    excludeNodes:NodeIndex[],
    cs:CiphersuiteImpl,
):Promise<[PrivateKeyPath, Uint8Array]> {
    const secret = await applyUpdatePathSecret(
        tree,
        state.privatePath,
        leafNodeIndex,
        groupContext,
        path,
        excludeNodes,
        cs,
    )
    const { pathSecrets, lastSecret } = await pathSecretsAlongFilteredPath(
        tree,
        leafNodeIndex,
        toNodeIndex(secret.nodeIndex),
        secret.pathSecret,
        cs.kdf,
    )

    // derive the commit secret before zeroizing pathSecrets: lastSecret is
    // the very same Uint8Array as pathSecrets' final entry
    const commitSecret = await deriveSecret(lastSecret, 'path', cs.kdf)

    const newPkp = mergePrivateKeyPaths(
        state.privatePath,
        await toPrivateKeyPath(pathSecrets, state.privatePath.leafIndex, cs),
    )

    zeroPathSecrets(pathSecrets)

    return [newPkp, commitSecret] as const
}

export async function processMessage (
    message:MlsPrivateMessage | MlsPublicMessage,
    state:ClientState,
    pskIndex:PskIndex,
    action:IncomingMessageCallback,
    cs:CiphersuiteImpl,
):Promise<ProcessMessageResult> {
    if (message.wireformat === 'mls_public_message') {
        const result = await processPublicMessage(state, message.publicMessage, pskIndex, cs, action)

        return { ...result, kind: 'newState' }
    } else return processPrivateMessage(state, message.privateMessage, pskIndex, cs, action)
}

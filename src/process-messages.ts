import { emptyUnappliedProposals } from './unapplied-proposals.js'
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
import {
    defaultIncomingMessageCallback,
} from './incoming-message-action.js'
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
import { mergePrivateKeyPaths, pruneBlankedNodes, toPrivateKeyPath } from './private-key-path.js'
import type { PrivateMessage } from './private-message.js'
import type { PskIndex } from './psk-index.js'
import type { PublicMessage } from './public-message.js'
import type { RatchetTree } from './ratchet-tree.js'
import { findBlankLeafNodeIndex, addLeafNode } from './ratchet-tree.js'
import { createSecretTree } from './secret-tree.js'
import type { Sender, SenderTypeName } from './sender.js'
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

/**
 * The sender MLS authenticated for a processed message. `leafIndex` is the
 * sender's leaf in the ratchet tree: for a `member` it is the signing leaf,
 * for a `new_member_commit` it is the leaf the joiner was placed in. It is
 * absent for sender types that have no leaf.
 */
export interface AuthenticatedSender {
    senderType:SenderTypeName
    leafIndex?:number
}

export type ProcessMessageResult =
  | {
      kind:'newState'
      newState:ClientState
      actionTaken:IncomingMessageAction
      /** Set when the message was a commit that was accepted. */
      committer?:AuthenticatedSender
  }
  | {
      kind:'applicationMessage'
      message:Uint8Array
      newState:ClientState
      sender:AuthenticatedSender
      authenticatedData:Uint8Array
  }

function memberSender (sender:Sender):AuthenticatedSender {
    return sender.senderType === 'member' ?
        { senderType: 'member', leafIndex: sender.leafIndex } :
        { senderType: sender.senderType }
}

/**
 * A commit that removes this client leaves its state frozen at the epoch
 * it was removed in: the group context never advances, only
 * `groupActiveState` flips. That stale state is not a usable receiver --
 * an alternative commit built from the same epoch would fork the client
 * back into a group it no longer belongs to, and the removing commit
 * itself could be replayed forever. Refuse all inbound traffic instead.
 */
function throwIfRemovedFromGroup (state:ClientState):void {
    if (state.groupActiveState.kind === 'removedFromGroup') {
        throw new ValidationError(
            'Cannot process message, this client was removed from the group'
        )
    }
}

/**
 * Process private message and apply proposal or commit and return the updated ClientState or return an application message
 */
export async function processPrivateMessage (
    state:ClientState,
    pm:PrivateMessage,
    pskSearch:PskIndex,
    cs:CiphersuiteImpl,
    onMessage:IncomingMessageCallback = defaultIncomingMessageCallback,
):Promise<ProcessMessageResult> {
    throwIfRemovedFromGroup(state)

    if (!constantTimeEqual(pm.groupId, state.groupContext.groupId)) {
        throw new ValidationError('Cannot process message, groupId does not match')
    }

    // a future epoch has no keys yet; refuse it before touching the
    // ratchet rather than letting it decrypt under the current epoch
    if (pm.epoch > state.groupContext.epoch) {
        throw new ValidationError(
            'Cannot process message, epoch is in the future'
        )
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

            return {
                kind: 'applicationMessage',
                message: result.content.content.applicationData,
                newState,
                sender: memberSender(result.content.content.sender),
                authenticatedData: result.content.content.authenticatedData,
            }
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
        return {
            kind: 'applicationMessage',
            message: result.content.content.applicationData,
            newState: updatedState,
            sender: memberSender(result.content.content.sender),
            authenticatedData: result.content.content.authenticatedData,
        }
    } else if (result.content.content.contentType === 'commit') {
        const { newState, actionTaken, committer } = await processCommit(
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
            ...(committer === undefined ? {} : { committer }),
        }
    } else {
        const action = onMessage({
            kind: 'proposal',
            proposal: {
                proposal: result.content.content.proposal,
                senderLeafIndex: getSenderLeafNodeIndex(result.content.content.sender),
                senderType: result.content.content.sender.senderType,
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
                newState: await processProposal(
                    updatedState,
                    result.content,
                    result.content.content.proposal,
                    cs,
                ),
                actionTaken: action,
            }
        }
    }
}

export interface NewStateWithActionTaken {
    newState:ClientState
    actionTaken:IncomingMessageAction
    /** Set when the message was a commit that was accepted. */
    committer?:AuthenticatedSender
}

export async function processPublicMessage (
    state:ClientState,
    pm:PublicMessage,
    pskSearch:PskIndex,
    cs:CiphersuiteImpl,
    onMessage:IncomingMessageCallback = defaultIncomingMessageCallback,
):Promise<NewStateWithActionTaken> {
    throwIfRemovedFromGroup(state)

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
        if (content.content.epoch !== state.groupContext.epoch) {
            throw new ValidationError(
                content.content.epoch < state.groupContext.epoch ?
                    'Cannot process proposal, epoch too old' :
                    'Cannot process proposal, epoch is in the future',
            )
        }

        const action = onMessage({
            kind: 'proposal',
            proposal: {
                proposal: content.content.proposal,
                senderLeafIndex: getSenderLeafNodeIndex(content.content.sender),
                senderType: content.content.sender.senderType,
            },
        })
        if (action === 'reject') {
            return {
                newState: state,
                actionTaken: action,
            }
        } else {
            return {
                newState: await processProposal(
                    state,
                    content,
                    content.content.proposal,
                    cs,
                ),
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

    const committer:AuthenticatedSender =
        result.additionalResult.kind === 'externalCommit' ?
            {
                senderType: 'new_member_commit',
                leafIndex: result.additionalResult.newMemberLeafIndex,
            } :
            memberSender(content.content.sender)

    const groupContextWithExtensions =
        result.additionalResult.kind === 'memberCommit' && result.additionalResult.hasGroupContextExtensionsProposal
            ? { ...state.groupContext, extensions: result.additionalResult.extensions }
            : state.groupContext

    if (content.content.commit.path !== undefined) {
        const committerLeafIndex =
            senderLeafIndex ??
      (result.additionalResult.kind === 'externalCommit' ? result.additionalResult.newMemberLeafIndex : undefined)

        if (committerLeafIndex === undefined) { throw new ValidationError('Cannot verify commit leaf node because no commiter leaf index found') }

        throwIfDefined(
            await validateLeafNodeUpdateOrCommit(
                content.content.commit.path.leafNode,
                committerLeafIndex,
                groupContextWithExtensions,
                result.tree,
                state.clientConfig.authService,
                cs.signature,
                result.additionalResult.kind === 'externalCommit' ?
                    result.additionalResult.priorCredential :
                    undefined,
            ),
        )
    }

    if (result.needsUpdatePath && content.content.commit.path === undefined) { throw new ValidationError('Update path is required') }

    if (result.selfRemoved) {
        return {
            newState: {
                ...state,
                unappliedProposals: emptyUnappliedProposals(),
                groupActiveState: { kind: 'removedFromGroup' },
            },
            actionTaken: action,
            committer,
        }
    }

    const [pathKeys, commitSecret, tree] = await applyTreeUpdate(
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

    // built only now that the tag has verified: nothing derived from an
    // unauthenticated commit reaches the private path before this point
    const pkp = pruneBlankedNodes(
        pathKeys === undefined ?
            state.privatePath :
            mergePrivateKeyPaths(state.privatePath, pathKeys),
        tree,
    )

    const secretTree = await createSecretTree(
        leafWidth(tree.length),
        epochSecrets.encryptionSecret,
        cs.kdf,
    )
    epochSecrets.encryptionSecret.fill(0)

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
            unappliedProposals: emptyUnappliedProposals(),
            groupActiveState,
        },
        actionTaken: action,
        committer,
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
):Promise<[PrivateKeyPath | undefined, Uint8Array, RatchetTree]> {
    if (path === undefined) {
        return [undefined, new Uint8Array(kdf.size), tree] as const
    }
    if (sender.senderType === 'member') {
        const updatedTree = await applyUpdatePath(tree, toLeafIndex(sender.leafIndex), path, cs.hash)

        const [pathKeys, commitSecret] = await updatePrivateKeyPath(
            updatedTree,
            state,
            toLeafIndex(sender.leafIndex),
            { ...groupContext, treeHash: await treeHashRoot(updatedTree, cs.hash), epoch: groupContext.epoch + 1n },
            path,
            excludeNodes,
            cs,
        )
        return [pathKeys, commitSecret, updatedTree] as const
    } else {
        const [treeWithLeafNode, leafNodeIndex] = addLeafNode(tree, path.leafNode)

        const senderLeafIndex = nodeToLeafIndex(leafNodeIndex)
        const updatedTree = await applyUpdatePath(treeWithLeafNode, senderLeafIndex, path, cs.hash, true)

        const [pathKeys, commitSecret] = await updatePrivateKeyPath(
            updatedTree,
            state,
            senderLeafIndex,
            { ...groupContext, treeHash: await treeHashRoot(updatedTree, cs.hash), epoch: groupContext.epoch + 1n },
            path,
            excludeNodes,
            cs,
        )
        return [pathKeys, commitSecret, updatedTree] as const
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

    // the tree here already carries the committer's advertised keys, so
    // this is where a path secret that does not derive to them is caught
    // (RFC 9420 SS12.4.3.1). The caller merges these into its private path
    // only once the confirmation tag has verified.
    const pathKeys = await toPrivateKeyPath(
        pathSecrets,
        state.privatePath.leafIndex,
        cs,
        tree,
    )

    zeroPathSecrets(pathSecrets)

    return [pathKeys, commitSecret] as const
}

export async function processMessage (
    message:MlsPrivateMessage | MlsPublicMessage,
    state:ClientState,
    pskIndex:PskIndex,
    action:IncomingMessageCallback = defaultIncomingMessageCallback,
    cs:CiphersuiteImpl,
):Promise<ProcessMessageResult> {
    if (message.wireformat === 'mls_public_message') {
        const result = await processPublicMessage(state, message.publicMessage, pskIndex, cs, action)

        return { ...result, kind: 'newState' }
    } else return processPrivateMessage(state, message.privateMessage, pskIndex, cs, action)
}

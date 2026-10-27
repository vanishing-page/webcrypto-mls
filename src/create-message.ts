import type { ClientState } from './client-state.js'
import {
    checkCanSendApplicationMessages,
    checkCanSendHandshakeMessages,
    throwIfDefined,
    validateProposalOnReceipt
} from './client-state.js'
import { makeProposalRef } from './authenticated-content.js'
import { consumedSecrets } from './consumed.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { MLSMessage } from './message.js'
import type { PrivateMessage } from './private-message.js'
import { protectProposal, protectApplicationData } from './message-protection.js'
import { protectProposalPublic } from './message-protection-public.js'
import type { Proposal } from './proposal.js'
import { signLeafNodeUpdate } from './leaf-node.js'
import { resolveLeafNodePatch } from './leaf-node-patch.js'
import type { LeafNodePatch } from './leaf-node-patch.js'
import { InternalError } from './mls-error.js'
import { addPendingUpdateKey } from './pending-update-keys.js'
import { leafToNodeIndex, toLeafIndex } from './treemath.js'
import {
    addUnappliedProposal,
    checkPendingCapacity,
} from './unapplied-proposals.js'

export async function createProposal (
    state:ClientState,
    publicMessage:boolean,
    proposal:Proposal,
    cs:CiphersuiteImpl,
    authenticatedData:Uint8Array = new Uint8Array(),
):Promise<{
    newState:ClientState
    message:MLSMessage
    consumed:Uint8Array[]
}> {
    const { newState, message } = await sendProposal(
        state, publicMessage, proposal, cs, authenticatedData)

    return { newState, message, consumed: consumedSecrets(state, newState) }
}

export interface CreateUpdateProposalOptions {
    authenticatedData?:Uint8Array
    /**
     * Changes to the leaf beyond the fresh HPKE key. The proposal is
     * still signed with the key in the tree; the new leaf is signed with
     * the patch's signature key, if any, and this member signs with it
     * only once a commit applies the Update.
     */
    leafNodePatch?:LeafNodePatch
}

/**
 * Proposes an Update of this member's own leaf with a fresh HPKE key
 * pair, signed and checked as a receiver will check it.
 *
 * The new private key is kept in the returned state, keyed by the
 * proposal's reference, because a commit that applies the Update
 * encrypts this member's path secret to the new key. Processing that
 * commit installs the key into the private path; any other commit, or a
 * commit of this member's own (RFC 9420 12.2 forbids a committer to
 * include its own Update), drops it and lists it in `consumed`.
 */
export async function createUpdateProposal (
    state:ClientState,
    publicMessage:boolean,
    cs:CiphersuiteImpl,
    options:CreateUpdateProposalOptions = {},
):Promise<{
    newState:ClientState
    message:MLSMessage
    consumed:Uint8Array[]
}> {
    checkCanSendHandshakeMessages(state)

    const leafIndex = state.privatePath.leafIndex
    const node = state.ratchetTree[leafToNodeIndex(toLeafIndex(leafIndex))]
    if (node?.nodeType !== 'leaf') {
        throw new InternalError('Own leaf is not in the ratchet tree')
    }

    const patch = options.leafNodePatch === undefined ?
        {} :
        await resolveLeafNodePatch(options.leafNodePatch, cs)

    const { publicKey, privateKey } = await cs.hpke.generateKeyPair()
    const leafNode = await signLeafNodeUpdate(
        {
            leafNodeSource: 'update',
            hpkePublicKey: await cs.hpke.exportPublicKey(publicKey),
            signaturePublicKey:
                patch.signature?.publicKey ?? node.leaf.signaturePublicKey,
            credential: patch.credential ?? node.leaf.credential,
            capabilities: patch.capabilities ?? node.leaf.capabilities,
            extensions: patch.extensions ?? node.leaf.extensions,
            info: {
                leafNodeSource: 'update',
                groupId: state.groupContext.groupId,
                leafIndex,
            },
        },
        patch.signature?.signKey ?? state.signaturePrivateKey,
        cs.signature,
    )

    const sent = await sendProposal(
        state,
        publicMessage,
        { proposalType: 'update', update: { leafNode } },
        cs,
        options.authenticatedData,
    )

    const newState:ClientState = {
        ...sent.newState,
        pendingUpdateKeys: addPendingUpdateKey(
            sent.ref,
            state.pendingUpdateKeys,
            {
                hpkePrivateKey: await cs.hpke.exportPrivateKey(privateKey),
                ...(patch.signature === undefined ?
                    {} :
                    { signaturePrivateKey: patch.signature.signKey }),
            },
        ),
    }

    return {
        newState,
        message: sent.message,
        consumed: consumedSecrets(state, newState),
    }
}

async function sendProposal (
    state:ClientState,
    publicMessage:boolean,
    proposal:Proposal,
    cs:CiphersuiteImpl,
    authenticatedData:Uint8Array = new Uint8Array(),
):Promise<{ newState:ClientState; message:MLSMessage; ref:Uint8Array }> {
    checkCanSendHandshakeMessages(state)

    throwIfDefined(checkPendingCapacity(
        state.unappliedProposals,
        state.clientConfig.maxPendingProposals,
    ))

    // the same checks a receiver applies, so this client never stores (or
    // sends) a proposal every peer would refuse
    throwIfDefined(
        await validateProposalOnReceipt(
            state,
            proposal,
            state.privatePath.leafIndex,
            true,
            cs,
        ),
    )

    if (publicMessage) {
        const result = await protectProposalPublic(
            state.signaturePrivateKey,
            state.keySchedule.membershipKey,
            state.groupContext,
            authenticatedData,
            proposal,
            state.privatePath.leafIndex,
            cs,
        )
        const ref = await makeProposalRef(
            {
                content: result.publicMessage.content,
                auth: result.publicMessage.auth,
                wireformat: 'mls_public_message',
            },
            cs.hash,
        )
        const newState = {
            ...state,
            unappliedProposals: addUnappliedProposal(
                ref,
                state.unappliedProposals,
                proposal,
                state.privatePath.leafIndex,
                'member',
            ),
        }
        return {
            newState,
            message: { wireformat: 'mls_public_message', version: 'mls10', publicMessage: result.publicMessage },
            ref,
        }
    } else {
        const result = await protectProposal(
            state.signaturePrivateKey,
            state.keySchedule.senderDataSecret,
            proposal,
            authenticatedData,
            state.groupContext,
            state.secretTree,
            state.privatePath.leafIndex,
            state.clientConfig.paddingConfig,
            cs,
        )

        const newState = {
            ...state,
            secretTree: result.newSecretTree,
            unappliedProposals: addUnappliedProposal(
                result.proposalRef,
                state.unappliedProposals,
                proposal,
                state.privatePath.leafIndex,
                'member',
            ),
        }

        return {
            newState,
            message: { wireformat: 'mls_private_message', version: 'mls10', privateMessage: result.privateMessage },
            ref: result.proposalRef,
        }
    }
}

export async function createApplicationMessage (
    state:ClientState,
    message:Uint8Array,
    cs:CiphersuiteImpl,
    authenticatedData:Uint8Array = new Uint8Array(),
):Promise<{
    newState:ClientState
    privateMessage:PrivateMessage
    consumed:Uint8Array[]
}> {
    checkCanSendApplicationMessages(state)

    const result = await protectApplicationData(
        state.signaturePrivateKey,
        state.keySchedule.senderDataSecret,
        message,
        authenticatedData,
        state.groupContext,
        state.secretTree,
        state.privatePath.leafIndex,
        state.clientConfig.paddingConfig,
        cs,
    )

    const newState = { ...state, secretTree: result.newSecretTree }

    return {
        newState,
        privateMessage: result.privateMessage,
        consumed: consumedSecrets(state, newState),
    }
}

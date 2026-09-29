import type { ClientState } from './client-state.js'
import {
    checkCanSendApplicationMessages,
    checkCanSendHandshakeMessages,
    throwIfDefined,
    validateProposalOnReceipt
} from './client-state.js'
import { makeProposalRef } from './authenticated-content.js'
import type { CiphersuiteImpl } from './crypto/ciphersuite.js'
import type { MLSMessage } from './message.js'
import type { PrivateMessage } from './private-message.js'
import { protectProposal, protectApplicationData } from './message-protection.js'
import { protectProposalPublic } from './message-protection-public.js'
import type { Proposal } from './proposal.js'
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
):Promise<{ newState:ClientState; message:MLSMessage }> {
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
        }
    }
}

export async function createApplicationMessage (
    state:ClientState,
    message:Uint8Array,
    cs:CiphersuiteImpl,
    authenticatedData:Uint8Array = new Uint8Array(),
):Promise<{ newState:ClientState; privateMessage:PrivateMessage }> {
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

    return { newState: { ...state, secretTree: result.newSecretTree }, privateMessage: result.privateMessage }
}

import type { Proposal } from './proposal.js'
import type { SenderTypeName } from './sender.js'
import { ValidationError } from './mls-error.js'
import { base64ToBytes, bytesToBase64 } from './util/byte-array.js'

export interface ProposalWithSender {
    proposal:Proposal
    senderLeafIndex:number | undefined
    senderType:SenderTypeName
}

/**
 * Pending proposals keyed by the base64 of their reference. Read it only
 * through `findUnappliedProposal`, an own-property lookup, so a reference
 * that spells an `Object.prototype` member (`toString` is valid base64)
 * is an ordinary unknown reference.
 */
export type UnappliedProposals = Record<string, ProposalWithSender>

export function emptyUnappliedProposals ():UnappliedProposals {
    return {}
}

export function findUnappliedProposal (
    ref:Uint8Array,
    proposals:UnappliedProposals,
):ProposalWithSender | undefined {
    const r = bytesToBase64(ref)
    return Object.hasOwn(proposals, r) ? proposals[r] : undefined
}

export function addUnappliedProposal (
    ref:Uint8Array,
    proposals:UnappliedProposals,
    proposal:Proposal,
    senderLeafIndex:number | undefined,
    senderType:SenderTypeName,
):UnappliedProposals {
    return {
        ...proposals,
        [bytesToBase64(ref)]: { proposal, senderLeafIndex, senderType },
    }
}

export interface PendingProposal extends ProposalWithSender {
    ref:Uint8Array
}

/**
 * The proposals this state holds but has not yet committed, each with the
 * reference a commit (or `discardPendingProposal`) names it by.
 */
export function listPendingProposals (
    state:{ unappliedProposals:UnappliedProposals },
):PendingProposal[] {
    return Object.entries(state.unappliedProposals).map(([r, p]) => ({
        ...p,
        ref: base64ToBytes(r),
    }))
}

/**
 * A new state without the pending proposal named by `ref`. The input is
 * left untouched; an unknown reference returns an equal state.
 */
export function discardPendingProposal<
    S extends { unappliedProposals:UnappliedProposals }
> (state:S, ref:Uint8Array):S {
    const r = bytesToBase64(ref)
    if (!Object.hasOwn(state.unappliedProposals, r)) return state
    const { [r]: _dropped, ...rest } = state.unappliedProposals
    return { ...state, unappliedProposals: rest }
}

/**
 * Refuses a new proposal once `max` are pending. Nothing already pending
 * is evicted, so a flood cannot push out an honest proposal. A `max` of 0
 * or less accepts none.
 */
export function checkPendingCapacity (
    proposals:UnappliedProposals,
    max:number,
):ValidationError | undefined {
    if (max <= 0) {
        return new ValidationError('pending proposals are disabled')
    }
    if (Object.keys(proposals).length >= max) {
        return new ValidationError('too many pending proposals')
    }
    return undefined
}

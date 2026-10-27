import type { SenderTypeName } from './sender.js'
import type { ProposalWithSender } from './unapplied-proposals.js'

export type IncomingMessageAction = 'accept' | 'reject'

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

/**
 * What the incoming-message callback is shown. A commit carries its
 * `committer`, so an application can refuse a commit by policy before
 * it is accepted; a member committer's credential is the leaf at
 * `leafIndex` in the receiver's current ratchet tree.
 */
export type IncomingMessage =
    | {
        kind:'commit'
        proposals:ProposalWithSender[]
        committer:AuthenticatedSender
    }
    | { kind:'proposal'; proposal:ProposalWithSender }

export type IncomingMessageCallback = (
    incoming:IncomingMessage,
) => IncomingMessageAction

export const acceptAll:IncomingMessageCallback = () => 'accept'

/**
 * The callback used when none is passed. A `new_member_proposal` is
 * authenticated only by its own KeyPackage signature, so anyone who
 * knows the group id and epoch can send one. Accepting it by default
 * would let the next routine commit add an outsider. Everything else
 * is accepted.
 */
export const defaultIncomingMessageCallback:IncomingMessageCallback = (
    incoming,
) => {
    if (
        incoming.kind === 'proposal' &&
        incoming.proposal.senderType === 'new_member_proposal'
    ) return 'reject'
    return 'accept'
}

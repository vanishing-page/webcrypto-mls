import type { ProposalWithSender } from './unapplied-proposals.js'

export type IncomingMessageAction = 'accept' | 'reject'

export type IncomingMessageCallback = (
    incoming:{ kind:'commit'; proposals:ProposalWithSender[] } | { kind:'proposal'; proposal:ProposalWithSender },
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

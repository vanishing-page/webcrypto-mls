import {
    isClientMessage,
    MAX_WIRE_MESSAGE_LENGTH,
    type ClientMessage,
    type ErrorReason,
    type LogEntry
} from '../protocol.js'

/**
 * Whether the room took a commit this client sent. Pure -- no DOM, no
 * WebSocket, no signals -- in the same family as `delivery-cursor.ts`
 * and `entry-queue.ts`, so the matching rule is a Node test.
 *
 * `send` returning true means only that the socket was open. The room
 * can still refuse the write (the `mls` interval, a full log), and a
 * creator that took "the frame left" for "the room accepted it" sends
 * a Welcome for a commit the log does not hold and moves to an epoch
 * nobody else can reach. So a commit is pending until the room answers
 * it one way or the other.
 */

/** A commit sent and not yet answered. */
export interface PendingCommit {
    payload:string
    ref:string
}

/**
 * `closed`, `lost` and `no-room` are not `error` reasons. `closed`: the
 * socket was not open, so the frame never left and there is nothing to
 * wait for. `lost`: the socket dropped before the room answered, and
 * the replay after reconnect ended without the commit in it, so the
 * room never logged it. `no-room`: the room is gone, so nothing it was
 * sent will ever be logged.
 */
export type CommitOutcome =
    | { status:'accepted' }
    | { status:'refused', reason:ErrorReason|'closed'|'lost'|'no-room' }

/**
 * What the connection hands over: the two room messages that can answer
 * a commit, and the two moments that let a dropped socket be settled. A
 * replayed entry is wrapped in the same `entry` shape, so a live echo
 * and a replayed one are judged by one rule.
 *
 * `reconnected` is a new socket opening after a drop; `replay-end` is a
 * `log` page with `more` false. `no-room` carries no `ref`, and needs
 * none: the room answers it to any write once it has expired, so it
 * refuses whatever is pending.
 */
export type CommitSignal =
    | { type:'entry', entry:LogEntry }
    | { type:'error', reason:ErrorReason, ref?:string }
    | { type:'no-room' }
    | { type:'reconnected' }
    | { type:'replay-end' }

/**
 * Accepted is the room's echo of this client's own entry: the sender is
 * this client and the payload is the pending one -- the same rule
 * `apply-entry.ts` uses to credit a chat message to its sender. The
 * room stores a payload verbatim and two commits never share one, so
 * the bytes identify the write.
 *
 * Refused is an `error` carrying the pending commit's `ref`. An error
 * with no `ref`, or another one, is about a different write.
 *
 * Anything else settles nothing, and is null.
 */
export function outcomeOf (
    pending:PendingCommit,
    self:string|null,
    signal:CommitSignal
):CommitOutcome|null {
    if (signal.type === 'reconnected' || signal.type === 'replay-end') {
        return null
    }

    if (signal.type === 'no-room') {
        return { status: 'refused', reason: 'no-room' }
    }

    if (signal.type === 'entry') {
        if (self === null) return null
        if (signal.entry.sender !== self) return null
        if (signal.entry.payload !== pending.payload) return null
        return { status: 'accepted' }
    }

    if (signal.ref === undefined || signal.ref !== pending.ref) return null
    return { status: 'refused', reason: signal.reason }
}

export interface PendingCommitsDeps {
    /** What this client calls itself on the wire, or null. */
    identity ():string|null

    /** Returns false when the socket is not open. */
    send (msg:ClientMessage):boolean
}

export interface PendingCommits {
    /**
     * Send a commit and resolve once the room has answered it. Never
     * rejects for a refusal -- that is an outcome, not an error. Throws
     * if a commit is already pending: only the creator commits, and its
     * commits are serialized by the approvals chain and the group lock,
     * so a second one here is a bug in the caller.
     */
    submit (payload:string):Promise<CommitOutcome>

    /**
     * Every entry and every `error` the room sends, each reconnect, and
     * the last page of each replay.
     */
    observe (signal:CommitSignal):void

    /**
     * True while a commit sent on a socket that has since dropped is
     * waiting for the replay to say whether the room logged it.
     */
    awaitsReplay ():boolean
}

export function createPendingCommits (
    { identity, send }:PendingCommitsDeps
):PendingCommits {
    let pending:(PendingCommit & {
        settle (outcome:CommitOutcome):void
    })|null = null

    // Set when the socket the pending commit went out on is replaced.
    // Only then is the end of a replay an answer: a paged replay that was
    // already running on the live socket when the commit went out was
    // answered before the write, and ends without it.
    let interrupted = false

    // Distinct per submission, so a refusal that arrives late for one
    // write can never settle the next.
    let count = 0

    return {
        submit (payload:string):Promise<CommitOutcome> {
            if (pending) {
                return Promise.reject(
                    new Error('a commit is already waiting for the room')
                )
            }

            const ref = `commit-${++count}`
            const msg:ClientMessage = {
                type: 'mls',
                kind: 'commit',
                payload,
                ref
            }

            // A frame the room cannot parse, or one that parses and
            // fails `isClientMessage`, is answered with a bare
            // `bad-message`: the room has no `ref` to echo, so the answer
            // could never be matched to this commit and it would wait
            // for ever. The room's own rule is applied here instead.
            if (
                !isClientMessage(msg) ||
                JSON.stringify(msg).length > MAX_WIRE_MESSAGE_LENGTH
            ) {
                return Promise.resolve({
                    status: 'refused',
                    reason: 'bad-message'
                })
            }

            interrupted = false

            // Registered before the frame goes out, so an answer that
            // arrives in the same turn as the send still has something
            // to settle.
            const outcome = new Promise<CommitOutcome>(resolve => {
                pending = { payload, ref, settle: resolve }
            })

            if (!send(msg)) {
                pending = null
                return Promise.resolve({ status: 'refused', reason: 'closed' })
            }

            return outcome
        },

        observe (signal:CommitSignal):void {
            if (!pending) return

            // A drop leaves the commit pending: the room may or may not
            // have logged it, and only a replay from the new socket can
            // say which. An echo in that replay settles it through
            // `outcomeOf` like a live one.
            if (signal.type === 'reconnected') {
                interrupted = true
                return
            }

            // The last page of a replay from the new socket, and no echo
            // on it or any page before: the room never logged it.
            const lost:CommitOutcome|null = interrupted ?
                { status: 'refused', reason: 'lost' } :
                null

            const outcome = signal.type === 'replay-end' ?
                lost :
                outcomeOf(pending, identity(), signal)
            if (!outcome) return

            const { settle } = pending
            pending = null
            interrupted = false
            settle(outcome)
        },

        awaitsReplay ():boolean {
            return pending !== null && interrupted
        }
    }
}

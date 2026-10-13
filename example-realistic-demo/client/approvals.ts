import { batch } from '@preact/signals'
import type { ClientState } from '../../src/index.js'
import type { ClientMessage, PendingRequest } from '../protocol.js'
import type { RealisticState } from './state.js'
import type { GroupLock } from './group-lock.js'
import type { CommitOutcome } from './pending-commit.js'
import { MLS_WRITE_INTERVAL_MS } from '../room-logic.js'
import {
    commitAdd,
    commitRemove,
    decodeKeyPackageB64,
    keyPackageBelongsTo
} from './mls-actions.js'
import {
    leafIndexOf,
    membersFromTree,
    nameFromCredential,
    type Member
} from './membership.js'

/**
 * Letting someone in, and putting someone out. Kept out of the page and
 * out of the view because the ordering rule below is the whole of
 * realistic-demo.AC4.1, and a rule that can only be checked in a browser
 * is a rule nothing checks.
 *
 * Both actions live here rather than in two modules because they share
 * the one thing that makes either correct: a single chain. An Add and a
 * Remove committed from the same group state are both at the same epoch,
 * and everyone else applies the first and rejects the second -- so they
 * have to queue behind each other, not merely behind their own kind.
 */
export interface ApprovalDeps {
    state:RealisticState

    /**
     * Shared with `chat.ts` and `apply-entry.ts`. The chain below orders
     * an Add against a Remove; only the lock orders either of them
     * against a message being sent or an entry being applied, and losing
     * a commit that has already been broadcast is the worst of the three
     * outcomes. See `group-lock.ts`.
     */
    lock:GroupLock

    /**
     * Returns false when the socket is not open. The caller of this
     * module never sees that -- an approval that could not be sent is
     * reported through `state.status` and changes no group state.
     */
    send (msg:ClientMessage):boolean

    /**
     * Send a commit and resolve once the room has answered it --
     * `submit` from `pending-commit.ts`. The frame leaving the socket is
     * not the room taking it: an `mls` write can be refused (the
     * interval, a full log), and nothing that follows a commit may go
     * out, or be adopted locally, until the room has said yes.
     */
    submitCommit (payload:string):Promise<CommitOutcome>

    /**
     * Let `ms` pass before a rate-limited commit is tried again.
     * Defaults to a timer; a test passes its own clock.
     */
    wait? (ms:number):Promise<void>
}

/**
 * How many times one commit is sent before a `rate-limited` refusal is
 * reported rather than retried. The interval is per socket and only
 * this page writes on it, so one retry clears it unless a chat message
 * was sent in between; a few more cover that without waiting for ever.
 */
export const MAX_COMMIT_ATTEMPTS = 4

export interface Approvals {
    /** Never rejects: a failure is reported in the status line. */
    approve (request:PendingRequest):Promise<void>
    deny (identity:string):void

    /**
     * Remove a member the page is showing. Never rejects, for the same
     * reason `approve` does not.
     */
    remove (member:Member):Promise<void>

    /** Every pending list the room sends, in full. */
    onPending (requests:PendingRequest[]):Promise<void>
}

/**
 * Both halves of a request, checked together: it decodes, and it
 * decodes into a key package the identity that asked actually owns. See
 * `keyPackageBelongsTo` for what committing an incoherent one does.
 */
function requestIsCoherent (request:PendingRequest):boolean {
    const keyPackage = decodeKeyPackageB64(request.keyPackage)
    if (!keyPackage) return false
    return keyPackageBelongsTo(keyPackage, request.identity)
}

function timer (ms:number):Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, ms) })
}

export function createApprovals (
    { state, lock, send, submitCommit, wait = timer }:ApprovalDeps
):Approvals {
    // The promise the last caller was handed, so a repeat click gets
    // something to await rather than nothing. Ordering is the lock's --
    // two Adds committed from the same group state are both at the same
    // epoch, everyone else applies the first and rejects the second, and
    // the second joiner is welcomed into a group nobody is in, so a
    // pending list of two pre-approved requests has to be walked rather
    // than fanned out.
    let last:Promise<void> = Promise.resolve()

    // What stops a re-broadcast pending list from committing a second
    // Add for a key package already in the tree. Cleared when the
    // approval settles either way, so one that failed can be retried.
    const inFlight = new Set<string>()

    // An Add the room accepted whose Welcome did not get out. The joiner's
    // leaf is in the tree, so the next approve of that identity reads as
    // already admitted and commits nothing -- this is what it sends
    // instead. It has to go out before any later commit: the room stamps
    // a Welcome's cursor at the log's end when it arrives, so a Welcome
    // sent after another commit tells its joiner to skip one it needs.
    // Only this module commits, so at most one is ever held.
    let unsentWelcome:{ identity:string, payload:string }|null = null

    /**
     * The Welcome, then the approval, short-circuited. Whatever did not
     * get out is held for the next attempt.
     */
    function sendWelcome (identity:string, payload:string):boolean {
        const delivered =
            send({ type: 'welcome', to: identity, payload }) &&
            send({ type: 'approve', identity })

        unsentWelcome = delivered ? null : { identity, payload }
        return delivered
    }

    /** Send a held Welcome, unless it is for `except`. */
    function flushUnsentWelcome (except:string):void {
        if (!unsentWelcome || unsentWelcome.identity === except) return
        const { identity, payload } = unsentWelcome
        if (!sendWelcome(identity, payload)) {
            throw new Error('the connection dropped before that was sent')
        }
    }

    /**
     * Commit and wait for the room to take it. `build` makes the commit
     * from a group state -- an Add or a Remove. Resolves with what it
     * built only once its own echo has come back; anything else throws,
     * having sent nothing but the commit and changed no group state.
     *
     * `rate-limited` is temporary -- the room refuses an `mls` write
     * inside `MLS_WRITE_INTERVAL_MS` of the socket's last one, which a
     * walked pending list hits by design -- so it is retried after the
     * interval, a bounded number of times. The room never logged the
     * refused write, so the same commit is sent again unless the group
     * it was built from has moved on. `log-full` and `log-too-large` are
     * permanent for this room and are reported at once.
     *
     * A socket that drops after the commit leaves it waiting here until
     * the replay on the next socket settles it: accepted if the replay
     * echoes it, `lost` if the replay ends without it. A lost commit is
     * reported like a refusal and not resent.
     */
    async function commitAndConfirm<T extends { commit:string }> (
        group:ClientState,
        build:(from:ClientState) => Promise<T>
    ):Promise<T> {
        let from = group
        let built = await build(from)

        for (let attempt = 1; ; attempt++) {
            const outcome = await submitCommit(built.commit)
            if (outcome.status === 'accepted') return built

            if (outcome.reason === 'closed') {
                throw new Error('the connection dropped before that was sent')
            }

            if (
                outcome.reason !== 'rate-limited' ||
                attempt >= MAX_COMMIT_ATTEMPTS
            ) {
                throw new Error(
                    `the room refused that commit (${outcome.reason})`
                )
            }

            await wait(MLS_WRITE_INTERVAL_MS)

            const current = state.group.value
            if (!current) throw new Error('there is no group any more')
            if (current !== from) {
                from = current
                built = await build(from)
            }
        }
    }

    async function commit (request:PendingRequest):Promise<void> {
        const group = state.group.value
        const cs = state.ciphersuite.value

        if (!group || !cs) {
            throw new Error('there is no group to add anyone to')
        }

        flushUnsentWelcome(request.identity)

        // Somebody already in the tree is not added again. This is not a
        // defensive flourish: a joiner whose socket dropped before its
        // Welcome arrived still has no group, so its next `hello`
        // re-publishes the request, and the room -- which admitted that
        // identity already -- calls the second ask `pre-approved`. The
        // library refuses an Add for a leaf that is already there, so
        // committing anyway left the creator with a permanent row and a
        // ValidationError on screen, retried on every re-broadcast.
        //
        // The `approve` still goes out, alone. It carries no new
        // decision -- the ledger already says admitted -- but it is what
        // deletes the pending row, and a request that is answered has to
        // stop being asked.
        const already = membersFromTree(group.ratchetTree)
            .find(member => member.identity === request.identity)

        // Unless its Welcome never went out: an accepted Add whose
        // Welcome the socket dropped leaves exactly this tree, and the
        // `approve` alone would admit somebody who cannot get in.
        if (already && unsentWelcome?.identity === request.identity) {
            if (!sendWelcome(request.identity, unsentWelcome.payload)) {
                throw new Error(
                    'the connection dropped before that was sent'
                )
            }

            state.status.value = `Let ${already.name} in.`
            return
        }

        if (already) {
            if (!send({ type: 'approve', identity: request.identity })) {
                throw new Error(
                    'the connection dropped before that was sent'
                )
            }

            state.status.value = `${already.name} is already in the group.`
            return
        }

        // The one place a name is learned about someone not yet in the
        // group. Null rather than a throw is deliberate in
        // `decodeKeyPackageB64` -- a request arrives off a socket, so it
        // is untrusted -- and this is where that null stops being
        // renderable and starts being a refusal.
        const keyPackage = decodeKeyPackageB64(request.keyPackage)

        if (!keyPackage) {
            throw new Error('that request carries no readable key package')
        }

        // Checked here as well as in `onPending` and in the view,
        // because this is the only path that commits, and a rule
        // enforced only where the call happens to come from is not a
        // rule.
        if (!keyPackageBelongsTo(keyPackage, request.identity)) {
            throw new Error(
                'that key package belongs to somebody else'
            )
        }

        const added = await commitAndConfirm(
            group,
            from => commitAdd(from, keyPackage, cs)
        )

        // The order is not incidental and must not be rearranged.
        //
        // The commit went first, and the room has accepted it, so it is
        // in the log before the room stamps the Welcome's cursor -- the
        // room sets that cursor to the current high-water seq. The
        // approval goes last, so the ledger only ever records an
        // admission that actually happened.
        //
        // The short-circuit matters as much as the order: a Welcome for
        // a commit that never reached the log strands the joiner at an
        // epoch nobody else is at.
        if (!sendWelcome(request.identity, added.welcome)) {
            // The commit is in the log, so everyone else will reach its
            // epoch, and so must the creator; the request stays pending
            // in the room, because `approve` never went out, and the
            // Welcome is held for the next approve of it.
            batch(() => {
                state.group.value = added.newState
            })
            throw new Error('the connection dropped before that was sent')
        }

        batch(() => {
            state.group.value = added.newState
            state.status.value =
                `Let ${nameFromCredential(keyPackage.leafNode.credential)} in.`
        })
    }

    /**
     * Removing is the mirror of `commit` above, and its two frames go
     * out in the same shape of order: the room has echoed the commit
     * before it is told to write the ledger, so the ledger only ever
     * records a removal that actually happened, and a refused commit
     * sends nothing after it and leaves the creator where it was.
     *
     * The creator check here is the second of two, and neither is
     * cryptographic. The room refuses a `removed` from a socket without
     * the creator token, and the page does not offer the control -- but
     * any member could commit a Remove, and this demo says so on the
     * page rather than pretending otherwise.
     */
    async function removeMember (member:Member):Promise<void> {
        const group = state.group.value
        const cs = state.ciphersuite.value

        if (!group || !cs) {
            throw new Error('there is no group to remove anyone from')
        }

        if (!state.isCreator.value) {
            throw new Error('only the room creator can remove somebody')
        }

        // Resolved against the tree being committed from, never from the
        // leaf index the view was rendered with. A commit that landed in
        // between would have moved it, and a stale index removes the
        // wrong person.
        const leafIndex = leafIndexOf(group.ratchetTree, member.identity)

        if (leafIndex === null) {
            throw new Error('that person is not in the group')
        }

        // A held Welcome for the member being removed is not sent: they
        // are on their way out, and it would let them in for one epoch.
        if (unsentWelcome?.identity === member.identity) unsentWelcome = null
        flushUnsentWelcome(member.identity)

        // A rebuilt commit resolves the leaf again, for the same reason
        // as above. One that cannot is a removal somebody else already
        // made.
        const removed = await commitAndConfirm(group, from => {
            const leaf = from === group ?
                leafIndex :
                leafIndexOf(from.ratchetTree, member.identity)
            if (leaf === null) {
                throw new Error('that person is not in the group')
            }
            return commitRemove(from, leaf, cs)
        })

        // The room has the commit, so the creator moves to its epoch
        // whether or not the ledger frame gets out -- `apply-entry`
        // skips its own commits, so it could never catch up otherwise.
        if (!send({ type: 'removed', identity: member.identity })) {
            batch(() => {
                state.group.value = removed.newState
            })
            throw new Error('the connection dropped before that was sent')
        }

        batch(() => {
            state.group.value = removed.newState
            state.status.value = `Removed ${member.name}.`
        })
    }

    function approve (request:PendingRequest):Promise<void> {
        if (inFlight.has(request.identity)) return last

        inFlight.add(request.identity)

        last = lock.run(() => commit(request))
            .catch(err => {
                state.status.value = `Could not approve that: ${err}`
            })
            .then(() => { inFlight.delete(request.identity) })

        return last
    }

    return {
        approve,

        remove (member:Member):Promise<void> {
            // The same guard as `approve`, and the same set: an
            // identity being let in and the same identity being put out
            // must not both be in flight.
            if (inFlight.has(member.identity)) return last

            inFlight.add(member.identity)

            last = lock.run(() => removeMember(member))
                .catch(err => {
                    state.status.value = `Could not remove that: ${err}`
                })
                .then(() => { inFlight.delete(member.identity) })

            return last
        },

        deny (identity:string):void {
            // Nothing is committed and no group state moves: a denial
            // is a row the room deletes and a ledger it does not write.
            if (!send({ type: 'deny', identity })) {
                state.status.value =
                    'The connection dropped; nothing was denied.'
            }
        },

        /**
         * A `pre-approved` request comes from an identity the creator
         * already admitted once, so it is committed with no prompt.
         * `stranger` and `previously-removed` always wait for a decision
         * -- letting someone back in after removing them is exactly the
         * choice that should not be made automatically.
         */
        async onPending (requests:PendingRequest[]):Promise<void> {
            // The room only sends this list to a socket holding the
            // creator token, so this is the second of two gates rather
            // than the only one.
            if (!state.isCreator.value || !state.group.value) return

            for (const request of requests) {
                if (request.standing !== 'pre-approved') continue

                // Refused rather than committed -- and refused
                // silently, without going near `approve`. This list is
                // re-broadcast, so a request that fails here would
                // write its failure to the status line again on every
                // broadcast, for ever. It stays in the pending list
                // with its Approve control disabled, which is where a
                // request nobody can act on belongs; the creator can
                // still deny it.
                if (!requestIsCoherent(request)) continue

                await approve(request)
            }
        }
    }
}

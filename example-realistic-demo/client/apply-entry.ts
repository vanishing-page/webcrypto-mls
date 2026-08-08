import { batch } from '@preact/signals'
import type { LogEntry } from '../protocol.js'
import type { RealisticState } from './state.js'
import type { GroupLock } from './group-lock.js'
import { processEntry } from './mls-actions.js'

/**
 * One entry from the log, applied to the group. Kept out of the page for
 * the same reason `approvals.ts` is: two of the three rules here are
 * only observable in a browser otherwise -- that a client never
 * processes its own entry, and that being removed is a normal outcome
 * rather than a failed commit.
 */
export interface ApplyEntryDeps {
    state:RealisticState

    /**
     * Shared with `chat.ts` and `approvals.ts`. The entry queue's drain
     * already orders entries against each other; the lock is what orders
     * them against a message being sent or a commit being made from this
     * page. See `group-lock.ts`.
     */
    lock:GroupLock

    /** What this client calls itself on the wire, or null. */
    identity ():string|null

    /** Close the socket for good. Called when this client is removed. */
    close ():void
}

export function createApplyEntry (
    { state, lock, identity, close }:ApplyEntryDeps
):(entry:LogEntry) => Promise<void> {
    /**
     * One application entry, recorded whether or not it can be read.
     * Recording comes first and unconditionally, because an entry this
     * client cannot decrypt is exactly the entry `buildTimeline` turns
     * into a placeholder -- one left out of `state.entries` would be
     * counted by nobody and silently vanish from the history instead.
     */
    function record (entry:LogEntry, text:string|null):void {
        batch(() => {
            state.entries.value = [...state.entries.value, entry]
            if (text === null) return
            state.decrypted.value = {
                ...state.decrypted.value,
                [entry.seq]: text
            }
        })
    }

    /**
     * This client's own message, echoed straight back by the room and
     * again on every replay. MLS cannot decrypt a message it produced,
     * so the plaintext comes from what `chat.ts` recorded at send time,
     * matched on the ciphertext itself: the room stores a payload
     * verbatim and hands back the same bytes, so the echo carries the
     * one field that identifies which send it answers.
     *
     * Matching on order instead would be wrong, not merely fragile. A
     * frame handed to an open socket that dies before it flushes is
     * discarded and nothing tells the page, so the list can hold a send
     * the room never logged -- and a positional match would then file
     * that message's text against the next echo's seq, showing the wrong
     * words under a real message for the rest of the session.
     *
     * No match is the ordinary case after a reload: nothing persists the
     * plaintexts, so the message becomes a placeholder rather than a
     * decrypt failure.
     */
    function recordOwn (entry:LogEntry):void {
        const pending = state.outbound.value
        const index = pending.findIndex(sent => {
            return sent.payload === entry.payload
        })

        batch(() => {
            record(entry, index === -1 ? null : pending[index].text)
            if (index === -1) return
            state.outbound.value = [
                ...pending.slice(0, index),
                ...pending.slice(index + 1)
            ]
        })
    }

    /**
     * The body, which runs inside the lock. Every line from the read of
     * `state.group` below to the write back at the end is in here: a read
     * taken outside would see the state as it was before whatever the
     * lock is holding writes to it, which is the whole of what the lock
     * prevents.
     */
    async function apply (entry:LogEntry):Promise<void> {
        const group = state.group.value
        const cs = state.ciphersuite.value

        // Out already. A removal does not empty the queue that carried
        // it -- the creator can commit again straight afterwards, and
        // those entries are pushed before the socket closes -- and this
        // client holds no key for anything past its own removal. Handing
        // one to `processEntry` throws, and a throw here is a failed
        // commit: the queue stops and tells the person to reload and
        // resynchronise, over a removal that worked exactly as it
        // should. There is nothing left to catch up on.
        if (state.removed.value) return

        // Nothing to apply it to. A commit arriving before the Welcome
        // is re-delivered by the replay that follows it, so dropping it
        // here loses nothing; see `pushEntries` in connection.ts.
        if (!group || !cs) return

        // Chat, which is the one kind an entry from this client itself
        // still means something for -- so it is taken before the
        // own-sender check below rather than after it.
        if (entry.kind === 'application') {
            if (entry.sender === identity()) {
                recordOwn(entry)
                return
            }

            // Recorded before the decrypt is attempted. `processEntry`
            // throws on a message this client holds no key for, and the
            // queue reads that as "count it and carry on" -- but only if
            // the entry is already in the history to be counted.
            record(entry, null)

            const said = await processEntry(group, entry.payload, cs)

            // The only other kind `processMessage` returns here is a
            // proposal it staged, which no client in this demo sends.
            if (said.kind !== 'applicationMessage') return

            batch(() => {
                // The receiving ratchet moved when the message was
                // opened. Dropping `newState` would leave this client
                // deriving the same generation again for the next
                // message from the same sender.
                state.group.value = said.newState
                state.decrypted.value = {
                    ...state.decrypted.value,
                    [entry.seq]: new TextDecoder().decode(said.message)
                }
            })

            return
        }

        // Never this client's own entry. MLS cannot process a message it
        // produced -- the sender applied `newState` at the moment it
        // committed -- and the room echoes an entry to its sender as well
        // as to everybody else, so this arrives both live and on replay.
        // Returning here still advances the cursor, which is the point:
        // a cursor that skipped this client's own writes would read the
        // next entry from anybody else as a gap.
        if (entry.sender === identity()) return

        // A `proposal` is never sent by this client, and processing one
        // would only stage it.
        if (entry.kind !== 'commit') return

        const result = await processEntry(group, entry.payload, cs)

        // A commit always returns a new state. The other kind is an
        // application message, which this client did not ask for here.
        if (result.kind !== 'newState') return

        // Being removed is the normal outcome of a commit that processed
        // correctly, not a failure. It must not throw: the queue stops on
        // a failed commit and tells the person to reload, which is the
        // wrong thing to say about a removal that worked exactly as it
        // should.
        if (result.newState.groupActiveState.kind === 'removedFromGroup') {
            batch(() => {
                state.group.value = result.newState
                state.removed.value = true
                state.status.value = 'You were removed from this room.'
            })

            // There is nothing left to catch up on, and a socket that
            // kept saying `hello` would keep a removed client on the
            // roster as though it were still in the room.
            close()
            return
        }

        state.group.value = result.newState
    }

    // A rejection still reaches the queue, which is what reads a failed
    // commit as fatal and stops.
    return (entry:LogEntry) => lock.run(() => apply(entry))
}

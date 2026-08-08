import { batch } from '@preact/signals'
import type { ClientMessage } from '../protocol.js'
import type { RealisticState } from './state.js'
import type { GroupLock } from './group-lock.js'
import { encryptMessage } from './mls-actions.js'
import { EM_DASH } from '../../example-shared/constants.js'

/**
 * Saying something. Kept out of the page for the same reason
 * `approvals.ts` is: the two rules that make it correct are only
 * observable in a browser otherwise -- that two sends never encrypt from
 * the same group state, and that a message the socket refused is
 * reported rather than dropped.
 */
export interface ChatDeps {
    state:RealisticState

    /**
     * Shared with `approvals.ts` and `apply-entry.ts`. Not this module's
     * own: a chain here would order sends against each other and against
     * nothing else, and the write this module makes is the one whose loss
     * reuses a nonce. See `group-lock.ts`.
     */
    lock:GroupLock

    /**
     * Returns false when the socket is not open. The caller never sees
     * that: a message that could not be sent is reported through
     * `state.status`.
     */
    send (msg:ClientMessage):boolean
}

export interface Chat {
    /** Never rejects: a failure is reported in the status line. */
    say (text:string):Promise<void>
}

export function createChat ({ state, lock, send }:ChatDeps):Chat {
    /**
     * The whole of this runs inside the lock, including the read of
     * `state.group` on the way in. `createApplicationMessage` reads a
     * generation out of the sender's own secret tree and returns a state
     * holding the next one, so anything that reads the group before this
     * writes back is encrypting from a generation this message has
     * already spent -- two plaintexts under one key and nonce. That is
     * true of a second send and equally true of an entry being applied,
     * which is why the ordering is not this module's own.
     */
    async function encryptAndSend (text:string):Promise<void> {
        const trimmed = text.trim()
        if (!trimmed) return

        const group = state.group.value
        const cs = state.ciphersuite.value

        if (!group || !cs) {
            state.status.value = 'There is no group to send to yet.'
            return
        }

        const { newState, payload } = await encryptMessage(
            group,
            trimmed,
            cs
        )

        // Applied before the send is attempted, and applied even when
        // the send fails. The generation this message used is spent
        // either way, and going back to it would encrypt the next
        // message under the same key and nonce. A generation nobody ever
        // receives is a gap, which every member tolerates; a reused
        // nonce is not.
        state.group.value = newState

        if (!send({ type: 'mls', kind: 'application', payload })) {
            state.status.value =
                'Not connected, so that message was not sent. It is ' +
                `not queued ${EM_DASH} say it again once the connection ` +
                'is back.'
            return
        }

        batch(() => {
            // Recorded rather than read back out of the log. The room
            // does echo the entry, so the seq arrives, but the payload
            // that comes with it is one this client cannot open -- MLS
            // cannot decrypt a message it produced -- so this is the
            // only copy of the plaintext it will ever hold. The payload
            // is kept with it because that is what the echo is matched
            // on; see `recordOwn` in `apply-entry.ts`.
            state.outbound.value = [
                ...state.outbound.value,
                { payload, text: trimmed }
            ]
            state.draft.value = ''
            state.status.value = 'Sent.'
        })
    }

    return {
        say (text:string):Promise<void> {
            return lock.run(() => encryptAndSend(text)).catch(err => {
                state.status.value = `Could not send that: ${err}`
            })
        }
    }
}

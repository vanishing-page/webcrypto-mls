import { batch, effect } from '@preact/signals'
import {
    restoredSessionUser,
    type PersistedSession,
    type SessionInput,
    type SessionStore
} from '../../example-shared/persistence-storage.js'
import type { RealisticState } from './state.js'
import type { Route } from './routing.js'

/**
 * Persistence as a standing control. Kept out of the page because the
 * rule that makes it correct -- that turning it on writes whatever state
 * happens to exist right now, including none at all -- is a rule about
 * timing, and timing is what a browser-only check tends to get wrong.
 *
 * The record itself is `PersistedSession` in
 * `example-shared/persistence-storage.ts`; this module decides only when
 * one is written, and what is in it.
 */
export interface SessionDeps {
    state:RealisticState
    store:SessionStore
}

export interface Session {
    /** Turn persistence on or off. Never rejects. */
    setPersist (on:boolean):Promise<void>

    /** Write the current state, if persistence is on. Never rejects. */
    save ():Promise<void>

    /**
     * Delete this demo's database outright and forget the preference.
     * Says nothing to the server: the room keeps existing until it
     * expires, which is the whole point of the control.
     */
    reset ():Promise<void>

    /** The stored session, or null if there is none to restore. */
    load ():Promise<PersistedSession|null>

    /** Put a loaded record back into the signals. */
    restore (session:PersistedSession):void

    /**
     * Re-save on every change that matters. Returns the disposer, so a
     * caller that starts one can stop it.
     */
    watch ():() => void
}

/**
 * Everything worth writing, read off the signals in one pass. Null when
 * there is no user yet: a record with no key package restores into
 * nothing, and `isRestorableSession` would reject it anyway.
 *
 * Exported because the effect below depends on it reading *every* signal
 * a record is built from -- a field left out here is a change that
 * silently stops triggering a re-save.
 */
export function sessionInputFrom (
    state:RealisticState
):SessionInput|null {
    const user = state.user.value

    // Read before the guard below can return, so that a change to any of
    // them re-runs the effect that called this.
    const roomId = state.roomId.value
    const cursor = state.cursor.value
    const creatorToken = state.creatorToken.value
    const group = state.group.value

    if (!user?.keyPackage || !user.privateKeys) return null

    return {
        name: user.name,
        keyPackage: user.keyPackage,
        privateKeys: user.privateKeys,
        roomId,
        cursor,
        creatorToken,
        // A waiting joiner has no group at all, and that record is the
        // reason the session store exists beside the member store.
        state: group ?? undefined
    }
}

/**
 * Whether a stored record is the one this page should come back as.
 *
 * `asked` is what the URL asks for. The bare origin asks for no room in
 * particular, so the record wins. A link to a different room wins over
 * the record instead: the URL is the ask, and the record's group state
 * belongs to a room this person is not asking for -- restoring it would
 * put one room's group on a page addressed to another, and then say
 * `hello` to that room with a cursor counted in a different log.
 *
 * The whole route rather than a room id, because an id that cannot name
 * a room is an ask as well, and as a `string|null` it was
 * indistinguishable from the bare origin -- both arrive as null. A
 * mistyped invitation therefore drew the gone view and then had it
 * replaced, by this page, with whatever room the browser had a session
 * for, address bar included.
 *
 * A rule rather than a line in `index.ts` because the wiring cannot ask
 * it after `restore` has run: `restore` writes the stored room id over
 * whatever the URL put in `state.roomId`, so a check made afterwards
 * compares the stored id with itself and is true every time.
 */
export function storedRoomIsWanted (
    stored:PersistedSession,
    asked:Route
):boolean {
    if (asked.kind === 'setup') return true
    if (asked.kind === 'gone') return false
    return asked.roomId === stored.roomId
}

export function createSession ({ state, store }:SessionDeps):Session {
    /**
     * Write, without asking whether persistence is on. Every caller has
     * already read `state.persist` -- `watch` has to read it
     * synchronously to subscribe to it at all -- so re-reading it here
     * would be a second guard nothing could ever be observed to hit.
     */
    async function write (input:SessionInput):Promise<void> {
        try {
            await store.saveSession(input)
        } catch (err) {
            state.status.value = `Could not save the session: ${err}`
        }
    }

    async function save ():Promise<void> {
        if (!state.persist.value) return
        const input = sessionInputFrom(state)

        // No user yet. The preference is remembered and this becomes a
        // write the moment there is something to write, which is what
        // lets the control be offered before anybody exists.
        if (!input) return

        await write(input)
    }

    async function setPersist (on:boolean):Promise<void> {
        state.persist.value = on

        if (on) {
            await save()
            return
        }

        try {
            await store.clearSession()
        } catch (err) {
            state.status.value = `Could not clear the session: ${err}`
        }
    }

    async function reset ():Promise<void> {
        state.persist.value = false

        try {
            await store.deleteDatabase()
            state.status.value =
                'Deleted this demo\'s stored data. The room itself is ' +
                'untouched and still on the server.'
        } catch (err) {
            state.status.value = `Could not delete the database: ${err}`
        }
    }

    function restore (session:PersistedSession):void {
        const user = restoredSessionUser(session)

        batch(() => {
            state.persist.value = true
            state.user.value = user
            // A record with no `state` is a joiner still waiting on
            // approval, and a null group is what returns the page to the
            // waiting view rather than the name field.
            state.group.value = user.state ?? null
            // The group state carries the removal; the signal the page
            // reads does not, so it is derived here rather than stored.
            // Without this a removed client comes back as a member of a
            // group it is not in, and the first replayed entry past its
            // removal -- one it holds no key for -- throws in
            // `processEntry` and is read as a fatal commit.
            state.removed.value =
                user.state?.groupActiveState.kind === 'removedFromGroup'
            state.cursor.value = session.cursor
            state.creatorToken.value = session.creatorToken
            if (session.roomId) state.roomId.value = session.roomId
        })
    }

    return {
        setPersist,
        save,
        reset,
        load: () => store.loadSession(),
        restore,

        watch ():() => void {
            return effect(() => {
                const on = state.persist.value

                // Called for its reads as much as its result: every
                // signal a record is built from is subscribed to here,
                // so a new group state, an advanced cursor or a creator
                // token that just arrived each re-save on their own.
                const input = sessionInputFrom(state)

                // The one place this decision is made on this path. Both
                // reads above happen first, unconditionally, or the
                // effect would stop following whichever signal the guard
                // returned before reaching.
                if (!on || !input) return

                write(input).catch(err => {
                    state.status.value = `Could not save the session: ${err}`
                })
            })
        }
    }
}

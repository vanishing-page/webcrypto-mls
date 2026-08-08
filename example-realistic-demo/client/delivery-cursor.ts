import type { LogEntry } from '../protocol.js'

/**
 * The two rules the connection obeys, kept apart from the socket that
 * obeys them. Pure -- no DOM, no WebSocket, no signals -- so it can be
 * unit tested in node.
 */

/**
 * Where the cursor goes after applying an entry.
 *
 * A cursor is a promise that everything at or below it has been applied,
 * so it may only advance by exactly one. An entry that skips a seq means
 * something was lost in flight, and moving the cursor past the gap would
 * turn a recoverable gap into permanent silent data loss -- the missing
 * entry would never be replayed, because the next reconnect would ask
 * from beyond it.
 *
 * Returns the unchanged cursor for anything already applied, and for
 * anything that would leave a gap.
 */
export function advanceCursor (cursor:number, seq:number):number {
    if (seq !== cursor + 1) return cursor
    return seq
}

/**
 * Whether an entry is the next one expected. The caller uses this to
 * tell "already seen, skip it" from "gap, stop and resynchronise".
 */
export function entryPosition (
    cursor:number,
    entry:LogEntry
):'next'|'seen'|'gap' {
    if (entry.seq <= cursor) return 'seen'
    if (entry.seq === cursor + 1) return 'next'
    return 'gap'
}

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000

/**
 * How long to wait before reconnect attempt `attempt`, counting from 0.
 * Doubles each time and stops growing at the cap, so a room that is
 * genuinely gone is not hammered while a transient drop still recovers
 * quickly.
 */
export function reconnectDelay (attempt:number):number {
    const n = Math.max(0, Math.floor(attempt))
    const raw = RECONNECT_BASE_MS * Math.pow(2, n)
    return Math.min(raw, RECONNECT_MAX_MS)
}

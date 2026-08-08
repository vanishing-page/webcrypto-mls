import { signal, computed, type Signal } from '@preact/signals'
import type { ClientState, CiphersuiteImpl } from '../../src/index.js'
import type { LogEntry, PendingRequest } from '../protocol.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import type { StorageStatus } from
    '../../example-shared/storage-persistence.js'
import type { PersistRequest } from '../../example-shared/storage-panel.js'

export type View = 'setup'|'waiting'|'room'|'gone'

export type ConnectionStatus =
    | 'idle'
    | 'connecting'
    | 'open'
    | 'reconnecting'
    | 'closed'

/**
 * A message this client sent, held until the room hands its seq back.
 * The plaintext is kept beside the ciphertext rather than on its own,
 * because the ciphertext is the only thing the echo carries that says
 * which send it answers -- see `recordOwn` in `apply-entry.ts`.
 */
export interface SentMessage {
    /** The payload as sent. The room stores and echoes it verbatim. */
    payload:string

    /** What was typed, which is the only copy this page will hold. */
    text:string
}

/**
 * One client, not a map of them. A browser is one MLS client here, so
 * the departure from `createDemoState()` is deliberate.
 */
export interface RealisticState {
    ciphersuite:Signal<CiphersuiteImpl|null>
    user:Signal<DemoUser|null>
    group:Signal<ClientState|null>
    roomId:Signal<string|null>
    creatorToken:Signal<string|null>
    isCreator:Signal<boolean>
    expiresAt:Signal<number|null>
    cursor:Signal<number>

    /**
     * The cursor as it stood at the moment this client was let in, which
     * is a different number from `cursor` the instant anything is
     * applied. `buildTimeline` needs the join point specifically -- it
     * is what separates "before my time" from "I was here and could not
     * read it" -- so the two are held apart rather than one being
     * derived from the other.
     */
    joinCursor:Signal<number>
    priorCount:Signal<number>
    live:Signal<string[]>
    pending:Signal<PendingRequest[]>

    /** Application entries only, in seq order, as the room numbered them. */
    entries:Signal<LogEntry[]>

    /** seq -> plaintext, for the entries this client could read. */
    decrypted:Signal<Record<number, string>>

    /**
     * Messages this client sent that the room has not yet handed back
     * with a seq. The echo carries a payload this client cannot decrypt,
     * so the plaintext has to come from here: each one is matched to its
     * seq as the echo lands, on the ciphertext the room stores verbatim
     * and hands back unchanged. Until then it is shown from this list,
     * because the person who typed it should see it straight away rather
     * than after a round trip.
     */
    outbound:Signal<SentMessage[]>

    /** What is in the composer. Room takes no hooks; see the view. */
    draft:Signal<string>

    persist:Signal<boolean>
    storage:Signal<StorageStatus>
    persistRequest:Signal<PersistRequest>
    status:Signal<string>
    connection:Signal<ConnectionStatus>
    roomMissing:Signal<boolean>
    removed:Signal<boolean>
    view:Signal<View>
}

export function createRealisticState ():RealisticState {
    const user = signal<DemoUser|null>(null)
    const group = signal<ClientState|null>(null)
    const roomId = signal<string|null>(null)
    const roomMissing = signal(false)

    /**
     * The view is derived, never assigned. Four signals fully determine
     * which of the four screens is correct, so storing the answer
     * separately would only create a way for it to disagree.
     */
    const view = computed<View>(() => {
        if (roomMissing.value) return 'gone'
        if (!user.value || !roomId.value) return 'setup'
        return group.value ? 'room' : 'waiting'
    })

    return {
        ciphersuite: signal(null),
        user,
        group,
        roomId,
        creatorToken: signal(null),
        isCreator: signal(false),
        expiresAt: signal(null),
        cursor: signal(0),
        joinCursor: signal(0),
        priorCount: signal(0),
        live: signal([]),
        pending: signal([]),
        entries: signal([]),
        decrypted: signal({}),
        outbound: signal([]),
        draft: signal(''),
        persist: signal(false),
        // Explicit type arguments for the same reason `connection` needs
        // one: the literal would infer `Signal<string>`.
        storage: signal<StorageStatus>('best-effort'),
        persistRequest: signal<PersistRequest>('idle'),
        status: signal('Ready'),
        // Explicit type argument: signal('idle') would infer
        // Signal<string>, which does not satisfy
        // Signal<ConnectionStatus>.
        connection: signal<ConnectionStatus>('idle'),
        roomMissing,
        removed: signal(false),
        view
    }
}

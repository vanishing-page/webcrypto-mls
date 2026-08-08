import type { LogEntry } from '../protocol.js'

/**
 * Turning a log into something readable. Pure -- no preact, no signals,
 * no DOM -- so the placeholder rules can be unit tested in node.
 *
 * A placeholder is not an error. Two ordinary things produce one: a
 * message sent before this client joined, and a message whose keys have
 * since rotated out, because `retainKeysForEpochs` is 4 and a member
 * away across more than four commits loses older messages they were a
 * member for. Rendering either as a failure would misrepresent forward
 * secrecy as a bug.
 */

export interface TimelineText {
    kind:'text'
    seq:number

    /**
     * The wire identity that sent it, carried through beside the name
     * rather than instead of it. The view marks this client's own
     * messages by this and never by `from`: two members may choose the
     * same display name, and a name resolved out of the tree is not a
     * key. `from` stays the only thing rendered.
     */
    sender:string

    from:string
    text:string
}

export interface TimelinePlaceholder {
    kind:'placeholder'
    /** Highest seq covered, so the item has a stable sort position. */
    seq:number
    count:number
    reason:'before-join'|'undecryptable'
}

export type TimelineItem = TimelineText|TimelinePlaceholder

export interface TimelineInput {
    /** Application entries only, in seq order. */
    entries:LogEntry[]

    /** seq -> plaintext, for entries this client could decrypt. */
    decrypted:Record<number, string>

    /**
     * Wire identity -> display name, which is what `entry.sender`
     * carries. Keyed by identity rather than by seq because a name is a
     * fact about the sender, and the same sender says more than one
     * thing.
     */
    names:Record<string, string>

    /**
     * The cursor adopted from `welcome-you`. Everything at or below it
     * predates this client's membership. Zero means the client was
     * there from the start.
     */
    joinCursor:number

    /**
     * How many application entries preceded the join, as the room
     * counted them. Used instead of counting locally, because the
     * client may never have been sent those entries at all. This is the
     * number `countApplicationsAtOrBelow` in `room-logic.ts` produces,
     * and the placeholder says exactly it.
     */
    priorCount:number
}

/**
 * Fold entries into renderable items, collapsing runs of
 * undecryptable ones.
 */
export function buildTimeline (input:TimelineInput):TimelineItem[] {
    const items:TimelineItem[] = []

    // One leading placeholder for everything before the join. A client
    // that joined at the very beginning has nothing before it and gets
    // no placeholder at all -- an empty "0 earlier messages" would be
    // noise.
    if (input.joinCursor > 0 && input.priorCount > 0) {
        items.push({
            kind: 'placeholder',
            seq: input.joinCursor,
            count: input.priorCount,
            reason: 'before-join'
        })
    }

    // The run of misses being accumulated, if the last rendered entry
    // was one. The leading before-join mark is deliberately never a
    // run: it means a different thing, and a miss after the join must
    // not be counted into it.
    let run:TimelinePlaceholder|null = null

    for (const entry of input.entries) {
        if (entry.kind !== 'application') continue
        if (entry.seq <= input.joinCursor) continue

        const text = input.decrypted[entry.seq]

        if (text === undefined) {
            // Consecutive misses collapse into one item rather than a
            // wall of identical rows.
            if (run) {
                run.count = run.count + 1
                run.seq = entry.seq
            } else {
                run = {
                    kind: 'placeholder',
                    seq: entry.seq,
                    count: 1,
                    reason: 'undecryptable'
                }
                items.push(run)
            }
            continue
        }

        run = null
        items.push({
            kind: 'text',
            seq: entry.seq,
            sender: entry.sender,
            from: input.names[entry.sender] ?? 'unknown',
            text
        })
    }

    return items
}

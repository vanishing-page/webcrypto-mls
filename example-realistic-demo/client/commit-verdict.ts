/**
 * What to do about a commit that decoded and then failed to process.
 *
 * Stopping is right only when an epoch really passed that this client
 * could not follow. Anything else is a replay or a forgery, and stopping
 * on it is fatal for the whole room: `hello` resends the same cursor,
 * the replay serves the same entry, and every member's queue halts on
 * it for as long as the room lives. So the rule is narrow -- `stop` for
 * a current-epoch commit for this group from the creator, `skip` for
 * everything else. Only the creator commits in this demo.
 *
 * Its inputs are what can be read without processing: a message's group
 * id and epoch are cleartext in both wire formats.
 */

/** The group id and epoch a message is framed for, or a client is at. */
export interface EpochFraming {
    epoch:bigint
    groupId:Uint8Array
}

export interface CommitFailureFacts {
    framed:EpochFraming
    current:EpochFraming

    /**
     * Whether the entry's sender is the identity at leaf 0 of this
     * client's own tree. Never taken from the room; see `creatorOf`.
     */
    senderIsCreator:boolean
}

export type CommitVerdict = 'skip'|'stop'

export function commitFailureVerdict (
    facts:CommitFailureFacts
):CommitVerdict {
    const { framed, current, senderIsCreator } = facts
    if (!senderIsCreator) return 'skip'
    if (framed.epoch !== current.epoch) return 'skip'
    if (!sameBytes(framed.groupId, current.groupId)) return 'skip'
    return 'stop'
}

function sameBytes (a:Uint8Array, b:Uint8Array):boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

/**
 * A message that decoded and then failed to process, carrying the
 * framing read at decode time so `onError` can ask the verdict without
 * decoding again. Thrown by `processEntry` around `processMessage` only.
 *
 * Distinct from `MalformedEntryError` on purpose: that one means "not an
 * MLS message" and always skips, and nothing here may widen it.
 */
export class EntryProcessingError extends Error {
    /** The tag `framingOf` reads; see `MalformedEntryError` for why. */
    readonly entryProcessingFailed = true

    constructor (readonly framing:EpochFraming, cause:unknown) {
        super('that entry did not process', { cause })
        this.name = 'EntryProcessingError'
    }
}

/**
 * The framing an error carries, or null for any failure that did not
 * come from processing a decoded message -- which the caller treats as
 * the unknown case it is, and stops.
 */
export function framingOf (err:unknown):EpochFraming|null {
    if (typeof err !== 'object' || err === null) return null
    const e = err as { entryProcessingFailed?:unknown, framing?:unknown }
    if (e.entryProcessingFailed !== true) return null
    return e.framing as EpochFraming
}

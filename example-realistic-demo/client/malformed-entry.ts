/**
 * The distinction between an entry that is not an MLS message and one
 * that is but will not process.
 *
 * The room stores an entry's `kind` exactly as its sender asserts it and
 * cannot check it: payloads are opaque strings there. So any member can
 * write `{kind:'commit', payload:'AAAA'}` and, without this distinction,
 * every other member's queue stops on it and the cursor never moves past
 * it -- not even across a reconnect, since `hello` resends the same
 * stuck cursor and the replay hands back the same entry. One line of
 * garbage kills the room for everybody but its author.
 *
 * A commit that decodes and then fails to process is the opposite case
 * and must still stop: advancing past a real epoch change would leave
 * this client silently out of step with the group. Which of the two
 * happened is only visible where the payload is decoded, so it is
 * recorded there rather than guessed at from the message text.
 */
export class MalformedEntryError extends Error {
    /**
     * The tag `isMalformedEntry` actually reads. An `instanceof` check
     * would answer the same question here, but this survives the error
     * crossing a bundle boundary that loaded this module twice, which an
     * `instanceof` silently would not.
     */
    readonly malformedEntry = true

    constructor (message:string) {
        super(message)
        this.name = 'MalformedEntryError'
    }
}

export function isMalformedEntry (err:unknown):boolean {
    if (typeof err !== 'object' || err === null) return false
    return (err as { malformedEntry?:unknown }).malformedEntry === true
}

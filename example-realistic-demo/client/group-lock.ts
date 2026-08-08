/**
 * One queue for every asynchronous read-modify-write of `state.group`.
 *
 * Three modules do that: `chat.ts` encrypting a message, `approvals.ts`
 * committing an Add or a Remove, and `apply-entry.ts` processing an entry
 * from somebody else. Each reads the group, awaits an MLS call, and
 * assigns the state that call returned. Two of them overlapping is a lost
 * update, and which update is lost decides how bad it is:
 *
 * - The commit loses. The creator broadcast a commit and a Welcome, then
 *   an application message applied in the same window put the pre-commit
 *   state back. Every other member moves to the new epoch; the creator is
 *   left at the old one, holding a tree nobody else has, permanently.
 * - The send loses. `chat.ts` spends a generation out of its own secret
 *   tree and writes the state holding the next one. Reverting that state
 *   makes the spent generation live again, and the following message
 *   encrypts a second plaintext under the same key and nonce. That is the
 *   one failure `chat.ts` goes out of its way to avoid on the
 *   send-refused path; it must not come back in through the side.
 *
 * Each module already serialises against itself -- a chain in `chat.ts`
 * and `approvals.ts`, the serial drain in `entry-queue.ts`. None of that
 * helps: a chain orders its own module's work against nothing else. The
 * ordering has to be shared, so it lives here and is passed in.
 *
 * Pure: no signals, no DOM, nothing MLS. The rule is about ordering, and
 * ordering is testable on its own.
 */
export interface GroupLock {
    /**
     * Run `job` once every job queued before it has settled, and return
     * what it returns. A rejection reaches this caller and nobody else --
     * the jobs behind it still run, because one failed send must not
     * silence the page for the rest of the session.
     */
    run<T> (job:() => Promise<T>):Promise<T>
}

export function createGroupLock ():GroupLock {
    // Deliberately a promise that never rejects. Chaining onto a rejected
    // one would skip every job behind the failure and leave the page
    // accepting messages that go nowhere.
    let tail:Promise<void> = Promise.resolve()

    return {
        run<T> (job:() => Promise<T>):Promise<T> {
            const result = tail.then(() => job())
            tail = result.then(() => {}, () => {})
            return result
        }
    }
}

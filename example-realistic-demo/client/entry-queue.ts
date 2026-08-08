/**
 * A serial queue for inbound entries.
 *
 * Applying an entry is async, because it involves crypto, and a live
 * `entry` can arrive while a `log` batch is still being applied. Without
 * a queue the two interleave, MLS rejects the out-of-order commit, and
 * the client is stuck with no way back. So nothing is ever applied
 * directly -- everything is appended here and drained one at a time.
 *
 * Pure in the sense that matters: the apply function is an argument, so
 * this holds no reference to a socket, a signal or the DOM, and can be
 * tested in node.
 */
export interface EntryQueue<T> {
    push (items:T[]):void

    /**
     * Clear a stop and discard anything left. A stopped queue rejects
     * every later push, so without this a single fatal entry kills the
     * client permanently -- the reconnect would replay and every entry
     * would be silently dropped. The caller resets on reconnect, when
     * the replay is about to re-deliver from a known-good cursor.
     */
    reset ():void

    readonly size:number
    readonly draining:boolean
    readonly stopped:boolean
    idle ():Promise<void>
}

export interface EntryQueueOptions<T> {
    apply (item:T):Promise<void>

    /**
     * Called when `apply` throws. Returning 'stop' halts the queue and
     * discards what is left; returning 'continue' drops that one item
     * and carries on.
     *
     * The difference is the whole point. A commit that fails to process
     * is fatal for group state -- carrying on would silently skip an
     * epoch. An application message that fails to decrypt is ordinary
     * forward secrecy and must not wedge the client.
     */
    onError (err:unknown, item:T):'stop'|'continue'
}

export function createEntryQueue<T> (
    opts:EntryQueueOptions<T>
):EntryQueue<T> {
    const items:T[] = []
    let draining = false
    let stopped = false
    let idleWaiters:Array<() => void> = []

    function settle ():void {
        const waiters = idleWaiters
        idleWaiters = []
        for (const resolve of waiters) resolve()
    }

    /**
     * `onError`'s answer, and 'stop' if it has none.
     *
     * `drain` is started and never awaited, so an exception escaping it
     * is an unhandled rejection: `draining` stays set for the life of
     * the page, `push` starts no drain because it believes one is
     * already running, and every entry after that is swallowed in
     * silence. `onError` writes signals, which is enough of a way to
     * throw to be worth containing. Stopping is the conservative
     * answer -- an entry whose failure nobody handled is exactly the
     * case where advancing past it would corrupt group state -- and a
     * stop is recoverable, because `onOpen` resets the queue and the
     * replay re-delivers from the last good cursor.
     */
    function verdictFor (err:unknown, item:T):'stop'|'continue' {
        try {
            return opts.onError(err, item)
        } catch (_handlerErr) {
            return 'stop'
        }
    }

    async function drain ():Promise<void> {
        if (draining) return
        draining = true

        // re-reads items.length every pass, so a push arriving mid-drain
        // lands at the back of this drain rather than starting a second
        while (items.length > 0 && !stopped) {
            const item = items.shift() as T
            try {
                await opts.apply(item)
            } catch (err) {
                if (verdictFor(err, item) === 'stop') {
                    stopped = true
                    items.length = 0
                }
            }
        }

        draining = false
        settle()
    }

    return {
        push (next:T[]):void {
            if (stopped) return
            items.push(...next)
            drain()
        },
        reset ():void {
            stopped = false
            items.length = 0
        },
        get size ():number {
            return items.length
        },
        get draining ():boolean {
            return draining
        },
        get stopped ():boolean {
            return stopped
        },
        idle ():Promise<void> {
            if (!draining && items.length === 0) return Promise.resolve()
            return new Promise(resolve => {
                idleWaiters.push(resolve)
            })
        }
    }
}

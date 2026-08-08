/**
 * Helpers for the tests that assert something did *not* happen yet.
 * Exports no tests of its own, so it is not registered in
 * `test/index.ts`; see `test/example/vnode.ts` for the same shape.
 */

export interface Deferred {
    promise:Promise<void>
    resolve ():void
    reject (err:unknown):void
}

/**
 * A promise the test resolves by hand. The rule the group lock exists
 * for is about the window while something else is still holding it, and
 * that window only exists if the test decides when it closes.
 */
export function deferred ():Deferred {
    // Assigned synchronously by the executor below, which runs before
    // `new Promise` returns. The initial no-ops are only there to satisfy
    // the definite-assignment check.
    let settle = ():void => {}
    let fail = (_err:unknown):void => {}

    const promise = new Promise<void>((resolve, reject) => {
        settle = resolve
        fail = reject
    })

    return { promise, resolve: settle, reject: fail }
}

/**
 * Long enough that an operation which was waiting for nothing would have
 * finished. The MLS calls these tests queue behind the lock -- one
 * encrypt, one decrypt, one Add commit -- each run in single-digit
 * milliseconds here, so this is a margin of one to two orders of
 * magnitude rather than a race.
 */
export function longEnoughToHaveFinished ():Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, 200) })
}

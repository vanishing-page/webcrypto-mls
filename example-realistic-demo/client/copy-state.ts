import { type Signal, useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

/**
 * How long the "Copied" confirmation stays up. Long enough to be read
 * after the eye has moved back to the value, short enough that it is
 * gone before the next copy.
 */
export const COPIED_MS = 4000

export interface CopyState {
    /** Whether the confirmation is showing. */
    copied:Signal<boolean>

    /** Put `value` on the clipboard and confirm it. */
    copy:(value:string) => void
}

/**
 * The clipboard half of a copy control: the write, the flag the views
 * confirm with, and the timer that takes the confirmation back down.
 * Both copy controls use this, so the confirmation behaves the same in
 * each, and neither of the presentational components needs a clock.
 */
export function useCopy (onError:(err:unknown) => void):CopyState {
    const copied = useSignal(false)
    const timer = useRef<ReturnType<typeof setTimeout>|null>(null)

    function clear ():void {
        if (timer.current === null) return
        clearTimeout(timer.current)
        timer.current = null
    }

    // A pending reset that outlives the component would fire into a
    // signal nothing reads, so drop it on unmount.
    useEffect(() => clear, [])

    function copy (value:string):void {
        (async () => {
            try {
                await navigator.clipboard.writeText(value)
                // A second copy restarts the wait rather than inheriting
                // whatever is left of the first one's.
                clear()
                copied.value = true
                timer.current = setTimeout(() => {
                    timer.current = null
                    copied.value = false
                }, COPIED_MS)
            } catch (err) {
                clear()
                copied.value = false
                onError(err)
            }
        })()
    }

    return { copied, copy }
}

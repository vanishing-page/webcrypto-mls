/**
 * Keeping the log pinned to its newest entry.
 *
 * A chat is read from the bottom, so the scroll container has to follow
 * the end of the log as entries land -- but only while the reader is
 * actually at the end. Someone who has scrolled up to read what was
 * said an hour ago must not be yanked back down by an arriving message,
 * so following is a mode this turns off the moment they leave the
 * bottom and back on the moment they return.
 *
 * There are no hooks here and nothing preact-shaped, for two reasons.
 * `Room` is deliberately hook-free -- the node suite calls it as a plain
 * function -- so the behaviour cannot live in a `useLayoutEffect`. And
 * observing the DOM directly is what makes it jank-free: a
 * `MutationObserver` callback runs as a microtask immediately after the
 * mutation that queued it and before the next paint, so the scroll
 * correction lands in the same frame as the message. Scheduling the
 * same work on `requestAnimationFrame`, or in an effect that runs after
 * preact has already committed, would let one frame paint unscrolled.
 *
 * Nothing in this module touches the DOM at module scope, so importing
 * it from a view is safe under node. `MutationObserver` and
 * `ResizeObserver` are named only inside functions the suite never
 * calls.
 */

/**
 * How far off the bottom still counts as being at the bottom, in CSS
 * pixels. A scroll position is routinely fractional -- a zoomed page
 * and a subpixel line height both produce one -- so an exact comparison
 * would drop out of following for no reason a reader could see. The
 * slack is also generous enough that nudging the log by a couple of
 * pixels leaves you still watching the end, which is what you are.
 */
const SLACK = 24

export interface FollowedLog {
    /** Scroll to the newest entry and start following again. */
    toBottom ():void

    /** Drop every listener and observer this attached. */
    stop ():void
}

/**
 * Follow the end of `scroller` until its reader scrolls away from it.
 *
 * Three things can put the newest entry out of view and each has its
 * own observer, because none of them implies the others. A message
 * arrives and the content grows, which is the mutation observer. The
 * panel changes size, or a line rewraps, or a font finishes loading and
 * every row gets taller, which is the resize observer -- watching the
 * container and its content both, since content growing does not resize
 * the container. And the reader scrolls, which is the listener that
 * decides whether any of it should move the view at all.
 */
export function stickToBottom (scroller:HTMLElement):FollowedLog {
    let following = true

    // What the sheet is told, and only ever written when it changes. A
    // scroll handler that touched the DOM on every event would be
    // inviting back exactly the stutter this is here to avoid.
    let above:boolean|null = null
    let below:boolean|null = null

    function distanceFromBottom ():number {
        return scroller.scrollHeight - scroller.scrollTop -
            scroller.clientHeight
    }

    /**
     * Which ends of the log have something past them, published as
     * attributes for the sheet to hang the edge rules and the jump
     * control on.
     *
     * This rather than `@container scroll-state(scrollable: ...)`,
     * which looks like the declarative answer and is not: it reports
     * that an axis has scrollable overflow at all, so it stays true at
     * the very top and at the very bottom alike, and a jump control it
     * drove would be offered permanently. Deciding it here also means
     * the control appears on exactly the condition that makes it do
     * something -- the same `SLACK` that decides whether the log is
     * following -- and in every browser rather than one.
     */
    function publish ():void {
        const nextAbove = scroller.scrollTop > 1
        const nextBelow = distanceFromBottom() > SLACK

        if (nextAbove !== above) {
            above = nextAbove
            scroller.dataset.above = String(nextAbove)
        }

        if (nextBelow !== below) {
            below = nextBelow
            scroller.dataset.below = String(nextBelow)
        }
    }

    function pin ():void {
        if (following) {
            // Clamped by the browser, so the overshoot is deliberate:
            // it asks for the end without having to know what the end
            // is after whatever just changed.
            scroller.scrollTop = scroller.scrollHeight
        }

        publish()
    }

    // Fires for our own writes as well as the reader's, which is what
    // keeps the mode honest: a programmatic pin lands at the bottom and
    // so leaves following on.
    function onScroll ():void {
        following = distanceFromBottom() <= SLACK
        publish()
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })

    // Attributes are deliberately not observed, so the writes `publish`
    // makes cannot feed back in here.
    const mutations = new MutationObserver(pin)
    mutations.observe(scroller, {
        characterData: true,
        childList: true,
        subtree: true
    })

    const resizes = new ResizeObserver(pin)
    resizes.observe(scroller)
    for (const child of Array.from(scroller.children)) {
        resizes.observe(child)
    }

    // The log is very often already scrolled past a screen on the first
    // render -- a client that has just replayed a room's history has
    // every message at once -- so the end has to be found before the
    // first paint, not on the first arrival after it.
    pin()

    return {
        toBottom () {
            following = true
            pin()
        },

        stop () {
            scroller.removeEventListener('scroll', onScroll)
            mutations.disconnect()
            resizes.disconnect()
        }
    }
}

/**
 * The log this page is currently following, if it is showing one.
 *
 * A module-level single value rather than a map, because a browser is
 * one MLS client in one room here and the page shows one log or none.
 */
let followed:FollowedLog|null = null

/**
 * The scroll container's `ref`, and a named function on purpose.
 *
 * Preact re-invokes a ref whose identity changed, so an inline arrow
 * would tear these observers down and build them again on every render
 * -- on every arriving message, which is exactly when the log can least
 * afford to lose its place. This identity never changes, so preact
 * calls it once on mount and once more with `null` on unmount.
 */
export function followNewest (el:HTMLElement|null):void {
    if (followed) {
        followed.stop()
        followed = null
    }

    if (el) followed = stickToBottom(el)
}

/**
 * Jump back to the newest entry and resume following it. Wired to the
 * control that appears only while there is something below the fold.
 */
export function jumpToNewest ():void {
    followed?.toBottom()
}

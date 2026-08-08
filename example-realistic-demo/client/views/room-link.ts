import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { useSignal } from '@preact/signals'

export interface RoomLinkProps {
    /** The whole absolute URL, not a path and not an id. */
    url:string

    /** Whether a copy has happened, so it can be confirmed. */
    copied:boolean

    onCopy:() => void
}

/**
 * The room's invitation: the whole absolute URL, selectable, plus a
 * control that copies it and says so. Presentational only -- the
 * clipboard call and the "copied" flag live in `ShareRoomLink` below,
 * which is what keeps this half assertable without a browser.
 */
export const RoomLink:FunctionComponent<RoomLinkProps> = function ({
    url,
    copied,
    onCopy
}) {
    return html`
        <div class="room-link">
            <substrate-input
                class="room-url"
                readonly=${true}
                value=${url}
                aria-label="Room URL"
            />
            <substrate-button
                class="copy"
                type="button"
                aria-label="Copy room URL"
                onClick=${onCopy}
            >Copy</substrate-button>
            <!-- The live region persists even when empty so assistive
            technology can observe the state change. The resulting empty
            flex item is deliberate. -->
            <span
                class="copied"
                role="status"
                data-copied=${copied}
            >${copied ? 'Copied' : ''}</span>
        </div>
    `
}

export interface ShareRoomLinkProps {
    url:string

    /** Where a clipboard refusal goes; the views send it to `status`. */
    onError:(err:unknown) => void
}

/**
 * The same link, wired to the clipboard. Both views that show a room URL
 * render this, so the confirmation behaves the same in each.
 */
export const ShareRoomLink:FunctionComponent<ShareRoomLinkProps> = function (
    { url, onError }
) {
    const copied = useSignal(false)

    async function copy ():Promise<void> {
        try {
            await navigator.clipboard.writeText(url)
            copied.value = true
        } catch (err) {
            copied.value = false
            onError(err)
        }
    }

    return html`<${RoomLink}
        url=${url}
        copied=${copied.value}
        onCopy=${() => { copy() }}
    />`
}

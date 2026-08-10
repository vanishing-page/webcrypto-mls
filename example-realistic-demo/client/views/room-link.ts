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
            <div class="copy-control">
                <!-- The word is always in the layout, above the button,
                and only turns visible on a copy, so nothing on the row
                moves when it appears. Hidden from assistive technology
                because the live region below says the same thing. -->
                <span
                    class="copied"
                    aria-hidden="true"
                    data-copied=${copied}
                >Copied</span>
                <substrate-button
                    class="copy"
                    type="button"
                    aria-label="Copy room URL"
                    onClick=${onCopy}
                >Copy</substrate-button>
                <!-- What assistive technology hears. It persists even
                when empty so the text swap is observable; a visibility
                change on its own is not reliably announced. -->
                <span
                    class="copy-status"
                    role="status"
                >${copied ? 'Copied' : ''}</span>
            </div>
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

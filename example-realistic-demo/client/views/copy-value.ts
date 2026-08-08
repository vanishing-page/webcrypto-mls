import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { useSignal } from '@preact/signals'

export interface CopyControlProps {
    /** Whether a copy has happened, so it can be confirmed. */
    copied:boolean

    /**
     * The button's accessible name. Required, and not defaulted: once
     * the room has two copy buttons in one column, "Copy" alone does
     * not say which value it takes.
     */
    label:string

    onCopy:() => void
}

/**
 * A control that copies some value the caller renders itself, and says
 * so once it has. Presentational only -- the clipboard call and the
 * "copied" flag live in `CopyValue` below, which is what keeps this
 * half assertable without a browser.
 */
export const CopyControl:FunctionComponent<CopyControlProps> = function ({
    copied,
    label,
    onCopy
}) {
    return html`
        <div class="copy-value">
            <substrate-button
                class="copy"
                type="button"
                aria-label=${label}
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

export interface CopyValueProps {
    /** The string the control puts on the clipboard. */
    value:string

    /** The button's accessible name; see `CopyControlProps`. */
    label:string

    /** Where a clipboard refusal goes; the views send it to `status`. */
    onError:(err:unknown) => void
}

/**
 * The same control, wired to the clipboard. The caller renders the
 * value and passes it here, so the value stays in the caller's own
 * vnode tree and remains assertable.
 */
export const CopyValue:FunctionComponent<CopyValueProps> = function (
    { value, label, onError }
) {
    const copied = useSignal(false)

    async function copy ():Promise<void> {
        try {
            await navigator.clipboard.writeText(value)
            copied.value = true
        } catch (err) {
            copied.value = false
            onError(err)
        }
    }

    return html`<${CopyControl}
        copied=${copied.value}
        label=${label}
        onCopy=${() => { copy() }}
    />`
}

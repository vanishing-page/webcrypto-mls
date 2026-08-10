import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'

/**
 * Explainer for dev tools.
 *
 * The `window.state` handle is gated on `import.meta.env.DEV` in both
 * demos, because the state it points at holds live group secrets. So the
 * copy has to name the dev server rather than promise the handle
 * outright -- on the deployed pages it is not there.
 */
export const DevTools:FunctionComponent = function () {
    return html`<div class="card instructions">
        <h2>Notes</h2>
        <p>
            Run the demo locally and <code>window.state</code> exists in
            the console. Use it to see all client-side application state.
            It is left out of built pages on purpose: the state holds live
            group secrets.
        </p>
    </div>`
}


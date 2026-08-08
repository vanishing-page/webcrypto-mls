import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'

/**
 * Explainer for dev tools.
 */
export const DevTools:FunctionComponent = function () {
    return html`<div class="card instructions">
        <h2>Notes</h2>
        <p>
            In the console, <code>window.state</code> exists. Use it to see
            all client-side application state.
        </p>
    </div>`
}


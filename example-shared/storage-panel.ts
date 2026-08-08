import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import {
    type StorageStatus,
    storageStatusLabel
} from './storage-persistence.js'
import { NBSP } from './constants.js'

/**
 * The state of the most recent `persist()` call. Tracked separately from
 * the storage status because a denial leaves the status unchanged, so
 * the status label alone gives no feedback that anything happened.
 */
export type PersistRequest = 'idle' | 'pending' | 'granted' | 'denied'

type RequestMessages = Record<Exclude<PersistRequest, 'idle'>, string>

export const PERSIST_MESSAGES:RequestMessages = {
    pending: 'Asking the browser for persistent storage...',
    granted: 'Granted. The browser will not evict this data ' +
        'automatically -- only you can clear it.',
    denied: 'Denied. Browsers decide this from engagement signals ' +
        '(bookmarking or installing the site as a PWA, repeat visits),' +
        ' so there is often no prompt. Data is still saved to indexedDB,' +
        ' but the browser may evict it under storage pressure.'
}

/**
 * How a finished `persist()` call reads to the visitor. Only an actually
 * persistent status counts as granted: 'best-effort' means the browser
 * declined, and 'unsupported' means it never asked.
 */
export function persistOutcome (
    status:StorageStatus
):Exclude<PersistRequest, 'idle' | 'pending'> {
    return status === 'persistent' ? 'granted' : 'denied'
}

export interface StoragePanelProps {
    status:StorageStatus;
    request:PersistRequest;
    onRequest:() => void;
}

/**
 * The storage-persistence block every persisting demo page shows: the
 * current status, a button to ask the browser for persistence, and the
 * outcome of the last request. Shared so that two pages cannot drift
 * into describing the same browser answer differently.
 */
export const StoragePanel:FunctionComponent<StoragePanelProps> = function ({
    status,
    request,
    onRequest
}) {
    return html`
        <div class="storage-persistence">
            <div>
                ${storageStatusLabel(status) + NBSP}
            </div>
            ${status !== 'unsupported' ? html`
                <substrate-button
                    class="request-persist-btn"
                    onClick=${onRequest}
                    disabled=${status === 'persistent' ||
                        request === 'pending'}
                >
                    ${request === 'pending' ?
                        'Requesting...' :
                        'Request persistent storage'}
                </substrate-button>
            ` : null}

            <!--
                Every message is laid into the same grid cell, so the
                slot is as tall as the tallest of them before any of
                them is shown. The copies are invisible: they are here
                to hold the space open, so that an answer arriving does
                not push the rest of the page down.
            -->
            <div class="persist-result-slot">
                ${(Object.keys(PERSIST_MESSAGES) as
                    (keyof RequestMessages)[]).map((key) => html`
                    <p class="persist-sizer" aria-hidden="true">
                        ${PERSIST_MESSAGES[key]}
                    </p>
                `)}

                <p
                    class="persist-result ${request}"
                    role="status"
                    aria-live="polite"
                >
                    ${request === 'idle' ? NBSP : PERSIST_MESSAGES[request]}
                </p>
            </div>
        </div>
    `
}

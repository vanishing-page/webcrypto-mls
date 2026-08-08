import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import type { StorageStatus } from
    '../../../example-shared/storage-persistence.js'
import {
    StoragePanel,
    type PersistRequest
} from '../../../example-shared/storage-panel.js'
import { EM_DASH, NBSP } from '../../../example-shared/constants.js'

export interface PersistenceProps {
    persist:boolean
    storage:StorageStatus
    request:PersistRequest
    onToggle (on:boolean):void
    onRequest ():void
    onReset ():void
}

/**
 * The persistence control, rendered from the first paint and never
 * unmounted -- before there is a user, before there is a room, and
 * beside every view afterwards. That placement is the requirement:
 * inside the room view it would appear only once a group existed, which
 * is long after the point at which someone would want to decide.
 *
 * It names what is written and where, because "remember me" alone says
 * nothing about private keys going into a database on this machine.
 *
 * No hooks, for the same reason `Room` has none: it is called directly
 * in the node suite.
 */
export const Persistence:FunctionComponent<PersistenceProps> = function (
    props
) {
    const { persist, storage, request } = props

    return html`
        <section class="persistence">
            <div class="block">
                <h2>Persistence</h2>

                <check-box
                    class="persist-toggle"
                    checked=${persist}
                    onChange=${(ev:{
                        currentTarget:{ checked:boolean }
                    }) => {
                        props.onToggle(ev.currentTarget.checked)
                    }}
                >Remember this session in this browser</check-box>

                <p class="persist-disclosure">
                    When checked, this writes your display name, key
                    package, private keys, the room's ID, your
                    place in the room's log, and your group state to indexedDB.
                    If you created the room, it also saves the token used for
                    admin auth. All this data is saved to an indexedDB database
                    called <code>mls-realistic-demo</code>.
                </p>
                <p>
                    The token is what the server uses to determine approvals and
                    removals in the room, so anything with access to this
                    browser's storage can act as the creator of the
                    room.
                </p>
                <p>
                    If unchecked, nothing is stored and closing the tab ends the
                    session for good.
                </p>

                <p class="history-disclosure">
                    Note the plaintext messages are not stored anywhere,
                    so coming back puts you in the
                    group at the epoch you left, with an empty
                    history: this page resumes from your place in the
                    log and reads from there on.
                </p>

                <${StoragePanel}
                    status=${storage}
                    request=${request}
                    onRequest=${props.onRequest}
                />

                <substrate-button class="reset" onClick=${props.onReset}>
                    Delete stored data
                </substrate-button>

                <p class="reset-disclosure">
                    Delete removes the <code>mls-realistic-demo</code>${NBSP}
                    database and nothing else. Anything else this
                    browser has stored is untouched, and so is the room
                    on the server ${EM_DASH} it goes on existing, with
                    everything said in it, until it expires.
                </p>
            </div>
        </section>
    `
}

import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { EM_DASH } from '../../../example-shared/constants.js'

export interface GoneProps {
    /** Back to the setup view, with no room id in the URL. */
    onCreateNew ():void
}

/**
 * The answer to a room id that leads nowhere. Shown for a 404 from the
 * probe and for a `no-room` off the socket, which are the same reply:
 * the room's Durable Object either deleted its storage when its alarm
 * fired or never had any, and from the outside those two are one state.
 *
 * So the page says both, in one sentence, rather than guessing. Telling
 * someone "this expired" about an id that was mistyped would be a
 * confident lie, and the server has nothing left that could distinguish
 * them -- expiry deletes the whole record, including the fact that
 * there was one.
 *
 * Driven entirely by props and hook-free, so the node suite can call it
 * as a plain function.
 */
export const Gone:FunctionComponent<GoneProps> = function (props) {
    return html`
        <section class="gone">
            <div class="block">
                <h1>There is no room at this address</h1>

                <p class="gone-disclosure">
                    Either this room expired ${EM_DASH} rooms are deleted
                    three days after they are made ${EM_DASH} or there
                    was never a
                    room with this id. Nothing here can tell you which.
                    Expiry deletes the room's whole record, so an
                    expired id and an invented one look the same from
                    outside.
                </p>

                <p>
                    Anything that was said in it is gone with it. The
                    messages were encrypted to keys the server never
                    held, and the log they were stored in has been
                    deleted, so there is nothing left to recover from
                    either side.
                </p>

                <substrate-button
                    class="create-new"
                    onClick=${props.onCreateNew}
                >Start a new room</substrate-button>
            </div>
        </section>
    `
}

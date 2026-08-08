import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { EM_DASH } from '../../../example-shared/constants.js'

export interface WaitingProps {
    /** The room this client asked to be let into. */
    url:string

    /** The name that went into the key package, kept locally. */
    name:string

    /** The one human sentence about where the request got to. */
    status:string

    /**
     * Whether this browser has been asked to keep the session. It
     * changes what is true about closing the tab, so the disclosure
     * below has to follow it.
     */
    persist:boolean
}

/**
 * The screen between asking and being let in. Driven entirely by props
 * and hook-free, so the Node suite can call it as a plain function --
 * and so it never has to read `location` itself.
 *
 * The disclosure is deliberately split in two, because the two halves
 * have different answers. The *request* does live in the room and does
 * survive a dropped connection -- that is realistic-demo.AC3.3. The
 * private key that opens the invitation lives in this page and nowhere
 * else, so closing the tab does not resume anything: the next visit
 * generates a new signature key, and a new signature key is a different
 * person who has to ask again. Saying only the first half teaches that
 * a Welcome is a thing you can pick up anywhere, which is the opposite
 * of what holding your own keys means.
 *
 * Persistence makes the second half survivable, and only when the
 * person has opted into it -- so which half is true is a function of
 * `persist`, and saying the wrong one is a defect no test of the code
 * would catch.
 */
export const Waiting:FunctionComponent<WaitingProps> = function ({
    url,
    name,
    status,
    persist
}) {
    return html`
        <section class="waiting">
            <div class="block">
                <h1>Waiting to be let in</h1>

                <p>
                    You asked to join
                    <a href=${url}>${url}</a>
                    as <span class="chosen-name">${name}</span>.
                </p>

                <p>
                    Whoever made the room has to approve you. Nobody
                    else can, and there is nothing you can do from here
                    to hurry it along.
                </p>

                <p class="disclosure" data-persist=${persist}>
                    Your request is held by the room, so it survives if
                    the connection drops ${EM_DASH} you do not have to
                    ask again.
                    ${persist ?
                        'The key that opens the invitation is in this ' +
                        'browser\'s storage, because you asked this ' +
                        'session to be kept, so you can close the tab ' +
                        'and come back to the same request. Turning ' +
                        'that off, or deleting the stored data, throws ' +
                        'the key away.' :
                        'The key that opens the invitation is held by ' +
                        'this page and by nothing else, so keep the ' +
                        'tab open. Closing it throws that key away, ' +
                        'and whoever opens this link next is somebody ' +
                        'new who has to ask again.'}
                </p>

                <p class="status" role="status">${status}</p>
            </div>
        </section>
    `
}

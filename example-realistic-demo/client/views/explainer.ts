import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { DevTools } from '../../../example-shared/dev-tools.js'
import {
    HowToUse,
    type SetupStep
} from '../../../example-shared/how-to-use.js'
import { EM_DASH } from '../../../example-shared/constants.js'

/**
 * The order this demo has to be driven in. Unlike the multi-device
 * page's steps, two of these need a second browser, which is the point
 * of the demo: nothing here is one page talking to itself.
 */
export const ROOM_STEPS:SetupStep[] = [
    {
        id: 'create-room',
        title: 'Create a room',
        detail: 'Your name goes into a key package made in the ' +
            'browser. The room is handed a room id and your ' +
            'identity, which is your signature public key. The token ' +
            'proving you made the room is minted there and handed back.'
    },
    {
        id: 'share-link',
        title: 'Send the link to somebody else',
        detail: 'Open it in another browser or another profile, ' +
            'not another tab, which is the same client.'
    },
    {
        id: 'approve',
        title: 'Approve the request',
        detail: "The new user's key package arrives with a request to join. " +
            'Approving the request commits an Add operation, ' +
            'and the Welcome message that comes back puts them in the group.'
    },
    {
        id: 'talk',
        title: 'Say something in both directions',
        detail: 'Each message is encrypted to the group\'s current ' +
            'epoch. The server stores the ciphertext, and will return ' +
            'ciphertexts in order.'
    },
    {
        id: 'break-it',
        title: 'Close a tab, or remove somebody',
        detail: "A closed tab's state is still in the database, not gone. " +
            'A removed member keeps ' +
            'everything already said and can read nothing after the ' +
            'commit that took their leaf out.'
    }
]

/**
 * What this server is trusted to do, and how to drive the demo.
 *
 * The trust disclosure is the part that matters. Everything it names is
 * something a well-behaved server is simply doing its job by doing, and
 * nothing on this page would catch it if it stopped -- which is a
 * different kind of statement from anything the protocol guarantees,
 * and the reason it is stated on its own.
 *
 * Hook-free and driven by props, like the other views, so the node
 * suite can call it directly.
 */
export const Explainer:FunctionComponent<{ expiresAt:number|null }> = function ({
    expiresAt
}) {
    return html`
        <section class="explainer">
            <div class="block">
                <h2>Trust</h2>

                <p class="trust-disclosure">
                    The server never sees a plaintext message.
                    The server does control the list of ciphertexts, so it
                    could possibly change the order of messages or delete
                    messages.
                </p>

                <p>
                    The server <em>can see</em> which identities are connected,
                    the time of connection, and the size of the ciphertexts.
                </p>

                <p>
                    Everybody in the room can read everybody else's name.
                    Names live in the ratchet tree, and every member holds
                    a copy of the tree.
                </p>

                <p>
                    The server can read the chosen username of anybody who asks
                    to join. A join request carries a key package, and the name
                    is written into the key package in plain text, as it is
                    in the Add operation that admits them. The room creator's
                    name is the exception ${EM_DASH} it reaches the other members
                    inside an encrypted Welcome, and the server never
                    sees it.
                </p>

                <p>
                    The server sends a token to the room creator, which gives
                    the room's creator the ability to remove other people from
                    the room. That is all application code, not a part of MLS.
                </p>
            </div>

            <${HowToUse} steps=${ROOM_STEPS} />

            <${DevTools} />

            ${expiresAt === null ? null : html`
                <p class="expiry" data-expires=${expiresAt}>
                    This room and everything stored in it are deleted at
                    ${' '}${new Date(expiresAt).toLocaleString()}.
                </p>
            `}
        </section>
    `
}

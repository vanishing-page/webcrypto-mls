import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { batch } from '@preact/signals'
import { useSignal, useSignalEffect } from '@preact/signals'
import { nanoid } from 'nanoid'
import { ROOM_ID_LENGTH } from '../../room-logic.js'
import { initCiphersuite, createUser, createOwnGroup } from
    '../mls-actions.js'
import { roomUrl } from '../routing.js'
import type { RealisticState } from '../state.js'
import { ShareRoomLink } from './room-link.js'

export interface SetupFormProps {
    name:string
    busy:boolean

    /**
     * True when this form is asking to be let into someone else's room
     * rather than making one. The field is the same either way -- only
     * what the button promises differs.
     */
    joining?:boolean

    onName:(value:string) => void
    onSubmit:() => void
}

/**
 * The form on its own, driven entirely by props. Splitting it from the
 * create flow below is what makes it assertable in Node: a component
 * that calls hooks cannot be invoked as a plain function.
 */
export const SetupForm:FunctionComponent<SetupFormProps> = function ({
    name,
    busy,
    joining,
    onName,
    onSubmit
}) {
    const ready = name.trim() !== '' && !busy

    const label = joining ?
        (busy ? 'Asking...' : 'Ask to join') :
        (busy ? 'Creating...' : 'Create room')

    return html`
        <form
            class="setup-form"
            onSubmit=${(ev?:Event) => {
                ev?.preventDefault()
                onSubmit()
            }}
        >
            <substrate-input
                label="Your name"
                name="display-name"
                autocomplete="nickname"
                value=${name}
                disabled=${busy}
                onInput=${(ev:{ currentTarget:{ value:string } }) => {
                    onName(ev.currentTarget.value)
                }}
            />
            <substrate-button
                type="submit"
                disabled=${!ready}
            >${label}</substrate-button>
        </form>
    `
}

export interface SetupProps {
    state:RealisticState

    /**
     * Open the socket for a room. `creatingRoom` says which of the two
     * things this socket is for -- making the room, or asking to be let
     * into one that already exists. Neither message is sent from here:
     * `connect()` returns while the socket is still CONNECTING, so both
     * go from the delivery client's open hook.
     */
    connect:(roomId:string, creatingRoom:boolean) => void

    /** Push a path and re-run the route, so the view follows the URL. */
    navigate:(path:string) => void
}

/**
 * Make one user and one room. The name is local: it goes into a key
 * package's credential, never onto the wire as a name.
 */
export const Setup:FunctionComponent<SetupProps> = function ({
    state,
    connect,
    navigate
}) {
    const name = useSignal('')
    const busy = useSignal(false)
    const roomId = useSignal<string|null>(null)

    // Navigation waits for the room to actually exist. `creatorToken`
    // arrives only in a `created` message, so a room id that the server
    // refused -- `room-exists` -- never becomes a URL anyone can visit.
    useSignalEffect(() => {
        const id = roomId.value
        if (id && state.creatorToken.value) navigate('/' + id)
    })

    // Someone who arrived on an invitation link already has a room id,
    // and must not make a second one. The same field asks for the same
    // thing; only what happens after the submit differs.
    const joining = state.roomId.value !== null

    /**
     * Make a user and ask to be let in. No group is created here: the
     * group arrives in a Welcome once the creator approves the request,
     * and making one locally would put this page in a room of its own
     * that nobody else can see.
     *
     * Nothing is sent from here either -- `connect()` returns while the
     * socket is still CONNECTING, so the request is published from the
     * open hook, which also re-publishes it after a reconnect.
     */
    async function join (displayName:string, roomId:string):Promise<void> {
        const cs = state.ciphersuite.value ?? await initCiphersuite()
        const user = await createUser(displayName, cs)

        batch(() => {
            state.ciphersuite.value = cs
            state.user.value = user
        })

        connect(roomId, false)
    }

    async function create ():Promise<void> {
        if (busy.value) return
        const displayName = name.value.trim()
        if (displayName === '') return

        busy.value = true

        try {
            const invited = state.roomId.value

            if (invited !== null) {
                await join(displayName, invited)
                return
            }

            const cs = state.ciphersuite.value ?? await initCiphersuite()
            const user = await createUser(displayName, cs)
            const group = await createOwnGroup(user, cs)
            const id = nanoid(ROOM_ID_LENGTH)

            batch(() => {
                state.ciphersuite.value = cs
                state.user.value = user
                state.group.value = group
                state.status.value = 'Creating the room...'
                roomId.value = id
            })

            connect(id, true)
        } catch (err) {
            batch(() => {
                busy.value = false
                state.status.value = `Could not create a room: ${err}`
            })
        }
    }

    return html`
        <section class="setup">
            <div class="block">
                <h1>${joining ? 'Join this room' : 'Start a room'}</h1>

                ${roomId.value === null ?
                    html`<${SetupForm}
                        name=${name.value}
                        busy=${busy.value}
                        joining=${joining}
                        onName=${(value:string) => { name.value = value }}
                        onSubmit=${() => { create() }}
                    />` :
                    html`
                        <p>Send this link to whoever should join.</p>
                        <${ShareRoomLink}
                            url=${roomUrl(location.origin, roomId.value)}
                            onError=${(err:unknown) => {
                                state.status.value =
                                    `Could not copy the URL: ${err}`
                            }}
                        />
                    `}

                <p class="status" role="status">${state.status.value}</p>
            </div>
        </section>
    `
}

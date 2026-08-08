import { render } from 'preact'
import { html } from 'htm/preact'
import { batch } from '@preact/signals'
import Route from 'route-event'
/**
 * Registration only. These must not be imported from a view module:
 * the node suite calls the views as plain functions, and both
 * `@substrate-system/web-component/util` (which binds
 * `document.querySelector` at module top level) and `check-box`
 * (whose class extends `HTMLElement`) throw under Node. This entry is
 * the one place the suite never reaches.
 */
import '@substrate-system/input'
import '@substrate-system/button'
import '@substrate-system/check-box'
import type { PendingRequest } from '../protocol.js'
import { createRealisticState } from './state.js'
import { routeFromPath } from './routing.js'
import { createConnection } from './connection.js'
import { createApprovals } from './approvals.js'
import { createApplyEntry } from './apply-entry.js'
import { createChat } from './chat.js'
import { createGroupLock } from './group-lock.js'
import { createSession, storedRoomIsWanted } from './session.js'
import {
    identityOf,
    encodeKeyPackageB64,
    initCiphersuite,
    joinFromWelcome
} from './mls-actions.js'
import type { Member } from './membership.js'
import { roomUrl } from './routing.js'
import { Setup } from './views/setup.js'
import { Room } from './views/room.js'
import { Waiting } from './views/waiting.js'
import { Persistence } from './views/persistence.js'
import { Gone } from './views/gone.js'
import { Explainer } from './views/explainer.js'
import { createSessionStore } from '../../example-shared/persistence-storage.js'
import {
    checkPersisted,
    requestPersistentStorage
} from '../../example-shared/storage-persistence.js'
import { persistOutcome } from '../../example-shared/storage-panel.js'

/**
 * The page: one state, one route subscription, one render. Everything
 * that decides anything lives in a module this one calls -- the route
 * rules in `routing.ts`, the wire rules in `../room-logic.ts`, the MLS
 * calls in `mls-actions.ts` -- so this file is wiring and nothing else.
 */

const state = createRealisticState()

if (isDev()) {
    // @ts-expect-error dev
    window.state = state
    localStorage.setItem('DEBUG', 'webcrypto-mls,webcrypto-mls:*')
}

/**
 * The third database name, beside `mls-persistence-demo` and
 * `mls-multi-device-demo`. Each demo owns its records outright, which is
 * what lets the Delete control here take one database and leave the
 * others alone.
 */
const session = createSession({
    state,
    store: createSessionStore({ dbName: 'mls-realistic-demo' })
})

/**
 * True from the moment this client generates a room id until the room
 * answers `created`. Task 6's connection reads it, so that a socket
 * dropping mid-creation retries the create rather than saying `hello`
 * to a room that was never made.
 */
const creating = { value: false }

/**
 * One lock, handed to all three modules that read `state.group`, await an
 * MLS call and write it back. It is on this page rather than inside any
 * of them because a lock each would order nothing: see `group-lock.ts`
 * for what each of the two possible lost updates does.
 */
const groupLock = createGroupLock()

/**
 * What this client calls itself on the wire, or null before there is a
 * key package. Read in two places -- the `hello` identity and the check
 * that skips this client's own entries on replay -- so it is one
 * function rather than the same expression twice.
 */
function ownIdentity ():string|null {
    const keyPackage = state.user.value?.keyPackage
    return keyPackage ? identityOf(keyPackage) : null
}

/** One socket for this page, whichever room it ends up in. */
const delivery = createConnection({
    state,

    identity: ownIdentity,

    isCreating ():boolean {
        return creating.value
    },

    /**
     * Ask to be let in whenever there is a key package and no group.
     * That is exactly the state of someone waiting for approval, and it
     * stops being true the moment a Welcome is processed -- so a member
     * never re-asks, and a client whose request went unanswered while
     * it was away asks again on its next open.
     */
    joinRequest ():string|null {
        const keyPackage = state.user.value?.keyPackage
        if (!keyPackage || state.group.value) return null
        return encodeKeyPackageB64(keyPackage)
    },

    /**
     * Applying an entry is its own module; see `apply-entry.ts` for why
     * a client never processes its own commit, and why being removed is
     * not a failure.
     */
    applyEntry: createApplyEntry({
        state,
        lock: groupLock,
        identity: ownIdentity,
        close: () => { delivery.close() }
    }),

    async onControl (msg):Promise<void> {
        // The create is retried on every open until the room confirms
        // it, so this is the only thing that ends it.
        if (msg.type === 'created') creating.value = false

        // Awaited rather than left running: the connection reports a
        // rejection here, and a pre-approved commit that failed is
        // something the creator has to be told about.
        if (msg.type === 'pending') {
            await approvals.onPending(msg.requests)
            return
        }

        if (msg.type !== 'welcome-you') return

        const user = state.user.value
        const cs = state.ciphersuite.value

        if (!user || !cs) {
            throw new Error('a Welcome arrived before there was a user')
        }

        // The promise is returned, not swallowed: the connection holds
        // the `log` batch that follows a Welcome until this settles.
        // Failing here is also better than half-joining -- the rejection
        // path discards the held entries rather than applying a replay
        // to a group that was never built.
        const group = await joinFromWelcome(msg.payload, user, cs)

        batch(() => {
            state.group.value = group
            // Adopted from the message, never recomputed. The room
            // stamped both against the log it just sent; deriving them
            // here is how the two drift apart.
            state.cursor.value = msg.cursor
            // Held apart from `cursor`, which moves with every entry
            // applied. The timeline needs the point this client came in
            // at, and that number never changes again.
            state.joinCursor.value = msg.cursor
            state.priorCount.value = msg.priorCount
            state.status.value = 'You were let in.'
        })
    }
})

/**
 * Approving is the creator's, and it is the same path whether a person
 * clicked Approve or the request arrived already pre-approved. Declared
 * after `delivery` because it sends through it; nothing calls into it
 * until a socket message arrives, which is long after this line.
 */
const approvals = createApprovals({
    state,
    lock: groupLock,
    send: (msg) => delivery.send(msg)
})

/** Saying something, declared after `delivery` for the same reason. */
const chat = createChat({
    state,
    lock: groupLock,
    send: (msg) => delivery.send(msg)
})

/**
 * Open the socket for a room. Called once per room, and only once an
 * identity exists -- `onOpen` sends nothing without one, so a socket
 * opened any earlier would identify itself to nobody.
 *
 * A joiner's socket is not a create: it says `hello` and then publishes
 * its request. Getting this backwards would have the room answer
 * `room-exists` and the page wait for a `created` that never comes.
 */
function connect (roomId:string, creatingRoom:boolean):void {
    creating.value = creatingRoom
    state.status.value = creatingRoom ?
        `Opening room ${roomId}...` :
        'Asking to be let in...'

    delivery.connect(roomId)
}

/**
 * Does this room still exist? Asked before a socket, because a socket
 * says nothing useful until there is an identity to say `hello` with,
 * and someone opening an invitation link has no identity yet.
 */
async function probeRoom (roomId:string):Promise<void> {
    const res = await fetch(`/api/room/${roomId}`)

    if (res.status === 404) {
        state.roomMissing.value = true
        return
    }

    if (!res.ok) {
        state.status.value = `Could not reach the room (${res.status}).`
        return
    }

    const info = await res.json() as { expiresAt:number }
    state.expiresAt.value = info.expiresAt
}

function applyRoute (path:string):void {
    const route = routeFromPath(path)

    if (route.kind === 'gone') {
        batch(() => {
            state.roomId.value = null
            state.roomMissing.value = true
        })
        return
    }

    batch(() => {
        state.roomId.value = route.kind === 'room' ? route.roomId : null
        state.roomMissing.value = false
    })

    // Only a visitor arriving at someone else's link needs the probe.
    // The creator already knows the room exists, and asking would race
    // its own create.
    if (route.kind === 'room' && !state.user.value) {
        probeRoom(route.roomId).catch(err => {
            state.status.value = `Could not reach the room: ${err}`
        })
    }
}

const onRoute = Route()
onRoute(path => { applyRoute(path) })

/**
 * Ask the browser to stop evicting this origin's storage. Separate from
 * the persist toggle: one is a preference this page keeps, the other is
 * a request only the browser can answer, and a denial changes nothing
 * about whether the session is written.
 */
async function askForPersistentStorage ():Promise<void> {
    state.persistRequest.value = 'pending'
    const status = await requestPersistentStorage()

    batch(() => {
        state.storage.value = status
        state.persistRequest.value = persistOutcome(status)
    })
}

/**
 * The persist control sits outside the view switch on purpose. It is a
 * standing control: present from the first paint, before there is a user
 * or a room, and never unmounted by a change of view.
 *
 * The explainer is standing for the same reason. What the server is
 * trusted for is as true on the setup form and on the gone view as it
 * is in a room, and copy that appears only once you are already in a
 * group is copy nobody reads before deciding to join one.
 */
function App () {
    return html`
        <div class="page">
        <header class="masthead">
            <p class="wordmark">
                <a href="/">webcrypto-mls</a>
            </p>
            <p class="masthead-sub">Realistic demo</p>
        </header>
        <${CurrentView} />
        <${Persistence}
            persist=${state.persist.value}
            storage=${state.storage.value}
            request=${state.persistRequest.value}
            onToggle=${(on:boolean) => {
                // Not awaited: `setPersist` reports its own failures
                // through the status line and never rejects.
                session.setPersist(on)
            }}
            onRequest=${() => {
                askForPersistentStorage().catch(err => {
                    state.status.value = `Could not ask for storage: ${err}`
                })
            }}
            onReset=${() => { session.reset() }}
        />
        <${Explainer} expiresAt=${state.expiresAt.value} />
        </div>
    `
}

/**
 * Come back as this browser left off, if it was asked to. Everything
 * here is conditional on a stored record existing: with none, the page
 * starts at the setup form exactly as it did before.
 */
async function restoreSession ():Promise<void> {
    const stored = await session.load()
    if (!stored) return

    // Asked before anything is restored, because `restore` writes the
    // stored room id over whatever the URL put there; see
    // `storedRoomIsWanted`. The route rather than `state.roomId`, which
    // is null both for the bare origin and for an id that cannot name a
    // room. Nothing is restored and nothing is deleted: the record stays
    // where it is, and this page is a fresh visitor to the address it was
    // actually asked for.
    if (!storedRoomIsWanted(stored, routeFromPath(location.pathname))) {
        state.status.value =
            'The address in the bar is not the room this browser has a ' +
            'session for, so that session was left alone.'
        return
    }

    // The ciphersuite is never persisted -- it is stateless, and
    // `restoredSessionUser` re-derives `clientConfig` for the same
    // reason.
    const cs = state.ciphersuite.value ?? await initCiphersuite()
    state.ciphersuite.value = cs
    session.restore(stored)

    const roomId = state.roomId.value
    if (!roomId) return

    // The URL is made to agree with the room being rejoined. Someone who
    // opened the bare origin gets the room's own address back, so the
    // link is there to share and a reload lands in the same place.
    if (routeFromPath(location.pathname).kind !== 'room') {
        onRoute.setRoute('/' + roomId)
    }

    // A client that was removed has nothing to catch up on, and a socket
    // saying `hello` would put it back on the roster as though it were
    // still in the room -- which is why `apply-entry.ts` closes the
    // socket when the removal lands. Restoring one must not undo that.
    if (state.removed.value) return

    // Never a create. The room already exists -- this client was in it --
    // so the socket says `hello` with the restored cursor, and the room
    // replays only what was missed. A restored joiner with no group
    // re-publishes its request from the same open hook.
    connect(roomId, false)
}

async function start ():Promise<void> {
    checkPersisted().then(status => {
        state.storage.value = status
    }, () => {
        // A browser with no `navigator.storage` is already reported as
        // 'unsupported' by checkPersisted, so a rejection here is
        // something else entirely and says nothing worth showing.
    })

    try {
        await restoreSession()
    } finally {
        // Started once a restore has settled, so the first thing it
        // writes is the restored record rather than a half-built one --
        // and started even when the restore failed, because a page whose
        // restore threw after `restore` had already turned the preference
        // back on would otherwise show persistence as on and save
        // nothing for the rest of the session.
        session.watch()
    }
}

const root = document.getElementById('root')

if (root) {
    try {
        applyRoute(location.pathname)
        render(html`<${App} />`, root)

        start().catch(err => {
            state.status.value = `Could not restore the session: ${err}`
        })
    } catch (err) {
        // Nothing here may escape module evaluation: an uncaught throw
        // would leave the page blank with the reason only in the
        // console, which is how the other demos already handle it.
        state.status.value = `Could not start: ${err}`
        render(html`<p class="status">${state.status.value}</p>`, root)
    }
}

function isDev ():boolean {
    return !!(import.meta.env.DEV || import.meta.env.MODE !== 'production')
}

function CurrentView () {
    switch (state.view.value) {
        case 'setup':
            return html`<${Setup}
                state=${state}
                connect=${connect}
                navigate=${(path:string) => { onRoute.setRoute(path) }}
            />`

        case 'room':
            return html`<${Room}
                state=${state}
                onApprove=${(request:PendingRequest) => {
                    // Not awaited: `approve` reports its own failures
                    // through the status line and never rejects.
                    approvals.approve(request)
                }}
                onDeny=${(identity:string) => { approvals.deny(identity) }}
                onRemove=${(member:Member) => {
                    // Not awaited, for the same reason `approve` is
                    // not: `remove` reports its own failures through
                    // the status line and never rejects.
                    approvals.remove(member)
                }}
                onSend=${(text:string) => {
                    // Not awaited, for the same reason the three above
                    // are not: `say` never rejects.
                    chat.say(text)
                }}
            />`

        case 'waiting':
            return html`<${Waiting}
                url=${roomUrl(location.origin, state.roomId.value ?? '')}
                name=${state.user.value?.name ?? ''}
                status=${state.status.value}
                persist=${state.persist.value}
            />`

        case 'gone':
            return html`<${Gone}
                onCreateNew=${() => {
                    // The route, not the signal: `applyRoute` clears
                    // `roomMissing` and the room id together, and going
                    // through it is what puts the URL back at the
                    // origin as well. Setting the signal alone would
                    // leave a dead room id in the address bar.
                    onRoute.setRoute('/')
                }}
            />`
    }
}

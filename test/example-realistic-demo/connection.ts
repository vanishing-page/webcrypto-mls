import { test } from '@substrate-system/tapzero'
import type {
    LogEntry,
    RoomMessage
} from '../../example-realistic-demo/protocol.js'
import type { ClientState } from '../../src/index.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import {
    createConnection
} from '../../example-realistic-demo/client/connection.js'
import type {
    DeliveryClient
} from '../../example-realistic-demo/client/delivery-client.js'

/**
 * The same minimal WebSocket that `delivery-client.ts`'s tests install:
 * `createConnection` builds a real delivery client, so node needs a
 * socket for the open hook to have anything to open.
 */
const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

interface FakeSocket {
    url:string
    readyState:number
    sent:string[]
    addEventListener (name:string, fn:(ev:any) => void):void
    send (data:string):void
    close ():void
    opened ():void
    delivers (data:string):void
}

function makeSocket (url:string):FakeSocket {
    const listeners:Record<string, Array<(ev:any) => void>> = {}

    function emit (name:string, ev:any):void {
        for (const fn of listeners[name] ?? []) fn(ev)
    }

    const socket:FakeSocket = {
        url,
        readyState: CONNECTING,
        sent: [],
        addEventListener (name, fn) {
            (listeners[name] = listeners[name] ?? []).push(fn)
        },
        send (data) {
            socket.sent.push(data)
        },
        close () {
            if (socket.readyState > OPEN) return
            socket.readyState = CLOSED
            queueMicrotask(() => { emit('close', {}) })
        },
        opened () {
            socket.readyState = OPEN
            emit('open', {})
        },
        delivers (data) {
            emit('message', { data })
        }
    }

    return socket
}

interface Fakes {
    sockets:FakeSocket[]
    restore ():void
}

function installFakes ():Fakes {
    const g = globalThis as any
    const sockets:FakeSocket[] = []
    const prevSocket = g.WebSocket
    const prevLocation = g.location

    const ctor = function (url:string):FakeSocket {
        const socket = makeSocket(url)
        sockets.push(socket)
        return socket
    }
    ctor.OPEN = OPEN

    g.WebSocket = ctor
    g.location = { protocol: 'https:', host: 'demo.test' }

    return {
        sockets,
        restore () {
            g.WebSocket = prevSocket
            g.location = prevLocation
        }
    }
}

/** A real turn of the event loop, so a queued drain can finish. */
function tick ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function entry (seq:number, kind:LogEntry['kind'] = 'application'):LogEntry {
    return { seq, sender: 'aaa', kind, payload: 'AA==' }
}

function group ():ClientState {
    return {} as unknown as ClientState
}

interface Harness {
    state:RealisticState
    client:DeliveryClient
    fakes:Fakes
    applied:number[]
    control:RoomMessage[]
    socket ():FakeSocket
    /** Deliver a room message down the socket, as the room would. */
    deliver (msg:RoomMessage):void
    sent ():any[]
    stop ():void
}

function harness (opts:{
    identity?:string|null
    isCreating?:boolean
    joinRequest?:string|null
    applyEntry? (e:LogEntry):Promise<void>
    onControl? (msg:RoomMessage):void|Promise<void>
} = {}):Harness {
    const fakes = installFakes()
    const state = createRealisticState()
    const applied:number[] = []
    const control:RoomMessage[] = []

    const client = createConnection({
        state,
        identity: () => (
            opts.identity === undefined ? 'alice-key' : opts.identity
        ),
        isCreating: () => opts.isCreating ?? false,
        joinRequest: () => opts.joinRequest ?? null,
        applyEntry: opts.applyEntry ?? (async (e) => {
            applied.push(e.seq)
        }),
        onControl (msg) {
            control.push(msg)
            return opts.onControl?.(msg)
        }
    })

    function socket ():FakeSocket {
        return fakes.sockets[fakes.sockets.length - 1]
    }

    return {
        state,
        client,
        fakes,
        applied,
        control,
        socket,
        deliver (msg) {
            socket().delivers(JSON.stringify(msg))
        },
        sent () {
            return socket().sent.map(s => JSON.parse(s))
        },
        stop () {
            client.close()
            fakes.restore()
        }
    }
}

// realistic-demo.AC10.4 -- the open hook

test('connection - an open with no identity says nothing', (t) => {
    const h = harness({ identity: null })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        t.deepEqual(h.sent(), [], 'nothing was written')
    } finally {
        h.stop()
    }
})

test('connection - a creating client sends create, not hello', (t) => {
    const h = harness({ isCreating: true })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        t.deepEqual(h.sent(), [{ type: 'create', identity: 'alice-key' }])
    } finally {
        h.stop()
    }
})

test('connection - a joining client says hello from its cursor', (t) => {
    const h = harness()
    try {
        h.state.cursor.value = 7
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        t.deepEqual(h.sent(), [{
            type: 'hello',
            identity: 'alice-key',
            cursor: 7
        }], 'no creatorToken when there is none')

        h.state.creatorToken.value = 'tok'
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        t.deepEqual(h.sent(), [{
            type: 'hello',
            identity: 'alice-key',
            cursor: 7,
            creatorToken: 'tok'
        }], 'the token is carried when there is one')
    } finally {
        h.stop()
    }
})

test('connection - opening clears a stopped queue', async (t) => {
    const h = harness({
        async applyEntry (e) {
            if (e.seq === 1) throw new Error('bad epoch')
        }
    })
    try {
        h.state.group.value = group()
        h.client.queue.push([entry(1, 'commit')])
        await h.client.queue.idle()
        t.equal(h.client.queue.stopped, true, 'the commit stopped it')

        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        t.equal(h.client.queue.stopped, false,
            'the reconnect, not the failure, cleared the stop')
    } finally {
        h.stop()
    }
})

// the dispatcher

test('connection - created records the token and the creator', (t) => {
    const h = harness({ isCreating: true })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        h.deliver({ type: 'created', creatorToken: 'tok', expiresAt: 99 })

        t.equal(h.state.creatorToken.value, 'tok')
        t.equal(h.state.expiresAt.value, 99)
        t.equal(h.state.isCreator.value, true)
    } finally {
        h.stop()
    }
})

test('connection - created clears the notice that opened the room',
    (t) => {
        const h = harness({ isCreating: true })
        try {
            h.client.connect('aB3xK9pQ2m')
            // What `index.ts` writes on its way into the room. The room
            // view renders it beside "Connection: open", so a notice
            // that outlives the create reads as a contradiction.
            h.state.status.value = 'Opening room aB3xK9pQ2m...'
            h.socket().opened()

            t.equal(h.state.status.value, 'Opening room aB3xK9pQ2m...',
                'the notice stands while the create is in flight')

            h.deliver({
                type: 'created',
                creatorToken: 'tok',
                expiresAt: 99
            })

            t.notEqual(h.state.status.value, 'Opening room aB3xK9pQ2m...',
                'the notice does not outlive the room it announced')
            t.equal(h.state.status.value, 'Room created.',
                'and the page says the room is there instead')
        } finally {
            h.stop()
        }
    })

test('connection - room-state reports standing and expiry', (t) => {
    const h = harness()
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        h.deliver({
            type: 'room-state',
            isCreator: true,
            createdAt: 1,
            expiresAt: 42
        })

        t.equal(h.state.isCreator.value, true,
            'the room says this socket holds the creator token')
        t.equal(h.state.expiresAt.value, 42)

        // Both polarities, because `isCreator` starts false: asserting
        // only the false case passes against a handler that never
        // writes it at all.
        h.deliver({
            type: 'room-state',
            isCreator: false,
            createdAt: 1,
            expiresAt: 42
        })

        t.equal(h.state.isCreator.value, false,
            'and a socket with no token is told so')
    } finally {
        h.stop()
    }
})

test('connection - no-room sends the page to the gone view', (t) => {
    const h = harness()
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        t.equal(h.state.view.value, 'setup')

        h.deliver({ type: 'no-room' })
        t.equal(h.state.roomMissing.value, true)
        t.equal(h.state.view.value, 'gone')
    } finally {
        h.stop()
    }
})

test('connection - roster, pending and error reach the state', (t) => {
    const h = harness()
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()

        h.deliver({ type: 'roster', live: ['a', 'b'] })
        t.deepEqual(h.state.live.value, ['a', 'b'])

        h.deliver({ type: 'pending', requests: [] })
        t.deepEqual(h.state.pending.value, [])

        h.deliver({ type: 'error', reason: 'not-member' })
        t.notEqual(h.state.status.value, 'Ready',
            'a refusal is shown, not swallowed')
    } finally {
        h.stop()
    }
})

test('connection - every message is offered to the page exactly once',
    async (t) => {
        const h = harness()
        try {
            h.state.group.value = group()
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({ type: 'roster', live: [] })
            h.deliver({ type: 'entry', entry: entry(1) })
            h.deliver({ type: 'error', reason: 'bad-message' })
            await h.client.queue.idle()

            t.deepEqual(h.control.map(m => m.type),
                ['roster', 'entry', 'error'])
        } finally {
            h.stop()
        }
    })

test('connection - a failing control handler is reported, not lost',
    async (t) => {
        const h = harness({
            async onControl (msg) {
                if (msg.type === 'pending') throw new Error('nope')
            }
        })
        try {
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()
            h.deliver({ type: 'pending', requests: [] })
            await tick()

            t.notEqual(h.state.status.value, 'Ready',
                'the failure surfaced in the status line')
        } finally {
            h.stop()
        }
    })

// the cursor -- realistic-demo.AC9

test('connection - a log batch applies in order and moves the cursor',
    async (t) => {
        const h = harness()
        try {
            h.state.group.value = group()
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({
                type: 'log',
                entries: [entry(1), entry(2), entry(3)]
            })
            await h.client.queue.idle()

            t.deepEqual(h.applied, [1, 2, 3])
            t.equal(h.state.cursor.value, 3)
        } finally {
            h.stop()
        }
    })

test('connection - a live entry after a batch keeps the order',
    async (t) => {
        const h = harness()
        try {
            h.state.group.value = group()
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({ type: 'log', entries: [entry(1), entry(2)] })
            h.deliver({ type: 'entry', entry: entry(3) })
            await h.client.queue.idle()

            t.deepEqual(h.applied, [1, 2, 3])
        } finally {
            h.stop()
        }
    })

test('connection - an entry already applied is skipped, not re-applied',
    async (t) => {
        const h = harness()
        try {
            h.state.group.value = group()
            h.state.cursor.value = 2
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({
                type: 'log',
                entries: [entry(1), entry(2), entry(3)]
            })
            await h.client.queue.idle()

            t.deepEqual(h.applied, [3], 'only the unseen one applied')
            t.equal(h.state.cursor.value, 3)
        } finally {
            h.stop()
        }
    })

test('connection - a gap stops rather than stranding the missing entry',
    async (t) => {
        const h = harness()
        try {
            h.state.group.value = group()
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({
                type: 'log',
                entries: [entry(1), entry(3, 'commit')]
            })
            await h.client.queue.idle()

            t.deepEqual(h.applied, [1], 'the entry past the gap was not applied')
            t.equal(h.state.cursor.value, 1, 'the cursor stayed behind it')
            t.equal(h.client.queue.stopped, true)
        } finally {
            h.stop()
        }
    })

test('connection - an entry that fails to apply does not move the cursor',
    async (t) => {
        const h = harness({
            async applyEntry (e) {
                if (e.seq === 1) throw new Error('bad epoch')
            }
        })
        try {
            h.state.group.value = group()
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({ type: 'entry', entry: entry(1, 'commit') })
            await h.client.queue.idle()

            t.equal(h.state.cursor.value, 0)
        } finally {
            h.stop()
        }
    })

// the offline joiner -- entries held across an async join

test('connection - entries arriving during a join are held, then applied',
    async (t) => {
        let letJoinFinish = ():void => {}
        const joined = new Promise<void>(resolve => {
            letJoinFinish = resolve
        })
        const h = harness({
            onControl (msg) {
                if (msg.type !== 'welcome-you') return
                return joined.then(() => {
                    h.state.group.value = group()
                })
            }
        })
        try {
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({
                type: 'welcome-you',
                payload: 'AA==',
                cursor: 0,
                priorCount: 0
            })
            h.deliver({ type: 'log', entries: [entry(1), entry(2)] })
            await tick()

            t.deepEqual(h.applied, [],
                'nothing applied while the join is in flight')

            letJoinFinish()
            await tick()
            await h.client.queue.idle()

            t.deepEqual(h.applied, [1, 2],
                'the held batch was flushed once the group existed')
            t.equal(h.state.cursor.value, 2)
        } finally {
            h.stop()
        }
    })

test('connection - a failed join discards the held entries', async (t) => {
    let failJoin = ():void => {}
    const failed = new Promise<void>((_resolve, reject) => {
        failJoin = () => { reject(new Error('no key')) }
    })
    try {
        const h = harness({
            onControl (msg) {
                if (msg.type !== 'welcome-you') return
                return failed
            }
        })
        try {
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({
                type: 'welcome-you',
                payload: 'AA==',
                cursor: 0,
                priorCount: 0
            })
            h.deliver({ type: 'log', entries: [entry(1)] })
            await tick()

            failJoin()
            await tick()
            await h.client.queue.idle()

            t.deepEqual(h.applied, [],
                'nothing was applied to a group that never existed')
            t.notEqual(h.state.status.value, 'Ready',
                'the person is told the invitation did not work')
        } finally {
            h.stop()
        }
    } finally {
        failed.catch(() => {})
    }
})

test('connection - entries before any group and no join are dropped',
    async (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            h.socket().opened()

            h.deliver({ type: 'entry', entry: entry(1, 'commit') })
            await h.client.queue.idle()

            t.deepEqual(h.applied, [], 'nothing to apply it to')
            t.equal(h.state.cursor.value, 0,
                'and the cursor did not move, so the replay re-delivers it')
        } finally {
            h.stop()
        }
    })

// realistic-demo.AC3.1 -- the request is published from the open hook

test('connection - a joiner follows hello with a join-request', (t) => {
    const h = harness({ joinRequest: 'kp-b64' })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()

        t.deepEqual(h.sent(), [
            { type: 'hello', identity: 'alice-key', cursor: 0 },
            {
                type: 'join-request',
                identity: 'alice-key',
                keyPackage: 'kp-b64'
            }
        ], 'hello first, then the request, under the same identity')
    } finally {
        h.stop()
    }
})

test('connection - a member publishes no join-request', (t) => {
    const h = harness({ joinRequest: null })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()

        t.deepEqual(h.sent(), [
            { type: 'hello', identity: 'alice-key', cursor: 0 }
        ], 'a client already in the group asks for nothing')
    } finally {
        h.stop()
    }
})

test('connection - a creating client publishes no join-request', (t) => {
    const h = harness({ isCreating: true, joinRequest: 'kp-b64' })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()

        t.deepEqual(h.sent(), [
            { type: 'create', identity: 'alice-key' }
        ], 'the creator of a room never asks to join it')
    } finally {
        h.stop()
    }
})

test('connection - the request is re-published on a reconnect', (t) => {
    const h = harness({ joinRequest: 'kp-b64' })
    try {
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()
        const first = h.socket()

        // A reconnected socket carries no attachment, so the request
        // has to be made again. The room keys `pending` by identity, so
        // this replaces rather than duplicates.
        h.client.connect('aB3xK9pQ2m')
        h.socket().opened()

        t.ok(h.socket() !== first, 'should be a second socket')
        t.deepEqual(
            h.sent().map(m => m.type),
            ['hello', 'join-request'],
            'the second socket asks again'
        )
    } finally {
        h.stop()
    }
})

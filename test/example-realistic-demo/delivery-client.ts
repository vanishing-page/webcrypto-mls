import { test } from '@substrate-system/tapzero'
import type {
    LogEntry,
    RoomMessage
} from '../../example-realistic-demo/protocol.js'
import {
    RECONNECT_BASE_MS
} from '../../example-realistic-demo/client/delivery-cursor.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import {
    createDeliveryClient,
    socketUrl,
    type DeliveryClient
} from '../../example-realistic-demo/client/delivery-client.js'

/**
 * `delivery-client.ts` is the only module in the client that touches a
 * socket, so node has to be given one. This is the whole of the
 * WebSocket surface the module uses: a constructor, `readyState` with
 * the OPEN constant, `addEventListener`, `send` and `close`.
 *
 * `close()` fires its event from a microtask rather than synchronously,
 * because that asynchrony is load bearing: `connect()` closes the
 * previous socket *before* it adopts the new one, and the retired
 * socket's listeners are what decide not to reconnect.
 */
const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

interface FakeSocket {
    url:string
    readyState:number
    sent:string[]
    addEventListener (name:string, fn:(ev:any) => void):void
    send (data:string):void
    close ():void

    // the test's side of the socket
    opened ():void
    delivers (data:string):void
    dropped ():void
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
            socket.readyState = CLOSING
            queueMicrotask(() => {
                socket.readyState = CLOSED
                emit('close', {})
            })
        },
        opened () {
            socket.readyState = OPEN
            emit('open', {})
        },
        delivers (data) {
            emit('message', { data })
        },
        dropped () {
            socket.readyState = CLOSED
            emit('close', {})
        }
    }

    return socket
}

interface Fakes {
    sockets:FakeSocket[]
    restore ():void
}

function installFakes (protocol = 'https:', host = 'demo.test'):Fakes {
    const g = globalThis as any
    const sockets:FakeSocket[] = []
    const prevSocket = g.WebSocket
    const prevLocation = g.location

    // `new` on a function that returns an object yields that object,
    // which is all `createDeliveryClient` asks of the constructor.
    // `OPEN` is read off the constructor by the keepalive.
    const ctor = function (url:string):FakeSocket {
        const socket = makeSocket(url)
        sockets.push(socket)
        return socket
    }
    ctor.OPEN = OPEN

    g.WebSocket = ctor
    g.location = { protocol, host }

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

/**
 * Poll until `ok()` holds, or give up and report that it never did.
 *
 * The reconnect runs off a real `setTimeout`, so its timing is the one
 * thing these tests cannot assert directly. Polling asserts the outcome
 * instead, and a false return is a genuine failure rather than a
 * timeout that silently passes.
 */
async function waitFor (ok:() => boolean, ms:number):Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (ok()) return true
        await tick()
    }
    return ok()
}

function entry (seq:number, kind:LogEntry['kind']):LogEntry {
    return { seq, sender: 'aaa', kind, payload: 'AA==' }
}

interface Harness {
    state:RealisticState
    client:DeliveryClient
    seen:RoomMessage[]
    opens:boolean[]
    fakes:Fakes
}

function harness (opts:{
    protocol?:string
    applyEntry? (e:LogEntry):Promise<void>
} = {}):Harness {
    const fakes = installFakes(opts.protocol)
    const state = createRealisticState()
    const seen:RoomMessage[] = []
    const opens:boolean[] = []
    const client = createDeliveryClient({
        state,
        applyEntry: opts.applyEntry ?? (async () => {}),
        onRoomMessage (msg) {
            seen.push(msg)
        },
        onOpen (isReconnect) {
            opens.push(isReconnect)
        }
    })

    return { state, client, seen, opens, fakes }
}

// realistic-demo.AC1.2

test('delivery-client - the socket url comes from where the page loaded',
    (t) => {
        const fakes = installFakes('https:', 'demo.test')
        try {
            t.equal(socketUrl('aB3xK9pQ2m'),
                'wss://demo.test/api/room/aB3xK9pQ2m/ws')
        } finally {
            fakes.restore()
        }
    })

test('delivery-client - a plain-http page gets a ws socket', (t) => {
    const fakes = installFakes('http:', 'localhost:8787')
    try {
        t.equal(socketUrl('aB3xK9pQ2m'),
            'ws://localhost:8787/api/room/aB3xK9pQ2m/ws')
    } finally {
        fakes.restore()
    }
})

test('delivery-client - connecting opens one socket and reports it',
    (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            t.equal(h.fakes.sockets.length, 1, 'one socket')
            t.equal(h.fakes.sockets[0].url,
                'wss://demo.test/api/room/aB3xK9pQ2m/ws')
            t.equal(h.state.connection.value, 'connecting')

            h.fakes.sockets[0].opened()
            t.equal(h.state.connection.value, 'open')
            t.deepEqual(h.opens, [false],
                'the open hook ran once, not as a reconnect')
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

test('delivery-client - a send before the socket opens is refused', (t) => {
    const h = harness()
    try {
        t.equal(h.client.send({ type: 'create', identity: 'aaa' }), false,
            'refused with no socket at all')

        h.client.connect('aB3xK9pQ2m')
        t.equal(h.client.send({ type: 'create', identity: 'aaa' }), false,
            'refused while still connecting')
        t.equal(h.fakes.sockets[0].sent.length, 0, 'nothing was written')

        h.fakes.sockets[0].opened()
        t.equal(h.client.send({ type: 'create', identity: 'aaa' }), true)
        t.deepEqual(
            JSON.parse(h.fakes.sockets[0].sent[0]),
            { type: 'create', identity: 'aaa' }
        )
    } finally {
        h.client.close()
        h.fakes.restore()
    }
})

test('delivery-client - only well-formed room messages are dispatched',
    (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            const socket = h.fakes.sockets[0]
            socket.opened()

            socket.delivers('pong')
            socket.delivers('not json at all')
            socket.delivers(JSON.stringify({ type: 'nonsense' }))
            t.equal(h.seen.length, 0, 'none of those were dispatched')

            socket.delivers(JSON.stringify({ type: 'roster', live: ['a'] }))
            t.deepEqual(h.seen, [{ type: 'roster', live: ['a'] }])
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

test('delivery-client - a drop we did not ask for reconnects', (t) => {
    const h = harness()
    try {
        h.client.connect('aB3xK9pQ2m')
        h.fakes.sockets[0].opened()
        h.fakes.sockets[0].dropped()

        t.equal(h.state.connection.value, 'reconnecting')
        t.notEqual(h.state.status.value, 'Ready',
            'the person is told the connection went')
    } finally {
        // also cancels the pending reconnect timer
        h.client.close()
        h.fakes.restore()
    }
})

test('delivery-client - closing on purpose does not reconnect', async (t) => {
    const h = harness()
    try {
        h.client.connect('aB3xK9pQ2m')
        h.fakes.sockets[0].opened()
        h.client.close()
        await tick()

        t.equal(h.state.connection.value, 'closed')
        t.equal(h.fakes.sockets.length, 1, 'no replacement was opened')
    } finally {
        h.fakes.restore()
    }
})

test('delivery-client - a reconnect says so on the open hook',
    async (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            h.fakes.sockets[0].opened()
            h.fakes.sockets[0].dropped()

            const again = await waitFor(
                () => h.fakes.sockets.length === 2,
                RECONNECT_BASE_MS * 8
            )
            t.equal(again, true, 'a second socket was opened')
            t.equal(h.state.connection.value, 'reconnecting',
                'reported as a reconnect, not as a first connect')

            h.fakes.sockets[1].opened()
            t.deepEqual(h.opens, [false, true],
                'the second open hook knows it is a reconnect')
            t.equal(h.state.connection.value, 'open')
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

test('delivery-client - a reconnect clears the lost-connection notice',
    async (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            h.fakes.sockets[0].opened()
            h.fakes.sockets[0].dropped()

            const again = await waitFor(
                () => h.fakes.sockets.length === 2,
                RECONNECT_BASE_MS * 8
            )
            t.equal(again, true, 'a second socket was opened')
            // Both polarities: the notice has to be there while the
            // socket is down for its absence afterwards to mean
            // anything.
            t.equal(h.state.status.value,
                'Connection lost. Reconnecting...',
                'the drop is announced while the socket is down')

            h.fakes.sockets[1].opened()
            t.equal(h.state.connection.value, 'open')
            t.notEqual(h.state.status.value,
                'Connection lost. Reconnecting...',
                'the notice does not outlive the reconnect it describes')
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

test('delivery-client - closing cancels a pending reconnect', async (t) => {
    const h = harness()
    try {
        h.client.connect('aB3xK9pQ2m')
        h.fakes.sockets[0].opened()
        h.fakes.sockets[0].dropped()
        t.equal(h.state.connection.value, 'reconnecting',
            'a reconnect is pending')

        h.client.close()
        // this one waits out its whole deadline by design, so it is the
        // shorter of the two -- still four times the real backoff
        const again = await waitFor(
            () => h.fakes.sockets.length > 1,
            RECONNECT_BASE_MS * 4
        )
        t.equal(again, false, 'the pending reconnect never ran')
    } finally {
        h.fakes.restore()
    }
})

test('delivery-client - a retired socket closing changes nothing',
    async (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            h.fakes.sockets[0].opened()

            // reconnect by hand; the first socket is closed by connect()
            // and its close event lands a microtask later
            h.client.connect('aB3xK9pQ2m')
            t.equal(h.fakes.sockets.length, 2, 'a second socket')
            t.ok(h.fakes.sockets[0].readyState > OPEN,
                'the replaced socket was closed, not left open')
            h.fakes.sockets[1].opened()
            await tick()

            t.equal(h.state.connection.value, 'open',
                'the retired socket did not report a reconnect')
            t.equal(h.fakes.sockets.length, 2,
                'and did not schedule another connect')
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

// realistic-demo.AC6.4

test('delivery-client - an entry that will not decrypt advances the cursor',
    async (t) => {
        const applied:number[] = []
        const h = harness({
            async applyEntry (e) {
                if (e.seq < 3) throw new Error('no key for that epoch')
                applied.push(e.seq)
            }
        })
        try {
            h.client.queue.push([
                entry(1, 'application'),
                entry(2, 'application'),
                entry(3, 'application')
            ])
            await h.client.queue.idle()

            // a run of them is traversable: the second could not have
            // advanced the cursor unless the first had already moved it
            t.equal(h.state.cursor.value, 2,
                'both undecryptable entries moved the cursor')
            t.deepEqual(applied, [3], 'the entry after them still applied')
            t.equal(h.client.queue.stopped, false)
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

test('delivery-client - a commit that will not process stops the queue',
    async (t) => {
        const applied:number[] = []
        const h = harness({
            async applyEntry (e) {
                if (e.seq === 1) throw new Error('bad epoch')
                applied.push(e.seq)
            }
        })
        try {
            h.client.queue.push([
                entry(1, 'commit'),
                entry(2, 'application')
            ])
            await h.client.queue.idle()

            t.equal(h.client.queue.stopped, true)
            t.deepEqual(applied, [], 'nothing after the commit was applied')
            t.equal(h.state.cursor.value, 0,
                'the cursor did not move past the commit')
            t.notEqual(h.state.status.value, 'Ready',
                'the person is told to resynchronise')
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

test('delivery-client - closing during a pending reconnect says closed',
    async (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            h.fakes.sockets[0].opened()
            h.fakes.sockets[0].dropped()
            t.equal(h.state.connection.value, 'reconnecting',
                'a reconnect is pending')

            h.client.close()
            // The socket is already gone, so there is no second close
            // event coming. Waiting for one leaves the room view
            // reading "Connection: reconnecting" for the life of the
            // page, next to nothing that is reconnecting.
            await tick()
            t.equal(h.state.connection.value, 'closed',
                'a deliberate close is reported even with no socket')
        } finally {
            h.fakes.restore()
        }
    })

test('delivery-client - connecting cancels a pending reconnect',
    async (t) => {
        const h = harness()
        try {
            h.client.connect('aB3xK9pQ2m')
            h.fakes.sockets[0].opened()
            h.fakes.sockets[0].dropped()
            t.equal(h.state.connection.value, 'reconnecting',
                'a reconnect is pending')

            // The caller opens the socket by hand before the timer
            // fires. The scheduled attempt is now redundant: left
            // running it would replace this perfectly good socket with
            // another one, and the room would close one of the two.
            h.client.connect('aB3xK9pQ2m')
            t.equal(h.fakes.sockets.length, 2, 'the manual socket')
            h.fakes.sockets[1].opened()

            const third = await waitFor(
                () => h.fakes.sockets.length > 2,
                RECONNECT_BASE_MS * 4
            )
            t.equal(third, false, 'the stale timer opened nothing')
            t.equal(h.state.connection.value, 'open')
        } finally {
            h.client.close()
            h.fakes.restore()
        }
    })

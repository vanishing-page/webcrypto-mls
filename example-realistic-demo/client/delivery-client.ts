import { batch } from '@preact/signals'
import {
    isRoomMessage,
    type ClientMessage,
    type LogEntry,
    type RoomMessage
} from '../protocol.js'
import { advanceCursor, reconnectDelay } from './delivery-cursor.js'
import { createEntryQueue, type EntryQueue } from './entry-queue.js'
import { isMalformedEntry } from './malformed-entry.js'
import type { RealisticState } from './state.js'

/**
 * The socket is same-origin and derived from where the page was loaded
 * from. There is no configured endpoint and no build-time origin
 * variable -- that is the entire reason one Worker serves both the page
 * and the delivery service.
 */
export function socketUrl (roomId:string):string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${location.host}/api/room/${roomId}/ws`
}

export interface DeliveryClient {
    connect (roomId:string):void
    send (msg:ClientMessage):boolean
    close ():void
    readonly queue:EntryQueue<LogEntry>
}

export interface DeliveryOptions {
    state:RealisticState
    applyEntry (entry:LogEntry):Promise<void>
    onRoomMessage (msg:RoomMessage):void

    /**
     * Called once each time the socket opens, including after every
     * reconnect. The caller sends `hello` or `create` from here.
     *
     * This hook is not optional decoration. `connect()` returns as soon
     * as the WebSocket is constructed, while `readyState` is still
     * CONNECTING, so anything sent immediately after it is dropped by
     * `send()`. And a reconnected socket carries no `serializeAttachment`
     * until it says `hello` again, so without this the room answers
     * `bad-message` to everything and never replays.
     */
    onOpen (isReconnect:boolean):void
}

export function createDeliveryClient (
    opts:DeliveryOptions
):DeliveryClient {
    const { state } = opts
    let ws:WebSocket|null = null
    let attempt = 0
    let closedByUs = false
    let timer:ReturnType<typeof setTimeout>|null = null
    let keepalive:ReturnType<typeof setInterval>|null = null

    const queue = createEntryQueue<LogEntry>({
        apply: opts.applyEntry,
        onError (err, entry) {
            // Not an MLS message at all, whatever its sender called it.
            // `kind` is asserted by the sender and the room cannot check
            // it, so treating this as a failed commit would let one line
            // of garbage stop every member's queue at the same seq
            // forever -- the reconnect replays from the same cursor and
            // fails on the same entry. Skipping it costs nothing: no
            // group state moved, because none could.
            if (isMalformedEntry(err)) {
                batch(() => {
                    state.status.value =
                        'Skipped an entry that is not a group message.'
                    state.cursor.value = advanceCursor(
                        state.cursor.value,
                        entry.seq
                    )
                })
                return 'continue'
            }

            // A commit that will not process is fatal for group state.
            // Advancing past it would corrupt the epoch silently, so
            // stop and say so.
            if (entry.kind === 'commit') {
                state.status.value =
                    'Could not process a group change. Reload to ' +
                    'resynchronise.'
                return 'stop'
            }

            // An application message that will not decrypt is ordinary
            // forward secrecy, not an error. Count it and keep going.
            //
            // This advance is required, not incidental. Leaving the
            // cursor behind here would make every following entry
            // report a gap, and a run of undecryptable entries could
            // never be traversed -- which is exactly what AC6.4 asks
            // for. This is the second and only other place the cursor
            // moves; see connection.ts for the success path.
            state.cursor.value = advanceCursor(
                state.cursor.value,
                entry.seq
            )
            return 'continue'
        }
    })

    function connect (roomId:string):void {
        // Never leave a previous socket open. connect() is called on
        // first use and on every reconnect, and two live sockets for
        // one identity would make the room close one of them anyway.
        //
        // No flag is set around this. The old socket's close event
        // fires asynchronously, by which time any shared flag would
        // have been reset -- the listeners below identify their own
        // socket instead.
        if (ws) ws.close()

        // A reconnect already scheduled is now redundant -- this call is
        // opening the socket it was going to open. Left running it fires
        // later and replaces a perfectly good socket with another one,
        // and the room closes one of the two identities anyway.
        cancelReconnect()

        closedByUs = false
        stopKeepalive()
        state.connection.value = attempt === 0 ?
            'connecting' :
            'reconnecting'

        const socket = new WebSocket(socketUrl(roomId))
        ws = socket

        socket.addEventListener('open', () => {
            // A socket that is no longer the current one has been
            // retired by a later connect(). Ignore it entirely.
            if (socket !== ws) return

            const isReconnect = attempt > 0
            attempt = 0
            batch(() => {
                state.connection.value = 'open'
                // The notice written on the drop would otherwise
                // outlive the drop, leaving the page reading
                // "Connection: open" and "Connection lost" at once.
                if (isReconnect) state.status.value = 'Reconnected.'
            })
            startKeepalive(socket)
            // Identity is re-established here, every time. Nothing else
            // may be sent before this.
            opts.onOpen(isReconnect)
        })

        socket.addEventListener('message', ev => {
            const data = String(ev.data)

            // The room's auto-response to a keepalive. Not a
            // RoomMessage and not JSON.
            if (data === 'pong') return

            let parsed:unknown
            try {
                parsed = JSON.parse(data)
            } catch (_err) {
                return
            }
            if (!isRoomMessage(parsed)) return
            opts.onRoomMessage(parsed)
        })

        socket.addEventListener('close', () => {
            // A retired socket closing is expected and must not
            // schedule anything -- otherwise replacing a socket would
            // trigger a reconnect that replaces it again, forever.
            if (socket !== ws) return

            if (closedByUs) {
                state.connection.value = 'closed'
                return
            }
            scheduleReconnect(roomId)
        })

        socket.addEventListener('error', () => {
            // 'close' always follows, so reconnection is handled there.
            socket.close()
        })
    }

    /**
     * The room configures an auto-response pair so a keepalive is
     * answered without waking the Durable Object. Sending one
     * periodically is what makes that configuration do anything, and it
     * keeps intermediaries from closing an idle socket.
     *
     * The literal must be exactly 'ping' -- it is matched against the
     * WebSocketRequestResponsePair the room registered.
     */
    function stopKeepalive ():void {
        if (keepalive === null) return
        clearInterval(keepalive)
        keepalive = null
    }

    function startKeepalive (socket:WebSocket):void {
        // Only one ever runs. Without clearing the previous one first,
        // each reconnect would leave another interval alive.
        stopKeepalive()
        keepalive = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN) {
                stopKeepalive()
                return
            }
            socket.send('ping')
        }, 30_000)
    }

    function cancelReconnect ():void {
        if (timer === null) return
        clearTimeout(timer)
        timer = null
    }

    function scheduleReconnect (roomId:string):void {
        const delay = reconnectDelay(attempt)
        attempt = attempt + 1

        batch(() => {
            state.connection.value = 'reconnecting'
            state.status.value = 'Connection lost. Reconnecting...'
        })

        timer = setTimeout(() => connect(roomId), delay)
    }

    return {
        connect,
        send (msg:ClientMessage):boolean {
            // A send while disconnected is reported, never silently
            // dropped -- the caller decides what to tell the person.
            if (!ws || ws.readyState !== WebSocket.OPEN) return false
            ws.send(JSON.stringify(msg))
            return true
        },
        close ():void {
            closedByUs = true
            cancelReconnect()
            stopKeepalive()
            // Said here rather than left to the close event. When a
            // reconnect is pending the socket has already gone, so no
            // second close is coming and the page would read
            // "Connection: reconnecting" for good, next to nothing that
            // is reconnecting. The event path sets the same value.
            state.connection.value = 'closed'
            ws?.close()
        },
        queue
    }
}

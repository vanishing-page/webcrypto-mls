import { batch } from '@preact/signals'
import type { LogEntry, RoomMessage } from '../protocol.js'
import { advanceCursor, entryPosition } from './delivery-cursor.js'
import {
    createDeliveryClient,
    type DeliveryClient,
    type PageOrigin
} from './delivery-client.js'
import type { RealisticState } from './state.js'

/**
 * The one place an inbound `RoomMessage` becomes something the page can
 * see: the dispatcher, the open hook that re-establishes identity, and
 * the cursor's success path. Phases 7 and 8 extend `applyEntry` and
 * `onControl` rather than this switch.
 */
export interface ConnectionDeps {
    state:RealisticState

    /** What this client will call itself in `hello` / `create`. */
    identity ():string|null

    /** True when this client is creating the room, not joining it. */
    isCreating ():boolean

    /**
     * The encoded key package to publish as a join request, or null
     * when this client is not asking to be let in -- it is already in
     * the group, or it has no key package yet.
     *
     * A string rather than the message: the decision of whether to ask
     * belongs to the page, and the shape of the asking belongs here.
     */
    joinRequest ():string|null

    /**
     * Sign the room's challenge for this socket with the leaf signature
     * key -- `proveIdentity` in `mls-actions.ts`, with the room id bound
     * in. The room checks it with `verifyIdentityProof`.
     */
    prove (challenge:string):Promise<string>

    /** Apply one entry to group state. Phases 7 and 8 extend this. */
    applyEntry (entry:LogEntry):Promise<void>

    /**
     * Handle a control message. Phases 7 and 8 extend this.
     *
     * May return a promise, and for `welcome-you` it must: joining from
     * a Welcome is async, and the connection has to know when the group
     * exists before it can apply anything to it.
     */
    onControl (msg:RoomMessage):void|Promise<void>

    /**
     * Where the page was loaded from, passed straight through to the
     * delivery client. Defaults to the real `location`; see `socketUrl`
     * for why it can be overridden.
     */
    page?:PageOrigin
}

export function createConnection (deps:ConnectionDeps):DeliveryClient {
    const { state } = deps

    // A `welcome-you` is followed immediately by the `log` batch, but
    // joining from the Welcome is async -- HPKE decryption, several
    // turns of the event loop. The batch would otherwise arrive while
    // `state.group` is still null and be thrown away, which is exactly
    // the offline-joiner case the demo exists to show. So entries are
    // held from the moment a Welcome arrives until the join resolves.
    let joinPending = false
    const held:LogEntry[] = []

    function pushEntries (entries:LogEntry[]):void {
        if (state.group.value) {
            delivery.queue.push(entries)
        } else if (joinPending) {
            held.push(...entries)
        }

        // Anything reaching neither branch has no group and no Welcome
        // in flight, and is dropped. That is a client waiting for
        // approval: the creator sends `mls{commit}` before `welcome`,
        // so the Add commit arrives before there is anything to apply
        // it to. Dropping is safe -- the replay that follows
        // `welcome-you` re-delivers it.
    }

    // The challenge most recently issued. Signing is async, so a socket
    // can be replaced while a proof is being made; a proof for a retired
    // socket's challenge would only be refused by the new one.
    let challenge:string|null = null

    /**
     * Everything the client says on a fresh socket, in order, once the
     * room's challenge has arrived -- so it is re-sent on every
     * reconnect, because every socket is issued a challenge of its own.
     */
    async function introduce (issued:string):Promise<void> {
        challenge = issued
        const identity = deps.identity()
        if (!identity) return

        let proof:string
        try {
            proof = await deps.prove(issued)
        } catch (err) {
            state.status.value = `Could not prove this identity: ${err}`
            return
        }
        if (challenge !== issued) return

        // `isCreating` stays true until `created` actually arrives, so a
        // socket that drops mid-creation retries the create rather than
        // sending `hello` to a room that was never made and getting
        // `no-room`.
        if (deps.isCreating()) {
            delivery.send({ type: 'create', identity, proof })
            return
        }

        // Resume from the stored cursor so the room replays only what
        // was missed.
        delivery.send({
            type: 'hello',
            identity,
            cursor: state.cursor.value,
            creatorToken: state.creatorToken.value ?? undefined,
            proof
        })

        // The request follows `hello` rather than replacing it: the room
        // attaches the socket to an identity on `hello`, and a request
        // from an unattached socket has nobody to answer.
        //
        // It is re-published on every socket, which is what makes it
        // survive a reconnect. The room keys `pending` by identity, so
        // re-publishing replaces rather than duplicates.
        const keyPackage = deps.joinRequest()

        if (keyPackage) {
            delivery.send({ type: 'join-request', identity, keyPackage })
        }
    }

    const delivery = createDeliveryClient({
        state,
        page: deps.page,

        /**
         * Runs on the first open and on every reconnect. Nothing is said
         * here: the room issues each socket a challenge as soon as it is
         * accepted, and `create` or `hello` has to carry a proof over
         * it. See `introduce`, which the `challenge` message runs.
         */
        onOpen (_isReconnect:boolean):void {
            // A stop from a previous connection is cleared here, not on
            // the failure itself. The replay about to arrive re-delivers
            // from the last good cursor, so this is the one moment the
            // queue can safely accept entries again. Without it a single
            // fatal entry kills the client permanently.
            delivery.queue.reset()

            // A new socket has not been challenged yet; a proof still
            // being made for the last one must not be sent on this one.
            challenge = null
        },

        /**
         * Every entry goes through the queue, never straight to
         * applyEntry -- that is what keeps a live `entry` from
         * interleaving with a `log` batch.
         */
        async applyEntry (entry:LogEntry):Promise<void> {
            const position = entryPosition(state.cursor.value, entry)

            // Already applied. Happens whenever a replay overlaps what
            // was seen live.
            if (position === 'seen') return

            if (position === 'gap') {
                // Something was lost. Advancing would strand it
                // permanently, so stop and let the reconnect replay
                // from the last good cursor instead.
                throw new Error(
                    `gap before seq ${entry.seq}; ` +
                    `cursor is ${state.cursor.value}`
                )
            }

            await deps.applyEntry(entry)

            // Advanced only after a successful apply, and only by one.
            state.cursor.value = advanceCursor(
                state.cursor.value,
                entry.seq
            )
        },

        onRoomMessage (msg:RoomMessage):void {
            switch (msg.type) {
                case 'challenge':
                    introduce(msg.challenge).catch(err => {
                        state.status.value =
                            `Could not introduce this client: ${err}`
                    })
                    break

                case 'created':
                    batch(() => {
                        state.creatorToken.value = msg.creatorToken
                        state.expiresAt.value = msg.expiresAt
                        state.isCreator.value = true
                        // `index.ts` wrote "Opening room ..." on the way
                        // in, and nothing else ever clears it. The room
                        // view renders it beside the connection state,
                        // so leaving it up means the page reads
                        // "Connection: open" and "Opening room ..." at
                        // the same time, for good.
                        state.status.value = 'Room created.'
                    })
                    break

                case 'room-state':
                    batch(() => {
                        state.isCreator.value = msg.isCreator
                        state.expiresAt.value = msg.expiresAt
                    })
                    break

                case 'no-room':
                    state.roomMissing.value = true
                    break

                case 'log':
                    // One push, so the whole batch drains before
                    // anything pushed after it.
                    pushEntries(msg.entries)

                    // The replay comes in pages that fit a frame. Ask
                    // for the next from the last seq this page carried,
                    // not from the cursor: the queue may not have
                    // applied the page yet, and the room answers from
                    // whatever cursor it is given.
                    if (msg.more) {
                        const last = msg.entries[msg.entries.length - 1]
                        if (last) {
                            delivery.send({
                                type: 'replay',
                                cursor: last.seq
                            })
                        }
                    }
                    break

                case 'entry':
                    pushEntries([msg.entry])
                    break

                case 'welcome-you':
                    // Set before onControl runs, so the `log` message
                    // arriving next is held rather than dropped.
                    joinPending = true
                    break

                case 'roster':
                    state.live.value = msg.live
                    break

                case 'pending':
                    state.pending.value = msg.requests
                    break

                case 'error':
                    state.status.value =
                        `Server rejected that: ${msg.reason}`
                    break
            }

            // Every message is then offered to the page. Phases 7 and 8
            // hook onto specific ones -- `welcome-you` for joining,
            // `pending` for the approval prompt -- without
            // re-implementing this switch. Exactly one call, so a
            // handler never runs twice.
            const handled = deps.onControl(msg)

            if (msg.type !== 'welcome-you') {
                // The handler is async for every message type, not just
                // welcome-you -- `pending` runs the pre-approved
                // auto-commit inside it. An unobserved rejection there
                // would fail realistic-demo.AC4.2 silently, showing the
                // creator nothing but an unhandled-rejection warning in
                // the console.
                Promise.resolve(handled).catch(err => {
                    state.status.value =
                        `Something failed handling ${msg.type}: ${err}`
                })
                return
            }

            // The group now exists (or the join failed). Either way the
            // hold is over.
            Promise.resolve(handled).then(
                () => {
                    joinPending = false
                    const queued = held.splice(0)
                    if (queued.length > 0) delivery.queue.push(queued)
                },
                () => {
                    // The join failed. Discard rather than apply
                    // entries to a group that was never constructed.
                    joinPending = false
                    held.length = 0

                    // The way out is named, because there is exactly
                    // one and it is not obvious. The room has already
                    // handed over its copy of the Welcome and the
                    // creator now sees this identity in the tree, so
                    // asking again under the same identity is answered
                    // "already in the group" for ever. Reloading
                    // generates a new signature key, and a new key is a
                    // stranger the creator can admit. Phase 8's
                    // persistence keeps the identity across a reload,
                    // which is where this stops being a way out.
                    state.status.value =
                        'Could not join from the invitation. Reload ' +
                        'the page to ask again.'
                }
            )
        }
    })

    return delivery
}

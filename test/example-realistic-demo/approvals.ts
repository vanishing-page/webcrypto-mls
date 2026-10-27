import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl, ClientState } from '../../src/index.js'
import type {
    ClientMessage,
    LogEntry,
    PendingRequest,
    Standing
} from '../../example-realistic-demo/protocol.js'
import {
    classifyMlsWrite,
    MLS_WRITE_INTERVAL_MS,
    type MlsWriteVerdict
} from '../../example-realistic-demo/room-logic.js'
import { createPendingCommits } from
    '../../example-realistic-demo/client/pending-commit.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import {
    createApprovals,
    MAX_COMMIT_ATTEMPTS,
    type Approvals
} from '../../example-realistic-demo/client/approvals.js'
import {
    initCiphersuite,
    createUser,
    createOwnGroup,
    identityOf,
    encodeKeyPackageB64,
    encryptMessage,
    joinFromWelcome,
    processEntry
} from '../../example-realistic-demo/client/mls-actions.js'
import {
    membersFromTree,
    type Member
} from '../../example-realistic-demo/client/membership.js'
import { createGroupLock, type GroupLock } from
    '../../example-realistic-demo/client/group-lock.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import {
    deferred,
    longEnoughToHaveFinished,
    until
} from './async-helpers.js'

let cs:CiphersuiteImpl

test('the ciphersuite initialises', async (t) => {
    cs = await initCiphersuite()
    t.ok(cs, 'should return a ciphersuite')
})

/**
 * The room, as far as an approval can see it. The Durable Object is not
 * run; what it decides about an `mls` write is `classifyMlsWrite`, the
 * production rule, applied against a clock the test moves by hand.
 */
interface Room {
    /** Every accepted write, in seq order. */
    log:LogEntry[]
    /**
     * Each Welcome, with the log length when it was stamped and the
     * last commit this socket had sent, accepted or not.
     */
    welcomes:{
        to:string
        payload:string
        cursor:number
        afterCommit:string|null
    }[]
    /**
     * Each `removed`, with whether the last commit this socket sent had
     * already been echoed back to it when the frame arrived.
     */
    removals:{ identity:string, afterEcho:boolean }[]
    /** The clock `classifyMlsWrite` reads, in milliseconds. */
    now:number
    /** Refuse every `mls` write for this reason instead, when set. */
    refuse:MlsWriteVerdict|null
    /** How many `mls` writes reached the room, accepted or not. */
    writes:number
    /** This socket's last accepted `mls` write, on `now`'s clock. */
    lastMlsAt:number|null
    /**
     * Drop the socket on the next commit, before its answer arrives.
     * `logged`: the room took the write and the echo died with the
     * socket. `unlogged`: the frame left and never reached the room.
     */
    dropOnCommit:'logged'|'unlogged'|null
    /** The room has expired: every `mls` write is answered `no-room`. */
    gone:boolean
    /**
     * Drop the socket just as the next commit's echo arrives, so the
     * commit is accepted and whatever follows it cannot be sent.
     */
    dropAfterEcho:boolean
}

interface Harness {
    state:RealisticState
    approvals:Approvals
    sent:ClientMessage[]
    room:Room
    /** What a closed socket does to `send`. */
    drop ():void

    /** A new socket opens, as `connection.ts` reports one. */
    reconnect ():void

    /**
     * The replay on that socket: the whole log in pages of `pageSize`,
     * each a function that hands its entries to the pending commit and,
     * on the last page, the end of the replay -- as `connection.ts`
     * does with each `log` frame.
     */
    replayPages (pageSize?:number):(() => void)[]

    /**
     * The same lock the page shares between here, `chat.ts` and
     * `apply-entry.ts`. Exposed so a test can hold it and watch what
     * this module does while it is held.
     */
    lock:GroupLock
}

/**
 * A creator with a group of one, connected, holding the token. Each
 * test starts from that because it is the only state in which approving
 * anything is meaningful.
 *
 * `send` is the room. An `mls` write is classified, and answered the
 * way the room answers it: an accepted write goes in the log and comes
 * back as the sender's own `entry`, a refused one comes back as an
 * `error` carrying the write's `ref`. Answers arrive on a later
 * microtask, as they would off a socket.
 */
async function harness (creator:DemoUser):Promise<Harness> {
    const state = createRealisticState()
    const sent:ClientMessage[] = []
    let open = true
    const self = identityOf(creator.keyPackage!)

    const room:Room = {
        log: [],
        welcomes: [],
        removals: [],
        now: 1_000_000,
        refuse: null,
        writes: 0,
        lastMlsAt: null,
        dropOnCommit: null,
        gone: false,
        dropAfterEcho: false
    }

    state.ciphersuite.value = cs
    state.user.value = creator
    state.group.value = await createOwnGroup(creator, cs)
    state.isCreator.value = true

    const lock = createGroupLock()

    let lastCommit:string|null = null
    // Commits whose own echo has been delivered to this client.
    const echoed = new Set<string>()

    function onMls (msg:ClientMessage & { type:'mls' }):void {
        room.writes++
        if (msg.kind === 'commit') lastCommit = msg.payload

        // `requireRoom` answers before anything else, and with no `ref`.
        if (room.gone) {
            queueMicrotask(() => { commits.observe({ type: 'no-room' }) })
            return
        }

        const dropping = msg.kind === 'commit' ? room.dropOnCommit : null
        if (dropping) {
            room.dropOnCommit = null
            open = false
            if (dropping === 'unlogged') return
        }

        const verdict = room.refuse ?? classifyMlsWrite({
            payloadLength: msg.payload.length,
            logRows: room.log.length,
            logBytes: room.log
                .reduce((sum, e) => sum + e.payload.length, 0),
            lastMlsAt: room.lastMlsAt,
            now: room.now
        })

        if (verdict !== 'ok') {
            queueMicrotask(() => {
                commits.observe({
                    type: 'error',
                    reason: verdict,
                    ref: msg.ref
                })
            })
            return
        }

        room.lastMlsAt = room.now
        const entry:LogEntry = {
            seq: room.log.length + 1,
            sender: self,
            kind: msg.kind,
            payload: msg.payload
        }
        room.log.push(entry)
        if (dropping) return
        queueMicrotask(() => {
            echoed.add(entry.payload)
            if (room.dropAfterEcho && msg.kind === 'commit') {
                room.dropAfterEcho = false
                open = false
            }
            commits.observe({ type: 'entry', entry })
        })
    }

    function send (msg:ClientMessage):boolean {
        if (!open) return false
        sent.push(msg)
        if (msg.type === 'mls') onMls(msg)
        if (msg.type === 'welcome') {
            room.welcomes.push({
                to: msg.to,
                payload: msg.payload,
                cursor: room.log.length,
                afterCommit: lastCommit
            })
        }
        if (msg.type === 'removed') {
            room.removals.push({
                identity: msg.identity,
                afterEcho: lastCommit !== null && echoed.has(lastCommit)
            })
        }
        return true
    }

    const commits = createPendingCommits({ identity: () => self, send })

    const approvals = createApprovals({
        state,
        lock,
        send,
        submitCommit: commits.submit,
        // The interval elapses on the room's clock, not on a timer.
        async wait (ms:number):Promise<void> { room.now += ms }
    })

    return {
        state,
        approvals,
        sent,
        room,
        lock,
        drop () { open = false },

        reconnect () {
            open = true
            commits.observe({ type: 'reconnected' })
        },

        replayPages (pageSize = Math.max(room.log.length, 1)) {
            const pages:LogEntry[][] = []
            for (let i = 0; i < room.log.length; i += pageSize) {
                pages.push(room.log.slice(i, i + pageSize))
            }
            if (pages.length === 0) pages.push([])

            return pages.map((entries, i) => () => {
                for (const entry of entries) {
                    if (entry.sender === self) echoed.add(entry.payload)
                    commits.observe({ type: 'entry', entry })
                }
                if (i === pages.length - 1) {
                    commits.observe({ type: 'replay-end' })
                }
            })
        }
    }
}

/**
 * A joiner, joined from the Welcome addressed to it and brought up to
 * date from the room's log -- every commit after the Welcome's cursor,
 * as the replay after `welcome-you` would deliver them.
 *
 * Null when it cannot get there, rather than a throw: a throw aborts
 * the rest of the file, and a stranded joiner is exactly the failure
 * these tests exist to report.
 */
async function joinAndCatchUp (
    room:Room,
    user:DemoUser
):Promise<ClientState|null> {
    const identity = identityOf(user.keyPackage!)
    const welcome = room.welcomes.find(w => w.to === identity)
    if (!welcome) return null

    try {
        let group = await joinFromWelcome(welcome.payload, user, cs)
        for (const entry of room.log.slice(welcome.cursor)) {
            if (entry.kind !== 'commit') continue
            const result = await processEntry(group, entry.payload, cs)
            if (result.kind === 'newState') group = result.newState
        }
        return group
    } catch (_err) {
        return null
    }
}

/** Whether `group` can read a message the creator sends now. */
async function readsCreator (
    h:Harness,
    group:ClientState|null,
    text:string
):Promise<boolean> {
    if (!group) return false
    const sent = await encryptMessage(h.state.group.value!, text, cs)
    h.state.group.value = sent.newState

    try {
        const said = await processEntry(group, sent.payload, cs)
        return said.kind === 'applicationMessage' &&
            new TextDecoder().decode(said.message) === text
    } catch (_err) {
        return false
    }
}

function requestFrom (
    user:DemoUser,
    standing:Standing = 'stranger'
):PendingRequest {
    return {
        identity: identityOf(user.keyPackage!),
        keyPackage: encodeKeyPackageB64(user.keyPackage!),
        requestedAt: 1,
        standing
    }
}

// Committing an Add is a read of `state.group`, an await, and a write
// back -- the same shape as a send in `chat.ts` and as applying an entry
// in `apply-entry.ts`. This is the case with the worst outcome: an
// application message applied in the middle of it overwrites the epoch
// the creator just committed and broadcast, so everyone else moves on and
// the creator is left behind at an epoch it can never leave. The chain in
// this module orders approvals against each other; only the shared lock
// orders them against the other two writers.
test('approvals - an approval waits for whatever else is holding the group',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        const before = h.state.group.value

        const holding = deferred()
        const held = h.lock.run(async () => { await holding.promise })

        const approving = h.approvals.approve(requestFrom(bob))
        await longEnoughToHaveFinished()

        t.deepEqual(
            h.sent.map(msg => msg.type),
            [],
            'no frame goes out while the group is held'
        )
        t.equal(
            h.state.group.value,
            before,
            'and no epoch is reached that the room was not told about'
        )

        holding.resolve()
        await Promise.all([held, approving])

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'and once it is released the approval goes out in full'
        )
    })

// realistic-demo.AC4.1 -- the order the three frames go out in

test('approvals - approve sends the commit, the Welcome, then the ok',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        const request = requestFrom(bob)

        await h.approvals.approve(request)

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'the commit is in the log before the room stamps the cursor'
        )

        const [commit, welcome, approve] = h.sent
        t.equal(
            commit.type === 'mls' ? commit.kind : null,
            'commit',
            'the entry is asserted to be a commit'
        )
        t.equal(
            welcome.type === 'welcome' ? welcome.to : null,
            request.identity,
            'the Welcome is addressed to the person who asked'
        )
        t.equal(
            approve.type === 'approve' ? approve.identity : null,
            request.identity,
            'and the ledger records that same identity'
        )
    })

test('approvals - the frames carry a commit and a joinable Welcome',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))

        const welcome = h.sent[1]
        if (welcome.type !== 'welcome') {
            t.fail('the second frame should be the Welcome')
            return
        }

        // Used rather than decoded. A payload that decodes but joins
        // nothing would satisfy a decode assertion and fail the demo.
        const bobGroup = await joinFromWelcome(welcome.payload, bob, cs)
        t.equal(
            String(bobGroup.groupContext.epoch),
            '1',
            'the joiner is at epoch 1'
        )
        t.equal(
            bobGroup.groupContext.groupId.join(),
            h.state.group.value!.groupContext.groupId.join(),
            'in the creator\'s own group'
        )
    })

test('approvals - the local group advances only once it has been sent',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)

        const ok = await harness(alice)
        const before = ok.state.group.value
        await ok.approvals.approve(requestFrom(bob))

        t.equal(
            String(ok.state.group.value!.groupContext.epoch),
            '1',
            'a delivered approval advances the epoch'
        )
        t.ok(
            ok.state.group.value !== before,
            'and the state is a new one, not the old one mutated'
        )

        const dropped = await harness(alice)
        const stranded = dropped.state.group.value
        dropped.drop()
        await dropped.approvals.approve(requestFrom(bob))

        t.equal(
            dropped.state.group.value,
            stranded,
            'a dropped socket leaves the creator where everyone else is'
        )
        t.equal(
            String(dropped.state.group.value!.groupContext.epoch),
            '0',
            'so the epoch does not move'
        )
        t.notEqual(
            dropped.state.status.value,
            'Ready',
            'and the failure is reported rather than swallowed'
        )
    })

test('approvals - a request with an unreadable key package is refused',
    async (t) => {
        const alice = await createUser('alice', cs)
        const h = await harness(alice)

        await h.approvals.approve({
            identity: 'someone',
            keyPackage: 'AQID',
            requestedAt: 1,
            standing: 'stranger'
        })

        t.deepEqual(h.sent, [], 'nothing was sent')
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '0',
            'and the group did not move'
        )
        t.notEqual(
            h.state.status.value,
            'Ready',
            'the creator is told the request could not be read'
        )
    })

/**
 * A request is two separate fields, and the room stores whatever a
 * socket puts in both: it cannot parse a key package, so it cannot
 * check that they agree. Committing one that does not agree adds a leaf
 * nobody who asked can open, sends the Welcome to somebody who cannot
 * read it, and has the room record the claimant as admitted -- which is
 * what lets them write to the log. The creator is the only party that
 * can tell, because the creator is the only one that decodes the key
 * package.
 */
function stolenRequest (
    claimant:DemoUser,
    keyPackageOwner:DemoUser,
    standing:Standing = 'stranger'
):PendingRequest {
    return {
        identity: identityOf(claimant.keyPackage!),
        keyPackage: encodeKeyPackageB64(keyPackageOwner.keyPackage!),
        requestedAt: 1,
        standing
    }
}

test('approvals - a key package the asker does not own is refused',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const mallory = await createUser('mallory', cs)
        const h = await harness(alice)

        await h.approvals.approve(stolenRequest(mallory, bob))

        t.deepEqual(h.sent, [], 'nothing was sent')
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '0',
            'and the group did not move'
        )
        t.notEqual(
            h.state.status.value,
            'Ready',
            'the creator is told why it was refused'
        )

        // The polarity. A gate that refuses everything would pass the
        // three assertions above on its own, and would also make the
        // demo unusable.
        h.state.status.value = 'Ready'
        await h.approvals.approve(requestFrom(bob))

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'and the same key package from its owner still gets in'
        )
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '1',
            'the group moved for the request that was honest'
        )
    })

test('approvals - a mismatched pre-approved request is never automatic',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const mallory = await createUser('mallory', cs)
        const h = await harness(alice)

        // The whole point of refusing it in `approve` would be undone by
        // an unprompted path that commits it anyway -- and worse, this
        // list is re-broadcast, so a failure here is retried for ever.
        await h.approvals.onPending([
            stolenRequest(mallory, bob, 'pre-approved')
        ])

        t.deepEqual(h.sent, [], 'nothing was sent, not even a refusal')
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '0',
            'and the group did not move'
        )

        // The polarity: the unprompted path still works for a request
        // whose two halves agree.
        await h.approvals.onPending([requestFrom(bob, 'pre-approved')])

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'an honest pre-approved request is still committed'
        )
    })

test('approvals - deny sends a deny and nothing else', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const h = await harness(alice)

    h.approvals.deny(identityOf(bob.keyPackage!))

    t.deepEqual(
        h.sent,
        [{ type: 'deny', identity: identityOf(bob.keyPackage!) }],
        'denial is one frame, and no group change'
    )
    t.equal(
        String(h.state.group.value!.groupContext.epoch),
        '0',
        'denying commits nothing'
    )
})

// realistic-demo.AC4.2 -- pre-approved commits with no prompt

test('approvals - a pre-approved request is committed with no prompt',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.onPending([requestFrom(bob, 'pre-approved')])

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'the same three frames go out, unprompted'
        )
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '1',
            'and the group advanced'
        )
    })

// Found in a browser during Phase 7 Task 6, not by reading the code. A
// joiner whose socket drops before its Welcome arrives has no group, so
// its next `hello` re-publishes the request -- and the room, which
// admitted that identity already, calls the second ask `pre-approved`.
// Committing an Add for a leaf that is already in the tree is refused by
// the library, so the creator was left with a permanent row and
// "Could not approve that: ValidationError" on screen, retried on every
// re-broadcast of the list.
test('approvals - somebody already in the group is not added twice',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const epoch = String(h.state.group.value!.groupContext.epoch)
        h.sent.length = 0

        await h.approvals.onPending([requestFrom(bob, 'pre-approved')])

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['approve'],
            'the admission is confirmed and nothing is committed'
        )
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            epoch,
            'the epoch did not move for somebody already in'
        )
        // Not a loose /already in/: the library's own refusal says
        // "already in the group" too, so that would pass against the
        // defect this test exists for.
        t.equal(
            h.state.status.value,
            'bob is already in the group.',
            'the status names them and reports no failure'
        )
    })

test('approvals - a stranger and a removed member wait for the creator',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const h = await harness(alice)

        await h.approvals.onPending([
            requestFrom(bob, 'stranger'),
            requestFrom(carl, 'previously-removed')
        ])

        t.deepEqual(h.sent, [], 'neither was let in without being asked')
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '0',
            'and the group did not move'
        )
    })

test('approvals - a client that is not the creator commits nothing',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        h.state.isCreator.value = false

        await h.approvals.onPending([requestFrom(bob, 'pre-approved')])

        t.deepEqual(
            h.sent,
            [],
            'only the creator acts on a pending list'
        )
    })

test('approvals - two pre-approved requests are admitted one at a time',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const h = await harness(alice)

        await h.approvals.onPending([
            requestFrom(bob, 'pre-approved'),
            requestFrom(carl, 'pre-approved')
        ])

        // The second commit lands inside the room's interval, so it is
        // refused once and sent again; what follows a commit is only
        // ever sent once the room has it.
        t.deepEqual(
            h.sent.filter(msg => msg.type !== 'mls').map(msg => msg.type),
            ['welcome', 'approve', 'welcome', 'approve'],
            'one whole approval, then the next'
        )
        t.equal(h.room.log.length, 2, 'and the room holds both commits')
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '2',
            'two commits, two epochs -- not two commits at one epoch'
        )

        // The second Welcome has to be against the epoch the first
        // commit produced. Committing both from the same state would
        // still send two Welcomes; joining is what tells them apart.
        const carlIdentity = identityOf(carl.keyPackage!)
        const second = h.sent.find(msg => {
            return msg.type === 'welcome' && msg.to === carlIdentity
        })
        if (!second || second.type !== 'welcome') {
            t.fail('the second person should have been welcomed')
            return
        }

        const carlGroup = await joinFromWelcome(second.payload, carl, cs)
        t.equal(
            String(carlGroup.groupContext.epoch),
            '2',
            'the second joiner lands at the second epoch'
        )
        t.equal(
            carlGroup.ratchetTree
                .filter(n => n?.nodeType === 'leaf').length,
            3,
            'in a group of three'
        )
    })

test('approvals - the same request is never approved twice', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const h = await harness(alice)
    const request = requestFrom(bob, 'pre-approved')

    // What a re-broadcast pending list does: the room sends the list
    // again before the first approval has removed the row from it.
    await Promise.all([
        h.approvals.onPending([request]),
        h.approvals.onPending([request])
    ])

    t.deepEqual(
        h.sent.map(msg => msg.type),
        ['mls', 'welcome', 'approve'],
        'one approval, not two'
    )
    t.equal(
        String(h.state.group.value!.groupContext.epoch),
        '1',
        'and one epoch, not two'
    )

    // The second attempt does not merely fail harmlessly. MLS refuses
    // a key package already in the tree, so without the guard the
    // creator is shown a failure for a person who was in fact let in.
    t.ok(
        !h.state.status.value.includes('Could not approve'),
        'and no failure is reported for an approval that worked'
    )
})

test('approvals - two lists in flight at once do not race', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const carl = await createUser('carl', cs)
    const h = await harness(alice)

    // The dispatcher does not await one control message before handing
    // over the next, so two pending lists really can overlap. Both are
    // started before either is awaited, which is the shape that broke.
    const first = h.approvals.onPending([requestFrom(bob, 'pre-approved')])
    const second = h.approvals.onPending([
        requestFrom(carl, 'pre-approved')
    ])
    await Promise.all([first, second])

    t.equal(
        String(h.state.group.value!.groupContext.epoch),
        '2',
        'two commits landed one after the other, not both at epoch 0'
    )

    const carlIdentity = identityOf(carl.keyPackage!)
    const welcome = h.sent.find(msg => {
        return msg.type === 'welcome' && msg.to === carlIdentity
    })

    if (!welcome || welcome.type !== 'welcome') {
        t.fail('the second person should have been welcomed')
        return
    }

    // The frame count alone would not tell these apart: two commits
    // from the same state also send two Welcomes. Joining is what says
    // which group the second one is into.
    const carlGroup = await joinFromWelcome(welcome.payload, carl, cs)
    t.equal(
        carlGroup.ratchetTree.filter(n => n?.nodeType === 'leaf').length,
        3,
        'and the later Welcome is into the group of three'
    )
})

// realistic-demo.AC5.4 -- removing a member

/**
 * The member to hand to `remove`, as the room view would: resolved from
 * the creator's own tree, which is the only place a name lives.
 */
function memberOf (state:RealisticState, user:DemoUser):Member {
    const identity = identityOf(user.keyPackage!)
    const found = membersFromTree(state.group.value!.ratchetTree)
        .find(member => member.identity === identity)

    if (!found) throw new Error('that user is not in the group')
    return found
}

test('approvals - remove sends the commit before telling the room',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const bobMember = memberOf(h.state, bob)
        h.sent.length = 0
        // Past the interval the Add opened, so the order is all this
        // looks at; a refused first try is the rate-limit tests' job.
        h.room.now += MLS_WRITE_INTERVAL_MS

        await h.approvals.remove(bobMember)

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'removed'],
            'the commit is in the log before the ledger records it'
        )

        const [commit, removed] = h.sent
        t.equal(
            commit.type === 'mls' ? commit.kind : null,
            'commit',
            'the entry is asserted to be a commit'
        )
        t.equal(
            removed.type === 'removed' ? removed.identity : null,
            bobMember.identity,
            'and the ledger records the identity that was removed'
        )
    })

test('approvals - remove advances the epoch and drops the leaf',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const bobMember = memberOf(h.state, bob)

        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '1',
            'the group is at epoch 1 with both members'
        )

        await h.approvals.remove(bobMember)

        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '2',
            'the group is one epoch on'
        )
        t.deepEqual(
            membersFromTree(h.state.group.value!.ratchetTree)
                .map(member => member.name),
            ['alice'],
            'and only the creator is left in the tree'
        )
    })

test('approvals - a removal that could not be sent changes nothing',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const bobMember = memberOf(h.state, bob)
        const before = h.state.group.value
        h.drop()

        await h.approvals.remove(bobMember)

        t.equal(
            h.state.group.value,
            before,
            'the group is left where it was, not one epoch ahead alone'
        )
        t.ok(
            h.state.status.value.includes('connection'),
            'and the failure is reported'
        )
    })

// realistic-demo.AC5.3 -- removal is the creator's

test('approvals - only the creator removes anyone', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const h = await harness(alice)

    await h.approvals.approve(requestFrom(bob))
    const bobMember = memberOf(h.state, bob)
    const before = h.state.group.value
    h.sent.length = 0
    h.state.isCreator.value = false

    await h.approvals.remove(bobMember)

    t.deepEqual(h.sent, [], 'nothing is sent')
    t.equal(
        h.state.group.value,
        before,
        'and no commit is made against the group'
    )
})

test('approvals - removing somebody already gone is refused', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const h = await harness(alice)

    await h.approvals.approve(requestFrom(bob))
    const bobMember = memberOf(h.state, bob)
    await h.approvals.remove(bobMember)

    const after = h.state.group.value
    h.sent.length = 0

    await h.approvals.remove(bobMember)

    t.deepEqual(h.sent, [], 'the second removal sends nothing')
    t.equal(
        h.state.group.value,
        after,
        'and moves no epoch'
    )
    t.ok(
        h.state.status.value.includes('not in the group'),
        'and says the person is not there, rather than reporting ' +
        'whatever the library made of a blank leaf'
    )
})

test('approvals - an approval and a removal do not share an epoch',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const bobMember = memberOf(h.state, bob)

        // Started in the same turn, the approval first: both read
        // `state.group` before either has written it, unless the
        // removal queues behind the approval rather than behind its own
        // kind. This order is the one that says so -- a removal that
        // waits only for other removals waits for nothing here.
        const approval = h.approvals.approve(requestFrom(carl))
        const removal = h.approvals.remove(bobMember)
        await Promise.all([approval, removal])

        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '3',
            'the two commits landed one after the other'
        )
        t.deepEqual(
            membersFromTree(h.state.group.value!.ratchetTree)
                .map(member => member.name)
                .sort(),
            ['alice', 'carl'],
            'and the group holds the result of both'
        )
    })

// F1 -- a commit does not count until the room accepts it

// The audit's reproduction. The second Add lands inside the room's
// `mls` interval and is refused; a creator that took "sent" for
// "accepted" still welcomed the second joiner and moved to epoch 2,
// leaving the first joiner at epoch 1 with no commit in the log to
// reach epoch 2 from.
test('approvals - two approvals inside one interval keep one room',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const h = await harness(alice)

        const first = h.approvals.approve(requestFrom(bob))
        const second = h.approvals.approve(requestFrom(carl))
        await Promise.all([first, second])

        const bobGroup = await joinAndCatchUp(h.room, bob)
        const carlGroup = await joinAndCatchUp(h.room, carl)

        t.ok(
            await readsCreator(h, bobGroup, 'hello bob'),
            'the first joiner reads the creator'
        )
        t.ok(
            await readsCreator(h, carlGroup, 'hello carl'),
            'and so does the second'
        )
    })

/** Every commit the room's log holds, as payloads. */
function loggedCommits (room:Room):Set<string> {
    return new Set(room.log
        .filter(entry => entry.kind === 'commit')
        .map(entry => entry.payload))
}

test('approvals - walking a pre-approved list welcomes only logged commits',
    async (t) => {
        const alice = await createUser('alice', cs)
        const joiners = await Promise.all(['bob', 'carl', 'dave', 'erin']
            .map(name => createUser(name, cs)))
        const h = await harness(alice)

        // Every write after the first lands inside the interval unless
        // the creator waits it out.
        await h.approvals.onPending(
            joiners.map(user => requestFrom(user, 'pre-approved'))
        )

        // A Welcome is only ever sent once the commit before it is in
        // the log.
        const logged = loggedCommits(h.room)
        t.ok(
            h.room.welcomes.every(w => {
                return w.afterCommit !== null && logged.has(w.afterCommit)
            }),
            'every Welcome follows a commit the room holds'
        )

        const approved = h.sent
            .filter(msg => msg.type === 'approve')
            .map(msg => msg.type === 'approve' ? msg.identity : '')

        for (const user of joiners) {
            const identity = identityOf(user.keyPackage!)
            if (!approved.includes(identity)) {
                t.ok(
                    !h.room.welcomes.some(w => w.to === identity),
                    `${identity.slice(0, 8)} was left pending, unwelcomed`
                )
                continue
            }

            const joined = await joinAndCatchUp(h.room, user)
            t.equal(
                String(joined?.groupContext.epoch),
                String(h.state.group.value!.groupContext.epoch),
                'an admitted joiner reaches the creator\'s epoch'
            )
            t.ok(
                await readsCreator(h, joined, `hello ${identity}`),
                'and reads the creator'
            )
        }
    })

test('approvals - a full log sends no Welcome and moves no epoch',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        const before = h.state.group.value
        h.room.refuse = 'log-full'
        h.state.status.value = 'Ready'

        await h.approvals.approve(requestFrom(bob))

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls'],
            'the commit went out and nothing followed it'
        )
        t.equal(h.room.writes, 1, 'and it was not retried')
        t.ok(
            h.state.group.value === before,
            'the creator stays where everyone else is'
        )
        t.notEqual(
            h.state.status.value,
            'Ready',
            'and the refusal is reported'
        )

        // Pending in the room means `approve` was never sent; still
        // pending here means it can be approved again.
        h.room.refuse = null
        await h.approvals.approve(requestFrom(bob))
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '1',
            'and the request can still be approved once the room has room'
        )
    })

test('approvals - a room gone mid-approval refuses it and frees the lock',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        const before = h.state.group.value
        h.room.gone = true

        // Waited on with a deadline rather than awaited: an approval
        // that never settles has to fail here, not end the file with its
        // plan unprinted.
        let settled = false
        h.approvals.approve(requestFrom(bob))
            .then(() => { settled = true })
        await until(() => settled, 'the approval settles')
            .catch(() => {})
        t.ok(settled, 'the approval settles')

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls'],
            'the commit went out and nothing followed it'
        )
        t.ok(
            h.state.group.value === before,
            'the creator stays where it was'
        )

        let ran = false
        h.lock.run(async () => { ran = true })
        await until(() => ran, 'the lock runs the next task')
            .catch(() => {})
        t.ok(ran, 'and the group lock is free for whatever comes next')
    })

test('approvals - a rate-limited commit is admitted after the interval',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        // A chat message this socket wrote a moment ago, so the
        // commit's first send lands inside the interval.
        h.room.lastMlsAt = h.room.now
        const lastWrite = h.room.now
        await h.approvals.approve(requestFrom(bob))

        t.equal(h.room.writes, 2, 'refused once, then accepted')

        t.ok(
            h.room.now - lastWrite >= MLS_WRITE_INTERVAL_MS,
            'the creator waited out the interval on the room\'s clock'
        )
        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.ok(
            await readsCreator(h, bobGroup, 'hello bob'),
            'and the joiner reads the creator'
        )
    })

test('approvals - rate-limited retries stop at the bound', async (t) => {
    const alice = await createUser('alice', cs)
    const bob = await createUser('bob', cs)
    const h = await harness(alice)
    const before = h.state.group.value
    h.room.refuse = 'rate-limited'
    h.state.status.value = 'Ready'

    await h.approvals.approve(requestFrom(bob))

    t.equal(
        h.room.writes,
        MAX_COMMIT_ATTEMPTS,
        'the commit was tried the bounded number of times'
    )
    t.deepEqual(
        h.sent.filter(msg => msg.type !== 'mls'),
        [],
        'and nothing followed it'
    )
    t.ok(h.state.group.value === before, 'the epoch did not move')
    t.notEqual(
        h.state.status.value,
        'Ready',
        'and the refusal is reported'
    )
})

// F1, the Remove half -- a removal waits for the room as an Add does

test('approvals - an accepted removal waits for the echo, then moves on',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        await h.approvals.approve(requestFrom(carl))
        const before = h.state.group.value!.groupContext.epoch
        const bobMember = memberOf(h.state, bob)

        await h.approvals.remove(bobMember)

        t.deepEqual(
            h.room.removals,
            [{ identity: bobMember.identity, afterEcho: true }],
            'the ledger is written once the room has echoed the commit'
        )
        t.ok(
            h.state.group.value!.groupContext.epoch === before + 1n,
            'and the creator is one epoch on'
        )

        const carlGroup = await joinAndCatchUp(h.room, carl)
        t.equal(
            String(carlGroup?.groupContext.epoch),
            String(h.state.group.value!.groupContext.epoch),
            'the member who stays reaches the creator\'s epoch'
        )
        t.ok(
            await readsCreator(h, carlGroup, 'hello carl'),
            'and reads the creator there'
        )
    })

test('approvals - a full log refuses a removal and nothing follows',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const bobMember = memberOf(h.state, bob)
        const before = h.state.group.value
        const writes = h.room.writes
        h.sent.length = 0
        h.room.refuse = 'log-full'
        h.state.status.value = 'Ready'

        await h.approvals.remove(bobMember)

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls'],
            'the commit went out and no removed frame followed it'
        )
        t.equal(h.room.writes, writes + 1, 'and it was not retried')
        t.ok(
            h.state.group.value === before,
            'the creator\'s epoch is unchanged'
        )
        t.notEqual(
            h.state.status.value,
            'Ready',
            'and the refusal is reported'
        )

        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.ok(
            await readsCreator(h, bobGroup, 'hello bob'),
            'the member the creator meant to remove still reads it'
        )
    })

test('approvals - a rate-limited removal completes after the interval',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        const bobMember = memberOf(h.state, bob)
        const writes = h.room.writes

        // Whatever this socket wrote last, it wrote a moment ago.
        h.room.lastMlsAt = h.room.now
        const lastWrite = h.room.now

        await h.approvals.remove(bobMember)

        t.equal(h.room.writes, writes + 2, 'refused once, then accepted')
        t.ok(
            h.room.now - lastWrite >= MLS_WRITE_INTERVAL_MS,
            'the creator waited out the interval on the room\'s clock'
        )
        t.deepEqual(
            h.room.removals.map(r => r.afterEcho),
            [true],
            'and wrote the ledger only once the retry was echoed'
        )

        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.equal(
            bobGroup?.groupActiveState.kind,
            'removedFromGroup',
            'the removed member reaches the removed state'
        )
    })

test('approvals - an approval and a removal in one interval keep one room',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const dave = await createUser('dave', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        await h.approvals.approve(requestFrom(dave))
        const bobMember = memberOf(h.state, bob)

        // No time passes between the two: the second commit lands
        // inside the interval the first one opened.
        const approval = h.approvals.approve(requestFrom(carl))
        const removal = h.approvals.remove(bobMember)
        await Promise.all([approval, removal])

        const epoch = String(h.state.group.value!.groupContext.epoch)

        for (const [user, name] of [[carl, 'carl'], [dave, 'dave']] as const) {
            const group = await joinAndCatchUp(h.room, user)
            t.equal(
                String(group?.groupContext.epoch),
                epoch,
                `${name} is at the creator's epoch`
            )
            t.ok(
                await readsCreator(h, group, `hello ${name}`),
                `and ${name} reads the creator`
            )
        }

        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.equal(
            bobGroup?.groupActiveState.kind,
            'removedFromGroup',
            'and the member put out is out'
        )
    })

// A drop after the echo -- the commit is in, its Welcome is not

test('approvals - a Welcome the drop stopped is sent on the next approve',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        h.room.dropAfterEcho = true

        await h.approvals.approve(requestFrom(bob))
        t.equal(h.room.welcomes.length, 0, 'the Welcome did not get out')
        t.equal(String(h.state.group.value!.groupContext.epoch), '1',
            'and the creator is at the epoch the room logged')

        // The request is still pending in the room, and the creator
        // approves it again -- by hand or as a re-broadcast.
        h.reconnect()
        h.sent.length = 0
        await h.approvals.approve(requestFrom(bob))

        t.deepEqual(h.sent.map(msg => msg.type), ['welcome', 'approve'],
            'the held Welcome goes out, then the approval, and no commit')
        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.ok(await readsCreator(h, bobGroup, 'hello bob'),
            'and the joiner reads the creator')
    })

test('approvals - a held Welcome goes out before the next commit',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carol = await createUser('carol', cs)
        const h = await harness(alice)
        h.room.dropAfterEcho = true

        await h.approvals.approve(requestFrom(bob))
        h.reconnect()

        // Somebody else first. The room stamps a Welcome's cursor when
        // it arrives, so bob's has to be in before carol's commit is, or
        // bob joins past a commit he needs.
        h.room.now += MLS_WRITE_INTERVAL_MS
        await h.approvals.approve(requestFrom(carol))

        const bobGroup = await joinAndCatchUp(h.room, bob)
        const carolGroup = await joinAndCatchUp(h.room, carol)
        t.ok(await readsCreator(h, bobGroup, 'hello bob'),
            'the stranded joiner reads the creator')
        t.ok(await readsCreator(h, carolGroup, 'hello carol'),
            'and so does the next one')
    })

test('approvals - a held Welcome is dropped when its joiner is removed',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carol = await createUser('carol', cs)
        const h = await harness(alice)
        h.room.dropAfterEcho = true

        await h.approvals.approve(requestFrom(bob))
        h.reconnect()
        h.room.now += MLS_WRITE_INTERVAL_MS
        await h.approvals.remove(memberOf(h.state, bob))
        h.room.now += MLS_WRITE_INTERVAL_MS
        await h.approvals.approve(requestFrom(carol))

        t.deepEqual(h.room.welcomes.map(w => w.to),
            [identityOf(carol.keyPackage!)],
            'nobody sends the removed member a way in')
        const carolGroup = await joinAndCatchUp(h.room, carol)
        t.ok(await readsCreator(h, carolGroup, 'hello carol'),
            'and the next joiner reads the creator')
    })

// F1, a dropped socket -- the replay after reconnect settles the commit

async function replayAll (h:Harness, pageSize?:number):Promise<void> {
    for (const page of h.replayPages(pageSize)) page()
}

test('approvals - a dropped commit the room logged finishes the approval',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        const before = h.state.group.value
        h.room.dropOnCommit = 'logged'

        const approving = h.approvals.approve(requestFrom(bob))
        await until(() => h.room.dropOnCommit === null,
            'the commit has gone out and the socket dropped')
        await longEnoughToHaveFinished()

        t.deepEqual(h.sent.map(msg => msg.type), ['mls'],
            'nothing follows the commit while its fate is unknown')
        t.ok(h.state.group.value === before, 'and no epoch has moved')

        h.reconnect()
        await replayAll(h)
        await approving

        t.deepEqual(h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'the replay held the commit, so the approval went out')
        t.equal(String(h.state.group.value!.groupContext.epoch), '1',
            'and the creator moved to its epoch')

        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.ok(await readsCreator(h, bobGroup, 'hello bob'),
            'the joiner reads the creator')
    })

test('approvals - a dropped commit the room never logged changes nothing',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)
        const before = h.state.group.value
        h.state.status.value = 'Ready'
        h.room.dropOnCommit = 'unlogged'

        const approving = h.approvals.approve(requestFrom(bob))
        await until(() => h.room.dropOnCommit === null,
            'the commit has gone out and the socket dropped')
        h.reconnect()
        await replayAll(h)
        await approving

        t.deepEqual(h.sent.map(msg => msg.type), ['mls'],
            'no Welcome and no approve')
        t.ok(h.state.group.value === before,
            'the creator\'s epoch is unchanged')
        t.notEqual(h.state.status.value, 'Ready',
            'and the loss is reported')

        // Still pending in the room, so it can be approved again.
        await h.approvals.approve(requestFrom(bob))
        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.ok(await readsCreator(h, bobGroup, 'hello bob'),
            'and a second try admits the joiner')
    })

test('approvals - a dropped removal the room logged finishes the removal',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        h.room.now += MLS_WRITE_INTERVAL_MS
        await h.approvals.approve(requestFrom(carl))
        h.room.now += MLS_WRITE_INTERVAL_MS
        const bobMember = memberOf(h.state, bob)
        const before = h.state.group.value!.groupContext.epoch
        h.room.dropOnCommit = 'logged'

        const removing = h.approvals.remove(bobMember)
        await until(() => h.room.dropOnCommit === null,
            'the commit has gone out and the socket dropped')
        await longEnoughToHaveFinished()
        t.deepEqual(h.room.removals, [],
            'no removed frame while the commit\'s fate is unknown')

        h.reconnect()
        await replayAll(h)
        await removing

        t.deepEqual(
            h.room.removals,
            [{ identity: bobMember.identity, afterEcho: true }],
            'the ledger is written once the replay has echoed the commit'
        )
        t.ok(h.state.group.value!.groupContext.epoch === before + 1n,
            'and the creator is one epoch on')

        const carlGroup = await joinAndCatchUp(h.room, carl)
        t.ok(await readsCreator(h, carlGroup, 'hello carl'),
            'the member who stays reads the creator')
        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.equal(bobGroup?.groupActiveState.kind, 'removedFromGroup',
            'and the removed member is out')
    })

test('approvals - a dropped removal the room never logged changes nothing',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        h.room.now += MLS_WRITE_INTERVAL_MS
        const bobMember = memberOf(h.state, bob)
        const before = h.state.group.value
        h.state.status.value = 'Ready'
        h.room.dropOnCommit = 'unlogged'

        const removing = h.approvals.remove(bobMember)
        await until(() => h.room.dropOnCommit === null,
            'the commit has gone out and the socket dropped')
        h.reconnect()
        await replayAll(h)
        await removing

        t.deepEqual(h.room.removals, [], 'no removed frame')
        t.ok(h.state.group.value === before,
            'the creator\'s epoch is unchanged')
        t.notEqual(h.state.status.value, 'Ready',
            'and the loss is reported')

        const bobGroup = await joinAndCatchUp(h.room, bob)
        t.ok(await readsCreator(h, bobGroup, 'hello bob'),
            'the member the creator meant to remove still reads it')
    })

test('approvals - a paged replay settles a dropped commit on its last page',
    async (t) => {
        const alice = await createUser('alice', cs)
        const bob = await createUser('bob', cs)
        const carl = await createUser('carl', cs)
        const dave = await createUser('dave', cs)
        const h = await harness(alice)

        await h.approvals.approve(requestFrom(bob))
        h.room.now += MLS_WRITE_INTERVAL_MS
        await h.approvals.approve(requestFrom(carl))
        h.room.now += MLS_WRITE_INTERVAL_MS
        h.room.dropOnCommit = 'logged'
        h.sent.length = 0

        const approving = h.approvals.approve(requestFrom(dave))
        await until(() => h.room.dropOnCommit === null,
            'the commit has gone out and the socket dropped')
        h.reconnect()

        // One entry a page: the dropped commit is alone on the last.
        const pages = h.replayPages(1)
        t.equal(pages.length, 3, 'three pages')
        for (const page of pages.slice(0, -1)) page()
        await longEnoughToHaveFinished()

        t.deepEqual(h.sent.map(msg => msg.type), ['mls'],
            'a page without the echo, not the last, settles nothing')

        pages[pages.length - 1]()
        await approving

        t.deepEqual(h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve'],
            'the echo on the last page finishes the approval')
        const daveGroup = await joinAndCatchUp(h.room, dave)
        t.ok(await readsCreator(h, daveGroup, 'hello dave'),
            'and the joiner reads the creator')
    })

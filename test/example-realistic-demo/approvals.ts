import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl } from '../../src/index.js'
import type {
    ClientMessage,
    PendingRequest,
    Standing
} from '../../example-realistic-demo/protocol.js'
import {
    createRealisticState,
    type RealisticState
} from '../../example-realistic-demo/client/state.js'
import {
    createApprovals,
    type Approvals
} from '../../example-realistic-demo/client/approvals.js'
import {
    initCiphersuite,
    createUser,
    createOwnGroup,
    identityOf,
    encodeKeyPackageB64,
    joinFromWelcome
} from '../../example-realistic-demo/client/mls-actions.js'
import {
    membersFromTree,
    type Member
} from '../../example-realistic-demo/client/membership.js'
import { createGroupLock, type GroupLock } from
    '../../example-realistic-demo/client/group-lock.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import { deferred, longEnoughToHaveFinished } from './async-helpers.js'

let cs:CiphersuiteImpl

test('the ciphersuite initialises', async (t) => {
    cs = await initCiphersuite()
    t.ok(cs, 'should return a ciphersuite')
})

interface Harness {
    state:RealisticState
    approvals:Approvals
    sent:ClientMessage[]
    /** What a closed socket does to `send`. */
    drop ():void

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
 */
async function harness (creator:DemoUser):Promise<Harness> {
    const state = createRealisticState()
    const sent:ClientMessage[] = []
    let open = true

    state.ciphersuite.value = cs
    state.user.value = creator
    state.group.value = await createOwnGroup(creator, cs)
    state.isCreator.value = true

    const lock = createGroupLock()

    const approvals = createApprovals({
        state,
        lock,
        send (msg:ClientMessage):boolean {
            if (!open) return false
            sent.push(msg)
            return true
        }
    })

    return { state, approvals, sent, lock, drop () { open = false } }
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

        t.deepEqual(
            h.sent.map(msg => msg.type),
            ['mls', 'welcome', 'approve', 'mls', 'welcome', 'approve'],
            'one whole approval, then the next'
        )
        t.equal(
            String(h.state.group.value!.groupContext.epoch),
            '2',
            'two commits, two epochs -- not two commits at one epoch'
        )

        // The second Welcome has to be against the epoch the first
        // commit produced. Committing both from the same state would
        // still send six frames; joining is what tells them apart.
        const second = h.sent[4]
        if (second.type !== 'welcome') {
            t.fail('the fifth frame should be the second Welcome')
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

import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl } from '../../src/index.js'
import type {
    LogEntry,
    PendingRequest,
    Standing
} from '../../example-realistic-demo/protocol.js'
import { StoragePanel } from '../../example-shared/storage-panel.js'
import { HowToUse } from '../../example-shared/how-to-use.js'
import {
    initCiphersuite,
    createUser,
    identityOf,
    encodeKeyPackageB64
} from '../../example-realistic-demo/client/mls-actions.js'
import { SetupForm } from
    '../../example-realistic-demo/client/views/setup.js'
import { RoomLink, ShareRoomLink } from
    '../../example-realistic-demo/client/views/room-link.js'
import { CopyControl, CopyValue } from
    '../../example-realistic-demo/client/views/copy-value.js'
import { Room } from '../../example-realistic-demo/client/views/room.js'
import { Waiting } from
    '../../example-realistic-demo/client/views/waiting.js'
import { Persistence } from
    '../../example-realistic-demo/client/views/persistence.js'
import { Gone } from '../../example-realistic-demo/client/views/gone.js'
import { Explainer, ROOM_STEPS } from
    '../../example-realistic-demo/client/views/explainer.js'
import { createRealisticState, type SentMessage } from
    '../../example-realistic-demo/client/state.js'
import type { Member } from
    '../../example-realistic-demo/client/membership.js'
import { bytesToBase64url, defaultCapabilities } from '../../src/index.js'
import type { Node, RatchetTree } from '../../src/ratchet-tree.js'
import { allNodes, childrenOf, findByType, findByClass, findByClassToken } from
    '../example/vnode.js'

function setupForm (props:Partial<Parameters<typeof SetupForm>[0]> = {}) {
    return SetupForm({
        name: '',
        busy: false,
        onName: () => {},
        onSubmit: () => {},
        ...props
    }, {})
}

test('SetupForm offers a name field and a submit button', t => {
    const tree = setupForm({ name: 'Alice' })

    const inputs = findByType(tree, 'substrate-input')
    t.equal(inputs.length, 1, 'should render one name field')
    t.equal(
        inputs[0].props.value,
        'Alice',
        'the field should show the name it was given'
    )
    t.equal(
        typeof inputs[0].props.label,
        'string',
        'with a label property of type string'
    )
    t.ok(
        typeof inputs[0].props.label === 'string' &&
            inputs[0].props.label.length > 0,
        'label is not empty'
    )

    const buttons = findByType(tree, 'substrate-button')
    t.equal(buttons.length, 1, 'should render one button')
    t.equal(
        buttons[0].props.type,
        'submit',
        'the button should submit the form'
    )
})

test('SetupForm will not submit without a name', t => {
    const empty = setupForm({ name: '' })
    t.equal(
        findByType(empty, 'substrate-button')[0].props.disabled,
        true,
        'an empty name should disable the button'
    )

    const spaces = setupForm({ name: '   ' })
    t.equal(
        findByType(spaces, 'substrate-button')[0].props.disabled,
        true,
        'a name of only spaces should disable the button'
    )

    const named = setupForm({ name: 'Alice' })
    t.equal(
        findByType(named, 'substrate-button')[0].props.disabled,
        false,
        'a name should enable the button'
    )
})

test('SetupForm disables itself while a room is being created', t => {
    const tree = setupForm({ name: 'Alice', busy: true })

    t.equal(
        findByType(tree, 'substrate-button')[0].props.disabled,
        true,
        'the button should be disabled while busy'
    )
    t.equal(
        findByType(tree, 'substrate-input')[0].props.disabled,
        true,
        'the field should be disabled while busy'
    )
})

test('SetupForm reports what was typed and when it was submitted', t => {
    const typed:string[] = []
    let submitted = 0

    const tree = setupForm({
        name: 'Al',
        onName: (value:string) => { typed.push(value) },
        onSubmit: () => { submitted++ }
    })

    const onInput = findByType(tree, 'substrate-input')[0].props.onInput as
        (ev:{ currentTarget:{ value:string } }) => void
    onInput({ currentTarget: { value: 'Alice' } })
    t.deepEqual(typed, ['Alice'], 'typing should report the new value')

    const onSubmit = findByType(tree, 'form')[0].props.onSubmit as
        () => void
    onSubmit()
    t.equal(submitted, 1, 'submitting the form should call onSubmit')
})

function roomLink (props:Partial<Parameters<typeof RoomLink>[0]> = {}) {
    return RoomLink({
        url: 'https://demo.test/abcdeFGH12',
        copied: false,
        onCopy: () => {},
        ...props
    }, {})
}

test('RoomLink shows the whole absolute URL', t => {
    const tree = roomLink()
    const fields = findByClass(tree, 'room-url')

    t.equal(fields.length, 1, 'should render one URL field')
    t.equal(
        fields[0].props.value,
        'https://demo.test/abcdeFGH12',
        'the field should hold the absolute room URL'
    )
    t.equal(
        fields[0].props.readonly,
        true,
        'the URL is for copying, not for editing'
    )
})

test('RoomLink has a copy control that reports the copy', t => {
    let copies = 0
    const tree = roomLink({ onCopy: () => { copies++ } })

    const buttons = findByClass(tree, 'copy')
    t.equal(buttons.length, 1, 'should render one copy button')
    t.ok(
        buttons[0].props['aria-label'],
        'the copy button should have an accessible name'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.equal(copies, 1, 'clicking should call onCopy')
})

test('RoomLink confirms a copy only once one has happened', t => {
    const noCopy = roomLink({ copied: false })
    const noConfirm = findByClass(noCopy, 'copied')
    t.equal(
        noConfirm.length,
        1,
        'the confirmation region should always exist'
    )
    t.equal(
        noConfirm[0].props['data-copied'],
        false,
        'before a copy the region should be marked as not copied'
    )
    t.equal(
        noConfirm[0].props.role,
        'status',
        'the region should be a live region'
    )

    const withCopy = roomLink({ copied: true })
    const withConfirm = findByClass(withCopy, 'copied')
    t.equal(
        withConfirm.length,
        1,
        'the confirmation region should still exist'
    )
    t.equal(
        withConfirm[0].props['data-copied'],
        true,
        'after a copy the region should be marked as copied'
    )
    t.equal(
        withConfirm[0].props.role,
        'status',
        'the region should be a live region'
    )

    const noChildren = childrenOf(noConfirm[0])
    const withChildren = childrenOf(withConfirm[0])
    t.notDeepEqual(
        withChildren,
        noChildren,
        'the two renderings should differ'
    )
    t.ok(
        !noChildren.some((c:unknown) => Boolean(c)),
        'the copied false rendering should have no visible content'
    )
    t.ok(
        withChildren.some((c:unknown) => Boolean(c)),
        'the copied true rendering should have visible content'
    )
})

function copyControl (
    props:Partial<Parameters<typeof CopyControl>[0]> = {}
) {
    return CopyControl({
        copied: false,
        label: 'Copy your signature public key',
        onCopy: () => {},
        ...props
    }, {})
}

test('CopyControl has one copy button, named for its value', t => {
    let copies = 0
    const label = 'Copy your signature public key'
    const tree = copyControl({ label, onCopy: () => { copies++ } })

    const buttons = findByClass(tree, 'copy')
    t.equal(buttons.length, 1, 'should render one copy button')
    t.equal(
        buttons[0].props['aria-label'],
        label,
        'the button should be named for the value it copies'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.equal(copies, 1, 'clicking should call onCopy')
})

test('CopyControl confirms a copy only once one has happened', t => {
    const noCopy = copyControl({ copied: false })
    const noConfirm = findByClass(noCopy, 'copied')
    t.equal(
        noConfirm.length,
        1,
        'the confirmation region should always exist'
    )
    t.equal(
        noConfirm[0].props['data-copied'],
        false,
        'before a copy the region should be marked as not copied'
    )
    t.equal(
        noConfirm[0].props.role,
        'status',
        'the region should be a live region'
    )

    const withCopy = copyControl({ copied: true })
    const withConfirm = findByClass(withCopy, 'copied')
    t.equal(
        withConfirm.length,
        1,
        'the confirmation region should still exist'
    )
    t.equal(
        withConfirm[0].props['data-copied'],
        true,
        'after a copy the region should be marked as copied'
    )
    t.equal(
        withConfirm[0].props.role,
        'status',
        'the region should be a live region'
    )

    const noChildren = childrenOf(noConfirm[0])
    const withChildren = childrenOf(withConfirm[0])
    t.notDeepEqual(
        withChildren,
        noChildren,
        'the two renderings should differ'
    )
    t.ok(
        !noChildren.some((c:unknown) => Boolean(c)),
        'the copied false rendering should have no visible content'
    )
    t.ok(
        withChildren.some((c:unknown) => Boolean(c)),
        'the copied true rendering should have visible content'
    )
})

function room (
    state:ReturnType<typeof createRealisticState>,
    props:{
        onApprove? (request:PendingRequest):void
        onDeny? (identity:string):void
        onRemove? (member:Member):void
        onSend? (text:string):void
    } = {}
) {
    return Room({
        state,
        onApprove: props.onApprove ?? (() => {}),
        onDeny: props.onDeny ?? (() => {}),
        onRemove: props.onRemove ?? (() => {}),
        onSend: props.onSend ?? (() => {})
    }, {})
}

test('Room shows the room URL for the room it is given', t => {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const state = createRealisticState()
        state.roomId.value = 'abcdeFGH12'

        const tree = room(state)
        const links = allNodes(tree).filter(node => {
            return (node.type as unknown) === ShareRoomLink
        })

        t.equal(links.length, 1, 'should render one room link')
        t.equal(
            links[0].props.url,
            'https://demo.test/abcdeFGH12',
            'the link should be the origin joined to the room id'
        )
    } finally {
        g.location = previous
    }
})

test('Room shows the connection status and the live members', t => {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const state = createRealisticState()
        state.roomId.value = 'abcdeFGH12'
        state.connection.value = 'reconnecting'
        state.live.value = ['aaa', 'bbb', 'ccc']

        const tree = room(state)

        const status = findByClass(tree, 'connection')
        t.equal(status.length, 1, 'should render one connection element')
        t.equal(
            status[0].props['data-status'],
            'reconnecting',
            'the element should carry the current connection status'
        )

        const live = findByClass(tree, 'live')
        t.equal(live.length, 1, 'should render one live list')
        t.equal(
            findByType(live[0], 'li').length,
            3,
            'should render one item per live member'
        )
    } finally {
        g.location = previous
    }
})

test('Room shows the epoch once there is a group', t => {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const state = createRealisticState()
        state.roomId.value = 'abcdeFGH12'

        const before = findByClass(room(state), 'epoch')
        t.equal(
            before.length,
            0,
            'should show no epoch while there is no group'
        )

        // A stand-in for ClientState keeps this a rendering test rather
        // than an MLS one. The empty tree is a group of nobody, which is
        // impossible in MLS but is the least this assertion needs.
        state.group.value = {
            groupContext: { epoch: 7n },
            ratchetTree: [],
            privatePath: { leafIndex: 0, privateKeys: {} }
        } as unknown as typeof state.group.value

        const after = findByClass(room(state), 'epoch')
        t.equal(after.length, 1, 'should show one epoch once joined')
        t.deepEqual(
            childrenOf(after[0]).filter(kid => kid !== undefined),
            ['7'],
            'the epoch should be the group context epoch'
        )
    } finally {
        g.location = previous
    }
})

// realistic-demo.AC4.1 -- the creator sees who has asked to join

let cs:CiphersuiteImpl
let bobRequest:PendingRequest
let stolenRequest:PendingRequest

test('the view fixtures build', async (t) => {
    cs = await initCiphersuite()
    const bob = await createUser('Bob', cs)
    const mallory = await createUser('Mallory', cs)

    bobRequest = {
        identity: identityOf(bob.keyPackage!),
        keyPackage: encodeKeyPackageB64(bob.keyPackage!),
        requestedAt: 1,
        standing: 'stranger'
    }

    // The two fields of a join request are separate, and the room
    // stores whatever a socket says in both -- it cannot parse a key
    // package, so it cannot check that they agree. This is one that
    // does not: Mallory's identity, Bob's key package.
    stolenRequest = {
        identity: identityOf(mallory.keyPackage!),
        keyPackage: encodeKeyPackageB64(bob.keyPackage!),
        requestedAt: 1,
        standing: 'stranger'
    }

    t.ok(bobRequest.keyPackage, 'should encode a real key package')
    t.notEqual(
        stolenRequest.identity,
        bobRequest.identity,
        'and the mismatched request claims a different identity'
    )
})

/**
 * A room where somebody has asked to join. `location` is stubbed the
 * same way the tests above stub it, because Room reads `origin`.
 */
function pendingRoom (opts:{
    isCreator:boolean
    requests:PendingRequest[]
    onApprove? (request:PendingRequest):void
    onDeny? (identity:string):void
}) {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const state = createRealisticState()
        state.roomId.value = 'abcdeFGH12'
        state.isCreator.value = opts.isCreator
        state.pending.value = opts.requests

        return room(state, {
            onApprove: opts.onApprove,
            onDeny: opts.onDeny
        })
    } finally {
        g.location = previous
    }
}

test('Room shows the pending list to the creator and nobody else', t => {
    const asCreator = pendingRoom({
        isCreator: true,
        requests: [bobRequest]
    })
    t.equal(
        findByClass(asCreator, 'request').length,
        1,
        'the creator sees one request'
    )
    t.equal(
        findByClass(asCreator, 'approve').length,
        1,
        'with a control to admit them'
    )
    t.equal(
        findByClass(asCreator, 'deny').length,
        1,
        'and one to refuse them'
    )

    // The polarity that matters: the same state, minus the creator
    // flag, must offer neither control. Asserting only the creator case
    // would pass against a view that shows this to everybody.
    const asMember = pendingRoom({
        isCreator: false,
        requests: [bobRequest]
    })
    t.equal(
        findByClass(asMember, 'request').length,
        0,
        'a member is shown no requests'
    )
    t.equal(
        findByClass(asMember, 'approve').length,
        0,
        'and no approve control'
    )
    t.equal(
        findByClass(asMember, 'deny').length,
        0,
        'and no deny control'
    )
})

test('Room reads the requester name out of the key package', t => {
    const tree = pendingRoom({ isCreator: true, requests: [bobRequest] })
    const names = findByClass(tree, 'requester-name')

    t.equal(names.length, 1, 'should name the requester')
    t.deepEqual(
        childrenOf(names[0]).filter(kid => kid !== undefined),
        ['Bob'],
        'the name comes from the credential, which the room never holds'
    )
})

test('Room still lists a request whose key package will not decode', t => {
    const tree = pendingRoom({
        isCreator: true,
        requests: [{ ...bobRequest, keyPackage: 'AQID' }]
    })

    t.equal(
        findByClass(tree, 'request').length,
        1,
        'an unreadable request is shown rather than dropped'
    )
    t.equal(
        findByClass(tree, 'approve')[0].props.disabled,
        true,
        'but it cannot be approved, because there is nothing to add'
    )
})

test('Room refuses to approve a key package the asker does not own', t => {
    const stolen = pendingRoom({
        isCreator: true,
        requests: [stolenRequest]
    })

    t.equal(
        findByClass(stolen, 'request').length,
        1,
        'the request is shown rather than hidden'
    )
    t.equal(
        findByClass(stolen, 'approve')[0].props.disabled,
        true,
        'but it cannot be approved: the key package is somebody else\'s'
    )
    t.equal(
        findByClass(stolen, 'mismatch-warning').length,
        1,
        'and the page says why, rather than leaving a dead control'
    )

    // The polarity that matters. A view that disabled every Approve
    // would pass the assertion above on its own.
    const honest = pendingRoom({
        isCreator: true,
        requests: [bobRequest]
    })

    t.equal(
        findByClass(honest, 'approve')[0].props.disabled,
        false,
        'and a request whose key package does match is approvable'
    )
    t.equal(
        findByClass(honest, 'mismatch-warning').length,
        0,
        'with no warning against it'
    )
})

test('Room marks each requester standing, previously-removed apart', t => {
    const standings:Standing[] = [
        'stranger',
        'pre-approved',
        'previously-removed'
    ]

    const tree = pendingRoom({
        isCreator: true,
        requests: standings.map((standing, i) => ({
            ...bobRequest,
            identity: `identity-${i}`,
            standing
        }))
    })

    t.deepEqual(
        findByClass(tree, 'request').map(node => node.props['data-standing']),
        standings,
        'every request carries the standing the room reported'
    )

    // Re-admitting someone previously removed is the decision worth
    // pausing over, so it gets its own mark rather than only a word.
    const warnings = findByClass(tree, 'standing-warning')
    t.equal(
        warnings.length,
        1,
        'only the previously-removed request is called out'
    )

    const strangerOnly = pendingRoom({
        isCreator: true,
        requests: [{ ...bobRequest, standing: 'stranger' }]
    })
    t.equal(
        findByClass(strangerOnly, 'standing-warning').length,
        0,
        'and a stranger is not'
    )
})

test('Room reports which request was approved or denied', t => {
    const approved:PendingRequest[] = []
    const denied:string[] = []

    const tree = pendingRoom({
        isCreator: true,
        requests: [bobRequest],
        onApprove: (request) => { approved.push(request) },
        onDeny: (identity) => { denied.push(identity) }
    })

    ;(findByClass(tree, 'approve')[0].props.onClick as () => void)()
    t.deepEqual(
        approved,
        [bobRequest],
        'approving reports the whole request, key package and all'
    )

    ;(findByClass(tree, 'deny')[0].props.onClick as () => void)()
    t.deepEqual(
        denied,
        [bobRequest.identity],
        'denying reports the identity the room keys the row by'
    )
})

function waiting (props:Partial<Parameters<typeof Waiting>[0]> = {}) {
    return Waiting({
        url: 'https://demo.test/abcdeFGH12',
        name: 'Alice',
        status: 'Waiting',
        persist: false,
        ...props
    }, {})
}

// realistic-demo.AC3.1 -- the request is published and the wait is shown

test('Waiting shows the room it is waiting on and the name given', t => {
    const tree = waiting({
        url: 'https://demo.test/zzzzzzzzzz',
        name: 'Bob'
    })

    const links = findByType(tree, 'a')
    t.equal(links.length, 1, 'should render one link to the room')
    t.equal(
        links[0].props.href,
        'https://demo.test/zzzzzzzzzz',
        'the link should point at the room it is waiting on'
    )

    const named = findByClass(tree, 'chosen-name')
    t.equal(named.length, 1, 'should show the name that was chosen')
    t.deepEqual(
        childrenOf(named[0]).filter(kid => kid !== undefined),
        ['Bob'],
        'the name should be the one it was given'
    )
})

test('Waiting reports the status it is given', t => {
    const tree = waiting({ status: 'Published the request.' })
    const status = findByClass(tree, 'status')

    t.equal(status.length, 1, 'should render one status line')
    t.equal(
        status[0].props.role,
        'status',
        'the status should announce itself to a screen reader'
    )
    t.deepEqual(
        childrenOf(status[0]).filter(kid => kid !== undefined),
        ['Published the request.'],
        'the status should be the one it was given'
    )
})

// realistic-demo.AC5.1 -- the member list is the client's own tree

/**
 * A leaf carrying only what the member list reads. Nothing here is
 * signed, which is the point: the list is derived from the tree, so a
 * tree is all the view needs.
 */
function fixtureLeaf (name:string, signatureKey:number[]):Node {
    return {
        nodeType: 'leaf',
        leaf: {
            hpkePublicKey: new Uint8Array(),
            signaturePublicKey: new Uint8Array(signatureKey),
            credential: {
                credentialType: 'basic',
                identity: new TextEncoder().encode(name)
            },
            capabilities: defaultCapabilities(),
            leafNodeSource: 'update',
            extensions: [],
            signature: new Uint8Array()
        }
    }
}

const aliceLeaf = fixtureLeaf('Alice', [1, 1, 1])
const bobLeaf = fixtureLeaf('Bob', [2, 2, 2])
// Two members may show the same name -- a name is a credential, not an
// identifier, and nothing stops two people choosing one. Which row is
// this client has to follow the leaf index.
const twinLeaf = fixtureLeaf('Alice', [3, 3, 3])
const aliceIdentity = bytesToBase64url(new Uint8Array([1, 1, 1]))
const bobIdentity = bytesToBase64url(new Uint8Array([2, 2, 2]))

/**
 * A room whose group is the two-leaf tree above, or `tree` when a case
 * needs leaves that one does not have. `ownLeaf` is the leaf this
 * client sits at, which is how the view knows not to offer a Remove
 * against the person looking at it. `userName` sets the session user,
 * which only the leaf-not-in-the-tree fallback reads.
 *
 * Returns the state beside the tree, for the tests that assert on what
 * a callback did to it. Most callers want `memberRoom` below.
 */
function memberRoomState (opts:{
    isCreator?:boolean
    live?:string[]
    ownLeaf?:number
    removed?:boolean
    tree?:RatchetTree
    userName?:string
    onRemove? (member:Member):void
}) {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const tree:RatchetTree = opts.tree ??
            [aliceLeaf, undefined, bobLeaf]
        const state = createRealisticState()

        state.roomId.value = 'abcdeFGH12'
        state.isCreator.value = opts.isCreator ?? false
        state.live.value = opts.live ?? []
        state.removed.value = opts.removed ?? false
        state.group.value = {
            groupContext: { epoch: 2n },
            ratchetTree: tree,
            privatePath: { leafIndex: opts.ownLeaf ?? 0, privateKeys: {} }
        } as unknown as typeof state.group.value

        if (opts.userName !== undefined) {
            state.user.value = {
                name: opts.userName
            } as unknown as typeof state.user.value
        }

        return { tree: room(state, { onRemove: opts.onRemove }), state }
    } finally {
        g.location = previous
    }
}

/** The same room, when only the rendered tree is wanted. */
function memberRoom (opts:Parameters<typeof memberRoomState>[0]) {
    return memberRoomState(opts).tree
}

test('Room lists every member of its own tree, by name', t => {
    const tree = memberRoom({})
    const members = findByClass(tree, 'member')

    t.equal(members.length, 2, 'should render one item per occupied leaf')
    t.deepEqual(
        findByClass(tree, 'member-name').map(node => {
            return childrenOf(node).filter(kid => typeof kid === 'string')
        }),
        [['Alice'], ['Bob']],
        'should name each member from the credential in their leaf'
    )
})

// realistic-demo.AC5.2 -- liveness is separate from membership

test('Room marks who is connected without unlisting anyone', t => {
    const tree = memberRoom({ live: [aliceIdentity] })
    const members = findByClass(tree, 'member')

    t.equal(
        members.length,
        2,
        'a member nobody can see is still a member'
    )
    t.deepEqual(
        members.map(node => node.props['data-connected']),
        [true, false],
        'only the identity the roster named is marked connected'
    )

    const bothLive = findByClass(
        memberRoom({ live: [aliceIdentity, bobIdentity] }),
        'member'
    )
    t.deepEqual(
        bothLive.map(node => node.props['data-connected']),
        [true, true],
        'and both are marked when the roster names both'
    )
})

// part of realistic-demo.AC10.6 -- the disclosures

test('Room says a disconnected member is still in the group', t => {
    const tree = memberRoom({ live: [aliceIdentity] })
    t.equal(
        findByClass(tree, 'presence-disclosure').length,
        1,
        'should render the disclosure beside the member list'
    )
})

test('Room says creator-only removal is interface, not cryptography', t => {
    t.equal(
        findByClass(memberRoom({ isCreator: true }), 'removal-disclosure')
            .length,
        1,
        'the creator is told the rule is theirs to enforce'
    )
    t.equal(
        findByClass(memberRoom({ isCreator: false }), 'removal-disclosure')
            .length,
        1,
        'and so is everybody else, who could commit a Remove anyway'
    )
})

// realistic-demo.AC5.3 -- the Remove control is the creator's

test('Room offers Remove to the creator and to nobody else', t => {
    t.equal(
        findByClass(memberRoom({ isCreator: true }), 'remove').length,
        1,
        'the creator can remove the other member'
    )
    t.equal(
        findByClass(memberRoom({ isCreator: false }), 'remove').length,
        0,
        'a member who is not the creator can remove nobody'
    )
})

test('Room never offers Remove against the person looking at it', t => {
    const asLeafZero = findByClass(
        memberRoom({ isCreator: true, ownLeaf: 0 }),
        'member'
    )
    t.deepEqual(
        asLeafZero.map(node => findByClass(node, 'remove').length),
        [0, 1],
        'the leaf this client sits at has no Remove control'
    )

    const asLeafTwo = findByClass(
        memberRoom({ isCreator: true, ownLeaf: 1 }),
        'member'
    )
    t.deepEqual(
        asLeafTwo.map(node => findByClass(node, 'remove').length),
        [1, 0],
        'and it moves with the leaf, rather than always being the first'
    )
})

test('Room reports which member to remove, with their leaf index', t => {
    const removed:Member[] = []
    const tree = memberRoom({
        isCreator: true,
        onRemove: (member) => { removed.push(member) }
    })

    ;(findByClass(tree, 'remove')[0].props.onClick as () => void)()

    t.equal(removed.length, 1, 'clicking should report one member')
    t.equal(
        removed[0]?.identity,
        bobIdentity,
        'the identity the room and the tree agree on'
    )
    t.equal(
        removed[0]?.leafIndex,
        1,
        'and the leaf index a Remove proposal names'
    )
})

test('Room says who this client is', t => {
    const tree = memberRoom({})

    const you = findByClassToken(tree, 'you')
    t.equal(you.length, 1, 'should render one You block')

    // Phase 4's rules reach the block through `.room-meta`, so where it
    // sits is part of the contract, not an accident of writing order.
    const meta = findByClass(tree, 'room-meta')
    t.equal(meta.length, 1, 'the room has one meta column')
    t.equal(
        findByClassToken(meta[0], 'you').length,
        1,
        'the You block sits inside the meta column'
    )

    t.deepEqual(
        findByClass(tree, 'own-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Alice']],
        'should name this client from its own leaf'
    )
    t.deepEqual(
        findByClass(tree, 'own-identity').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [[aliceIdentity]],
        'should show the whole signature public key'
    )
    t.deepEqual(
        findByClass(tree, 'own-leaf').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['0']],
        'should show the leaf index the group holds'
    )
})

test('the You block follows the leaf, not the first member', t => {
    const tree = memberRoom({ ownLeaf: 1 })

    t.deepEqual(
        findByClass(tree, 'own-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Bob']],
        'the name should come from the leaf this client sits at'
    )
    t.deepEqual(
        findByClass(tree, 'own-identity').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [[bobIdentity]],
        'and so should the key'
    )
    t.deepEqual(
        findByClass(tree, 'own-leaf').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['1']],
        'and so should the leaf index'
    )
})

test('the You block says which of the two roles this client has', t => {
    const asCreator = findByClass(
        memberRoom({ isCreator: true }),
        'own-role'
    )
    t.equal(asCreator.length, 1, 'should render one role')
    t.equal(
        asCreator[0].props['data-role'],
        'creator',
        'the room creator is marked as the creator'
    )

    const asMember = findByClass(
        memberRoom({ isCreator: false }),
        'own-role'
    )
    t.equal(
        asMember[0].props['data-role'],
        'member',
        'and everybody else is marked a member'
    )
})

test('the You block survives a leaf that is not in the tree', t => {
    const tree = memberRoom({ ownLeaf: 5, userName: 'Zara' })

    t.equal(
        findByClassToken(tree, 'you').length,
        1,
        'the block is still rendered'
    )
    t.deepEqual(
        findByClass(tree, 'own-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Zara']],
        'the name falls back to the one held for the session'
    )
    t.equal(
        findByClass(tree, 'own-identity').length,
        0,
        'and there is no key to show, so no key row'
    )
})

test('the You block offers to copy the key, named for the key', t => {
    const tree = memberRoom({})
    const copies = allNodes(tree).filter(node => {
        return (node.type as unknown) === CopyValue
    })

    t.equal(copies.length, 1, 'should render one copy control')
    t.equal(
        copies[0].props.value,
        aliceIdentity,
        'it should copy the key, not the room URL'
    )

    // Both names are read out of the components rather than written
    // here, so this fails if either one changes to match the other.
    const linkLabel = findByClass(roomLink({}), 'copy')[0]
        .props['aria-label']
    t.ok(linkLabel, 'the room link copy button has a name')
    t.ok(copies[0].props.label, 'the key copy button has a name')
    t.notEqual(
        copies[0].props.label,
        linkLabel,
        'the two copy controls in this column are named differently'
    )
})

test('a refused copy of the key is reported to the person', t => {
    const { tree, state } = memberRoomState({})
    const before = state.status.value

    const copies = allNodes(tree).filter(node => {
        return (node.type as unknown) === CopyValue
    })
    ;(copies[0].props.onError as (err:unknown) => void)(
        new Error('no clipboard')
    )

    t.notEqual(
        state.status.value,
        before,
        'the refusal should reach the status line'
    )
    // The confirmation half of this criterion is asserted where it can
    // actually fail, in `CopyControl confirms a copy only once one has
    // happened`. It cannot be asserted here: `CopyValue` calls
    // `useSignal`, so it sits in this tree unexpanded -- which is how
    // the line above finds it by type -- and a search for its
    // confirmation finds nothing whatever the code does. Clearing
    // `copied` on a refusal lives inside that unexpanded component and
    // is recorded as uncovered in ac-coverage.md.
    t.ok(
        state.status.value.includes('no clipboard'),
        'and the status should say what went wrong'
    )
})

test('the You block says a name is not hidden from the server', t => {
    const you = findByClassToken(memberRoom({}), 'you')[0]

    t.equal(
        findByClass(you, 'name-disclosure').length,
        1,
        'the disclosure sits with the name it is about'
    )
})

/** The `own-mark` text inside `row`, for asserting on its shape. */
function markText (row:unknown):string {
    const mark = findByClass(row, 'own-mark')[0]
    return childrenOf(mark)
        .filter(kid => typeof kid === 'string')
        .join('')
}

test('Room marks which member is the person looking at it', t => {
    const members = findByClass(memberRoom({ ownLeaf: 1 }), 'member')

    t.deepEqual(
        members.map(node => node.props['data-own']),
        [false, true],
        'exactly one row is this client'
    )
    t.deepEqual(
        members.map(node => findByClass(node, 'own-mark').length),
        [0, 1],
        'and the mark is on that row, in words, not only in CSS'
    )

    // Not the wording -- the separation. htm strips the whitespace-only
    // text around a newline, so a marker written without this leading
    // space flattens into the name and announces as one word. No CSS
    // reaches that: margin is box-model, the accessible text run is not.
    t.ok(
        /^\s/.test(markText(members[1])),
        'the marker is separated from the name it annotates'
    )
})

test('the mark follows the leaf when two members share a name', t => {
    const members = findByClass(
        memberRoom({ tree: [aliceLeaf, undefined, twinLeaf], ownLeaf: 1 }),
        'member'
    )

    t.equal(members.length, 2, 'both members are listed')
    t.deepEqual(
        members.map(node => {
            return childrenOf(findByClass(node, 'member-name')[0])
                .filter(kid => typeof kid === 'string')
        }),
        [['Alice'], ['Alice']],
        'and they are telling the truth: the names are the same'
    )
    t.deepEqual(
        members.map(node => node.props['data-own']),
        [false, true],
        'the mark follows the leaf index, not the name'
    )
})

test('Room marks this client in the connected list, when it is in it', t => {
    // Two keys, not one. A single-item list cannot tell a mark on the
    // right row from a mark on every row, which is the discipline the
    // member tests above already follow.
    const marked = findByType(
        findByClass(
            memberRoom({ live: [bobIdentity, aliceIdentity] }),
            'live'
        )[0],
        'li'
    )

    t.deepEqual(
        marked.map(node => node.props['data-own']),
        [false, true],
        'the key this client holds is marked, and only that one'
    )
    t.deepEqual(
        marked.map(node => findByClass(node, 'own-mark').length),
        [0, 1],
        'and it says so in words, on that row only'
    )
    // The key is 43 characters with no spaces in it, so a marker that
    // ran on to the end of it would be worse here than in the name
    // list. See the note in the member test above.
    t.ok(
        /^\s/.test(markText(marked[1])),
        'the marker is separated from the key it follows'
    )

    const others = findByType(
        findByClass(memberRoom({ live: [bobIdentity] }), 'live')[0],
        'li'
    )
    t.deepEqual(
        others.map(node => node.props['data-own']),
        [false],
        'and somebody else holding a socket is not marked'
    )
})

test('Room marks nobody live when this client is not connected', t => {
    // A roster with somebody on it, and that somebody is not us. An
    // empty list would pass against code that never marks anything.
    const live = findByClass(memberRoom({ live: [bobIdentity] }), 'live')[0]

    t.equal(
        findByType(live, 'li').length,
        1,
        'somebody is holding a socket open'
    )
    t.equal(
        findByClass(live, 'own-mark').length,
        0,
        'but it is not this client, so nothing is marked'
    )
})

test('Room says what the room routes on, beside the keys', t => {
    t.equal(
        findByClass(memberRoom({}), 'identity-disclosure').length,
        1,
        'the disclosure still heads the list it is about'
    )
})

// realistic-demo.AC5.5 -- being removed

test('Room says plainly when this client was removed', t => {
    const tree = memberRoom({ removed: true })

    t.equal(
        findByClass(tree, 'removed').length,
        1,
        'should render the removed notice'
    )
    t.equal(
        findByClass(tree, 'members').length,
        0,
        'and stop showing a member list it can no longer follow'
    )
    t.equal(
        findByClass(tree, 'remove').length,
        0,
        'and offer no controls that would need the group'
    )
    t.equal(
        findByClass(tree, 'composer').length,
        0,
        'and no composer for a group it can no longer write to'
    )
})

// realistic-demo.AC6 -- the chat pane

/**
 * A room whose timeline is whatever the caller sets up. The tree is the
 * two-leaf fixture above, so `alice` and `bob` are names the view can
 * actually resolve a sender to.
 */
function chatRoom (opts:{
    entries?:LogEntry[]
    decrypted?:Record<number, string>
    outbound?:SentMessage[]
    draft?:string
    joinCursor?:number
    priorCount?:number
    onSend? (text:string):void
}) {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const tree:RatchetTree = [aliceLeaf, undefined, bobLeaf]
        const state = createRealisticState()

        state.roomId.value = 'abcdeFGH12'
        state.entries.value = opts.entries ?? []
        state.decrypted.value = opts.decrypted ?? {}
        state.outbound.value = opts.outbound ?? []
        state.draft.value = opts.draft ?? ''
        state.joinCursor.value = opts.joinCursor ?? 0
        state.priorCount.value = opts.priorCount ?? 0
        state.group.value = {
            groupContext: { epoch: 2n },
            ratchetTree: tree,
            privatePath: { leafIndex: 0, privateKeys: {} }
        } as unknown as typeof state.group.value

        return room(state, { onSend: opts.onSend })
    } finally {
        g.location = previous
    }
}

function appEntry (seq:number, sender:string):LogEntry {
    return { seq, sender, kind: 'application', payload: 'opaque' }
}

test('Room renders a decrypted message with the sender\'s name', t => {
    const tree = chatRoom({
        entries: [appEntry(1, bobIdentity)],
        decrypted: { 1: 'hello' }
    })

    const messages = findByClass(tree, 'message')
    t.equal(messages.length, 1, 'should render one message')
    t.equal(
        messages[0].props['data-seq'],
        1,
        'carrying the seq the room gave it'
    )
    t.deepEqual(
        findByClass(messages[0], 'message-from').flatMap(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        ['Bob'],
        'named from the ratchet tree, which is the only place a name is'
    )
    t.equal(
        findByClass(tree, 'placeholder').length,
        0,
        'and nothing is a placeholder'
    )
})

// realistic-demo.AC6.3 / AC6.4 -- placeholders, through the pure fold

test('Room renders unreadable entries as counted placeholders', t => {
    const tree = chatRoom({
        entries: [
            appEntry(4, bobIdentity),
            appEntry(5, bobIdentity),
            appEntry(6, bobIdentity)
        ],
        decrypted: { 6: 'this one I can read' },
        joinCursor: 3,
        priorCount: 2
    })

    const placeholders = findByClass(tree, 'placeholder')
    t.equal(
        placeholders.length,
        2,
        'the run before the join, and the run after'
    )
    t.deepEqual(
        placeholders.map(node => node.props['data-reason']),
        ['before-join', 'undecryptable'],
        'each saying which of the two it is'
    )
    t.deepEqual(
        placeholders.map(node => node.props['data-count']),
        [2, 2],
        'and how many entries it stands for'
    )
    t.equal(
        findByClass(tree, 'message').length,
        1,
        'with the readable one rendered as itself'
    )
})

// realistic-demo.AC6.6 -- a member who joined at epoch zero

test('Room shows no leading placeholder for a founding member', t => {
    const tree = chatRoom({
        entries: [appEntry(1, bobIdentity)],
        decrypted: { 1: 'hello' },
        joinCursor: 0,
        priorCount: 0
    })

    t.equal(
        findByClass(tree, 'placeholder').length,
        0,
        'nothing preceded a client that was there from the start'
    )
})

test('Room shows its own unsent messages, apart from delivered ones', t => {
    const tree = chatRoom({
        entries: [appEntry(1, bobIdentity)],
        decrypted: { 1: 'from bob' },
        outbound: [
            { payload: 'ciphertext-one', text: 'mine one' },
            { payload: 'ciphertext-two', text: 'mine two' }
        ]
    })

    t.equal(
        findByClass(tree, 'outbound-message').length,
        2,
        'both of this client\'s own messages are shown'
    )
    t.equal(
        findByClass(tree, 'message').length,
        1,
        'and they are not confused with the one the room numbered'
    )

    // The polarity that matters: with nothing outbound, none of these
    // rows appear at all.
    t.equal(
        findByClass(chatRoom({}), 'outbound-message').length,
        0,
        'and a client that has said nothing shows none'
    )
})

test('Room composer reports what was typed and what was submitted', t => {
    const said:string[] = []
    const tree = chatRoom({ draft: 'hello', onSend: (t) => { said.push(t) } })

    const inputs = findByClass(tree, 'draft')
    t.equal(inputs.length, 1, 'should render one message field')
    t.equal(inputs[0].props.value, 'hello', 'showing the current draft')

    t.equal(
        typeof inputs[0].props.label,
        'string',
        'with a label property of type string'
    )
    t.ok(
        typeof inputs[0].props.label === 'string' &&
            inputs[0].props.label.length > 0,
        'label is not empty'
    )

    const form = findByClass(tree, 'composer')
    t.equal(form.length, 1, 'should render one composer')

    let prevented = 0
    ;(form[0].props.onSubmit as (ev:{ preventDefault ():void }) => void)({
        preventDefault: () => { prevented = prevented + 1 }
    })

    t.equal(prevented, 1, 'submitting does not navigate')
    t.deepEqual(said, ['hello'], 'and reports the draft that was typed')
})

test('Room composer records what is being typed', t => {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const state = createRealisticState()
        state.roomId.value = 'abcdeFGH12'

        // The transition is what is asserted, not the value: `draft`
        // starts empty, so a view that never writes it would satisfy an
        // assertion about the empty case on its own.
        t.equal(state.draft.value, '', 'nothing typed yet')
        t.equal(
            findByClass(room(state), 'send')[0].props.disabled,
            true,
            'and so nothing to send'
        )

        const input = findByClass(room(state), 'draft')[0]
        const onInput = input.props.onInput as
            (ev:{ currentTarget:{ value:string } }) => void

        onInput({ currentTarget: { value: 'well hello' } })

        t.equal(
            state.draft.value,
            'well hello',
            'typing reaches the signal the composer reads back'
        )
        t.equal(
            findByClass(room(state), 'send')[0].props.disabled,
            false,
            'which is what lets the message be sent at all'
        )
    } finally {
        g.location = previous
    }
})

test('Room will not send an empty message', t => {
    t.equal(
        findByClass(chatRoom({ draft: '' }), 'send')[0].props.disabled,
        true,
        'an empty draft disables the send control'
    )
    t.equal(
        findByClass(chatRoom({ draft: '   ' }), 'send')[0].props.disabled,
        true,
        'and so does one of only spaces'
    )
    t.equal(
        findByClass(chatRoom({ draft: 'hi' }), 'send')[0].props.disabled,
        false,
        'while a real message enables it'
    )
})

// part of realistic-demo.AC10.6 -- what a placeholder means

test('Room says what a placeholder stands for', t => {
    t.equal(
        findByClass(chatRoom({}), 'placeholder-disclosure').length,
        1,
        'the explanation stands beside the timeline, always'
    )
})

// realistic-demo.AC7.1 -- persist is a standing control

function persistence (
    props:Partial<Parameters<typeof Persistence>[0]> = {}
) {
    return Persistence({
        persist: false,
        storage: 'best-effort',
        request: 'idle',
        onToggle: () => {},
        onRequest: () => {},
        onReset: () => {},
        ...props
    }, {})
}

test('Persistence offers a toggle that reflects and reports its state', t => {
    const reported:boolean[] = []
    const off = persistence({ onToggle: (on) => { reported.push(on) } })

    const toggles = findByClass(off, 'persist-toggle')
    t.equal(toggles.length, 1, 'should render one toggle')

    const boxes = findByType(off, 'check-box')
    t.equal(boxes.length, 1, 'as a checkbox')
    t.equal(boxes[0].props.checked, false, 'unchecked when persistence is off')

    ;(boxes[0].props.onChange as (ev:{
        currentTarget:{ checked:boolean }
    }) => void)({ currentTarget: { checked: true } })
    t.deepEqual(reported, [true], 'and reports being switched on')

    const on = persistence({ persist: true })
    t.equal(
        findByType(on, 'check-box')[0].props.checked,
        true,
        'checked when persistence is on'
    )
})

test('Persistence says what is stored and where', t => {
    const tree = persistence()

    t.equal(
        findByClass(tree, 'persist-disclosure').length,
        1,
        'the toggle is not offered without saying what it writes'
    )
    t.equal(
        findByClass(tree, 'reset-disclosure').length,
        1,
        'and Delete is not offered without saying what it takes'
    )

    // What it writes is not the whole of what a reader assumes from
    // "remember this session". The record holds no plaintext, so a
    // restored page comes back into the group with an empty history --
    // said here rather than discovered, since it is the one thing the
    // control does that would otherwise look like a bug.
    t.equal(
        findByClass(tree, 'history-disclosure').length,
        1,
        'and it says the messages are not part of what is kept'
    )
})

test('Persistence reuses the shared storage panel', t => {
    // Rather than a second, drifting description of the same browser
    // answer. See `example-shared/storage-panel.ts`.
    const panels = allNodes(persistence({ storage: 'persistent' }))
        .filter(node => (node.type as unknown) === StoragePanel)

    t.equal(panels.length, 1, 'should render one storage panel')
    t.equal(
        panels[0].props.status,
        'persistent',
        'told the status the page holds'
    )
})

// realistic-demo.AC7.6 -- Reset is its own control

test('Persistence offers a reset that reports itself', t => {
    let resets = 0
    const tree = persistence({ onReset: () => { resets = resets + 1 } })

    const buttons = findByClass(tree, 'reset')
    t.equal(buttons.length, 1, 'should render one delete control')

    ;(buttons[0].props.onClick as () => void)()
    t.equal(resets, 1, 'clicking it reports the request')
})

// realistic-demo.AC8.4 -- the gone view

function gone (props:Partial<Parameters<typeof Gone>[0]> = {}) {
    return Gone({ onCreateNew: () => {}, ...props }, {})
}

test('Gone offers a way to start a new room', t => {
    let asked = 0
    const buttons = findByClass(
        gone({ onCreateNew: () => { asked = asked + 1 } }),
        'create-new'
    )

    t.equal(buttons.length, 1, 'should render one control')

    ;(buttons[0].props.onClick as () => void)()
    t.equal(asked, 1, 'clicking it reports the request')
})

test('Gone says both cases at once, having no way to tell them apart', t => {
    // An expired room and an id that never existed give the same answer,
    // so there is one disclosure covering both rather than a branch.
    t.equal(
        findByClass(gone(), 'gone-disclosure').length,
        1,
        'should say both are possible, in one place'
    )
    t.equal(
        findByType(gone(), 'h1').length,
        1,
        'under one heading, not one heading per case'
    )
})

// realistic-demo.AC10.6 -- the explainer

function explainer (
    props:Partial<Parameters<typeof Explainer>[0]> = {}
) {
    return Explainer({ expiresAt: null, ...props }, {})
}

test('every room step says what to do and why', t => {
    for (const step of ROOM_STEPS) {
        t.ok(step.title.length > 0, `${step.id} should name the action`)
        t.ok(step.detail.length > 0, `${step.id} should say what it does`)
    }

    t.equal(
        new Set(ROOM_STEPS.map(step => step.id)).size,
        ROOM_STEPS.length,
        'each step should have its own id'
    )
})

test('Explainer introduces the demo and reuses the how-to card', t => {
    const tree = explainer()

    const cards = allNodes(tree)
        .filter(node => (node.type as unknown) === HowToUse)

    t.equal(cards.length, 1, 'should render one how-to-use card')
    t.deepEqual(
        cards[0].props.steps,
        ROOM_STEPS,
        'told this room\'s steps rather than another demo\'s'
    )
})

test('Explainer names what the delivery service is trusted for', t => {
    t.equal(
        findByClass(explainer(), 'trust-disclosure').length,
        1,
        'should say what the delivery service is trusted for'
    )
})

test('Explainer shows the expiry only once the room has given one', t => {
    t.equal(
        findByClass(explainer({ expiresAt: null }), 'expiry').length,
        0,
        'nothing is claimed about expiry before the room says'
    )

    const shown = findByClass(explainer({ expiresAt: 1900000000000 }), 'expiry')
    t.equal(shown.length, 1, 'should render the expiry once it is known')
    t.equal(
        shown[0].props['data-expires'],
        1900000000000,
        'the moment shown should be the one the room gave'
    )
})

// realistic-demo.AC7.1 -- the waiting disclosure follows the preference

test('Waiting says to keep the tab open only when nothing is stored', t => {
    const off = findByClass(waiting({ persist: false }), 'disclosure')
    t.equal(off.length, 1, 'should render one disclosure')
    t.equal(
        off[0].props['data-persist'],
        false,
        'with nothing stored, the key lives only in this page'
    )

    const on = findByClass(waiting({ persist: true }), 'disclosure')
    t.equal(on.length, 1, 'should still render one disclosure')
    t.equal(
        on[0].props['data-persist'],
        true,
        'with the session kept, closing the tab is survivable'
    )

    // Not what either one says -- only that they are not the same
    // sentence. A flag that changes the attribute and leaves the
    // paragraph alone would be worse than no flag: the page would look
    // like it had followed the preference while telling you the
    // opposite of what is true.
    t.equal(
        JSON.stringify(childrenOf(off[0])) ===
            JSON.stringify(childrenOf(on[0])),
        false,
        'the two should not be the same paragraph'
    )
})

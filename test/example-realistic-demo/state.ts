import { test } from '@substrate-system/tapzero'
import { batch } from '@preact/signals'
import type { ClientState } from '../../src/index.js'
import type { DemoUser } from '../../example-shared/demo-user.js'
import {
    createRealisticState
} from '../../example-realistic-demo/client/state.js'

/**
 * The only logic in `state.ts` is the derived view, so that is what
 * these cover. Placeholders are enough: the derivation reads presence,
 * never a field.
 */
function user (name:string):DemoUser {
    return { name }
}

function group ():ClientState {
    return {} as unknown as ClientState
}

test('the view starts at setup', (t) => {
    const state = createRealisticState()
    t.equal(state.view.value, 'setup')
})

test('a user without a room is still setup', (t) => {
    const state = createRealisticState()
    state.user.value = user('alice')
    t.equal(state.view.value, 'setup')
})

test('a room without a user is still setup', (t) => {
    const state = createRealisticState()
    state.roomId.value = 'aB3xK9pQ2m'
    t.equal(state.view.value, 'setup')
})

test('a user and a room with no group is waiting', (t) => {
    const state = createRealisticState()
    batch(() => {
        state.user.value = user('alice')
        state.roomId.value = 'aB3xK9pQ2m'
    })
    t.equal(state.view.value, 'waiting')
})

test('a group turns waiting into room', (t) => {
    const state = createRealisticState()
    batch(() => {
        state.user.value = user('alice')
        state.roomId.value = 'aB3xK9pQ2m'
    })
    t.equal(state.view.value, 'waiting')
    state.group.value = group()
    t.equal(state.view.value, 'room')
})

test('a missing room beats a fully joined room', (t) => {
    const state = createRealisticState()
    batch(() => {
        state.user.value = user('alice')
        state.roomId.value = 'aB3xK9pQ2m'
        state.group.value = group()
    })
    t.equal(state.view.value, 'room')
    state.roomMissing.value = true
    t.equal(state.view.value, 'gone')
})

test('a missing room beats setup as well', (t) => {
    const state = createRealisticState()
    state.roomMissing.value = true
    t.equal(state.view.value, 'gone')
})

test('the view follows the signals back down again', (t) => {
    const state = createRealisticState()
    batch(() => {
        state.user.value = user('alice')
        state.roomId.value = 'aB3xK9pQ2m'
        state.group.value = group()
    })
    t.equal(state.view.value, 'room')
    state.group.value = null
    t.equal(state.view.value, 'waiting')
    state.roomId.value = null
    t.equal(state.view.value, 'setup')
})

test('the connection starts idle and the cursor at zero', (t) => {
    const state = createRealisticState()
    t.equal(state.connection.value, 'idle')
    t.equal(state.cursor.value, 0)
    t.equal(state.priorCount.value, 0)
    t.equal(state.isCreator.value, false)
    t.equal(state.removed.value, false)
    t.equal(state.persist.value, false)
})

test('the timeline starts empty and the join point at zero', (t) => {
    const state = createRealisticState()

    // A client that was there from the start has a join cursor of zero,
    // and `buildTimeline` renders no leading placeholder for it -- so
    // zero is the right value to start at, not a placeholder for
    // "unknown".
    t.equal(state.joinCursor.value, 0)
    t.deepEqual(state.entries.value, [])
    t.deepEqual(state.decrypted.value, {})
    t.deepEqual(state.outbound.value, [])
    t.equal(state.draft.value, '')
})

test('the storage controls start unasked', (t) => {
    const state = createRealisticState()

    // 'best-effort' rather than 'unsupported': the page cannot know
    // which until it has asked the browser, and claiming storage is
    // unavailable before asking would be a false disclosure.
    t.equal(state.storage.value, 'best-effort')
    t.equal(state.persistRequest.value, 'idle')
})

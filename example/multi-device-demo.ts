import { batch, signal, useComputed } from '@preact/signals'
import { type FunctionComponent } from 'preact'
import { useEffect } from 'preact/hooks'
import { html } from 'htm/preact'
import { createDemoState } from './demo-state.js'
import type { DemoUser } from '../example-shared/demo-user.js'
import {
    selectTreeLayout,
    selectNodeDetails,
    rotationKeyChangeCount,
    TIGHT_TREE_LAYOUT
} from './tree-view.js'
import { TreeDiagram, TreeNodeDetailPanel } from './tree-diagram.js'
import { toLeafIndex } from '../src/treemath.js'
import {
    initCiphersuite,
    createUser,
    createMLSGroup,
    addUserToGroup,
    addUsersToGroup,
    removeUsersFromGroup,
    removeUserFromGroup,
    rotateKeys,
    sendMessage,
    decryptMessage
} from './demo-actions.js'
import { DEVICES, clientId } from './devices.js'
import { selectGroupUser } from './participants.js'
import {
    selectUser,
    userExists,
    selectDevice,
    userStartPlan,
    userAddPlan,
    userRemovePlan,
    membershipSummary,
    membershipText,
    describeClient,
    type DeviceRow
} from './user.js'
import {
    userPathNodeIndices,
    userLeafNodeIndices
} from './user-highlight.js'
import { selectDeviceInfo, clearTopSelection } from './device-info.js'
import { rotationStatus } from './device-rotation.js'
import { removalCommitter, removalStatus } from './device-removal.js'
import { DeviceInfoPanel } from './device-info-panel.js'
import {
    canSend,
    sendOptions,
    resolvePendingSender
} from './send-plan.js'
import { selectMessageView, messageRowKey } from './message-view.js'
import { PersonMessageBox } from './message-box.js'
import { EXAMPLE_USERS } from './example-users.js'
import {
    createMemberStore,
    restoredUsersFromRecords
} from '../example-shared/persistence-storage.js'
import { syncPersistedDevices } from './device-sync.js'
import {
    type StorageStatus,
    checkPersisted,
    requestPersistentStorage
} from '../example-shared/storage-persistence.js'
import {
    type PersistRequest,
    StoragePanel,
    persistOutcome
} from '../example-shared/storage-panel.js'
import { partitionDeviceRecords } from './device-restore.js'
import { HowToUse } from '../example-shared/how-to-use.js'
import { bytesToBase64url } from '../src/index.js'
import { EM_DASH, NBSP, SPACE } from '../example-shared/constants.js'

/**
 * The multi-device demo page. Every person here is three separate MLS
 * clients -- a phone, a laptop, and a desktop -- each with its own key
 * package, leaf, and ClientState. The demo state's `users` map is keyed
 * by client id ('Alice/phone'), which is what lets the shared actions in
 * demo-actions.ts be reused unchanged: they only ever see client names.
 */

const state = createDemoState()

// This page's own indexedDB database. Every demo that persists owns one:
// `loadAllMembers` returns the whole store and the restore path deletes
// what it cannot classify, so sharing a database with the persistence
// demo would have each page delete the other's records.
const {
    saveMember,
    deleteMember,
    loadAllMembers,
    deleteDatabase
} = createMemberStore({ dbName: 'mls-multi-device-demo' })

await initCiphersuite(state)

// People whose devices are being generated right now. Three key
// packages take a moment, so the button reports progress rather than
// looking dead.
const creating = signal<Set<string>>(new Set())

function markCreating (user:string, isCreating:boolean):void {
    const next = new Set(creating.value)
    if (isCreating) next.add(user)
    else next.delete(user)
    creating.value = next
}

/**
 * Generate one client per device for `user`. Each device gets its own
 * non-extractable Ed25519 signature keypair, the same approach
 * `createPersistentUser` takes in the persistence demo: the private key
 * bytes are never readable, only usable via `crypto.subtle`. Separate
 * keypairs are the point of the page -- two devices belonging to one
 * person share no key material at all.
 */
/**
 * One device's client: a key package over its own non-extractable
 * Ed25519 signature keypair. Also used to give a removed device a fresh
 * key package, since a consumed one cannot be added to a group twice.
 */
async function createDeviceClient (id:string):Promise<void> {
    const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false, // not extractable
        ['sign', 'verify']
    )

    await createUser(state, id, { signatureKeyPair: keyPair })
}

async function createDevices (user:string):Promise<void> {
    markCreating(user, true)

    try {
        for (const device of DEVICES) {
            await createDeviceClient(clientId(user, device.id))
        }

        state.status.value = `Created ${user}'s ${DEVICES.length} devices`
    } finally {
        markCreating(user, false)
    }
}

// The user whose devices are being put into the group right now.
// Founding the group and adding two devices is three commits' worth of
// crypto, so the button reports progress.
const startingGroup = signal<string|null>(null)

/**
 * Start the group as one person: their phone founds it, then their
 * laptop and desktop are added to it. Each device is an ordinary MLS
 * client, so this is just `createGroup` followed by one add per
 * remaining device -- nothing here tells the library that the three
 * belong to the same human.
 */
async function startGroupAs (user:string):Promise<void> {
    if (state.groupId.value) return  // one group per page

    const plan = userStartPlan(selectUser(user, state.users.value))
    if (!plan) return

    startingGroup.value = user

    try {
        await createMLSGroup(state, plan.creator)
        if (!state.groupId.value) return  // createMLSGroup reported why

        for (const joiner of plan.joiners) {
            await addUserToGroup(state, plan.creator, joiner)
        }

        const inGroup = selectUser(user, state.users.value)
            .filter(row => row.inGroup)
        actor.value = user
        state.status.value = `Group started as ${user}: ` +
            `${inGroup.length} of their devices are in it`
    } finally {
        startingGroup.value = null
    }
}

// The person acting on the group right now. Their first in-group device
// is the client that actually issues the commit -- a person cannot
// commit, only a client can.
const actor = signal<string|null>(null)

// The user action in flight, if any, keyed as 'add:Bob'. One
// commit covering three devices takes a moment.
const committing = signal<string|null>(null)

/**
 * Add a whole user with one commit. `userAddPlan` resolves
 * the person-level request ("Alice adds Bob's devices") into the one
 * committing client and the list of clients its proposals name; the
 * epoch advances once, not once per device.
 */
async function addUser (adder:string, target:string):Promise<void> {
    const users = state.users.value
    const plan = userAddPlan(
        selectUser(adder, users),
        selectUser(target, users)
    )
    if (!plan) return

    committing.value = `add:${target}`

    try {
        const ok = await addUsersToGroup(state, plan.committer, plan.targets)
        // On failure the action has already put the reason in `status`
        // -- overwriting it would claim a commit that never happened.
        if (ok) {
            state.status.value = `${plan.committer} added ${target}'s ` +
                `${plan.targets.length} devices in one commit`
            await syncPersisted()
        }
    } finally {
        committing.value = null
    }
}

// The mirror of addUser: one commit carrying one remove proposal
// per in-group device of the target person.
async function removeUser (
    remover:string,
    target:string
):Promise<void> {
    const users = state.users.value
    const plan = userRemovePlan(
        selectUser(remover, users),
        selectUser(target, users)
    )
    if (!plan) return

    committing.value = `remove:${target}`

    try {
        const ok = await removeUsersFromGroup(
            state,
            plan.committer,
            plan.targets
        )
        if (ok) {
            state.status.value = `${plan.committer} removed ${target}'s ` +
                `${plan.targets.length} devices in one commit`
            await syncPersisted()
        }
    } finally {
        committing.value = null
    }
}

// The client id of the device rotating its keys right now, if any.
const rotating = signal<string|null>(null)

function clientEpoch (
    users:Map<string, DemoUser>,
    id:string
):bigint|null {
    return users.get(id)?.state?.groupContext.epoch ?? null
}

/**
 * Rotate one device's keys. `rotateKeys` takes a client name and this
 * page's clients are named by client id, so a single device rotates on
 * its own: its leaf key and its direct path are replaced, and the
 * person's other devices only process the commit like any other member.
 *
 * The action reports both success and failure through `status`, so the
 * friendlier line is written only when the rotating client's own epoch
 * actually advanced.
 */
async function rotateDevice (id:string):Promise<void> {
    const before = clientEpoch(state.users.value, id)

    rotating.value = id

    try {
        await rotateKeys(state, id)

        const line = rotationStatus(
            id,
            before,
            clientEpoch(state.users.value, id)
        )
        // No line means nothing rotated, and rotateKeys has already put
        // the reason in `status`.
        if (!line) return

        state.status.value = line
        await syncPersisted()
    } finally {
        rotating.value = null
    }
}

// The client ids holding a leaf right now, in the order the devices
// were created. `removalCommitter` prefers one of the target's own
// devices and only falls back to this order, so it decides what "any
// other client" means.
function inGroupClientIds (users:Map<string, DemoUser>):string[] {
    return [...users.entries()]
        .filter(([, user]) => user.state)
        .map(([id]) => id)
}

// The client id of the device being removed right now, if any.
const removingDevice = signal<string|null>(null)

/**
 * Remove one device from the group. MLS forbids committing your own
 * removal, so the commit comes from another client -- one of the same
 * person's devices where there is one, which is what makes the lost
 * phone story read the way it does.
 *
 * `removeUserFromGroup` clears the removed client's state but leaves its
 * consumed key package in place, and a key package cannot be added
 * twice, so the device is given a fresh one. That puts it back in the
 * "created, not in the group" shape, ready to be added again.
 */
async function removeDevice (id:string):Promise<void> {
    const users = state.users.value
    const committer = removalCommitter(inGroupClientIds(users), id)
    if (!committer) return

    const before = clientEpoch(users, committer)

    removingDevice.value = id

    try {
        await removeUserFromGroup(state, committer, id)

        const line = removalStatus(
            committer,
            id,
            before,
            clientEpoch(state.users.value, committer)
        )
        // No line means nothing was removed, and removeUserFromGroup has
        // already put the reason in `status`.
        if (!line) return

        await createDeviceClient(id)

        batch(() => {
            // Device Info would otherwise linger on a client that no
            // longer holds a leaf.
            if (selectedDevice.value === id) selectedDevice.value = null
            state.status.value = line
        })

        // The removed device holds no leaf now, so this is also what
        // drops its saved record.
        await syncPersisted()
    } finally {
        removingDevice.value = null
    }
}

// The client ids whose ClientState has been written to this page's
// database. Storage is per device, the same way membership is: a
// person's three devices are three unrelated records under three keys,
// and persisting one says nothing about the other two.
const persistedIds = signal<Set<string>>(new Set())

// The client id being written right now, if any.
const persisting = signal<string|null>(null)

/**
 * Save one device's own MLS state to indexedDB, keyed by the group id
 * and the client id. Only a device holding a leaf has anything to save
 * -- a key package alone is not group state.
 */
async function persistDevice (id:string):Promise<void> {
    const groupId = state.groupId.value
    const client = state.users.value.get(id)
    if (!groupId || !client?.state) return

    persisting.value = id

    try {
        await saveMember(bytesToBase64url(groupId), id, client.state)

        batch(() => {
            persistedIds.value = new Set(persistedIds.value).add(id)
            state.status.value = `Persisted ${describeClient(id)}`
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.status.value = `Could not persist ${describeClient(id)}: ` +
            message
    } finally {
        persisting.value = null
    }
}

/**
 * Bring every persisted device's record up to date with the state it
 * holds now, dropping the record of any that has left the group. Called
 * from each action that advances group state -- a record saved at an
 * older epoch would restore a device that cannot decrypt anything
 * current.
 *
 * A storage failure here is reported rather than thrown: the action
 * itself succeeded, and what failed is only the copy on disk.
 */
async function syncPersisted ():Promise<void> {
    try {
        const next = await syncPersistedDevices(
            { saveMember, deleteMember },
            {
                groupId: state.groupId.value,
                users: state.users.value,
                persistedIds: persistedIds.value
            }
        )

        if (next !== persistedIds.value) persistedIds.value = next
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.status.value = 'Could not update persisted devices: ' + message
    }
}

/**
 * Bring back every device this page persisted, at the epoch it was last
 * saved at. Nothing about the person-to-device grouping is stored: the
 * records are keyed by client id, the users map is keyed by client id,
 * and every user view on this page derives a person's devices by
 * parsing those ids -- so restoring the map restores the grouping.
 *
 * This runs under a top-level `await` in a module that is statically
 * imported into the app's single bundle, so a rejection escaping here
 * would fail module evaluation and take the whole app down. Every failure
 * is caught and reported into the status line instead.
 */
async function restoreDevices ():Promise<void> {
    try {
        const records = await loadAllMembers()
        if (records.length === 0) return

        const { restorable, stale } = partitionDeviceRecords(records)

        // A stale record is a device that is no longer in the group, or a
        // record this page cannot name a device from at all. Either way
        // restoring it would show a device that is not a member, so it is
        // deleted. The record's own groupId reproduces its key.
        for (const record of stale) {
            await deleteMember(
                bytesToBase64url(record.state.groupContext.groupId),
                record.name
            )
        }

        if (restorable.length === 0) return

        const { users, groupId } = restoredUsersFromRecords(restorable)

        const droppedNote = stale.length > 0 ?
            ` (dropped ${stale.length} stale record(s))` :
            ''

        batch(() => {
            state.users.value = new Map([...state.users.value, ...users])
            state.groupId.value = groupId
            state.status.value = `Restored ${restorable.length} device(s) ` +
                'from indexedDB' + droppedNote
            persistedIds.value = new Set(restorable.map((r) => r.name))
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.status.value = 'Restore from indexedDB failed: ' + message
    }
}

await restoreDevices()

// Whether the browser has granted persistent storage for this origin.
// Origin-wide, not per database -- the answer here is the same one the
// persistence demo sees.
const storageStatus = signal<StorageStatus>(await checkPersisted())

// Outcome of the most recent `persist()` call.
const persistRequest = signal<PersistRequest>('idle')

async function requestStoragePersistence ():Promise<void> {
    persistRequest.value = 'pending'
    const status = await requestPersistentStorage()

    batch(() => {
        storageStatus.value = status
        persistRequest.value = persistOutcome(status)
    })
}

/**
 * Throw away everything this page has stored and start over. Only this
 * page's database is dropped: the persistence demo owns a different one
 * and keeps its records. The reload is what clears the in-memory state,
 * since ClientStates live in module scope.
 */
async function resetDemo ():Promise<void> {
    try {
        await deleteDatabase()
        globalThis.location.reload()
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.status.value = 'Could not clear stored data: ' + message
    }
}

// The person a message will be sent from, once one of their devices is
// picked. Choosing a person only opens the device row -- a person has
// no keys, so nothing is encrypted until a client is named.
const pendingSender = signal<string|null>(null)

// The client id sending right now, if any.
const sending = signal<string|null>(null)

/**
 * Send the typed message from one device. `sendMessage` takes a client
 * name and this page's clients are named by client id, so the message
 * is encrypted under that one client's key schedule and lands in every
 * other member's queue -- including the sender's own other devices,
 * which are ordinary members like anyone else.
 *
 * The input is only cleared once a message actually exists: on failure
 * `sendMessage` has put the reason in `status` and the text is still
 * worth keeping.
 */
async function sendFrom (id:string):Promise<void> {
    const text = state.inputMessage.value.trim()
    if (!text) return

    const before = state.messages.value.length

    sending.value = id

    try {
        await sendMessage(state, id, text)

        if (state.messages.value.length === before) return

        batch(() => {
            state.inputMessage.value = ''
            pendingSender.value = null
            state.status.value = `Message sent from ${describeClient(id)}`
        })

        await syncPersisted()
    } finally {
        sending.value = null
    }
}

// Which person-and-message boxes the reader has opened, keyed by
// `messageRowKey`. Expansion is per person per message: opening Alice's
// copy of one message says nothing about Bob's copy, or about Alice's
// copy of the next one.
const expandedRows = signal<Set<string>>(new Set())

function expandRow (key:string):void {
    const next = new Set(expandedRows.value)
    next.add(key)
    expandedRows.value = next
}

// The client whose decrypt is running right now, if any.
const decrypting = signal<string|null>(null)

/**
 * Decrypt one message on one device. Every device decrypts for itself:
 * the ciphertext sitting in a client's queue is sealed under that
 * client's own key schedule, and no amount of belonging to the same
 * person as the sender changes that.
 */
async function decryptOn (id:string, messageIndex:number):Promise<void> {
    decrypting.value = id

    try {
        await decryptMessage(state, id, messageIndex)
        await syncPersisted()
    } finally {
        decrypting.value = null
    }
}

/**
 * Every distinct epoch held by an in-group client, ascending. Each
 * device advances its own state independently, so this is one entry
 * while they agree and more than one if a device ever falls behind --
 * worth showing rather than reading the epoch off a single client.
 */
function groupEpochs (users:Map<string, DemoUser>):bigint[] {
    const epochs = new Set<bigint>()

    for (const user of users.values()) {
        if (user.state) epochs.add(user.state.groupContext.epoch)
    }

    return [...epochs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// The tree node pinned open in the detail panel, if any.
const selectedNodeIndex = signal<number|null>(null)

// The person whose devices are listed in the Status panel, if any.
// Selecting is a read-only inspection -- it never changes who commits,
// which is what `actor` is for.
const selectedPerson = signal<string|null>(null)

// The client id of the device whose own MLS state is on show, if any. A
// selected device covers the tree diagram rather than replacing the
// pinned node, so the two selections stack: see `clearTop`.
const selectedDevice = signal<string|null>(null)

/**
 * Drop the topmost selection -- the device if one is showing, otherwise
 * the pinned tree node. Shared by the card's Clear button and Escape, so
 * both peel the selections back in the same order.
 */
function clearTop ():void {
    const next = clearTopSelection({
        device: selectedDevice.value,
        nodeIndex: selectedNodeIndex.value
    })

    batch(() => {
        selectedDevice.value = next.device
        selectedNodeIndex.value = next.nodeIndex
    })
}

// 21 leaves at 34px spacing cannot show 21 labels at once -- they smear
// into each other. Hovering or focusing one leaf reveals that leaf's
// label alone, so it has room for the full description of the client
// rather than the bare 'Alice/phone' id.
const LEAF_LABELS = { reveal: true, describe: describeClient }

// The device the pointer or keyboard focus is resting on a rotate
// control for. Only a peek: it lights up the tree and changes nothing.
const hoveredDevice = signal<string|null>(null)

/**
 * Ask one device to rotate. The click is also what disables the button,
 * and a disabled button never sees the matching mouseleave, so the peek
 * is dropped here rather than left lighting a device nobody is pointing
 * at for the length of the commit.
 */
function startRotate (id:string):void {
    hoveredDevice.value = null
    rotateDevice(id)
}

/**
 * One device in the User Management list. The rotate control is a real
 * button drawn as a link, and it is disabled unless the device holds a
 * leaf: a device outside the group has no path to replace, and asking
 * `rotateKeys` to rotate one only regenerates its key package -- through
 * a code path that would not give it back the non-extractable signature
 * key `createDeviceClient` made it with.
 *
 * A rotation is a commit, so every rotate control waits on the one in
 * flight, the same way the add and remove buttons wait on theirs.
 */
function deviceRow (row:DeviceRow) {
    const isRotating = rotating.value === row.clientId
    const disabled = !row.inGroup || rotating.value !== null

    return html`
        <li key=${row.clientId}>
            <span class="icon" aria-hidden="true">${row.device.icon}</span>
            <span class="label">${row.device.label}</span>
            <code class="client-id">${row.clientId}</code>
            ${row.inGroup ?
                html`<span class="in-group">in group</span>` :
                null}
            <button
                class="rotate"
                disabled=${disabled}
                aria-label=${'Rotate keys: ' + describeClient(row.clientId)}
                onMouseEnter=${() => {
                    hoveredDevice.value = row.clientId
                }}
                onMouseLeave=${() => {
                    hoveredDevice.value = null
                }}
                onFocus=${() => {
                    hoveredDevice.value = row.clientId
                }}
                onBlur=${() => {
                    hoveredDevice.value = null
                }}
                onClick=${() => startRotate(row.clientId)}
            >
                ${isRotating ? 'rotating...' : 'rotate'}
            </button>
        </li>
    `
}

/**
 * One row of the Status panel's Devices section. Always three of these
 * for the selected person, whether or not their devices exist yet: the
 * point is the shape of a user, so a device nobody has created is
 * still worth a row saying it is not in the group. The row is a button:
 * activating it shows that one client's own MLS state in place of the
 * tree.
 */
function selectedDeviceRow (row:DeviceRow) {
    const isSelected = selectedDevice.value === row.clientId
    const isPersisted = persistedIds.value.has(row.clientId)

    return html`
        <li key=${row.clientId}>
            <button
                class="device ${isSelected ? 'selected' : ''}"
                aria-pressed=${isSelected}
                onClick=${() => {
                    selectedDevice.value = row.clientId
                }}
            >
                <span class="icon" aria-hidden="true">
                    ${row.device.icon}
                </span>
                <span class="label">${row.device.label}</span>
                <span class="membership ${row.inGroup ? 'in-group' : ''}">
                    ${row.inGroup ? 'in group' : 'not in group'}
                </span>
                <span class="storage ${isPersisted ? 'persisted' : ''}">
                    ${isPersisted ? 'persisted' : 'not persisted'}
                </span>
            </button>
        </li>
    `
}

export const MultiDeviceDemo:FunctionComponent = function () {
    const {
        users, status, ciphersuite, groupId, messages, inputMessage,
        decryptedMessages, messageQueues
    } = state

    // Escape peels back the same selections the Clear button does, in
    // the same order. Bound to the document because the thing being
    // cleared is rarely what holds focus.
    useEffect(() => {
        const onKeyDown = (ev:KeyboardEvent) => {
            if (ev.key === 'Escape') clearTop()
        }

        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [])

    const epochs = groupEpochs(users.value)
    const membership = membershipSummary(users.value)

    // People with at least one leaf: only they can commit. The stored
    // choice can go stale (their last device could be removed), so it
    // is validated against the list rather than trusted.
    const people = EXAMPLE_USERS.filter((user) => {
        return canSend(selectUser(user, users.value))
    })
    const acting = (actor.value && people.includes(actor.value)) ?
        actor.value :
        people[0] ?? null

    const actingRows = acting ?
        selectUser(acting, users.value) :
        []

    // One leaf per device, so seven users fill 21 of the 32 leaf
    // slots. `TIGHT_TREE_LAYOUT` keeps that drawable; the surrounding
    // `.tree-scroll` gives it somewhere to overflow to.
    const treeLayout = useComputed(() => {
        const groupUser = selectGroupUser(users.value)

        const leafNames = new Map(
            Array.from(users.value.entries())
                .filter(([, user]) => user.state)
                .map(([name, user]) => {
                    return [
                        toLeafIndex(user.state!.privatePath.leafIndex),
                        name,
                    ] as const
                })
        )

        return selectTreeLayout(
            !!groupId.value,
            groupUser?.state?.ratchetTree,
            leafNames,
            TIGHT_TREE_LAYOUT
        )
    })

    const treeDetail = useComputed(() => {
        const tree = selectGroupUser(users.value)?.state?.ratchetTree
        if (!tree) return { kind: 'none' as const }

        // Peeking at a rotate control says what that rotation would
        // cost, and takes precedence over a pinned node the same way it
        // takes precedence over the person highlight in the tree.
        //
        // The count is one device's own direct path, not the person's
        // union: rotating a phone leaves the laptop's and the desktop's
        // leaves untouched, so counting all three would overstate it.
        const device = hoveredDevice.value
        const path = device ?
            users.value.get(device)?.state?.privatePath :
            undefined

        if (path) {
            return {
                kind: 'peek' as const,
                count: rotationKeyChangeCount(
                    tree,
                    toLeafIndex(path.leafIndex)
                )
            }
        }

        const index = selectedNodeIndex.value
        if (index === null) return { kind: 'none' as const }

        return {
            kind: 'node' as const,
            details: selectNodeDetails(tree, index),
        }
    })

    // Which devices the tree is lighting up. Selecting a person means
    // all of theirs; peeking at a rotate control means only that one.
    // The peek wins, the way it does on the other pages -- seeing what a
    // rotation would touch should not cost you your selection.
    //
    // One device rather than a person is the whole point of the peek: a
    // rotation replaces one leaf and one direct path, and lighting the
    // person's union would claim it touches their other two devices.
    const highlightRows = useComputed<DeviceRow[]>(() => {
        const device = hoveredDevice.value

        if (device) {
            const row = selectDevice(device, users.value)
            return row ? [row] : []
        }

        const person = selectedPerson.value
        return person ? selectUser(person, users.value) : []
    })

    // Every leaf those devices hold, plus each of those leaves' direct
    // paths. A person is several leaves, so this is a union of paths
    // rather than the single path a hovered member gets on the other
    // pages -- the styling is the same one either way.
    const selectedPath = useComputed(() => {
        const rows = highlightRows.value
        if (rows.length === 0) return new Set<number>()

        const tree = selectGroupUser(users.value)?.state?.ratchetTree
        if (!tree) return new Set<number>()

        return userPathNodeIndices(tree, rows, users.value)
    })

    // The leaves of those same devices, outlined the way a pinned node
    // is so the highlight reads as "these are Bob's devices" rather than
    // leaving one thick outline on whichever node was clicked last.
    const selectedLeaves = useComputed(() => {
        const rows = highlightRows.value
        if (rows.length === 0) return new Set<number>()

        const tree = selectGroupUser(users.value)?.state?.ratchetTree
        if (!tree) return new Set<number>()

        return userLeafNodeIndices(tree, rows, users.value)
    })

    const addButtons = !acting ? [] : EXAMPLE_USERS.filter((user) => {
        return !!userAddPlan(
            actingRows,
            selectUser(user, users.value)
        )
    }).map(user => html`
        <button
            key=${'add-' + user}
            onClick=${() => addUser(acting, user)}
            disabled=${committing.value !== null}
        >
            ${committing.value === `add:${user}` ?
                'Committing...' :
                `${acting} adds ${user}'s devices`}
        </button>
    `)

    const removeButtons = !acting ? [] : EXAMPLE_USERS.filter((user) => {
        return !!userRemovePlan(
            actingRows,
            selectUser(user, users.value)
        )
    }).map(user => html`
        <button
            key=${'remove-' + user}
            onClick=${() => removeUser(acting, user)}
            disabled=${committing.value !== null}
        >
            ${committing.value === `remove:${user}` ?
                'Committing...' :
                `${acting} removes ${user}'s devices`}
        </button>
    `)

    const startButtons = EXAMPLE_USERS.filter((user) => {
        return userExists(selectUser(user, users.value))
    }).map((user) => html`
        <button
            key=${user}
            onClick=${() => startGroupAs(user)}
            disabled=${startingGroup.value !== null}
        >
            ${startingGroup.value === user ?
                'Starting...' :
                `Start group as ${user}`}
        </button>
    `)

    // The Devices section sits in the Status panel, which is above the
    // tree-node detail block, so a pinned node's properties never push
    // it out of view.
    const inspecting = selectedPerson.value
    const inspectedRows = inspecting ?
        selectUser(inspecting, users.value) :
        []

    // The device card and the tree share the status row's right-hand
    // column. Selecting a device only swaps what is drawn there; the
    // pinned tree node is left alone in state.
    const deviceInfo = selectedDevice.value === null ?
        null :
        selectDeviceInfo(selectedDevice.value, users.value)

    // Sending is two steps. The first names a person, which only opens
    // the device row; the stored person can go stale the same way the
    // acting person can, so it is validated rather than trusted.
    const pending = resolvePendingSender(pendingSender.value, people)
    const hasText = inputMessage.value.trim().length > 0

    const sendAsButtons = people.map(user => html`
        <button
            key=${'send-as-' + user}
            class="send-as ${pending === user ? 'selected' : ''}"
            aria-pressed=${pending === user}
            onClick=${() => {
                pendingSender.value = user
            }}
            disabled=${!hasText || sending.value !== null}
        >
            Send as ${user}
        </button>
    `)

    const sendWithButtons = !pending ? [] : sendOptions(
        selectUser(pending, users.value)
    ).map(option => html`
        <button
            key=${'send-with-' + option.clientId}
            class="send-with-device"
            onClick=${() => sendFrom(option.clientId)}
            disabled=${!option.enabled || sending.value !== null}
        >
            <span class="icon" aria-hidden="true">${option.device.icon}</span>
            <span class="label">
                ${sending.value === option.clientId ?
                    'Sending...' :
                    option.device.label}
            </span>
        </button>
    `)

    // One view per message, each holding one row per person. The
    // columns below are the transpose of this: a person, then every
    // message that reached any of their devices.
    const messageViews = messages.value.map((message, messageIndex) => {
        return selectMessageView({
            users: users.value,
            queues: messageQueues.value,
            decrypted: decryptedMessages.value,
            message,
            messageIndex
        })
    })

    const messageColumns = (messageViews[0] ?? []).map((first) => {
        const person = first.person

        const boxes = messageViews.map((view, messageIndex) => {
            const row = view.find(entry => entry.person === person)

            // Nothing of this message reached any of their devices --
            // they joined later, or left before it was sent.
            if (!row?.holdsMessage) return null

            const msg = messages.value[messageIndex]
            const key = messageRowKey(messageIndex, person)

            return html`
                <${PersonMessageBox}
                    key=${key}
                    view=${row}
                    from=${describeClient(msg.from)}
                    epoch=${msg.epoch.toString()}
                    ciphertext=${
                        bytesToBase64url(msg.ciphertext).slice(0, 64)
                    }
                    expanded=${expandedRows.value.has(key)}
                    onExpand=${() => expandRow(key)}
                    onDecrypt=${(id:string) => decryptOn(id, messageIndex)}
                    decrypting=${decrypting.value}
                />
            `
        })

        return html`
            <div key=${person} class="message-column">
                <h4 class="column-header">${person}</h4>
                <div class="message-boxes">${boxes}</div>
            </div>
        `
    })

    const userRows = EXAMPLE_USERS.map((user) => {
        const devices = selectUser(user, users.value)
        const exists = userExists(devices)
        const isCreating = creating.value.has(user)
        const isSelected = selectedPerson.value === user

        return html`
            <li key=${user}>
                <button
                    class="person ${isSelected ? 'selected' : ''}"
                    aria-pressed=${isSelected}
                    onClick=${() => {
                        batch(() => {
                            selectedPerson.value = user
                            // The shown device belonged to whoever was
                            // selected before, so it goes with them.
                            selectedDevice.value = null
                        })
                    }}
                >
                    ${user}
                </button>
                ${exists ? html`
                    <ul class="devices">
                        ${devices.map(deviceRow)}
                    </ul>
                ` : html`
                    <button
                        onClick=${() => createDevices(user)}
                        disabled=${!ciphersuite.value || isCreating}
                    >
                        ${isCreating ?
                            'Creating...' :
                            `Create ${user}'s devices`}
                    </button>
                `}
            </li>
        `
    })

    const statusCard = html`
        <div class="card status">
            <div class="status-layout">
                <div class="status-content">
                    <h3>Status</h3>
                    <p class="device-count">
                        Devices created:${NBSP}${users.value.size}
                    </p>
                    <p class="member-count">
                        Members in group:${NBSP}
                        ${membershipText(membership)}
                    </p>
                    ${epochs.length === 0 ? null : html`
                        <p class="epoch">
                            ${epochs.length === 1 ?
                                'Epoch' :
                                'Epochs'}:${NBSP}
                            ${epochs.map(e => e.toString()).join(', ')}
                        </p>
                    `}
                    <p>${status.value}</p>

                    ${inspecting ? html`
                        <div class="devices-section">
                            <h4>Devices</h4>
                            <p class="whose">${inspecting}</p>
                            <ul class="device-rows">
                                ${inspectedRows.map(selectedDeviceRow)}
                            </ul>
                        </div>
                    ` : null}

                    ${deviceInfo ?
                        null :
                        html`<${TreeNodeDetailPanel}
                            detail=${treeDetail.value}
                        />`}
                </div>
            </div>
        </div>
    `

    // The right-hand column of the status row. A selected device takes
    // over the tree's slot: one client's own state is what the page is
    // about, and the tree is the same picture either way.
    const treeCard = deviceInfo ? html`
        <${DeviceInfoPanel}
            info=${deviceInfo}
            onClear=${clearTop}
            onRotate=${() => rotateDevice(deviceInfo.clientId)}
            rotating=${rotating.value === deviceInfo.clientId}
            onRemove=${() => removeDevice(deviceInfo.clientId)}
            removing=${removingDevice.value === deviceInfo.clientId}
            removeBlocked=${removalCommitter(
                inGroupClientIds(users.value),
                deviceInfo.clientId
            ) === null}
            onPersist=${() => persistDevice(deviceInfo.clientId)}
            persisting=${persisting.value === deviceInfo.clientId}
            persisted=${persistedIds.value.has(deviceInfo.clientId)}
        />
    ` : treeLayout.value ? html`
        <div class="tree-scroll">
            <${TreeDiagram}
                layout=${treeLayout.value}
                hoveredPath=${selectedPath.value}
                outlinedNodes=${selectedLeaves.value}
                selectedNodeIndex=${selectedNodeIndex.value}
                onSelectNode=${(nodeIndex:number) => {
                    selectedNodeIndex.value = nodeIndex
                }}
                onClear=${clearTop}
                leafLabels=${LEAF_LABELS}
            />
        </div>
    ` : null

    return html`
        <div class="container">
            <h1>Multi-device Demo</h1>

            <p>
                MLS has no notion of a person. Each of the seven people
                here gets three devices ${EM_DASH} a phone, a laptop, and
                a desktop ${EM_DASH} and${SPACE}<strong>each device is its own
                client</strong>, with its own key package, its own leaf,
                and its own${SPACE}<code>ClientState</code>. The mapping
                from devices to user exists only in application code
                (<code>example/user.ts</code>).
            </p>

            <${StoragePanel}
                status=${storageStatus.value}
                request=${persistRequest.value}
                onRequest=${requestStoragePersistence}
            />

            <button
                class="reset-btn"
                onClick=${resetDemo}
            >
                Reset
            </button>

            ${treeCard ? html`
                <div class="grid status-row">
                    ${statusCard}
                    ${treeCard}
                </div>
            ` : statusCard}

            <div class="grid">
                <div class="card users multi-device">
                    <h3>👤 User Management</h3>

                    <ul class="list user-devices">
                        ${userRows}
                    </ul>
                </div>

                <div class="card group-ops multi-device">
                    <h3>Group Operations</h3>

                    ${groupId.value ? html`
                        <p>
                            The group is active. Every device in it is one
                            leaf of the ratchet tree. A whole user moves in
                            one commit ${EM_DASH} one proposal per device,
                            so the
                            epoch advances once however many devices arrive
                            or leave.
                        </p>

                        <label class="actor">
                            Acting as${NBSP}
                            <select
                                value=${acting ?? ''}
                                onChange=${(ev:Event) => {
                                    actor.value = (
                                        ev.target as HTMLSelectElement
                                    ).value
                                }}
                            >
                                ${people.map(user => html`
                                    <option key=${user} value=${user}>
                                        ${user}
                                    </option>
                                `)}
                            </select>
                        </label>

                        ${addButtons.length ? html`
                            <h4>Add a user</h4>
                            <div class="controls members">
                                ${addButtons}
                            </div>
                        ` : null}

                        ${removeButtons.length ? html`
                            <h4>Remove a user</h4>
                            <div class="controls members">
                                ${removeButtons}
                            </div>
                        ` : null}
                    ` : html`
                        <p>
                            Starting the group as a person founds it with
                            their phone, then adds their laptop and desktop
                            as two more clients.
                        </p>

                        ${startButtons.length ? html`
                            <div class="controls groups">
                                ${startButtons}
                            </div>
                        ` : html`
                            <p class="hint">
                                Create someone's devices first.
                            </p>
                        `}
                    `}
                </div>
            </div>

            ${people.length ? html`
                <div class="card messenger multi-device">
                    <h3>Send Message</h3>
                    <p>
                        A person cannot send anything ${EM_DASH} only a
                        client
                        can. Pick who is sending, then pick which of
                        their devices does the encrypting.
                    </p>
                    <label for="message">Message</label>
                    <div class="flex">
                        <input
                            type="text"
                            name="message"
                            id="message"
                            value=${inputMessage.value}
                            onInput=${(ev:Event) => {
                                inputMessage.value = (
                                    ev.target as HTMLInputElement
                                ).value
                            }}
                            placeholder="Type a message..."
                        />
                    </div>
                    <div class="controls">
                        ${sendAsButtons}
                    </div>

                    ${pending ? html`
                        <div class="send-with">
                            <p class="prompt">Send with:</p>
                            <div class="controls devices">
                                ${sendWithButtons}
                            </div>
                        </div>
                    ` : null}
                </div>

                ${messages.value.length ? html`
                    <div class="card message-history multi-device">
                        <h3>Message History</h3>
                        <p>
                            One column per person, but a person decrypts
                            nothing. Open a message and each of that
                            person's devices decrypts for itself ${EM_DASH}
                            including the other two belonging to whoever
                            sent it.
                        </p>
                        <div class="message-columns">
                            ${messageColumns}
                        </div>
                    </div>
                ` : null}
            ` : null}

            <${HowToUse} />
        </div>
    `
}

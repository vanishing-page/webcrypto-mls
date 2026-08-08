import {
    DEVICES,
    clientId,
    parseClientId,
    type Device
} from './devices.js'
import type { DemoUser } from '../example-shared/demo-user.js'

/**
 * A "user" here is one person's three devices. MLS knows nothing about
 * it: the group holds one leaf per device, and this module is the only
 * place that folds those separate clients back into a person.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node.
 */

export interface DeviceRow {
    device:Device;
    clientId:string;

    // A key package (and signature keypair) has been generated for this
    // device, so it can be added to a group.
    created:boolean;

    // The device has a ClientState, ie it holds a leaf in the group.
    inGroup:boolean;
}

/**
 * One row per device for `user`, in `DEVICES` order. A person who has
 * created nothing still gets three rows, all false, so the UI can list
 * the devices that could exist alongside the ones that do.
 */
export function selectUser (
    user:string,
    users:Map<string, DemoUser>
):DeviceRow[] {
    return DEVICES.map((device) => {
        const id = clientId(user, device.id)
        const client = users.get(id)

        return {
            device,
            clientId: id,
            created: !!client?.keyPackage,
            inGroup: !!client?.state
        }
    })
}

/**
 * The one row for a single device, named by its client id. The person is
 * read back out of the id, so this is `selectUser` narrowed to one of its
 * three rows -- which is what a per-device control has in hand.
 *
 * Null when the id is not a client id at all, or names a device that is
 * not one of `DEVICES`.
 */
export function selectDevice (
    id:string,
    users:Map<string, DemoUser>
):DeviceRow|null {
    const parsed = parseClientId(id)
    if (!parsed) return null

    return selectUser(parsed.user, users)
        .find(row => row.clientId === id) ?? null
}

// Whether every one of the person's devices has been created.
export function userExists (rows:DeviceRow[]):boolean {
    return rows.every(row => row.created)
}

export interface StartPlan {
    // The device that calls createGroup -- the person's phone, since
    // DEVICES puts it first.
    creator:string;

    // The person's other created devices, added to the group after it
    // exists, in DEVICES order.
    joiners:string[];
}

/**
 * How to start the group as this person: the first created device in
 * DEVICES order founds the group and the rest are added to it. Returns
 * null when the person has no created device to found it with.
 */
export function userStartPlan (rows:DeviceRow[]):StartPlan|null {
    const created = rows.filter(row => row.created)
    if (created.length === 0) return null

    return {
        creator: created[0].clientId,
        joiners: created.slice(1).map(row => row.clientId)
    }
}

/**
 * The device that issues a commit on this person's behalf: their first
 * in-group device in DEVICES order. A person is not a member of an MLS
 * group, so "Alice adds Bob's devices" has to resolve to one concrete
 * client that holds a leaf. Null when none of their devices has joined.
 */
export function userCommitter (rows:DeviceRow[]):string|null {
    return rows.find(row => row.inGroup)?.clientId ?? null
}

export interface UserCommitPlan {
    // The client id that creates the commit.
    committer:string;

    // The client ids named by the commit's proposals, in DEVICES order.
    // One proposal each, all carried by a single commit, so the epoch
    // advances once per user rather than once per device.
    targets:string[];
}

/**
 * One commit adding every device of the target person that exists but
 * has not joined. Null when the adder holds no leaf to commit from, or
 * when the target has nothing left to add.
 */
export function userAddPlan (
    adderRows:DeviceRow[],
    targetRows:DeviceRow[]
):UserCommitPlan|null {
    const committer = userCommitter(adderRows)
    if (!committer) return null

    const targets = targetRows
        .filter(row => row.created && !row.inGroup)
        .map(row => row.clientId)

    if (targets.length === 0) return null

    return { committer, targets }
}

/**
 * One commit removing every in-group device of the target person. Null
 * when the remover holds no leaf, when the target holds none, or when
 * the committer is itself a target -- RFC 9420 forbids a commit that
 * removes its own committer, so a user cannot remove themselves.
 */
export function userRemovePlan (
    removerRows:DeviceRow[],
    targetRows:DeviceRow[]
):UserCommitPlan|null {
    const committer = userCommitter(removerRows)
    if (!committer) return null

    const targets = targetRows
        .filter(row => row.inGroup)
        .map(row => row.clientId)

    if (targets.length === 0) return null
    if (targets.includes(committer)) return null

    return { committer, targets }
}

/**
 * A client id read back as a sentence fragment, eg 'Alice/phone' becomes
 * `Alice's Phone 📱`. Used wherever one client has to identify itself in
 * full -- a revealed tree label, a leaf's aria-label -- rather than as
 * the terse id. A name that is not a client id (the other two demos key
 * their users by a bare person name) is returned unchanged.
 */
export function describeClient (id:string):string {
    const parsed = parseClientId(id)
    if (!parsed) return id

    const device = DEVICES.find(d => d.id === parsed.deviceId)
    if (!device) return id

    return `${parsed.user}'s ${device.label} ${device.icon}`
}

export interface Membership {
    // Leaves in the group: one per in-group device.
    clients:number;

    // Distinct people those leaves belong to.
    people:number;
}

/**
 * Group membership counted both ways. The client count is what MLS
 * actually holds; the people count only exists in this page's head.
 */
export function membershipSummary (users:Map<string, DemoUser>):Membership {
    const people = new Set<string>()
    let clients = 0

    for (const [id, user] of users.entries()) {
        if (!user.state) continue
        clients++
        const parsed = parseClientId(id)
        if (parsed) people.add(parsed.user)
    }

    return { clients, people: people.size }
}

/**
 * Membership as a status line fragment, eg
 * `21 (7 people x 3 devices)`. The multiplication is only shown when it
 * actually holds -- mid-way through populating the tree, or after one
 * device has been removed, the counts do not factor.
 */
export function membershipText (membership:Membership):string {
    const { clients, people } = membership
    if (clients === 0) return '0'

    const noun = people === 1 ? 'person' : 'people'
    if (clients === people * DEVICES.length) {
        return `${clients} (${people} ${noun} x ${DEVICES.length} devices)`
    }

    return `${clients} (${people} ${noun})`
}

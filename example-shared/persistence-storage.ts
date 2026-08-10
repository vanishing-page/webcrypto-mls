import {
    type ClientState,
    type KeyPackage,
    type PrivateKeyPackage
} from '../src/index.js'
import { demoClientConfig } from './demo-client-config.js'
import { toLeafIndex, leafToNodeIndex } from '../src/treemath.js'
import {
    constantTimeEqual
} from '../src/util/constant-time-compare.js'
import type { Node } from '../src/ratchet-tree.js'
import type { DemoUser } from './demo-user.js'

const STORE_NAME = 'members'
const SESSION_STORE_NAME = 'session'
const SESSION_KEY = 'current'

/**
 * Shared by both stores so one upgrade path creates both. The two
 * existing demo databases are already at version 1, so their upgrade
 * handler never re-runs and they simply never gain a `session` store --
 * which they do not need. Bumping the version to give them one would
 * force an upgrade on databases that are working fine.
 */
function openDb (dbName:string):Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(dbName, 1)
        open.onupgradeneeded = () => {
            const db = open.result
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME)
            }
            if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
                db.createObjectStore(SESSION_STORE_NAME)
            }
        }
        open.onerror = () => reject(open.error)
        open.onsuccess = () => resolve(open.result)
    })
}

// `ClientState.clientConfig` carries function values (an `authService` with
// a `validateCredential` method, a `keyPackageEqualityConfig` comparator,
// etc.) that the structured clone algorithm cannot clone. It is the demo's
// unmodified default config, so -- like the cipher suite -- it's stateless
// and gets re-derived on restore rather than persisted.
type PersistableClientState = Omit<ClientState, 'clientConfig'>

// A shallow copy rather than `demoClientConfig` itself, so a restored
// state can have a field swapped out without every other state seeing it.
// The values it copies are shared, which is fine -- they are the library
// defaults and nothing here mutates them. What matters is that it is the
// same config the demos
// create and join groups with: a restored state that authenticated
// differently from the live one would accept or refuse peers the original
// would not.
function freshClientConfig ():ClientState['clientConfig'] {
    return { ...demoClientConfig }
}

export interface PersistedMember {
    name:string
    state:PersistableClientState
}

export function memberKey (groupIdB64:string, name:string):string {
    return `${groupIdB64}:${name}`
}

/**
 * Pure composition step for restoring from storage -- separated from the
 * indexedDB I/O below so it can be unit tested in Node without a real
 * `indexedDB` global. All persisted records belong to the demo's single
 * active group, so the restored `groupId` is whichever record's state was
 * seen last (they all agree).
 */
export function restoredUsersFromRecords (
    records:PersistedMember[]
):{ users:Map<string, DemoUser>; groupId:Uint8Array | null } {
    const users = new Map<string, DemoUser>()
    let groupId:Uint8Array | null = null

    for (const record of records) {
        const state:ClientState = {
            ...record.state,
            clientConfig: freshClientConfig()
        }
        users.set(record.name, { name: record.name, state })
        groupId = state.groupContext.groupId
    }

    return { users, groupId }
}

/**
 * Split the persisted member names into the ones to re-save and the ones
 * whose record is now stale. A member removed from the group has their
 * `state` cleared, so their saved record is frozen at the epoch before the
 * removal -- it has to be deleted, otherwise the next page load restores
 * them as a member of a group they are no longer in.
 */
export function partitionPersistedNames (
    persistedNames:Iterable<string>,
    users:Map<string, DemoUser>
):{ save:string[]; remove:string[] } {
    const save:string[] = []
    const remove:string[] = []

    for (const name of persistedNames) {
        if (users.get(name)?.state) save.push(name)
        else remove.push(name)
    }

    return { save, remove }
}

/**
 * The identity bytes a tree leaf asserts: the basic credential's
 * identity, or the leaf's signature public key for other credential
 * types. Null for a blank position or a parent node.
 */
function leafIdentity (node:Node | undefined):Uint8Array | null {
    if (!node || node.nodeType !== 'leaf') return null
    const cred = node.leaf.credential
    return cred.credentialType === 'basic' ?
        cred.identity :
        node.leaf.signaturePublicKey
}

/**
 * Classify persisted records against the highest-epoch record's view
 * of the group. A record is only restorable if it is still `active`,
 * belongs to the same group, and its own leaf in the authoritative
 * tree still holds its identity. Anything else is a stale record --
 * for example a member removed while an older version of this page
 * was running, whose record was never deleted -- and restoring it
 * would show a zombie member, so the caller should delete it instead.
 *
 * A `suspendedPendingReinit` record is conservatively treated as
 * stale here too, even though a group paused pending a reinit has
 * not lost membership the way a `removedFromGroup` record has. This
 * demo has no reinit path, so the distinction doesn't matter in
 * practice -- a future reinit path should revisit this.
 *
 * The highest-epoch record is trusted as authoritative without
 * further corroboration: a corrupted or hand-edited record with an
 * inflated epoch would cause every legitimate member's record to be
 * misclassified as stale. This is accepted because it matches the
 * plan's documented risk model -- a genuine zombie record is always
 * frozen at its removal epoch, necessarily lower than live members'.
 */
export function partitionRestorableRecords (
    records:PersistedMember[]
):{ restorable:PersistedMember[]; stale:PersistedMember[] } {
    if (records.length === 0) return { restorable: [], stale: [] }

    let authority = records[0]
    for (const record of records) {
        if (record.state.groupContext.epoch >
            authority.state.groupContext.epoch) {
            authority = record
        }
    }

    const authorityTree = authority.state.ratchetTree
    const authorityGroupId = authority.state.groupContext.groupId

    const restorable:PersistedMember[] = []
    const stale:PersistedMember[] = []

    for (const record of records) {
        const { state } = record
        const nodeIndex = leafToNodeIndex(
            toLeafIndex(state.privatePath.leafIndex)
        )
        const own = leafIdentity(state.ratchetTree[nodeIndex])
        const current = leafIdentity(authorityTree[nodeIndex])

        const isMember =
            state.groupActiveState.kind === 'active' &&
            constantTimeEqual(
                state.groupContext.groupId,
                authorityGroupId
            ) &&
            own !== null &&
            current !== null &&
            constantTimeEqual(own, current)

        if (isMember) restorable.push(record)
        else stale.push(record)
    }

    return { restorable, stale }
}

export interface MemberStore {
    saveMember (
        groupIdB64:string,
        name:string,
        state:ClientState
    ):Promise<void>
    deleteMember (groupIdB64:string, name:string):Promise<void>
    loadAllMembers ():Promise<PersistedMember[]>
    deleteDatabase ():Promise<void>
}

/**
 * Bind the storage operations to one named database, so each demo page
 * owns its records outright. `loadAllMembers` returns every record in
 * the store and the caller deletes whatever it cannot classify, so two
 * demos sharing one database would read each other's members as stale
 * and delete them.
 *
 * Nothing is opened until an operation is called, which is what lets a
 * demo module build its store at module scope.
 */
export function createMemberStore ({ dbName }:{ dbName:string }):MemberStore {
    async function saveMember (
        groupIdB64:string,
        name:string,
        state:ClientState
    ):Promise<void> {
        const db = await openDb(dbName)
        const { clientConfig: _clientConfig, ...persistableState } = state

        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite')
            const record:PersistedMember = { name, state: persistableState }
            tx.objectStore(STORE_NAME).put(record, memberKey(groupIdB64, name))
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async function deleteMember (
        groupIdB64:string,
        name:string
    ):Promise<void> {
        const db = await openDb(dbName)

        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite')
            tx.objectStore(STORE_NAME).delete(memberKey(groupIdB64, name))
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async function loadAllMembers ():Promise<PersistedMember[]> {
        const db = await openDb(dbName)

        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly')
            const request = tx.objectStore(STORE_NAME).getAll()
            request.onsuccess = () => {
                resolve(request.result as PersistedMember[])
            }
            request.onerror = () => reject(request.error)
        })
    }

    function deleteDatabase ():Promise<void> {
        return new Promise((resolve, reject) => {
            const del = indexedDB.deleteDatabase(dbName)
            del.onsuccess = () => resolve()
            del.onerror = () => reject(del.error)
            del.onblocked = () => resolve()
        })
    }

    return { saveMember, deleteMember, loadAllMembers, deleteDatabase }
}

// -------------------------------------------------------------------
// The session store. A second object store beside the member store in
// the same database, because a waiting joiner has a key package and
// private keys but no group state at all, while `PersistedMember`
// requires `state` -- and the page also has to remember room-level
// facts (`roomId`, `cursor`, `creatorToken`) that are not member state.
// -------------------------------------------------------------------

/**
 * Everything a page needs to come back as it was, including the cases
 * `PersistedMember` cannot express. `state` is absent for a joiner
 * still waiting on approval.
 */
export interface PersistedSession {
    name:string
    keyPackage:KeyPackage
    privateKeys:PrivateKeyPackage
    roomId:string|null
    cursor:number
    creatorToken:string|null
    state?:PersistableClientState
}

/**
 * What the page hands in: the same fields, but with the live
 * `ClientState` it is actually holding. `sessionRecord` is what turns
 * one into the other.
 */
export interface SessionInput extends Omit<PersistedSession, 'state'> {
    state?:ClientState
}

/**
 * Build the record to store. `clientConfig` is stripped for the same
 * reason `saveMember` strips it -- it holds functions and is not
 * structured-cloneable.
 *
 * Pure, so the decision about what gets written is testable without a
 * database.
 */
export function sessionRecord (input:SessionInput):PersistedSession {
    // Destructure rather than spread, so a session with no group does
    // not gain a `state` key holding `undefined`.
    const { state, ...rest } = input
    if (!state) return { ...rest }

    const { clientConfig: _clientConfig, ...persistableState } = state
    return { ...rest, state: persistableState }
}

/**
 * Whether a stored record is usable. A record with no name, no key
 * package, no private keys or no cursor cannot do anything, and is
 * treated as absent rather than restored into a broken half-state. A
 * record with no `state` is fine: that is the waiting joiner.
 */
export function isRestorableSession (
    value:unknown
):value is PersistedSession {
    if (!value || typeof value !== 'object') return false
    const record = value as Partial<PersistedSession>
    return (
        typeof record.name === 'string' &&
        record.keyPackage !== undefined &&
        record.privateKeys !== undefined &&
        typeof record.cursor === 'number' &&
        Number.isFinite(record.cursor)
    )
}

/**
 * Rebuild the client from a stored record. The counterpart to
 * `restoredUsersFromRecords` for the one-client case: `clientConfig` is
 * re-derived rather than restored, and a record with no group state
 * comes back as a user with no group -- which is what returns a waiting
 * joiner to the waiting view instead of the name field.
 */
export function restoredSessionUser (session:PersistedSession):DemoUser {
    const user:DemoUser = {
        name: session.name,
        keyPackage: session.keyPackage,
        privateKeys: session.privateKeys
    }
    if (!session.state) return user

    return {
        ...user,
        state: { ...session.state, clientConfig: freshClientConfig() }
    }
}

export interface SessionStore {
    saveSession (session:SessionInput):Promise<void>
    loadSession ():Promise<PersistedSession|null>
    clearSession ():Promise<void>
    deleteDatabase ():Promise<void>
}

/**
 * One session per database, keyed by a constant -- a page using this
 * holds exactly one client, unlike the demos that hold a map of many.
 *
 * Nothing is opened until an operation is called, matching
 * `createMemberStore`, which is what lets a page build its store at
 * module scope.
 */
export function createSessionStore (
    { dbName }:{ dbName:string }
):SessionStore {
    /**
     * One connection per store, held so `deleteDatabase` can close it.
     * A delete is blocked for as long as any connection to the database
     * is open, and a blocked delete does not fail -- it waits -- so a
     * connection left open per operation makes the Delete control report
     * success and remove nothing until the tab closes.
     */
    let connection:IDBDatabase|null = null

    async function connect ():Promise<IDBDatabase> {
        if (connection) return connection

        const db = await openDb(dbName)

        // Dropped rather than reused if the browser closes it under us:
        // another tab deleting or upgrading the database closes every
        // other connection, and a transaction on a closed one throws.
        db.onclose = () => { connection = null }

        // A delete fires `versionchange` on every open connection,
        // including this one, so this handler alone is enough to unblock
        // a delete started from *any* tab -- including this page's own.
        // The explicit close in `deleteDatabase` therefore duplicates it
        // for the local case, deliberately: it does not depend on an
        // event round trip, so the delete is never momentarily blocked.
        // Removing either one leaves the delete working; removing both
        // makes the Delete control report success and remove nothing.
        db.onversionchange = () => {
            db.close()
            connection = null
        }

        connection = db
        return db
    }

    async function saveSession (session:SessionInput):Promise<void> {
        const db = await connect()
        const record = sessionRecord(session)

        return new Promise((resolve, reject) => {
            const tx = db.transaction(SESSION_STORE_NAME, 'readwrite')
            tx.objectStore(SESSION_STORE_NAME).put(record, SESSION_KEY)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    async function loadSession ():Promise<PersistedSession|null> {
        const db = await connect()

        return new Promise((resolve, reject) => {
            const tx = db.transaction(SESSION_STORE_NAME, 'readonly')
            const request = tx.objectStore(SESSION_STORE_NAME)
                .get(SESSION_KEY)

            // A record that cannot be used is reported as absent rather
            // than restored into a broken half-state.
            request.onsuccess = () => {
                const value:unknown = request.result
                resolve(isRestorableSession(value) ? value : null)
            }
            request.onerror = () => reject(request.error)
        })
    }

    async function clearSession ():Promise<void> {
        const db = await connect()

        return new Promise((resolve, reject) => {
            const tx = db.transaction(SESSION_STORE_NAME, 'readwrite')
            tx.objectStore(SESSION_STORE_NAME).delete(SESSION_KEY)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
    }

    function deleteDatabase ():Promise<void> {
        // This page's own connection first, or it blocks its own delete.
        if (connection) {
            connection.close()
            connection = null
        }

        return new Promise((resolve, reject) => {
            const del = indexedDB.deleteDatabase(dbName)
            del.onsuccess = () => resolve()
            del.onerror = () => reject(del.error)
            // Another tab still holds it open. Resolve rather than hang:
            // the delete completes once that tab lets go.
            del.onblocked = () => resolve()
        })
    }

    return { saveSession, loadSession, clearSession, deleteDatabase }
}

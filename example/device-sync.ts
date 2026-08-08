import { type ClientState, bytesToBase64url } from '../src/index.js'
import {
    partitionPersistedNames
} from '../example-shared/persistence-storage.js'
import type { DemoUser } from '../example-shared/demo-user.js'

/**
 * The slice of a `MemberStore` a sync needs. Narrowed to the two
 * operations so the sync can be tested against a plain recording object
 * rather than a fake `indexedDB`.
 */
export interface DeviceSyncStore {
    saveMember (
        groupIdB64:string,
        name:string,
        state:ClientState
    ):Promise<void>
    deleteMember (groupIdB64:string, name:string):Promise<void>
}

export interface DeviceSyncInput {
    groupId:Uint8Array|null
    users:Map<string, DemoUser>
    persistedIds:Set<string>
}

/**
 * Bring every already-persisted device's record back up to date, and
 * return the client ids that are persisted afterwards.
 *
 * Any action that advances group state -- a commit, a message, a
 * processed message -- leaves a saved record frozen at a dead epoch, so
 * each one calls this. A persisted device that no longer holds a leaf
 * was removed from the group; its record is dropped rather than
 * re-saved, because restoring it on the next load would show a device
 * that is not a member.
 *
 * The persisted set is returned by reference when nothing was dropped,
 * so the common case does not churn the signal holding it.
 */
export async function syncPersistedDevices (
    store:DeviceSyncStore,
    { groupId, users, persistedIds }:DeviceSyncInput
):Promise<Set<string>> {
    if (!groupId) return persistedIds

    const groupIdB64 = bytesToBase64url(groupId)
    const { save, remove } = partitionPersistedNames(persistedIds, users)

    for (const id of save) {
        const client = users.get(id)
        if (client?.state) await store.saveMember(groupIdB64, id, client.state)
    }

    for (const id of remove) {
        await store.deleteMember(groupIdB64, id)
    }

    if (remove.length === 0) return persistedIds

    const remaining = new Set(persistedIds)
    for (const id of remove) remaining.delete(id)

    return remaining
}

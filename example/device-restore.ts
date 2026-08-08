import {
    partitionRestorableRecords,
    type PersistedMember
} from '../example-shared/persistence-storage.js'
import { parseClientId } from './devices.js'

/**
 * Classify this page's persisted records into the ones to restore and the
 * ones to delete.
 *
 * Records here are keyed by client id ('Alice/phone'), one per device, so
 * the person-to-device grouping is not stored at all -- it falls out of
 * parsing the names back with `parseClientId`. A record whose name is not
 * a valid client id was written by something other than this page (or by
 * an older schema), and this page has nowhere to put it: it is stale.
 *
 * Unparseable records are dropped *before* `partitionRestorableRecords`
 * runs, not after. That function trusts its highest-epoch record as the
 * authoritative view of the tree, so letting a foreign record through
 * could make every genuine device read as stale.
 */
export function partitionDeviceRecords (
    records:PersistedMember[]
):{ restorable:PersistedMember[]; stale:PersistedMember[] } {
    const ours:PersistedMember[] = []
    const stale:PersistedMember[] = []

    for (const record of records) {
        if (parseClientId(record.name)) ours.push(record)
        else stale.push(record)
    }

    const partitioned = partitionRestorableRecords(ours)

    return {
        restorable: partitioned.restorable,
        stale: [...stale, ...partitioned.stale]
    }
}

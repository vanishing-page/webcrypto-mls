import type { Device } from './devices.js'
import type { DeviceRow } from './user.js'

/**
 * Sending is two steps on this page: pick the person, then pick the
 * device. MLS only ever encrypts from a client, so "Alice sends" has to
 * resolve to exactly one of Alice's three clients -- the phone in her
 * pocket or the laptop on the desk -- before any ciphertext exists.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node.
 */

export interface SendOption {
    clientId:string;
    device:Device;

    // The device holds a leaf, so it has the key schedule to encrypt
    // with. A device that exists only on paper is still listed -- the
    // row is the shape of the user -- but cannot be sent from.
    enabled:boolean;
}

// Whether this person can send at all: at least one of their devices
// holds a leaf.
export function canSend (rows:DeviceRow[]):boolean {
    return rows.some(row => row.inGroup)
}

// One option per device, in DEVICES order (the order of `rows`).
export function sendOptions (rows:DeviceRow[]):SendOption[] {
    return rows.map(row => ({
        clientId: row.clientId,
        device: row.device,
        enabled: row.inGroup
    }))
}

/**
 * The person whose device row is open, or null when it should be
 * closed. A pending sender goes stale when their last device leaves the
 * group, so the stored choice is validated against who can currently
 * send rather than trusted.
 */
export function resolvePendingSender (
    pending:string|null,
    senders:string[]
):string|null {
    if (!pending) return null
    return senders.includes(pending) ? pending : null
}

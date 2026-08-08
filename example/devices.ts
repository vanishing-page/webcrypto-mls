// The device model for the multi-device demo. MLS has no notion of a
// "user": one person maps to N leaves in the ratchet tree, one per
// device, and each leaf is a separate client with its own key package
// and ClientState. The person-to-device grouping is a demo-level idea
// only, encoded here as a client id of the form "Alice/phone".
//
// This module is pure -- no preact, no signals, no DOM -- so it can be
// unit tested in node.

export type DeviceId = 'phone'|'laptop'|'desktop'

export interface Device {
    id:DeviceId;
    label:string;
    icon:string;
}

// Ordered: every list of a person's devices is rendered and created in
// this order, and the group is always started from the first one.
export const DEVICES:Device[] = [
    { id: 'phone', label: 'Phone', icon: '📱' },
    { id: 'laptop', label: 'Laptop', icon: '💻' },
    { id: 'desktop', label: 'Desktop', icon: '🖥️' }
]

// The separator between the person's name and the device id. Names in
// EXAMPLE_USERS never contain it, so a client id has exactly one.
const SEPARATOR = '/'

// The identity of one client, eg clientId('Alice', 'phone') is
// 'Alice/phone'. This is what the demo keys its users map by, and what
// goes into a client's credential.
export function clientId (user:string, deviceId:DeviceId):string {
    return `${user}${SEPARATOR}${deviceId}`
}

function isDeviceId (id:string):id is DeviceId {
    return DEVICES.some(device => device.id === id)
}

// The inverse of clientId. Returns null rather than throwing for
// anything that is not a well formed client id -- an unknown device id,
// a missing or repeated separator, or an empty user.
export function parseClientId (
    id:string
):{ user:string, deviceId:DeviceId }|null {
    const parts = id.split(SEPARATOR)
    if (parts.length !== 2) return null
    const [user, deviceId] = parts
    if (user.length === 0) return null
    if (!isDeviceId(deviceId)) return null
    return { user, deviceId }
}

// All of one person's client ids, in DEVICES order.
export function userClientIds (user:string):string[] {
    return DEVICES.map(device => clientId(user, device.id))
}

import { parseClientId, type Device } from './devices.js'
import { selectUser } from './user.js'
import { EXAMPLE_USERS } from './example-users.js'
import type { DemoMessage, DemoMessageQueue } from './demo-state.js'
import type { DemoUser } from '../example-shared/demo-user.js'

/**
 * One message, seen from every device in the demo. MLS delivers a
 * PrivateMessage to clients, not to people, so a single "message" is
 * really N per-client decrypt states -- and a person's phone can have
 * read it while their laptop has not. This module folds the per-client
 * queues into one row per person per message, which is the shape the
 * Message History UI renders.
 *
 * Pure -- no preact, no signals, no DOM -- so it can be unit tested in
 * node.
 */

export interface DeviceMessageView {
    device:Device;
    clientId:string;

    // The device holds a leaf. A device outside the group has no key
    // schedule for this epoch and so can never decrypt: the UI omits its
    // Decrypt button rather than offering one that must fail.
    inGroup:boolean;

    // The ciphertext is sitting in this device's inbox, waiting.
    queued:boolean;

    // The plaintext is available on this device.
    decrypted:boolean;

    // This is the client that composed the message.
    isSender:boolean;

    // The plaintext, or null when this device has not decrypted it.
    text:string|null;
}

export interface PersonMessageView {
    person:string;

    // Whether the message reached this user at all: at least one
    // device has it queued or decrypted. A person who joined after the
    // message was sent holds nothing, and the UI can collapse them.
    holdsMessage:boolean;

    // One entry per device, in DEVICES order.
    devices:DeviceMessageView[];
}

export interface MessageViewInput {
    users:Map<string, DemoUser>;
    queues:Record<string, DemoMessageQueue>;
    decrypted:Record<string, Record<number, string>>;
    message:DemoMessage;

    // The message's index in `state.messages`, which is the key both the
    // queues and the decrypted map are indexed by.
    messageIndex:number;
}

/**
 * The distinct people holding a client id in `users`, in EXAMPLE_USERS
 * order. Anyone outside that list (nothing in the demo creates such a
 * client, but the map is not typed to forbid it) is kept, in first-seen
 * order, after the known people.
 */
function peopleIn (users:Map<string, DemoUser>):string[] {
    const seen:string[] = []

    for (const id of users.keys()) {
        const parsed = parseClientId(id)
        if (!parsed) continue
        if (!seen.includes(parsed.user)) seen.push(parsed.user)
    }

    const known = EXAMPLE_USERS.filter(user => seen.includes(user))
    const rest = seen.filter(user => !EXAMPLE_USERS.includes(user))

    return [...known, ...rest]
}

/**
 * One row per person, each holding one entry per device, for a single
 * message.
 */
export function selectMessageView (
    input:MessageViewInput
):PersonMessageView[] {
    const { users, queues, decrypted, message, messageIndex } = input

    return peopleIn(users).map((person) => {
        const devices = selectUser(person, users).map((row) => {
            const isSender = message.from === row.clientId
            const text = decrypted[row.clientId]?.[messageIndex]
            const queued = (queues[row.clientId] ?? [])
                .some(item => item.messageIndex === messageIndex)

            return {
                device: row.device,
                clientId: row.clientId,
                inGroup: row.inGroup,
                queued,

                // The sending client encrypted the plaintext it already
                // had in hand, so it is decrypted by definition -- there
                // is nothing for it to decrypt.
                decrypted: isSender || text !== undefined,
                isSender,
                text: isSender ? message.text : (text ?? null)
            }
        })

        return {
            person,
            holdsMessage: devices.some(d => d.queued || d.decrypted),
            devices
        }
    })
}

// A stable identity for one person's row of one message, for tracking
// which rows the reader has expanded. Neither a person's name nor a
// message's index changes once it exists.
export function messageRowKey (
    messageIndex:number,
    person:string
):string {
    return `${messageIndex}:${person}`
}

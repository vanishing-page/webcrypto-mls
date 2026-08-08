import { signal, type Signal } from '@preact/signals'
import type { CiphersuiteImpl } from '../src/index.js'
import type { DemoUser } from '../example-shared/demo-user.js'

export interface DemoMessage {
    from:string
    text:string
    ciphertext:Uint8Array // Encrypted message bytes
    epoch:bigint
    timestamp:number
}

export type DemoMessageQueue = Array<{
    messageIndex:number;
    ciphertext:Uint8Array;
    epoch:bigint
}>

export interface DemoState {
    users:Signal<Map<string, DemoUser>>;
    messages:Signal<DemoMessage[]>;
    ciphersuite:Signal<CiphersuiteImpl | null>;
    groupId:Signal<Uint8Array | null>;
    status:Signal<string>;
    inputMessage:Signal<string>;
    keyPackageInfo:Signal<string>;

    // userName -> (messageIndex -> decryptedText)
    decryptedMessages:Signal<Record<string, Record<number, string>>>;

    // userName -> message queue (simulating per-user machines)
    messageQueues:Signal<Record<string, DemoMessageQueue>>;
}

/**
 * The group-messaging slice of demo state (users, messages, ciphersuite,
 * etc.) shared by the main demo and the persistence demo -- neither the
 * `route` signal nor `Route()` (a page-level, single-instance concern
 * owned by example/state.ts) live here.
 */
export function createDemoState ():DemoState {
    return {
        users: signal(new Map()),
        messages: signal([]),
        ciphersuite: signal(null),
        groupId: signal(null),
        status: signal('Ready to start'),
        inputMessage: signal(''),
        keyPackageInfo: signal(''),
        decryptedMessages: signal({}),
        messageQueues: signal({})
    }
}

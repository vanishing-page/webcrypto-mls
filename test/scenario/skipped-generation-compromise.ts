import { test } from '@substrate-system/tapzero'
import { skipReason } from '../helpers/skip.js'
import type { ClientState } from '../../src/client-state.js'
import { createGroup, joinGroup, makePskIndex } from '../../src/client-state.js'
import { createCommit } from '../../src/create-commit.js'
import { createApplicationMessage } from '../../src/create-message.js'
import {
    processMessage,
    processPrivateMessage,
} from '../../src/process-messages.js'
import { emptyPskIndex } from '../../src/psk-index.js'
import { acceptAll } from '../../src/incoming-message-action.js'
import type { Credential } from '../../src/credential.js'
import type {
    CiphersuiteImpl,
    CiphersuiteName,
} from '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../../src/crypto/get-ciphersuite-impl.js'
import { deriveTreeSecret } from '../../src/crypto/kdf.js'
import { generateKeyPackage } from '../../src/key-package.js'
import { defaultLifetime } from '../../src/lifetime.js'
import { defaultCapabilities } from '../../src/default-capabilities.js'
import { deriveKey, deriveNonce } from '../../src/secret-tree.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
import type { PrivateMessage } from '../../src/private-message.js'
import { ValidationError } from '../../src/mls-error.js'
import { sampleCiphersuites } from '../helpers/suite-filter.js'
import { testClientConfig } from '../helpers/client-config.js'

function skippable (error:any):boolean {
    return error?.name === 'NotSupportedError' ||
        error?.name === 'DependencyError'
}

for (const cs of sampleCiphersuites()) {
    test('state compromise after a skipped generation does not ' +
        'recover consumed generations ' + cs, async (t) => {
        try {
            await compromiseAfterSkip(t, cs as CiphersuiteName)
        } catch (error:any) {
            if (skippable(error)) {
                t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })

    test('a skipped generation delivered late decrypts once ' + cs,
        async (t) => {
            try {
                await lateDeliveryDecryptsOnce(t, cs as CiphersuiteName)
            } catch (error:any) {
                if (skippable(error)) {
                    t.comment(`Skipping ${cs}: ${skipReason(error)}`)
                    return
                }
                throw error
            }
        })
}

async function makeMember (name:string, impl:CiphersuiteImpl) {
    const credential:Credential = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(name),
    }
    return generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

async function setup (cs:CiphersuiteName) {
    const impl = await getCipherSuite(getCiphersuiteFromName(cs))
    const alice = await makeMember('alice', impl)
    const bob = await makeMember('bob', impl)

    const created = await createGroup(
        new TextEncoder().encode('skipped-generation-compromise'),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )
    const commit = await createCommit(
        { state: created, cipherSuite: impl },
        {
            extraProposals: [{
                proposalType: 'add',
                add: { keyPackage: bob.publicPackage },
            }],
        },
    )
    const bobGroup = await joinGroup(
        commit.welcome!,
        bob.publicPackage,
        bob.privatePackage,
        emptyPskIndex,
        impl,
        commit.newState.ratchetTree,
        undefined,
        testClientConfig,
    )
    return { impl, aliceGroup: commit.newState, bobGroup }
}

/**
 * Every byte buffer reachable from `root`, walking objects, arrays and
 * maps. This is what an attacker who reads the member's memory gets.
 */
function reachableBuffers (root:unknown):Uint8Array[] {
    const seen = new Set<unknown>()
    const found:Uint8Array[] = []
    const walk = (value:unknown):void => {
        if (value === null || typeof value !== 'object') return
        if (seen.has(value)) return
        seen.add(value)
        if (value instanceof Uint8Array) {
            found.push(value)
            return
        }
        if (value instanceof Map) {
            for (const [k, v] of value) {
                walk(k)
                walk(v)
            }
            return
        }
        for (const v of Object.values(value)) walk(v)
    }
    walk(root)
    return found
}

function equalBytes (a:Uint8Array, b:Uint8Array):boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

interface GenerationKeys {
    key:Uint8Array
    nonce:Uint8Array
}

/**
 * The key and nonce of every generation up to `last`, derived from the
 * sender's own application ratchet.
 */
async function senderKeys (
    aliceGroup:ClientState,
    last:number,
    impl:CiphersuiteImpl,
):Promise<GenerationKeys[]> {
    const index = leafToNodeIndex(toLeafIndex(aliceGroup.privatePath.leafIndex))
    let secret = aliceGroup.secretTree[index]!.application.secret
    const keys:GenerationKeys[] = []
    for (let g = 0; g <= last; g++) {
        keys.push({
            key: await deriveKey(secret, g, impl),
            nonce: await deriveNonce(secret, g, impl),
        })
        secret = await deriveTreeSecret(
            secret, 'secret', g, impl.kdf.size, impl.kdf)
    }
    return keys
}

/**
 * Tries each buffer as a key or nonce directly, and as an application
 * ratchet chain secret at every generation from 0 to the target, and
 * reports whether any of them yields a consumed generation's key.
 *
 * Buffers are not tried as secret tree roots: the key schedule's
 * encryption secret is a separate retention story, and this test is
 * about the ratchet's own record of skipped generations.
 */
async function anyRecovers (
    candidates:Uint8Array[],
    targets:number[],
    keys:GenerationKeys[],
    impl:CiphersuiteImpl,
):Promise<boolean> {
    for (const candidate of candidates) {
        for (const g of targets) {
            if (equalBytes(candidate, keys[g]!.key)) return true
            if (equalBytes(candidate, keys[g]!.nonce)) return true
        }
        if (candidate.length !== impl.kdf.size) continue
        const last = Math.max(...targets)
        for (let start = 0; start <= last; start++) {
            let secret = candidate
            for (let g = start; g <= last; g++) {
                if (targets.includes(g)) {
                    const key = await deriveKey(secret, g, impl)
                    if (equalBytes(key, keys[g]!.key)) return true
                }
                secret = await deriveTreeSecret(
                    secret, 'secret', g, impl.kdf.size, impl.kdf)
            }
        }
    }
    return false
}

async function compromiseAfterSkip (t:any, cs:CiphersuiteName) {
    const { impl, aliceGroup: startAlice, bobGroup: startBob } =
        await setup(cs)
    let aliceGroup = startAlice
    let bobGroup = startBob

    const keys = await senderKeys(aliceGroup, 3, impl)

    const sent:PrivateMessage[] = []
    for (let i = 0; i < 4; i++) {
        const result = await createApplicationMessage(
            aliceGroup, new TextEncoder().encode(`message ${i}`), impl)
        aliceGroup = result.newState
        sent.push(result.privateMessage)
    }

    // generation 0 is lost; 1 to 3 arrive in order
    for (const msg of sent.slice(1)) {
        const result = await processPrivateMessage(
            bobGroup, msg, makePskIndex(bobGroup, {}), impl)
        bobGroup = result.newState
    }

    t.equal(
        await anyRecovers(reachableBuffers(bobGroup), [1, 2, 3], keys, impl),
        false,
        'nothing in the state recovers a consumed generation',
    )

    for (let i = 0; i < 2; i++) {
        const commit = await createCommit(
            { state: aliceGroup, cipherSuite: impl })
        aliceGroup = commit.newState
        if (commit.commit.wireformat !== 'mls_private_message') {
            throw new Error('Expected a private message commit')
        }
        const processed = await processMessage(
            commit.commit, bobGroup, emptyPskIndex, acceptAll, impl)
        bobGroup = processed.newState
    }

    t.ok(
        bobGroup.historicalReceiverData.size > 0,
        'sanity: the old epoch is retained as historical receiver data',
    )
    t.equal(
        await anyRecovers(reachableBuffers(bobGroup), [1, 2, 3], keys, impl),
        false,
        'nothing in the state recovers a consumed generation two ' +
            'epochs later',
    )

    // the skipped generation is still readable from the retained epoch
    const late = await processPrivateMessage(
        bobGroup, sent[0]!, makePskIndex(bobGroup, {}), impl)
    t.equal(late.kind, 'applicationMessage',
        'the skipped generation still decrypts from historical data')
}

async function lateDeliveryDecryptsOnce (t:any, cs:CiphersuiteName) {
    const { impl, aliceGroup: startAlice, bobGroup: startBob } =
        await setup(cs)
    let aliceGroup = startAlice
    let bobGroup = startBob

    const sent:PrivateMessage[] = []
    for (let i = 0; i < 3; i++) {
        const result = await createApplicationMessage(
            aliceGroup, new TextEncoder().encode(`message ${i}`), impl)
        aliceGroup = result.newState
        sent.push(result.privateMessage)
    }

    bobGroup = (await processPrivateMessage(
        bobGroup, sent[2]!, makePskIndex(bobGroup, {}), impl)).newState

    const late = await processPrivateMessage(
        bobGroup, sent[0]!, makePskIndex(bobGroup, {}), impl)
    if (late.kind !== 'applicationMessage') {
        throw new Error('Expected an application message')
    }
    t.deepEqual(late.message, new TextEncoder().encode('message 0'),
        'the skipped generation decrypts')

    // the prior state still holds generation 0, so delivering to it again
    // must still work: consuming must not wipe the caller's state
    const again = await processPrivateMessage(
        bobGroup, sent[0]!, makePskIndex(bobGroup, {}), impl)
    t.equal(again.kind, 'applicationMessage',
        'the prior state still decrypts the skipped generation')

    let replayRejected = false
    try {
        await processPrivateMessage(
            late.newState, sent[0]!, makePskIndex(late.newState, {}), impl)
    } catch (error) {
        replayRejected = error instanceof ValidationError
    }
    t.ok(replayRejected, 'a second delivery is rejected as a replay')
}

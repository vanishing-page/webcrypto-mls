import { extract, expand } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { CiphersuiteImpl } from
    '../../src/crypto/ciphersuite.js'
import { labelOf } from './helpers.js'

/**
 * One `kdf.expand` output, with the label sealKdf framed into its
 * info. `out` is the buffer the KDF handed back, not a copy, so a
 * later wipe by the library is visible through it.
 */
export interface RecordedExpand {
    label:string
    out:Uint8Array
}

/**
 * A ciphersuite whose KDF records every expand and can be told to
 * reject the next expand whose label contains a given string.
 *
 * Only `kdf.expand` is wrapped. Every SEAL derivation ends in exactly
 * one expand (sealKdf: extract, then expand), so the expand outputs
 * are the derived keys themselves; the PRKs from extract are sealKdf's
 * own scratch and it wipes them. Rejecting in expand therefore fails
 * a derivation at its last step, after its PRK exists, which is the
 * harder case for cleanup.
 *
 * `pauseAt` parks the next expand whose label matches, after its
 * output is computed and recorded, until the test releases it. That
 * is how a test lands a cancel while a named derivation is settling.
 */
export function recordingSuite (cs:CiphersuiteImpl):{
    cs:CiphersuiteImpl
    recorded:RecordedExpand[]
    /** Outputs whose label contains `label`. */
    outputs:(label:string) => Uint8Array[]
    /** Reject the next expand whose label contains `label`. */
    rejectAt:(label:string, err:Error) => void
    /** Park the next expand whose label contains `label`. */
    pauseAt:(label:string) => Gate
} {
    const recorded:RecordedExpand[] = []
    let reject:{ label:string, err:Error }|null = null
    let pause:{ label:string, gate:Gate, wait:Promise<void> }|null = null

    const wrapped:CiphersuiteImpl = {
        ...cs,
        kdf: {
            ...cs.kdf,
            expand: async (prk, info, len) => {
                const label = labelOf(info)
                if (reject && label.includes(reject.label)) {
                    const { err } = reject
                    reject = null
                    throw err
                }
                const out = await cs.kdf.expand(prk, info, len)
                recorded.push({ label, out })
                if (pause && label.includes(pause.label)) {
                    const { gate, wait } = pause
                    pause = null
                    gate.markReached()
                    await wait
                }
                return out
            },
        },
    }

    return {
        cs: wrapped,
        recorded,
        outputs: label => recorded
            .filter(r => r.label.includes(label))
            .map(r => r.out),
        rejectAt: (label, err) => { reject = { label, err } },
        pauseAt: label => {
            let release!:() => void
            const wait = new Promise<void>(resolve => { release = resolve })
            let markReached!:() => void
            const reached = new Promise<void>(resolve => {
                markReached = resolve
            })
            const gate = { reached, release, markReached }
            pause = { label, gate, wait }
            return gate
        },
    }
}

export interface Gate {
    /** Resolves once the paused expand has its output. */
    reached:Promise<void>
    /** Let the paused expand return. */
    release:() => void
    markReached:() => void
}

/**
 * The same suite with its HKDF computed in JavaScript (noble) rather
 * than through WebCrypto. The outputs are identical -- both are RFC
 * 5869 HKDF-SHA-256 -- but no derivation waits on the platform, so
 * every continuation after a gate is released is a microtask and one
 * macrotask turn (`settle`) runs a read to wherever it stops. That
 * makes "the operation has settled" a queue flush rather than a
 * timing guess. SHA-256 suites only.
 */
export function pureKdfSuite (cs:CiphersuiteImpl):CiphersuiteImpl {
    if (cs.kdf.size !== 32) throw new Error('pureKdfSuite: SHA-256 only')
    return {
        ...cs,
        kdf: {
            ...cs.kdf,
            extract: async (salt, ikm) => extract(sha256, ikm, salt),
            expand: async (prk, info, len) => expand(sha256, prk, info, len),
        },
    }
}

/**
 * One macrotask turn. Over a `pureKdfSuite` with a fully buffered
 * source, nothing a read does after a gate is released waits on
 * anything but the microtask queue, which this drains.
 */
export function settle ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

export function isZeroed (buf:Uint8Array):boolean {
    return buf.every(b => b === 0)
}

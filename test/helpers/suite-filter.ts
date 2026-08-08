/**
 * Which ciphersuites a test run exercises.
 *
 * Every scenario and validation test fans out over the whole ciphersuite
 * matrix, which is where nearly all of the suite's running time goes. The
 * `MLS_SUITES` environment variable narrows that fan-out so CI can split
 * the matrix across parallel jobs without any suite going unexercised:
 *
 *   unset, or `all`   every ciphersuite (the default)
 *   `fast`            the representative sample, for a quick local loop
 *   `shard:2/4`       the second of four disjoint, cost-balanced shards
 *   `NAME,OTHER`      exactly those ciphersuites, by name
 *
 * Anything else is an error rather than an empty run, so a typo in a
 * workflow file fails loudly instead of quietly testing nothing.
 */
import type { CiphersuiteName } from '../../src/crypto/ciphersuite.js'
import { ciphersuites } from '../../src/crypto/ciphersuite.js'

/**
 * Every ciphersuite, ordered slowest first.
 *
 * Sharding deals suites out of this order round robin, so each shard
 * receives a mix of expensive and cheap ones rather than one shard
 * inheriting all four ML-DSA suites. The order comes from measuring the
 * suite: the four ML-DSA signature suites together are about half of the
 * total, and the smallest suite is roughly a tenth of the largest.
 */
const BY_COST:CiphersuiteName[] = [
    'MLS_256_XWING_AES256GCM_SHA512_MLDSA87',
    'MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87',
    'MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87',
    'MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87',
    'MLS_256_DHKEMP521_AES256GCM_SHA512_P521',
    'MLS_256_DHKEMP384_AES256GCM_SHA384_P384',
    'MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448',
    'MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448',
    'MLS_128_DHKEMP256_AES128GCM_SHA256_P256',
    'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
    'MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519',
    'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519',
    'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    'MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519',
    'MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519',
    'MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519',
    'MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519',
    'MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519',
    'MLS_128_MLKEM512_CHACHA20POLY1305_SHA256_Ed25519',
]

/**
 * A cross section of the matrix: one X25519 suite, one NIST curve, one
 * ML-KEM suite, and one X-Wing suite with ML-DSA signatures.
 *
 * This is for tests whose cost is out of proportion to what a second
 * ciphersuite would tell us -- a group lifecycle exercises tree and epoch
 * handling, not the primitives, so running it nineteen times mostly buys
 * a slower CI job.
 */
export const REPRESENTATIVE:CiphersuiteName[] = [
    'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    'MLS_128_DHKEMP256_AES128GCM_SHA256_P256',
    'MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519',
    'MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87',
]

/**
 * Resolve a filter against the full set of ciphersuites.
 *
 * @param all Every ciphersuite name the library defines.
 * @param filter The `MLS_SUITES` value, or an empty string for all.
 * @returns The ciphersuites to run, in `all` order.
 */
export function selectSuites (
    all:readonly CiphersuiteName[],
    filter:string
):CiphersuiteName[] {
    const spec = filter.trim()
    if (spec === '' || spec === 'all') return [...all]

    const inOrder = (chosen:Set<string>) => {
        return all.filter(name => chosen.has(name))
    }

    if (spec === 'fast') return inOrder(new Set(REPRESENTATIVE))

    const shard = spec.match(/^shard:(\d+)\/(\d+)$/)
    if (shard) {
        const index = Number(shard[1])
        const count = Number(shard[2])
        if (count < 1 || index < 1 || index > count) {
            throw new Error(
                `MLS_SUITES shard out of range: ${spec}, ` +
                'expected shard:i/n with 1 <= i <= n'
            )
        }
        return inOrder(new Set(shardOf(all, index, count)))
    }

    const named = spec.split(',').map(part => part.trim()).filter(Boolean)
    const unknown = named.filter(name => !all.includes(name as never))
    if (unknown.length > 0) {
        throw new Error(
            `MLS_SUITES names unknown ciphersuites: ${unknown.join(', ')}`
        )
    }
    return inOrder(new Set(named))
}

/**
 * Deal the cost-ordered suites round robin and take one shard's worth.
 */
function shardOf (
    all:readonly CiphersuiteName[],
    index:number,
    count:number
):CiphersuiteName[] {
    // A suite added to the library but not to BY_COST would silently
    // drop out of every shard, so refuse to shard at all until the
    // order is updated.
    const missing = all.filter(name => !BY_COST.includes(name))
    if (missing.length > 0) {
        throw new Error(
            'BY_COST in test/helpers/suite-filter.ts is missing ' +
            `ciphersuites: ${missing.join(', ')}`
        )
    }
    return BY_COST.filter((name, i) => {
        return all.includes(name) && i % count === index - 1
    })
}

let active:CiphersuiteName[]|null = null

/**
 * The ciphersuites this run should exercise. Test files loop over this
 * rather than over the whole matrix.
 */
export function testCiphersuites ():CiphersuiteName[] {
    if (active === null) {
        const all = Object.keys(ciphersuites) as CiphersuiteName[]
        active = selectSuites(all, readFilter())
    }
    return active
}

/**
 * The representative sample, narrowed to what this run is exercising, so
 * a sampled test still splits across shards instead of repeating in all
 * of them.
 */
export function sampleCiphersuites ():CiphersuiteName[] {
    const running = new Set<string>(testCiphersuites())
    return REPRESENTATIVE.filter(name => running.has(name))
}

// The node run has a real `process` and the browser bundle polyfills
// one, but this project's tsconfig lists neither node's types nor the
// polyfill's, so declare the one property this file reads. The
// declaration is module scoped.
declare const process:{
    env?:Record<string, string|undefined>
}|undefined

/**
 * The browser bundle's polyfilled `process` carries no environment, so
 * the filter reads as unset there and the browser run gets the whole
 * matrix.
 */
function readFilter ():string {
    if (typeof process === 'undefined') return ''
    return process.env?.MLS_SUITES ?? ''
}

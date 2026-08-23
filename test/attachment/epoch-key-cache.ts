import { test } from '@substrate-system/tapzero'
import {
    startSeal,
    sealSegment,
    openSegment,
    segmentKey,
    wipeSealState,
} from '../../src/attachment/schedule.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import {
    fromHex,
    toHex,
    paramsFromVector,
    sealCryptoFromVector,
    labelOf,
} from './helpers.js'

import F23 from '../../test_vectors/seal/core/F23.json'

/**
 * Wrap a SealCrypto so every `epoch_key` expand is counted. sealKdf
 * writes its label into the expand `info`, so `labelOf` is enough to
 * tell the epoch-key step from the other four schedule steps without
 * depending on how many expands precede it.
 */
function countingCrypto (
    inner:SealCrypto,
):{ crypto:SealCrypto, count:() => number } {
    let n = 0
    const crypto:SealCrypto = {
        ...inner,
        kdf: {
            size: inner.kdf.size,
            extract: (salt, ikm) => inner.kdf.extract(salt, ikm),
            expand: (prk, info, len) => {
                if (labelOf(info).includes('epoch_key')) n++
                return inner.kdf.expand(prk, info, len)
            },
        },
    }
    return { crypto, count: () => n }
}

async function stateFor (
    epochLength:number,
):Promise<{
    state:Awaited<ReturnType<typeof startSeal>>
    count:() => number
}> {
    const cek = fromHex(F23.cek_hex)
    const params = { ...paramsFromVector(F23), epochLength }
    const inner = await sealCryptoFromVector(F23)
    const { crypto, count } = countingCrypto(inner)
    const state = await startSeal(cek, params, new Uint8Array(), crypto)
    return { state, count }
}

test(
    'epoch key cache: one derivation per epoch, not per segment',
    async t => {
        // epochLength 2 puts four segments in each epoch, so twelve
        // segments span three epochs.
        const { state, count } = await stateFor(2)
        const before = count()

        const keys:string[] = []
        for (let i = 0; i < 12; i++) {
            keys.push(toHex(await segmentKey(state, BigInt(i))))
        }

        t.equal(
            count() - before,
            3,
            'twelve segments over three epochs cost three expands',
        )

        // Every segment inside an epoch shares one key, and the three
        // epoch keys differ from each other.
        for (const [lo, hi] of [[0, 4], [4, 8], [8, 12]]) {
            const first = keys[lo]
            for (let i = lo + 1; i < hi; i++) {
                t.equal(
                    keys[i],
                    first,
                    `segment ${i} shares the key of segment ${lo}`,
                )
            }
        }
        t.equal(
            new Set(keys).size,
            3,
            'the three epochs have three distinct keys',
        )
    },
)

test(
    'epoch key cache: repeat lookups do not re-derive',
    async t => {
        const { state, count } = await stateFor(2)

        await segmentKey(state, 0n)
        const after = count()
        for (let i = 0; i < 20; i++) await segmentKey(state, 0n)

        t.equal(
            count(),
            after,
            'twenty repeat lookups of one epoch cost no extra expand',
        )
    },
)

test(
    'epoch key cache: a real epoch boundary changes the key',
    async t => {
        // The shipped epochLength is 10, so segment 1023 is the last of
        // epoch 0 and segment 1024 the first of epoch 1.
        const { state } = await stateFor(10)

        const last = toHex(await segmentKey(state, 1023n))
        const first = toHex(await segmentKey(state, 1024n))

        t.notEqual(last, first, 'crossing an epoch changes the key')
        t.equal(
            toHex(await segmentKey(state, 0n)),
            last,
            'segment 0 and segment 1023 share epoch 0',
        )
    },
)

test(
    'epoch key cache: sealSegment does not wipe the cached key',
    async t => {
        // The cached key is the state's, not the caller's. A caller
        // that zeroed it after use would poison every later segment in
        // the same epoch, so round-trip two segments of one epoch.
        const { state } = await stateFor(2)
        const plaintext = fromHex('00112233445566778899aabbccddeeff')

        for (const index of [0n, 1n, 2n]) {
            const sealed = await sealSegment(state, {
                index,
                isFinal: false,
                plaintext,
            })
            const opened = await openSegment(state, {
                index,
                isFinal: false,
                ciphertext: sealed.ciphertext,
                tag: sealed.tag,
            })
            t.equal(
                toHex(opened),
                toHex(plaintext),
                `segment ${index} round-trips`,
            )
        }
    },
)

test(
    'epoch key cache: wipeSealState zeroizes and drops the cache',
    async t => {
        const { state, count } = await stateFor(2)

        await segmentKey(state, 0n)
        await segmentKey(state, 4n)

        // Alias the very buffers the cache holds, so a later wipe shows
        // up here even after the map is emptied.
        const cached = [...state.epochKeys.values()]
        t.equal(cached.length, 2, 'two epoch keys are cached')
        t.ok(
            cached.every(k => k.some(b => b !== 0)),
            'both cached keys have non-zero bytes',
        )

        wipeSealState(state)

        t.ok(
            cached.every(k => k.every(b => b === 0)),
            'both cached keys are zeroed',
        )
        t.equal(state.epochKeys.size, 0, 'the cache is emptied')

        // An emptied cache must re-derive rather than hand back a
        // zeroed buffer.
        const before = count()
        await segmentKey(state, 0n)
        t.equal(count() - before, 1, 'a wiped cache re-derives')
    },
)

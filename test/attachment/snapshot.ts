import { test } from '@substrate-system/tapzero'
import {
    multisetContrib, multisetSnapshot, multisetMask, xorInto,
} from '../../src/attachment/snapshot.js'
import { startSeal } from '../../src/attachment/schedule.js'
import {
    fromHex, toHex, paramsFromVector, sealCryptoFromVector,
    type CoreVector,
} from './helpers.js'

import F16EngineData from
    '../../test_vectors/seal/engine/F16.json'
import F17EngineData from
    '../../test_vectors/seal/engine/F17.json'
import F23EngineData from
    '../../test_vectors/seal/engine/F23.json'

// Type the engine vectors since they have extra fields
interface EngineVector extends CoreVector {
    snapshot?:{
        accumulator_hex:string
        mask_hex:string
        wrapped_acc_hex:string
        snapshot_tag_hex:string
    }
    segments?:Array<{
        index:number
        is_final:number
        nonce_hex:string
        segment_aad_hex:string
        segment_key_hex?:string
        ciphertext_hex:string
        tag_hex:string
        contrib_hex:string
    }>
    stored_object_hex?:string
}

const engineVectors = [F16EngineData, F17EngineData, F23EngineData] as
    unknown as EngineVector[]

// AC2.1: Snapshot authenticators (multiset 0x0001)
test(
    'snapshot: multiset contrib matches vector values',
    async t => {
        for (const vector of engineVectors) {
            // Skip if this vector doesn't have snap_id 0x0001
            if (vector.payload_info.snap_id === 0) {
                t.comment(
                    `${vector.name}: snap_id 0 (SEAL-simple), no ` +
                    'multiset snapshot object, skipping',
                )
                continue
            }
            if (vector.payload_info.snap_id !== 0x0001) {
                t.comment(
                    `${vector.name}: snap_id ${vector.payload_info.snap_id}, ` +
                    'skipping multiset test',
                )
                continue
            }

            // Skip if no multiset snapshot fields
            if (!vector.snapshot) {
                t.comment(
                    `${vector.name}: no snapshot fields, ` +
                    'skipping multiset test',
                )
                continue
            }

            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)

            if (!vector.segments) {
                throw new Error('segments required for multiset test')
            }

            for (const seg of vector.segments) {
                const tag = fromHex(seg.tag_hex)
                const contrib = await multisetContrib(
                    state, BigInt(seg.index), tag,
                )
                t.equal(
                    toHex(contrib),
                    seg.contrib_hex,
                    `${vector.name}: contrib ${seg.index} matches`,
                )
            }
        }
    },
)

test(
    'snapshot: multiset snapshot matches vector',
    async t => {
        for (const vector of engineVectors) {
            if (vector.payload_info.snap_id === 0) {
                t.comment(
                    `${vector.name}: snap_id 0 (SEAL-simple), no ` +
                    'multiset snapshot object, skipping',
                )
                continue
            }
            if (vector.payload_info.snap_id !== 0x0001) {
                t.comment(
                    `${vector.name}: snap_id ${vector.payload_info.snap_id}, ` +
                    'skipping',
                )
                continue
            }

            if (!vector.snapshot || !vector.segments) {
                t.comment(`${vector.name}: no snapshot fields, skipping`)
                continue
            }

            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)

            // Compute accumulator from contribs
            const contribs:Uint8Array[] = []
            for (const seg of vector.segments) {
                const tag = fromHex(seg.tag_hex)
                const contrib = await multisetContrib(
                    state, BigInt(seg.index), tag,
                )
                contribs.push(contrib)
            }

            // XOR all contribs
            const acc = contribs[0].slice()
            for (let i = 1; i < contribs.length; i++) {
                xorInto(acc, contribs[i])
            }

            t.equal(
                toHex(acc),
                vector.snapshot.accumulator_hex,
                `${vector.name}: accumulator matches`,
            )

            // Compute snapshot from accumulator
            const snapshot = await multisetSnapshot(
                state, BigInt(vector.segments.length), acc,
            )

            t.equal(
                toHex(snapshot),
                vector.snapshot.snapshot_tag_hex,
                `${vector.name}: snapshot matches`,
            )
        }
    },
)

test(
    'snapshot: multiset mask computation',
    async t => {
        for (const vector of engineVectors) {
            if (vector.payload_info.snap_id === 0) {
                t.comment(
                    `${vector.name}: snap_id 0 (SEAL-simple), no ` +
                    'multiset snapshot object, skipping',
                )
                continue
            }
            if (vector.payload_info.snap_id !== 0x0001) {
                t.comment(`${vector.name}: snap_id not 0x0001, skipping`)
                continue
            }

            if (!vector.snapshot || !vector.segments) {
                t.comment(`${vector.name}: no snapshot fields, skipping`)
                continue
            }

            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)

            // Recompute
            const contribs:Uint8Array[] = []
            for (const seg of vector.segments) {
                const tag = fromHex(seg.tag_hex)
                const contrib = await multisetContrib(
                    state, BigInt(seg.index), tag,
                )
                contribs.push(contrib)
            }

            const acc = contribs[0].slice()
            for (let i = 1; i < contribs.length; i++) {
                xorInto(acc, contribs[i])
            }

            const snapshot = await multisetSnapshot(
                state, BigInt(vector.segments.length), acc,
            )

            // Compute mask
            const mask = await multisetMask(
                state, BigInt(vector.segments.length), snapshot,
            )

            t.equal(
                toHex(mask),
                vector.snapshot.mask_hex,
                `${vector.name}: mask matches`,
            )

            // Verify wrapped_acc = acc XOR mask
            const wrapped = acc.slice()
            xorInto(wrapped, mask)

            t.equal(
                toHex(wrapped),
                vector.snapshot.wrapped_acc_hex,
                `${vector.name}: wrapped_acc = acc XOR mask`,
            )
        }
    },
)

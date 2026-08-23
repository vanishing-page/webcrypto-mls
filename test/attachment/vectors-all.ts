import { test } from '@substrate-system/tapzero'
import {
    startSeal,
    sealSegment,
    openSegment,
} from '../../src/attachment/schedule.js'
import {
    multisetContrib,
    multisetSnapshot,
    multisetMask,
    xorInto,
} from '../../src/attachment/snapshot.js'
import { concatAll } from '../../src/attachment/kdf.js'
import {
    fromHex,
    toHex,
    paramsFromVector,
    sealCryptoFromVector,
    SUPPORTED_AEAD_IDS,
    type CoreVector,
} from './helpers.js'

import F1Core from '../../test_vectors/seal/core/F1.json'
import F5Core from '../../test_vectors/seal/core/F5.json'
import F9Core from '../../test_vectors/seal/core/F9.json'
import F16Core from '../../test_vectors/seal/core/F16.json'
import F17Core from '../../test_vectors/seal/core/F17.json'
import F23Core from '../../test_vectors/seal/core/F23.json'

import F16Engine from '../../test_vectors/seal/engine/F16.json'
import F17Engine from '../../test_vectors/seal/engine/F17.json'
import F23Engine from '../../test_vectors/seal/engine/F23.json'

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
        contrib_hex?:string
    }>
    rewrite_segment_0?:{
        is_final:number
        new_nonce_hex:string
        new_ciphertext_hex:string
        new_tag_hex:string
        new_contrib_hex?:string
        new_accumulator_hex?:string
        new_snapshot_tag_hex?:string
        new_wrapped_acc_hex?:string
    }
    stored_object_hex?:string
    negative_snapverify?:{
        comment:string
        tampered_accumulator_hex:string
    }
}

const allVectors = [
    F1Core,
    F5Core,
    F9Core,
    F16Core,
    F17Core,
    F23Core,
    F16Engine,
    F17Engine,
    F23Engine,
] as CoreVector[]

// Sweep all vendored SEAL vectors to ensure:
// 1. NO vendored file is silently unconsumed
// 2. Schedule derivation is correct
// 3. Segment encryption/decryption is correct
// 4. Multiset operations work where present
test('AC5.1: sweep all vendored SEAL vectors', async t => {
    for (const vector of allVectors) {
        const cek = fromHex(vector.cek_hex)
        const params = paramsFromVector(vector)
        const sealCrypto = await sealCryptoFromVector(vector)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        // Test schedule fields
        t.equal(
            toHex(state.commitment),
            vector.schedule.commitment_hex,
            `${vector.name}: schedule commitment`,
        )

        t.equal(
            toHex(state.payloadKey),
            vector.schedule.payload_key_hex,
            `${vector.name}: schedule payload_key`,
        )

        if (vector.schedule.acc_key_hex !== undefined) {
            t.equal(
                toHex(state.snapKey),
                vector.schedule.acc_key_hex,
                `${vector.name}: schedule acc_key`,
            )
        } else {
            t.comment(
                `${vector.name}: no acc_key in schedule`,
            )
        }

        if (vector.schedule.nonce_base_hex !== undefined) {
            t.equal(
                toHex(state.nonceBase as Uint8Array),
                vector.schedule.nonce_base_hex,
                `${vector.name}: schedule nonce_base`,
            )
        } else {
            t.comment(
                `${vector.name}: no nonce_base in schedule`,
            )
        }

        // Test segments
        const segments:Array<{
            index:number
            is_final:number
            nonce_hex:string
            segment_aad_hex:string
            segment_key_hex?:string
            ciphertext_hex:string
            tag_hex:string
            contrib_hex?:string
        }> = []

        if (vector.segment_0) {
            segments.push({
                index: 0,
                ...vector.segment_0,
            })
        }

        if ('segments' in vector && vector.segments) {
            segments.push(...vector.segments)
        }

        if (segments.length === 0) {
            t.comment(`${vector.name}: no segments in vector`)
            continue
        }

        for (const seg of segments) {
            // Test seal/open roundtrip if AEAD is supported
            if (SUPPORTED_AEAD_IDS.has(vector.payload_info.aead_id)) {
                try {
                    const ct = fromHex(seg.ciphertext_hex)
                    const tag = fromHex(seg.tag_hex)
                    const nonce = fromHex(seg.nonce_hex)

                    // Open to get plaintext
                    const plaintext = await openSegment(
                        state,
                        {
                            index: BigInt(seg.index),
                            isFinal: seg.is_final === 1,
                            ciphertext: ct,
                            tag,
                            nonce,
                        },
                    )

                    // Re-seal and verify
                    const resealed = await sealSegment(
                        state,
                        {
                            index: BigInt(seg.index),
                            isFinal: seg.is_final === 1,
                            plaintext,
                            nonce,
                        },
                    )

                    t.equal(
                        toHex(resealed.ciphertext),
                        seg.ciphertext_hex,
                        `${vector.name}: seg ${seg.index} ciphertext`,
                    )
                    t.equal(
                        toHex(resealed.tag),
                        seg.tag_hex,
                        `${vector.name}: seg ${seg.index} tag`,
                    )
                } catch (err) {
                    t.ok(false,
                        `${vector.name}: seg ${seg.index} open/seal failed: ` +
                        `${err}`)
                }
            } else {
                t.comment(
                    `${vector.name}: aead_id ${vector.payload_info.aead_id} ` +
                    'unsupported, skipping seal/open',
                )
            }

            // Test multiset fields if present
            if (seg.contrib_hex !== undefined) {
                try {
                    const tag = fromHex(seg.tag_hex)
                    const contrib = await multisetContrib(
                        state,
                        BigInt(seg.index),
                        tag,
                    )
                    t.equal(
                        toHex(contrib),
                        seg.contrib_hex,
                        `${vector.name}: seg ${seg.index} contrib`,
                    )
                } catch (err) {
                    t.ok(false,
                        `${vector.name}: seg ${seg.index} multiset contrib ` +
                        `failed: ${err}`)
                }
            } else {
                t.comment(
                    `${vector.name}: seg ${seg.index} no contrib_hex`,
                )
            }
        }

        // Test snapshot multiset fields if present
        const engineVector = vector as EngineVector
        if (engineVector.snapshot) {
            try {
                // Compute accumulator from all contribs
                const contribs:Uint8Array[] = []
                for (const seg of segments) {
                    const tag = fromHex(seg.tag_hex)
                    const contrib = await multisetContrib(
                        state,
                        BigInt(seg.index),
                        tag,
                    )
                    contribs.push(contrib)
                }

                const acc = contribs[0].slice()
                for (let i = 1; i < contribs.length; i++) {
                    xorInto(acc, contribs[i])
                }

                t.equal(
                    toHex(acc),
                    engineVector.snapshot.accumulator_hex,
                    `${vector.name}: snapshot accumulator`,
                )

                // Compute snapshot from accumulator
                const snapshot = await multisetSnapshot(
                    state,
                    BigInt(segments.length),
                    acc,
                )

                t.equal(
                    toHex(snapshot),
                    engineVector.snapshot.snapshot_tag_hex,
                    `${vector.name}: snapshot tag`,
                )

                // Compute mask
                const mask = await multisetMask(
                    state,
                    BigInt(segments.length),
                    snapshot,
                )

                t.equal(
                    toHex(mask),
                    engineVector.snapshot.mask_hex,
                    `${vector.name}: snapshot mask`,
                )

                // Verify wrapped_acc = acc XOR mask
                const wrapped = acc.slice()
                xorInto(wrapped, mask)

                t.equal(
                    toHex(wrapped),
                    engineVector.snapshot.wrapped_acc_hex,
                    `${vector.name}: wrapped_acc`,
                )
            } catch (err) {
                t.ok(false,
                    `${vector.name}: snapshot multiset failed: ${err}`)
            }
        } else {
            t.comment(
                `${vector.name}: no snapshot fields`,
            )
        }

        // A tampered accumulator must not reproduce the vendored
        // snapshot tag: that mismatch is what a verifier rejects on.
        if (engineVector.negative_snapverify !== undefined) {
            const tampered = fromHex(
                engineVector.negative_snapverify.tampered_accumulator_hex,
            )
            const recomputed = await multisetSnapshot(
                state,
                BigInt(segments.length),
                tampered,
            )
            t.notEqual(
                toHex(recomputed),
                engineVector.snapshot!.snapshot_tag_hex,
                `${vector.name}: tampered accumulator fails snapverify`,
            )
        }

        // Rewriting segment 0 replaces its contribution to the
        // accumulator, which moves the snapshot tag, the mask and the
        // wrapped accumulator with it.
        const rewrite = engineVector.rewrite_segment_0
        if (rewrite !== undefined) {
            const newTag = fromHex(rewrite.new_tag_hex)

            const newContrib = await multisetContrib(state, 0n, newTag)
            t.equal(
                toHex(newContrib),
                rewrite.new_contrib_hex,
                `${vector.name}: rewrite seg 0 contrib`,
            )

            // Accumulator over the rewritten segment 0 and the
            // untouched tail.
            const newAcc = newContrib.slice()
            for (const seg of segments.slice(1)) {
                const contrib = await multisetContrib(
                    state,
                    BigInt(seg.index),
                    fromHex(seg.tag_hex),
                )
                xorInto(newAcc, contrib)
            }
            t.equal(
                toHex(newAcc),
                rewrite.new_accumulator_hex,
                `${vector.name}: rewrite accumulator`,
            )

            const newSnapshot = await multisetSnapshot(
                state,
                BigInt(segments.length),
                newAcc,
            )
            t.equal(
                toHex(newSnapshot),
                rewrite.new_snapshot_tag_hex,
                `${vector.name}: rewrite snapshot tag`,
            )

            const newMask = await multisetMask(
                state,
                BigInt(segments.length),
                newSnapshot,
            )
            const newWrapped = newAcc.slice()
            xorInto(newWrapped, newMask)
            t.equal(
                toHex(newWrapped),
                rewrite.new_wrapped_acc_hex,
                `${vector.name}: rewrite wrapped_acc`,
            )

            if (SUPPORTED_AEAD_IDS.has(vector.payload_info.aead_id)) {
                const isFinal = rewrite.is_final === 1
                const nonce = fromHex(rewrite.new_nonce_hex)
                try {
                    const plaintext = await openSegment(state, {
                        index: 0n,
                        isFinal,
                        ciphertext: fromHex(rewrite.new_ciphertext_hex),
                        tag: newTag,
                        nonce,
                    })
                    const resealed = await sealSegment(state, {
                        index: 0n,
                        isFinal,
                        plaintext,
                        nonce,
                    })
                    t.equal(
                        toHex(resealed.ciphertext),
                        rewrite.new_ciphertext_hex,
                        `${vector.name}: rewrite seg 0 ciphertext`,
                    )
                    t.equal(
                        toHex(resealed.tag),
                        rewrite.new_tag_hex,
                        `${vector.name}: rewrite seg 0 tag`,
                    )
                } catch (err) {
                    t.fail(
                        `${vector.name}: rewrite seg 0 open/seal failed: ` +
                        `${err}`,
                    )
                }
            }
        }

        // The stored object is the salt, the commitment and the single
        // sealed segment, concatenated. Build it from what this
        // implementation derives rather than from the vendored hex, so
        // the field pins our serialization and not itself.
        if (engineVector.stored_object_hex !== undefined) {
            const seg = segments[0]
            const isFinal = seg.is_final === 1
            const nonce = fromHex(seg.nonce_hex)
            try {
                const plaintext = await openSegment(state, {
                    index: BigInt(seg.index),
                    isFinal,
                    ciphertext: fromHex(seg.ciphertext_hex),
                    tag: fromHex(seg.tag_hex),
                    nonce,
                })
                const resealed = await sealSegment(state, {
                    index: BigInt(seg.index),
                    isFinal,
                    plaintext,
                    nonce,
                })
                const stored = toHex(concatAll([
                    params.salt,
                    state.commitment,
                    resealed.ciphertext,
                    resealed.tag,
                ]))
                t.equal(
                    stored,
                    engineVector.stored_object_hex,
                    `${vector.name}: stored object`,
                )
            } catch (err) {
                t.fail(
                    `${vector.name}: stored object open/seal failed: ${err}`,
                )
            }
        }
    }
})

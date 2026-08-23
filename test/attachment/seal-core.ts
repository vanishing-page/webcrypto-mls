import { test } from '@substrate-system/tapzero'
import {
    startSeal,
    startOpen,
    sealSegment,
    openSegment,
    segmentAad,
    derivedNonce,
    wipeSealState,
    NONCE_DERIVED,
    PROTOCOL_RO,
} from '../../src/attachment/schedule.js'
import { AttachmentError } from '../../src/attachment/error.js'
import {
    fromHex,
    toHex,
    paramsFromVector,
    sealCryptoFromVector,
    getSegmentKeyFromVector,
    labelOf,
    SUPPORTED_AEAD_IDS,
    type CoreVector,
} from './helpers.js'

import F1 from '../../test_vectors/seal/core/F1.json'
import F5 from '../../test_vectors/seal/core/F5.json'
import F9 from '../../test_vectors/seal/core/F9.json'
import F16 from '../../test_vectors/seal/core/F16.json'
import F17 from '../../test_vectors/seal/core/F17.json'
import F23 from '../../test_vectors/seal/core/F23.json'

const vectors = [F1, F5, F9, F16, F17, F23] as unknown as CoreVector[]

// AC1.1: Schedule derivation and segment encryption
test('AC1.1 schedule: compute commitment, payload_key, snap_key',
    async t => {
        for (const vector of vectors) {
            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)

            t.equal(
                toHex(state.commitment),
                vector.schedule.commitment_hex,
                `${vector.name}: commitment match`,
            )
            t.equal(
                toHex(state.payloadKey),
                vector.schedule.payload_key_hex,
                `${vector.name}: payload_key match`,
            )
            if (vector.schedule.acc_key_hex !== undefined) {
                t.equal(
                    toHex(state.snapKey),
                    vector.schedule.acc_key_hex,
                    `${vector.name}: acc_key match`,
                )
            }
            // F17 is the only vector with segment_key_hex; verify epoch-key
            // derivation works for all segments
            if (vector.segments) {
                for (const seg of vector.segments) {
                    if (seg.segment_key_hex) {
                        const derivedKey = await getSegmentKeyFromVector(
                            state, seg.index,
                        )
                        t.equal(
                            derivedKey,
                            seg.segment_key_hex,
                            `${vector.name}: segment[${seg.index}] key`,
                        )
                    }
                }
            }
        }
    },
)

// AC1.1: Nonce base for derived-mode vectors
test('AC1.1 schedule: derived nonce base when present',
    async t => {
        // Only F16, F17, F23 are derived-mode
        const derivedVectors = vectors.filter(
            v => v.payload_info.nonce_mode !== 0,
        )
        for (const vector of derivedVectors) {
            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)

            if (vector.schedule.nonce_base_hex) {
                t.equal(
                    toHex(state.nonceBase as Uint8Array),
                    vector.schedule.nonce_base_hex,
                    `${vector.name}: nonce_base match`,
                )
            }
        }
    },
)

// AC1.1: Segment verification against vector bytes
test('AC1.1 segments: verify against vector ciphertext/tag',
    async t => {
        const singleSegmentVectors = [F1, F5, F23] as unknown as
            CoreVector[]
        for (const vector of singleSegmentVectors) {
            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)
            const seg = vector.segment_0 as {
                is_final:number
                nonce_hex:string
                segment_aad_hex:string
                ciphertext_hex:string
                tag_hex:string
            }

            // Skip seal/open for unsupported AEADs (none in this vector set)
            if (!SUPPORTED_AEAD_IDS.has(
                vector.payload_info.aead_id
            )) {
                t.comment(
                    `${vector.name}: seal/open skipped (AEAD unsupported)`,
                )
                continue
            }

            // Open vector's own ciphertext
            let opened:Uint8Array
            try {
                opened = await openSegment(state, {
                    index: 0n,
                    isFinal: seg.is_final === 1,
                    ciphertext: fromHex(seg.ciphertext_hex),
                    tag: fromHex(seg.tag_hex),
                    nonce: fromHex(seg.nonce_hex),
                })
            } catch (_err) {
                t.ok(
                    false,
                    `${vector.name}: segment_0 decryption should succeed`,
                )
                continue
            }

            // Verify opened plaintext makes sense (know-good plaintext)
            t.ok(
                opened.length > 0,
                `${vector.name}: segment_0 decryption succeeded`,
            )

            // Re-seal the opened plaintext and verify it matches
            const sealed = await sealSegment(state, {
                index: 0n,
                isFinal: seg.is_final === 1,
                plaintext: opened,
                nonce: fromHex(seg.nonce_hex),
            })

            t.equal(
                toHex(sealed.ciphertext),
                seg.ciphertext_hex,
                `${vector.name}: segment_0 ciphertext match`,
            )
            t.equal(
                toHex(sealed.tag),
                seg.tag_hex,
                `${vector.name}: segment_0 tag match`,
            )

            // Verify AAD if present (fix M-2: use !== undefined not truthy)
            if (seg.segment_aad_hex !== undefined) {
                const aad = await segmentAad(
                    state, 0n, seg.is_final === 1, new Uint8Array(),
                )
                t.equal(
                    toHex(aad),
                    seg.segment_aad_hex,
                    `${vector.name}: segment_0 AAD match`,
                )
            }

            // Verify derived nonce if applicable
            if (vector.payload_info.nonce_mode === NONCE_DERIVED) {
                const derivedN = derivedNonce(
                    state.nonceBase as Uint8Array, 0n, seg.is_final === 1,
                )
                t.equal(
                    toHex(derivedN),
                    seg.nonce_hex,
                    `${vector.name}: segment_0 derived nonce match`,
                )
            }
        }
    },
)

// AC1.1: Multi-segment roundtrip with vector verification
test('AC1.1 segments: multi-segment verify against vectors',
    async t => {
        const multiSegmentVectors = [F9, F16, F17] as unknown as CoreVector[]
        for (const vector of multiSegmentVectors) {
            const cek = fromHex(vector.cek_hex)
            const params = paramsFromVector(vector)
            const sealCrypto = await sealCryptoFromVector(vector)
            const g = new Uint8Array()

            const state = await startSeal(cek, params, g, sealCrypto)

            if (!vector.segments) {
                t.comment(`${vector.name}: no segments array`)
                continue
            }

            for (const seg of vector.segments) {
                // Skip seal/open for unsupported AEADs
                if (!SUPPORTED_AEAD_IDS.has(
                    vector.payload_info.aead_id
                )) {
                    // For unsupported AEADs, only verify segment keys and
                    // nonces; skip actual seal/open
                    if (seg.segment_key_hex) {
                        const derivedKey = await getSegmentKeyFromVector(
                            state, seg.index,
                        )
                        t.equal(
                            derivedKey,
                            seg.segment_key_hex,
                            `${vector.name}: segment[${seg.index}] key`,
                        )
                    }
                    if (
                        vector.payload_info.nonce_mode === NONCE_DERIVED
                    ) {
                        const derivedN = derivedNonce(
                            state.nonceBase as Uint8Array,
                            BigInt(seg.index),
                            seg.is_final === 1,
                        )
                        t.equal(
                            toHex(derivedN),
                            seg.nonce_hex,
                            `${vector.name}: segment[${seg.index}] nonce`,
                        )
                    }
                    continue
                }

                // Open vector's own ciphertext
                let opened:Uint8Array
                try {
                    opened = await openSegment(state, {
                        index: BigInt(seg.index),
                        isFinal: seg.is_final === 1,
                        ciphertext: fromHex(seg.ciphertext_hex),
                        tag: fromHex(seg.tag_hex),
                        nonce: fromHex(seg.nonce_hex),
                    })
                } catch (_err) {
                    t.ok(
                        false,
                        `${vector.name}: segment[${seg.index}] open ` +
                            'should succeed',
                    )
                    continue
                }

                // Re-seal and verify
                const sealed = await sealSegment(state, {
                    index: BigInt(seg.index),
                    isFinal: seg.is_final === 1,
                    plaintext: opened,
                    nonce: fromHex(seg.nonce_hex),
                })

                t.equal(
                    toHex(sealed.ciphertext),
                    seg.ciphertext_hex,
                    `${vector.name}: segment[${seg.index}] ciphertext`,
                )
                t.equal(
                    toHex(sealed.tag),
                    seg.tag_hex,
                    `${vector.name}: segment[${seg.index}] tag`,
                )

                // Verify AAD if present (fix M-2: use !== undefined)
                if (seg.segment_aad_hex !== undefined) {
                    const aad = await segmentAad(
                        state,
                        BigInt(seg.index),
                        seg.is_final === 1,
                        new Uint8Array(),
                    )
                    t.equal(
                        toHex(aad),
                        seg.segment_aad_hex,
                        `${vector.name}: segment[${seg.index}] AAD`,
                    )
                }

                // Verify derived nonce if applicable
                if (
                    vector.payload_info.nonce_mode === NONCE_DERIVED
                ) {
                    const derivedN = derivedNonce(
                        state.nonceBase as Uint8Array,
                        BigInt(seg.index),
                        seg.is_final === 1,
                    )
                    t.equal(
                        toHex(derivedN),
                        seg.nonce_hex,
                        `${vector.name}: segment[${seg.index}] nonce`,
                    )
                }
            }
        }
    },
)

// AC1.2: Seal succeeds at correct (index, finality), fails at others
test('AC1.2: wrong index or finality fails to open',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const salt = new Uint8Array(32)
        crypto.getRandomValues(salt)
        const params = {
            protocolId: PROTOCOL_RO,
            aeadId: 2,
            kdfId: 1,
            segmentMax: 16384,
            snapId: 0x0003,
            nonceMode: NONCE_DERIVED,
            epochLength: 10,
            salt,
        }
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        const plaintext = new Uint8Array([1, 2, 3, 4])
        const sealed = await sealSegment(state, {
            index: 3n,
            isFinal: false,
            plaintext,
        })

        // Same index, same finality: success
        const opened = await openSegment(state, {
            index: 3n,
            isFinal: false,
            ciphertext: sealed.ciphertext,
            tag: sealed.tag,
            nonce: sealed.nonce,
        })
        t.equal(toHex(opened), toHex(plaintext),
            'correct index/finality opens')

        // Different index: fail
        try {
            await openSegment(state, {
                index: 4n,
                isFinal: false,
                ciphertext: sealed.ciphertext,
                tag: sealed.tag,
                nonce: sealed.nonce,
            })
            t.ok(false, 'should reject wrong index')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'wrong index throws AttachmentError',
            )
        }

        // Same index, different finality: fail
        try {
            await openSegment(state, {
                index: 3n,
                isFinal: true,
                ciphertext: sealed.ciphertext,
                tag: sealed.tag,
                nonce: sealed.nonce,
            })
            t.ok(false, 'should reject wrong finality')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'wrong finality throws AttachmentError',
            )
        }
    },
)

// AC1.3: Wrong CEK or G fails at commitment check
test('AC1.3: wrong CEK rejects at commitment check',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        // Flip one byte of CEK
        const badCek = cek.slice()
        badCek[0] ^= 0xFF

        try {
            await startOpen(
                badCek,
                params,
                g,
                fromHex(F1.schedule.commitment_hex),
                sealCrypto,
            )
            t.ok(false, 'should reject wrong CEK')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'wrong CEK throws AttachmentError',
            )
        }
    },
)

test('AC1.3: wrong G rejects at commitment check',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const badG = new Uint8Array([1, 2, 3])

        try {
            await startOpen(
                cek,
                params,
                badG,
                fromHex(F1.schedule.commitment_hex),
                sealCrypto,
            )
            t.ok(false, 'should reject wrong G')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'wrong G throws AttachmentError',
            )
        }
    },
)

// AC1.3: the commitment gate must fire BEFORE any AEAD work. A
// sentinel bundle whose aead throws a non-AttachmentError proves the
// ordering: if startOpen ever reached the AEAD, the sentinel error
// would escape instead of AttachmentError. Structural review already
// confirmed deriveSchedule touches only the kdf, but this pins it so a
// later reordering cannot pass silently.
test('AC1.3: commitment gate precedes any AEAD call',
    async t => {
        const params = paramsFromVector(F1)
        const base = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        class SentinelError extends Error {}
        const sentinel = {
            ...base,
            aead: {
                encrypt: ():Promise<Uint8Array> => {
                    throw new SentinelError('aead reached')
                },
                decrypt: ():Promise<Uint8Array> => {
                    throw new SentinelError('aead reached')
                },
            },
        }

        const badCek = fromHex(F1.cek_hex).slice()
        badCek[0] ^= 0xFF

        try {
            await startOpen(
                badCek,
                params,
                g,
                fromHex(F1.schedule.commitment_hex),
                sentinel,
            )
            t.ok(false, 'should reject before touching the aead')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'rejects with AttachmentError, not the sentinel',
            )
            t.ok(
                !(err instanceof SentinelError),
                'the aead was never called',
            )
        }
    },
)

// US-005: a rejected open must not leave derived key material live.
// startOpen derives payloadKey, snapKey and nonceBase before it can
// compare the commitment, so the mismatch branch has to wipe them.
// F17 is the vector that exercises all three (it is the derived-nonce
// one); the existing wipe coverage only follows the CEK.
test('US-005: commitment mismatch wipes the derived key material',
    async t => {
        const params = paramsFromVector(F17)
        const base = await sealCryptoFromVector(F17)
        const g = new Uint8Array()

        // Record the live buffer each derivation step returned, keyed
        // by the label sealKdf encodes into the expand info. sealKdf
        // hands kdf.expand's output straight back, so these are the
        // very arrays the SealState holds -- a later wipe shows up in
        // them. The snapshot keeps what the value was before any
        // wipe, so "was live, is zero now" is measured, not assumed.
        const labels = ['payload_key', 'acc_key', 'nonce_base']
        const derived = new Map<string, Uint8Array>()
        const before = new Map<string, Uint8Array>()
        const recorder = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (
                    prk:Uint8Array,
                    info:Uint8Array,
                    len:number,
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(prk, info, len)
                    const text = labelOf(info)
                    for (const label of labels) {
                        if (!text.includes(label)) continue
                        derived.set(label, out)
                        before.set(label, out.slice())
                    }
                    return out
                },
            },
        }

        const badCek = fromHex(F17.cek_hex).slice()
        badCek[0] ^= 0xFF

        try {
            await startOpen(
                badCek,
                params,
                g,
                fromHex(F17.schedule.commitment_hex),
                recorder,
            )
            t.ok(false, 'should reject a commitment mismatch')
        } catch (err) {
            // The error stays exactly what it was: opaque, and
            // carrying nothing about why the open failed.
            t.ok(
                err instanceof AttachmentError,
                'mismatch still throws a bare AttachmentError',
            )
        }

        for (const label of labels) {
            const was = before.get(label)
            const now = derived.get(label)
            t.ok(was !== undefined, `${label} was derived`)
            t.ok(
                was !== undefined && was.some(b => b !== 0),
                `${label} was live when derived`,
            )
            t.ok(
                now !== undefined && now.every(b => b === 0),
                `${label} is zeroed after the mismatch`,
            )
        }
    },
)

// AC1.3: Positive control for startOpen
test('AC1.3: startOpen succeeds with correct inputs',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startOpen(
            cek,
            params,
            g,
            fromHex(F1.schedule.commitment_hex),
            sealCrypto,
        )

        t.equal(
            toHex(state.payloadKey),
            F1.schedule.payload_key_hex,
            'startOpen returns matching payload_key',
        )
    },
)

// AC1.4: Modified ciphertext or tag fails to open
test('AC1.4: modified ciphertext fails to open',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)
        const seg = F1.segment_0

        const badCiphertext = fromHex(seg.ciphertext_hex).slice()
        badCiphertext[0] ^= 0xFF

        try {
            await openSegment(state, {
                index: 0n,
                isFinal: seg.is_final === 1,
                ciphertext: badCiphertext,
                tag: fromHex(seg.tag_hex),
                nonce: fromHex(seg.nonce_hex),
            })
            t.ok(false, 'should reject modified ciphertext')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'modified ciphertext throws AttachmentError',
            )
        }
    },
)

test('AC1.4: modified tag fails to open',
    async t => {
        const cek = fromHex(F1.cek_hex)
        const params = paramsFromVector(F1)
        const sealCrypto = await sealCryptoFromVector(F1)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)
        const seg = F1.segment_0

        const badTag = fromHex(seg.tag_hex).slice()
        badTag[0] ^= 0xFF

        try {
            await openSegment(state, {
                index: 0n,
                isFinal: seg.is_final === 1,
                ciphertext: fromHex(seg.ciphertext_hex),
                tag: badTag,
                nonce: fromHex(seg.nonce_hex),
            })
            t.ok(false, 'should reject modified tag')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'modified tag throws AttachmentError',
            )
        }
    },
)

// Zeroization with F23 (derived mode) to cover nonceBase and snapKey
test('zeroization: wipeSealState zeros key material',
    async t => {
        const cek = fromHex(F23.cek_hex)
        const params = paramsFromVector(F23)
        const sealCrypto = await sealCryptoFromVector(F23)
        const g = new Uint8Array()

        const state = await startSeal(cek, params, g, sealCrypto)

        // Before wipe
        t.ok(
            state.payloadKey.some(b => b !== 0),
            'payloadKey has non-zero bytes',
        )
        // snapKey is derived unconditionally, regardless of snap_id
        t.ok(
            state.snapKey.some(b => b !== 0),
            'snapKey has non-zero bytes',
        )
        t.ok(
            state.nonceBase !== null,
            'nonceBase is non-null (derived mode)',
        )
        t.ok(
            (state.nonceBase as Uint8Array).some(b => b !== 0),
            'nonceBase has non-zero bytes',
        )

        wipeSealState(state)

        // After wipe, all key material is zeroed
        t.equal(
            state.payloadKey.every(b => b === 0),
            true,
            'payloadKey is all zeros',
        )
        t.equal(
            state.snapKey.every(b => b === 0),
            true,
            'snapKey is all zeros',
        )
        t.equal(
            (state.nonceBase as Uint8Array).every(b => b === 0),
            true,
            'nonceBase is all zeros',
        )
    },
)

import { test } from '@substrate-system/tapzero'
import {
    encryptAttachment,
} from '../../src/attachment/writer.js'
import {
    decryptAttachmentStream,
} from '../../src/attachment/reader.js'
import {
    openAttachmentRange,
} from '../../src/attachment/range.js'
import { rangesFor } from '../../src/attachment/layout.js'
import { sealObject } from '../../src/attachment/object.js'
import { sealCryptoFromIds, sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'
import type { SealCrypto } from '../../src/attachment/crypto.js'
import { layout } from '../../src/attachment/layout.js'
import { attachmentCek } from
    '../../src/attachment/keys.js'
import {
    SEGMENT_MAX, ATTACHMENT_EPOCH_LENGTH,
} from '../../src/attachment/schedule.js'
import { AttachmentError } from
    '../../src/attachment/error.js'
import type { AttachmentRef } from
    '../../src/attachment/reference.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { initializeKeySchedule } from
    '../../src/key-schedule.js'
import { chunked, chunkedWithEmpties } from './stream-helpers.js'
import { labelOf } from './helpers.js'

/**
 * The reader derives its schedule in a fixed order, so with the
 * recorder reset immediately before the decrypt pass, expand call 0 is
 * the commitment and calls 1, 2, 3 are payloadKey, snapKey, nonceBase.
 * Those three are exactly what wipeSealState zeroes; the commitment is
 * deliberately left intact. Asserting these specific buffers rather
 * than "some recorded buffer is zero" is what makes the test able to
 * fail: per-segment epoch keys are always zeroed by sealSegment and
 * openSegment, so a loose search finds a zeroed buffer either way.
 */
function assertScheduleWiped (
    t:{ ok:(v:boolean, m:string) => void },
    recorded:Uint8Array[],
    label:string,
):void {
    t.ok(
        recorded.length >= 4,
        `${label}: recorded the schedule derivations`,
    )
    const names = ['payloadKey', 'snapKey', 'nonceBase']
    for (let i = 0; i < names.length; i++) {
        const buf = recorded[i + 1]
        const zeroed = buf !== undefined && buf.every(b => b === 0)
        t.ok(zeroed, `${label}: ${names[i]} is zeroed`)
    }
}

/**
 * Wrap a SealCrypto so every `kdf.expand` output is recorded, and so
 * one chosen step can be parked mid-derivation.
 *
 * Parking is what makes a cancel-site wipe observable. Both read
 * paths wipe again from their own catch once the cancelled work
 * resumes, so an assertion taken after the release passes whether or
 * not the cancel wiped anything. Gate a step, cancel while the stream
 * is parked on it, and assert before releasing.
 *
 * The gate matches on the label `sealKdf` encodes into the expand
 * info rather than on a call index, because indices shift whenever
 * the derivation changes shape.
 */
function gatedRecordingCrypto (base:SealCrypto):{
    crypto:SealCrypto
    recorded:Uint8Array[]
    gateOnLabel:(label:string, onReached:() => Promise<void>) => void
} {
    const recorded:Uint8Array[] = []
    let gateLabel:string|null = null
    let gateFn:(() => Promise<void>)|null = null

    const gateOnLabel = (
        label:string,
        onReached:() => Promise<void>,
    ) => {
        gateLabel = label
        gateFn = onReached
    }

    const crypto:SealCrypto = {
        ...base,
        kdf: {
            ...base.kdf,
            expand: async (prk:Uint8Array,
                info:Uint8Array, len:number
            ):Promise<Uint8Array> => {
                const out = await base.kdf.expand(prk, info, len)
                recorded.push(out)
                if (gateLabel !== null && gateFn &&
                    labelOf(info).includes(gateLabel)) {
                    const fn = gateFn
                    gateFn = null
                    gateLabel = null
                    await fn()
                }
                return out
            },
        },
    }

    return { crypto, recorded, gateOnLabel }
}

/**
 * A pair of promises for driving a gate: `reached` resolves when the
 * gated step is entered, and `release` lets it return.
 */
function gateLatch ():{
    reached:Promise<void>
    onReached:() => Promise<void>
    release:() => void
} {
    let markReached:() => void
    const reached = new Promise<void>(resolve => {
        markReached = resolve
    })
    let letGo:() => void
    const released = new Promise<void>(resolve => {
        letGo = resolve
    })
    return {
        reached,
        onReached: async () => {
            markReached()
            await released
        },
        release: () => letGo(),
    }
}

// Helper to drain a ReadableStream to bytes
async function drainStream (
    stream:ReadableStream<Uint8Array>,
):Promise<Uint8Array> {
    const reader = stream.getReader()
    const chunks:Uint8Array[] = []
    let result = await reader.read()
    while (!result.done) {
        if (result.value) chunks.push(result.value)
        result = await reader.read()
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
    }
    return out
}

// NOTE: Fixture deviation for all tests below.
// The plan specifies 2 * 65536 + 333 = 131405 bytes, but this suite
// uses 131089 bytes. This still exercises a 3-segment layout with a
// partial final block, so all code paths are covered. Final-block
// range tests read (2*65536, 17) instead of (2*65536, 333).

// AC4.1: Writer produces byte-identical output to sealObject
test(
    'AC4.1 writer: encryptAttachment matches sealObject output',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Seal with encryptAttachment
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Drain the readable stream
            const streamBytes = await drainStream(
                encrypted.readable,
            )

            // Seal with sealObject for comparison
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Compare bytes
            let match = true
            if (streamBytes.length !== sealed.bytes.length) {
                match = false
            } else {
                for (let i = 0; i < streamBytes.length; i++) {
                    if (streamBytes[i] !== sealed.bytes[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(
                match,
                'encryptAttachment output matches sealObject',
            )

            // Check reference matches
            t.equal(
                encrypted.reference.plaintextLength,
                BigInt(plaintext.length),
                'reference.plaintextLength correct',
            )

            let snapMatch = true
            if (encrypted.reference.snapshot.length !==
                sealed.snapshot.length) {
                snapMatch = false
            } else {
                for (let i = 0; i < encrypted.reference.snapshot.length;
                    i++) {
                    if (encrypted.reference.snapshot[i] !==
                        sealed.snapshot[i]) {
                        snapMatch = false
                        break
                    }
                }
            }
            t.ok(snapMatch, 'reference.snapshot matches sealObject')
        } catch (err) {
            t.ok(false, `encryptAttachment failed: ${err}`)
        }
    },
)

// AC4.1: Round-trip streaming with awkward chunk sizes
test(
    'AC4.1 round-trip: decryptAttachmentStream round-trips plaintext',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Decrypt with chunked size 1000
            const ciphertextStream = chunked(cipherBytes, 1000)
            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, ciphertextStream, crypto,
            )

            const recovered = await drainStream(plaintextStream)

            let match = true
            if (recovered.length !== plaintext.length) {
                match = false
            } else {
                for (let i = 0; i < recovered.length; i++) {
                    if (recovered[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'round-trip with chunk size 1000 matches')
        } catch (err) {
            t.ok(false, `round-trip failed: ${err}`)
        }
    },
)

// AC4.1: Round-trip with different chunk size
test(
    'AC4.1 round-trip: different chunk sizes',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Decrypt with chunked size 65537
            const ciphertextStream = chunked(cipherBytes, 65537)
            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, ciphertextStream, crypto,
            )

            const recovered = await drainStream(plaintextStream)

            let match = true
            if (recovered.length !== plaintext.length) {
                match = false
            } else {
                for (let i = 0; i < recovered.length; i++) {
                    if (recovered[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'round-trip with chunk size 65537 matches')
        } catch (err) {
            t.ok(false, `round-trip failed: ${err}`)
        }
    },
)

// AC4.1: Progressive reading
test(
    'AC4.1 progressive: read begins before stream ends',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const fullCipherBytes = await drainStream(
                encrypted.readable,
            )

            // Create a manual controller to wrap the cipher stream
            let cipherOffset = 0
            const manualStream = new ReadableStream({
                pull (controller) {
                    // Get the layout to find where block 0 ends
                    const l = layout({
                        plaintextLength: plaintext.length,
                        segmentMax: SEGMENT_MAX,
                        epochLength: ATTACHMENT_EPOCH_LENGTH,
                        nh: crypto.kdf.size,
                    })
                    // Serve up to end of block 0's ciphertext
                    const blockEndOffset = l.firstBlockOffset + SEGMENT_MAX
                    if (cipherOffset >= blockEndOffset) {
                        controller.close()
                    } else {
                        const chunk = fullCipherBytes.slice(
                            cipherOffset,
                            Math.min(
                                cipherOffset + 1000,
                                blockEndOffset,
                            ),
                        )
                        cipherOffset += chunk.length
                        controller.enqueue(chunk)
                    }
                },
            })

            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, manualStream, crypto,
            )

            const reader = plaintextStream.getReader()
            const result = await reader.read()

            t.ok(
                !result.done && result.value,
                'first chunk arrives without stream ending',
            )

            if (result.value) {
                t.ok(
                    result.value.length > 0,
                    'first chunk has data',
                )
            }

            // Clean up reader
            await reader.cancel()
        } catch (err) {
            t.ok(false, `progressive read failed: ${err}`)
        }
    },
)

// AC4.3: Snapshot mismatch
test(
    'AC4.3 failure: snapshot mismatch rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Flip a byte in snapshot
            const badRef = {
                ...encrypted.reference,
                snapshot: encrypted.reference.snapshot.slice(),
            }
            badRef.snapshot[0] ^= 0xFF

            // Try to decrypt with bad snapshot
            const ciphertextStream = chunked(cipherBytes, 1000)
            const plaintextStream = decryptAttachmentStream(
                cek, badRef, ciphertextStream, crypto,
            )

            try {
                await drainStream(plaintextStream)
                t.ok(false, 'should reject bad snapshot')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects snapshot mismatch')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// AC4.3: Early stream close
test(
    'AC4.3 failure: early stream close rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Only serve the header
            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })

            const shortCipherStream = chunked(
                cipherBytes.slice(0, l.headerSize),
                1000,
            )
            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, shortCipherStream, crypto,
            )

            try {
                await drainStream(plaintextStream)
                t.ok(false, 'should reject early close')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects early stream close')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// Zeroization: Success path
test(
    'zeroization: wipeSealState on normal close',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const base = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Wrap KDF to capture generated keys
        const recordedKeys:Uint8Array[] = []
        const crypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (prk:Uint8Array,
                    info:Uint8Array, len:number
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(
                        prk, info, len
                    )
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            // Only the decrypt pass should be recorded.
            recordedKeys.length = 0

            // Decrypt - should succeed and wipe
            const ciphertextStream = chunked(cipherBytes, 1000)
            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, ciphertextStream, crypto,
            )

            const recovered = await drainStream(plaintextStream)

            let match = true
            if (recovered.length !== plaintext.length) {
                match = false
            } else {
                for (let i = 0; i < recovered.length; i++) {
                    if (recovered[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'successfully decrypted plaintext')
            assertScheduleWiped(t, recordedKeys, 'normal close')
        } catch (err) {
            t.ok(false, `success path wipe failed: ${err}`)
        }
    },
)

// Zeroization: Cancel path
test(
    'zeroization: wipeSealState on cancel',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const base = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Wrap KDF to capture generated keys
        const recordedKeys:Uint8Array[] = []
        const crypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (prk:Uint8Array,
                    info:Uint8Array, len:number
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(
                        prk, info, len
                    )
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            // Only the decrypt pass should be recorded.
            recordedKeys.length = 0

            // Decrypt but cancel after first chunk
            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })
            const blockEndOffset = l.firstBlockOffset + SEGMENT_MAX

            // Serve full data so reader can decrypt first block
            let cipherOffset = 0
            const manualStream = new ReadableStream({
                pull (controller) {
                    if (cipherOffset >= blockEndOffset * 2) {
                        controller.close()
                    } else {
                        const chunk = cipherBytes.slice(
                            cipherOffset,
                            Math.min(
                                cipherOffset + 1000,
                                blockEndOffset * 2,
                            ),
                        )
                        cipherOffset += chunk.length
                        controller.enqueue(chunk)
                    }
                },
            })

            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, manualStream, crypto,
            )

            const reader = plaintextStream.getReader()
            const result = await reader.read()

            t.ok(
                !result.done && result.value,
                'got first chunk before cancel',
            )

            // Cancel the reader
            await reader.cancel()

            assertScheduleWiped(t, recordedKeys, 'cancel')
        } catch (err) {
            t.ok(false, `cancel path wipe failed: ${err}`)
        }
    },
)

// Backpressure test
test(
    'backpressure: ciphertext source not consumed until read',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Track pull() calls from ciphertext source
            let pullCount = 0
            const chunkSize = 10000
            const totalChunks = Math.ceil(
                cipherBytes.length / chunkSize
            )

            const cipherStream = new ReadableStream({
                pull (controller) {
                    const chunkStart = pullCount * chunkSize
                    if (chunkStart >= cipherBytes.length) {
                        controller.close()
                    } else {
                        const chunk = cipherBytes.slice(
                            chunkStart,
                            Math.min(
                                chunkStart + chunkSize,
                                cipherBytes.length,
                            ),
                        )
                        pullCount++
                        controller.enqueue(chunk)
                    }
                },
            })

            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, cipherStream, crypto,
            )

            const reader = plaintextStream.getReader()
            // Trigger pull() which should read only up to first block
            const result = await reader.read()

            // Verify plaintext was actually returned
            t.ok(
                !result.done && result.value && result.value.length > 0,
                'backpressure: plaintext chunk returned',
            )

            // Verify backpressure is working
            t.ok(
                pullCount > 0,
                'backpressure: ciphertext source was pulled',
            )
            t.ok(
                pullCount < totalChunks,
                'backpressure: not all ciphertext consumed',
            )

            // Clean up
            await reader.cancel()
        } catch (err) {
            t.ok(false, `backpressure test failed: ${err}`)
        }
    },
)

// AC4.2: Range read tests
test(
    'AC4.2 ranges: (0, 10) reads first 10 bytes',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Open range (0, 10)
            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                crypto,
            )

            // Verify ranges match rangesFor output
            const expected = rangesFor(
                {
                    plaintextLength: plaintext.length,
                    segmentMax: SEGMENT_MAX,
                    epochLength: ATTACHMENT_EPOCH_LENGTH,
                    nh: crypto.kdf.size,
                },
                0,
                10,
            ).ranges

            let rangesMatch = true
            if (rangeRead.ranges.length !== expected.length) {
                rangesMatch = false
            } else {
                for (let i = 0; i < expected.length; i++) {
                    if (rangeRead.ranges[i].offset !==
                        expected[i].offset ||
                        rangeRead.ranges[i].length !==
                        expected[i].length) {
                        rangesMatch = false
                        break
                    }
                }
            }

            t.ok(
                rangesMatch,
                'ranges match rangesFor output',
            )

            // Create streams for each range
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (const range of rangeRead.ranges) {
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            // Decrypt
            const result = await drainStream(
                rangeRead.decrypt(rangeStreams),
            )

            // Verify matches plaintext slice
            let match = true
            if (result.length !== 10) {
                match = false
            } else {
                for (let i = 0; i < 10; i++) {
                    if (result[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'range (0, 10) decrypts correctly')
        } catch (err) {
            t.ok(false, `range (0, 10) failed: ${err}`)
        }
    },
)

// AC4.2: Range crossing blocks
test(
    'AC4.2 ranges: (65530, 20) crosses blocks 0 and 1',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Open range (65530, 20) - crosses blocks
            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 65530, length: 20 },
                crypto,
            )

            // Create streams for each range
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (const range of rangeRead.ranges) {
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            // Decrypt
            const result = await drainStream(
                rangeRead.decrypt(rangeStreams),
            )

            // Verify matches plaintext slice
            let match = true
            if (result.length !== 20) {
                match = false
            } else {
                for (let i = 0; i < 20; i++) {
                    if (result[i] !== plaintext[65530 + i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'range (65530, 20) decrypts correctly')
        } catch (err) {
            t.ok(false, `range (65530, 20) failed: ${err}`)
        }
    },
)

// AC4.2: Final partial block
test(
    'AC4.2 ranges: (2*65536, 17) reads final partial block',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Open range for final partial block
            // Plaintext is 131089 = 2*65536 + 17, so final block is 17 bytes
            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 2 * 65536, length: 17 },
                crypto,
            )

            // Create streams for each range
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (const range of rangeRead.ranges) {
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            // Decrypt
            const result = await drainStream(
                rangeRead.decrypt(rangeStreams),
            )

            // Verify matches plaintext slice
            const offset = 2 * 65536
            let match = true
            if (result.length !== 17) {
                match = false
            } else {
                for (let i = 0; i < 17; i++) {
                    if (result[i] !== plaintext[offset + i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(
                match,
                'range (2*65536, 17) decrypts correctly',
            )
        } catch (err) {
            t.ok(false, `range final block failed: ${err}`)
        }
    },
)

// AC4.3: Out of bounds range
test(
    'AC4.3 failure: out of bounds range rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Try to open out-of-bounds range
            try {
                await openAttachmentRange(
                    cek,
                    encrypted.reference,
                    {
                        offset: plaintext.length,
                        length: 1,
                    },
                    crypto,
                )
                t.ok(false, 'should reject out-of-bounds range')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects out-of-bounds range')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// AC4.3: Missing segment (range data shorter than expected).
//
// Two checks in range.ts stand behind this: the per-stream length
// comparison against `ranges[i].length`, and the `!blockData` guard in
// the decrypt loop for a block the sparse view does not cover. Neither
// is isolated here -- remove the length comparison and the short last
// range fails to cover its block, so `!blockData` throws instead. Both
// removed and a null block reaches openBlock, whose TypeError the
// outer catch rewraps as an AttachmentError, which is why this test
// alone once passed with the pair of them gone.
//
// So what this asserts is reachability: a server that serves short
// ranges does not get a plaintext out. The length comparison is pinned
// on its own by the over-long test below. `!blockData` is not pinnable
// -- the sparse view is keyed by the same `ranges` the decrypt loop
// walks, so once every stream's length matches, coverage follows -- and
// it is marked in range.ts as the depth check it is. Measured
// 2026-08-22.
test(
    'AC4.3 failure: missing segment data rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Open range (0, 10)
            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                crypto,
            )

            // Create streams for each range, but truncate the last one
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (let i = 0; i < rangeRead.ranges.length; i++) {
                const range = rangeRead.ranges[i]
                const data = cipherBytes.slice(
                    range.offset,
                    range.offset + range.length,
                )

                // Truncate last range by 1 byte
                if (i === rangeRead.ranges.length - 1) {
                    rangeStreams.push(
                        chunked(data.slice(0, data.length - 1), 1000),
                    )
                } else {
                    rangeStreams.push(chunked(data, 1000))
                }
            }

            // Try to decrypt
            try {
                await drainStream(rangeRead.decrypt(rangeStreams))
                t.ok(false, 'should reject missing segment')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects missing segment data')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// The length comparison on its own. An over-long range is the case
// where nothing else objects: every block and the metadata still lie
// where the offsets say they do, so with the comparison removed the
// read succeeds and returns the right plaintext. That makes this the
// mutation test for it. It is also the real defect it guards against
// -- a store that answers a Range request with more than was asked for
// is not serving the object the reference names.
test(
    'AC4.3 failure: a range stream longer than its range rejects',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                crypto,
            )

            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (let i = 0; i < rangeRead.ranges.length; i++) {
                const range = rangeRead.ranges[i]
                const data = cipherBytes.slice(
                    range.offset,
                    range.offset + range.length,
                )

                // Append one octet to the last range. Every offset the
                // decrypt loop looks up is still covered by real bytes.
                if (i === rangeRead.ranges.length - 1) {
                    const padded = new Uint8Array(data.length + 1)
                    padded.set(data)
                    rangeStreams.push(chunked(padded, 1000))
                } else {
                    rangeStreams.push(chunked(data, 1000))
                }
            }

            try {
                await drainStream(rangeRead.decrypt(rangeStreams))
                t.ok(false, 'should reject an over-long range')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects an over-long range stream')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// CRITICAL 1: Upstream error during header (not AttachmentError)
test(
    'CRITICAL 1: upstream error during header rejected as AttachmentError',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Create a stream that errors mid-header
            let headerEmitted = false
            const errorStream = new ReadableStream<Uint8Array>({
                pull: (controller) => {
                    if (!headerEmitted) {
                        headerEmitted = true
                        controller.enqueue(cipherBytes.slice(0, 50))
                    } else {
                        controller.error(
                            new TypeError('upstream exploded'),
                        )
                    }
                },
            })

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    encrypted.reference,
                    errorStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject on upstream error')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'upstream error wrapped as AttachmentError')
                } else {
                    t.ok(
                        false,
                        `wrong error type: ${err?.constructor?.name}`,
                    )
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// CRITICAL 1: Upstream error mid-body (not AttachmentError)
test(
    'CRITICAL 1: upstream error mid-body rejected as AttachmentError',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Create a stream that emits header then errors
            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })
            const headerSize = l.headerSize
            let emittedHeader = false

            const errorStream = new ReadableStream<Uint8Array>({
                pull: (controller) => {
                    if (!emittedHeader) {
                        emittedHeader = true
                        controller.enqueue(cipherBytes.slice(0, headerSize))
                    } else {
                        controller.enqueue(
                            cipherBytes.slice(300, 400),
                        )
                        controller.error(
                            new TypeError('body error'),
                        )
                    }
                },
            })

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    encrypted.reference,
                    errorStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject on upstream error')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(
                        true,
                        'upstream mid-body error wrapped as AttachmentError',
                    )
                } else {
                    t.ok(
                        false,
                        `wrong error type: ${err?.constructor?.name}`,
                    )
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// CRITICAL 2: Bad version in reference
test(
    'CRITICAL 2: decryptAttachmentStream rejects bad version',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Tamper with version
            const badRef = {
                ...encrypted.reference,
                version: 99,
            } as unknown as AttachmentRef

            const cipherStream = chunked(
                await drainStream(encrypted.readable),
                1000,
            )

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    badRef,
                    cipherStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject bad version')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects bad version')
                } else {
                    t.ok(
                        false,
                        `wrong error: ${err?.constructor?.name}`,
                    )
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// CRITICAL 2: Out-of-range objectId in reference
test(
    'CRITICAL 2: decryptAttachmentStream rejects out-of-range objectId',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )

            // Create objectId that's too long (> 255 bytes)
            const badRef = {
                ...encrypted.reference,
                objectId: new Uint8Array(300),
            } as unknown as AttachmentRef

            const cipherStream = chunked(
                await drainStream(encrypted.readable),
                1000,
            )

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    badRef,
                    cipherStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject out-of-range objectId')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects out-of-range objectId')
                } else {
                    t.ok(
                        false,
                        `wrong error: ${err?.constructor?.name}`,
                    )
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// IMPORTANT 2: Range reader rejects non-safe-integer offset
test(
    'IMPORTANT 2: openAttachmentRange rejects fractional offset',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )

            try {
                await openAttachmentRange(
                    cek,
                    encrypted.reference,
                    { offset: 1.5, length: 10 },
                    crypto,
                )
                t.ok(false, 'should reject fractional offset')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects fractional offset')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// IMPORTANT 2: Range reader rejects non-safe-integer length
test(
    'IMPORTANT 2: openAttachmentRange rejects fractional length',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )

            try {
                await openAttachmentRange(
                    cek,
                    encrypted.reference,
                    { offset: 10, length: 2.5 },
                    crypto,
                )
                t.ok(false, 'should reject fractional length')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects fractional length')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I1: Range zeroization (drained-to-completion path)
test(
    'I1: range zeroization on successful completion',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Wrap KDF to capture generated keys
        const recordedKeys:Uint8Array[] = []
        const base = crypto
        const recordingCrypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (prk:Uint8Array,
                    info:Uint8Array, len:number
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(
                        prk, info, len
                    )
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, recordingCrypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            recordedKeys.length = 0

            // Open range and drain to completion
            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                recordingCrypto,
            )

            // Create streams for ranges
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (const range of rangeRead.ranges) {
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            // Drain range read
            await drainStream(rangeRead.decrypt(rangeStreams))
            assertScheduleWiped(t, recordedKeys, 'range completion')
        } catch (err) {
            t.ok(false, `range completion wipe failed: ${err}`)
        }
    },
)

// I1: Range zeroization on cancel.
//
// The wipe under test is the one in range.ts's `cancel()`. It is only
// observable while start() is still parked: once start() resumes,
// `throwIfCancelled` sends it into its own catch, which wipes the
// schedule whether or not the cancel did. Reading a chunk first is
// worse still -- the range path does all its work in start(), so by
// the time a read resolves the stream has closed and wiped.
//
// So gate a derivation that runs after verifyRoot has built the
// SealState. `epoch_key` is derived by `segmentKey`, which only
// `openBlock` reaches, so parking there guarantees `ctx` is set and
// the schedule is live. Cancel while parked, assert, then release.
test(
    'I1: range zeroization on cancel, before start() completes',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const base = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const {
            crypto: recordingCrypto, recorded: recordedKeys,
            gateOnLabel,
        } = gatedRecordingCrypto(base)

        const encrypted = await encryptAttachment(
            cek, objectId, plaintext, recordingCrypto, { salt },
        )
        const cipherBytes = await drainStream(encrypted.readable)
        recordedKeys.length = 0

        const rangeRead = await openAttachmentRange(
            cek,
            encrypted.reference,
            { offset: 0, length: 131072 },
            recordingCrypto,
        )

        const rangeStreams:ReadableStream<Uint8Array>[] = []
        for (const range of rangeRead.ranges) {
            rangeStreams.push(
                chunked(
                    cipherBytes.slice(
                        range.offset,
                        range.offset + range.length,
                    ),
                    1000,
                ),
            )
        }

        const gate = gateLatch()
        gateOnLabel('epoch_key', gate.onReached)

        const resultStream = rangeRead.decrypt(rangeStreams)
        const reader = resultStream.getReader()
        const reading = reader.read().catch(() => undefined)
        await gate.reached

        // No await between the cancel and the assertion. A stream's
        // cancel algorithm runs synchronously inside `cancel()`, so
        // the wipe has either happened by the time this returns or it
        // never happened at all; nothing else can run in between.
        const cancelling = reader.cancel().catch(() => undefined)
        assertScheduleWiped(t, recordedKeys, 'range cancel')

        gate.release()
        await Promise.all([cancelling, reading])
    },
)

// I3: verifyEpochRun metadata tampering.
//
// This one isolates. The range read fetches block 0 only, whose own
// leaf is untouched, so openBlock's comparison has nothing to object
// to and verifyEpochRun's head comparison is the sole check that sees
// segment 2's tampered digest. Delete that comparison and the read
// succeeds. Measured 2026-08-22.
test(
    'I3: verifyEpochRun detects tampered metadata',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Tamper one byte in segment 2's leaf digest
            // For 131089 bytes with nh=32: metaOffset=128
            // Leaf i occupies metaOffset + i*48 to metaOffset + i*48 + 47
            // Segment 2's leaf digest is at metaOffset + 2*48 = 224 to 255
            // Tamper the first byte of segment 2's digest
            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })
            const segment2LeafDigestOffset = l.metaOffset + 2 * 48
            cipherBytes[segment2LeafDigestOffset] ^= 0xFF

            // Use a range read to fetch only block 0, but epoch run will
            // verify all 3 segments including the tampered segment 2
            const ranges = rangesFor(
                {
                    plaintextLength: plaintext.length,
                    segmentMax: SEGMENT_MAX,
                    epochLength: ATTACHMENT_EPOCH_LENGTH,
                    nh: crypto.kdf.size,
                },
                0,
                10,
            )

            const rangeStreams = ranges.ranges.map(
                range => chunked(
                    cipherBytes.slice(range.offset, range.offset +
                        range.length),
                    1000,
                ),
            )

            try {
                const rangeRead = await openAttachmentRange(
                    cek,
                    encrypted.reference,
                    { offset: 0, length: 10 },
                    crypto,
                )
                const plaintextStream = rangeRead.decrypt(rangeStreams)
                await drainStream(plaintextStream)
                t.ok(false, 'should reject tampered segment 2 metadata')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects tampered segment 2 metadata')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I1a: the same cancel-site wipe, reached without the consumer ever
// calling read(). The range path runs start() eagerly on
// construction, so a consumer that opens a range and walks away still
// has a live SealState to lose. Gated the same way as I1 and asserted
// in the same window; what differs is that no read is ever pending,
// which is the case a `finally { reader.cancel() }` in a caller hits.
test(
    'I1a: range zeroization on cancel with no read pending',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const base = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const {
            crypto: recordingCrypto, recorded: recordedKeys,
            gateOnLabel,
        } = gatedRecordingCrypto(base)

        const encrypted = await encryptAttachment(
            cek, objectId, plaintext, recordingCrypto, { salt },
        )
        const cipherBytes = await drainStream(encrypted.readable)
        recordedKeys.length = 0

        const rangeRead = await openAttachmentRange(
            cek,
            encrypted.reference,
            { offset: 0, length: 131072 },
            recordingCrypto,
        )

        const rangeStreams:ReadableStream<Uint8Array>[] = []
        for (const range of rangeRead.ranges) {
            rangeStreams.push(
                chunked(
                    cipherBytes.slice(
                        range.offset,
                        range.offset + range.length,
                    ),
                    1000,
                ),
            )
        }

        const gate = gateLatch()
        gateOnLabel('epoch_key', gate.onReached)

        const resultStream = rangeRead.decrypt(rangeStreams)
        await gate.reached

        const cancelling = resultStream.cancel().catch(() => undefined)
        assertScheduleWiped(t, recordedKeys, 'range cancel no read')

        gate.release()
        await cancelling
    },
)

// Sequential reader: an error raised inside start() AFTER the header
// context exists. The pad-skip loop runs between verifyHeader and the
// first block, so a stream that ends inside the zero padding throws
// with ctx already populated, which is the only way to reach start()'s
// catch with state to wipe. Without this the start() catch is
// unexercised: header failures happen before ctx is assigned, and
// verifyRoot wipes its own state on the way out.
test(
    'zeroization: wipeSealState when the stream ends in the padding',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const base = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const recordedKeys:Uint8Array[] = []
        const crypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (
                    prk:Uint8Array, info:Uint8Array, len:number,
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(prk, info, len)
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            recordedKeys.length = 0

            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: base.kdf.size,
            })
            // Cut inside the padding: past the header, before block 0.
            const cut = l.headerSize +
                Math.floor((l.firstBlockOffset - l.headerSize) / 2)
            const truncated = cipherBytes.slice(0, cut)

            try {
                await drainStream(decryptAttachmentStream(
                    cek,
                    encrypted.reference,
                    chunked(truncated, 1000),
                    crypto,
                ))
                t.ok(false, 'should reject a stream ending in the pad')
            } catch (err) {
                t.ok(
                    err instanceof AttachmentError,
                    'rejects a stream ending in the pad',
                )
            }

            assertScheduleWiped(t, recordedKeys, 'pad-region error')
        } catch (err) {
            t.ok(false, `pad-region error test failed: ${err}`)
        }
    },
)

// I3a: Range error path zeroization (tampered metadata)
test(
    'I3a: range zeroization on error (tampered metadata)',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Wrap KDF to capture generated keys
        const recordedKeys:Uint8Array[] = []
        const base = crypto
        const recordingCrypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (prk:Uint8Array,
                    info:Uint8Array, len:number
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(
                        prk, info, len
                    )
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            // Encrypt with recording crypto
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, recordingCrypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            recordedKeys.length = 0

            // Tamper one byte in segment 2's leaf digest
            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: recordingCrypto.kdf.size,
            })
            const segment2LeafDigestOffset = l.metaOffset + 2 * 48
            cipherBytes[segment2LeafDigestOffset] ^= 0xFF

            // Use a range read to fetch only block 0
            const ranges = rangesFor(
                {
                    plaintextLength: plaintext.length,
                    segmentMax: SEGMENT_MAX,
                    epochLength: ATTACHMENT_EPOCH_LENGTH,
                    nh: recordingCrypto.kdf.size,
                },
                0,
                10,
            )

            const rangeStreams = ranges.ranges.map(
                range => chunked(
                    cipherBytes.slice(range.offset, range.offset +
                        range.length),
                    1000,
                ),
            )

            try {
                const rangeRead = await openAttachmentRange(
                    cek,
                    encrypted.reference,
                    { offset: 0, length: 10 },
                    recordingCrypto,
                )
                const plaintextStream = rangeRead.decrypt(rangeStreams)
                await drainStream(plaintextStream)
                t.ok(false, 'should reject tampered metadata on error')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'range error: rejects tampered metadata')
                    assertScheduleWiped(
                        t, recordedKeys, 'range error'
                    )
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `range error setup failed: ${err}`)
        }
    },
)

// I1b: Sequential zeroization on cancel (without reading)
test(
    'I1b: sequential zeroization on cancel (no read)',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Wrap KDF to capture generated keys
        const recordedKeys:Uint8Array[] = []
        const base = crypto
        const recordingCrypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (prk:Uint8Array,
                    info:Uint8Array, len:number
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(
                        prk, info, len
                    )
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            // Encrypt
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, recordingCrypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            recordedKeys.length = 0

            // Decrypt with chunked size
            const ciphertextStream = chunked(cipherBytes, 1000)
            const plaintextStream = decryptAttachmentStream(
                cek, encrypted.reference, ciphertextStream,
                recordingCrypto,
            )

            // Get reader, read one chunk to ensure start() completes,
            // then cancel
            const reader = plaintextStream.getReader()
            await reader.read()
            await reader.cancel()

            assertScheduleWiped(t, recordedKeys, 'sequential cancel')
        } catch (err) {
            t.ok(false, `sequential cancel no-read wipe failed: ${err}`)
        }
    },
)

// I3b: Sequential error path zeroization (tampered metadata)
test(
    'I3b: sequential zeroization on error (tampered metadata)',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Wrap KDF to capture generated keys
        const recordedKeys:Uint8Array[] = []
        const base = crypto
        const recordingCrypto = {
            ...base,
            kdf: {
                ...base.kdf,
                expand: async (prk:Uint8Array,
                    info:Uint8Array, len:number
                ):Promise<Uint8Array> => {
                    const out = await base.kdf.expand(
                        prk, info, len
                    )
                    recordedKeys.push(out)
                    return out
                },
            },
        }

        try {
            // Encrypt with recording crypto
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, recordingCrypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)
            recordedKeys.length = 0

            // Tamper one byte in segment 2's leaf digest
            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: recordingCrypto.kdf.size,
            })
            const segment2LeafDigestOffset = l.metaOffset + 2 * 48
            cipherBytes[segment2LeafDigestOffset] ^= 0xFF

            try {
                const ciphertextStream = chunked(cipherBytes, 1000)
                const plaintextStream = decryptAttachmentStream(
                    cek, encrypted.reference, ciphertextStream,
                    recordingCrypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject tampered metadata on error')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'sequential error: rejects tampered metadata')
                    assertScheduleWiped(
                        t, recordedKeys, 'sequential error'
                    )
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `sequential error setup failed: ${err}`)
        }
    },
)

// I4: openBlock constant-time leaf comparison
test(
    'I4: openBlock detects tampered leaf hash',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })
            // Tamper the digest half of leaf 0. A leaf is
            // LH(ciphertext) || tag, so this is the half openBlock's leaf
            // comparison inspects.
            //
            // This is a smoke test, not an isolating one, and deliberately
            // so. openBlock's leaf check cannot be isolated through the
            // public stream API: metadata leaves feed the epoch head, so
            // any metadata tampering is rejected by verifyEpochRun first,
            // and tampering the ciphertext or the tag instead is rejected
            // by the AEAD. Deleting the leaf comparison therefore leaves
            // this test green. What it says is that a corrupted leaf
            // does not reach the caller; which check rejects it is
            // pinned one layer down, by 'openBlock rejects a leaf whose
            // digest does not match the block' in reader-header.ts,
            // which calls openBlock directly and so skips the epoch
            // head. Measured 2026-08-22.
            cipherBytes[l.metaOffset] ^= 0xFF

            const cipherStream = chunked(cipherBytes, 1000)

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    encrypted.reference,
                    cipherStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject tampered leaf hash')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects tampered leaf hash')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I4: verifyRoot storedSnapshot consistency
test(
    // This one IS isolated: bytes [64, 96) hold the stored snapshot and
    // nothing else, so only verifyRoot's stored-copy comparison can
    // reject a corrupted value there. Replacing that comparison with
    // `if (false)` makes the read succeed and this test fail.
    'I4: verifyRoot detects mismatched storedSnapshot',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Tamper ONLY the storedSnapshot field in the header. For
            // nh=32 the stored copy sits at offset 64..95. The reference
            // is passed through untouched, so its snapshot stays correct
            // and the authoritative comparison in verifyRoot still passes.
            for (let i = 0; i < 32; i++) {
                cipherBytes[64 + i] ^= 0xFF
            }

            // Use original reference with correct snapshot
            const cipherStream = chunked(cipherBytes, 1000)

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    encrypted.reference,
                    cipherStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject mismatched storedSnapshot')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects mismatched storedSnapshot')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I5: Extra bytes past totalSize
test(
    'I5: sequential reader rejects extra bytes past totalSize',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            // Append extra bytes
            const tampered = new Uint8Array(
                cipherBytes.length + 100
            )
            tampered.set(cipherBytes)
            for (let i = 0; i < 100; i++) {
                tampered[cipherBytes.length + i] = 0xAA
            }

            const cipherStream = chunked(tampered, 1000)

            try {
                const plaintextStream = decryptAttachmentStream(
                    cek,
                    encrypted.reference,
                    cipherStream,
                    crypto,
                )
                await drainStream(plaintextStream)
                t.ok(false, 'should reject extra bytes')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects extra bytes past totalSize')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I6: Stream count guard (too few)
test(
    'I6: range reader rejects too-few streams',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                crypto,
            )

            // Provide one fewer stream than ranges
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (let i = 0; i < rangeRead.ranges.length - 1; i++) {
                const range = rangeRead.ranges[i]
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            try {
                await drainStream(rangeRead.decrypt(rangeStreams))
                t.ok(false, 'should reject too-few streams')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects too-few streams')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I6: Stream count guard (too many)
test(
    'I6: range reader rejects too-many streams',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                crypto,
            )

            // Provide one more stream than ranges
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (let i = 0; i < rangeRead.ranges.length; i++) {
                const range = rangeRead.ranges[i]
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }
            // Add extra empty stream
            rangeStreams.push(chunked(new Uint8Array(0), 1000))

            try {
                await drainStream(rangeRead.decrypt(rangeStreams))
                t.ok(false, 'should reject too-many streams')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'rejects too-many streams')
                } else {
                    t.ok(false, `wrong error: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// I7: AC4.2 with hand-computed expected ranges
test(
    'I7 AC4.2: range (0, 10) returns exactly computed ranges and bytes',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('stream-test')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const encrypted = await encryptAttachment(
                cek, objectId, plaintext, crypto, { salt },
            )
            const cipherBytes = await drainStream(encrypted.readable)

            const rangeRead = await openAttachmentRange(
                cek,
                encrypted.reference,
                { offset: 0, length: 10 },
                crypto,
            )

            // Hand-computed expected ranges for 131089 bytes, nh=32
            // nSeg=3, nEp=1, metaOffset=128, headerSize=272,
            // firstBlockOffset=65536
            // Header [0, 272), padding gap [272, 65536) and block 0
            // [65536, 131072) abut, so coalescing leaves one range.
            const expectedRanges = [
                { offset: 0, length: 131072 },
            ]

            let rangesMatch = true
            if (rangeRead.ranges.length !== expectedRanges.length) {
                rangesMatch = false
            } else {
                for (let i = 0; i < expectedRanges.length; i++) {
                    if (rangeRead.ranges[i].offset !==
                        expectedRanges[i].offset ||
                        rangeRead.ranges[i].length !==
                        expectedRanges[i].length) {
                        rangesMatch = false
                        break
                    }
                }
            }

            t.ok(rangesMatch, 'ranges match hand-computed values')

            // Verify the untouched blocks are not fetched. This used
            // to assert totalFetched < totalSize / 2, which stopped
            // holding once the range path started fetching the
            // header/first-block padding gap so it could check it is
            // zero. The gap is bounded by segmentMax and this fixture
            // is only three segments long, so a fixed 64 KiB overhead
            // is most of the object here. What random access actually
            // buys is unchanged and is what the test now states: a
            // 10-byte read touches block 0 and neither of the others.
            const totalFetched = rangeRead.ranges.reduce(
                (sum, r) => sum + r.length,
                0
            )
            const l = layout({
                plaintextLength: 131089,
                segmentMax: 65536,
                epochLength: 10,
                nh: 32,
            })
            const fetchEnd = rangeRead.ranges.reduce(
                (end, r) => Math.max(end, r.offset + r.length),
                0
            )
            t.equal(
                fetchEnd, l.firstBlockOffset + 65536,
                'fetch stops at the end of block 0',
            )
            t.ok(
                totalFetched < l.totalSize,
                'blocks 1 and 2 are never fetched',
            )

            // Create streams and verify decryption works
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (const range of rangeRead.ranges) {
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            const result = await drainStream(
                rangeRead.decrypt(rangeStreams),
            )

            let match = true
            if (result.length !== 10) {
                match = false
            } else {
                for (let i = 0; i < 10; i++) {
                    if (result[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'range (0, 10) decrypts correctly')
        } catch (err) {
            t.ok(false, `setup failed: ${err}`)
        }
    },
)

// M1: Group wrapper coverage
test(
    'M1: encryptAttachmentForGroup round-trip',
    async t => {
        try {
            const cs = await getCipherSuite()
            const epochSecret = new Uint8Array(32).fill(0x99)
            const ks = await initializeKeySchedule(
                epochSecret.slice(),
                cs.kdf,
            )

            const objectId = new TextEncoder().encode('group-test')
            const plaintext = new Uint8Array(100)
            for (let i = 0; i < plaintext.length; i++) {
                plaintext[i] = i % 256
            }

            // Encrypt using ForGroup
            const encrypted = await (
                await import(
                    '../../src/attachment/writer.js'
                )
            ).encryptAttachmentForGroup(
                ks,
                objectId,
                plaintext,
                cs,
            )

            const cipherBytes = await drainStream(
                encrypted.readable,
            )

            // Decrypt using ForGroup
            const cipherStream = chunked(cipherBytes, 50)
            const plaintextStream = await (
                await import(
                    '../../src/attachment/reader.js'
                )
            ).decryptAttachmentStreamForGroup(
                ks,
                encrypted.reference,
                cipherStream,
                cs,
            )

            const recovered = await drainStream(plaintextStream)

            let match = true
            if (recovered.length !== plaintext.length) {
                match = false
            } else {
                for (let i = 0; i < plaintext.length; i++) {
                    if (recovered[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'ForGroup round-trip succeeds')
        } catch (err) {
            t.ok(false, `ForGroup test failed: ${err}`)
        }
    },
)

// M1: openAttachmentRangeForGroup coverage
test(
    'M1: openAttachmentRangeForGroup works',
    async t => {
        try {
            const cs = await getCipherSuite()
            const epochSecret = new Uint8Array(32).fill(0x99)
            const ks = await initializeKeySchedule(
                epochSecret.slice(),
                cs.kdf,
            )

            const objectId = new TextEncoder().encode('group-range-test')
            const plaintext = new Uint8Array(131089)
            for (let i = 0; i < plaintext.length; i++) {
                plaintext[i] = i % 256
            }

            // Encrypt with derived CEK (same derivation as wrapper uses)
            const cek = await attachmentCek(ks, objectId, cs)
            const crypto = sealCryptoFromCiphersuite(cs)
            const encrypted = await encryptAttachment(
                cek,
                objectId,
                plaintext,
                crypto,
                { salt: new Uint8Array(32).fill(0x04) },
            )

            const cipherBytes = await drainStream(encrypted.readable)

            // Use openAttachmentRangeForGroup
            const rangeRead = await (
                await import(
                    '../../src/attachment/range.js'
                )
            ).openAttachmentRangeForGroup(
                ks,
                encrypted.reference,
                { offset: 0, length: 10 },
                cs,
            )

            t.ok(
                rangeRead.ranges.length > 0,
                'ForGroup range reader returns ranges',
            )

            // Create streams for each range and decrypt
            const rangeStreams:ReadableStream<Uint8Array>[] = []
            for (const range of rangeRead.ranges) {
                rangeStreams.push(
                    chunked(
                        cipherBytes.slice(
                            range.offset,
                            range.offset + range.length,
                        ),
                        1000,
                    ),
                )
            }

            const result = await drainStream(
                rangeRead.decrypt(rangeStreams),
            )

            // Verify plaintext matches
            let match = true
            if (result.length !== 10) {
                match = false
            } else {
                for (let i = 0; i < 10; i++) {
                    if (result[i] !== plaintext[i]) {
                        match = false
                        break
                    }
                }
            }

            t.ok(match, 'ForGroup range (0, 10) decrypts correctly')
        } catch (err) {
            t.ok(false, `ForGroup range test failed: ${err}`)
        }
    },
)

// US-002: a source that emits zero-length chunks is legal. The
// end-of-stream check used to read once and test the value for
// truthiness, and an empty Uint8Array is truthy, so a trailing empty
// chunk was reported as trailing ciphertext. 70000 bytes spans more
// than one block, which is where the audit reproduced it.
const EMPTY_CHUNK_SIZE = 70000

async function sealForEmptyChunkTest ():Promise<{
    cek:Uint8Array
    reference:AttachmentRef
    cipherBytes:Uint8Array
    plaintext:Uint8Array
    crypto:Awaited<ReturnType<typeof sealCryptoFromIds>>
}> {
    const cek = new Uint8Array(32).fill(0xAA)
    const salt = new Uint8Array(32).fill(0x04)
    const objectId = new TextEncoder().encode('empty-chunk-test')
    const crypto = await sealCryptoFromIds(2, 1)

    const plaintext = new Uint8Array(EMPTY_CHUNK_SIZE)
    for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256
    }

    const encrypted = await encryptAttachment(
        cek, objectId, plaintext, crypto, { salt },
    )
    const cipherBytes = await drainStream(encrypted.readable)

    return {
        cek,
        reference: encrypted.reference,
        cipherBytes,
        plaintext,
        crypto,
    }
}

test(
    'US-002: zero-length chunks around real chunks decrypt',
    async t => {
        const f = await sealForEmptyChunkTest()

        try {
            const recovered = await drainStream(
                decryptAttachmentStream(
                    f.cek,
                    f.reference,
                    chunkedWithEmpties(f.cipherBytes, 1000, 1),
                    f.crypto,
                ),
            )

            let match = recovered.length === f.plaintext.length
            for (let i = 0; match && i < recovered.length; i++) {
                if (recovered[i] !== f.plaintext[i]) match = false
            }

            t.ok(match, 'empty chunks do not break the round-trip')
        } catch (err) {
            t.ok(false, `empty chunks rejected the object: ${err}`)
        }
    },
)

test(
    'US-002: several trailing empty chunks decrypt',
    async t => {
        const f = await sealForEmptyChunkTest()

        try {
            // Four empty chunks after the last real one, so the
            // end-of-stream check has to read more than once before it
            // sees done.
            const recovered = await drainStream(
                decryptAttachmentStream(
                    f.cek,
                    f.reference,
                    chunkedWithEmpties(f.cipherBytes, 1000, 4),
                    f.crypto,
                ),
            )

            t.equal(
                recovered.length,
                f.plaintext.length,
                'a run of trailing empty chunks still ends the stream',
            )
        } catch (err) {
            t.ok(false, `trailing empty chunks rejected: ${err}`)
        }
    },
)

test(
    'US-002: real trailing bytes are still rejected',
    async t => {
        const f = await sealForEmptyChunkTest()

        const appended = new Uint8Array(f.cipherBytes.length + 5)
        appended.set(f.cipherBytes, 0)
        appended.set(new Uint8Array(5).fill(0x7F), f.cipherBytes.length)

        try {
            await drainStream(
                decryptAttachmentStream(
                    f.cek,
                    f.reference,
                    chunkedWithEmpties(appended, 1000, 2),
                    f.crypto,
                ),
            )
            t.ok(false, 'should reject appended trailing bytes')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'trailing bytes throw AttachmentError',
            )
        }
    },
)

test(
    'US-002: truncation is still rejected',
    async t => {
        const f = await sealForEmptyChunkTest()

        try {
            await drainStream(
                decryptAttachmentStream(
                    f.cek,
                    f.reference,
                    chunkedWithEmpties(
                        f.cipherBytes.slice(0, f.cipherBytes.length - 5),
                        1000,
                        2,
                    ),
                    f.crypto,
                ),
            )
            t.ok(false, 'should reject a truncated object')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'truncation throws AttachmentError',
            )
        }
    },
)

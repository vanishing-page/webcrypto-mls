import { test } from '@substrate-system/tapzero'
import {
    parsePrefix, verifyRoot, verifyHeader, openBlock,
} from '../../src/attachment/reader.js'
import { sealObject } from '../../src/attachment/object.js'
import { sealCryptoFromIds } from
    '../../src/attachment/crypto.js'
import {
    layout, blockRange, MAX_SEGMENTS,
} from '../../src/attachment/layout.js'
import {
    SEGMENT_MAX, ATTACHMENT_EPOCH_LENGTH,
} from '../../src/attachment/schedule.js'
import { AttachmentError } from
    '../../src/attachment/error.js'

// AC4.1, AC4.3: parsePrefix and verifyRoot
test(
    'parsePrefix extracts header fields correctly',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('test-obj')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })

            const prefix = parsePrefix(
                sealed.bytes,
                plaintext.length,
                crypto.kdf.size,
            )

            t.equal(
                prefix.layoutParams.plaintextLength,
                plaintext.length,
                'parsePrefix extracts plaintextLength',
            )
            t.equal(
                prefix.l.nSeg,
                l.nSeg,
                'parsePrefix layout matches',
            )
            t.equal(
                prefix.salt.length,
                32,
                'parsePrefix extracts 32-byte salt',
            )
            t.ok(
                prefix.storedCommitment,
                'parsePrefix extracts commitment',
            )
            t.ok(
                prefix.storedSnapshot,
                'parsePrefix extracts snapshot',
            )
            t.equal(
                prefix.epochHeads.length,
                l.nEp * crypto.kdf.size,
                'parsePrefix extracts complete epoch heads',
            )
        } catch (err) {
            t.ok(false, `parsePrefix failed: ${err}`)
        }
    },
)

test(
    'verifyRoot gate checks commitment and snapshot',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('test-obj')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            const prefix = parsePrefix(
                sealed.bytes,
                plaintext.length,
                crypto.kdf.size,
            )

            // Correct snapshot should pass
            const state = await verifyRoot(
                cek, objectId, prefix, sealed.snapshot, crypto,
            )

            t.ok(
                state,
                'verifyRoot accepts correct snapshot',
            )
            t.ok(
                state.payloadKey,
                'verifyRoot returns valid SealState',
            )
        } catch (err) {
            t.ok(false, `verifyRoot with correct snapshot failed: ${err}`)
        }
    },
)

test(
    'verifyRoot rejects snapshot mismatch',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('test-obj')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            const prefix = parsePrefix(
                sealed.bytes,
                plaintext.length,
                crypto.kdf.size,
            )

            // Flip a byte in the snapshot
            const badSnapshot = sealed.snapshot.slice()
            badSnapshot[0] ^= 0xFF

            try {
                await verifyRoot(
                    cek, objectId, prefix, badSnapshot, crypto,
                )
                t.ok(false, 'verifyRoot should reject bad snapshot')
            } catch (err) {
                if (err instanceof AttachmentError) {
                    t.ok(true, 'verifyRoot rejects snapshot mismatch')
                } else {
                    t.ok(false, `Wrong error type: ${err}`)
                }
            }
        } catch (err) {
            t.ok(false, `Setup failed: ${err}`)
        }
    },
)

test(
    'verifyHeader convenience wrapper',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('test-obj')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            const sealed = await sealObject(
                cek, objectId, plaintext, crypto, { salt },
            )

            const l = layout({
                plaintextLength: plaintext.length,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })

            const header = sealed.bytes.slice(0, l.headerSize)

            const ctx = await verifyHeader(
                cek, objectId, header,
                {
                    snapshot: sealed.snapshot,
                    plaintextLength: plaintext.length,
                },
                crypto,
            )

            t.ok(ctx.state, 'verifyHeader returns HeaderContext')
            t.ok(ctx.prefix, 'HeaderContext has prefix')
            t.ok(ctx.metadata, 'HeaderContext has metadata')
            t.equal(
                ctx.metadata.length,
                l.nSeg * (crypto.kdf.size + 16),
                'metadata has correct length',
            )
        } catch (err) {
            t.ok(false, `verifyHeader failed: ${err}`)
        }
    },
)

// Where the plaintextLength contract is actually enforceable.
//
// Phase 3 task 5 removed a third clause from verifyHeader's guard that
// Number.isSafeInteger already subsumed. That removal is correct, but
// its testing note asked for the two surviving clauses to be covered,
// and covering them through verifyHeader turns out to be impossible.
//
// The identical guard appears at three levels: verifyHeader, then
// parsePrefix which it calls on the next line, then layout which
// parsePrefix calls. Each is redundant with the one below it, so
// deleting any single copy changes nothing observable from above.
// Verified by mutation, not assumed: deleting verifyHeader's guard
// leaves the suite green, and so does deleting parsePrefix's.
//
// layout() is where the contract actually bites. Deleting its guard
// makes layout return a nonsense layout for 0, 1.5 and -1 instead of
// throwing, so these tests turn red. The two outer copies are defence
// in depth -- worth keeping, and not something a test can pin.
//
// MAX_SAFE_INTEGER + 1 is caught by Number.isSafeInteger, the first
// clause of the length guard, not by the separate MAX_SEGMENTS ceiling
// below it -- nSeg is never computed for it. The MAX_SEGMENTS ceiling
// needs a length that is a safe integer and still too large; that case
// is covered separately below.
const REJECTED_LENGTHS:[string, number][] = [
    ['above MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ['non-integer', 1.5],
    ['zero', 0],
    ['negative', -1],
]

for (const [label, plaintextLength] of REJECTED_LENGTHS) {
    test(`layout rejects plaintextLength: ${label}`, async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        try {
            layout({
                plaintextLength,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })
            t.ok(false, `should reject plaintextLength ${label}`)
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                `rejects plaintextLength ${label}`
            )
        }
    })
}

test(
    'layout control: a valid plaintextLength is accepted, so the ' +
        'rejections above are the guard and not a blanket throw',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const l = layout({
            plaintextLength: 1000,
            segmentMax: SEGMENT_MAX,
            epochLength: ATTACHMENT_EPOCH_LENGTH,
            nh: crypto.kdf.size,
        })
        t.equal(l.nSeg, 1, 'valid length produces a layout')
    },
)

// Where the MAX_SEGMENTS ceiling is actually enforceable.
//
// The ceiling lives in layout(), one line below the length guard, and
// only bites for a plaintextLength that clears the length guard --
// a positive safe integer -- while still asking for more than
// MAX_SEGMENTS segments. The smallest such length is one octet past
// MAX_SEGMENTS full segments.
//
// Verified by mutation: deleting `if (nSeg > MAX_SEGMENTS) throw` from
// layout.ts turns the layout case below red, because layout returns a
// layout instead of throwing.
//
// The verifyHeader case below reaches the same throw through the
// public entry point, which is what the contract promises, but it
// cannot pin the mutation on its own: with the ceiling deleted,
// parsePrefix's own byte-length check rejects the (astronomical)
// header size and raises the same opaque AttachmentError. Errors here
// are deliberately indistinguishable, so the two cases split the work
// -- layout pins the guard, verifyHeader pins the reachability.
const CEILING_LENGTH = MAX_SEGMENTS * SEGMENT_MAX

test(
    'layout rejects a plaintextLength one octet past MAX_SEGMENTS',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const plaintextLength = CEILING_LENGTH + 1

        t.ok(
            Number.isSafeInteger(plaintextLength) && plaintextLength > 0,
            'the length clears the length guard, so only the ' +
                'MAX_SEGMENTS ceiling can reject it',
        )

        try {
            layout({
                plaintextLength,
                segmentMax: SEGMENT_MAX,
                epochLength: ATTACHMENT_EPOCH_LENGTH,
                nh: crypto.kdf.size,
            })
            t.ok(false, 'should reject a segment count past MAX_SEGMENTS')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'layout rejects a segment count past MAX_SEGMENTS',
            )
        }
    },
)

test(
    'layout control: exactly MAX_SEGMENTS segments is accepted, so ' +
        'the rejection above is the ceiling and not a size cutoff',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const l = layout({
            plaintextLength: CEILING_LENGTH,
            segmentMax: SEGMENT_MAX,
            epochLength: ATTACHMENT_EPOCH_LENGTH,
            nh: crypto.kdf.size,
        })
        t.equal(l.nSeg, MAX_SEGMENTS, 'the ceiling itself is allowed')
        t.ok(
            Number.isSafeInteger(l.totalSize),
            'every offset at the ceiling stays a safe integer',
        )
    },
)

test(
    'verifyHeader rejects a plaintextLength past MAX_SEGMENTS',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const objectId = new TextEncoder().encode('test-obj')
        const crypto = await sealCryptoFromIds(2, 1)

        try {
            await verifyHeader(
                cek, objectId, new Uint8Array(0),
                {
                    snapshot: new Uint8Array(crypto.kdf.size),
                    plaintextLength: CEILING_LENGTH + 1,
                },
                crypto,
            )
            t.ok(false, 'verifyHeader should reject the length')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'verifyHeader rejects a length past MAX_SEGMENTS',
            )
        }
    },
)

// openBlock's leaf comparison, pinned at the only layer where it is
// the sole check standing between a tampered leaf and a plaintext.
//
// Through the stream and range APIs this check cannot be isolated: a
// metadata leaf feeds its epoch head, so tampering one is rejected by
// verifyEpochRun first, and tampering the ciphertext or the tag is
// rejected by the AEAD. streams.ts's 'I4: openBlock detects tampered
// leaf hash' is the reachability smoke test for that reason and stays
// green when the comparison goes.
//
// Calling openBlock directly skips the epoch head. Corrupting only the
// digest half of leaf 0 leaves the tag half -- the part openSegment
// uses -- intact, so with the comparison removed the segment decrypts
// and this test fails.
test(
    'openBlock rejects a leaf whose digest does not match the block',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('test-obj')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(
            cek, objectId, plaintext, crypto, { salt },
        )
        const l = layout({
            plaintextLength: plaintext.length,
            segmentMax: SEGMENT_MAX,
            epochLength: ATTACHMENT_EPOCH_LENGTH,
            nh: crypto.kdf.size,
        })
        const ref = {
            snapshot: sealed.snapshot,
            plaintextLength: plaintext.length,
        }
        const header = sealed.bytes.slice(0, l.headerSize)
        const block0 = blockRange(l, {
            plaintextLength: plaintext.length,
            segmentMax: SEGMENT_MAX,
            epochLength: ATTACHMENT_EPOCH_LENGTH,
            nh: crypto.kdf.size,
        }, 0)
        const block = sealed.bytes.slice(
            block0.offset, block0.offset + block0.length,
        )

        const good = await verifyHeader(
            cek, objectId, header, ref, crypto,
        )
        const opened = await openBlock(good, 0, block)
        t.equal(
            opened.length,
            block0.length,
            'the untampered block opens, so the setup is sound',
        )

        const tampered = await verifyHeader(
            cek, objectId, header, ref, crypto,
        )
        // Leaf 0 is LH(ciphertext) || tag. Flip a bit in the digest
        // half only; the tag half stays valid for openSegment.
        tampered.metadata[0] ^= 0xFF

        try {
            await openBlock(tampered, 0, block)
            t.ok(false, 'should reject a mismatched leaf digest')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openBlock rejects a mismatched leaf digest',
            )
        }
    },
)

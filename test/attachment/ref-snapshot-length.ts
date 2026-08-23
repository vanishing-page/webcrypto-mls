import { test } from '@substrate-system/tapzero'
import type { AttachmentRef } from '../../src/attachment/reference.js'
import {
    ATTACHMENT_REF_VERSION,
    SNAPSHOT_LENGTHS,
    encodeAttachmentRef,
    decodeAttachmentRef,
    validateAttachmentRef,
} from '../../src/attachment/reference.js'
import { AttachmentError } from '../../src/attachment/error.js'

// Lengths no supported ciphersuite can produce: empty, half a
// SHA-256 digest, one short of it, and one long.
const BAD_LENGTHS = [0, 16, 31, 33]

function refWithSnapshot (snapshot:Uint8Array):AttachmentRef {
    return {
        version: ATTACHMENT_REF_VERSION,
        objectId: new TextEncoder().encode('snapshot-length'),
        plaintextLength: BigInt(4096),
        snapshot,
        locator: new TextEncoder().encode('loc'),
    }
}

test('US-016: validateAttachmentRef rejects a wrong-length snapshot',
    t => {
        for (const len of BAD_LENGTHS) {
            try {
                validateAttachmentRef(refWithSnapshot(new Uint8Array(len)))
                t.fail(`accepted a ${len}-octet snapshot`)
            } catch (err) {
                t.ok(
                    err instanceof AttachmentError,
                    `rejects a ${len}-octet snapshot`,
                )
            }
        }
    },
)

test('US-016: every supported KDF output size still validates',
    t => {
        for (const len of SNAPSHOT_LENGTHS) {
            validateAttachmentRef(refWithSnapshot(new Uint8Array(len)))
            t.ok(true, `a ${len}-octet snapshot validates`)
        }
    },
)

// The kdfSize argument is the point of the story: a caller that knows
// the ciphersuite pins the exact length rather than the whole set, so
// a SHA-256 snapshot cannot be presented to a SHA-384 read.
test('US-016: an explicit kdfSize pins one length, not the set',
    t => {
        const short = refWithSnapshot(new Uint8Array(32))
        try {
            validateAttachmentRef(short, 48)
            t.fail('accepted a 32-octet snapshot under a 48-octet KDF')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'a 32-octet snapshot rejects under a 48-octet KDF',
            )
        }

        validateAttachmentRef(refWithSnapshot(new Uint8Array(48)), 48)
        t.ok(true, 'a 48-octet snapshot passes under a 48-octet KDF')
    },
)

test('US-016: a wrong-length snapshot rejects at encode and decode',
    t => {
        const bad = refWithSnapshot(new Uint8Array(31))
        try {
            encodeAttachmentRef(bad)
            t.fail('encode accepted a 31-octet snapshot')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'encode rejects a 31-octet snapshot',
            )
        }

        // Encode a valid ref, then rewrite the snapshot field in place
        // so the bytes are well formed but the length is wrong. This is
        // the shape an attacker controls: the wire, not the object.
        const good = refWithSnapshot(new Uint8Array(32).fill(0x5A))
        const encoded = encodeAttachmentRef(good)
        const snapAt = encoded.indexOf(0x5A) - 1
        const forged = new Uint8Array(encoded.length - 1)
        forged.set(encoded.subarray(0, snapAt), 0)
        forged[snapAt] = 31
        forged.set(encoded.subarray(snapAt + 2), snapAt + 1)

        try {
            decodeAttachmentRef(forged)
            t.fail('decode accepted a 31-octet snapshot')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'decode rejects a 31-octet snapshot',
            )
        }
    },
)

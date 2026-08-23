import { test } from '@substrate-system/tapzero'
import {
    encryptAttachment, encryptAttachmentForGroup,
} from '../../src/attachment/writer.js'
import { parsePrefix, verifyHeader } from
    '../../src/attachment/reader.js'
import { sealObject } from '../../src/attachment/object.js'
import { sealCryptoFromIds } from
    '../../src/attachment/crypto.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { buildLayout } from './attachment-fixtures.js'

// The second half of the mutation pass: the locator passthrough in
// writer.ts and the two byte-length guards on the read side. Each
// test is pinned at the layer where the guard is the only thing
// standing between the input and a wrong answer.

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

/**
 * writer.ts encryptAttachment(): the locator is the caller's handle
 * for fetching the stored bytes back, and nothing downstream reads
 * it, so a dropped locator is silent -- the object seals, the ref
 * verifies, and the bytes are simply unfetchable. Replace the option
 * with the empty default and this goes red.
 */
test('US-022b: encryptAttachment carries the locator into the ref',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x09)
        const objectId = new TextEncoder().encode('locator-obj')
        const plaintext = new Uint8Array(4096).fill(0x11)
        const locator = new TextEncoder().encode('blob://abc123')

        const sealed = await encryptAttachment(
            cek, objectId, plaintext, crypto, { locator },
        )

        t.deepEqual(
            Array.from(sealed.reference.locator),
            Array.from(locator),
            'the ref carries the locator it was given',
        )
    },
)

/**
 * The default is the other half of the same line: no locator means an
 * empty one, not `undefined` on a field the codec declares required.
 */
test('US-022b: encryptAttachment defaults the locator to empty',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const cek = new Uint8Array(32).fill(0x09)
        const objectId = new TextEncoder().encode('locator-obj')
        const plaintext = new Uint8Array(4096).fill(0x11)

        const sealed = await encryptAttachment(
            cek, objectId, plaintext, crypto,
        )

        t.ok(
            sealed.reference.locator instanceof Uint8Array,
            'the locator is a Uint8Array with no option given',
        )
        t.equal(
            sealed.reference.locator.length, 0,
            'and it is empty',
        )
    },
)

/**
 * writer.ts encryptAttachmentForGroup(): the wrapper rebuilds the
 * option bag rather than forwarding it, because `salt` must not
 * survive the trip. Drop `locator` from what it rebuilds and the
 * group path silently seals every object with an empty locator.
 */
test('US-022b: encryptAttachmentForGroup forwards the locator',
    async t => {
        const cs = await getCipherSuite(getCiphersuiteFromName(SUITE))
        const keySchedule = {
            applicationExportSecret: new Uint8Array(32).fill(0x07),
        }
        const objectId = new TextEncoder().encode('locator-group')
        const plaintext = new Uint8Array(4096).fill(0x11)
        const locator = new TextEncoder().encode('blob://group-42')

        const sealed = await encryptAttachmentForGroup(
            keySchedule, objectId, plaintext, cs, { locator },
        )

        t.deepEqual(
            Array.from(sealed.reference.locator),
            Array.from(locator),
            'the group wrapper passes the locator through',
        )
    },
)

/**
 * reader.ts parsePrefix(): every field it returns is a `slice`, and
 * `slice` past the end of a short buffer returns a short array rather
 * than throwing. Without the byte-length check a truncated buffer
 * parses into a prefix whose commitment, snapshot or epoch heads are
 * quietly short, and the failure surfaces later as a mismatch that
 * looks like tampering. This is the only layer that can tell the two
 * apart.
 */
test('US-022b: parsePrefix rejects a buffer short of the epoch heads',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const plaintext = new Uint8Array(131089)
        const { l } = buildLayout(plaintext.length, crypto)

        // One octet short of the last epoch head.
        const needed = l.epochHeadsOffset + (l.nEp * crypto.kdf.size)
        const short = new Uint8Array(needed - 1)

        try {
            parsePrefix(short, plaintext.length, crypto.kdf.size)
            t.fail('should reject a buffer short of the epoch heads')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

/**
 * The control for the case above: exactly the needed octets parse, so
 * the rejection is the length check and not a blanket throw. The
 * bytes are zeros, which is fine -- parsePrefix does no crypto.
 */
test('US-022b: parsePrefix control, the exact prefix length parses',
    async t => {
        const crypto = await sealCryptoFromIds(2, 1)
        const plaintextLength = 131089
        const { l } = buildLayout(plaintextLength, crypto)

        const needed = l.epochHeadsOffset + (l.nEp * crypto.kdf.size)
        const exact = new Uint8Array(needed)

        const prefix = parsePrefix(
            exact, plaintextLength, crypto.kdf.size,
        )

        t.equal(
            prefix.epochHeads.length,
            l.nEp * crypto.kdf.size,
            'the epoch heads come out at full length',
        )
    },
)

/**
 * reader.ts verifyHeader(): its guard is `!==`, not `<`, and
 * parsePrefix only needs bytes up to the end of the epoch heads. A
 * header cut off before the metadata region therefore clears
 * parsePrefix and passes the commitment and root checks -- both read
 * the prefix alone -- and the metadata slice comes back short or
 * empty. Every segment then opens against metadata that is not there.
 */
test('US-022b: verifyHeader rejects a header cut short of metadata',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('short-header')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(
            cek, objectId, plaintext, crypto, { salt },
        )
        const { l } = buildLayout(plaintext.length, crypto)

        // Long enough for parsePrefix, short of the metadata region.
        const truncated = sealed.bytes.slice(0, l.metaOffset)

        t.ok(
            truncated.length < l.headerSize,
            'the truncated header clears parsePrefix but is not ' +
                'the whole header',
        )

        try {
            await verifyHeader(
                cek, objectId, truncated,
                {
                    snapshot: sealed.snapshot,
                    plaintextLength: plaintext.length,
                },
                crypto,
            )
            t.fail('should reject a header short of headerSize')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

/**
 * The other side of `!==`: handing verifyHeader the whole stored
 * object instead of its header is a caller bug, and the slices it
 * takes would all still land in the right place, so nothing else
 * would ever notice.
 */
test('US-022b: verifyHeader rejects a header longer than headerSize',
    async t => {
        const cek = new Uint8Array(32).fill(0xAA)
        const salt = new Uint8Array(32).fill(0x04)
        const objectId = new TextEncoder().encode('long-header')
        const crypto = await sealCryptoFromIds(2, 1)

        const plaintext = new Uint8Array(131089)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        const sealed = await sealObject(
            cek, objectId, plaintext, crypto, { salt },
        )
        const { l } = buildLayout(plaintext.length, crypto)

        t.ok(
            sealed.bytes.length > l.headerSize,
            'the whole object is longer than its header',
        )

        try {
            await verifyHeader(
                cek, objectId, sealed.bytes,
                {
                    snapshot: sealed.snapshot,
                    plaintextLength: plaintext.length,
                },
                crypto,
            )
            t.fail('should reject a header longer than headerSize')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'should throw AttachmentError',
            )
        }
    },
)

// The positive control for both verifyHeader cases lives in
// reader-header.ts ('verifyHeader convenience wrapper'), which passes
// exactly headerSize octets and reads the metadata back at full
// length. It is not repeated here.

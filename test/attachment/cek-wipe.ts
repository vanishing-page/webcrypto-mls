import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl } from
    '../../src/crypto/ciphersuite.js'
import type { KeySchedule } from '../../src/key-schedule.js'
import {
    encryptAttachmentForGroup, encryptAttachment,
} from '../../src/attachment/writer.js'
import { attachmentCek } from '../../src/attachment/keys.js'
import { AttachmentError } from '../../src/attachment/error.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import {
    decryptAttachmentStream, decryptAttachmentStreamForGroup,
} from '../../src/attachment/reader.js'
import {
    openAttachmentRangeForGroup,
} from '../../src/attachment/range.js'
import {
    sealCryptoFromCiphersuite, sealCryptoFromIds, type SealCrypto,
} from '../../src/attachment/crypto.js'
import { buildLayout } from './attachment-fixtures.js'
import {
    drainStream, chunked,
} from './stream-helpers.js'
import { labelOf } from './helpers.js'

/**
 * The slice of tapzero's harness these helpers use.
 */
interface TestHarness {
    ok (value:unknown, msg?:string):void
    deepEqual (actual:unknown, expected:unknown, msg?:string):void
}

/**
 * Instrument a ciphersuite's kdf.expand to record all outputs,
 * and provide a control that verifies the 17th expand is the CEK.
 * Returns both the instrumented ciphersuite and utilities for testing.
 */
function instrumentCiphersuiteForCekWipe (
    baseCs:CiphersuiteImpl,
):{
    cs:CiphersuiteImpl
    recorded:Uint8Array[]
    gateAt:(index:number, onReached:() => Promise<void>) => void
    gateOnLabel:(label:string, onReached:() => Promise<void>) => void
    countWipedSince:(from:number) => number
    reset:() => void
    assertCekZeroed:(t:TestHarness, msg:string) => void
    assertCekLive:(t:TestHarness, msg:string) => void
    verifyControl:(
        t:TestHarness,
        ks:Pick<KeySchedule, 'applicationExportSecret'>,
        oid:Uint8Array
    ) => Promise<void>
} {
    const recorded:Uint8Array[] = []

    // A copy of each output taken at the moment it was produced.
    // `recorded` holds the live buffers, so a later wipe zeroes them;
    // the snapshot preserves what the value was before any wipe. The
    // pair is what lets a test say "this buffer was non-zero when
    // derived and is zero now" without guessing which index it is.
    const snapshots:Uint8Array[] = []

    let gateIndex = -1
    let gateLabel:string|null = null
    let gateFn:(() => Promise<void>)|null = null

    /**
     * Pause the `index`-th expand until `onReached` resolves. Used to
     * land a cancel at a chosen point in the derivation instead of
     * racing it against the four sealKdf awaits, which would be flaky.
     */
    const gateAt = (index:number, onReached:() => Promise<void>) => {
        gateIndex = index
        gateFn = onReached
    }

    /**
     * Same, but keyed on the label sealKdf encodes into the expand
     * info rather than on a position. Positions shift whenever the
     * derivation changes shape; a label names the step itself. Use
     * this when the exact step matters, as it does when a test needs
     * to park after the SealState is complete rather than partway
     * through building it.
     */
    const gateOnLabel = (
        label:string,
        onReached:() => Promise<void>,
    ) => {
        gateLabel = label
        gateFn = onReached
    }

    /**
     * How many buffers recorded at or after `from` were non-zero when
     * produced and are all-zero now, i.e. how many were wiped.
     */
    const countWipedSince = (from:number):number => {
        let n = 0
        for (let i = from; i < recorded.length; i++) {
            const was = snapshots[i]
            const now = recorded[i]
            if (!was || !now) continue
            if (was.every(b => b === 0)) continue
            if (now.every(b => b === 0)) n++
        }
        return n
    }

    // Wrap the kdf to record all expand outputs.
    // Record the actual buffer (not a slice) so that when the
    // wrapper wipes the CEK, the recorded entry shows as wiped.
    const cs:CiphersuiteImpl = {
        ...baseCs,
        kdf: {
            ...baseCs.kdf,
            expand: async (prk:Uint8Array,
                info:Uint8Array, len:number
            ):Promise<Uint8Array> => {
                const out = await baseCs.kdf.expand(
                    prk, info, len,
                )
                const index = recorded.length
                recorded.push(out)
                snapshots.push(out.slice())
                const byLabel = gateLabel !== null &&
                    labelOf(info).includes(gateLabel)
                if ((index === gateIndex || byLabel) && gateFn) {
                    const fn = gateFn
                    gateFn = null
                    gateLabel = null
                    await fn()
                }
                return out
            },
        },
    }

    /**
     * Verify the control: that recorded[16] is indeed the CEK.
     * Derivation is deterministic, so this pins which recorded
     * buffer is the CEK.
     *
     * Self-contained on purpose: it derives once through the
     * instrumented suite to populate `recorded`, then again through
     * the UNinstrumented `baseCs` for the expected value.
     *
     * Both halves matter. attachmentCek returns kdf.expand's output
     * unmodified, so a single derivation through `cs` would make
     * `expected` and the recorded entry the same object -- a
     * comparison that cannot fail. Deriving `expected` through
     * `baseCs` keeps it an independent buffer. Indexing from
     * `before` rather than 0 keeps the control correct whether or
     * not the caller has already recorded expands.
     */
    const verifyControl = async (
        t:TestHarness,
        ks:Pick<KeySchedule, 'applicationExportSecret'>,
        oid:Uint8Array,
    ):Promise<void> => {
        const before = recorded.length
        await attachmentCek(ks, oid, cs)
        const expected = await attachmentCek(ks, oid, baseCs)
        t.ok(
            recorded.length - before >= 17,
            'recorded at least 17 expands for CEK derivation'
        )
        t.deepEqual(
            recorded[before + 16], expected,
            'recorded[16] is the CEK'
        )
    }

    /**
     * Clear both arrays together. Resetting `recorded` alone leaves
     * `snapshots` holding an earlier derivation batch, so the two stop
     * being a matched pair and countWipedSince compares entries from
     * different runs.
     */
    const reset = () => {
        recorded.length = 0
        snapshots.length = 0
    }

    /**
     * The CEK is the 17th expand of a derivation batch. Assert on it
     * through here rather than inlining the index: a missing entry is
     * a FAILURE, never a pass. An earlier version of this file guarded
     * each site with `if (cekIdx < recorded.length) ... else ok(true)`,
     * which turned "I could not find the CEK" into a green tick at six
     * separate call sites.
     */
    const cekBuffer = (t:TestHarness):Uint8Array|undefined => {
        t.ok(
            recorded.length > 16,
            'a CEK was recorded (at least 17 expands)'
        )
        return recorded[16]
    }

    const assertCekZeroed = (t:TestHarness, msg:string) => {
        const cek = cekBuffer(t)
        t.ok(cek !== undefined && cek.every(b => b === 0), msg)
    }

    const assertCekLive = (t:TestHarness, msg:string) => {
        const cek = cekBuffer(t)
        t.ok(cek !== undefined && !cek.every(b => b === 0), msg)
    }

    return {
        cs,
        recorded,
        gateAt,
        gateOnLabel,
        countWipedSince,
        verifyControl,
        reset,
        assertCekZeroed,
        assertCekLive,
    }
}

// Task 1: Writer wrapper tests

test(
    'CEK wipe: control -- recorded[16] is CEK',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const { cs: instrCs, verifyControl } =
            instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('test-object')

        // Derive CEK with instrumented suite
        await attachmentCek(keySchedule, oid, instrCs)

        // Verify control
        await verifyControl(t, keySchedule, oid)
    },
)

test(
    'CEK wipe: success path -- CEK zeroed after encryption',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('test-object-1')
        const plaintext = new Uint8Array(1000)

        try {
            // Verify control with the instrumented suite
            await verifyControl(t, keySchedule, oid)

            // Reset recorded array for the actual encryption test
            reset()

            // Run encryption (which should wipe the CEK)
            await encryptAttachmentForGroup(
                keySchedule, oid, plaintext, instrCs,
            )

            assertCekZeroed(t, 'CEK is zeroed after success')
        } catch (err) {
            t.ok(false, `encryption failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: throw path -- CEK zeroed on encryptAttachment ' +
        'error',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const { cs: instrCs, verifyControl, reset, assertCekZeroed } =
            instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('test-object-2')
        const plaintext = new Uint8Array(1000)

        // Instrument cs.hpke.encryptAead to throw. `{...baseCs}` is a
        // shallow spread, so instrCs.hpke is the SAME object as
        // cs.hpke; patching it here patches both. Restored in the
        // finally below rather than relying on getCipherSuite handing
        // out a fresh hpke each call.
        let throwError = false
        // Hoisted so the catch below can pin the throw by identity.
        // The seal path does not wrap an AEAD failure in an
        // AttachmentError -- it propagates whatever the ciphersuite
        // threw -- so `instanceof AttachmentError` would be the wrong
        // assertion here. Pinning `=== simulatedFailure` is strictly
        // tighter: it rejects a TypeError from the instrumentation
        // itself as well as any error the seal path introduces.
        const simulatedFailure = new Error('simulated encryptAead failure')
        const originalEncryptAead = instrCs.hpke.encryptAead
        instrCs.hpke.encryptAead = async (
            key:Uint8Array,
            nonce:Uint8Array,
            aad:Uint8Array,
            pt:Uint8Array,
        ):Promise<Uint8Array> => {
            if (throwError) {
                throw simulatedFailure
            }
            return originalEncryptAead(key, nonce, aad, pt)
        }

        try {
            // Pin the CEK index against an independent derivation.
            await verifyControl(t, keySchedule, oid)

            // Reset instrumented cs for the test run
            reset()
            throwError = true

            // Run encryption with failure
            try {
                await encryptAttachmentForGroup(
                    keySchedule, oid, plaintext, instrCs,
                )
                t.ok(false, 'should have thrown')
            } catch (encErr) {
                t.ok(
                    encErr === simulatedFailure,
                    'encryptAttachmentForGroup rethrows the AEAD ' +
                    'failure unchanged',
                )

                assertCekZeroed(t, 'CEK is zeroed on throw')
            }
        } catch (err) {
            t.ok(false, `test setup failed: ${err}`)
        } finally {
            instrCs.hpke.encryptAead = originalEncryptAead
            throwError = false
        }
    },
)

test(
    'CEK wipe: reader normal close -- CEK zeroed after full read',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-normal-test')
        const plaintext = new Uint8Array(1000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt the plaintext
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0) // Clean up

            // Use reference from encrypted object
            const ref = encrypted.reference

            // Create ciphertext stream from encrypted bytes
            const ciphertext = chunked(encrypted.bytes, 100)

            // Reset recorded for the decrypt test
            reset()

            // Decrypt and read fully via wrapper
            const stream =
                await decryptAttachmentStreamForGroup(
                    keySchedule, ref, ciphertext, instrCs,
                )

            // Drain the stream to completion
            const result = await drainStream(stream)

            // Verify plaintext matches
            const plainMatches =
                result.total.length === plaintext.length &&
                result.total.every(
                    (b, i) => b === plaintext[i]
                )
            t.ok(plainMatches, 'plaintext decrypted correctly')

            assertCekZeroed(t, 'CEK zeroed on normal close')
        } catch (err) {
            t.ok(false, `test failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: reader error -- CEK zeroed on tampered header',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-error-test')
        const plaintext = new Uint8Array(500)

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0)

            // Use reference from encrypted object
            const ref = encrypted.reference

            // Tamper with ciphertext
            const tampered = encrypted.bytes.slice()
            tampered[100] ^= 0xFF

            // Create ciphertext stream
            const ciphertext = chunked(tampered, 100)

            // Reset recorded
            reset()

            // Try to decrypt
            const stream =
                await decryptAttachmentStreamForGroup(
                    keySchedule, ref, ciphertext, instrCs,
                )

            try {
                await drainStream(stream)
                t.ok(false, 'should have errored on tampered data')
            } catch (drainErr) {
                t.ok(
                    drainErr instanceof AttachmentError,
                    'tampered stream errors with AttachmentError',
                )

                assertCekZeroed(t, 'CEK zeroed on stream error')
            }
        } catch (err) {
            t.ok(false, `test setup failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: locked input stream -- AttachmentError, CEK zeroed',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-locked-test')
        const plaintext = new Uint8Array(500)

        // Pin CEK index
        await verifyControl(t, keySchedule, oid)

        const cek = await attachmentCek(keySchedule, oid, instrCs)
        const crypto = sealCryptoFromCiphersuite(instrCs)
        const encrypted = await encryptAttachment(
            cek, oid, plaintext, crypto,
        )
        cek.fill(0)

        const ciphertext = chunked(encrypted.bytes, 100)

        // Lock the stream before handing it over. getReader() on an
        // already-locked stream throws a raw TypeError, which is the
        // one failure mode that used to escape the wipe path because
        // it happened before the guarded region.
        const squatter = ciphertext.getReader()

        reset()

        const stream = await decryptAttachmentStreamForGroup(
            keySchedule, encrypted.reference, ciphertext, instrCs,
        )

        let caught:unknown = null
        try {
            await drainStream(stream)
        } catch (err) {
            caught = err
        }

        t.ok(
            caught instanceof AttachmentError,
            'locked stream surfaces AttachmentError, not TypeError'
        )

        assertCekZeroed(t, 'CEK zeroed after locked-stream failure')

        squatter.releaseLock()
    },
)

test(
    'CEK wipe: reader mid-read error -- CEK zeroed when the ' +
        'failure lands in pull, not start',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const { cs: instrCs, verifyControl, reset, assertCekZeroed } =
            instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-midread')
        const plaintext = new Uint8Array(500)

        await verifyControl(t, keySchedule, oid)

        const cek = await attachmentCek(keySchedule, oid, instrCs)
        const crypto = sealCryptoFromCiphersuite(instrCs)
        const encrypted = await encryptAttachment(
            cek, oid, plaintext, crypto,
        )
        cek.fill(0)

        reset()

        // The other error test tampers byte 100, which for this
        // plaintext is inside the 176-byte header, so it fails in
        // start() and exercises the same exit as the truncation test.
        // Tamper at firstBlockOffset instead -- the first segment --
        // so the header verifies, start() completes, and the failure
        // lands in pull()'s catch. That is the only path to the wipe
        // there, and without this test that wipe is unkillable.
        // Derived from layout(), not a literal, so it survives a
        // parameter change.
        const { l } = buildLayout(plaintext.length, crypto)
        const tampered = new Uint8Array(encrypted.bytes)
        tampered[l.firstBlockOffset] ^= 0xFF

        const stream = await decryptAttachmentStreamForGroup(
            keySchedule,
            encrypted.reference,
            chunked(tampered, 4096),
            instrCs,
        )

        try {
            await drainStream(stream)
            t.ok(false, 'should have errored mid-read')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'stream errored mid-read'
            )
            assertCekZeroed(t, 'CEK zeroed on mid-read error')
        }
    },
)

// The sequential reader wipes on cancel, on close and on error, so a
// cancel test only proves the cancel wipe if the stream can neither
// close nor fail while the assertion is taken. Two things arrange
// that here: the source stalls one octet short of the last block, so
// the read-ahead pull parks forever instead of reaching the close
// path; and the assertion runs in the same synchronous turn as
// cancel(), before the error that the cancel itself provokes can
// wipe. An earlier version read one chunk of a single-segment object
// and then awaited the cancel, which passed only because the
// read-ahead had not yet closed the stream -- a dependency on the
// queuing strategy's high-water mark, not on the code under test.
test(
    'CEK wipe: reader cancel -- CEK zeroed by the cancel itself',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-cancel-test')

        // Two segments, so one delivered block leaves the stream with
        // work outstanding no matter how far ahead the reader reads.
        const plaintext = new Uint8Array(70000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        // Pin CEK index
        await verifyControl(t, keySchedule, oid)

        const cek = await attachmentCek(keySchedule, oid, instrCs)
        const crypto = sealCryptoFromCiphersuite(instrCs)
        const encrypted = await encryptAttachment(
            cek, oid, plaintext, crypto,
        )
        cek.fill(0)

        // Everything but the final octet, then silence. The last
        // block is one octet short forever, so the pull that reads
        // ahead for it can neither decrypt nor see the source end.
        const short = encrypted.bytes.slice(
            0, encrypted.bytes.length - 1,
        )
        let served = false
        const stalling = new ReadableStream<Uint8Array>({
            pull (controller) {
                if (served) return new Promise<void>(() => {})
                served = true
                controller.enqueue(short)
                return Promise.resolve()
            },
        })

        reset()

        const stream = await decryptAttachmentStreamForGroup(
            keySchedule, encrypted.reference, stalling, instrCs,
        )

        const reader = stream.getReader()
        const first = await reader.read()
        t.ok(
            !first.done && first.value !== undefined,
            'first block delivered before the cancel'
        )

        // No await between these two lines. A stream's cancel
        // algorithm runs synchronously inside cancel(), so the CEK is
        // either zero here or it was never zeroed by the cancel.
        const cancelling = reader.cancel().catch(() => undefined)
        assertCekZeroed(t, 'CEK zeroed on cancel')

        await cancelling
        reader.releaseLock()
    },
)

test(
    'CEK wipe: reader pre-header failure -- CEK zeroed on ' +
        'truncated stream',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-trunc-test')
        const plaintext = new Uint8Array(1000)

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0)

            // Use reference from encrypted object
            const ref = encrypted.reference

            // Truncate encrypted bytes (below headerSize)
            const truncated = encrypted.bytes.slice(0, 50)

            // Create ciphertext stream
            const ciphertext = chunked(truncated, 20)

            // Reset recorded
            reset()

            // Try to decrypt
            const stream =
                await decryptAttachmentStreamForGroup(
                    keySchedule, ref, ciphertext, instrCs,
                )

            try {
                await drainStream(stream)
                t.ok(false, 'should have errored on truncation')
            } catch (drainErr) {
                t.ok(
                    drainErr instanceof AttachmentError,
                    'truncated stream errors with AttachmentError',
                )

                assertCekZeroed(t, 'CEK zeroed on pre-header error')
            }
        } catch (err) {
            t.ok(false, `test setup failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: reader two-flag regression -- a null-ctx cancel ' +
        'must not swallow the later SealState wipe',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, recorded, gateOnLabel, countWipedSince,
            verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-two-flag')
        const plaintext = new Uint8Array(500)

        await verifyControl(t, keySchedule, oid)

        const cek = await attachmentCek(keySchedule, oid, instrCs)
        const crypto = sealCryptoFromCiphersuite(instrCs)
        const encrypted = await encryptAttachment(
            cek, oid, plaintext, crypto,
        )
        cek.fill(0)

        reset()

        // WHERE the cancel lands decides what this test proves.
        //
        // Park on one of deriveSchedule's own steps and the CEK is
        // zeroed midway through building the SealState, so the keys
        // come out of zeros, verifyRoot rejects the root, and
        // verifyHeader wipes the state itself before ctx is ever
        // assigned. Both doWipe shapes then look identical and the
        // test proves nothing -- an earlier version of this file
        // parked there and concluded, wrongly, that the leak was
        // unreachable.
        //
        // Park on the step AFTER the schedule is complete and the
        // premise holds: the state was built from the real key, so
        // verifyRoot succeeds and ctx is assigned. Keyed on the label
        // rather than a position, because positions move.
        let reached:() => void
        const gateReached = new Promise<void>(resolve => {
            reached = resolve
        })
        let release:() => void
        const released = new Promise<void>(resolve => {
            release = resolve
        })
        gateOnLabel('snap_epoch_root', async () => {
            reached()
            await released
        })

        // The second doWipe -- the one a single latch swallows --
        // arrives via the padding-skip loop's read. That read is
        // guaranteed here because the gap the loop must skip,
        // firstBlockOffset - headerSize, is far larger than any chunk
        // the test feeds, so the loop cannot satisfy toSkip from
        // what is already buffered and must call read() again.
        //
        // An earlier version of this comment claimed the chunk size
        // had to divide headerSize exactly. That was wrong: a chunk
        // of headerSize + 7 leaves spare bytes buffered and the test
        // still passes. The gap size is the mechanism, not alignment.
        const { l } = buildLayout(plaintext.length, crypto)
        const chunk = 128
        t.ok(
            l.firstBlockOffset - l.headerSize > chunk,
            'gap exceeds one chunk, so the skip loop must read'
        )

        const stream = await decryptAttachmentStreamForGroup(
            keySchedule,
            encrypted.reference,
            chunked(encrypted.bytes, chunk),
            instrCs,
        )

        const reader = stream.getReader()
        const reading = reader.read().catch(() => undefined)
        await gateReached

        // Parked after the schedule is built but before ctx is set.
        const cancelling = reader.cancel().catch(() => undefined)
        for (let i = 0; i < 500; i++) {
            const c = recorded[16]
            if (c && c.every(b => b === 0)) break
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        assertCekZeroed(t, 'cancel wiped the CEK with ctx still null')

        release!()
        await Promise.all([cancelling, reading])

        // payload_key, acc_key and nonce_base are expand outputs, so
        // `recorded` aliases the very buffers wipeSealState zeroes.
        // Two flags wipe them on the second doWipe; one shared latch,
        // already set by the cancel above, swallows that call and
        // leaves all three live.
        for (let i = 0; i < 500 && countWipedSince(17) < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        t.ok(
            countWipedSince(17) >= 3,
            'SealState wiped after a null-ctx cancel (two flags)'
        )
    },
)

test(
    'CEK wipe: reader construction throw -- CEK zeroed on bad ' +
        'version',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const { cs: instrCs, verifyControl, reset, assertCekZeroed } =
            instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('reader-throw-test')

        // Pin the CEK index
        await verifyControl(t, keySchedule, oid)

        // Reset for test run
        reset()

        // Create a ref with bad version
        const badRef = {
            version: 99, // Invalid version
            objectId: oid.slice(),
            plaintextLength: BigInt(1000),
            snapshot: new Uint8Array(32),
            locator: new Uint8Array(),
        }

        // Mock ciphertext stream (won't be used)
        const ciphertext = new ReadableStream({
            pull () { /* never called */ },
        })

        // Try to create stream via wrapper
        try {
            await decryptAttachmentStreamForGroup(
                keySchedule, badRef, ciphertext, instrCs,
            )
            t.ok(false, 'should have thrown on bad version')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'decryptAttachmentStreamForGroup throws ' +
                'AttachmentError on a bad version',
            )

            assertCekZeroed(t, 'CEK zeroed on construction throw')
        }
    },
)

// Task 3: Range wrapper tests

test(
    'CEK wipe: range normal close -- CEK zeroed after full read',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-normal-test')
        const plaintext = new Uint8Array(1000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt the plaintext
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0) // Clean up

            // Use reference from encrypted object
            const ref = encrypted.reference

            // Reset recorded for the range test
            reset()

            // Open range and read
            const rangeRead = await openAttachmentRangeForGroup(
                keySchedule,
                ref,
                { offset: 0, length: 100 },
                instrCs,
            )

            // Get fresh range streams for decrypt
            const rangeStreams = rangeRead.ranges.map(r =>
                chunked(encrypted.bytes.slice(r.offset, r.offset +
                    r.length), 50)
            )

            // Decrypt and read
            const stream = rangeRead.decrypt(rangeStreams)
            await drainStream(stream)

            assertCekZeroed(t, 'CEK zeroed on normal close')
        } catch (err) {
            t.ok(false, `test failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: range error -- CEK zeroed on tampered data',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-error-test')
        const plaintext = new Uint8Array(500)

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0)

            // Use reference from encrypted object
            const ref = encrypted.reference

            // Tamper with ciphertext
            const tampered = encrypted.bytes.slice()
            tampered[100] ^= 0xFF

            // Reset recorded
            reset()

            // Open range
            const rangeRead = await openAttachmentRangeForGroup(
                keySchedule,
                ref,
                { offset: 0, length: 100 },
                instrCs,
            )

            // Get range streams from tampered data
            const rangeStreams = rangeRead.ranges.map(r =>
                chunked(tampered.slice(r.offset, r.offset +
                    r.length), 50)
            )

            // Try to decrypt
            const stream = rangeRead.decrypt(rangeStreams)

            try {
                await drainStream(stream)
                t.ok(false, 'should have errored on tampered data')
            } catch (drainErr) {
                t.ok(
                    drainErr instanceof AttachmentError,
                    'tampered range errors with AttachmentError',
                )

                assertCekZeroed(t, 'CEK zeroed on error')
            }
        } catch (err) {
            t.ok(false, `test setup failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: range cancel -- CEK zeroed when cancel lands ' +
        'before start completes',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, recorded, gateAt, verifyControl, reset,
            assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-cancel-test')
        const plaintext = new Uint8Array(2000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        await verifyControl(t, keySchedule, oid)

        const cek = await attachmentCek(keySchedule, oid, instrCs)
        const crypto = sealCryptoFromCiphersuite(instrCs)
        const encrypted = await encryptAttachment(
            cek, oid, plaintext, crypto,
        )
        cek.fill(0)

        reset()

        const rangeRead = await openAttachmentRangeForGroup(
            keySchedule,
            encrypted.reference,
            { offset: 0, length: 100 },
            instrCs,
        )

        const rangeStreams = rangeRead.ranges.map(r =>
            chunked(
                encrypted.bytes.slice(r.offset, r.offset + r.length),
                50,
            )
        )

        // Cancel has to land BEFORE start() completes. pull() emits
        // its whole window and reaches its own wipe on the first call,
        // so on any path where start() finishes the CEK is already
        // gone and the cancel-site wipe is unobservable. Gate an
        // expand inside start() and cancel while parked there.
        let reached:() => void
        const gateReached = new Promise<void>(resolve => {
            reached = resolve
        })
        let release:() => void
        const released = new Promise<void>(resolve => {
            release = resolve
        })
        gateAt(17, async () => {
            reached()
            await released
        })

        const stream = rangeRead.decrypt(rangeStreams)
        const reader = stream.getReader()
        const reading = reader.read().catch(() => undefined)
        await gateReached

        const cancelling = reader.cancel().catch(() => undefined)

        // Observe while still parked. This is the assertion that
        // makes the cancel-site wipe load-bearing: after release,
        // start()'s catch and pull() would wipe the CEK anyway, so
        // checking afterwards passes with or without it.
        for (let i = 0; i < 500; i++) {
            const c = recorded[16]
            if (c && c.every(b => b === 0)) break
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        assertCekZeroed(
            t, 'CEK zeroed by cancel before start completed'
        )

        release!()
        await Promise.all([cancelling, reading])
    },
)

test(
    'CEK wipe: range construction throw -- CEK zeroed on bad ref',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const { cs: instrCs, verifyControl, reset, assertCekZeroed } =
            instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-throw-test')

        // Pin the CEK index
        await verifyControl(t, keySchedule, oid)

        // Reset for test run
        reset()

        // Create a ref with bad version
        const badRef = {
            version: 99, // Invalid version
            objectId: oid.slice(),
            plaintextLength: BigInt(1000),
            snapshot: new Uint8Array(32),
            locator: new Uint8Array(),
        }

        // Try to open range via wrapper
        try {
            await openAttachmentRangeForGroup(
                keySchedule, badRef,
                { offset: 0, length: 100 },
                instrCs,
            )
            t.ok(false, 'should have thrown on bad version')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'openAttachmentRangeForGroup throws AttachmentError ' +
                'on a bad version',
            )

            assertCekZeroed(t, 'CEK zeroed on construction throw')
        }
    },
)

test(
    'CEK wipe: range seek-then-abandon -- CEK live before close, ' +
        'zeroed after',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
            assertCekLive,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-abandon-test')
        const plaintext = new Uint8Array(1000)

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0)

            // Reset recorded
            reset()

            // Open range (but don't call decrypt)
            const rangeRead = await openAttachmentRangeForGroup(
                keySchedule,
                encrypted.reference,
                { offset: 0, length: 100 },
                instrCs,
            )

            // Both halves matter. Asserting only that the CEK is
            // zero after close() would also pass against an
            // implementation that wiped too early.
            assertCekLive(t, 'CEK live before close()')

            // Now close it
            rangeRead.close()

            // Check CEK is zeroed after close
            assertCekZeroed(t, 'CEK zeroed after close()')
        } catch (err) {
            t.ok(false, `test failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: range single-use -- second decrypt errors',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-singleuse-test')
        const plaintext = new Uint8Array(1000)

        try {
            // Pin CEK index
            await verifyControl(t, keySchedule, oid)

            // Encrypt
            const cek = await attachmentCek(keySchedule, oid, instrCs)
            const crypto = sealCryptoFromCiphersuite(instrCs)
            const encrypted = await encryptAttachment(
                cek, oid, plaintext, crypto,
            )
            cek.fill(0)

            // Reset recorded
            reset()

            // Open range
            const rangeRead = await openAttachmentRangeForGroup(
                keySchedule,
                encrypted.reference,
                { offset: 0, length: 100 },
                instrCs,
            )

            // First decrypt: create streams and read
            const rangeStreams1 = rangeRead.ranges.map(r =>
                chunked(encrypted.bytes.slice(r.offset, r.offset +
                    r.length), 50)
            )
            const stream1 = rangeRead.decrypt(rangeStreams1)
            await drainStream(stream1)

            // CEK should now be zeroed
            assertCekZeroed(t, 'CEK zeroed after first decrypt closes')

            // Second decrypt: try with fresh streams
            const rangeStreams2 = rangeRead.ranges.map(r =>
                chunked(encrypted.bytes.slice(r.offset, r.offset +
                    r.length), 50)
            )
            const stream2 = rangeRead.decrypt(rangeStreams2)

            // Reading the stream should error (CEK is now zeros)
            try {
                await drainStream(stream2)
                t.ok(false, 'second decrypt should have errored')
            } catch (err) {
                // Pin the type. AC2.3 and convention 5 ask for
                // AttachmentError specifically, and the path does
                // throw one -- startOpen's commitment compare fails
                // against the zeroed CEK. Catching anything at all
                // would also pass on a programming fault.
                t.ok(
                    err instanceof AttachmentError,
                    'second decrypt errors with AttachmentError'
                )
            }
        } catch (err) {
            t.ok(false, `test setup failed: ${err}`)
        }
    },
)

test(
    'CEK wipe: range null-ctx cancel -- SealState wiped and the ' +
        'window is not decrypted for nobody',
    async t => {
        const cs = await getCipherSuite(
            getCiphersuiteFromName(
                'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
            )
        )
        const {
            cs: instrCs, recorded, gateOnLabel, countWipedSince,
            verifyControl, reset, assertCekZeroed,
        } = instrumentCiphersuiteForCekWipe(cs)

        const keySchedule = {
            applicationExportSecret: new Uint8Array(32),
        }
        const oid = new TextEncoder().encode('range-null-ctx')
        const plaintext = new Uint8Array(2000)
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256
        }

        await verifyControl(t, keySchedule, oid)

        const cek = await attachmentCek(keySchedule, oid, instrCs)
        const crypto = sealCryptoFromCiphersuite(instrCs)
        const encrypted = await encryptAttachment(
            cek, oid, plaintext, crypto,
        )
        cek.fill(0)

        // Baseline: how much derivation a read that is never
        // cancelled performs. The cancelled run below is compared
        // against this, so "start() stopped early" is measured
        // rather than assumed.
        reset()
        const fullRead = await openAttachmentRangeForGroup(
            keySchedule,
            encrypted.reference,
            { offset: 0, length: 100 },
            instrCs,
        )
        await drainStream(fullRead.decrypt(fullRead.ranges.map(r =>
            chunked(
                encrypted.bytes.slice(r.offset, r.offset + r.length),
                50,
            )
        )))
        const fullCount = recorded.length

        reset()

        const rangeRead = await openAttachmentRangeForGroup(
            keySchedule,
            encrypted.reference,
            { offset: 0, length: 100 },
            instrCs,
        )
        const rangeStreams = rangeRead.ranges.map(r =>
            chunked(
                encrypted.bytes.slice(r.offset, r.offset + r.length),
                50,
            )
        )

        // Park AFTER deriveSchedule has finished but BEFORE verifyRoot
        // returns, which is the whole window in which range.ts's
        // `ctx` is still null and the SealState is already built from
        // the real key. Gating on a step inside deriveSchedule instead
        // would zero the CEK midway, make verifyRoot reject, and prove
        // nothing -- verifyRoot wipes its own state on that path.
        let reached:() => void
        const gateReached = new Promise<void>(resolve => {
            reached = resolve
        })
        let release:() => void
        const released = new Promise<void>(resolve => {
            release = resolve
        })
        gateOnLabel('snap_epoch_root', async () => {
            reached()
            await released
        })

        const stream = rangeRead.decrypt(rangeStreams)
        const reader = stream.getReader()
        const reading = reader.read().catch(() => undefined)
        await gateReached

        const cancelling = reader.cancel().catch(() => undefined)
        for (let i = 0; i < 500; i++) {
            const c = recorded[16]
            if (c && c.every(b => b === 0)) break
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        assertCekZeroed(t, 'cancel wiped the CEK with ctx still null')

        release!()
        await Promise.all([cancelling, reading])

        // payload_key, acc_key and nonce_base are expand outputs, so
        // `recorded` aliases the very buffers wipeSealState zeroes. A
        // cancel that latched on the null ctx and never came back
        // leaves all three live.
        for (let i = 0; i < 500 && countWipedSince(17) < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        t.ok(
            countWipedSince(17) >= 3,
            'SealState wiped after a null-ctx cancel'
        )

        // And the cancel actually stopped the work: a start() that
        // ran to completion derives every fetched epoch's and every
        // fetched block's keys, which the baseline above counts.
        t.ok(
            recorded.length < fullCount,
            'cancelled start() derived less than a full read ' +
                `(${recorded.length} < ${fullCount})`
        )
    },
)

// L10: the SEAL KDF's own scratch buffers

/**
 * True when `needle` appears as a contiguous run anywhere in `hay`.
 */
function containsBytes (hay:Uint8Array, needle:Uint8Array):boolean {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) continue outer
        }
        return true
    }
    return false
}

/**
 * Wrap a SealCrypto so every buffer handed to or returned by
 * kdf.extract and kdf.expand is captured live (not copied), so a later
 * wipe shows up in the capture. The payload key is copied out when
 * produced, since the live buffer is wiped with the SealState.
 */
function recordKdfBuffers (base:SealCrypto):{
    crypto:SealCrypto
    captured:Uint8Array[]
    extractInputs:Uint8Array[]
    prks:Uint8Array[]
    payloadKeys:Uint8Array[]
} {
    const captured:Uint8Array[] = []
    // Copies of each extract input as it was when handed over, so a
    // control can show the CEK really did pass through the KDF.
    const extractInputs:Uint8Array[] = []
    const prks:Uint8Array[] = []
    const payloadKeys:Uint8Array[] = []
    const crypto:SealCrypto = {
        ...base,
        kdf: {
            ...base.kdf,
            extract: async (salt, ikm) => {
                const out = await base.kdf.extract(salt, ikm)
                captured.push(salt, ikm, out)
                extractInputs.push(ikm.slice())
                return out
            },
            expand: async (prk, info, len) => {
                const out = await base.kdf.expand(prk, info, len)
                captured.push(prk, info, out)
                prks.push(prk)
                if (labelOf(info).includes('payload_key')) {
                    payloadKeys.push(out.slice())
                }
                return out
            },
        },
    }
    return { crypto, captured, extractInputs, prks, payloadKeys }
}

async function sealAndReadRecorded ():Promise<{
    cek:Uint8Array
    captured:Uint8Array[]
    extractInputs:Uint8Array[]
    prks:Uint8Array[]
    payloadKeys:Uint8Array[]
}> {
    const rec = recordKdfBuffers(await sealCryptoFromIds(2, 1))
    const cek = new Uint8Array(32).map((_, i) => 0xa0 ^ i)
    const oid = new TextEncoder().encode('kdf-scratch')
    const plaintext = new Uint8Array(3000).fill(7)
    const sealed = await encryptAttachment(
        cek, oid, plaintext, rec.crypto,
    )
    await drainStream(decryptAttachmentStream(
        cek, sealed.reference, chunked(sealed.bytes, 1024), rec.crypto,
    ))
    return { cek, ...rec }
}

test('L10: no KDF buffer holds the CEK once the caller wipes it',
    async t => {
        const { cek, captured, extractInputs } =
            await sealAndReadRecorded()
        const cekCopy = cek.slice()
        t.ok(
            extractInputs.some(b => containsBytes(b, cekCopy)),
            'control: the CEK reached the KDF before the wipe',
        )
        cek.fill(0)
        const holders = captured.filter(b => b !== cek &&
            containsBytes(b, cekCopy))
        t.equal(holders.length, 0, 'no captured KDF buffer holds the CEK')
    },
)

test('L10: no KDF buffer holds the payload key after the read',
    async t => {
        const { payloadKeys, captured, prks } =
            await sealAndReadRecorded()
        t.equal(payloadKeys.length, 2, 'control: seal and open each ' +
            'derived a payload key')
        for (const pk of payloadKeys) {
            const holders = captured.filter(b => containsBytes(b, pk))
            t.equal(holders.length, 0,
                'no captured KDF buffer holds the payload key')
        }
        t.ok(prks.length > 0 && prks.every(p => p.every(b => b === 0)),
            'every PRK sealKdf handed to expand is zeroed')
    },
)

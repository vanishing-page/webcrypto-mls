import { test } from '@substrate-system/tapzero'
import type { Kdf } from '../../src/crypto/kdf.js'
import {
    attachmentCek,
    safeExportSecret,
} from '../../src/attachment/keys.js'
import { AttachmentError } from '../../src/attachment/error.js'
import {
    makeKdf,
    makeKdfImpl,
} from '../../src/crypto/implementation/default/make-kdf-impl.js'
import { initializeKeySchedule } from '../../src/key-schedule.js'
import { fromHex, toHex } from './helpers.js'

import keysVector from '../../test_vectors/seal/own/keys.json'

/**
 * The exporter tree is 16 levels deep, so a CEK derivation is 16
 * `expand` calls for the tree followed by one for the CEK itself.
 */
const TREE_DEPTH = 16
const CEK_INDEX = TREE_DEPTH

/**
 * Wrap a Kdf so every `expand` output is retained. `live` holds the
 * buffers the code under test is actually using, so a later wipe
 * shows up there; `snapshot` is a copy taken at the moment of
 * derivation, which is what lets a test say "this was non-zero when
 * derived and is zero now" rather than accepting a buffer that was
 * never populated in the first place.
 *
 * `throwAt` makes the n-th expand reject, which is how the throw
 * paths are reached without a fake ciphersuite that would also
 * change the derivation.
 */
function recordingKdf (
    base:Kdf,
    throwAt?:number,
):{ kdf:Kdf, live:Uint8Array[], snapshot:Uint8Array[] } {
    const live:Uint8Array[] = []
    const snapshot:Uint8Array[] = []
    const kdf:Kdf = {
        ...base,
        expand: async (prk:Uint8Array, info:Uint8Array, len:number) => {
            if (live.length === throwAt) {
                throw new AttachmentError()
            }
            const out = await base.expand(prk, info, len)
            live.push(out)
            snapshot.push(out.slice())
            return out
        },
    }
    return { kdf, live, snapshot }
}

interface Harness {
    ok (value:unknown, msg?:string):void
}

/**
 * Assert that entries `[from, to)` were non-zero when derived and
 * are all-zero now. A missing entry is a failure: an absent buffer
 * must never read as "wiped".
 */
function assertWipedRange (
    t:Harness,
    live:Uint8Array[],
    snapshot:Uint8Array[],
    from:number,
    to:number,
    what:string,
) {
    for (let i = from; i < to; i++) {
        const was = snapshot[i]
        const now = live[i]
        t.ok(
            was !== undefined && !was.every(b => b === 0),
            `${what}: node ${i} was non-zero when derived`,
        )
        t.ok(
            now !== undefined && now.every(b => b === 0),
            `${what}: node ${i} is zero now`,
        )
    }
}

function freshRoot ():Uint8Array {
    const root = new Uint8Array(32)
    for (let i = 0; i < root.length; i++) root[i] = i + 1
    return root
}

test(
    'exporter tree: control -- 17 expands, the last is the CEK',
    async t => {
        const base = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const { kdf, live, snapshot } = recordingKdf(base)
        const root = freshRoot()
        const oid = new TextEncoder().encode('control-object')

        const cek = await attachmentCek(
            { applicationExportSecret: root }, oid, { kdf },
        )

        t.equal(live.length, 17, 'CEK derivation is 17 expands')
        t.equal(
            toHex(snapshot[CEK_INDEX]),
            toHex(cek),
            'the 17th expand is the returned CEK',
        )
    },
)

test(
    'exporter tree: intermediate nodes are zero after ' +
    'attachmentCek returns',
    async t => {
        const base = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const { kdf, live, snapshot } = recordingKdf(base)
        const root = freshRoot()
        const rootBefore = toHex(root)
        const oid = new TextEncoder().encode('wipe-object')

        const cek = await attachmentCek(
            { applicationExportSecret: root }, oid, { kdf },
        )

        // All 16 tree nodes, componentSecret (index 15) included.
        assertWipedRange(t, live, snapshot, 0, TREE_DEPTH, 'success')

        t.ok(
            !cek.every(b => b === 0),
            'the returned CEK is not wiped',
        )
        t.equal(
            rootBefore,
            toHex(root),
            'the caller\'s applicationExportSecret survives',
        )
    },
)

test(
    'exporter tree: componentSecret is zero when the CEK ' +
    'derivation throws',
    async t => {
        const base = makeKdfImpl(makeKdf('HKDF-SHA256'))
        // The 17th expand -- the CEK itself -- rejects, so the
        // throw lands after safeExportSecret has returned.
        const { kdf, live, snapshot } = recordingKdf(base, CEK_INDEX)
        const root = freshRoot()
        const rootBefore = toHex(root)
        const oid = new TextEncoder().encode('throw-object')

        let threw = false
        try {
            await attachmentCek(
                { applicationExportSecret: root }, oid, { kdf },
            )
        } catch (err) {
            threw = err instanceof AttachmentError
        }

        t.ok(threw, 'attachmentCek rejects with AttachmentError')
        t.equal(live.length, TREE_DEPTH, 'no CEK was produced')
        assertWipedRange(t, live, snapshot, 0, TREE_DEPTH, 'throw')
        t.equal(
            rootBefore,
            toHex(root),
            'the caller\'s applicationExportSecret survives the throw',
        )
    },
)

test(
    'exporter tree: nodes derived before a mid-walk throw are zero',
    async t => {
        const base = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const { kdf, live, snapshot } = recordingKdf(base, 8)
        const root = freshRoot()
        const rootBefore = toHex(root)

        let threw = false
        try {
            await safeExportSecret(root, 0xF001, kdf)
        } catch (err) {
            threw = err instanceof AttachmentError
        }

        t.ok(threw, 'safeExportSecret rejects with AttachmentError')
        t.equal(live.length, 8, 'eight nodes were derived')
        assertWipedRange(t, live, snapshot, 0, 8, 'mid-walk')
        t.equal(
            rootBefore,
            toHex(root),
            'the caller\'s applicationExportSecret survives',
        )
    },
)

test(
    'exporter tree: wiping does not change the derived CEK',
    async t => {
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const epochSecret = fromHex(keysVector.epoch_secret_hex)
        const keySchedule = await initializeKeySchedule(epochSecret, kdf)
        const objectId = fromHex(keysVector.object_id_hex)

        const first = await attachmentCek(keySchedule, objectId, { kdf })
        const second = await attachmentCek(keySchedule, objectId, { kdf })

        t.equal(
            toHex(first),
            keysVector.cek_hex,
            'CEK still matches the frozen vector',
        )
        t.equal(
            toHex(second),
            keysVector.cek_hex,
            'a second derivation from the same key schedule matches',
        )
    },
)

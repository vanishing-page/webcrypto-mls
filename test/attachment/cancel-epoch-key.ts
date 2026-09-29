import { test } from '@substrate-system/tapzero'
import type { CiphersuiteImpl } from
    '../../src/crypto/ciphersuite.js'
import { getCiphersuiteFromName } from
    '../../src/crypto/ciphersuite.js'
import { getCipherSuite } from
    '../../src/crypto/get-ciphersuite-impl.js'
import { encryptAttachment } from '../../src/attachment/writer.js'
import {
    decryptAttachmentStream,
    decryptAttachmentStreamForGroup,
} from '../../src/attachment/reader.js'
import { openAttachmentRange } from '../../src/attachment/range.js'
import { attachmentCek } from '../../src/attachment/keys.js'
import { sealCryptoFromCiphersuite } from
    '../../src/attachment/crypto.js'
import { chunked } from './stream-helpers.js'
import { labelOf } from './helpers.js'

// Audit 2026-09 M5: a cancel that lands while `segmentKey` is parked
// on the `epoch_key` derivation. The wipe runs first, then the
// derivation resumes. The regression was that it cached the fresh key
// into the already-wiped state and went on to decrypt with it.
//
// Every assertion here is taken after the gate is released, because
// the bug is in what happens once the derivation resumes.

/**
 * Wrap a ciphersuite so every `kdf.expand` is recorded with its label,
 * every AEAD decryption is counted, and one labelled expand can be
 * parked until the test releases it.
 */
function gatedSuite (cs:CiphersuiteImpl, gateLabel:string):{
    cs:CiphersuiteImpl
    epochKeys:() => Uint8Array[]
    decrypts:() => number
    reached:Promise<void>
    arm:() => void
    release:() => void
} {
    const recorded:{ label:string, out:Uint8Array }[] = []
    let decrypts = 0
    let armed = false
    let markReached!:() => void
    const reached = new Promise<void>(resolve => {
        markReached = resolve
    })
    let letGo!:() => void
    const released = new Promise<void>(resolve => {
        letGo = resolve
    })

    const wrapped:CiphersuiteImpl = {
        ...cs,
        kdf: {
            ...cs.kdf,
            expand: async (prk, info, len) => {
                const out = await cs.kdf.expand(prk, info, len)
                const label = labelOf(info)
                recorded.push({ label, out })
                if (armed && label.includes(gateLabel)) {
                    armed = false
                    markReached()
                    await released
                }
                return out
            },
        },
        hpke: {
            ...cs.hpke,
            decryptAead: (key, nonce, aad, ct) => {
                decrypts++
                return cs.hpke.decryptAead(key, nonce, aad, ct)
            },
        },
    }

    return {
        cs: wrapped,
        epochKeys: () => recorded
            .filter(r => r.label.includes('epoch_key'))
            .map(r => r.out),
        decrypts: () => decrypts,
        reached,
        arm: () => { armed = true },
        release: () => letGo(),
    }
}

/**
 * Let the parked derivation run to wherever it goes next. After the
 * release, everything up to the AEAD call is promise continuations
 * (derived nonces and an empty AAD need no crypto), so one macrotask
 * turn drains all of it. This is a queue flush, not a timing wait.
 */
function flush ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

type T = {
    ok:(v:unknown, m?:string) => void
    equal:(a:unknown, b:unknown, m?:string) => void
}

function assertNoLiveEpochKey (
    t:T,
    g:ReturnType<typeof gatedSuite>,
    decryptsAtCancel:number,
    label:string,
):void {
    const keys = g.epochKeys()
    t.ok(keys.length > 0, `${label}: an epoch key was derived`)
    t.ok(
        keys.every(k => k.every(b => b === 0)),
        `${label}: every derived epoch key is zeroed`,
    )
    t.equal(
        g.decrypts(),
        decryptsAtCancel,
        `${label}: no AEAD decryption after the cancel`,
    )
}

async function fixture (label:string) {
    const cs = await getCipherSuite(getCiphersuiteFromName(
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    ))
    const g = gatedSuite(cs, 'epoch_key')
    const crypto = sealCryptoFromCiphersuite(g.cs)
    const keySchedule = {
        applicationExportSecret: new Uint8Array(32).fill(7),
    }
    const oid = new TextEncoder().encode(label)
    const plaintext = new Uint8Array(131089)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256
    const cek = await attachmentCek(keySchedule, oid, g.cs)
    const encrypted = await encryptAttachment(
        cek, oid, plaintext, crypto,
    )
    return { g, crypto, keySchedule, cek, encrypted }
}

test('M5: sequential cancel during epoch_key leaves no key', async t => {
    const { g, crypto, cek, encrypted } = await fixture('m5-seq')
    g.arm()
    const stream = decryptAttachmentStream(
        cek, encrypted.reference, chunked(encrypted.bytes, 1000), crypto,
    )
    const reader = stream.getReader()
    const reading = reader.read().catch(() => undefined)
    await g.reached

    const decryptsAtCancel = g.decrypts()
    const cancelling = reader.cancel().catch(() => undefined)
    g.release()
    await Promise.all([cancelling, reading])
    await flush()

    assertNoLiveEpochKey(t, g, decryptsAtCancel, 'sequential')
})

test('M5: group cancel during epoch_key leaves no key', async t => {
    const { g, keySchedule, encrypted } = await fixture('m5-group')
    g.arm()
    const stream = await decryptAttachmentStreamForGroup(
        keySchedule, encrypted.reference,
        chunked(encrypted.bytes, 1000), g.cs,
    )
    const reader = stream.getReader()
    const reading = reader.read().catch(() => undefined)
    await g.reached

    const decryptsAtCancel = g.decrypts()
    const cancelling = reader.cancel().catch(() => undefined)
    g.release()
    await Promise.all([cancelling, reading])
    await flush()

    assertNoLiveEpochKey(t, g, decryptsAtCancel, 'group')
})

test('M5: range cancel during epoch_key leaves no key', async t => {
    const { g, crypto, cek, encrypted } = await fixture('m5-range')
    const rangeRead = await openAttachmentRange(
        cek, encrypted.reference, { offset: 0, length: 131072 }, crypto,
    )
    const sources = rangeRead.ranges.map(r => chunked(
        encrypted.bytes.slice(r.offset, r.offset + r.length), 1000,
    ))
    g.arm()
    const stream = rangeRead.decrypt(sources)
    await g.reached

    const decryptsAtCancel = g.decrypts()
    const cancelling = stream.cancel().catch(() => undefined)
    g.release()
    await cancelling
    await flush()

    assertNoLiveEpochKey(t, g, decryptsAtCancel, 'range')
})

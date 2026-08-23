/* eslint-disable camelcase -- All snake_case is from the Swift CLI JSON
 * contract; disabling per-request would be too verbose. */
import { execSync, spawnSync } from 'node:child_process'
import type { SealParams } from '../src/attachment/schedule.js'
import {
    startSeal, sealSegment, openSegment,
    PROTOCOL_RO, PROTOCOL_RW, NONCE_DERIVED, NONCE_RANDOM,
    ATTACHMENT_EPOCH_LENGTH, SEGMENT_MAX,
} from '../src/attachment/schedule.js'
import { sealCryptoFromIds } from '../src/attachment/crypto.js'
import { AttachmentError } from '../src/attachment/error.js'
import { toolchainOutcome } from './interop-toolchain.js'

// Hex utilities
function toHex (bytes:Uint8Array):string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function fromHex (hex:string):Uint8Array {
    if (hex.length % 2 !== 0) throw new Error('odd hex length')
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
    }
    return bytes
}

// Build Swift CLI binary once
let swiftBinPath:string|null = null

function getSwiftBinary ():string {
    if (!swiftBinPath) {
        // Actually compile the Swift binary first
        execSync('swift build -c debug --package-path interop/seal-cli',
            { stdio: 'inherit' })
        // Then get the path
        swiftBinPath =
            execSync('swift build -c debug --show-bin-path ' +
                '--package-path interop/seal-cli',
            { encoding: 'utf8' }).trim() + '/seal-cli'
    }
    return swiftBinPath
}

// Build payload_info object
function buildPayloadInfo (
    aeadId:number,
    segmentMax:number,
    kdfId:number,
    snapId:number,
    nonceMode:number,
    epochLength:number,
    salt:Uint8Array
):Record<string, unknown> {
    return {
        aead_id: aeadId,
        segment_max: segmentMax,
        kdf_id: kdfId,
        snap_id: snapId,
        nonce_mode: nonceMode,
        epoch_length: epochLength,
        salt_hex: toHex(salt),
    }
}

// Call Swift CLI
function callSwift (request:Record<string, unknown>):Record<string, string> {
    const cli = getSwiftBinary()
    const input = JSON.stringify(request)
    const result = spawnSync(cli, [], {
        input,
        encoding: 'utf8',
    })
    if (result.error) {
        console.error('spawnSync error:', result.error)
        throw result.error
    }
    // Check for crashes and errors BEFORE attempting to parse JSON
    if (result.status === null) {
        console.error('Swift CLI crashed: process did not start')
        console.error('Swift stderr:', result.stderr)
        throw new Error('Swift CLI crashed')
    }
    if (result.status !== 0 && result.status !== 1) {
        console.error('Swift stderr:', result.stderr)
        throw new Error(
            `Swift CLI failed with exit ${result.status}`)
    }
    // Now parse the JSON response
    try {
        const response = JSON.parse(result.stdout) as Record<string, string>
        return response
    } catch (e) {
        console.error('Failed to parse Swift response:', result.stdout)
        console.error('Swift stderr:', result.stderr)
        throw e
    }
}

async function main () {
    const AEAD_ID = 2 // AES-256-GCM
    const KDF_ID = 1 // HKDF-SHA-256

    // Build crypto
    const crypto = await sealCryptoFromIds(AEAD_ID, KDF_ID)

    // Test each nonce mode
    const modes = [
        {
            name: 'derived',
            nonce_mode: NONCE_DERIVED,
            protocol: PROTOCOL_RO,
            snap_id: 0x0000,
        },
        {
            name: 'random',
            nonce_mode: NONCE_RANDOM,
            protocol: PROTOCOL_RW,
            snap_id: 0x0001,
        },
    ]

    for (const { name, nonce_mode, protocol, snap_id } of modes) {
        console.log(`Testing nonce mode: ${name}`)

        // Random CEK, salt, G
        const cek = globalThis.crypto.getRandomValues(new Uint8Array(32))
        const salt = globalThis.crypto.getRandomValues(new Uint8Array(32))
        const g = new TextEncoder().encode('interop-object')

        // Note: snap_id is 0x0000 for SEAL-RO-v1 (derived) and 0x0001 for
        // SEAL-RW-v1 (random). These are the only snapshot authenticators
        // that swift-raae implements. The interop test does NOT cover
        // snap_id 0x0003 (epoch digest tree), which remains locked by our
        // frozen vectors only.
        const params:SealParams = {
            protocolId: protocol,
            aeadId: AEAD_ID,
            kdfId: KDF_ID,
            segmentMax: SEGMENT_MAX,
            snapId: snap_id,
            nonceMode: nonce_mode,
            epochLength: ATTACHMENT_EPOCH_LENGTH,
            salt,
        }

        // Schedule check
        console.log(`  ${name}: schedule`)
        const tsSchedule = await startSeal(cek, params, g, crypto)
        const swiftResp = callSwift({
            op: 'schedule',
            protocol_id: protocol,
            cek_hex: toHex(cek),
            g_hex: toHex(g),
            payload_info: buildPayloadInfo(
                AEAD_ID, SEGMENT_MAX, KDF_ID, snap_id,
                nonce_mode, ATTACHMENT_EPOCH_LENGTH, salt),
        })

        if (swiftResp.error) {
            console.error(`  FAIL: ${swiftResp.error}`)
            process.exit(1)
        }

        if (toHex(tsSchedule.commitment) !== swiftResp.commitment_hex) {
            console.error('  FAIL: commitment mismatch')
            process.exit(1)
        }

        if (toHex(tsSchedule.payloadKey) !==
            swiftResp.payload_key_hex) {
            console.error('  FAIL: payload_key mismatch')
            process.exit(1)
        }

        if (toHex(tsSchedule.snapKey) !== swiftResp.acc_key_hex) {
            console.error('  FAIL: acc_key mismatch')
            process.exit(1)
        }

        if (nonce_mode === NONCE_DERIVED) {
            if (toHex(tsSchedule.nonceBase as Uint8Array) !==
                swiftResp.nonce_base_hex) {
                console.error('  FAIL: nonce_base mismatch')
                process.exit(1)
            }
        }

        // TS seal, Swift open
        console.log(`  ${name}: TS seal -> Swift open`)
        const pt1 = Buffer.from('Hello, World!')
        const nonce1 = globalThis.crypto.getRandomValues(
            new Uint8Array(12))
        const sealed1 = await sealSegment(tsSchedule, {
            index: 0n,
            isFinal: false,
            plaintext: new Uint8Array(pt1),
            nonce: nonce_mode === NONCE_RANDOM ? nonce1 : undefined,
        })

        const openResp1 = callSwift({
            op: 'open_segment',
            protocol_id: protocol,
            cek_hex: toHex(cek),
            g_hex: toHex(g),
            payload_info: buildPayloadInfo(
                AEAD_ID, SEGMENT_MAX, KDF_ID, snap_id,
                nonce_mode, ATTACHMENT_EPOCH_LENGTH, salt),
            index: 0,
            is_final: 0,
            ct_hex: toHex(sealed1.ciphertext),
            tag_hex: toHex(sealed1.tag),
            nonce_hex: toHex(sealed1.nonce),
        })

        if (openResp1.error) {
            console.error(`  FAIL: ${openResp1.error}`)
            process.exit(1)
        }

        if (openResp1.plaintext_hex !== toHex(new Uint8Array(pt1))) {
            console.error('  FAIL: plaintext mismatch')
            process.exit(1)
        }

        // Swift seal, TS open
        console.log(`  ${name}: Swift seal -> TS open`)
        const pt2 = Buffer.from('Swift test')
        const sealResp2 = callSwift({
            op: 'seal_segment',
            protocol_id: protocol,
            cek_hex: toHex(cek),
            g_hex: toHex(g),
            payload_info: buildPayloadInfo(
                AEAD_ID, SEGMENT_MAX, KDF_ID, snap_id,
                nonce_mode, ATTACHMENT_EPOCH_LENGTH, salt),
            index: 1,
            is_final: 0,
            plaintext_hex: toHex(new Uint8Array(pt2)),
            nonce_hex: nonce_mode === NONCE_RANDOM ?
                toHex(globalThis.crypto.getRandomValues(
                    new Uint8Array(12))) : '',
        })

        if (sealResp2.error) {
            console.error(`  FAIL: ${sealResp2.error}`)
            process.exit(1)
        }

        try {
            const ts2 = await openSegment(tsSchedule, {
                index: 1n,
                isFinal: false,
                ciphertext: fromHex(sealResp2.ct_hex),
                tag: fromHex(sealResp2.tag_hex),
                nonce: fromHex(sealResp2.nonce_hex),
            })

            if (toHex(ts2) !== toHex(new Uint8Array(pt2))) {
                console.error('  FAIL: plaintext mismatch after Swift seal')
                process.exit(1)
            }
        } catch (e) {
            console.error(`  FAIL: ${name} mode Swift->TS open failed`)
            console.error(`    Error: ${(e as Error).message}`)
            console.error(`    Nonce hex: ${sealResp2.nonce_hex}`)
            console.error(`    CT hex: ${sealResp2.ct_hex.slice(0, 32)}...`)
            console.error(`    Tag hex: ${sealResp2.tag_hex}`)
            process.exit(1)
        }

        // TS seal segment 3 at the first index of epoch 1. An epoch is
        // 2^ATTACHMENT_EPOCH_LENGTH = 1024 segments, so index 1024 is the
        // first that rotates the epoch key; index 10 is still epoch 0.
        console.log(`  ${name}: TS seal -> Swift open (epoch crossing)`)
        const pt3 = Buffer.from('Final!')
        const nonce3 = globalThis.crypto.getRandomValues(
            new Uint8Array(12))
        const sealed3 = await sealSegment(tsSchedule, {
            index: 1024n,
            isFinal: true,
            plaintext: new Uint8Array(pt3),
            nonce: nonce_mode === NONCE_RANDOM ? nonce3 : undefined,
        })

        const openResp3 = callSwift({
            op: 'open_segment',
            protocol_id: protocol,
            cek_hex: toHex(cek),
            g_hex: toHex(g),
            payload_info: buildPayloadInfo(
                AEAD_ID, SEGMENT_MAX, KDF_ID, snap_id,
                nonce_mode, ATTACHMENT_EPOCH_LENGTH, salt),
            index: 1024,
            is_final: 1,
            ct_hex: toHex(sealed3.ciphertext),
            tag_hex: toHex(sealed3.tag),
            nonce_hex: toHex(sealed3.nonce),
        })

        if (openResp3.error) {
            console.error(`  FAIL: ${openResp3.error}`)
            process.exit(1)
        }

        if (openResp3.plaintext_hex !== toHex(new Uint8Array(pt3))) {
            console.error('  FAIL: plaintext mismatch (segment 3)')
            process.exit(1)
        }

        // Swift seal segment 3 at index 11, is_final: 1
        console.log(`  ${name}: Swift seal -> TS open (is_final)`)
        const pt4 = Buffer.from('Last')
        const sealResp4 = callSwift({
            op: 'seal_segment',
            protocol_id: protocol,
            cek_hex: toHex(cek),
            g_hex: toHex(g),
            payload_info: buildPayloadInfo(
                AEAD_ID, SEGMENT_MAX, KDF_ID, snap_id,
                nonce_mode, ATTACHMENT_EPOCH_LENGTH, salt),
            index: 1025,
            is_final: 1,
            plaintext_hex: toHex(new Uint8Array(pt4)),
            nonce_hex: nonce_mode === NONCE_RANDOM ?
                toHex(globalThis.crypto.getRandomValues(
                    new Uint8Array(12))) : '',
        })

        if (sealResp4.error) {
            console.error(`  FAIL: ${sealResp4.error}`)
            process.exit(1)
        }

        try {
            const ts4 = await openSegment(tsSchedule, {
                index: 1025n,
                isFinal: true,
                ciphertext: fromHex(sealResp4.ct_hex),
                tag: fromHex(sealResp4.tag_hex),
                nonce: fromHex(sealResp4.nonce_hex),
            })

            if (toHex(ts4) !== toHex(new Uint8Array(pt4))) {
                console.error('  FAIL: plaintext mismatch after Swift seal ' +
                    '(segment 4)')
                process.exit(1)
            }
        } catch (e) {
            console.error(`  FAIL: ${name} mode Swift->TS open ` +
                '(segment 4) failed')
            console.error(`    Error: ${(e as Error).message}`)
            process.exit(1)
        }

        // Tamper test
        console.log(`  ${name}: tamper detection`)
        const tamperedCt = sealed1.ciphertext.slice()
        tamperedCt[0] ^= 0xFF

        const tamperResp = callSwift({
            op: 'open_segment',
            protocol_id: protocol,
            cek_hex: toHex(cek),
            g_hex: toHex(g),
            payload_info: buildPayloadInfo(
                AEAD_ID, SEGMENT_MAX, KDF_ID, snap_id,
                nonce_mode, ATTACHMENT_EPOCH_LENGTH, salt),
            index: 0,
            is_final: 0,
            ct_hex: toHex(tamperedCt),
            tag_hex: toHex(sealed1.tag),
            nonce_hex: toHex(sealed1.nonce),
        })

        if (!tamperResp.error) {
            console.error('  FAIL: Swift should reject tamper')
            process.exit(1)
        }

        try {
            await openSegment(tsSchedule, {
                index: 0n,
                isFinal: false,
                ciphertext: tamperedCt,
                tag: sealed1.tag,
                nonce: sealed1.nonce,
            })
            console.error('  FAIL: TS should reject tamper')
            process.exit(1)
        } catch (e) {
            // Pin the type. A bare catch here passed the tamper case on
            // any throw at all, including a TypeError from a mistyped
            // openSegment argument, which would have reported "TS
            // rejects tamper" while proving nothing about the AEAD tag.
            if (!(e instanceof AttachmentError)) {
                console.error(
                    '  FAIL: TS rejected tamper with the wrong error: ' +
                    String(e))
                process.exit(1)
            }
        }

        // Range-read test: NOT IMPLEMENTED
        // Task 3 step 6 needs segments sealed under SEAL-RO-v1 with
        // snap_id 0x0003. swift-raae does not implement snap_id 0x0003:
        // Suites.swift:isKnownSnapID admits 0x0000 and 0x0001 only, and
        // Sources/RAAE/ contains no epoch-tree code. The rejection fires at
        // KeySchedule.swift:135-137 as ScheduleError.unsupportedSnapID,
        // before the profile-tuple guard at :152-158 is reached.
        // Consequently swift-raae expresses no opinion on our
        // SEAL-RO-v1 + 0x0003 pairing. Per Spec/NOTES.md:139-145,
        // draft-02 defines SEAL-attachment as a named instantiation over
        // SEAL-RO-v1 with exactly that snap_id, so the pairing is the
        // conformant one and the gap is an upstream implementation gap.
        // Note the vendored spec HTML still pins SEAL-RO-v1 to snap_id
        // 0x0000 and reads as forbidding our tuple. That snapshot
        // predates the -02 generalisation; Spec/SOURCE.md:15-18 marks
        // it non-authoritative at exactly this point. Check NOTES.md,
        // not the HTML, before concluding this comment is wrong.
        console.log(`  ${name}: range read`)
        console.log('    range read: skip (swift-raae ' +
            'rejects SEAL-RO-v1 + snap_id 0x0003)')

        console.log(`  ${name}: PASS`)
    }

    // Negative test: assert swift-raae rejects snap_id 0x0003 for the
    // specific reason (unsupportedSnapID), not some other reason like
    // profile-tuple mismatch. This pins the upstream gap: when swift-raae
    // starts implementing snap_id 0x0003, this test will fail and alert
    // us that real round-trip coverage for the epoch digest tree is now
    // possible.
    console.log('Testing snap_id 0x0003 rejection:')
    const snapId0x0003Salt = globalThis.crypto.getRandomValues(
        new Uint8Array(32))
    const snapId0x0003G = new TextEncoder().encode(
        'interop-0x0003-rejection')
    const snapId0x0003Cek = globalThis.crypto.getRandomValues(
        new Uint8Array(32))
    const rejectResp = callSwift({
        op: 'schedule',
        protocol_id: PROTOCOL_RO,
        cek_hex: toHex(snapId0x0003Cek),
        g_hex: toHex(snapId0x0003G),
        payload_info: buildPayloadInfo(
            AEAD_ID, SEGMENT_MAX, KDF_ID, 0x0003,
            NONCE_DERIVED, ATTACHMENT_EPOCH_LENGTH,
            snapId0x0003Salt),
    })

    if (!rejectResp.error) {
        console.error('  FAIL: snap_id 0x0003 should be rejected. ' +
            'If swift-raae now accepts it, upstream implemented the ' +
            'epoch digest tree: add real round-trip coverage and ' +
            'retire this negative case.')
        process.exit(1)
    }

    // One binding, used by the predicate, the failure message and the
    // success line. Duplicating it meant a changed predicate still
    // printed the old name in the failure text.
    const expectedReason = 'unsupportedSnapID'

    if (!rejectResp.error.includes(expectedReason)) {
        console.error(
            `  FAIL: error should mention ${expectedReason}, got: ` +
            rejectResp.error + '. A different rejection reason means ' +
            'upstream capability changed; check whether the epoch ' +
            'digest tree is now implemented and real round-trip ' +
            'coverage should replace this case.')
        process.exit(1)
    }

    console.log(`  snap_id 0x0003: rejected as ${expectedReason} ` +
        '(upstream impl gap: epoch digest tree not yet supported)')

    console.log('All interop tests passed!')
}

/**
 * Only a failed lookup means the toolchain is absent. Any other error
 * here is a bug in this script, and reporting it as SKIP would turn a
 * broken harness into a green run, which is precisely the false
 * negative toolchainOutcome exists to avoid.
 */
function swiftAvailable ():boolean {
    try {
        execSync('command -v swift', { stdio: 'ignore' })
        return true
    } catch (err) {
        if (err instanceof Error && 'status' in err) return false
        throw err
    }
}

const outcome = toolchainOutcome(swiftAvailable(), process.env.CI)
if (outcome.action !== 'run') {
    if (outcome.action === 'fail') console.error(outcome.message)
    else console.log(outcome.message)
    process.exit(outcome.exitCode)
}

main().catch(err => {
    console.error('ERROR:', err.message)
    process.exit(1)
})

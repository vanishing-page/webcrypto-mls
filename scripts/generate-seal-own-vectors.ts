// Generate SEAL epoch-tree and CEK own vectors for regression testing
import { sealObject } from '../src/attachment/object.js'
import { sealCryptoFromIds } from '../src/attachment/crypto.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { initializeKeySchedule } from '../src/key-schedule.js'
import {
    safeExportSecret,
    attachmentCek,
    ATTACHMENT_COMPONENT_ID,
} from '../src/attachment/keys.js'
import {
    makeKdf,
    makeKdfImpl,
} from '../src/crypto/implementation/default/make-kdf-impl.js'

interface Vector {
    name:string
    description:string
    configuration:string
    cek_hex:string
    salt_hex:string
    object_id_hex:string
    plaintext_length:number
    commitment_hex:string
    snapshot_hex:string
    first_64_bytes_hex:string
    object_sha256_hex:string
}

interface KeysVector {
    epoch_secret_hex:string
    application_export_secret_hex:string
    component_id:number
    object_id_hex:string
    component_secret_hex:string
    cek_hex:string
}

function toHex (bytes:Uint8Array):string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

async function generateVectors ():Promise<void> {
    const outputDir = process.argv[2] ?? 'test_vectors/seal/own'

    // Fixed inputs for SEAL vectors
    const cek = new Uint8Array(32).fill(0xAA)
    const salt = new Uint8Array(32).fill(0x04)
    const objectId = new TextEncoder().encode('own-vector')
    const plaintextLength = 65536 + 100

    // Counter bytes
    const plaintext = new Uint8Array(plaintextLength)
    for (let i = 0; i < plaintextLength; i++) {
        plaintext[i] = i % 256
    }

    // Get crypto (AES-256-GCM + HKDF-SHA-256)
    const crypto = await sealCryptoFromIds(2, 1)

    // Seal
    const sealed = await sealObject(cek, objectId, plaintext, crypto, { salt })

    // Compute SHA-256 of full object
    const hash = await crypto.hash.digest(sealed.bytes)

    // Build SEAL vector
    const vector:Vector = {
        name: 'epoch-tree-own-vector',
        description: 'SEAL-RO-v1 epoch digest tree with 65636-byte plaintext',
        configuration: 'AES-256-GCM, HKDF-SHA-256, ' +
            'derived nonces, epoch_length 10, snap_id 0x0003',
        cek_hex: toHex(cek),
        salt_hex: toHex(salt),
        object_id_hex: toHex(objectId),
        plaintext_length: plaintextLength,
        commitment_hex: toHex(sealed.bytes.slice(32, 64)),
        snapshot_hex: toHex(sealed.snapshot),
        first_64_bytes_hex: toHex(sealed.bytes.slice(0, 64)),
        object_sha256_hex: toHex(hash),
    }

    // Fixed inputs for CEK vectors
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)

    const componentId = ATTACHMENT_COMPONENT_ID
    const cekObjectId = new TextEncoder().encode('own-vector')

    // Derive component secret and CEK
    const componentSecret = await safeExportSecret(
        keySchedule.applicationExportSecret,
        componentId,
        kdf,
    )

    const derivedCek = await attachmentCek(
        keySchedule,
        cekObjectId,
        { kdf },
    )

    // Build CEK vector
    const keysVector:KeysVector = {
        epoch_secret_hex: toHex(epochSecret),
        application_export_secret_hex:
            toHex(keySchedule.applicationExportSecret),
        component_id: componentId,
        object_id_hex: toHex(cekObjectId),
        component_secret_hex: toHex(componentSecret),
        cek_hex: toHex(derivedCek),
    }

    // Write vectors directory
    mkdirSync(outputDir, { recursive: true })

    // Write epoch-tree.json
    writeFileSync(
        `${outputDir}/epoch-tree.json`,
        JSON.stringify(vector, null, 2) + '\n',
    )

    console.log(`Generated ${outputDir}/epoch-tree.json`)

    // Write keys.json
    writeFileSync(
        `${outputDir}/keys.json`,
        JSON.stringify(keysVector, null, 2) + '\n',
    )

    console.log(`Generated ${outputDir}/keys.json`)
}

generateVectors().catch(err => {
    console.error(err)
    process.exit(1)
})

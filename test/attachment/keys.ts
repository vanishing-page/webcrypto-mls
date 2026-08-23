import { test } from '@substrate-system/tapzero'
import {
    initializeKeySchedule,
} from '../../src/key-schedule.js'
import {
    attachmentCek,
    safeExportSecret,
} from '../../src/attachment/keys.js'
import { AttachmentError } from '../../src/attachment/error.js'
import {
    fromHex,
    toHex,
} from './helpers.js'
import {
    makeKdf,
    makeKdfImpl,
} from '../../src/crypto/implementation/default/make-kdf-impl.js'

import keysVector from '../../test_vectors/seal/own/keys.json'

// AC3.1: Determinism
test('AC3.1: same (epochSecret, objectId) twice gives same CEK bytes',
    async t => {
        const epochSecret = new Uint8Array(32).fill(0x42)
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const objectId = new TextEncoder().encode('test-id')

        const keySchedule1 = await initializeKeySchedule(
            epochSecret.slice(), kdf)
        const cek1 = await attachmentCek(
            keySchedule1,
            objectId,
            { kdf },
        )

        const keySchedule2 = await initializeKeySchedule(
            epochSecret.slice(), kdf)
        const cek2 = await attachmentCek(
            keySchedule2,
            objectId,
            { kdf },
        )

        t.equal(
            toHex(cek1),
            toHex(cek2),
            'CEK deterministic for same inputs',
        )
    },
)

// AC3.1: Separation - different objectId
test('AC3.1: different objectId gives different CEK',
    async t => {
        const epochSecret = new Uint8Array(32).fill(0x42)
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const keySchedule = await initializeKeySchedule(
            epochSecret.slice(), kdf)

        const objectId1 = new TextEncoder().encode('object-1')
        const objectId2 = new TextEncoder().encode('object-2')

        const cek1 = await attachmentCek(
            keySchedule,
            objectId1,
            { kdf },
        )
        const cek2 = await attachmentCek(
            keySchedule,
            objectId2,
            { kdf },
        )

        t.notEqual(
            toHex(cek1),
            toHex(cek2),
            'CEK differs for different objectIds',
        )
    },
)

// AC3.1: Separation - different epochSecret
test('AC3.1: different epochSecret gives different CEK',
    async t => {
        const objectId = new TextEncoder().encode('test-id')
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))

        const epochSecret1 = new Uint8Array(32).fill(0x42)
        const keySchedule1 = await initializeKeySchedule(
            epochSecret1.slice(), kdf)
        const cek1 = await attachmentCek(
            keySchedule1,
            objectId,
            { kdf },
        )

        const epochSecret2 = new Uint8Array(32).fill(0x43)
        const keySchedule2 = await initializeKeySchedule(
            epochSecret2.slice(), kdf)
        const cek2 = await attachmentCek(
            keySchedule2,
            objectId,
            { kdf },
        )

        t.notEqual(
            toHex(cek1),
            toHex(cek2),
            'CEK differs for different epochSecrets',
        )
    },
)

// AC3.1: Separation - different componentId
test('AC3.1: different componentId gives different CEK',
    async t => {
        const epochSecret = new Uint8Array(32).fill(0x42)
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const keySchedule = await initializeKeySchedule(
            epochSecret.slice(), kdf)
        const objectId = new TextEncoder().encode('test-id')

        const cek1 = await attachmentCek(
            keySchedule,
            objectId,
            { kdf },
            { componentId: 0xF001 },
        )
        const cek2 = await attachmentCek(
            keySchedule,
            objectId,
            { kdf },
            { componentId: 0xF002 },
        )

        t.notEqual(
            toHex(cek1),
            toHex(cek2),
            'CEK differs for different componentIds',
        )
    },
)

// AC3.1: Frozen vectors
test('AC3.1: frozen vector CEK matches', async t => {
    const epochSecret = fromHex(keysVector.epoch_secret_hex)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret, kdf)

    const objectId = fromHex(keysVector.object_id_hex)
    const derivedCek = await attachmentCek(
        keySchedule,
        objectId,
        { kdf },
    )

    t.equal(
        toHex(derivedCek),
        keysVector.cek_hex,
        'CEK matches frozen vector',
    )
})

// AC3.1: Frozen vector - applicationExportSecret
test('AC3.1: frozen vector application_export_secret matches', async t => {
    const epochSecret = fromHex(keysVector.epoch_secret_hex)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret, kdf)

    t.equal(
        toHex(keySchedule.applicationExportSecret),
        keysVector.application_export_secret_hex,
        'applicationExportSecret matches frozen vector',
    )
})

// AC3.1: Frozen vector - componentSecret
test('AC3.1: frozen vector component_secret matches', async t => {
    const epochSecret = fromHex(keysVector.epoch_secret_hex)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret, kdf)

    const componentSecret = await safeExportSecret(
        keySchedule.applicationExportSecret,
        keysVector.component_id,
        kdf,
    )

    t.equal(
        toHex(componentSecret),
        keysVector.component_secret_hex,
        'componentSecret matches frozen vector',
    )
})

// AC3.2: objectId length 0 rejects
test('AC3.2: objectId length 0 rejects with AttachmentError', async t => {
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)
    const emptyObjectId = new Uint8Array(0)

    try {
        await attachmentCek(
            keySchedule,
            emptyObjectId,
            { kdf },
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects with AttachmentError for empty objectId',
        )
    }
})

// AC3.2: objectId length 256 rejects
test('AC3.2: objectId length 256 rejects with AttachmentError', async t => {
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)
    const longObjectId = new Uint8Array(256).fill(0xFF)

    try {
        await attachmentCek(
            keySchedule,
            longObjectId,
            { kdf },
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects with AttachmentError for too-long objectId',
        )
    }
})

// Missing applicationExportSecret
test('AC3.1: missing applicationExportSecret rejects', async t => {
    const objectId = new TextEncoder().encode('test-id')
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))

    // Simulate old persisted state without applicationExportSecret.
    // The cast is deliberate here: we're testing that the function
    // correctly rejects undefined, so we must be able to construct
    // a partial state that the type system wouldn't allow in normal
    // operation.
    const incompleteKeySchedule = {
        applicationExportSecret: undefined as unknown as Uint8Array,
    }

    try {
        await attachmentCek(
            incompleteKeySchedule,
            objectId,
            { kdf },
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'rejects with AttachmentError when ' +
            'applicationExportSecret is missing',
        )
    }
})

// Structural assertion: tree walk performs exactly 16 derivations
test(
    'structural: exporter tree walk 16 levels for componentId derivation',
    async t => {
        const epochSecret = new Uint8Array(32).fill(0x42)
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const keySchedule = await initializeKeySchedule(
            epochSecret.slice(), kdf)

        let derivationCount = 0

        // Wrap kdf.expand to count calls
        const originalExpand = kdf.expand.bind(kdf)
        const wrappedKdf = {
            ...kdf,
            expand: async (
                secret:Uint8Array,
                info:Uint8Array,
                length:number,
            ):Promise<Uint8Array> => {
                derivationCount++
                return originalExpand(secret, info, length)
            },
        }

        await safeExportSecret(
            keySchedule.applicationExportSecret,
            0xF001,
            wrappedKdf,
        )

        t.equal(
            derivationCount, 16,
            'exporter tree walk performs 16 derivations')
    },
)

// Structural: different componentIds produce different secrets
test(
    'structural: componentId 0x0000 and 0x0001 ' +
    'produce different component secrets',
    async t => {
        const epochSecret = new Uint8Array(32).fill(0x42)
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const keySchedule = await initializeKeySchedule(
            epochSecret.slice(), kdf)

        const secret0 = await safeExportSecret(
            keySchedule.applicationExportSecret,
            0x0000,
            kdf,
        )
        const secret1 = await safeExportSecret(
            keySchedule.applicationExportSecret,
            0x0001,
            kdf,
        )

        t.notEqual(
            toHex(secret0),
            toHex(secret1),
            'componentId 0x0000 and 0x0001 ' +
            'produce different secrets',
        )
    },
)

// Structural: boundary componentIds produce different secrets from 0xF001
test(
    'structural: boundary componentIds (0x0000, 0xFFFF) ' +
    'differ from 0xF001',
    async t => {
        const epochSecret = new Uint8Array(32).fill(0x42)
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
        const keySchedule = await initializeKeySchedule(
            epochSecret.slice(), kdf)

        const secret0000 = await safeExportSecret(
            keySchedule.applicationExportSecret,
            0x0000,
            kdf,
        )
        const secretF001 = await safeExportSecret(
            keySchedule.applicationExportSecret,
            0xF001,
            kdf,
        )
        const secretFFFF = await safeExportSecret(
            keySchedule.applicationExportSecret,
            0xFFFF,
            kdf,
        )

        t.notEqual(
            toHex(secret0000),
            toHex(secretF001),
            'componentId 0x0000 differs from 0xF001',
        )
        t.notEqual(
            toHex(secretFFFF),
            toHex(secretF001),
            'componentId 0xFFFF differs from 0xF001',
        )
    },
)

// Structural: ComponentOperationLabel encoding
test(
    'structural: componentOperationLabel produces expected TLS encoding',
    async t => {
        const { componentOperationLabel } = await import(
            '../../src/attachment/keys.js'
        )

        const result = componentOperationLabel(0xF001, 'attachment')

        // Build expected result by hand
        const encoder = new TextEncoder()
        const baseLabelBytes = encoder.encode('MLS Component')
        const labelBytes = encoder.encode('attachment')

        // Expected structure:
        // 1 byte length of baseLabelBytes (14)
        // 14 bytes of baseLabelBytes
        // 2 bytes componentId (0xF0 0x01)
        // 1 byte length of labelBytes (10)
        // 10 bytes of labelBytes
        const expected = new Uint8Array([
            baseLabelBytes.length,
            ...baseLabelBytes,
            0xF0, 0x01,
            labelBytes.length,
            ...labelBytes,
        ])

        t.equal(
            toHex(result),
            toHex(expected),
            'componentOperationLabel encodes expected TLS bytes',
        )
    },
)

// MINOR 3: componentOperationLabel guard has no test coverage
test('MINOR 3: componentOperationLabel(NaN) throws AttachmentError',
    async t => {
        const { componentOperationLabel } = await import(
            '../../src/attachment/keys.js'
        )

        try {
            componentOperationLabel(NaN, 'attachment')
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'NaN componentId throws AttachmentError ' +
                '(not CodecError)',
            )
        }
    },
)

// CRITICAL 1: safeExportSecret integer validation
test('CRITICAL 1: safeExportSecret rejects NaN', async t => {
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)

    try {
        await safeExportSecret(
            keySchedule.applicationExportSecret,
            NaN,
            kdf,
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            'NaN componentId throws AttachmentError',
        )
    }
})

test('CRITICAL 1: safeExportSecret rejects non-integer 1.5', async t => {
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)

    try {
        await safeExportSecret(
            keySchedule.applicationExportSecret,
            1.5,
            kdf,
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            '1.5 componentId throws AttachmentError',
        )
    }
})

test('CRITICAL 1: safeExportSecret rejects negative -1', async t => {
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)

    try {
        await safeExportSecret(
            keySchedule.applicationExportSecret,
            -1,
            kdf,
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            '-1 componentId throws AttachmentError',
        )
    }
})

test('CRITICAL 1: safeExportSecret rejects out-of-range 0x10000', async t => {
    const epochSecret = new Uint8Array(32).fill(0x42)
    const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))
    const keySchedule = await initializeKeySchedule(epochSecret.slice(), kdf)

    try {
        await safeExportSecret(
            keySchedule.applicationExportSecret,
            0x10000,
            kdf,
        )
        t.ok(false, 'should throw AttachmentError')
    } catch (err) {
        t.ok(
            err instanceof AttachmentError,
            '0x10000 componentId throws AttachmentError',
        )
    }
})

// CRITICAL 2: applicationExportSecret validation
test(
    'CRITICAL 2: attachmentCek rejects empty Uint8Array',
    async t => {
        const objectId = new TextEncoder().encode('test-id')
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))

        const invalidKeySchedule = {
            applicationExportSecret: new Uint8Array(0),
        }

        try {
            await attachmentCek(
                invalidKeySchedule,
                objectId,
                { kdf },
            )
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'empty Uint8Array throws AttachmentError',
            )
        }
    },
)

test(
    'CRITICAL 2: attachmentCek rejects plain object {}',
    async t => {
        const objectId = new TextEncoder().encode('test-id')
        const kdf = makeKdfImpl(makeKdf('HKDF-SHA256'))

        // Simulate JSON-deserialized state: plain object without
        // the Uint8Array type constraint
        const invalidKeySchedule = {
            applicationExportSecret: {} as unknown as Uint8Array,
        }

        try {
            await attachmentCek(
                invalidKeySchedule,
                objectId,
                { kdf },
            )
            t.ok(false, 'should throw AttachmentError')
        } catch (err) {
            t.ok(
                err instanceof AttachmentError,
                'plain object {} throws AttachmentError',
            )
        }
    },
)

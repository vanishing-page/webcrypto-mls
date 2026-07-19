import { test } from '@substrate-system/tapzero'
import type { Extension } from '../src/extension.js'
import { extensionsEqual } from '../src/extension.js'

test('extensionsEqual - identical extensions', (t) => {
    const ext1:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 3]),
    }
    const ext2:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 3]),
    }

    t.equal(
        extensionsEqual([ext1], [ext2]),
        true,
        'should return true for identical extensions'
    )
})

test('extensionsEqual - different extension types', (t) => {
    const ext1:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 3]),
    }
    const ext2:Extension = {
        extensionType: 'ratchet_tree',
        extensionData: new Uint8Array([1, 2, 3]),
    }

    t.equal(
        extensionsEqual([ext1], [ext2]),
        false,
        'should return false for different extension types'
    )
})

test('extensionsEqual - different extension data', (t) => {
    const ext1:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 3]),
    }
    const ext2:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 4]),
    }

    t.equal(
        extensionsEqual([ext1], [ext2]),
        false,
        'should return false for different extension data'
    )
})

test('extensionsEqual - different array lengths', (t) => {
    const ext1:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 3]),
    }
    const ext2:Extension = {
        extensionType: 'application_id',
        extensionData: new Uint8Array([1, 2, 3]),
    }

    t.equal(
        extensionsEqual([ext1], [ext1, ext2]),
        false,
        'should return false for different array lengths'
    )
})

test('extensionsEqual - empty arrays', (t) => {
    t.equal(
        extensionsEqual([], []),
        true,
        'should return true for empty arrays'
    )
})

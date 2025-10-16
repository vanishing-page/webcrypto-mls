import { test } from '@substrate-system/tapzero'
import type { RequiredCapabilities } from '../../src/requiredCapabilities.js'
import {
    encodeRequiredCapabilities,
    decodeRequiredCapabilities
} from '../../src/requiredCapabilities.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeRequiredCapabilities, decodeRequiredCapabilities)

test('RequiredCapabilities roundtrip empty arrays', (t) => {
    const rc: RequiredCapabilities = {
        extensionTypes: [],
        proposalTypes: [],
        credentialTypes: [],
    }
    roundtrip(t, rc, 'should roundtrip empty arrays')
})

test('RequiredCapabilities roundtrip non-empty arrays', (t) => {
    const rc: RequiredCapabilities = {
        extensionTypes: [7, 8],
        proposalTypes: [9, 10, 11],
        credentialTypes: ['basic', 'x509'],
    }
    roundtrip(t, rc, 'should roundtrip non-empty arrays')
})

test('RequiredCapabilities roundtrip single-element arrays', (t) => {
    const rc: RequiredCapabilities = {
        extensionTypes: [8],
        proposalTypes: [9],
        credentialTypes: ['basic'],
    }
    roundtrip(t, rc, 'should roundtrip single-element arrays')
})

import { test } from '@substrate-system/tapzero'
import { createCustomCredential } from '../src/custom-credential.js'

test('createCustomCredential rejects the reserved "basic" credential type id', (t) => {
    t.throws(
        () => createCustomCredential(1, new Uint8Array([1, 2])),
        'should reject credential type id 1 (basic)',
    )
})

test('createCustomCredential rejects the reserved "x509" credential type id', (t) => {
    t.throws(
        () => createCustomCredential(2, new Uint8Array([1, 2])),
        'should reject credential type id 2 (x509)',
    )
})

test('createCustomCredential accepts a non-reserved credential type id', (t) => {
    const credential = createCustomCredential(5, new Uint8Array([1, 2]))
    t.equal(credential.credentialType, '5', 'should create a custom credential')
})

import { test } from '@substrate-system/tapzero'
import { makeHashImpl } from '../../src/crypto/implementation/noble/make-hash-impl.js'
import { randomBytes } from '@noble/hashes/utils.js'

const key = randomBytes(32)
const data = new TextEncoder().encode('Hello world!')

test('Noble hash implementation - verifyMac accepts a matching tag', async (t) => {
    const hash = makeHashImpl('SHA-256')
    const mac = await hash.mac(key, data)
    t.equal(await hash.verifyMac(key, mac, data), true,
        'should verify a correctly computed mac')
})

test(
    'Noble hash implementation - verifyMac rejects a tag differing in the ' +
        'first byte',
    async (t) => {
        const hash = makeHashImpl('SHA-256')
        const mac = await hash.mac(key, data)
        const tampered = new Uint8Array(mac)
        tampered[0] = tampered[0]! ^ 0xff
        t.equal(await hash.verifyMac(key, tampered, data), false,
            'should reject a tag tampered at the first byte')
    }
)

test(
    'Noble hash implementation - verifyMac rejects a tag differing in the ' +
        'last byte',
    async (t) => {
        const hash = makeHashImpl('SHA-256')
        const mac = await hash.mac(key, data)
        const tampered = new Uint8Array(mac)
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
        t.equal(await hash.verifyMac(key, tampered, data), false,
            'should reject a tag tampered at the last byte')
    }
)

test(
    'Noble hash implementation - verifyMac rejects a tag of a different ' +
        'length',
    async (t) => {
        const hash = makeHashImpl('SHA-256')
        const mac = await hash.mac(key, data)
        const shorter = mac.slice(0, mac.length - 1)
        t.equal(await hash.verifyMac(key, shorter, data), false,
            'should reject a tag with a mismatched length')
    }
)

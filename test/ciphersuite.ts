import { test } from '@substrate-system/tapzero'
import { ciphersuites, getCiphersuiteFromName } from '../src/crypto/ciphersuite.js'

const STANDARD_IDS = {
    MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519: 1,
    MLS_128_DHKEMP256_AES128GCM_SHA256_P256: 2,
    MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519: 3,
    MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448: 4,
    MLS_256_DHKEMP521_AES256GCM_SHA512_P521: 5,
    MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448: 6,
    MLS_256_DHKEMP384_AES256GCM_SHA384_P384: 7,
}

test('standard ciphersuite IDs (0x0001-0x0007) are unchanged', (t) => {
    for (const [name, id] of Object.entries(STANDARD_IDS)) {
        t.equal(
            ciphersuites[name as keyof typeof ciphersuites],
            id,
            `${name} should keep its standard IANA ID`
        )
    }
})

test('experimental PQ ciphersuite IDs live in the private-use range', (t) => {
    const standardNames = new Set(Object.keys(STANDARD_IDS))
    for (const [name, id] of Object.entries(ciphersuites)) {
        if (standardNames.has(name)) continue
        t.ok(
            id >= 0xF000 && id <= 0xFFFF,
            `${name} (id ${id}) should be in the private-use range ` +
                '0xF000-0xFFFF'
        )
    }
})

test('PQ ciphersuite name/AEAD/hash/kdf are internally consistent', (t) => {
    const standardNames = new Set(Object.keys(STANDARD_IDS))
    for (const name of Object.keys(ciphersuites)) {
        if (standardNames.has(name)) continue

        const suite = getCiphersuiteFromName(
            name as keyof typeof ciphersuites
        )

        const expectAead = name.includes('CHACHA20POLY1305') ?
            'CHACHA20POLY1305' :
            (name.includes('AES128GCM') ? 'AES128GCM' : 'AES256GCM')
        t.equal(
            suite.hpke.aead,
            expectAead,
            `${name} aead should match its name`
        )

        // hash and kdf must agree on the digest they both name
        const normalize = (s:string) => s.replace(/[^0-9]/g, '')
        t.equal(
            normalize(suite.hash),
            normalize(suite.hpke.kdf),
            `${name} hash (${suite.hash}) should match kdf hash ` +
                `(${suite.hpke.kdf})`
        )
    }
})

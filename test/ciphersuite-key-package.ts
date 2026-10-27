import { test } from '@substrate-system/tapzero'
import { skipReason } from './helpers/skip.js'
import { getCiphersuiteFromName } from '../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../src/crypto/get-ciphersuite-impl.js'
import { encodeKeyPackage, generateKeyPackage } from '../src/key-package.js'
import { defaultLifetime } from '../src/lifetime.js'
import { defaultCapabilities } from '../src/default-capabilities.js'
import { testCiphersuites } from './helpers/suite-filter.js'
import { CODE_POINTS } from './helpers/ciphersuite-code-points.js'

for (const name of testCiphersuites()) {
    test(`a KeyPackage carries the pinned code point (${name})`, async (t) => {
        try {
            const impl = await getCipherSuite(getCiphersuiteFromName(name))
            const { publicPackage } = await generateKeyPackage(
                {
                    credentialType: 'basic',
                    identity: new TextEncoder().encode('alice')
                },
                defaultCapabilities(),
                defaultLifetime(),
                [],
                impl
            )
            const bytes = encodeKeyPackage(publicPackage)
            // KeyPackage: version (uint16), then cipher_suite (uint16)
            const wire = (bytes[2]! << 8) | bytes[3]!
            t.equal(
                wire,
                CODE_POINTS[name],
                `cipher_suite should be 0x${CODE_POINTS[name].toString(16)}`
            )
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError' ||
                error?.message?.includes('SubtleCrypto') ||
                error?.message?.includes('Unrecognized name')
            ) {
                t.comment(`Skipping: ${skipReason(error)}`)
                return
            }
            throw error
        }
    })
}

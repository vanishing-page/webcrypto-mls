import { test } from '@substrate-system/tapzero'
import { ciphersuites, getCiphersuiteFromName } from '../src/crypto/ciphersuite.js'
import { getCipherSuite } from '../src/crypto/get-ciphersuite-impl.js'
import { initializeKeySchedule } from '../src/key-schedule.js'

for (const name of Object.keys(ciphersuites)) {
    test(`initializeKeySchedule drops epochSecret (${name})`, async (t) => {
        try {
            const cs = await getCipherSuite(
                getCiphersuiteFromName(name as keyof typeof ciphersuites)
            )

            const epochSecret = cs.rng.randomBytes(cs.kdf.size)
            const original = epochSecret.slice()

            const keySchedule = await initializeKeySchedule(epochSecret, cs.kdf)

            t.equal(
                (keySchedule as any).epochSecret,
                undefined,
                'KeySchedule should not retain epochSecret'
            )

            t.notDeepEqual(
                epochSecret,
                original,
                'the passed-in epochSecret buffer should be zeroized ' +
                    'once its outputs are derived'
            )
            t.ok(
                epochSecret.every((b) => b === 0),
                'the passed-in epochSecret buffer should be all zeros'
            )
        } catch (error:any) {
            if (
                error?.name === 'NotSupportedError' ||
                error?.name === 'DependencyError' ||
                error?.message?.includes('SubtleCrypto') ||
                error?.message?.includes('Unrecognized name')
            ) {
                t.comment(`Skipping: ${error.message}`)
                return
            }
            throw error
        }
    })
}

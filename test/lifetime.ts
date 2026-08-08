import { test } from '@substrate-system/tapzero'
import { defaultLifetime } from '../src/lifetime.js'

test('defaultLifetime is computed at call time, not module load time', async t => {
    const before = BigInt(Math.floor(Date.now() / 1000))

    // simulate time passing between module load and key package generation
    await new Promise(resolve => setTimeout(resolve, 1100))

    const lifetime = defaultLifetime()
    const after = BigInt(Math.floor(Date.now() / 1000))

    t.ok(
        lifetime.notBefore >= before - 3600n &&
            lifetime.notBefore <= after - 3600n,
        'notBefore reflects the current time when called, not an earlier time'
    )
    t.ok(
        lifetime.notAfter >= before + 2592000n &&
            lifetime.notAfter <= after + 2592000n,
        'notAfter reflects the current time when called, not an earlier time'
    )

    const second = defaultLifetime()
    t.ok(
        second.notBefore >= lifetime.notBefore,
        'a later call produces a notBefore that has not gone backwards'
    )
})

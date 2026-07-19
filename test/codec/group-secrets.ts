import { test } from '@substrate-system/tapzero'
import {
    encodeGroupSecrets,
    decodeGroupSecrets
} from '../../src/group-secrets.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeGroupSecrets, decodeGroupSecrets)

test('groupSecrets roundtrip minimal', (t) => {
    roundtrip(t, { joinerSecret: new Uint8Array([1]), pathSecret: undefined, psks: [] }, 'should roundtrip minimal group secrets')
})

test('groupSecrets roundtrip nontrivial', (t) => {
    roundtrip(t, {
        joinerSecret: new Uint8Array([2, 3, 4]),
        pathSecret: new Uint8Array([5, 6, 7]),
        psks: [{ psktype: 'external', pskId: new Uint8Array([8, 9, 10]), pskNonce: new Uint8Array([11, 12, 13, 14]) }],
    }, 'should roundtrip nontrivial group secrets')
})

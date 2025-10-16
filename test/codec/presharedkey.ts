import { test } from '@substrate-system/tapzero'
import {
    decodePskId,
    decodePskLabel,
    decodePskType,
    decodeResumptionPSKUsage,
    encodePskId,
    encodePskLabel,
    encodePskType,
    encodeResumptionPSKUsage,
} from '../../src/presharedkey.js'
import { createRoundtripTest } from './roundtrip.js'

test('PSKType roundtrip', (t) => {
    const roundtrip = createRoundtripTest(encodePskType, decodePskType)
    roundtrip(t, 'external')
    roundtrip(t, 'resumption')
})

test('ResumptionPSKUsageName roundtrip', (t) => {
    const roundtrip = createRoundtripTest(encodeResumptionPSKUsage, decodeResumptionPSKUsage)
    roundtrip(t, 'application')
    roundtrip(t, 'branch')
    roundtrip(t, 'reinit')
})

test('PreSharedKeyID roundtrip', (t) => {
    dummyPskId.forEach(v => createRoundtripTest(encodePskId, decodePskId)(t, v))
})

test('PSKLabel roundtrip', (t) => {
    dummyPskLabel.forEach(v => createRoundtripTest(encodePskLabel, decodePskLabel)(t, v))
})

const dummyByteArray = [new Uint8Array([0, 1, 2]), new Uint8Array()] as const
const dummyPskInfoResumption = [
    { usage: 'application', pskGroupId: dummyByteArray[0], pskEpoch: 1000n },
    { usage: 'branch', pskGroupId: dummyByteArray[1], pskEpoch: 0n },
] as const
const dummyPskInfoExternal = [{ pskId: dummyByteArray[0] }, { pskId: dummyByteArray[1] }] as const
const dummyPskId = [
    { psktype: 'external', ...dummyPskInfoExternal[0], pskNonce: dummyByteArray[0] },
    { psktype: 'resumption', ...dummyPskInfoResumption[0], pskNonce: dummyByteArray[0] },
    { psktype: 'resumption', ...dummyPskInfoResumption[1], pskNonce: dummyByteArray[1] },
] as const
const dummyPskLabel = [
    { id: dummyPskId[0], index: 99, count: 200 },
    { id: dummyPskId[1], index: 1, count: 65535 },
]

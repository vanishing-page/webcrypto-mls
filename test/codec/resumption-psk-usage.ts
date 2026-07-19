import { test } from '@substrate-system/tapzero'
import type { ResumptionPSKUsageName } from '../../src/presharedkey.js'
import {
    encodeResumptionPSKUsage,
    decodeResumptionPSKUsage
} from '../../src/presharedkey.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(
    encodeResumptionPSKUsage,
    decodeResumptionPSKUsage
)

test('ResumptionPSKUsageName roundtrip application', (t) => {
    roundtrip(t, 'application' as ResumptionPSKUsageName, 'should roundtrip application')
})

test('ResumptionPSKUsageName roundtrip reinit', (t) => {
    roundtrip(t, 'reinit' as ResumptionPSKUsageName, 'should roundtrip reinit')
})

test('ResumptionPSKUsageName roundtrip branch', (t) => {
    roundtrip(t, 'branch' as ResumptionPSKUsageName, 'should roundtrip branch')
})

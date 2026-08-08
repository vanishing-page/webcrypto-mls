import { test } from '@substrate-system/tapzero'
import { openEnumNumberEncoder } from '../../src/util/enum-helpers.js'

const sample = {
    foo: 1,
    bar: 2,
} as const

test('openEnumNumberEncoder encodes known names to their numeric value', (t) => {
    const encode = openEnumNumberEncoder(sample)
    t.equal(encode('foo'), 1, 'should encode known name "foo"')
    t.equal(encode('bar'), 2, 'should encode known name "bar"')
})

test('openEnumNumberEncoder encodes a numeric-string open value', (t) => {
    const encode = openEnumNumberEncoder(sample)
    t.equal(encode('42' as any), 42, 'should encode a stringified number')
})

test('openEnumNumberEncoder throws instead of returning NaN for a non-numeric unknown value', (t) => {
    const encode = openEnumNumberEncoder(sample)
    t.throws(
        () => encode('not-a-number' as any),
        'should throw instead of silently producing NaN',
    )
})

import { test } from '@substrate-system/tapzero'
import { rotationStatus } from '../../example/device-rotation.js'
import { describeClient } from '../../example/user.js'

test('rotationStatus names the device that rotated', t => {
    const line = rotationStatus('Alice/phone', 2n, 3n)

    t.ok(line, 'should produce a status line')
    t.ok(
        line!.startsWith(describeClient('Alice/phone')),
        'should name the person and the device, not the raw client id'
    )
    t.ok(
        line!.includes('3'),
        'should report the epoch the rotation landed on'
    )
})

test('rotationStatus stays quiet when the epoch did not advance', t => {
    t.equal(
        rotationStatus('Alice/phone', 2n, 2n),
        null,
        'an unchanged epoch means no commit happened'
    )
    t.equal(
        rotationStatus('Alice/phone', 3n, 2n),
        null,
        'an epoch going backwards is not a rotation either'
    )
})

test('rotationStatus stays quiet without an in-group before and after', t => {
    t.equal(
        rotationStatus('Alice/phone', null, 1n),
        null,
        'a device with no prior state regenerated a key package instead'
    )
    t.equal(
        rotationStatus('Alice/phone', 1n, null),
        null,
        'losing state is not a rotation'
    )
})

test('rotationStatus falls back to the raw id it cannot parse', t => {
    const line = rotationStatus('Alice', 1n, 2n)

    t.ok(line, 'should still report the rotation')
    t.ok(
        line!.startsWith('Alice '),
        'an unparseable client id is reported as given'
    )
})

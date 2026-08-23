import { test } from '@substrate-system/tapzero'
import {
    constantTimeEqual,
} from '../../src/util/constant-time-compare.js'

// The second layer of the US-016 defense in depth: even with the
// explicit snapshot-length check in validateAttachmentRef, the root
// comparison in object.ts and reader.ts has to reject a wrong-length
// candidate rather than compare a prefix.
test('US-016: constantTimeEqual is false for unequal lengths', t => {
    const short = new Uint8Array(31).fill(0xA5)
    const long = new Uint8Array(32).fill(0xA5)

    t.equal(
        constantTimeEqual(short, long),
        false,
        'a shared prefix does not make a short operand equal',
    )
    t.equal(
        constantTimeEqual(long, short),
        false,
        'the same holds with the operands swapped',
    )
    t.equal(
        constantTimeEqual(new Uint8Array(0), long),
        false,
        'an empty operand is not equal to a non-empty one',
    )
    t.equal(
        constantTimeEqual(long, long.slice()),
        true,
        'equal length and equal contents are still equal',
    )
})

import { test } from '@substrate-system/tapzero'
import type { SenderTypeName } from '../../src/sender.js'
import { encodeSenderType, decodeSenderType } from '../../src/sender.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeSenderType, decodeSenderType)

test('SenderTypeName roundtrip member', (t) => {
    roundtrip(t, 'member' as SenderTypeName, 'should roundtrip member')
})

test('SenderTypeName roundtrip external', (t) => {
    roundtrip(t, 'external' as SenderTypeName, 'should roundtrip external')
})

test('SenderTypeName roundtrip new_member_proposal', (t) => {
    roundtrip(t, 'new_member_proposal' as SenderTypeName, 'should roundtrip new_member_proposal')
})

test('SenderTypeName roundtrip new_member_commit', (t) => {
    roundtrip(t, 'new_member_commit' as SenderTypeName, 'should roundtrip new_member_commit')
})

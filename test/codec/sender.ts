import { test } from '@substrate-system/tapzero'
import { encodeSender, decodeSender } from '../../src/sender.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeSender, decodeSender)

test('Sender roundtrip member', (t) => {
    roundtrip(t, { senderType: 'member', leafIndex: 0 }, 'should roundtrip member')
})

test('Sender roundtrip external', (t) => {
    roundtrip(t, { senderType: 'external', senderIndex: 1 }, 'should roundtrip external')
})

test('Sender roundtrip new_member_proposal', (t) => {
    roundtrip(t, { senderType: 'new_member_proposal' }, 'should roundtrip new_member_proposal')
})

test('Sender roundtrip new_member_commit', (t) => {
    roundtrip(t, { senderType: 'new_member_commit' }, 'should roundtrip new_member_commit')
})

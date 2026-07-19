import { test } from '@substrate-system/tapzero'
import type { DefaultProposalTypeName } from '../../src/default-proposal-type.js'
import {
    encodeDefaultProposalType,
    decodeDefaultProposalType
} from '../../src/default-proposal-type.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(
    encodeDefaultProposalType,
    decodeDefaultProposalType
)

test('ProposalTypeName roundtrip add', (t) => {
    roundtrip(t, 'add' as DefaultProposalTypeName, 'should roundtrip add')
})

test('ProposalTypeName roundtrip group_context_extensions', (t) => {
    roundtrip(t, 'group_context_extensions' as DefaultProposalTypeName, 'should roundtrip group_context_extensions')
})

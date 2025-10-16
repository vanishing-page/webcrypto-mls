import { test } from '@substrate-system/tapzero'
import type { ProposalOrRefTypeName } from '../../src/proposalOrRefType.js'
import { encodeProposalOrRefType, decodeProposalOrRefType } from '../../src/proposalOrRefType.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeProposalOrRefType, decodeProposalOrRefType)

test('ProposalOrRefTypeName roundtrip proposal', (t) => {
    roundtrip(t, 'proposal' as ProposalOrRefTypeName, 'should roundtrip proposal')
})

test('ProposalOrRefTypeName roundtrip reference', (t) => {
    roundtrip(t, 'reference' as ProposalOrRefTypeName, 'should roundtrip reference')
})

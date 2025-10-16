import { test } from '@substrate-system/tapzero'
import { encodeProposalOrRef, decodeProposalOrRef } from '../../src/proposalOrRefType.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeProposalOrRef, decodeProposalOrRef)

test('ProposalOrRef roundtrip proposal', (t) => {
    roundtrip(t, { proposalOrRefType: 'proposal', proposal: { proposalType: 'remove', remove: { removed: 1 } } }, 'should roundtrip proposal')
})

test('ProposalOrRef roundtrip reference', (t) => {
    roundtrip(t, { proposalOrRefType: 'reference', reference: new Uint8Array([1, 2, 3, 4, 5]) }, 'should roundtrip reference')
})

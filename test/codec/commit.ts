import { test } from '@substrate-system/tapzero'
import { encodeCommit, decodeCommit } from '../../src/commit.js'
import { createRoundtripTest } from './roundtrip.js'

const roundtrip = createRoundtripTest(encodeCommit, decodeCommit)

test('commit roundtrip minimal', (t) => {
    roundtrip(t,
        { proposals: [], path: undefined },
        'should roundtrip minimal commit')
})

test('commit roundtrip nontrivial', (t) => {
    roundtrip(t, {
        proposals: [{
            proposalOrRefType: 'proposal',
            proposal: {
                proposalType: 'remove',
                remove: { removed: 1 }
            }
        }],
        path: undefined,
    }, 'should roundtrip nontrivial commit')
})

import { test } from '@substrate-system/tapzero'
import {
    commitFailureVerdict,
    type CommitFailureFacts
} from '../../example-realistic-demo/client/commit-verdict.js'

// security-audit-2026-09.md H6

const GROUP = new Uint8Array([1, 2, 3, 4])

/** The one combination that stops: current epoch, this group, creator. */
function facts (over:Partial<CommitFailureFacts> = {}):CommitFailureFacts {
    return {
        framed: { epoch: 5n, groupId: GROUP },
        current: { epoch: 5n, groupId: new Uint8Array([1, 2, 3, 4]) },
        senderIsCreator: true,
        ...over
    }
}

test('commit verdict - a commit from an older epoch is skipped', (t) => {
    const verdict = commitFailureVerdict(facts({
        framed: { epoch: 4n, groupId: GROUP }
    }))
    t.equal(verdict, 'skip')
})

test('commit verdict - a commit from a future epoch is skipped', (t) => {
    const verdict = commitFailureVerdict(facts({
        framed: { epoch: 6n, groupId: GROUP }
    }))
    t.equal(verdict, 'skip')
})

test('commit verdict - a commit framed for another group is skipped',
    (t) => {
        const verdict = commitFailureVerdict(facts({
            framed: { epoch: 5n, groupId: new Uint8Array([1, 2, 3, 5]) }
        }))
        t.equal(verdict, 'skip')

        const shorter = commitFailureVerdict(facts({
            framed: { epoch: 5n, groupId: new Uint8Array([1, 2, 3]) }
        }))
        t.equal(shorter, 'skip', 'a prefix of the group id is not a match')
    })

test('commit verdict - a current commit not from the creator is skipped',
    (t) => {
        const verdict = commitFailureVerdict(facts({
            senderIsCreator: false
        }))
        t.equal(verdict, 'skip')
    })

test('commit verdict - a current commit from the creator stops', (t) => {
    t.equal(commitFailureVerdict(facts()), 'stop')
})

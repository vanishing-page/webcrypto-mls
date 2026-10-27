import { test } from '@substrate-system/tapzero'
import { tapRunOutcome } from '../scripts/tap-outcome.js'

/**
 * The tail of a tapzero run under node that finished: the plan, then
 * the totals, the way `node scripts/run-tests.mjs` prints them.
 */
function completeRun (planned:number, failed = 0):string {
    return [
        'TAP version 13',
        '# some test',
        'ok 1 an assertion',
        '',
        `1..${planned}`,
        `# tests ${planned}`,
        `# pass  ${planned - failed}`,
        ...(failed > 0 ? [`# fail  ${failed}`] : []),
        '',
        '# ok',
    ].join('\n')
}

test('tap outcome - a node run that reached its plan passes', t => {
    const outcome = tapRunOutcome(completeRun(38873), 0, 'the node run')
    t.ok(outcome.ok, 'the run counts as a pass')
    t.equal(outcome.exitCode, 0, 'and exits zero')
})

test('tap outcome - a node run that stalled partway fails', t => {
    // What node prints when a test awaits a promise that never settles:
    // the event loop empties, node exits 0, and tapzero never reaches
    // its plan.
    const stalled = [
        'TAP version 13',
        '# a',
        'ok 1 one',
        '# stalls',
    ].join('\n')

    const outcome = tapRunOutcome(stalled, 0, 'the node run')
    t.ok(!outcome.ok, 'a stalled run is not a pass')
    t.ok(outcome.exitCode !== 0, 'its exit code is non-zero')
})

test('tap outcome - a failing exit code is carried through', t => {
    const outcome = tapRunOutcome(completeRun(10), 3, 'the node run')
    t.ok(!outcome.ok, 'the plan does not rescue a failed run')
    t.equal(outcome.exitCode, 3, 'the exit code is kept')
})

test('tap outcome - fewer passes than planned fails', t => {
    const outcome = tapRunOutcome(
        '1..10\n# tests 10\n# pass  9',
        0,
        'the node run'
    )
    t.ok(!outcome.ok, 'a short count is not a pass')
})

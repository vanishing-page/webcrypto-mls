import { test } from '@substrate-system/tapzero'
import { browserRunOutcome } from '../scripts/browser-tap.js'

/**
 * The tail of a tapzero run that finished: the plan, then the totals.
 * `pass` is padded to two spaces the way tapzero prints it.
 */
function completeRun (planned:number, failed = 0):string {
    return [
        '# Running tests in chromium',
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

test('a run that reached its plan passes', t => {
    const outcome = browserRunOutcome(completeRun(42281), 0)
    t.ok(outcome.ok, 'the run counts as a pass')
    t.equal(outcome.exitCode, 0, 'and exits zero')
})

test('a non-zero exit code always loses', t => {
    // A page error or a timeout makes tapout exit non-zero after
    // printing a plan that looks complete.
    const outcome = browserRunOutcome(completeRun(42281), 1)
    t.ok(!outcome.ok, 'the plan does not rescue a failed run')
    t.equal(outcome.exitCode, 1, 'the exit code is carried through')
})

test('a run cut short before its plan fails', t => {
    // What tapout prints when the page goes quiet for three seconds
    // in the middle of the suite: some output, no plan, exit 0.
    const truncated = [
        '# Running tests in chromium',
        'TAP version 13',
        '# slow and silent',
        'Tests auto-finished (no explicit completion detected)',
    ].join('\n')

    const outcome = browserRunOutcome(truncated, 0)
    t.ok(!outcome.ok, 'a truncated run is not a pass')
    t.ok(outcome.exitCode !== 0, 'its exit code is non-zero')
    t.ok(
        outcome.message.includes('plan'),
        'the message says what was missing'
    )
})

test('a run with an empty plan fails', t => {
    const outcome = browserRunOutcome('1..0\n# tests 0\n# pass  0', 0)
    t.ok(!outcome.ok, 'planning nothing is not a pass')
})

test('reported failures fail even with a zero exit code', t => {
    const outcome = browserRunOutcome(completeRun(10, 2), 0)
    t.ok(!outcome.ok, 'two failing assertions lose')
    t.ok(outcome.message.includes('2'), 'the count is reported')
})

test('totals that disagree with the plan fail', t => {
    const short = [
        '1..500',
        '# tests 400',
        '# pass  400',
    ].join('\n')

    const outcome = browserRunOutcome(short, 0)
    t.ok(!outcome.ok, 'fewer assertions run than planned is not a pass')
    t.ok(outcome.message.includes('500'), 'the message gives both counts')
})

test('a plan printed by a test cannot stand in for the suite', t => {
    // A test that prints TAP of its own is not the suite's plan; the
    // last plan line is.
    const nested = [
        'ok 1 a test that prints a plan of its own',
        '1..1',
        '# tests 1',
        '# pass  1',
        'ok 2 a later assertion',
        '1..2',
        '# tests 2',
        '# pass  2',
    ].join('\n')

    t.ok(browserRunOutcome(nested, 0).ok, 'the run passes on its own plan')
})

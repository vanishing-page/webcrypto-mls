// Whether a test run reached the end of its suite, decided from the TAP
// stream it printed rather than from its exit code alone.
//
// A run can stop partway and still exit 0. Under node, a test that
// awaits a promise that never settles empties the event loop, and node
// exits 0 with every later test unrun. In the browser, tapout ends a
// run that goes quiet for three seconds and exits 0 too; see
// scripts/browser-tap.ts. Neither prints `not ok`, so the exit code
// cannot tell a full green run from one that stopped after the first
// assertion.
//
// tapzero prints its plan (`1..N`) and its totals only after the last
// test has run, so requiring them is what makes a truncated run red.
//
// Keep this module free of node imports: a test pulls it in and
// `tsconfig.json` narrows `types` to vite's, so a `node:*` import here
// would fail that typecheck.

export interface TapRunOutcome {
    ok:boolean;
    message:string;
    exitCode:number;
}

const PLAN = /^1\.\.(\d+)$/
const TOTAL_TESTS = /^#\s*tests\s+(\d+)$/
const TOTAL_PASS = /^#\s*pass\s+(\d+)$/
const TOTAL_FAIL = /^#\s*fail\s+(\d+)$/

/**
 * The number captured by the last line matching `pattern`, or null when
 * no line matches. The last one wins so that a plan printed inside a
 * test's own output cannot stand in for the suite's.
 */
function lastCount (lines:string[], pattern:RegExp):number|null {
    for (let i = lines.length - 1; i >= 0; i--) {
        const match = pattern.exec(lines[i])
        if (match) return Number(match[1])
    }

    return null
}

/**
 * Decide whether a test run counts as a pass.
 *
 * @param tapOutput Everything the run printed on stdout.
 * @param exitCode The exit code of the process that ran the suite.
 * Non-zero always loses; this function only ever turns a zero into a
 * failure, never the other way round.
 * @param runName How the messages name the run, e.g. `the node run`.
 * @param truncatedHint Appended to the message for a run that printed
 * no plan, to say how that run gets cut short.
 * @returns Whether the run passed, the line to print when it did not,
 * and the exit code to leave with.
 */
export function tapRunOutcome (
    tapOutput:string,
    exitCode:number,
    runName:string,
    truncatedHint = ''
):TapRunOutcome {
    if (exitCode !== 0) {
        return {
            ok: false,
            message: 'FAIL: ' + runName + ' exited ' + exitCode + '.',
            exitCode,
        }
    }

    const lines = tapOutput.split('\n').map(line => line.trim())
    const planned = lastCount(lines, PLAN)

    if (planned === null) {
        return {
            ok: false,
            message: 'FAIL: ' + runName + ' printed no TAP plan, so it ' +
                'stopped before the end of the suite.' +
                (truncatedHint ? ' ' + truncatedHint : ''),
            exitCode: 1,
        }
    }

    if (planned === 0) {
        return {
            ok: false,
            message: 'FAIL: ' + runName + ' planned no assertions. The ' +
                'suite is meant to run tens of thousands of them, so an ' +
                'empty plan means the bundle ran nothing.',
            exitCode: 1,
        }
    }

    const failed = lastCount(lines, TOTAL_FAIL)
    if (failed !== null && failed > 0) {
        return {
            ok: false,
            message: 'FAIL: ' + runName + ' reported ' + failed +
                ' failing assertions.',
            exitCode: 1,
        }
    }

    const ran = lastCount(lines, TOTAL_TESTS)
    const passed = lastCount(lines, TOTAL_PASS)

    if (ran !== planned || passed !== planned) {
        return {
            ok: false,
            message: 'FAIL: ' + runName + ' planned ' + planned +
                ' assertions but reported ' + ran + ' run and ' + passed +
                ' passing.',
            exitCode: 1,
        }
    }

    return {
        ok: true,
        message: '',
        exitCode: 0,
    }
}

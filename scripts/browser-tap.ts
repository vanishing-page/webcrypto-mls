// Whether a browser test run reached the end of its suite, decided from
// the TAP stream it printed rather than from the runner's exit code
// alone.
//
// `tapout` ends a run when the page stops printing for three seconds
// and reports it as "Tests auto-finished (no explicit completion
// detected)". A run that goes quiet for that long in the middle -- one
// slow ciphersuite on a loaded runner is enough -- is cut short there,
// and `tapout` exits 0 because nothing printed `not ok`. Verified
// against tapout 0.0.40 with a suite that sleeps eight seconds between
// two assertions: the second assertion fails, and the run still exits
// 0 having printed one line. The exit code alone therefore cannot tell
// a full green run from a run that stopped after the first assertion,
// which is the whole value of having the job.
//
// tapzero prints its plan (`1..N`) and its totals only after the last
// test has run, so requiring them is what makes a truncated run red.
//
// Keep this module free of node imports: a test pulls it in and
// `tsconfig.json` narrows `types` to vite's, so a `node:*` import here
// would fail that typecheck. `scripts/interop-toolchain.ts` is split
// out of its harness for the same reason.

export interface BrowserRunOutcome {
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
 * Decide whether a browser run counts as a pass.
 *
 * @param tapOutput Everything the run printed on stdout.
 * @param runnerExitCode The exit code of the process that ran the
 * suite in the browser. Non-zero always loses; this function only ever
 * turns a zero into a failure, never the other way round.
 * @returns Whether the run passed, the line to print when it did not,
 * and the exit code to leave with.
 */
export function browserRunOutcome (
    tapOutput:string,
    runnerExitCode:number
):BrowserRunOutcome {
    if (runnerExitCode !== 0) {
        return {
            ok: false,
            message: 'FAIL: the browser run exited ' + runnerExitCode + '.',
            exitCode: runnerExitCode,
        }
    }

    const lines = tapOutput.split('\n').map(line => line.trim())
    const planned = lastCount(lines, PLAN)

    if (planned === null) {
        return {
            ok: false,
            message: 'FAIL: the browser run printed no TAP plan, so it ' +
                'stopped before the end of the suite. tapout ends a run ' +
                'that goes quiet for three seconds and exits 0, so a ' +
                'truncated run looks green without this check. Rerun ' +
                'locally; if the suite now has a step that is silent for ' +
                'longer than that, the step has to report progress.',
            exitCode: 1,
        }
    }

    if (planned === 0) {
        return {
            ok: false,
            message: 'FAIL: the browser run planned no assertions. The ' +
                'suite is meant to run tens of thousands of them, so an ' +
                'empty plan means the bundle ran nothing.',
            exitCode: 1,
        }
    }

    const failed = lastCount(lines, TOTAL_FAIL)
    if (failed !== null && failed > 0) {
        return {
            ok: false,
            message: 'FAIL: the browser run reported ' + failed +
                ' failing assertions.',
            exitCode: 1,
        }
    }

    const ran = lastCount(lines, TOTAL_TESTS)
    const passed = lastCount(lines, TOTAL_PASS)

    if (ran !== planned || passed !== planned) {
        return {
            ok: false,
            message: 'FAIL: the browser run planned ' + planned +
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

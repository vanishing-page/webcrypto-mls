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
// The plan check itself is scripts/tap-outcome.ts, which the node runner
// shares; this module only says how a browser run gets cut short.
//
// Keep this module free of node imports: a test pulls it in and
// `tsconfig.json` narrows `types` to vite's, so a `node:*` import here
// would fail that typecheck. `scripts/interop-toolchain.ts` is split
// out of its harness for the same reason.

import { tapRunOutcome, type TapRunOutcome } from './tap-outcome.js'

export type BrowserRunOutcome = TapRunOutcome

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
    return tapRunOutcome(
        tapOutput,
        runnerExitCode,
        'the browser run',
        'tapout ends a run that goes quiet for three seconds and exits ' +
            '0, so a truncated run looks green without this check. ' +
            'Rerun locally; if the suite now has a step that is silent ' +
            'for longer than that, the step has to report progress.'
    )
}

// @ts-check
// Run the whole test suite in headless chromium and check that it
// reached the end of the suite.
//
//   node scripts/run-browser-tests.mjs
//
// This wraps what used to be a shell pipeline,
// `node build-test.js | tapout`, for one reason: the pipeline's exit
// code is tapout's, and tapout exits 0 for a run that stopped in the
// middle. See scripts/browser-tap.ts for how that happens and why the
// TAP plan is the thing that catches it. Reading the exit code and the
// stream together needs both processes visible at once, which a shell
// pipeline under `sh` cannot give us -- dash has no `pipefail`.
//
// Everything the run prints still goes to stdout as it arrives, so the
// output is what it always was.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

// How long the whole in-page run may take. It has to stay under the
// job's timeout in .github/workflows/nodejs.yml so that a hung run is
// reported as a timed-out test run rather than as a killed job. The
// suite takes about two and a half minutes locally; the rest is
// headroom for a slower runner.
const PAGE_TIMEOUT_MS = 600000

const outfile = '.browser-tap-bundle.mjs'
buildSync({
    entryPoints: ['scripts/browser-tap.ts'],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    outfile,
})
const { browserRunOutcome } = await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })

/** @param {import('node:child_process').ChildProcess} child */
function exitCodeOf (child) {
    return new Promise(resolve => {
        child.on('error', () => resolve(1))
        child.on('close', code => resolve(code ?? 1))
    })
}

const bundle = spawn(process.execPath, ['build-test.js'], {
    stdio: ['ignore', 'pipe', 'inherit'],
})
const runner = spawn('node_modules/.bin/tapout', [
    '--timeout', String(PAGE_TIMEOUT_MS),
], {
    stdio: ['pipe', 'pipe', 'inherit'],
})

if (bundle.stdout && runner.stdin) bundle.stdout.pipe(runner.stdin)
// tapout can exit while the bundle is still being written to it, which
// closes the pipe under the writer. That is not a failure on its own;
// the exit codes below decide.
runner.stdin?.on('error', () => {})

let output = ''
runner.stdout?.on('data', chunk => {
    output += chunk
    process.stdout.write(chunk)
})

const [bundleCode, runnerCode] = await Promise.all([
    exitCodeOf(bundle),
    exitCodeOf(runner),
])

// Set the exit code rather than calling process.exit, so that the last
// of the run's output is flushed. In CI stdout is a pipe, and exiting
// outright there drops whatever is still buffered -- which is the tail
// of the TAP stream, the part worth reading.
if (bundleCode !== 0) {
    console.error(
        'FAIL: bundling test/index.ts for the browser did not succeed, ' +
        'so nothing ran.'
    )
    process.exitCode = bundleCode
} else {
    const outcome = browserRunOutcome(output, runnerCode)
    if (!outcome.ok) console.error(outcome.message)
    process.exitCode = outcome.exitCode
}

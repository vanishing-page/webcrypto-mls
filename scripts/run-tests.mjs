// @ts-check
// Bundle one of the test entries with esbuild and run it under node.
//
//   node scripts/run-tests.mjs [all|unit|matrix] [suite filter]
//
// The suite filter is the same value MLS_SUITES takes, and passing it
// here is just a friendlier way of setting that variable:
//
//   node scripts/run-tests.mjs matrix shard:1/4
//   MLS_SUITES=shard:1/4 node scripts/run-tests.mjs matrix
//
// esbuild only strips types, so a run here says nothing about whether
// the code typechecks. Run tsc as well.
//
// The exit code alone does not decide the result. A test that awaits a
// promise that never settles empties the event loop, and node exits 0
// with every later test unrun. So the run's stdout is checked for
// tapzero's closing plan and totals, the same check the browser run
// makes; see scripts/tap-outcome.ts.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ENTRIES = {
    all: 'test/index.ts',
    unit: 'test/unit.ts',
    matrix: 'test/matrix.ts',
}

const [name = 'all', suites] = process.argv.slice(2)
const entry = ENTRIES[name]

if (!entry) {
    console.error(
        `unknown test entry '${name}', ` +
        `expected one of: ${Object.keys(ENTRIES).join(', ')}`
    )
    process.exit(1)
}

const bundle = `.test-bundle-${name}.cjs`

await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    loader: { '.json': 'json' },
    keepNames: true,
    outfile: bundle,
})

const outcomeBundle = `.test-outcome-${name}.mjs`
await esbuild.build({
    entryPoints: ['scripts/tap-outcome.ts'],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    outfile: outcomeBundle,
})
const { tapRunOutcome } = await import(pathToFileURL(outcomeBundle).href)
fs.rmSync(outcomeBundle, { force: true })

const child = spawn(process.execPath, [bundle], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: suites ? { ...process.env, MLS_SUITES: suites } : process.env,
})

let output = ''
child.stdout.on('data', chunk => {
    output += chunk
    process.stdout.write(chunk)
})

// A signal death has no exit code of its own; report it as a failure
// rather than as a pass.
const status = await new Promise(resolve => {
    child.on('error', () => resolve(1))
    child.on('close', code => resolve(code ?? 1))
})

fs.rmSync(bundle, { force: true })

// Set the exit code rather than calling process.exit, so that the tail
// of the TAP stream is flushed when stdout is a pipe.
const outcome = tapRunOutcome(output, status, `the ${name} test run`)
if (!outcome.ok) console.error(outcome.message)
process.exitCode = outcome.exitCode

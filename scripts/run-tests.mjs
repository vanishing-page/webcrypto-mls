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
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
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

const result = spawnSync(process.execPath, [bundle], {
    stdio: 'inherit',
    env: suites ? { ...process.env, MLS_SUITES: suites } : process.env,
})

fs.rmSync(bundle, { force: true })

// A signal death has no exit code of its own; report it as a failure
// rather than as a pass.
process.exit(result.status ?? 1)

// Bundles and runs the benchmark. Mirrors the esbuild settings of
// scripts/run-interop.mjs, except for the ESM output that the
// benchmark's top-level await needs.
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const outfile = '.bench-bundle.mjs'
buildSync({
    entryPoints: ['scripts/bench.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    keepNames: true,
    loader: { '.json': 'json' },
    outfile,
})
const result = spawnSync(process.execPath, [outfile], {
    stdio: 'inherit',
})
rmSync(outfile, { force: true })
process.exit(result.status ?? 1)

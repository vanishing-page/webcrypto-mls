// Bundles and runs the interop harness. Mirrors the esbuild
// settings of scripts/run-tests.mjs.
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const outfile = '.interop-bundle.cjs'
buildSync({
    entryPoints: ['scripts/interop-seal.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    keepNames: true,
    loader: { '.json': 'json' },
    outfile,
})
const result = spawnSync(process.execPath, [outfile], {
    stdio: 'inherit',
})
rmSync(outfile, { force: true })
process.exit(result.status ?? 1)

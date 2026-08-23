// Check that vector generation is deterministic by bundling and running
// the generator in a temp directory, then comparing output byte-for-byte
// against the committed vectors.
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import {
    rmSync, readdirSync, readFileSync, mkdtempSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'vector-check-'))
const outfile = '.vector-gen-bundle.cjs'

// process.exit() terminates immediately and does NOT run finally
// blocks, so exiting from inside the try below would strand the
// esbuild bundle in the repository root and orphan the temp
// directory. Record the failure, let the finally clean up, and exit
// afterwards. run-interop.mjs uses the same shape: compute, clean up,
// exit last.
let failure = null
const fail = (msg) => {
    failure = msg
    throw new Error('determinism-check-failed')
}

try {
    // Bundle the generator
    buildSync({
        entryPoints: ['scripts/generate-seal-own-vectors.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        keepNames: true,
        loader: { '.json': 'json' },
        outfile,
    })

    // Run the generator in the temp directory
    const result = spawnSync(
        process.execPath,
        [outfile, tempDir],
        { stdio: 'inherit' }
    )

    if (result.status !== 0) {
        fail('Vector generation failed')
    }

    // Compare the two sets symmetrically, over .json vectors only.
    //
    // No hard-coded list of expected files. An earlier version kept
    // one and compared generated-against-expected and
    // expected-against-committed, but never committed-against-
    // generated -- so a committed vector the generator no longer
    // produces passed silently, which is the dropped-vector case this
    // check exists to catch. A third source of truth beside the
    // generator and the committed tree is also a thing to keep in
    // sync by hand.
    //
    // Exclude the known non-vector files BY NAME rather than
    // allowlisting an extension. An earlier version filtered both
    // listings to .json, which made any non-.json file invisible on
    // both sides -- a stray extra.bin in the committed tree passed
    // silently, the same blind spot the symmetric comparison exists
    // to close. Excluding by name means a future vector in another
    // format is covered without editing this script.
    const NOT_VECTORS = new Set(['README.md'])
    const isVector = (f) => !NOT_VECTORS.has(f)
    const generated = readdirSync(tempDir).filter(isVector).sort()
    const committed = readdirSync('test_vectors/seal/own')
        .filter(isVector).sort()

    // Ahead of the two loops, so it guards what it looks like it
    // guards. Below them it only fired when BOTH sides were empty.
    if (generated.length === 0) {
        fail('Determinism check failed: no vectors generated')
    }

    for (const file of generated) {
        if (!committed.includes(file)) {
            fail(`Determinism check failed: generated file ` +
                `has no committed counterpart: ${file}`)
        }
    }

    for (const file of committed) {
        if (!generated.includes(file)) {
            fail(`Determinism check failed: committed vector ` +
                `was not generated: ${file}`)
        }
    }

    // Compare byte-for-byte
    for (const file of generated) {
        const a = readFileSync(join(tempDir, file))
        const b = readFileSync(join('test_vectors/seal/own', file))
        if (!a.equals(b)) {
            fail(`Determinism check failed: ${file} differs`)
        }
    }

    console.log('Determinism check passed: all vectors match')
} catch (err) {
    if (!failure) throw err
} finally {
    // Runs on every path now, including failure.
    rmSync(tempDir, { recursive: true, force: true })
    rmSync(outfile, { force: true })
}

if (failure) {
    console.error(failure)
    process.exit(1)
}

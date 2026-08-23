// Verifies the attachment subsystem's structural invariants:
// 1. src/index.ts stays attachment-free (opt-in via subpaths only)
// 2. reader.ts never pulls in range.ts
// 3. keys.ts pulls in no SEAL code (usable with foreign schemes)
// 4. No file under src/attachment/ calls getRandomValues; the salt
//    comes from the SealCrypto bundle's rng (phase 3)
// 5. wipeSealState is called in reader.ts, range.ts and object.ts
//    (design security rule 7)
// 6. writer.ts wipes its CEK with .fill(0), and the reader and range
//    ...ForGroup wrappers pass { ownedCek: cek } so the stream owns
//    and wipes theirs (phase 2)
// 7. Every vendored test vector is imported, the core and engine
//    counts match test_vectors/seal/README.md, and each engine file is
//    byte-identical to its core counterpart as that README claims
//
// Check 4 is an absence scan over every file under src/attachment/,
// which is a stronger guarantee than the rest. Checks 5 to 7 are
// presence checks: they prove the mechanism was not deleted
// wholesale, not that it is reachable on every path. The
// behavioural proofs live in test/attachment/cek-wipe.ts and
// test/attachment/padding.ts.
import { build } from 'esbuild'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

let failed = false
function fail (msg) {
    console.error('FAIL: ' + msg)
    failed = true
}

const index = readFileSync('src/index.ts', 'utf8')
if (index.includes('attachment')) {
    fail('src/index.ts references attachment/')
}

async function inputsOf (entry) {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'esm',
        metafile: true,
        logLevel: 'silent',
    })
    return Object.keys(result.metafile.inputs)
}

const readerInputs = await inputsOf('src/attachment/reader.ts')
if (readerInputs.some(p => p.endsWith('attachment/range.ts'))) {
    fail('reader.ts pulls in range.ts')
}

const keysInputs = await inputsOf('src/attachment/keys.ts')
const sealModules = [
    'crypto.ts', 'kdf.ts', 'schedule.ts', 'snapshot.ts',
    'layout.ts', 'object.ts', 'reader.ts', 'range.ts', 'writer.ts',
    'reference.ts',
]
for (const m of sealModules) {
    if (keysInputs.some(p => p.endsWith('attachment/' + m))) {
        fail('keys.ts pulls in attachment/' + m)
    }
}

// Check that no file under src/attachment/ calls getRandomValues.
// The salt this would produce is what security rule 1 rests on, so
// this is the structural backstop for AC3.2.
//
// Matched over the whole file rather than line by line. A line-scoped
// version was defeated by wrapping at the dot, which the 80-column
// house rule makes the natural way to write the call:
//     globalThis.crypto
//         .getRandomValues(new Uint8Array(32))
//
// Matched on the bare identifier rather than on a `crypto.` prefix,
// which also catches a destructured `const { getRandomValues } = ...`.
// The plan warned against matching `globalThis.crypto` alone because
// crypto.ts uses `globalThis.crypto.subtle` legitimately; the bare
// identifier does not have that problem, and there are zero
// occurrences of it under src/attachment/ today.
//
// Recursive so a future src/attachment/<subdir>/foo.ts cannot escape.
const attachmentDir = 'src/attachment'
const attachmentFiles = readdirSync(attachmentDir, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.ts'))
for (const file of attachmentFiles) {
    const path = `${attachmentDir}/${file}`
    const src = readFileSync(path, 'utf8')
    // Blank out comments before matching, keeping offsets intact
    // so the reported line number stays right. Without this the
    // invariant cannot be described in the source it governs: a
    // comment saying "never call getRandomValues here" would fail the
    // build, which reads as a bug to whoever writes it. Block comments
    // count: every file under src/attachment/ uses JSDoc, so that is
    // where such a note would naturally go. Newlines are preserved
    // rather than blanked wholesale, because a block comment spans
    // lines and squashing them would shift every line number below it.
    //
    // String literals are NOT stripped. Handling three quote forms
    // plus escapes plus template interpolation is real complexity for
    // a case that has no reason to occur here, and the failure mode is
    // fail-closed: a false positive blocks a commit and is obvious.
    const scannable = src.replace(
        /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        m => m.replace(/[^\n]/g, ' '),
    )
    let at = scannable.indexOf('getRandomValues')
    while (at !== -1) {
        const line = scannable.slice(0, at).split('\n').length
        fail(`${path}:${line} calls getRandomValues`)
        at = scannable.indexOf('getRandomValues', at + 1)
    }
}

if (failed) process.exit(1)
console.log('attachment layering invariants ok')

// Inventory check: verify all vendored vector files are imported
const coreDir = 'test_vectors/seal/core'
const engineDir = 'test_vectors/seal/engine'

const coreFiles = readdirSync(coreDir)
    .filter(f => f.endsWith('.json'))
    .sort()
const engineFiles = readdirSync(engineDir)
    .filter(f => f.endsWith('.json'))
    .sort()

// The counts and the byte-identity claim are both stated in
// test_vectors/seal/README.md. Pin them here so the doc cannot drift
// away from the directory: vendoring a new file, or re-vendoring one
// that stops matching its counterpart, fails until the README says so.
const EXPECTED_CORE = 6
const EXPECTED_ENGINE = 3

if (coreFiles.length !== EXPECTED_CORE) {
    fail(
        `${coreDir} holds ${coreFiles.length} vectors, ` +
        `README says ${EXPECTED_CORE}`,
    )
}

if (engineFiles.length !== EXPECTED_ENGINE) {
    fail(
        `${engineDir} holds ${engineFiles.length} vectors, ` +
        `README says ${EXPECTED_ENGINE}`,
    )
}

for (const file of engineFiles) {
    if (!existsSync(`${coreDir}/${file}`)) {
        fail(
            `engine vector ${file} has no core counterpart, so the ` +
            'byte-identity claim in README.md no longer holds',
        )
        continue
    }
    const core = readFileSync(`${coreDir}/${file}`)
    const engine = readFileSync(`${engineDir}/${file}`)
    if (!core.equals(engine)) {
        fail(
            `engine vector ${file} is no longer byte-identical to its ` +
            'core counterpart, which README.md claims it is',
        )
    }
}

const vectorsFile = readFileSync('test/attachment/vectors-all.ts', 'utf8')

// Check each vendor file is mentioned in an import
for (const file of coreFiles) {
    if (!vectorsFile.includes(`'../../test_vectors/seal/core/${file}'`)) {
        fail(`vendored core vector ${file} not imported in vectors-all.ts`)
    }
}

for (const file of engineFiles) {
    if (!vectorsFile.includes(`'../../test_vectors/seal/engine/${file}'`)) {
        fail(`vendored engine vector ${file} not imported in vectors-all.ts`)
    }
}

// 5. Every module that owns a SealState wipes it. This is a presence
// check only: it proves the call was not deleted wholesale, not that it
// fires on each terminal path, which the zeroization tests in
// test/attachment/streams.ts cover.
const wipeOwners = ['reader.ts', 'range.ts', 'object.ts']
for (const owner of wipeOwners) {
    const src = readFileSync(`src/attachment/${owner}`, 'utf8')
    // Count call sites, not the bare name: the import binding also
    // contains it, so a module that imports and never calls would pass.
    const calls = (src.match(/wipeSealState\(/g) || []).length
    if (calls === 0) {
        fail(`src/attachment/${owner} never calls wipeSealState`)
    }
}

// Sibling check for CEK ownership: verify that the wrappers own and
// wipe the derived CEKs. This is a presence check only: it proves the
// call-site arguments and wipe calls were not deleted wholesale, not
// that the wipe is reachable on every exit path. The behavioural proof
// lives in test/attachment/cek-wipe.ts.
const writer = readFileSync('src/attachment/writer.ts', 'utf8')
if (!writer.includes('.fill(0)')) {
    fail('src/attachment/writer.ts never calls .fill(0) on the CEK')
}

const reader = readFileSync('src/attachment/reader.ts', 'utf8')
const readerCalls = (reader.match(/{\s*ownedCek:\s*cek\s*}/g) || []).length
if (readerCalls === 0) {
    fail('src/attachment/reader.ts never passes { ownedCek: cek } argument')
}

const range = readFileSync('src/attachment/range.ts', 'utf8')
const rangeCalls = (range.match(/{\s*ownedCek:\s*cek\s*}/g) || []).length
if (rangeCalls === 0) {
    fail('src/attachment/range.ts never passes { ownedCek: cek } argument')
}

if (failed) process.exit(1)
console.log(`zeroization calls present in ${wipeOwners.join(', ')} ok`)
const totalVectors = coreFiles.length + engineFiles.length
console.log(
    `vector inventory: ${coreFiles.length} core, ` +
    `${engineFiles.length} engine (${totalVectors} total) ok`,
)

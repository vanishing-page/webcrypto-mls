// Consumes the built package the way a user does: by its package name,
// through the export map, from both CommonJS and ESM. Every test under
// `test/` imports `src/`, so none of them can see a defect that lives
// only in `dist/` -- such as a CommonJS file that requires a `.js`
// sibling and so loads the ESM build instead, leaving two copies of
// `mls-error` whose classes fail `instanceof` against each other.
//
// Needs `dist/`, so run it after `npm run build`. CI runs it in the
// `build` job for that reason; it is not part of `test:checks`.
//
// Three checks:
//
//   No `.cjs` file in `dist/` (regular or minified) requires a relative
//   `.js` path. That is the structural rule behind the other two.
//
//   From CommonJS, a real library error (the fail-closed authentication
//   service) is `instanceof` `UsageError` from the root and from the
//   `mls-error` subpath, and every export name shared by two of the
//   required entry points is the same value from each. Every error
//   class and both base64 decoders import from the root, the decoders
//   invert the encoders, and an error a public operation throws on bad
//   peer input is `instanceof` `ValidationError` and `MlsError` from
//   the root.
//
//   The same from ESM.
//
//   A CommonJS (`.cts`) and an ESM (`.mts`) TypeScript consumer of the
//   same entry points compile under `--module NodeNext --strict`, each
//   as its own program. A CommonJS subpath without a `.d.cts` beside
//   its `.cjs` is TS7016. A `.d.cts` that reaches an ESM `.d.ts`
//   through a relative import is not an error -- NodeNext allows a
//   CommonJS file to require ESM -- so the CommonJS program's resolved
//   file list must also contain no `dist/**/*.d.ts`. `skipLibCheck` is
//   off: no third-party declaration in the graph needs it, and with it
//   on tsc would not report errors inside the package's own
//   declarations.
//
// The consumer is a scratch directory with the package linked into its
// `node_modules` under its real name, so dependencies resolve from this
// checkout without a network install. It is removed whether the check
// passes or fails.
import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
    symlinkSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
    dirname, isAbsolute, join, relative, sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

// The root, the documented error subpath, a nested attachment subpath
// and a nested crypto subpath. `crypto/ciphersuite` shares exports with
// the root, so the identity check has something to compare there too.
const ENTRIES = [
    '',
    '/mls-error',
    '/attachment/reader',
    '/attachment/error',
    '/crypto/ciphersuite',
]

// The error classes and byte helpers a consumer imports from the root.
// The error type is part of the contract, so every class must be
// reachable for `instanceof` without knowing the subpath.
const ROOT_EXPORTS = [
    'MlsError',
    'ValidationError',
    'CodecError',
    'UsageError',
    'DependencyError',
    'CryptoVerificationError',
    'CryptoError',
    'InternalError',
    'base64ToBytes',
    'base64urlToBytes',
]

const failures = []

function walk (dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
        const p = join(dir, d.name)
        return d.isDirectory() ? walk(p) : [p]
    })
}

function checkNoRelativeJs () {
    const req = /require\(\s*["'](\.{1,2}\/[^"']*\.js)["']\s*\)/g
    for (const file of walk(DIST).filter(f => f.endsWith('.cjs'))) {
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(req)) {
            failures.push(
                `${relative(ROOT, file)} requires ESM file ${m[1]}`
            )
        }
    }
}

// The body shared by both consumers. `load` is `require` or a dynamic
// `import`; everything after it is module-system neutral.
const consumerBody = `
const PKG = ${JSON.stringify(PKG)}
const ENTRIES = ${JSON.stringify(ENTRIES)}
const ROOT_EXPORTS = ${JSON.stringify(ROOT_EXPORTS)}

async function run (load) {
    const mods = {}
    for (const e of ENTRIES) mods[PKG + e] = await load(PKG + e)
    const failures = []
    const root = mods[PKG]
    const errors = mods[PKG + '/mls-error']

    let thrown
    try {
        await root.failClosedAuthenticationService.validateCredential(
            { credentialType: 'basic', identity: new Uint8Array() },
            new Uint8Array()
        )
    } catch (err) {
        thrown = err
    }
    if (!thrown) {
        failures.push('fail-closed authentication service did not throw')
    } else {
        for (const [name, m] of Object.entries(mods)) {
            if (m.UsageError && !(thrown instanceof m.UsageError)) {
                failures.push('error is not instanceof UsageError from ' +
                    name)
            }
        }
        if (!errors.UsageError) failures.push('mls-error has no UsageError')
    }

    for (const name of ROOT_EXPORTS) {
        if (typeof root[name] !== 'function') {
            failures.push('package root does not export ' + name)
        }
    }

    // A peer's GroupInfo with no external_senders extension is bad peer
    // input, refused before any crypto runs.
    let invalid
    try {
        await root.proposeExternal(
            { groupContext: { extensions: [] } },
            { proposalType: 'remove', remove: { removed: 0 } },
            new Uint8Array(),
            new Uint8Array(),
            undefined
        )
    } catch (err) {
        invalid = err
    }
    for (const cls of ['ValidationError', 'MlsError']) {
        if (typeof root[cls] !== 'function') continue
        if (!(invalid instanceof root[cls])) {
            failures.push('bad peer input did not throw an instance of ' +
                cls + ' from the root: ' + invalid)
        }
    }

    if (root.base64ToBytes && root.base64urlToBytes) {
        const bytes = new Uint8Array(256).map((_, i) => i)
        const same = (a, b) => a.length === b.length &&
            a.every((x, i) => x === b[i])
        if (!same(root.base64ToBytes(root.bytesToBase64(bytes)), bytes)) {
            failures.push('base64ToBytes does not invert bytesToBase64')
        }
        const url = root.bytesToBase64url(bytes)
        if (!same(root.base64urlToBytes(url), bytes)) {
            failures.push('base64urlToBytes does not invert bytesToBase64url')
        }
    }

    // Any export name that two entry points both expose is meant to be
    // one value; a second copy means a second evaluation of its module.
    const seen = new Map()
    for (const [name, m] of Object.entries(mods)) {
        for (const key of Object.keys(m)) {
            if (key === 'default' || key === '__esModule') continue
            const prior = seen.get(key)
            if (!prior) {
                seen.set(key, { name, value: m[key] })
            } else if (prior.value !== m[key]) {
                failures.push(key + ' from ' + name +
                    ' is a different object than from ' + prior.name)
            }
        }
    }
    return failures
}
`

const cjsConsumer = consumerBody + `
run(async id => require(id)).then(f => {
    for (const line of f) console.log(line)
    process.exitCode = f.length ? 1 : 0
}, err => { console.log(String(err && err.stack)); process.exitCode = 1 })
`

const esmConsumer = consumerBody + `
run(id => import(id)).then(f => {
    for (const line of f) console.log(line)
    process.exitCode = f.length ? 1 : 0
}, err => { console.log(String(err && err.stack)); process.exitCode = 1 })
`

// TypeScript consumers. Each uses a value and a type from every entry
// point, so an entry that resolves to nothing is TS7016 under `strict`.
function tsConsumer (load) {
    const lines = ENTRIES.map((e, i) => load(`m${i}`, PKG + e))
    return lines.join('\n') + `
const name:m4.CiphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
const id:number = m4.ciphersuites[name]
const err:m1.MlsError = new m0.UsageError('probe')
const parse:(b:Uint8Array, n:number, nh:number) => m2.HeaderPrefix =
    m2.parsePrefix
const auth:m0.AuthenticationService = m0.failClosedAuthenticationService
const base:typeof m3.AttachmentError extends Function ? true : false = true
export { id, err, parse, auth, base }
`
}

const cjsTsConsumer = tsConsumer((n, id) => `import ${n} = require('${id}')`)
const esmTsConsumer = tsConsumer((n, id) => `import * as ${n} from '${id}'`)

function tsconfig (file) {
    return JSON.stringify({
        compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            types: [],
            strict: true,
            noEmit: true,
        },
        files: [file],
    }, null, 4)
}

// Returns the program's file list, so a caller can check where the
// consumer's imports resolved.
function runTsc (scratch, project, label) {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const r = spawnSync(
        process.execPath,
        [tsc, '-p', project, '--listFiles'],
        { cwd: scratch, encoding: 'utf8' }
    )
    const out = (r.stdout + r.stderr).trim()
    const lines = out.split('\n').map(l => l.trim())
    if (r.status !== 0) {
        const errors = lines.filter(l => !isAbsolute(l)).join('\n')
        failures.push(`${label} TypeScript consumer failed:\n${errors}`)
    }
    return lines.filter(l => isAbsolute(l))
}

function checkTypes (scratch) {
    writeFileSync(join(scratch, 'consumer.cts'), cjsTsConsumer)
    writeFileSync(join(scratch, 'consumer.mts'), esmTsConsumer)
    writeFileSync(join(scratch, 'tsconfig.cjs.json'), tsconfig('consumer.cts'))
    writeFileSync(join(scratch, 'tsconfig.esm.json'), tsconfig('consumer.mts'))

    const cjsFiles = runTsc(scratch, 'tsconfig.cjs.json', 'CommonJS')
    runTsc(scratch, 'tsconfig.esm.json', 'ESM')

    // tsc lists real paths, so the package's files appear under DIST
    // rather than under the scratch link.
    for (const f of cjsFiles) {
        if (f.startsWith(DIST + sep) && f.endsWith('.d.ts')) {
            failures.push('CommonJS types resolved ESM declaration ' +
                relative(ROOT, f))
        }
    }
}

function runConsumer (scratch, file, label) {
    const r = spawnSync(process.execPath, [file], {
        cwd: scratch,
        encoding: 'utf8',
    })
    const out = (r.stdout + r.stderr).trim()
    if (r.status !== 0) {
        failures.push(`${label} consumer failed:\n${out}`)
    }
}

function main () {
    if (!existsSync(DIST)) {
        console.error('dist/ is missing; run `npm run build` first')
        process.exit(1)
    }

    checkNoRelativeJs()

    // Inside the checkout and gitignored, rather than in the system
    // temp directory, so a crash cannot leave it anywhere unexpected.
    const scratch = mkdtempSync(join(ROOT, '.package-consumer-'))
    try {
        const linkDir = join(scratch, 'node_modules', ...PKG.split('/'))
        mkdirSync(dirname(linkDir), { recursive: true })
        symlinkSync(ROOT, linkDir, 'dir')
        writeFileSync(join(scratch, 'consumer.cjs'), cjsConsumer)
        writeFileSync(join(scratch, 'consumer.mjs'), esmConsumer)
        runConsumer(scratch, 'consumer.cjs', 'CommonJS')
        runConsumer(scratch, 'consumer.mjs', 'ESM')
        checkTypes(scratch)
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }

    if (failures.length) {
        console.error('package consumer check failed:')
        for (const f of failures) console.error('  ' + f)
        process.exit(1)
    }
    console.log('package consumer check passed')
}

main()

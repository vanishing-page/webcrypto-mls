// Point every relative `require` in the CommonJS build at its CommonJS
// sibling. esbuild renames the outputs with `--out-extension` but does
// not rewrite the specifiers inside them, and without bundling it has
// no flag that would, so `dist/index.cjs` is left requiring
// `./mls-error.js` -- the ESM build. A consumer that also requires the
// `mls-error` subpath then holds two copies of every error class.
//
// A `.min.cjs` file is pointed at `.min.cjs`, any other `.cjs` file at
// `.cjs`, so each build stays a closed graph of its own. Bare
// specifiers (dependencies) are left alone. Safe to run more than once:
// a specifier that already ends in `.cjs` does not match.
//
// Bundling each entry instead would duplicate shared modules per
// entry, which is the same class-identity bug in another form.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const REQUIRE = /(require\(\s*["'])(\.{1,2}\/[^"']*)\.js(["']\s*\))/g

function walk (dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
        const p = join(dir, d.name)
        return d.isDirectory() ? walk(p) : [p]
    })
}

for (const file of walk(DIST).filter(f => f.endsWith('.cjs'))) {
    const ext = file.endsWith('.min.cjs') ? '.min.cjs' : '.cjs'
    const src = readFileSync(file, 'utf8')
    const out = src.replace(REQUIRE, `$1$2${ext}$3`)
    if (out !== src) writeFileSync(file, out)
}

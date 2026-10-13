// Copy every dist/**/*.d.ts to a .d.cts beside it, so CJS consumers
// (node16/nodenext module resolution) get a declaration file matching
// each *.cjs file at every depth, fixing up the sourcemap
// reference/filename to match.
//
// Relative specifiers inside the declarations are rewritten from `.js`
// to `.cjs`, so a `.d.cts` resolves to its `.d.cts` siblings and the
// CommonJS type graph never reaches into the ESM one. Bare specifiers
// (dependencies) are left alone.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')

// `from './x.js'` and `import('./x.js')`, the two forms tsc emits.
const SPECIFIER = /((?:from\s+|import\(\s*)["'])(\.{1,2}\/[^"']*)\.js(["'])/g

function walk (dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
        const p = join(dir, d.name)
        return d.isDirectory() ? walk(p) : [p]
    })
}

const files = walk(distDir).filter(f => f.endsWith('.d.ts'))

for (const src of files) {
    const dir = dirname(src)
    const base = basename(src).slice(0, -'.d.ts'.length)

    let content = readFileSync(src, 'utf8')
    content = content.replace(SPECIFIER, '$1$2.cjs$3')
    content = content.replace(
        /\/\/# sourceMappingURL=.+\.d\.ts\.map/,
        `//# sourceMappingURL=${base}.d.cts.map`
    )
    writeFileSync(join(dir, `${base}.d.cts`), content)

    const mapFile = `${src}.map`
    if (existsSync(mapFile)) {
        const map = JSON.parse(readFileSync(mapFile, 'utf8'))
        map.file = `${base}.d.cts`
        writeFileSync(
            join(dir, `${base}.d.cts.map`),
            JSON.stringify(map)
        )
    }
}

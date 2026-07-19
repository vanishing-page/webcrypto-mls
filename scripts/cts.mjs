// Copy dist/*.d.ts to dist/*.d.cts so CJS consumers (node16/nodenext
// module resolution) get a declaration file matching each *.cjs file,
// fixing up the sourcemap reference/filename to match.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')

const files = readdirSync(distDir).filter(f => f.endsWith('.d.ts'))

for (const file of files) {
    const base = file.slice(0, -'.d.ts'.length)
    const src = join(distDir, file)

    let content = readFileSync(src, 'utf8')
    content = content.replace(
        /\/\/# sourceMappingURL=.+\.d\.ts\.map/,
        `//# sourceMappingURL=${base}.d.cts.map`
    )
    writeFileSync(join(distDir, `${base}.d.cts`), content)

    const mapFile = join(distDir, `${file}.map`)
    if (existsSync(mapFile)) {
        const map = JSON.parse(readFileSync(mapFile, 'utf8'))
        map.file = `${base}.d.cts`
        writeFileSync(
            join(distDir, `${base}.d.cts.map`),
            JSON.stringify(map)
        )
    }
}

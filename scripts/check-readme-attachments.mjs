// Verifies the README's "Encrypted attachments" section:
// 1. the section exists
// 2. every fenced code block in it comes from
//    example/attachment-end-to-end.ts, which the test suite runs, so
//    the published walkthrough cannot drift into pseudocode that no
//    longer compiles
// 3. the section links the example file and the attachments demo
// 4. the section obeys the house style the rest of the docs follow:
//    80 columns, no em dashes, no arrow characters
//
// Check 2 is the load-bearing one. Prose can say anything; code in a
// README is a promise that it runs. Pinning each block to a file that
// typechecks and is imported from test/unit.ts keeps that promise
// mechanical rather than a matter of review.
//
// A block is read as an optional prologue of import statements plus a
// body. The body has to be a verbatim excerpt. The prologue does not,
// because a reader wants the imports one snippet needs and the example
// groups them at the top of the file for the compiler; instead every
// name a prologue imports has to be imported from the same specifier
// in the example. So a snippet still cannot name an export that does
// not exist, or reach a subpath export through the package root.
import { readFileSync } from 'node:fs'

let failed = false
function fail (msg) {
    console.error('FAIL: ' + msg)
    failed = true
}

const README = 'README.md'
const EXAMPLE = 'example/attachment-end-to-end.ts'
const HEADING = '## Encrypted attachments'
const DEMO_LINK = 'example/attachments-demo.ts'

const readme = readFileSync(README, 'utf8')
const lines = readme.split('\n')

const start = lines.findIndex(l => l.trim() === HEADING)
if (start === -1) {
    fail(`${README} has no "${HEADING}" section`)
    process.exit(1)
}

// The section runs to the next heading of the same level or above.
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
    if ((/^#{1,2} /).test(lines[i])) {
        end = i
        break
    }
}
const section = lines.slice(start, end)

// Style. The section is checked on its own rather than the whole file
// so this gate reports on what it owns.
section.forEach((line, i) => {
    const at = `${README}:${start + i + 1}`
    if (line.length > 80) {
        fail(`${at} is ${line.length} columns, over 80`)
    }
    if (line.includes('—')) {
        fail(`${at} contains an em dash`)
    }
    if (line.includes('→')) {
        fail(`${at} contains an arrow character`)
    }
})

// Provenance. Collect the fenced blocks, then check each one against
// the example: body byte for byte, imported names by specifier.
const example = readFileSync(EXAMPLE, 'utf8')
const blocks = []
let open = null
for (const line of section) {
    if (open === null) {
        if (line.startsWith('```')) open = []
        continue
    }
    if (line.startsWith('```')) {
        blocks.push(open.join('\n'))
        open = null
        continue
    }
    open.push(line)
}
if (open !== null) fail(`${README} has an unclosed code fence`)

if (blocks.length === 0) {
    fail(`the "${HEADING}" section has no code blocks`)
}
// `import { a, type B } from 'x'`, over one line or several.
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g

/** specifier -> the names imported from it. */
function importedNames (source) {
    const byModule = new Map()
    for (const match of source.matchAll(IMPORT)) {
        const names = match[1]
            .split(',')
            .map(name => name.trim().replace(/^type\s+/, ''))
            .filter(Boolean)
        const already = byModule.get(match[2]) ?? new Set()
        for (const name of names) already.add(name)
        byModule.set(match[2], already)
    }
    return byModule
}

/** A block's leading import statements, and everything after them. */
function splitPrologue (block) {
    const leading = /^import\s*\{[^}]*\}\s*from\s*'[^']+'\n+/
    let rest = block.endsWith('\n') ? block : block + '\n'
    let prologue = ''
    for (;;) {
        const match = leading.exec(rest)
        if (match === null) break
        prologue += match[0]
        rest = rest.slice(match[0].length)
    }
    return { prologue, body: rest.replace(/\n+$/, '') }
}

const exampleImports = importedNames(example)

for (const block of blocks) {
    const { prologue, body } = splitPrologue(block)
    // Name the block by its first line of code. Every block opens with
    // imports now, so those make for identical error messages.
    const first = (body === '' ? block : body).split('\n')[0]

    for (const [module, names] of importedNames(prologue)) {
        const known = exampleImports.get(module)
        if (known === undefined) {
            fail(
                `a code block starting "${first}" imports from ` +
                `${module}, which ${EXAMPLE} does not import from`,
            )
            continue
        }
        for (const name of names) {
            if (!known.has(name)) {
                fail(
                    `a code block starting "${first}" imports ` +
                    `${name} from ${module}, which ${EXAMPLE} does ` +
                    'not',
                )
            }
        }
    }

    if (body !== '' && !example.includes(body)) {
        fail(
            `a code block starting "${first}" is not a verbatim ` +
            `excerpt of ${EXAMPLE}`,
        )
    }
}

// Links out: the file the code came from, and the running demo.
const body = section.join('\n')
for (const link of [EXAMPLE, DEMO_LINK]) {
    if (!body.includes(link)) {
        fail(`the "${HEADING}" section does not link ${link}`)
    }
}

if (failed) process.exit(1)
console.log(
    `README attachments section ok: ${blocks.length} code blocks, ` +
    `all from ${EXAMPLE}`,
)

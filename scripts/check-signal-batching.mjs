// Verifies the house rule on signal writes in the example app: when a
// handler writes two signals one after another, the pair has to be
// wrapped in `batch()`. An unbatched pair renders twice, and the
// intermediate render shows a state the app was never in -- a status
// line from the new action next to a `playing` flag from the old one.
//
// The scan is source-level because the rule is source-level. A render
// test can only observe the extra paint indirectly, and only for the
// pairs it happens to drive; this covers every pair in the file.
//
// What counts as a "sequential write" here: two assignments to signals
// declared in the same file, with nothing between them except
// whitespace, a semicolon or a comment. Anything else in the gap --
// an await, a call, a branch -- means the two renders are separated by
// work and batching them would change behaviour, so those are left
// alone.
//
// Comments are blanked (offsets preserved, so line numbers stay right)
// before matching, for the same reason as in
// check-attachment-invariants.mjs: the rule has to be describable in
// the source it governs.
import { readFileSync, readdirSync } from 'node:fs'

const SCAN_DIR = 'example'

let failed = false
function fail (msg) {
    console.error('FAIL: ' + msg)
    failed = true
}

function blankComments (src) {
    return src.replace(
        /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        m => m.replace(/[^\n]/g, ' '),
    )
}

function lineOf (src, at) {
    return src.slice(0, at).split('\n').length
}

// Walk forward from `from` until the statement that starts there ends:
// a `;` or a newline reached at nesting depth zero, outside any string
// or template. Template interpolation nests, so `${` pushes a level.
function statementEnd (src, from) {
    const stack = []
    let quote = null
    for (let i = from; i < src.length; i++) {
        const ch = src[i]
        if (quote) {
            if (ch === '\\') {
                i++
            } else if (ch === quote) {
                quote = null
            } else if (quote === '`' && ch === '$' && src[i + 1] === '{') {
                stack.push('`')
                quote = null
                i++
            }
            continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch
        } else if (ch === '(' || ch === '[' || ch === '{') {
            stack.push(ch)
        } else if (ch === ')' || ch === ']') {
            stack.pop()
        } else if (ch === '}') {
            const open = stack.pop()
            if (open === '`') quote = '`'
        } else if (stack.length === 0 && (ch === ';' || ch === '\n')) {
            return ch === ';' ? i + 1 : i
        }
    }
    return src.length
}

// The half-open source region covered by each `batch(...)` call.
function batchRegions (src) {
    const regions = []
    const call = /\bbatch\s*\(/g
    let m
    while ((m = call.exec(src)) !== null) {
        const open = m.index + m[0].length - 1
        regions.push([open, statementEnd(src, open)])
    }
    return regions
}

function signalNames (src) {
    const names = new Set()
    const decl = new RegExp(
        '\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*' +
        '(?::[^=\\n]*)?=\\s*(?:useSignal|signal)\\s*[<(]',
        'g',
    )
    let m
    while ((m = decl.exec(src)) !== null) names.add(m[1])
    return [...names]
}

const files = readdirSync(SCAN_DIR, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.ts'))
    .sort()

for (const file of files) {
    const path = `${SCAN_DIR}/${file}`
    const src = blankComments(readFileSync(path, 'utf8'))
    const names = signalNames(src)
    if (names.length === 0) continue

    const write = new RegExp(
        `\\b(?:${names.join('|')})\\.value\\s*(?:[+\\-*/|&]{0,2})=(?!=)`,
        'g',
    )
    const regions = batchRegions(src)
    const writes = []
    let m
    while ((m = write.exec(src)) !== null) {
        writes.push({
            start: m.index,
            end: statementEnd(src, m.index + m[0].length),
            batched: regions.some(([a, b]) => m.index > a && m.index < b),
        })
    }

    for (let i = 1; i < writes.length; i++) {
        const prev = writes[i - 1]
        const cur = writes[i]
        if (prev.batched || cur.batched) continue
        if (!/^;?\s*$/.test(src.slice(prev.end, cur.start))) continue
        fail(
            `${path}:${lineOf(src, prev.start)} writes two signals in a ` +
            `row (next at line ${lineOf(src, cur.start)}) without batch()`,
        )
    }
}

if (failed) process.exit(1)
console.log('example signal writes are batched')

// Checks the two mechanical house-style rules from CLAUDE.md over the
// work this branch did: no line over 80 columns, and no em dash or
// arrow character. Both are checked by command rather than by reading,
// because a sweep done by eye is only as good as the pass that did it
// and nothing stops the next commit from undoing it.
//
// The character rule runs over the whole of every changed file. There
// is no cost to it: em dashes and arrows are rare enough that the
// pre-existing text already satisfies the rule, so nothing is grandfathered
// in.
//
// The length rule has two scopes, because the branch touched files it
// did not write:
//
//   Added lines. Every line this branch adds to any changed file has to
//   fit. Lines that were already in the file before the branch are left
//   alone -- reflowing 170 pre-existing lines of `src/client-state.ts`
//   because a rename touched the file is churn, not a style sweep, and
//   it buries the branch's real diff.
//
//   Whole files. The files this branch owns outright fit end to end,
//   pre-existing lines included. That list is WHOLE_FILE below.
//
// Exemptions, for lines that cannot be wrapped rather than lines that
// are inconvenient to wrap:
//
//   A line carrying a URL. Badges, spec links and MDN references are a
//   single unbreakable token; splitting one breaks the link.
//
//   A line with no break point. A bare file path or a long identifier
//   is one token; if the indent plus the longest token already passes
//   80, no wrapping brings the line under it.
//
//   A markdown table row. A cell cannot contain a newline, so the row
//   is as short as its widest cell allows.
//
//   A fenced code block in markdown. The content is quoted verbatim
//   from a real file, command line or transcript, and rewrapping it
//   makes the quote wrong.
//
//   The generated table of contents. `npm run toc` rewrites the region
//   between the `toc` and `tocstop` markers from the heading text, so
//   editing it by hand does not survive the next release.
//
// SELF_EXEMPT is the set of files that contain an em dash or an arrow
// as data -- the checkers that look for them.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MAX_COLUMNS = 80

// The files this branch owns, checked end to end.
const WHOLE_FILE = [
    'README.md',
    'docs/adr/INDEX.md',
    'docs/fdr/INDEX.md',
    'docs/security-audit.md',
    'src/key-schedule.ts',
    'test/attachment/seal-core.ts',
    'example/attachments-demo.ts',
    'docs/implementation-plans/2026-08-19-random-access-attachments' +
        '/test-requirements.md',
    'docs/implementation-plans/2026-08-20-random-access-attachments-fixes' +
        '/test-requirements.md',
    'docs/test-plans/2026-08-19-random-access-attachments.md',
    'docs/test-plans/2026-08-20-random-access-attachments-fixes.md'
]

// Checkers that carry the forbidden characters as their own subject
// matter. Exempt from the character rule only, not the length rule.
const SELF_EXEMPT = [
    'scripts/check-readme-attachments.mjs',
    'scripts/check-house-style.mjs'
]

// Text this branch is responsible for. Lock files, vendored manifests
// and generated output are not hand-written prose or code.
const CHECKED_EXTENSIONS = /\.(ts|md|css|mjs|swift|sh|yml)$/

const EM_DASH = '—'
const ARROWS = /[←→⇐⇒]/

const base = process.argv[2] || 'main'
const failures = []

function fail (file, lineNumber, message) {
    failures.push(`${file}:${lineNumber}: ${message}`)
}

function git (...args) {
    // The branch diff runs to several megabytes, well past the 1 MiB
    // default, and overflowing it fails as ENOBUFS rather than as a
    // short read.
    return execFileSync('git', args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
    })
}

// Line numbers in `file` that the length rule does not apply to. Read
// from the working tree, so a number from a diff against the working
// tree lines up with it.
function unwrappableLines (file, lines) {
    const markdown = file.endsWith('.md')
    const exempt = new Set()
    let inToc = false
    let inFence = false
    lines.forEach((line, i) => {
        if (line.includes('<!-- toc -->')) inToc = true
        if (inToc) exempt.add(i + 1)
        if (line.includes('<!-- tocstop -->')) inToc = false
        if (markdown && (/^[ \t]*```/).test(line)) {
            exempt.add(i + 1)
            inFence = !inFence
        } else if (markdown && inFence) {
            exempt.add(i + 1)
        }
        if ((/https?:\/\//).test(line)) exempt.add(i + 1)
        if ((/^[ \t]*\|/).test(line)) exempt.add(i + 1)
        const indent = line.length - line.trimStart().length
        const longest = line.trim().split(/\s+/)
            .reduce((n, token) => Math.max(n, token.length), 0)
        if (indent + longest > MAX_COLUMNS) exempt.add(i + 1)
    })
    return exempt
}

function readLines (file) {
    return readFileSync(file, 'utf8').split('\n')
}

function checkCharacters (file, lineNumber, line) {
    if (SELF_EXEMPT.includes(file)) return
    if (line.includes(EM_DASH)) {
        fail(file, lineNumber, 'contains an em dash')
    }
    if (ARROWS.test(line)) {
        fail(file, lineNumber, 'contains an arrow character')
    }
}

function checkLength (file, lineNumber, line, exempt) {
    if (exempt.has(lineNumber)) return
    if (line.length > MAX_COLUMNS) {
        fail(file, lineNumber, `is ${line.length} columns, over ${MAX_COLUMNS}`)
    }
}

// Every file the branch added, copied, modified or renamed. Deletions
// are excluded: there is nothing left to read.
const changed = git(
    'diff', '--name-only', '--diff-filter=ACMR', base
).split('\n').filter(f => CHECKED_EXTENSIONS.test(f))

// The character rule, over every line of every changed file.
for (const file of changed) {
    readLines(file).forEach((line, i) => checkCharacters(file, i + 1, line))
}

// Length, scope one: the whole of the files the branch owns.
const wholeFile = new Set()
for (const file of WHOLE_FILE) {
    if (!changed.includes(file)) {
        failures.push(
            `${file}: listed in WHOLE_FILE but not changed against ` +
            `${base}; update the list`
        )
        continue
    }
    wholeFile.add(file)
    const lines = readLines(file)
    const exempt = unwrappableLines(file, lines)
    lines.forEach((line, i) => checkLength(file, i + 1, line, exempt))
}

// Length, scope two: the lines the branch added to everything else. `-U0`
// gives no context lines, so every `+` is a real addition, and the
// hunk header's new-side start counts them off against the working
// tree.
const rest = changed.filter(f => !wholeFile.has(f))
if (rest.length > 0) {
    const diff = git('diff', '--diff-filter=ACMR', '-U0', base, '--', ...rest)
    let file = null
    let exempt = new Set()
    let lineNumber = 0
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) {
            file = line.slice('+++ b/'.length)
            exempt = unwrappableLines(file, readLines(file))
            continue
        }
        const hunk = (/^@@ -\S+ \+(\d+)/).exec(line)
        if (hunk !== null) {
            lineNumber = Number(hunk[1])
            continue
        }
        if (!line.startsWith('+') || file === null) continue
        checkLength(file, lineNumber, line.slice(1), exempt)
        lineNumber++
    }
}

if (failures.length > 0) {
    console.error(`house style: ${failures.length} violation(s)`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
}

console.log(
    `house style: ok (${wholeFile.size} file(s) end to end, ` +
    `added lines in ${rest.length} other(s))`
)

// Checks that AUDIT-ra.md's resolution table accounts for every finding
// the audit made. The branch's merge condition is "all of AUDIT-ra.md is
// closed", and a condition stated only in prose is a condition nobody
// can check. This turns it into a command.
//
// The table is not the source of truth for what the audit found -- the
// audit body is. So the finding list is derived from the body on every
// run and the table is checked against it, in both directions:
//
//   Every finding has a row. A finding the table forgets is a finding
//   that quietly shipped unresolved.
//
//   Every row has a finding. A row whose id matches nothing is a stale
//   claim of closure, which is worse than no claim at all.
//
// Two kinds of finding id, both derived rather than listed here:
//
//   `<section>.<n>` for a numbered item, e.g. `1.4`. Sections 1 to 3
//   each number their items in one continuous run, so the pair is
//   unique. Section 4 is the audit's suggested order of work, not a
//   finding list, so it is skipped.
//
//   `<section>.<heading>` for a `###` subsection that carries findings
//   as bullets or prose instead of a numbered list, e.g. `2.CI`. The
//   heading is used verbatim: it is already unique within the document
//   and a slug would only add a rule to get wrong.
//
// The resolution column says how the finding was closed. Three forms:
//
//   One or more `US-0NN` ids, comma separated. The stories that closed
//   it. This is the ordinary case.
//
//   `OPEN: <reason>`. Deliberately left open, with the reason written
//   down. The PRD allows this; it does not allow silence.
//
//   `NO ACTION: <reason>`. The audit recorded something that needed no
//   change, such as its "Sound, for the record" section.
import { readFileSync } from 'node:fs'

const AUDIT = 'AUDIT-ra.md'
const TABLE_HEADING = '## 5. Resolution'

let failed = false
function fail (msg) {
    console.error('FAIL: ' + msg)
    failed = true
}

const lines = readFileSync(AUDIT, 'utf8').split('\n')

// ---------------------------------------------------------------------
// Derive the finding ids from the audit body.
// ---------------------------------------------------------------------

/** @type {string[]} */
const findings = []
let section = null
let heading = null
let headingHadNumbered = false

function closeHeading () {
    if (section === null || heading === null) return
    if (!headingHadNumbered) findings.push(section + '.' + heading)
}

for (const line of lines) {
    const top = line.match(/^## (\d+)\. /)
    if (top) {
        closeHeading()
        heading = null
        headingHadNumbered = false
        section = Number(top[1]) <= 3 ? top[1] : null
        continue
    }
    if ((/^## /).test(line)) {
        closeHeading()
        section = null
        heading = null
        headingHadNumbered = false
        continue
    }
    if (section === null) continue

    const sub = line.match(/^### (.+)$/)
    if (sub) {
        closeHeading()
        heading = sub[1].trim()
        headingHadNumbered = false
        continue
    }

    const numbered = line.match(/^(\d+)\. /)
    if (numbered) {
        headingHadNumbered = true
        findings.push(section + '.' + numbered[1])
    }
}
closeHeading()

if (findings.length === 0) {
    fail(`${AUDIT}: no findings parsed; the parser or the document moved`)
    process.exit(1)
}

const duplicates = findings.filter((id, i) => findings.indexOf(id) !== i)
if (duplicates.length > 0) {
    fail(`${AUDIT}: finding ids are not unique: ${duplicates.join(', ')}`)
}

// ---------------------------------------------------------------------
// Read the resolution table.
// ---------------------------------------------------------------------

const start = lines.findIndex(l => l.trim() === TABLE_HEADING)
if (start === -1) {
    fail(`${AUDIT} has no "${TABLE_HEADING}" section`)
    process.exit(1)
}

/** @type {Map<string, string>} */
const rows = new Map()
for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if ((/^## /).test(line)) break
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 3) {
        fail(`${AUDIT}:${i + 1}: table row needs three cells`)
        continue
    }
    const [id, resolution] = cells
    // Skip the header row and its separator.
    if (id === 'Item' || (/^-+$/).test(id)) continue
    if (rows.has(id)) fail(`${AUDIT}:${i + 1}: duplicate row for "${id}"`)
    rows.set(id, resolution)
}

const STORIES = /^US-\d{3}(, US-\d{3})*$/

for (const id of findings) {
    if (!rows.has(id)) {
        fail(`${AUDIT}: finding "${id}" has no row in the resolution table`)
        continue
    }
    const resolution = rows.get(id)
    const open = resolution.startsWith('OPEN:')
    const none = resolution.startsWith('NO ACTION:')
    if (open || none) {
        const reason = resolution.slice(resolution.indexOf(':') + 1).trim()
        if (reason.length === 0) {
            fail(`${AUDIT}: finding "${id}" is ${open ? 'open' : 'no-action'}` +
                ' with no reason written down')
        }
        continue
    }
    if (!STORIES.test(resolution)) {
        fail(`${AUDIT}: finding "${id}" resolution "${resolution}" is not a` +
            ' US-0NN list, an "OPEN:" reason or a "NO ACTION:" reason')
    }
}

for (const id of rows.keys()) {
    if (!findings.includes(id)) {
        fail(`${AUDIT}: resolution row "${id}" matches no finding in the` +
            ' audit body')
    }
}

if (failed) {
    console.error(`\n${AUDIT} resolution table is incomplete.`)
    process.exit(1)
}

console.log(
    `ok - ${AUDIT}: all ${findings.length} findings have a resolution`
)

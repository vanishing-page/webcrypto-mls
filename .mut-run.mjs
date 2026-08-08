// Mutation harness for US-021. One [file, name, from, to] per mutation:
// copy the file aside, apply exactly one replacement, confirm it landed,
// rebuild the fast bundle, run it, restore by file copy.
//
// A kill is scored on ANY of three signals -- failures, a non-zero exit,
// or an assertion count below the baseline -- because a mutation that
// makes a test throw aborts the tap run with no `not ok` line at all.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const BUNDLE = ['./.mut-index.ts', '--bundle', '--platform=node',
    '--format=cjs', '--loader:.json=json', '--keep-names',
    '--outfile=.mut-bundle.cjs']

function run () {
    try {
        execFileSync('npx', ['esbuild', ...BUNDLE], { stdio: 'pipe' })
    } catch (err) {
        return { failures: 1, exit: 1, count: 0, note: 'bundle failed' }
    }

    let out = ''
    let exit = 0
    try {
        out = execFileSync('node', ['.mut-bundle.cjs'], {
            stdio: 'pipe', maxBuffer: 64 * 1024 * 1024
        }).toString()
    } catch (err) {
        out = (err.stdout ?? '').toString()
        exit = err.status ?? 1
    }

    const failures = (out.match(/^not ok /gm) ?? []).length
    const counts = out.match(/^# (?:pass|tests)\s+(\d+)$/gm) ?? []
    const count = counts.length ?
        Math.max(...counts.map(l => Number(l.split(/\s+/)[2]))) :
        0

    return { failures, exit, count }
}

const baseline = run()
console.log('baseline', JSON.stringify(baseline))

const mutations = JSON.parse(readFileSync(process.argv[2], 'utf8'))

for (const [file, name, from, to] of mutations) {
    const good = readFileSync(file, 'utf8')
    copyFileSync(file, '/tmp/MUT-GOOD')

    if (!good.includes(from)) {
        console.log(`SKIP  ${name} -- pattern did not match`)
        continue
    }

    writeFileSync(file, good.replace(from, to))

    let applied = true
    try {
        execFileSync('diff', ['-q', '/tmp/MUT-GOOD', file], { stdio: 'pipe' })
        applied = false
    } catch {
        applied = true
    }

    if (!applied) {
        copyFileSync('/tmp/MUT-GOOD', file)
        console.log(`SKIP  ${name} -- replacement was a no-op`)
        continue
    }

    const res = run()
    copyFileSync('/tmp/MUT-GOOD', file)

    const killed = res.failures > 0 ||
        res.exit !== 0 ||
        res.count < baseline.count

    console.log(
        `${killed ? 'KILL ' : 'ALIVE'} ${name} -- ` +
        `failures=${res.failures} exit=${res.exit} count=${res.count}`
    )
}

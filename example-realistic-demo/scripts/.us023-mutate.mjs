#!/usr/bin/env node

/**
 * Mutation harness for probe checks. Kept, like the root `.mut-run.mjs`
 * it is the Worker-side counterpart of: the list below is US-023's
 * evidence, and the next probe check to be proved load bearing should
 * extend it rather than start again.
 *
 * Each entry is [name, file, from, to, expected failing check]. The
 * mutation is applied, confirmed with `diff -q`, the worker restarted,
 * the probe run, and the file restored by copy -- never by
 * `git checkout --`, which would take uncommitted work with it.
 *
 * A mutation that stops the worker starting scores a kill too: the check
 * cannot pass against a room that is not there.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repo = '/Users/nick/code/webcrypto-mls'

const MUTATIONS = [
  [
    'check 21: the second create is allowed through',
    'example-realistic-demo/index.ts',
    "        if (this.readMeta()) {\n" +
      "            return this.send(ws, { type: 'error', reason: 'room-exists' })\n" +
      '        }',
    '        // guard deleted by the US-023 mutation harness',
    21
  ],
  [
    'check 22: a room with no metadata answers room-state anyway',
    'example-realistic-demo/index.ts',
    "        const meta = this.readMeta()\n" +
      '        if (!meta) {\n' +
      "            return this.send(ws, { type: 'no-room' })\n" +
      '        }',
    "        const meta = this.readMeta() ?? {\n" +
      '            created_at: 0,\n' +
      '            expires_at: 0,\n' +
      "            creator_identity: '',\n" +
      "            creator_token: ''\n" +
      '        }',
    22
  ],
  [
    'check 23: the SPA fallback is dropped',
    'example-realistic-demo/wrangler.jsonc',
    '"not_found_handling": "single-page-application"',
    '"not_found_handling": "none"',
    23
  ],
  [
    'check 23: run_worker_first no longer protects /api',
    'example-realistic-demo/wrangler.jsonc',
    '"run_worker_first": ["/api/*"]',
    '"run_worker_first": ["/nothing/*"]',
    23
  ]
]

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForWorker (deadlineMs) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const res = await fetch('http://localhost:8787/api/health')
      if (res.status === 200) return true
    } catch {
      // not up yet
    }
    await sleep(300)
  }
  return false
}

function startWorker () {
  const out = fs.openSync('/tmp/mut-worker.txt', 'w')
  const child = spawn(
    'npm',
    ['run', 'worker:realistic'],
    { cwd: repo, stdio: ['ignore', out, out], detached: true }
  )
  child.unref()
  return child
}

function stopWorker () {
  for (const pat of [
    `${repo}/node_modules/@cloudflare/workerd`,
    `${repo}/node_modules/wrangler`
  ]) {
    try {
      execFileSync('pkill', ['-f', pat])
    } catch {
      // nothing matched
    }
  }
}

function runProbe () {
  try {
    const out = execFileSync(
      'node',
      ['example-realistic-demo/scripts/probe.mjs'],
      { cwd: repo, encoding: 'utf8' }
    )
    return { exit: 0, out }
  } catch (err) {
    return { exit: err.status ?? 1, out: err.stdout ?? '' }
  }
}

let killed = 0
let survived = 0

for (const [name, rel, from, to, target] of MUTATIONS) {
  const file = path.join(repo, rel)
  const backup = `${file}.us023bak`
  fs.copyFileSync(file, backup)

  const original = fs.readFileSync(file, 'utf8')
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} -- pattern did not match`)
    fs.rmSync(backup)
    continue
  }

  fs.writeFileSync(file, original.replace(from, to))

  try {
    execFileSync('diff', ['-q', file, backup])
    console.log(`SKIP  ${name} -- diff -q says the file is unchanged`)
    fs.copyFileSync(backup, file)
    fs.rmSync(backup)
    continue
  } catch {
    // diff exits non-zero, which is what "the mutation landed" means
  }

  stopWorker()
  await sleep(500)
  startWorker()
  const up = await waitForWorker(30000)

  let verdict
  if (!up) {
    verdict = 'KILL (the worker would not start)'
    killed++
  } else {
    const { exit, out } = runProbe()
    const line = out
      .split('\n')
      .find(l => l.startsWith(`Check ${target}:`)) ?? '(no line)'
    const failedTarget = line.includes('FAIL')
    if (failedTarget) {
      verdict = `KILL by check ${target}`
      killed++
    } else if (exit !== 0) {
      const others = out
        .split('\n')
        .filter(l => l.includes('FAIL'))
        .join('; ')
      verdict = `KILL, but by another check: ${others}`
      killed++
    } else {
      verdict = 'SURVIVED'
      survived++
    }
    console.log(`      ${line.trim()}`)
  }

  console.log(`${verdict}  ${name}`)

  fs.copyFileSync(backup, file)
  fs.rmSync(backup)
  stopWorker()
  await sleep(500)
}

startWorker()
await waitForWorker(30000)

console.log('')
console.log(`Mutations: ${killed} killed, ${survived} survived`)
process.exit(survived > 0 ? 1 : 0)

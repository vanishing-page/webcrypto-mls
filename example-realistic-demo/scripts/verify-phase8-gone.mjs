#!/usr/bin/env node

/**
 * Phase 8 Task 5b: the gone view and the explainer, in real browsers.
 *
 * Only the half of Task 5 that this story built. Chat and the persist
 * toggle are `verify-phase8-chat.mjs`; the whole Task 6 sweep is its own
 * story.
 *
 * Every client is its own Chromium profile -- a separate user data
 * directory -- for the same reason the chat harness uses them: a shared
 * profile shares the stored session, and a second tab of one browser is
 * the same client rather than a second person.
 *
 * Needs both dev servers already running:
 *
 *   npm run worker:realistic      # wrangler, :8787
 *   npm run dev:realistic   # vite, :1234 (proxies /api to the Worker)
 *
 * Usage: node example-realistic-demo/scripts/verify-phase8-gone.mjs [origin]
 */

import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] || 'http://localhost:1234'

// Shared selectors. Both target the control the component renders
// rather than the host, which is what the other harnesses do too.
const SETUP_NAME_FIELD = 'form.setup-form substrate-input input'
const SETUP_SUBMIT_BTN = 'form.setup-form substrate-button[type=submit] button'

let passCount = 0
let failCount = 0
const profiles = []

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

async function check (name, fn) {
  try {
    await fn()
    console.log(`PASS - ${name}`)
    passCount++
  } catch (err) {
    console.log(`FAIL - ${name}`)
    console.log(`  Error: ${err.message}`)
    failCount++
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor (label, predicate, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await sleep(100)
  }
}

async function openProfile (name) {
  const dir = mkdtempSync(join(tmpdir(), `mls-gone-${name}-`))
  const context = await chromium.launchPersistentContext(dir, {
    headless: true
  })

  const pages = context.pages()
  const page = pages.length > 0 ? pages[0] : await context.newPage()
  const profile = { name, dir, context, page, errors: [], notFound: [] }

  page.on('response', res => {
    if (res.status() === 404) profile.notFound.push(res.url())
  })

  page.on('console', msg => {
    if (msg.type() === 'error') profile.errors.push(msg.text())
  })
  page.on('pageerror', err => {
    profile.errors.push(`pageerror: ${err.message}`)
  })

  profiles.push(profile)
  return profile
}

/**
 * Vite's dev client logs a websocket failure of its own when the page
 * navigates; it says nothing about this demo.
 *
 * The probe's 404 is dropped as well -- it is the answer the first check
 * is about, and the browser logs every 404 to the console whatever the
 * page does with it. Dropping it blind would hide a missing asset, so
 * the check below asserts separately that every 404 this profile saw
 * was a room probe.
 */
function realErrors (profile) {
  return profile.errors.filter(text => {
    if (/vite/i.test(text)) return false
    return !/status of 404/.test(text)
  })
}

function has (page, selector) {
  return page.locator(selector).count().then(n => n > 0)
}

function count (page, selector) {
  return page.locator(selector).count()
}

async function textOf (page, selector) {
  return (await page.locator(selector).first().innerText()).trim()
}

// --- the runs ---------------------------------------------------------

const visitor = await openProfile('visitor')
const creator = await openProfile('creator')

// realistic-demo.AC8.4 -- an id that leads nowhere

await check('an id with no room behind it renders the gone view', async () => {
  // Ten characters, the room id length, so this is a well-formed id the
  // route accepts -- not a path the router rejects for its shape.
  await visitor.page.goto(`${origin}/zzzzzzzzzz`)
  await waitFor('the gone view', () => has(visitor.page, 'section.gone'))

  assert(
    !(await has(visitor.page, 'section.setup')),
    'the setup form should not also be on the page'
  )
  assert(
    !(await has(visitor.page, 'section.room')),
    'and neither should a room'
  )
})

await check('the gone view says both cases, in one place', async () => {
  assert(
    (await count(visitor.page, '.gone .gone-disclosure')) === 1,
    'expected exactly one disclosure'
  )

  const text = await textOf(visitor.page, '.gone .gone-disclosure')
  assert(/expired/i.test(text), 'it should raise expiry as one case')
  assert(
    /never/i.test(text) || /no room/i.test(text),
    'and never having existed as the other'
  )
})

await check('the gone view offers a way back to a new room', async () => {
  await visitor.page.click('.gone .create-new')
  await waitFor('the setup form', () => has(visitor.page, 'section.setup'))

  assert(
    !(await has(visitor.page, 'section.gone')),
    'the gone view should be replaced, not stacked under the form'
  )
  assert(
    new URL(visitor.page.url()).pathname === '/',
    `the dead room id should be out of the URL, got ${visitor.page.url()}`
  )
})

// realistic-demo.AC10.6 -- the explainer

await check('the explainer stands beside the setup form', async () => {
  for (const cls of ['intro', 'guarantee-disclosure', 'trust-disclosure']) {
    assert(
      (await count(visitor.page, `.explainer .${cls}`)) === 1,
      `expected one .${cls}`
    )
  }

  assert(
    (await count(visitor.page, '.explainer .instructions li')) >= 3,
    'the how-to card should list the steps'
  )
})

await check('the explainer separates guarantee from trust', async () => {
  const guarantee = await textOf(
    visitor.page,
    '.explainer .guarantee-disclosure'
  )
  const trust = await textOf(visitor.page, '.explainer .trust-disclosure')

  assert(
    /cannot read/i.test(guarantee),
    'the guarantee should say the server cannot read a message'
  )
  assert(
    /order/i.test(trust),
    'the trust half should name the ordering the server is trusted for'
  )
  assert(guarantee !== trust, 'they should not be the same paragraph')
})

await check('no expiry is claimed before a room has given one', async () => {
  assert(
    (await count(visitor.page, '.explainer .expiry')) === 0,
    'nothing on the setup page knows when any room expires'
  )
})

// The expiry is the room's answer, so it needs a real room. The creator
// profile makes one; `data-expires` is the number the room sent, which
// is what the page must be showing rather than one it worked out.

await check('a real room puts its own expiry on the page', async () => {
  await creator.page.goto(origin)
  await creator.page.fill(SETUP_NAME_FIELD, 'Ada')
  await creator.page.click(SETUP_SUBMIT_BTN)

  await waitFor('the room view', () => has(creator.page, 'section.room'))
  await waitFor('the expiry', () => has(creator.page, '.explainer .expiry'))

  const shown = await creator.page.getAttribute(
    '.explainer .expiry',
    'data-expires'
  )

  const roomId = new URL(creator.page.url()).pathname.slice(1)
  const res = await fetch(`${origin}/api/room/${roomId}`)
  const info = await res.json()

  assert(
    Number(shown) === info.expiresAt,
    `page shows ${shown}, the room says ${info.expiresAt}`
  )
  assert(
    info.expiresAt > Date.now(),
    'and the moment it names should still be ahead'
  )
})

await check('the explainer is on the room view too', async () => {
  for (const cls of ['intro', 'guarantee-disclosure', 'trust-disclosure']) {
    assert(
      (await count(creator.page, `.explainer .${cls}`)) === 1,
      `expected one .${cls} beside the room`
    )
  }
})

// realistic-demo.AC7.1 -- the waiting copy follows the preference

await check('the waiting disclosure follows the persist toggle', async () => {
  const roomId = new URL(creator.page.url()).pathname.slice(1)

  await visitor.page.goto(`${origin}/${roomId}`)
  await waitFor('the join form', () => has(visitor.page, '.setup-form'))
  await visitor.page.fill(SETUP_NAME_FIELD, 'Grace')
  await visitor.page.click(SETUP_SUBMIT_BTN)

  await waitFor('the waiting view', () => has(visitor.page, 'section.waiting'))

  const off = await visitor.page.getAttribute(
    '.waiting .disclosure',
    'data-persist'
  )
  assert(off === 'false', `expected data-persist false, got ${off}`)
  const keepTab = await textOf(visitor.page, '.waiting .disclosure')
  assert(
    /keep the tab open/i.test(keepTab),
    'with nothing stored it should say to keep the tab open'
  )

  await visitor.page.click('.persistence .persist-toggle input')
  await waitFor('the disclosure to change', async () => {
    const on = await visitor.page.getAttribute(
      '.waiting .disclosure',
      'data-persist'
    )
    return on === 'true'
  })

  const kept = await textOf(visitor.page, '.waiting .disclosure')
  assert(
    !/keep the tab open/i.test(kept),
    'with the session kept it must not still say to keep the tab open'
  )
})

await check('neither page logged an error', async () => {
  for (const profile of profiles) {
    const errors = realErrors(profile)
    assert(
      errors.length === 0,
      `${profile.name} logged: ${errors.join(' | ')}`
    )

    const stray = profile.notFound.filter(url => {
      return !/\/api\/room\//.test(url)
    })
    assert(
      stray.length === 0,
      `${profile.name} got a 404 for ${stray.join(' | ')}`
    )
  }

  // And the one the gone view is about did happen, so the filter above
  // is not quietly covering for a probe that never ran.
  assert(
    visitor.notFound.some(url => /\/api\/room\/zzzzzzzzzz/.test(url)),
    'the visitor should have probed the dead room and been refused'
  )
})

for (const profile of profiles) {
  await profile.context.close()
  rmSync(profile.dir, { recursive: true, force: true })
}

console.log('')
console.log(`${passCount} passed, ${failCount} failed`)

process.exit(failCount === 0 ? 0 : 1)

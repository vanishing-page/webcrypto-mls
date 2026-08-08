#!/usr/bin/env node

/**
 * Phase 8 Task 6: the end-to-end sweep, in real browser profiles.
 *
 * This script covers the Task 6 steps that the two Task 5 harnesses do
 * not. Run all three; they are complementary, not alternatives:
 *
 *   verify-phase8-chat.mjs   steps 2, 3 and most of 7
 *   verify-phase8-gone.mjs   steps 9 and 10
 *   this script              steps 4, 5, 6, 7.5, and 8
 *
 * Every client is its own Chromium profile -- a separate user data
 * directory. A second tab of one browser shares the database, so it is
 * the same client coming back rather than a second person, and every
 * persistence check here would pass for the wrong reason.
 *
 * Needs both dev servers already running:
 *
 *   npm run worker:realistic      # wrangler, :8787
 *   npm run dev:realistic   # vite, :1234 (proxies /api to the Worker)
 *
 * Usage: node example-realistic-demo/scripts/verify-phase8-e2e.mjs [origin]
 */

import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] || 'http://localhost:1234'

// Shared selectors
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

async function waitFor (label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await sleep(100)
  }
}

// --- profiles ---------------------------------------------------------

async function openProfile (name) {
  const dir = mkdtempSync(join(tmpdir(), `mls-e2e-${name}-`))
  const context = await chromium.launchPersistentContext(dir, {
    headless: true
  })

  const profile = { name, dir, context, page: null, frames: [], errors: [] }
  profiles.push(profile)
  await newTab(profile)
  return profile
}

/**
 * A fresh tab in an existing profile. The profile's storage survives,
 * which is what makes "close the tab and come back" a returning client
 * rather than a new one -- and before Phase 8 it was not: nothing
 * persisted, so the next visit generated a new signature key. Every
 * check below that closes a tab turns persistence on first, or it would
 * be testing a stranger.
 */
async function newTab (profile) {
  const existing = profile.context.pages()
  const page = existing.length > 0 && profile.page === null ?
    existing[0] :
    await profile.context.newPage()

  page.on('websocket', socket => {
    socket.on('framesent', frame => record(profile, 'sent', frame))
    socket.on('framereceived', frame => record(profile, 'recv', frame))
  })

  page.on('console', msg => {
    if (msg.type() === 'error') profile.errors.push(msg.text())
  })
  page.on('pageerror', err => {
    profile.errors.push(`pageerror: ${err.message}`)
  })

  profile.page = page
  return page
}

function record (profile, dir, frame) {
  const text = typeof frame.payload === 'string' ?
    frame.payload :
    frame.payload.toString('utf8')

  if (text === 'ping' || text === 'pong') return

  let msg = null
  try {
    msg = JSON.parse(text)
  } catch (_err) {
    msg = null
  }

  profile.frames.push({ dir, text, msg })
}

function sent (profile, type, from = 0) {
  return profile.frames
    .slice(from)
    .filter(f => f.dir === 'sent' && f.msg?.type === type)
}

// --- page readers -----------------------------------------------------

function has (page, selector) {
  return page.locator(selector).count().then(n => n > 0)
}

async function textOf (page, selector) {
  return (await page.locator(selector).first().innerText()).trim()
}

async function epochOf (page) {
  return Number(await textOf(page, 'section.room .epoch'))
}

/** The timeline as rows: text, outbound and placeholder alike. */
function timelineOf (page) {
  return page.$$eval('section.room ul.timeline li', els => {
    return els.map(el => ({
      kind: el.classList.contains('message') ?
        'text' :
        el.classList.contains('outbound-message') ? 'outbound' : 'placeholder',
      from: el.querySelector('.message-from')?.textContent?.trim() ?? '',
      text: el.querySelector('.message-text')?.textContent?.trim() ?? '',
      seq: el.getAttribute('data-seq'),
      reason: el.getAttribute('data-reason'),
      count: el.getAttribute('data-count')
    }))
  })
}

async function createUser (profile, displayName) {
  await profile.page.fill(SETUP_NAME_FIELD, displayName)
  await profile.page.click(SETUP_SUBMIT_BTN)
}

async function say (profile, text) {
  await profile.page.fill('form.composer substrate-input.draft input', text)
  await profile.page.click('form.composer substrate-button.send button')
}

async function waitForRoom (profile) {
  await waitFor(
    `${profile.name} to reach the room`,
    () => has(profile.page, 'section.room')
  )
}

/**
 * Sending and then waiting for the room to number it. An outbound row is
 * a message the room has not written to the log yet; a check that
 * counted or ordered rows while one was pending would be comparing two
 * different moments.
 */
async function sayAndSettle (profile, text) {
  await say(profile, text)
  await waitFor(`${profile.name}'s message to be numbered`, async () => {
    const rows = await timelineOf(profile.page)
    return rows.some(r => r.kind === 'text' && r.text === text)
  })
}

async function approveNamed (creator, displayName) {
  await waitFor(`${displayName}'s request`, async () => {
    const rows = creator.page
      .locator('section.room ul.pending li.request')
      .filter({ hasText: displayName })
    return (await rows.count()) > 0
  })

  const row = creator.page
    .locator('section.room ul.pending li.request')
    .filter({ hasText: displayName })
  await row.locator('substrate-button.approve').click()
}

async function removeNamed (creator, displayName) {
  const row = creator.page
    .locator('section.room ul.members li.member')
    .filter({ hasText: displayName })
  await row.locator('substrate-button.remove').click()
}

function memberNames (page) {
  return page.$$eval('section.room ul.members li.member .member-name', els => {
    // Only the cell's own text: the "You" marker is an element inside
    // it on this client's own row.
    return els.map(el => {
      return Array.from(el.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join('')
        .trim()
    })
  })
}

async function setPersist (profile, on) {
  const box = profile.page.locator('section.persistence input[type=checkbox]')
  if (await box.isChecked() !== on) await box.click()
}

/**
 * What this profile's own indexedDB holds for the realistic demo. The
 * connection is always closed again: a live one blocks the page's own
 * Delete control, so a reader that leaked one would be the reason the
 * check it is about to make fails.
 */
function storedSession (profile) {
  return profile.page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('mls-realistic-demo', 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        if (!db.objectStoreNames.contains('session')) {
          db.close()
          return resolve(null)
        }
        const tx = db.transaction('session', 'readonly')
        const req = tx.objectStore('session').get('current')
        tx.oncomplete = () => db.close()
        req.onsuccess = () => {
          const value = req.result
          if (!value) return resolve(null)
          resolve({
            name: value.name,
            roomId: value.roomId,
            cursor: value.cursor,
            creatorToken: value.creatorToken,
            hasKeyPackage: value.keyPackage !== undefined,
            hasPrivateKeys: value.privateKeys !== undefined,
            hasState: value.state !== undefined
          })
        }
        req.onerror = () => reject(req.error)
      }
    })
  })
}

function databaseNames (profile) {
  return profile.page.evaluate(async () => {
    const list = await indexedDB.databases()
    return list.map(d => d.name)
  })
}

/** A record in one of the two older demos' databases, made by hand. */
function seedOtherDemo (profile, dbName, storeName, key) {
  return profile.page.evaluate(({ dbName, storeName, key }) => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, 1)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).put({ name: key }, key)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, { dbName, storeName, key })
}

/** The keys in another demo's store, so "intact" can mean its records. */
function otherDemoKeys (profile, dbName, storeName) {
  return profile.page.evaluate(({ dbName, storeName }) => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, 1)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).getAllKeys()
        tx.oncomplete = () => db.close()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }
    })
  }, { dbName, storeName })
}

function realErrors (profile) {
  return profile.errors.filter(text => !/favicon/.test(text))
}

// --- the run ----------------------------------------------------------

console.log(`Origin: ${origin}`)
console.log('')

const alice = await openProfile('alice')
const bob = await openProfile('bob')
let roomUrl = ''

await check('A creates a room and B is let in with persistence on',
  async () => {
    await alice.page.goto(origin)
    await waitFor('the name field', () => has(alice.page, SETUP_NAME_FIELD))
    await createUser(alice, 'Alice')
    await waitForRoom(alice)
    roomUrl = alice.page.url()

    await bob.page.goto(roomUrl)
    await waitFor('the name field', () => has(bob.page, SETUP_NAME_FIELD))
    await createUser(bob, 'Bob')
    await waitFor('B to wait', () => has(bob.page, 'section.waiting'))
    await approveNamed(alice, 'Bob')
    await waitForRoom(bob)

    await setPersist(bob, true)
    await waitFor('the record to be written', async () => {
      return (await storedSession(bob)) !== null
    })
  })

// Step 4, realistic-demo.AC6.2 -- what was said while away, in order.

await check('a returning client replays what it missed, in order',
  async () => {
    const before = await timelineOf(bob.page)
    assert(
      !before.some(r => r.kind === 'placeholder'),
      'B joined before anything was said and should hold no placeholder'
    )

    await bob.page.close()
    bob.page = null

    const said = ['away-one', 'away-two', 'away-three', 'away-four']
    for (const text of said) await sayAndSettle(alice, text)

    await newTab(bob)
    await bob.page.goto(roomUrl)
    await waitForRoom(bob)

    await waitFor('B to catch up', async () => {
      const rows = await timelineOf(bob.page)
      return rows.filter(r => said.includes(r.text)).length === said.length
    })

    const rows = await timelineOf(bob.page)
    const seen = rows.filter(r => said.includes(r.text))

    // Order, said as the sequence itself rather than as a count: a
    // check that only counted four rows passes against a replay that
    // delivered them backwards.
    assert(
      JSON.stringify(seen.map(r => r.text)) === JSON.stringify(said),
      `expected ${said.join(', ')}; got ${seen.map(r => r.text).join(', ')}`
    )
    assert(
      seen.every(r => r.from === 'Alice'),
      'every replayed message should still name its sender'
    )

    // And the other half: nothing arrived twice. Duplicates are the
    // failure a cursor that did not advance produces, and a check for
    // order alone would not see them.
    const seqs = rows.filter(r => r.kind === 'text').map(r => r.seq)
    assert(
      new Set(seqs).size === seqs.length,
      `an entry was rendered twice: ${seqs.join(', ')}`
    )
  })

// Step 5, realistic-demo.AC6.5's wiring -- a client's own past messages.

let ownReplayNote = ''

await check("a client's own messages survive a reload as text", async () => {
  const mine = ['mine-one', 'mine-two']
  for (const text of mine) await sayAndSettle(bob, text)

  const beforeReload = await timelineOf(bob.page)
  assert(
    mine.every(text => beforeReload.some(r => {
      return r.kind === 'text' && r.text === text
    })),
    'B should see its own messages as text before any reload'
  )

  await bob.page.reload()
  await waitForRoom(bob)

  // A message A sends after the reload proves the replay path is alive,
  // so an empty history below cannot be "the reload has not finished".
  await sayAndSettle(alice, 'after-the-reload')
  await waitFor('B to receive the new message', async () => {
    const rows = await timelineOf(bob.page)
    return rows.some(r => r.text === 'after-the-reload')
  })

  const rows = await timelineOf(bob.page)
  const kept = mine.filter(text => rows.some(r => {
    return r.kind === 'text' && r.text === text
  }))
  const asPlaceholder = rows.filter(r => r.reason === 'undecryptable')

  ownReplayNote =
    `own messages rendered as text after reload: ${kept.length}/2; ` +
    `undecryptable placeholders: ${asPlaceholder.length}; ` +
    `rows in total: ${rows.length}`

  // The criterion is the negative one: whatever a reload does with the
  // history, a client's own past message must never be shown as a
  // message it could not read. That would say forward secrecy took away
  // something the person typed themselves.
  assert(
    asPlaceholder.length === 0,
    "a client's own past messages must not render as decrypt failures: " +
    ownReplayNote
  )
})

// Step 6, realistic-demo.AC6.4's wiring -- more than four commits away.

let collapseNote = ''

await check('a client away across more than four commits comes back sane',
  async () => {
    await bob.page.close()
    bob.page = null

    // retainKeysForEpochs is 4, so this drives six commits with a
    // message between each: three joins and three removals.
    for (const name of ['Cara', 'Dan', 'Eve']) {
      const guest = await openProfile(name.toLowerCase())
      await guest.page.goto(roomUrl)
      await waitFor('the name field', () => has(guest.page, SETUP_NAME_FIELD))
      await createUser(guest, name)
      await waitFor('the guest to wait', () => {
        return has(guest.page, 'section.waiting')
      })
      await approveNamed(alice, name)
      await waitForRoom(guest)

      await sayAndSettle(alice, `while-${name.toLowerCase()}-was-here`)

      await removeNamed(alice, name)
      await waitFor(`${name} to leave the roster`, async () => {
        return !(await memberNames(alice.page)).includes(name)
      })

      await sayAndSettle(alice, `after-${name.toLowerCase()}-went`)
    }

    const epoch = await epochOf(alice.page)
    assert(epoch > 4, `expected more than four commits, got epoch ${epoch}`)

    await newTab(bob)
    await bob.page.goto(roomUrl)
    await waitForRoom(bob)

    await waitFor('B to catch up on the epoch', async () => {
      return await epochOf(bob.page) === epoch
    })

    await waitFor('B to see the last thing said', async () => {
      const rows = await timelineOf(bob.page)
      return rows.some(r => r.text === 'after-eve-went')
    })

    const rows = await timelineOf(bob.page)
    const runs = rows.filter(r => r.reason === 'undecryptable')

    collapseNote = runs.length === 0 ?
      'no undecryptable entry occurred: replaying commits and messages ' +
      'in log order keeps a returning member in step, so the ' +
      'retainKeysForEpochs window is never crossed' :
      `undecryptable placeholders: ${runs.length}, counts ` +
      runs.map(r => r.count).join(', ')

    // Whichever happened, the rule is the same: consecutive unreadable
    // entries are one counted row, never a wall of them. A run of
    // count 1 rows next to each other is exactly the failure the fold
    // exists to prevent.
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]
      const here = rows[i]
      assert(
        !(prev.reason === 'undecryptable' && here.reason === 'undecryptable'),
        'two undecryptable placeholders in a row should have collapsed ' +
        'into one counted item'
      )
    }

    assert(
      !(await has(bob.page, 'section.removed')),
      'B was never removed and must not be shown the removed view'
    )
  })

// Step 7.5, realistic-demo.AC7.5 -- a waiting joiner comes back waiting.

await check('a waiting joiner persists and returns to waiting', async () => {
  const frank = await openProfile('frank')
  await frank.page.goto(roomUrl)
  await waitFor('the name field', () => has(frank.page, SETUP_NAME_FIELD))
  await createUser(frank, 'Frank')
  await waitFor('F to wait', () => has(frank.page, 'section.waiting'))

  assert(
    await has(frank.page, 'section.persistence input[type=checkbox]'),
    'the persist control should be on the waiting view too'
  )

  await setPersist(frank, true)
  await waitFor('the record to be written', async () => {
    return (await storedSession(frank)) !== null
  })

  const record = await storedSession(frank)
  assert(record.hasKeyPackage, 'the key package should be stored')
  assert(record.hasPrivateKeys, 'and the private keys that open a Welcome')
  assert(
    record.hasState === false,
    'a waiting joiner has no group state, which is why the record exists'
  )

  await frank.page.reload()
  await waitFor('F to come back waiting', () => {
    return has(frank.page, 'section.waiting')
  })
  assert(
    !(await has(frank.page, SETUP_NAME_FIELD)),
    'a restored joiner must not fall back to the name field'
  )
  assert(
    await textOf(frank.page, 'section.waiting .chosen-name') === 'Frank',
    'and it should still be the same person waiting'
  )

  // The key package is intact only if the invitation it asked for still
  // opens. Approving after the reload is the check: a new key pair
  // would leave A's Welcome addressed to a key F no longer holds, and F
  // would sit on the waiting view for ever.
  await approveNamed(alice, 'Frank')
  await waitForRoom(frank)

  await waitFor(
    'the pending list to drain -- a reload must not leave a second ' +
      'request behind as a new identity',
    async () => {
      return (await alice.page
        .locator('section.room ul.pending li.request')
        .count()) === 0
    }
  )
})

// Step 8, realistic-demo.AC7.6 -- Reset takes this demo and nothing else.

await check('reset deletes only this demo and leaves the room standing',
  async () => {
    await seedOtherDemo(bob, 'mls-persistence-demo', 'members', 'someone')
    await seedOtherDemo(bob, 'mls-multi-device-demo', 'members', 'a-device')

    const before = await databaseNames(bob)
    for (const name of [
      'mls-realistic-demo',
      'mls-persistence-demo',
      'mls-multi-device-demo'
    ]) {
      assert(before.includes(name), `${name} should exist before Reset`)
    }

    await bob.page.click('section.persistence substrate-button.reset')
    await waitFor('the database to go', async () => {
      return !(await databaseNames(bob)).includes('mls-realistic-demo')
    })

    const after = await databaseNames(bob)
    assert(
      after.includes('mls-persistence-demo'),
      "the persistence demo's database must be left alone"
    )
    assert(
      after.includes('mls-multi-device-demo'),
      "and so must the multi-device demo's"
    )

    // Present is not intact. A deleteDatabase followed by a reopen
    // leaves the name in the list with nothing in it, which is exactly
    // the failure this criterion is about.
    assert(
      (await otherDemoKeys(bob, 'mls-persistence-demo', 'members'))
        .includes('someone'),
      "the persistence demo's record must survive"
    )
    assert(
      (await otherDemoKeys(bob, 'mls-multi-device-demo', 'members'))
        .includes('a-device'),
      "and so must the multi-device demo's"
    )

    // The room is on the server, not in the browser. A fresh profile
    // asking for the same URL must find it, not the gone view.
    const grace = await openProfile('grace')
    await grace.page.goto(roomUrl)
    await waitFor('the page to settle', () => {
      return has(grace.page, SETUP_NAME_FIELD)
    })
    assert(
      !(await has(grace.page, 'section.gone')),
      'Reset is local; the room must still exist on the server'
    )
  })

await check('no page logged an error', async () => {
  for (const profile of profiles) {
    const errors = realErrors(profile)
    assert(
      errors.length === 0,
      `${profile.name} logged: ${errors.join(' | ')}`
    )
  }
})

// --- teardown ---------------------------------------------------------

for (const profile of profiles) {
  await profile.context.close()
  rmSync(profile.dir, { recursive: true, force: true })
}

console.log('')
if (ownReplayNote) console.log(`Note (step 5): ${ownReplayNote}`)
if (collapseNote) console.log(`Note (step 6): ${collapseNote}`)
console.log('')
console.log(`${passCount} passed, ${failCount} failed`)

process.exit(failCount === 0 ? 0 : 1)

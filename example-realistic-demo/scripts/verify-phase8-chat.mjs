#!/usr/bin/env node

/**
 * Phase 8 Task 5a: chat and the persistence control, driven through real
 * browsers.
 *
 * Only the half of Task 5 that this story built: a message sent, seen
 * and unreadable on the wire, and the persist toggle writing, restoring
 * and deleting a session. The gone view, the explainer copy and the full
 * Task 6 sweep are other stories' work and are not checked here.
 *
 * Every client is its own Chromium profile -- a separate user data
 * directory -- which is what makes the persistence checks mean anything:
 * a shared profile shares the database.
 *
 * Needs both dev servers already running:
 *
 *   npm run worker:realistic      # wrangler, :8787
 *   npm run dev:realistic   # vite, :1234 (proxies /api to the Worker)
 *
 * Usage: node example-realistic-demo/scripts/verify-phase8-chat.mjs [origin]
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

// --- profiles ---------------------------------------------------------

async function openProfile (name) {
  const dir = mkdtempSync(join(tmpdir(), `mls-phase8-${name}-`))
  const context = await chromium.launchPersistentContext(dir, {
    headless: true
  })

  const profile = { name, dir, context, page: null, frames: [], errors: [] }
  profiles.push(profile)
  await newTab(profile)
  return profile
}

/**
 * A fresh tab in an existing profile -- the profile's storage survives,
 * which is the whole point of the persistence checks below.
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

/** The timeline as rows: text, placeholder and not-yet-numbered alike. */
function timelineOf (page) {
  return page.$$eval('section.room ul.timeline li', els => {
    return els.map(el => ({
      kind: el.classList.contains('message') ?
        'text' :
        el.classList.contains('outbound-message') ? 'outbound' : 'placeholder',
      from: el.querySelector('.message-from')?.textContent?.trim() ?? '',
      text: el.querySelector('.message-text')?.textContent?.trim() ?? '',
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

async function approveNamed (creator, displayName) {
  const row = creator.page
    .locator('section.room ul.pending li.request')
    .filter({ hasText: displayName })
  await row.locator('substrate-button.approve').click()
}

/**
 * What this profile's own indexedDB holds for the realistic demo. Every
 * connection opened here is closed again: a live connection blocks the
 * page's own Delete control, so a reader that leaked one would make this
 * script the reason the check it is about to make fails.
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

function realErrors (profile) {
  return profile.errors.filter(text => !/favicon/.test(text))
}

// --- the run ----------------------------------------------------------

console.log(`Origin: ${origin}`)
console.log('')

const alice = await openProfile('alice')
let roomUrl = ''

await check('the persist control is there before any user exists', async () => {
  await alice.page.goto(origin)
  await waitFor('the name field', () => has(alice.page, SETUP_NAME_FIELD))

  assert(
    await has(alice.page, 'section.persistence input[type=checkbox]'),
    'the persist toggle should be on the page from the first paint'
  )
  assert(
    await has(alice.page, 'section.persistence substrate-button.reset'),
    'and so should the delete control'
  )
  assert(
    (await textOf(alice.page, 'section.persistence .persist-disclosure'))
      .includes('mls-realistic-demo'),
    'the disclosure should name the database it writes to'
  )
})

await check('A creates a room, B joins and is approved', async () => {
  await createUser(alice, 'Alice')
  await waitForRoom(alice)
  roomUrl = alice.page.url()

  assert(
    await has(alice.page, 'section.persistence input[type=checkbox]'),
    'the persist toggle should survive the change of view'
  )
})

const bob = await openProfile('bob')

await check('B is let in', async () => {
  await bob.page.goto(roomUrl)
  await waitFor('the name field', () => has(bob.page, SETUP_NAME_FIELD))
  await createUser(bob, 'Bob')
  await waitFor('B to wait', () => has(bob.page, 'section.waiting'))

  await waitFor(
    'the pending list',
    () => has(alice.page, 'section.room ul.pending li.request')
  )
  await approveNamed(alice, 'Bob')
  await waitForRoom(bob)
})

// realistic-demo.AC6.1 -- a sent message is decrypted and displayed

await check("A's message reaches B, and the wire carries no plaintext",
  async () => {
    const mark = alice.frames.length
    const secret = 'the-cat-is-on-the-mat'
    await say(alice, secret)

    // The sender sees it too: first from the local record, then as a
    // numbered row once the room echoes the entry back. The echo carries
    // a payload she cannot decrypt, so the text on that row is still the
    // plaintext she recorded at send time.
    await waitFor('A to show her own message', async () => {
      const rows = await timelineOf(alice.page)
      return rows.some(r => r.text === secret)
    })
    await waitFor('the echo to number it', async () => {
      const rows = await timelineOf(alice.page)
      return rows.some(r => r.kind === 'text' && r.text === secret)
    })
    assert(
      !(await timelineOf(alice.page)).some(r => r.kind === 'outbound'),
      'the outbound row should give way to the numbered one'
    )

    await waitFor('B to show the message', async () => {
      const rows = await timelineOf(bob.page)
      return rows.some(r => r.kind === 'text' && r.text === secret)
    })

    const [row] = (await timelineOf(bob.page)).filter(r => r.text === secret)
    assert(row.from === 'Alice', `expected Alice, got "${row.from}"`)

    const frames = sent(alice, 'mls', mark)
      .filter(f => f.msg.kind === 'application')
    assert(frames.length === 1, `expected one application frame, got ${frames.length}`)
    assert(
      !frames[0].text.includes(secret),
      'the plaintext must appear nowhere on the wire'
    )
    assert(
      /^[A-Za-z0-9+/=]+$/.test(frames[0].msg.payload),
      'the payload should be opaque base64'
    )
  })

await check("B's reply reaches A with B's name", async () => {
  const reply = 'and-the-mat-is-on-the-floor'
  await say(bob, reply)

  await waitFor('A to show the reply', async () => {
    const rows = await timelineOf(alice.page)
    return rows.some(r => r.kind === 'text' && r.text === reply)
  })

  const [row] = (await timelineOf(alice.page)).filter(r => r.text === reply)
  assert(row.from === 'Bob', `expected Bob, got "${row.from}"`)

  // The negative half: A's own earlier message must not have turned into
  // a placeholder now that the timeline has re-rendered.
  const rows = await timelineOf(alice.page)
  assert(
    rows.some(r => r.text === 'the-cat-is-on-the-mat'),
    "A's own message should still be shown to her"
  )
  assert(
    !rows.some(r => r.kind === 'placeholder'),
    'nobody who has been here from epoch zero should see a placeholder'
  )
})

// realistic-demo.AC7.2 -- turning it on writes whatever state exists

let storedCursor = 0

await check('persist on writes the session', async () => {
  assert(
    await storedSession(bob) === null,
    'nothing should be stored before the toggle is touched'
  )

  await bob.page.click('section.persistence input[type=checkbox]')
  await waitFor('the record to be written', async () => {
    return (await storedSession(bob)) !== null
  })

  const record = await storedSession(bob)
  assert(record.name === 'Bob', `expected Bob, got ${record.name}`)
  assert(record.hasKeyPackage, 'the key package should be stored')
  assert(record.hasPrivateKeys, 'and the private keys')
  assert(record.hasState, 'and the group state')
  assert(
    record.roomId === roomUrl.split('/').pop(),
    `expected the room id, got ${record.roomId}`
  )
  assert(record.cursor > 0, `expected a cursor past zero, got ${record.cursor}`)
  assert(
    record.creatorToken === null,
    'B is not the creator, so it holds no token'
  )
  storedCursor = record.cursor

  const creator = await storedSession(alice)
  assert(creator === null, 'A has not turned hers on, so she stores nothing')
})

// realistic-demo.AC7.4 -- a reload comes back at the current epoch

await check('a reload restores the group at the epoch it was at', async () => {
  const epoch = await epochOf(bob.page)
  assert(epoch > 0, `expected a group past epoch zero, got ${epoch}`)

  const mark = bob.frames.length
  await bob.page.reload()
  await waitForRoom(bob)

  assert(
    await epochOf(bob.page) === epoch,
    'the restored group should be at the epoch it was persisted at'
  )
  assert(
    !(await has(bob.page, SETUP_NAME_FIELD)),
    'a restored client must not be asked for a name again'
  )

  await waitFor(
    'the restored client to say hello',
    () => sent(bob, 'hello', mark).length >= 1
  )

  const cursors = sent(bob, 'hello', mark).map(f => f.msg.cursor)
  assert(
    cursors.every(c => c === storedCursor),
    'the restored client should resume from the stored cursor ' +
    `${storedCursor}; it said ${cursors.join(', ')}`
  )
})

await check('chat still works after the restore', async () => {
  const third = 'said-after-a-reload'
  await say(bob, third)

  await waitFor('A to show it', async () => {
    const rows = await timelineOf(alice.page)
    return rows.some(r => r.kind === 'text' && r.text === third)
  })

  const [row] = (await timelineOf(alice.page)).filter(r => r.text === third)
  assert(row.from === 'Bob', `expected Bob, got "${row.from}"`)
})

// The URL is the ask. A stored session must not be restored onto a page
// addressed to a different room -- the group state belongs to one room
// and the cursor is counted in that room's log.

await check('a link to another room does not restore the stored one',
  async () => {
    const carol = await openProfile('carol')
    await carol.page.goto(origin)
    await waitFor('the name field', () => has(carol.page, SETUP_NAME_FIELD))
    await createUser(carol, 'Carol')
    await waitForRoom(carol)
    const otherRoom = carol.page.url()

    assert(otherRoom !== roomUrl, 'the second room should be a new room')

    await bob.page.goto(otherRoom)

    // Asked for by name, which is what a client with no session for this
    // room is. Before the fix, `restore` wrote the stored room id over
    // the one the URL asked for, so this page came back as a member of
    // the *other* room and said hello to this one with a cursor counted
    // in a different log.
    await waitFor(
      'B to be asked who it is in the new room',
      () => has(bob.page, SETUP_NAME_FIELD)
    )
    assert(
      !(await has(bob.page, 'section.room')),
      'B must not arrive in a room it was never in'
    )

    const record = await storedSession(bob)
    assert(
      record !== null && record.roomId === roomUrl.split('/').pop(),
      'and the stored record must be left exactly as it was'
    )

    // Back where the remaining checks expect B to be.
    await bob.page.goto(roomUrl)
    await waitForRoom(bob)
  })

// realistic-demo.AC7.3 -- turning it off deletes what was stored

await check('persist off deletes the stored session', async () => {
  await bob.page.click('section.persistence input[type=checkbox]')
  await waitFor('the record to go', async () => {
    return (await storedSession(bob)) === null
  })

  // And it stays gone: an advancing cursor must not write it back.
  await say(alice, 'said-while-b-stores-nothing')
  await waitFor('B to receive it', async () => {
    const rows = await timelineOf(bob.page)
    return rows.some(r => r.text === 'said-while-b-stores-nothing')
  })
  assert(
    await storedSession(bob) === null,
    'nothing should be written back while the toggle is off'
  )

  await bob.page.reload()
  await waitFor(
    'the name field',
    () => has(bob.page, SETUP_NAME_FIELD)
  )
})

// realistic-demo.AC7.6, the half this story can check: Delete takes this
// demo's database and nothing else.

await check('delete takes only this demo\'s database', async () => {
  await bob.page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('mls-persistence-demo', 1)
      open.onupgradeneeded = () => {
        open.result.createObjectStore('members')
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('members', 'readwrite')
        tx.objectStore('members').put({ name: 'someone' }, 'someone')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
  })

  await createUser(bob, 'Bob')
  await waitFor('B to wait', () => has(bob.page, 'section.waiting'))
  await bob.page.click('section.persistence input[type=checkbox]')
  await waitFor('a record for the waiting joiner', async () => {
    return (await storedSession(bob)) !== null
  })

  // realistic-demo.AC7.5's record: keys, no group state.
  const record = await storedSession(bob)
  assert(record.hasKeyPackage, 'a waiting joiner stores its key package')
  assert(
    record.hasState === false,
    'and no group state, which is what returns it to waiting'
  )

  await bob.page.click('section.persistence substrate-button.reset')
  await waitFor('the database to go', async () => {
    return !(await databaseNames(bob)).includes('mls-realistic-demo')
  })

  assert(
    (await databaseNames(bob)).includes('mls-persistence-demo'),
    'the persistence demo\'s database must be left alone'
  )

  // The room is still on the server: A is still in it and still talking.
  await say(alice, 'still-here-after-the-delete')
  await waitFor('A to show it', async () => {
    const rows = await timelineOf(alice.page)
    return rows.some(r => r.text === 'still-here-after-the-delete')
  })
})

// realistic-demo.AC6.3 and AC6.6, the wiring half. The fold itself is
// unit tested; what a browser adds is that `joinCursor` and `priorCount`
// reach it from the room's `welcome-you` rather than staying at zero.
// Task 6 covers the rest of the placeholder criteria.

await check('a late joiner is told how many messages it missed',
  async () => {
    // Counted only once nothing is still in flight. An outbound row is a
    // message the room has not numbered yet, and it is not in the log the
    // room counts `priorCount` from -- so counting while one is pending
    // compares two different moments. Waiting for it is also the
    // assertion that every outbound row does become a numbered one.
    await waitFor('everything A sent to be numbered', async () => {
      const rows = await timelineOf(alice.page)
      return !rows.some(r => r.kind === 'outbound')
    })

    const before = (await timelineOf(alice.page))
      .filter(r => r.kind === 'text').length
    assert(before > 0, 'there should be messages to have missed')

    const dave = await openProfile('dave')
    await dave.page.goto(roomUrl)
    await waitFor('the name field', () => has(dave.page, SETUP_NAME_FIELD))
    await createUser(dave, 'Dave')
    await waitFor('D to wait', () => has(dave.page, 'section.waiting'))

    await waitFor(
      "Dave's request",
      async () => {
        const rows = alice.page
          .locator('section.room ul.pending li.request')
          .filter({ hasText: 'Dave' })
        return (await rows.count()) > 0
      }
    )
    await approveNamed(alice, 'Dave')
    await waitForRoom(dave)

    await waitFor('the leading placeholder', async () => {
      const rows = await timelineOf(dave.page)
      return rows.some(r => r.reason === 'before-join')
    })

    const rows = await timelineOf(dave.page)
    const leading = rows.filter(r => r.reason === 'before-join')
    assert(
      leading.length === 1,
      `expected one leading placeholder, got ${leading.length}`
    )
    assert(
      Number(leading[0].count) === before,
      `expected a count of ${before}, got ${leading[0].count}`
    )

    // The negative half: A was here from epoch zero and still sees none.
    assert(
      !(await timelineOf(alice.page)).some(r => r.kind === 'placeholder'),
      'a founding member should still see no placeholder at all'
    )
  })

await check('neither page logged an error', async () => {
  for (const profile of [alice, bob]) {
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
console.log(`${passCount} passed, ${failCount} failed`)

process.exit(failCount === 0 ? 0 : 1)

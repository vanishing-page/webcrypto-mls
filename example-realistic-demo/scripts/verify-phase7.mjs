#!/usr/bin/env node

/**
 * Phase 7 Task 6: the two-party join choreography, driven through real
 * browsers.
 *
 * Every client is its own Chromium *profile* -- a separate user data
 * directory, so separate storage and separate everything -- rather than
 * a tab, which is what Task 6 asks for and what a single profile cannot
 * give.
 *
 * Needs both dev servers already running:
 *
 *   npm run worker:realistic      # wrangler, :8787
 *   npm run dev:realistic   # vite, :1234 (proxies /api to the Worker)
 *
 * Usage: node example-realistic-demo/scripts/verify-phase7.mjs [origin]
 *
 * Where a step departs from phase_07.md's wording it says so and says
 * why, in a `note`, and the notes are reprinted at the end. The
 * departures are all one thing: no client persists anything yet, so a
 * closed tab is a *new client* rather than the same one coming back.
 * Where a step says "close the tab and reopen it", the check that can
 * be made today drops the socket instead and keeps the client alive.
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
const notes = []
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

function note (text) {
  notes.push(text)
  console.log(`  note: ${text}`)
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

/**
 * One profile is one client. The frame log and the socket counters are
 * per profile, because "what did A send" and "is B's socket up" are the
 * two questions every step below asks.
 */
async function openProfile (name) {
  const dir = mkdtempSync(join(tmpdir(), `mls-phase7-${name}-`))
  const context = await chromium.launchPersistentContext(dir, {
    headless: true
  })

  // Every socket the page opens, recorded so a check can drop one. A
  // subclass rather than a wrapping function: the client reads the
  // static `WebSocket.OPEN`, which a plain function would not carry.
  // The page itself is untouched -- nothing here is a client change.
  await context.addInitScript(() => {
    const Native = window.WebSocket
    const sockets = []
    window.__mlsSockets = sockets

    class Recording extends Native {
      constructor (...args) {
        super(...args)
        sockets.push(this)
      }
    }

    window.WebSocket = Recording
  })

  const profile = {
    name,
    dir,
    context,
    page: null,
    frames: [],
    errors: []
  }

  profiles.push(profile)
  await newTab(profile)
  return profile
}

/**
 * A fresh tab in an existing profile. Used for the literal
 * close-and-reopen observations: the profile's storage survives, and
 * the point of the observation is that the client does not.
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

  // The hibernation keepalive pair, which is not JSON and not a
  // protocol message.
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

function received (profile, type, from = 0) {
  return profile.frames
    .slice(from)
    .filter(f => f.dir === 'recv' && f.msg?.type === type)
}

/**
 * Is this client's delivery socket up? Matched by URL, because a Vite
 * dev page holds two sockets: the room's and the HMR channel's. Closing
 * or counting the wrong one makes the dev server reload the page, which
 * throws away the identity and the group the check was about.
 */
function liveSocket (profile) {
  return profile.page.evaluate(() => {
    const sockets = window.__mlsSockets ?? []
    return sockets.some(socket => {
      return socket.url.includes('/api/room/') && socket.readyState === 1
    })
  })
}

/**
 * Drop this client's socket without touching the client. The page keeps
 * its identity, its group and its cursor -- which is the difference
 * between "went away for a while" and "closed the tab", and the only
 * one of the two Phase 7 can tell apart.
 *
 * Two halves, and both are needed. `setOffline` stops the reconnect
 * that follows from succeeding, but it does *not* close a socket that
 * is already open -- traffic on it simply stops arriving, which the
 * room reads as a live member and the page reads as a healthy
 * connection. So the open socket is closed from inside the page, which
 * is a real close event on both ends.
 */
async function goOffline (profile) {
  await profile.context.setOffline(true)
  await profile.page.evaluate(() => {
    for (const socket of window.__mlsSockets ?? []) {
      if (!socket.url.includes('/api/room/')) continue
      if (socket.readyState === 1) socket.close()
    }
  })
  await waitFor(
    `${profile.name}'s socket to drop`,
    async () => !(await liveSocket(profile))
  )
}

async function goOnline (profile) {
  await profile.context.setOffline(false)
  await waitFor(
    `${profile.name}'s socket to come back`,
    async () => await liveSocket(profile)
  )
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

function membersOf (page) {
  return page.$$eval('section.room ul.members li.member', els => {
    // The name cell also holds the "You" marker on this client's own
    // row, and that marker is an element. Read only the cell's own text
    // nodes, so the marker does not become part of the name.
    const nameOf = el => {
      const cell = el.querySelector('.member-name')
      if (!cell) return ''
      return Array.from(cell.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join('')
        .trim()
    }

    return els.map(el => ({
      name: nameOf(el),
      presence: el.querySelector('.presence')?.textContent?.trim() ?? '',
      connected: el.getAttribute('data-connected'),
      remove: el.querySelector('substrate-button.remove') !== null
    }))
  })
}

function pendingOf (page) {
  return page.$$eval('section.room ul.pending li.request', els => {
    return els.map(el => {
      const approve = el.querySelector('substrate-button.approve button')
      return {
        name: el.querySelector('.requester-name')?.textContent?.trim() ?? '',
        standing: el.getAttribute('data-standing'),
        approve: el.querySelector('substrate-button.approve') !== null,
        approveDisabled: approve?.hasAttribute('disabled') ?? null
      }
    })
  })
}

function names (list) {
  return list.map(m => m.name)
}

async function createUser (profile, displayName) {
  await profile.page.fill(SETUP_NAME_FIELD, displayName)
  await profile.page.click(SETUP_SUBMIT_BTN)
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
 * Errors the page is not responsible for. A dev-server favicon that
 * does not exist is logged as a console error by Chromium and says
 * nothing about the client.
 */
function realErrors (profile) {
  return profile.errors.filter(text => !/favicon/.test(text))
}

// --- the run ----------------------------------------------------------

console.log(`Origin: ${origin}`)
console.log('')

const alice = await openProfile('alice')
let roomUrl = ''

// Step 2, part 1: the creator's own room.
await check('A creates a room and is its only member', async () => {
  await alice.page.goto(origin)
  await waitFor('the name field', () => has(alice.page, SETUP_NAME_FIELD))
  await createUser(alice, 'Alice')
  await waitForRoom(alice)

  roomUrl = alice.page.url()
  assert(
    /^http:\/\/[^/]+\/[A-Za-z0-9_-]{10}$/.test(roomUrl),
    `room URL looks wrong: ${roomUrl}`
  )

  const members = await membersOf(alice.page)
  assert(members.length === 1, `expected one member, got ${members.length}`)
  assert(members[0].name === 'Alice', `expected Alice, got ${members[0].name}`)
  assert(members[0].presence === 'Connected', 'Alice should be Connected')
  assert(
    members[0].remove === false,
    'the creator must not be offered a Remove against her own leaf'
  )
  assert(await epochOf(alice.page) === 0, 'a new group is at epoch 0')
})

await check('both disclosures render beside what they describe', async () => {
  assert(
    await has(alice.page, 'section.room p.presence-disclosure'),
    'the Away disclosure is missing'
  )
  assert(
    await has(alice.page, 'section.room p.removal-disclosure'),
    'the creator-only-removal disclosure is missing'
  )
})

const bob = await openProfile('bob')

// Step 2, part 2: an invitation link with no user on it.
await check('B opens the link and is asked for a name', async () => {
  await bob.page.goto(roomUrl)
  await waitFor('the name field', () => has(bob.page, SETUP_NAME_FIELD))
  assert(
    !(await has(bob.page, 'section.room')),
    'B must not see a room before being let in'
  )
  assert(
    !(await has(bob.page, 'section.gone')),
    'an existing room must not read as gone'
  )
})

await check('B asks to join and waits', async () => {
  const mark = bob.frames.length
  await createUser(bob, 'Bob')
  await waitFor('B to wait', () => has(bob.page, 'section.waiting'))
  assert(
    await textOf(bob.page, '.chosen-name') === 'Bob',
    'the waiting view should name the person waiting'
  )
  await waitFor(
    'B to publish a join request',
    async () => sent(bob, 'join-request', mark).length === 1
  )
  const hello = sent(bob, 'hello', mark)
  assert(hello.length === 1, 'B should say hello exactly once per socket')
  assert(
    bob.frames.indexOf(hello[0]) <
      bob.frames.indexOf(sent(bob, 'join-request', mark)[0]),
    'hello must precede the join request'
  )
})

await check("A sees B's name and standing", async () => {
  await waitFor(
    'the pending list',
    async () => (await pendingOf(alice.page)).length === 1
  )
  const [row] = await pendingOf(alice.page)
  assert(row.name === 'Bob', `expected Bob, got ${row.name}`)
  assert(
    row.standing === 'stranger',
    `expected stranger, got ${row.standing}`
  )
  assert(row.approveDisabled === false, 'Approve should be offered')
})

let welcomeYou = null

await check('approve sends commit, welcome, approve in that order', async () => {
  const mark = alice.frames.length
  await approveNamed(alice, 'Bob')
  await waitFor(
    'three outbound frames',
    async () => {
      const order = alice.frames
        .slice(mark)
        .filter(f => f.dir === 'sent')
        .filter(f => ['mls', 'welcome', 'approve'].includes(f.msg?.type))
      return order.length >= 3
    }
  )

  const order = alice.frames
    .slice(mark)
    .filter(f => f.dir === 'sent')
    .filter(f => ['mls', 'welcome', 'approve'].includes(f.msg?.type))
    .map(f => f.msg)

  assert(
    order.length === 3,
    `expected three frames, got ${order.map(m => m.type).join(', ')}`
  )
  assert(order[0].type === 'mls', `first frame was ${order[0].type}`)
  assert(
    order[0].kind === 'commit',
    `first frame was mls{${order[0].kind}}`
  )
  assert(order[1].type === 'welcome', `second frame was ${order[1].type}`)
  assert(order[2].type === 'approve', `third frame was ${order[2].type}`)
})

await check('B joins from the Welcome', async () => {
  await waitForRoom(bob)
  const welcomes = received(bob, 'welcome-you')
  assert(welcomes.length === 1, 'B should be welcomed exactly once')
  welcomeYou = welcomes[0].msg
})

await check("B adopts the room's cursor verbatim", async () => {
  // The cursor is not rendered, so it is read the one place it appears
  // on the wire: `hello` carries it, and a reconnect with no entry in
  // between says what B is holding.
  const mark = bob.frames.length
  await goOffline(bob)
  await goOnline(bob)
  await waitFor(
    "B's next hello",
    async () => sent(bob, 'hello', mark).length >= 1
  )
  const [hello] = sent(bob, 'hello', mark)
  assert(
    hello.msg.cursor === welcomeYou.cursor,
    `B resumed at ${hello.msg.cursor}, was welcomed at ` +
      `${welcomeYou.cursor}`
  )
  note(
    'priorCount is adopted in the same batch as the cursor but has no ' +
    'Phase 7 rendering and never goes back on the wire, so only the ' +
    'cursor half of AC3.2 is browser-observable today. Phase 8 renders ' +
    'the missed-message count, which is where the other half becomes ' +
    'checkable.'
  )
})

await check('A and B agree on the members and the epoch', async () => {
  await waitFor(
    'B to list two members',
    async () => (await membersOf(bob.page)).length === 2
  )
  const forAlice = await membersOf(alice.page)
  const forBob = await membersOf(bob.page)

  assert(
    names(forAlice).join() === 'Alice,Bob',
    `A lists ${names(forAlice).join()}`
  )
  assert(
    names(forBob).join() === 'Alice,Bob',
    `B lists ${names(forBob).join()}`
  )
  const epochA = await epochOf(alice.page)
  const epochB = await epochOf(bob.page)
  assert(epochA === 1, `A is at epoch ${epochA}, expected 1`)
  assert(epochB === 1, `B is at epoch ${epochB}, expected 1`)
})

await check('no display name ever crosses the wire', async () => {
  // Both lists came from each client's own tree, and this is what says
  // so: the room never learns a name, so B's list cannot have come
  // from the room.
  const leaked = bob.frames.filter(f => /Alice|Bob/.test(f.text))
  assert(
    leaked.length === 0,
    `${leaked.length} frame(s) carried a display name in the clear`
  )
})

// Step 7's negative, taken before the removal it is about.
await check('B is offered no Remove control, for anybody', async () => {
  const members = await membersOf(bob.page)
  assert(members.length === 2, 'B should see both members')
  assert(
    members.every(m => m.remove === false),
    'a non-creator must be offered no Remove control'
  )
  assert(
    !(await has(bob.page, 'section.room substrate-button.remove')),
    'a non-creator rendered a Remove button'
  )
  assert(
    !(await has(bob.page, 'section.room ul.pending')),
    'a non-creator rendered a pending list'
  )
})

// Step 6: liveness.
const carl = await openProfile('carl')

await check('C joins, taking the group to epoch 2', async () => {
  await carl.page.goto(roomUrl)
  await waitFor('the name field', () => has(carl.page, SETUP_NAME_FIELD))
  await createUser(carl, 'Carl')
  await waitFor('C to wait', () => has(carl.page, 'section.waiting'))
  await waitFor(
    "C's request",
    async () => (await pendingOf(alice.page)).some(r => r.name === 'Carl')
  )
  await approveNamed(alice, 'Carl')
  await waitForRoom(carl)
  const epochA = await epochOf(alice.page)
  assert(epochA === 2, `A is at epoch ${epochA}, expected 2`)
})

await check('a dropped socket marks Away and touches no group state', async () => {
  const before = await epochOf(alice.page)
  await goOffline(carl)

  await waitFor(
    'A to mark C Away',
    async () => {
      const carlRow = (await membersOf(alice.page))
        .find(m => m.name === 'Carl')
      return carlRow?.presence === 'Away'
    }
  )

  const members = await membersOf(alice.page)
  const carlRow = members.find(m => m.name === 'Carl')
  assert(carlRow !== undefined, 'C must stay listed as a member')
  assert(carlRow.connected === 'false', 'C should read data-connected=false')
  assert(
    names(members).join() === 'Alice,Bob,Carl',
    `A lists ${names(members).join()}`
  )
  const after = await epochOf(alice.page)
  assert(
    after === before,
    `the epoch moved ${before} -> ${after} on a dropped socket`
  )
  const live = await alice.page.locator('section.room ul.live li').count()
  assert(live === 2, `expected two connected, got ${live}`)
})

await check('the Away mark clears when the socket comes back', async () => {
  // Asserted before the transition as well as after it. Reading
  // Connected at the end says nothing on its own -- Connected is where
  // this member started.
  const before = (await membersOf(alice.page)).find(m => m.name === 'Carl')
  assert(
    before?.presence === 'Away',
    `C reads ${before?.presence} before coming back, expected Away`
  )

  await goOnline(carl)
  await waitFor(
    'A to mark C Connected',
    async () => {
      const carlRow = (await membersOf(alice.page))
        .find(m => m.name === 'Carl')
      return carlRow?.presence === 'Connected'
    }
  )
  note(
    'phase_07.md Step 6 closes and reopens the tab. Nothing is ' +
    'persisted yet, so a reopened tab is a new identity and the old ' +
    "member's mark could never clear -- the socket is dropped instead, " +
    'which is the same event the roster reports. The literal ' +
    'close-and-reopen is checked below for what it does today.'
  )
})

await check('a closed tab is a new client, not the same one back', async () => {
  // The Phase 7 limit, stated as a check so it is noticed when it
  // stops being true: nothing is persisted, so a second page in the
  // profile of somebody who is already a member is asked for a name.
  const reopened = await carl.context.newPage()

  try {
    await reopened.goto(roomUrl)
    await waitFor('the name field', () => has(reopened, SETUP_NAME_FIELD))
    assert(
      !(await has(reopened, 'section.room')),
      'a fresh page cannot already be in the group'
    )
  } finally {
    await reopened.close()
  }
  note(
    'A reopened page shows the name field: identity, group and cursor ' +
    'are all in memory, so Task 6 Steps 3 and 4 cannot be run with a ' +
    'literal tab close until Phase 8 (US-017) persists a session. ' +
    'Both are run below against a dropped socket instead.'
  )
})

// Step 7: removal.
await check('A removes B: epoch advances by one, the leaf goes', async () => {
  const before = await epochOf(alice.page)
  const row = alice.page
    .locator('section.room ul.members li.member')
    .filter({ hasText: 'Bob' })
  await row.locator('substrate-button.remove').click()

  await waitFor(
    'B to leave the list',
    async () => !(await membersOf(alice.page)).some(m => m.name === 'Bob')
  )

  const after = await epochOf(alice.page)
  assert(after === before + 1, `epoch went ${before} -> ${after}`)
  const members = await membersOf(alice.page)
  assert(
    names(members).join() === 'Alice,Carl',
    `A lists ${names(members).join()}`
  )
})

await check("B's own page reports the removal in plain language", async () => {
  await waitFor(
    'B to show the removed view',
    () => has(bob.page, 'section.removed')
  )
  const heading = await textOf(bob.page, 'section.removed h1')
  assert(/removed/i.test(heading), `heading reads "${heading}"`)
  assert(
    !(await has(bob.page, 'section.removed substrate-button.remove')),
    'the removed view must offer no controls'
  )
  const errors = realErrors(bob)
  assert(
    errors.length === 0,
    `B logged ${errors.length} console error(s): ${errors.join(' | ')}`
  )
})

// Step 8: a commit that lands while a member is away.
const erin = await openProfile('erin')

await check('a commit made while C is away is replayed to C', async () => {
  await goOffline(carl)
  const epochAway = await epochOf(carl.page)

  await erin.page.goto(roomUrl)
  await waitFor('the name field', () => has(erin.page, SETUP_NAME_FIELD))
  await createUser(erin, 'Erin')
  await waitFor(
    "E's request",
    async () => (await pendingOf(alice.page)).some(r => r.name === 'Erin')
  )
  await approveNamed(alice, 'Erin')
  await waitForRoom(erin)

  const epochA = await epochOf(alice.page)
  assert(epochA > epochAway, 'A should have moved on while C was away')

  await goOnline(carl)
  await waitFor(
    'C to catch up',
    async () => await epochOf(carl.page) === epochA
  )

  const forAlice = names(await membersOf(alice.page))
  const forCarl = names(await membersOf(carl.page))
  assert(
    forCarl.join() === forAlice.join(),
    `C lists ${forCarl.join()}, A lists ${forAlice.join()}`
  )
  // Erin took the leaf B was removed from, which is only true if the
  // survivors kept their leaf indices rather than being renumbered:
  // leaf order puts her between Alice and Carl.
  assert(
    forAlice.join() === 'Alice,Erin,Carl',
    `expected Alice,Erin,Carl in leaf order, got ${forAlice.join()}`
  )
})

// Step 4: a request made while the creator is away.
const fred = await openProfile('fred')

await check('a request made while the creator is away survives', async () => {
  await goOffline(alice)

  await fred.page.goto(roomUrl)
  await waitFor('the name field', () => has(fred.page, SETUP_NAME_FIELD))
  await createUser(fred, 'Fred')
  await waitFor('F to wait', () => has(fred.page, 'section.waiting'))

  await goOnline(alice)
  await waitFor(
    "F's request to reach A",
    async () => (await pendingOf(alice.page)).some(r => r.name === 'Fred')
  )
  const row = (await pendingOf(alice.page)).find(r => r.name === 'Fred')
  assert(
    row.standing === 'stranger',
    `expected stranger, got ${row.standing}`
  )
})

// Step 3: a Welcome issued while the requester is away.
await check('a Welcome issued while F is away is delivered on connect', async () => {
  await goOffline(fred)
  const mark = alice.frames.length

  // The one and only click. Nothing below clicks anything, so a second
  // commit could only have come from the page acting on its own.
  await approveNamed(alice, 'Fred')
  await waitFor(
    "A's approval to go out",
    async () => sent(alice, 'approve', mark).length === 1
  )
  assert(
    await has(fred.page, 'section.waiting'),
    'F should still be waiting while offline'
  )

  await goOnline(fred)
  await waitForRoom(fred)

  assert(
    sent(alice, 'mls', mark).length === 1,
    `A committed ${sent(alice, 'mls', mark).length} times for one ` +
      'approval'
  )
  assert(
    received(fred, 'welcome-you').length === 1,
    'F should be welcomed exactly once'
  )
  const forFred = names(await membersOf(fred.page))
  const forAlice = names(await membersOf(alice.page))
  assert(
    forFred.join() === forAlice.join(),
    `F lists ${forFred.join()}, A lists ${forAlice.join()}`
  )
})

// Step 5: the same identity asking twice. Reaching this needed no
// contrivance -- F's reconnect re-published its request before the
// Welcome arrived, which is exactly an already-admitted identity
// asking again.
await check('a pre-approved request is committed with no prompt', async () => {
  const reAsked = sent(fred, 'join-request').length
  assert(
    reAsked >= 2,
    `F published ${reAsked} join request(s); the second is what makes ` +
      'this identity pre-approved'
  )

  const preApproved = received(alice, 'pending')
    .flatMap(f => f.msg.requests)
    .filter(r => r.standing === 'pre-approved')
  assert(
    preApproved.length >= 1,
    'no pre-approved request ever reached A'
  )

  // Nothing here clicks anything. Either the row was committed without
  // a prompt and is gone, or it is still sitting on A's page waiting
  // for one.
  await sleep(3000)
  const rows = await pendingOf(alice.page)
  const status = await textOf(alice.page, 'section.room p.status')

  assert(
    rows.length === 0,
    `A is still showing ${rows.length} request(s) ` +
      `(${rows.map(r => `${r.name}/${r.standing}`).join(', ')}) ` +
      `with status "${status}"`
  )
  // Which path cleared it matters. An empty list with a
  // "Could not approve that" beside it is the defect, not the fix.
  assert(
    status === 'Fred is already in the group.',
    `A's status reads "${status}"`
  )
})

await check('no page logged an uncaught error', async () => {
  const bad = profiles
    .map(p => ({ name: p.name, errors: realErrors(p) }))
    .filter(p => p.errors.length > 0)

  assert(
    bad.length === 0,
    bad.map(p => `${p.name}: ${p.errors.join(' | ')}`).join(' || ')
  )
})

// --- teardown ---------------------------------------------------------

for (const profile of profiles) {
  await profile.context.close()
  rmSync(profile.dir, { recursive: true, force: true })
}

console.log('')
if (notes.length > 0) {
  console.log('Notes:')
  for (const text of notes) console.log(`- ${text}`)
  console.log('')
}
console.log(`Passed: ${passCount}`)
console.log(`Failed: ${failCount}`)
process.exit(failCount > 0 ? 1 : 0)

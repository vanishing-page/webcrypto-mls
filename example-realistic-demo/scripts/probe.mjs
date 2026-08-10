#!/usr/bin/env node

/**
 * Operational probe for realistic-demo room verification.
 * Tests AC1.1, AC1.3, AC1.4, AC1.5, AC2.4, AC8.3, AC9.1, AC9.2 and the
 * phase 5 join, ledger, authorization and expiry criteria by running
 * twenty-six checks against a live Worker. Uses a fresh random room ID
 * per run.
 */

import crypto from 'node:crypto'

const baseUrl = process.argv[2] || 'http://localhost:8787'
let passCount = 0
let failCount = 0
const roomId = crypto.randomUUID().slice(0, 10)

console.log(`Room ID: ${roomId}`)
console.log(`Base URL: ${baseUrl}`)
console.log('')

async function check (num, name, fn) {
  try {
    await fn()
    console.log(`Check ${num}: PASS - ${name}`)
    passCount++
  } catch (err) {
    console.log(`Check ${num}: FAIL - ${name}`)
    console.log(`  Error: ${err.message}`)
    failCount++
  }
}

function assert (condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

// Check 1: GET /api/room/<valid-unused-id> returns 404
await check(1, '404 for unused room id', async () => {
  const res = await fetch(`${baseUrl}/api/room/${roomId}`)
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

// Check 2: GET /api/room/<invalid-id> returns 400 for invalid ids
await check(2, '400 for invalid room ids', async () => {
  const invalidIds = [
    'abcdefgh..', // contains . (10 chars)
    'abcdefghjk+', // contains + (11 chars, wrong length too)
    'abc', // too short (3 chars)
    'api', // reserved word
    // The slash is the one that matters: it is what a path traversal
    // attempt looks like. It must be 400 like any other malformed id,
    // not 404, so a traversal-shaped request is distinguishable from a
    // plain typo in the logs.
    'ab/cdefgh',
    'ab%2Fcdefgh' // the encoded form of the same thing
    // A literal `../../etc/passwd` is deliberately NOT tested here. The
    // URL parser removes dot segments before the request is sent, so it
    // normalises to /etc/passwd and never reaches /api/room/ at all --
    // it is answered by the SPA fallback with index.html, which is
    // correct. Traversal cannot be expressed in that shape; the two
    // above are the shapes that actually arrive.
  ]

  for (const id of invalidIds) {
    const res = await fetch(`${baseUrl}/api/room/${id}`)
    assert(res.status === 400, `id "${id}" should return 400, got ${res.status}`)
  }

  // The same must hold on the socket path, before any upgrade check.
  const res = await fetch(`${baseUrl}/api/room/ab/cdefgh/ws`)
  assert(res.status === 400, `slash id on /ws should be 400, got ${res.status}`)
})

// Helper to wrap WebSocket in a promise for easier async handling.
// Defaults to the phase 4 room; the phase 5 suite passes its own.
function openSocket (id = roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/api/room/${id}/ws`)
    ws.onerror = () => reject(new Error('socket error'))
    ws.onopen = () => resolve(ws)
  })
}

// Not every frame is JSON: the hibernation keepalive answers a literal
// "pong". A handler that threw on it would surface as an unhandled error
// rather than as a failed check.
function safeParse (data) {
  try {
    const msg = JSON.parse(data)
    return (msg && typeof msg === 'object') ? msg : null
  } catch (_err) {
    return null
  }
}

// Helper to wait for a message of a specific type
function waitForMessage (ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timeout waiting for ${type} message`)),
      timeoutMs
    )
    const handler = (event) => {
      const msg = safeParse(event.data)
      if (msg?.type === type) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
  })
}

// Gather every message of a type arriving inside a window. This is for
// the negatives -- "four rejections and nothing else", "no second
// Welcome" -- which have no single event to wait on.
function collect (ws, type, ms = 400) {
  return new Promise(resolve => {
    const seen = []
    const handler = (event) => {
      const msg = safeParse(event.data)
      if (msg?.type === type) seen.push(msg)
    }
    ws.addEventListener('message', handler)
    setTimeout(() => {
      ws.removeEventListener('message', handler)
      resolve(seen)
    }, ms)
  })
}

// Record the order message types arrive in, so an ordering rule can be
// asserted rather than assumed.
function recordOrder (ws) {
  const order = []
  const handler = (event) => {
    const msg = safeParse(event.data)
    if (msg) order.push(msg.type)
  }
  ws.addEventListener('message', handler)
  return { order, stop: () => ws.removeEventListener('message', handler) }
}

// Wait for a message of a type that also satisfies a predicate. Needed
// because a roster arrives on several occasions and the interesting one
// is usually not the first.
function waitForMatch (ws, type, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timeout waiting for matching ${type}`)),
      timeoutMs
    )
    const handler = (event) => {
      const msg = safeParse(event.data)
      if (msg?.type === type && predicate(msg)) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
  })
}

// Resolve when the socket closes. A close is a condition like any other;
// sleeping past it makes the probe timing-sensitive.
function waitForClose (ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    const timeout = setTimeout(
      () => reject(new Error('timeout waiting for close')),
      timeoutMs
    )
    ws.addEventListener('close', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

// Check 3: Open socket, send create, assert created reply
let socketA
let createdReply

await check(3, 'socket create returns created message', async () => {
  socketA = await openSocket()
  const roster = waitForMessage(socketA, 'roster')
  socketA.send(JSON.stringify({
    type: 'create',
    identity: 'A'
  }))
  createdReply = await waitForMessage(socketA, 'created')
  assert(typeof createdReply.creatorToken === 'string', 'missing creatorToken')
  assert(typeof createdReply.expiresAt === 'number', 'missing expiresAt')
  assert(createdReply.expiresAt > Date.now(), 'expiresAt must be in future')

  // Assert the roster CONTAINS the creator, not merely that it lacks
  // someone. Every absence assertion in this file passes trivially if
  // broadcastRoster returns a constant empty array, so without this one
  // the whole liveness feature could be deleted with the probe green.
  const first = await roster
  assert(
    JSON.stringify(first.live) === JSON.stringify(['A']),
    `expected roster ["A"], got ${JSON.stringify(first.live)}`
  )
})

// Check 4: GET /api/room/<id> returns 200 with times
await check(4, 'GET /api/room/:id returns 200 with times', async () => {
  const res = await fetch(`${baseUrl}/api/room/${roomId}`)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(typeof body.createdAt === 'number', 'missing createdAt')
  assert(typeof body.expiresAt === 'number', 'missing expiresAt')
  assert(body.expiresAt > body.createdAt, 'expiresAt must be after createdAt')
})

// Check 5: Send 3 mls messages, open socket B with cursor 0, verify log
// kind must be one of the three EntryKind values in protocol.ts. Anything
// else is rejected by isClientMessage before the room ever sees it, which
// is correct -- but it means a probe using invented kinds tests nothing.
const messages = [
  { kind: 'commit', payload: 'Zm9vLWdyb3VwLWluZm8=' }, // base64 padding
  { kind: 'proposal', payload: 'd2VsY29tZS1wYXlsb2Fk' },
  { kind: 'application', payload: 'YWRkLWVudHJ5LWhlcmU=' }
]

// Everything below needs socketA. If check 3 failed, socketA is
// undefined and sending on it would throw outside every check(),
// aborting the run with a stack trace instead of a summary.
if (!socketA) {
  console.log('')
  console.log('Check 3 failed, so no later check can run.')
  console.log(`Results: ${passCount} passed, ${failCount} failed`)
  process.exit(1)
}

// Send messages from A
messages.forEach(msg => {
  socketA.send(JSON.stringify({
    type: 'mls',
    kind: msg.kind,
    payload: msg.payload
  }))
})

let socketB
let logReply

await check(5, 'log entries round-trip byte-identical', async () => {
  socketB = await openSocket()
  socketB.send(JSON.stringify({
    type: 'hello',
    identity: 'B',
    cursor: 0
  }))
  logReply = await waitForMessage(socketB, 'log')

  assert(logReply.entries, 'missing entries in log reply')
  assert(logReply.entries.length === 3, `expected 3 entries, got ${logReply.entries.length}`)

  for (let i = 0; i < 3; i++) {
    const entry = logReply.entries[i]
    const expected = messages[i]
    assert(entry.seq === i + 1, `entry ${i} seq: expected ${i + 1}, got ${entry.seq}`)
    assert(entry.sender === 'A', `entry ${i} sender: expected A, got ${entry.sender}`)
    assert(entry.kind === expected.kind, `entry ${i} kind: expected "${expected.kind}", got "${entry.kind}"`)
    assert(entry.payload === expected.payload, `entry ${i} payload mismatch`)
  }
})

// Check 6: Send 4th mls, assert every socket receives it, the sender
// included, and that all of them are told the same seq.
//
// The sender is the one client that cannot decrypt this entry -- MLS
// cannot open a message it produced -- and the room withheld it from the
// sender for exactly that reason until Phase 8. Withholding it strands
// the sender's cursor: a cursor may only advance by one and may never
// skip a gap (realistic-demo.AC10.4), so a client that never sees its
// own write is stuck below it for good and reads the next entry from
// anybody else as a gap. Echoing to everyone is what makes live delivery
// and replay the same shape; the client recognises its own entry by
// `sender` and renders it from the plaintext it recorded at send time.
await check(6, 'an entry reaches every socket, its sender included',
  async () => {
    const aEntry = waitForMatch(socketA, 'entry', m => m.entry.seq === 4)
    const bEntry = waitForMatch(socketB, 'entry', m => m.entry.seq === 4)

    socketA.send(JSON.stringify({
      type: 'mls',
      kind: 'commit',
      payload: 'Y29tbWl0LWVudHJ5'
    }))

    // Both are positive waits, so neither needs a settle. The check
    // fails by timing out rather than by racing a clock.
    const [mine, theirs] = await Promise.all([aEntry, bEntry])

    assert(
      mine.entry.sender === 'A',
      `sender's own copy: expected sender A, got ${mine.entry.sender}`
    )
    assert(
      theirs.entry.sender === 'A',
      `B's copy: expected sender A, got ${theirs.entry.sender}`
    )
    // One log, one numbering. A sender told a different seq from
    // everybody else would advance its cursor to a number that means
    // something different in every other client.
    assert(
      mine.entry.payload === theirs.entry.payload &&
      mine.entry.kind === theirs.entry.kind,
      'the sender was handed a different entry from everybody else'
    )
  })

// Check 7: Reconnect B with cursor 3, verify replay contains only seq 4
let socketB2
let logReply2

await check(7, 'replay returns only entries after cursor', async () => {
  socketB2 = await openSocket()
  socketB2.send(JSON.stringify({
    type: 'hello',
    identity: 'B',
    cursor: 3
  }))
  logReply2 = await waitForMessage(socketB2, 'log')

  assert(logReply2.entries.length === 1, `expected 1 entry, got ${logReply2.entries.length}`)
  assert(logReply2.entries[0].seq === 4, `expected seq 4, got ${logReply2.entries[0].seq}`)
})

// Check 8: Open third socket as B, assert socket from check 7 closes,
// and roster doesn't list B twice
await check(8, 'second socket for same identity replaces first', async () => {
  let socketB2Closed = false
  let rosterMsg = null

  const closeHandler = () => {
    socketB2Closed = true
  }

  const rosterHandler = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'roster') {
      rosterMsg = msg
    }
  }

  socketB2.addEventListener('close', closeHandler)
  // The roster is read on A, not on B2. B2 is the socket being replaced,
  // so it is closed before the broadcast goes out and can never observe
  // it. A is the creator's socket and stays open throughout.
  socketA.addEventListener('message', rosterHandler)
  const nextRoster = waitForMessage(socketA, 'roster')

  const socketB3 = await openSocket()
  socketB3.send(JSON.stringify({
    type: 'hello',
    identity: 'B',
    cursor: 0
  }))

  // Conditions, not clocks: the replaced socket must actually close, and
  // a roster must actually arrive.
  await waitForClose(socketB2)
  await nextRoster

  socketB2.removeEventListener('close', closeHandler)
  socketA.removeEventListener('message', rosterHandler)
  socketB3.close()

  assert(socketB2Closed, 'socket from check 7 did not close')
  assert(rosterMsg, 'no roster received')

  // Exact contents, not an absence. B is a joiner, and at this phase
  // assembleRoster filters by `known`, which holds only the creator
  // until Phase 5 adds the admitted ledger -- so B legitimately never
  // appears. Asserting "B is not listed twice" would therefore pass even
  // if the roster were hardcoded empty. Asserting the exact array is
  // what makes this check capable of failing.
  assert(
    JSON.stringify(rosterMsg.live) === JSON.stringify(['A']),
    `expected roster ["A"], got ${JSON.stringify(rosterMsg.live)}`
  )
})

// Check 9: a real disconnect drops the departed identity from the next
// roster. This is the phase's Step 4, automated so it is repeatable.
//
// Only the creator appears in a roster at this phase: assembleRoster
// filters the live identities by `known`, and `known` is just the
// creator until Phase 5 adds the admitted ledger. So the departure that
// is observable here is the creator's, watched from a joiner's socket.
await check(9, 'a disconnect drops the identity from the roster', async () => {
  const watcher = await openSocket()
  // The watcher's own hello triggers a roster naming the still-connected
  // creator. Capturing it is what makes this check bidirectional: it
  // pins the roster BEFORE the disconnect as well as after, so a roster
  // that is always empty fails here rather than passing.
  const beforeRoster = waitForMessage(watcher, 'roster')
  watcher.send(JSON.stringify({
    type: 'hello',
    identity: 'WATCHER',
    cursor: 0
  }))
  const before = await beforeRoster
  assert(
    before.live.includes('A'),
    `roster before the disconnect should list A, got ${JSON.stringify(before.live)}`
  )

  // A is the creator, so it is the identity the roster reports.
  const afterRoster = waitForMatch(
    watcher,
    'roster',
    (m) => !m.live.includes('A')
  )
  socketA.close()
  const after = await afterRoster

  assert(
    JSON.stringify(after.live) === JSON.stringify([]),
    `roster after the disconnect should be empty, got ${JSON.stringify(after.live)}`
  )
  watcher.close()
})

// Check 10: the hibernation keepalive answers without waking the object.
await check(10, 'ping is auto-answered with pong', async () => {
  const socket = await openSocket()
  const pong = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no pong')), 5000)
    socket.addEventListener('message', (event) => {
      if (event.data === 'pong') {
        clearTimeout(timer)
        resolve(event.data)
      }
    })
  })
  socket.send('ping')
  const reply = await pong
  assert(reply === 'pong', `expected "pong", got ${JSON.stringify(reply)}`)
  socket.close()
})

// -----------------------------------------------------------------
// Phase 5: asynchronous join, the identity ledger, and expiry.
//
// A second room, so none of this depends on the state checks 1-10 left
// behind, and neither suite can mask a failure in the other.
// -----------------------------------------------------------------

const roomId2 = crypto.randomUUID().slice(0, 10)
console.log('')
console.log(`Room ID (phase 5): ${roomId2}`)
console.log('')

// The four messages that write to the ledger or the mailbox. Every one
// of them must be creator-only.
function controlMessages (target) {
  return [
    { type: 'approve', identity: target },
    { type: 'deny', identity: target },
    { type: 'removed', identity: target },
    { type: 'welcome', to: target, payload: 'd2VsY29tZS1wYXlsb2Fk' }
  ]
}

let creatorToken
let creator

await check(11, 'the creator token gates every control message',
  async () => {
    const socketC = await openSocket(roomId2)
    socketC.send(JSON.stringify({ type: 'create', identity: 'C' }))
    const created = await waitForMessage(socketC, 'created')
    creatorToken = created.creatorToken
    assert(typeof creatorToken === 'string', 'no creatorToken issued')

    // No token at all. Target B, whose standing later checks depend on:
    // if any of these were accepted, B would be admitted or removed and
    // checks 12-14 would fail, so this is not only asserted here.
    const stranger = await openSocket(roomId2)
    stranger.send(JSON.stringify({
      type: 'hello', identity: 'E', cursor: 0
    }))
    const strangerState = await waitForMessage(stranger, 'room-state')
    assert(
      strangerState.isCreator === false,
      'a socket with no token must not be told it is the creator'
    )
    const noTokenErrors = collect(stranger, 'error')
    for (const msg of controlMessages('B')) {
      stranger.send(JSON.stringify(msg))
    }
    const got1 = await noTokenErrors
    assert(
      got1.length === 4,
      `no token: expected 4 rejections, got ${got1.length}`
    )
    assert(
      got1.every(e => e.reason === 'not-creator'),
      `no token: expected not-creator, got ${JSON.stringify(got1)}`
    )
    stranger.close()

    // The creator's own identity, with the wrong token. This is the
    // sharp case, and the one phase 4 got wrong: an identity is a public
    // signature key that everyone in the room has seen, so claiming it
    // must buy nothing at all.
    const impostor = await openSocket(roomId2)
    impostor.send(JSON.stringify({
      type: 'hello',
      identity: 'C',
      cursor: 0,
      creatorToken: 'not-the-real-token'
    }))
    const impostorState = await waitForMessage(impostor, 'room-state')
    assert(
      impostorState.isCreator === false,
      'a wrong token must not report isCreator'
    )
    const wrongTokenErrors = collect(impostor, 'error')
    for (const msg of controlMessages('B')) {
      impostor.send(JSON.stringify(msg))
    }
    const got2 = await wrongTokenErrors
    assert(
      got2.length === 4,
      `wrong token: expected 4 rejections, got ${got2.length}`
    )
    assert(
      got2.every(e => e.reason === 'not-creator'),
      `wrong token: expected not-creator, got ${JSON.stringify(got2)}`
    )
    impostor.close()

    // The real token, on a socket that did not create the room -- so it
    // is the token being checked, not the create-time attachment.
    // Targets a throwaway identity to keep B's ledger clean.
    creator = await openSocket(roomId2)
    creator.send(JSON.stringify({
      type: 'hello', identity: 'C', cursor: 0, creatorToken
    }))
    const creatorState = await waitForMessage(creator, 'room-state')
    assert(
      creatorState.isCreator === true,
      'the correct token must report isCreator'
    )
    const acceptedErrors = collect(creator, 'error')
    for (const msg of controlMessages('THROWAWAY')) {
      creator.send(JSON.stringify(msg))
    }
    const got3 = await acceptedErrors
    assert(
      got3.length === 0,
      `correct token: expected no rejection, got ${JSON.stringify(got3)}`
    )
  })

// Everything below needs the creator socket and its token.
if (!creator || !creatorToken) {
  console.log('')
  console.log('Check 11 failed, so checks 12-19 cannot run.')
  console.log(`Results: ${passCount} passed, ${failCount} failed`)
  process.exit(1)
}

const KEY_PACKAGE_1 = 'a2V5LXBhY2thZ2UtMQ=='
const KEY_PACKAGE_2 = 'a2V5LXBhY2thZ2UtMg=='

await check(12, 'a join request survives its requester leaving',
  async () => {
    const b = await openSocket(roomId2)
    b.send(JSON.stringify({
      type: 'join-request',
      identity: 'B',
      keyPackage: KEY_PACKAGE_1
    }))
    await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === 'B'))

    // B leaves entirely. Nothing of B remains connected.
    b.close()
    await waitForClose(b)

    // And the creator leaves too, so what is read back on the next visit
    // came out of storage rather than off a socket either party held.
    creator.close()
    creator = await openSocket(roomId2)
    creator.send(JSON.stringify({
      type: 'hello', identity: 'C', cursor: 0, creatorToken
    }))
    const pending = await waitForMessage(creator, 'pending')

    const entry = pending.requests.find(r => r.identity === 'B')
    assert(entry, `B is not pending after both parties left: ${
      JSON.stringify(pending.requests)}`)
    assert(
      entry.keyPackage === KEY_PACKAGE_1,
      `key package not intact, got ${entry.keyPackage}`
    )
    assert(
      entry.standing === 'stranger',
      `expected standing stranger, got ${entry.standing}`
    )
  })

await check(13, 'a repeat request replaces rather than duplicating',
  async () => {
    const b = await openSocket(roomId2)
    // The pending list carries every requester's key package, so it must
    // reach the creator and nobody else. B is a non-creator with a live
    // socket at the exact moment the list is sent.
    const leakedToB = collect(b, 'pending', 600)
    b.send(JSON.stringify({
      type: 'join-request',
      identity: 'B',
      keyPackage: KEY_PACKAGE_2
    }))
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => {
        return r.identity === 'B' && r.keyPackage === KEY_PACKAGE_2
      }))
    assert(
      (await leakedToB).length === 0,
      'the pending list was sent to a socket that is not the creator'
    )

    const forB = pending.requests.filter(r => r.identity === 'B')
    assert(
      forB.length === 1,
      `expected exactly one entry for B, got ${forB.length}`
    )
    assert(
      forB[0].keyPackage === KEY_PACKAGE_2,
      'the second request must replace the first key package'
    )
    b.close()
    await waitForClose(b)
  })

await check(14, 'denial discards the request and records no admission',
  async () => {
    creator.send(JSON.stringify({ type: 'deny', identity: 'B' }))
    await waitForMatch(creator, 'pending',
      m => !m.requests.some(r => r.identity === 'B'))

    // Denial is not removal. A denied identity was never admitted, so it
    // is still a stranger and may ask again.
    const b = await openSocket(roomId2)
    b.send(JSON.stringify({
      type: 'join-request',
      identity: 'B',
      keyPackage: KEY_PACKAGE_1
    }))
    const again = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === 'B'))

    const entry = again.requests.find(r => r.identity === 'B')
    assert(
      entry.standing === 'stranger',
      `denial is not removal: expected stranger, got ${entry.standing}`
    )
    // Awaited, not fired and forgotten. If a socket for B is still open
    // when check 15 issues its Welcome, deliverMailbox hands the Welcome
    // to that socket and deletes the row, so the B check 15 opens for
    // itself never receives one -- an intermittent failure in a later
    // check caused by an earlier one's litter.
    b.close()
    await waitForClose(b)
  })

await check(15, 'a Welcome survives absence, and is consumed once',
  async () => {
    // A witness reports the seq the room actually assigned, so the
    // cursor assertion below is against the real high-water mark rather
    // than a number this script counted for itself.
    const witness = await openSocket(roomId2)
    witness.send(JSON.stringify({
      type: 'hello', identity: 'WIT', cursor: 0
    }))
    await waitForMessage(witness, 'room-state')

    // Two application messages and then the commit. The two are what
    // priorCount must count; the commit is what it must not.
    creator.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'bXNnLW9uZQ=='
    }))
    creator.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'bXNnLXR3bw=='
    }))
    creator.send(JSON.stringify({
      type: 'mls', kind: 'commit', payload: 'dGhlLWNvbW1pdA=='
    }))
    const commit = await waitForMatch(witness, 'entry',
      m => m.entry.kind === 'commit')
    const commitSeq = commit.entry.seq

    // B is not connected. The Welcome has to wait in the mailbox.
    creator.send(JSON.stringify({
      type: 'welcome', to: 'B', payload: 'V0VMQ09NRS1QQVlMT0FE'
    }))

    const b = await openSocket(roomId2)
    const seen = recordOrder(b)
    b.send(JSON.stringify({ type: 'hello', identity: 'B', cursor: 0 }))

    const welcome = await waitForMessage(b, 'welcome-you')
    assert(
      welcome.payload === 'V0VMQ09NRS1QQVlMT0FE',
      'welcome payload did not round-trip'
    )
    assert(
      welcome.cursor === commitSeq,
      `welcome cursor: expected the commit's seq ${commitSeq}, got ${
        welcome.cursor}`
    )
    assert(
      welcome.priorCount === 2,
      `priorCount: expected the 2 application entries, got ${
        welcome.priorCount}`
    )

    // The log batch must arrive after the Welcome. A joiner connects at
    // cursor 0, so the other order hands it the whole log before the
    // Welcome that makes any of it processable.
    await waitForMessage(b, 'log')
    seen.stop()
    const welcomeAt = seen.order.indexOf('welcome-you')
    const logAt = seen.order.indexOf('log')
    assert(
      welcomeAt !== -1 && logAt !== -1,
      `expected both welcome-you and log, saw ${seen.order.join(',')}`
    )
    assert(
      welcomeAt < logAt,
      `welcome-you must precede log, saw ${seen.order.join(',')}`
    )

    b.close()
    await waitForClose(b)

    // Consumed once. Replaying it would try to rejoin a group the client
    // is already in.
    const b2 = await openSocket(roomId2)
    b2.send(JSON.stringify({ type: 'hello', identity: 'B', cursor: 0 }))
    await waitForMessage(b2, 'room-state')
    const repeats = await collect(b2, 'welcome-you', 600)
    assert(
      repeats.length === 0,
      'the Welcome was delivered a second time'
    )
    b2.close()
    witness.close()
  })

await check(16, 'standing after removal is previously-removed',
  async () => {
    creator.send(JSON.stringify({ type: 'approve', identity: 'B' }))
    creator.send(JSON.stringify({ type: 'removed', identity: 'B' }))

    const b = await openSocket(roomId2)
    b.send(JSON.stringify({
      type: 'join-request',
      identity: 'B',
      keyPackage: KEY_PACKAGE_2
    }))
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === 'B'))

    const entry = pending.requests.find(r => r.identity === 'B')
    assert(
      entry.standing === 'previously-removed',
      `expected previously-removed, got ${entry.standing}`
    )
    b.close()
    await waitForClose(b)
  })

await check(17, 'a new room expires three days out', async () => {
  const freshId = crypto.randomUUID().slice(0, 10)
  const s = await openSocket(freshId)
  const before = Date.now()
  s.send(JSON.stringify({ type: 'create', identity: 'X' }))
  const created = await waitForMessage(s, 'created')

  const threeDays = 3 * 24 * 60 * 60 * 1000
  const drift = Math.abs(created.expiresAt - (before + threeDays))
  assert(
    drift < 60000,
    `expiresAt is ${drift}ms away from three days out`
  )
  s.close()
})

// Check 18 is not in the plan. It covers a hole the plan's own token
// makes closable for the first time: replaceExistingSocket matches on
// identity alone, so before this, anyone could evict the creator's live
// socket just by saying hello as them.
await check(18, 'an untokened claim cannot evict the creator', async () => {
  let creatorClosed = false
  const closeHandler = () => { creatorClosed = true }
  creator.addEventListener('close', closeHandler)

  const impostor = await openSocket(roomId2)
  impostor.send(JSON.stringify({
    type: 'hello', identity: 'C', cursor: 0
  }))
  await waitForMessage(impostor, 'room-state')

  // A negative with no event to wait for. Sound here because the
  // eviction it would race with happens inside the same hello the
  // room-state above already answered.
  await new Promise(r => setTimeout(r, 300))

  creator.removeEventListener('close', closeHandler)
  impostor.close()
  assert(
    !creatorClosed,
    "the creator's socket was evicted by a claim carrying no token"
  )
})

// Check 19 is not in the plan either. Task 4 Step 5 extends the roster's
// `known` set with admitted-minus-removed, and nothing above would notice
// if that line were reverted: every other roster assertion in this file
// concerns the creator, who is known either way. A fresh identity is the
// only way to make the extension observable.
await check(19, 'an admitted identity joins the roster, a removed one leaves',
  async () => {
    const d = await openSocket(roomId2)
    // Registered before the hello that triggers it. Awaiting D's
    // room-state first would let the roster reach the creator before
    // anything was listening for it.
    const rosterOnJoin = waitForMessage(creator, 'roster')
    d.send(JSON.stringify({ type: 'hello', identity: 'D', cursor: 0 }))
    await waitForMessage(d, 'room-state')

    // Connected but not admitted: live, and still not on the roster.
    const beforeApproval = await rosterOnJoin
    assert(
      !beforeApproval.live.includes('D'),
      `D is live but unapproved and must not be listed, got ${
        JSON.stringify(beforeApproval.live)}`
    )

    // The load-bearing assertion. This is the one that fails if `known`
    // goes back to holding only the creator.
    creator.send(JSON.stringify({ type: 'approve', identity: 'D' }))
    const afterApproval = await waitForMatch(creator, 'roster',
      m => m.live.includes('D'))
    assert(
      afterApproval.live.includes('D'),
      'an admitted, connected identity must appear on the roster'
    )

    // Removal wins over admission.
    creator.send(JSON.stringify({ type: 'removed', identity: 'D' }))
    const afterRemoval = await waitForMatch(creator, 'roster',
      m => !m.live.includes('D'))
    assert(
      !afterRemoval.live.includes('D'),
      'a removed identity must drop off the roster even while connected'
    )

    // Re-approval is a supported flow -- `previously-removed` exists so
    // the creator can weigh letting someone back in -- and the roster
    // has to survive it. The ledger's removed row is never cleared by
    // anything else, and `known` subtracts removed from admitted, so an
    // approve that leaves the row behind readmits a member who is
    // permanently invisible on the roster.
    creator.send(JSON.stringify({ type: 'approve', identity: 'D' }))
    const afterReapproval = await waitForMatch(creator, 'roster',
      m => m.live.includes('D'))
    assert(
      afterReapproval.live.includes('D'),
      're-approving a removed identity must restore it to the roster'
    )
    d.close()
    await waitForClose(d)
  })

// Check 20 settles carry-forward finding 2b. Before the gate, any socket
// that had said hello could append to the log. Nothing else in this file
// would notice the gate being deleted: every other `mls` send in the probe
// comes from a creator, who may write either way.
await check(20, 'the ledger gates who may write to the log', async () => {
  // 20a. A stranger: connected, never admitted, must be refused.
  const outsider = await openSocket(roomId2)
  outsider.send(JSON.stringify({
    type: 'hello', identity: 'F', cursor: 0
  }))
  await waitForMessage(outsider, 'room-state')

  const strangerEntries = collect(creator, 'entry')
  const strangerErrors = collect(outsider, 'error')
  outsider.send(JSON.stringify({
    type: 'mls', kind: 'application', payload: 'c3RyYW5nZXI='
  }))
  const errs = await strangerErrors
  assert(
    errs.length === 1 && errs[0].reason === 'not-member',
    `stranger: expected one not-member, got ${JSON.stringify(errs)}`
  )
  // Rejected means not written, not merely not acknowledged.
  const seen = await strangerEntries
  assert(
    !seen.some(m => m.entry.sender === 'F'),
    'a refused write still reached the log'
  )

  // 20b. The creator, who is never in the ledger, must still write. A
  // gate that only consulted `admitted` would lock the one identity that
  // has to be able to commit out of its own room.
  const creatorEntry = waitForMatch(outsider, 'entry',
    m => m.entry.sender === 'C')
  creator.send(JSON.stringify({
    type: 'mls', kind: 'commit', payload: 'Y3JlYXRvcg=='
  }))
  await creatorEntry

  // 20c. An admitted member writes. D was approved in check 19.
  const member = await openSocket(roomId2)
  member.send(JSON.stringify({ type: 'hello', identity: 'D', cursor: 0 }))
  await waitForMessage(member, 'room-state')
  const memberEntry = waitForMatch(creator, 'entry',
    m => m.entry.sender === 'D')
  member.send(JSON.stringify({
    type: 'mls', kind: 'application', payload: 'bWVtYmVy'
  }))
  await memberEntry

  // 20d. Removal wins over admission. B was approved and then removed in
  // check 16, so B's `admitted` row is still there.
  const removed = await openSocket(roomId2)
  removed.send(JSON.stringify({ type: 'hello', identity: 'B', cursor: 0 }))
  await waitForMessage(removed, 'room-state')
  const removedErrors = collect(removed, 'error')
  removed.send(JSON.stringify({
    type: 'mls', kind: 'application', payload: 'cmVtb3ZlZA=='
  }))
  const errs2 = await removedErrors
  assert(
    errs2.length === 1 && errs2[0].reason === 'not-member',
    `removed: expected one not-member, got ${JSON.stringify(errs2)}`
  )

  outsider.close()
  await waitForClose(outsider)
  member.close()
  await waitForClose(member)
  removed.close()
  await waitForClose(removed)
})

// Checks 21 to 23 close the last acceptance criteria that had no
// standing automated check: each was resting on a browser step recorded
// in progress.log, which verifies the behaviour once and then cannot
// notice it breaking. They need no creator socket, but they are numbered
// last rather than inserted, because checks 3-20 are named by number in
// HANDOFF.md and in this branch's log.

await check(21, 'a second create on an existing room is refused',
  async () => {
    const freshId = crypto.randomUUID().slice(0, 10)

    const first = await openSocket(freshId)
    first.send(JSON.stringify({ type: 'create', identity: 'P' }))
    const made = await waitForMessage(first, 'created')
    assert(typeof made.creatorToken === 'string', 'no token on the first')

    // A separate socket, so this is the room's metadata refusing the
    // second create rather than one socket's attachment doing it.
    const second = await openSocket(freshId)
    const refusals = collect(second, 'error')
    const alsoCreated = collect(second, 'created')
    second.send(JSON.stringify({ type: 'create', identity: 'Q' }))

    const errs = await refusals
    assert(
      errs.length === 1 && errs[0].reason === 'room-exists',
      `expected one room-exists, got ${JSON.stringify(errs)}`
    )

    // The refusal is only half of it. A second create that answered
    // room-exists and issued a token anyway would hand the room to
    // whoever asked second, so assert no token came back as well.
    const tokens = await alsoCreated
    assert(
      tokens.length === 0,
      `a refused create must issue no token, got ${JSON.stringify(tokens)}`
    )

    // And the room still belongs to whoever made it: the first token is
    // still the one the room accepts.
    const back = await openSocket(freshId)
    back.send(JSON.stringify({
      type: 'hello',
      identity: 'P',
      cursor: 0,
      creatorToken: made.creatorToken
    }))
    const state = await waitForMessage(back, 'room-state')
    assert(
      state.isCreator === true,
      'the original creator token stopped working after the refusal'
    )

    first.close()
    await waitForClose(first)
    second.close()
    await waitForClose(second)
    back.close()
    await waitForClose(back)
  })

await check(22, 'a hello to a room that was never made answers no-room',
  async () => {
    // A well-formed, unused id: the route accepts it, so this reaches
    // the Durable Object and is answered by onHello's metadata check
    // rather than by the id validation in the fetch handler.
    const unusedId = crypto.randomUUID().slice(0, 10)
    const s = await openSocket(unusedId)

    const states = collect(s, 'room-state')
    s.send(JSON.stringify({ type: 'hello', identity: 'Z', cursor: 0 }))
    const gone = await waitForMessage(s, 'no-room')

    // The frame carries nothing but its type. That is what makes an
    // expired room and an id that never existed indistinguishable from
    // outside -- a field naming either case here would give it away.
    // The expired half of this criterion is not reachable without
    // editing the Worker; HANDOFF.md records how it was verified.
    assert(
      Object.keys(gone).length === 1,
      `no-room should carry only its type, got ${JSON.stringify(gone)}`
    )

    // A room that answered both would have told this socket it is in a
    // room that does not exist.
    const answered = await states
    assert(
      answered.length === 0,
      `expected no room-state, got ${JSON.stringify(answered)}`
    )

    s.close()
    await waitForClose(s)
  })

await check(23, 'an unshared path is served the page, not a 404',
  async () => {
    // The invitation link is a bare room id at the origin. Nothing in
    // the Worker answers it: `not_found_handling` in wrangler.jsonc is
    // what turns an unmatched path into the app shell, and
    // `run_worker_first` is what keeps `/api/*` out of that. Both are
    // configuration, so nothing else in this repository would notice
    // either of them being dropped -- and dropping the first 404s every
    // link the demo hands out.
    const shell = await fetch(baseUrl)
    assert(
      shell.status === 200,
      `GET / should be 200, got ${shell.status}. If this is a fresh ` +
      'checkout, run npm run build:realistic first: wrangler serves ' +
      'the assets from example-realistic-demo/dist.'
    )
    const shellBody = await shell.text()

    // A well-formed room id that has never been created. It must be
    // answered the same page as `/`, because a joiner opens the link
    // before the client has spoken to the room at all.
    const linkId = crypto.randomUUID().slice(0, 10)
    const link = await fetch(`${baseUrl}/${linkId}`)
    assert(
      link.status === 200,
      `GET /${linkId} should be 200, got ${link.status}`
    )
    assert(
      (await link.text()) === shellBody,
      'an unmatched path should be served the same page as /'
    )

    // The other half, and the reason this is one check: the fallback
    // must not reach into the API namespace. The same id under
    // /api/room/ is still a 404, so a room that does not exist is
    // distinguishable from a page that does.
    const api = await fetch(`${baseUrl}/api/room/${linkId}`)
    assert(
      api.status === 404,
      `the SPA fallback swallowed the API: got ${api.status}, not 404`
    )
  })

// The join-request limits. The cap itself is proved in Node against
// classifyJoinRequest, where sixty-five requests cost nothing; what these
// two checks prove is that the Worker actually consults the rule and that
// a refusal writes nothing.
let limited
await check(24, 'an oversized key package is refused and stored nowhere',
  async () => {
    limited = await openSocket(roomId2)
    limited.send(JSON.stringify({
      type: 'join-request',
      identity: 'BIG',
      // One over MAX_KEY_PACKAGE_LENGTH.
      keyPackage: 'A'.repeat(16 * 1024 + 1)
    }))
    const refusal = await waitForMessage(limited, 'error')
    assert(
      refusal.reason === 'key-package-too-large',
      `expected key-package-too-large, got ${refusal.reason}`
    )

    // A request that is allowed, from another socket, is what makes the
    // creator's list arrive. BIG's absence from it is the assertion: the
    // refusal above stored nothing.
    const ok = await openSocket(roomId2)
    ok.send(JSON.stringify({
      type: 'join-request',
      identity: 'OK1',
      keyPackage: KEY_PACKAGE_1
    }))
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === 'OK1'))
    assert(
      !pending.requests.some(r => r.identity === 'BIG'),
      'the oversized request was stored anyway'
    )
    ok.close()
    await waitForClose(ok)
  })

await check(25, 'a second join request from one socket is rate limited',
  async () => {
    // Same socket as check 24, whose only request so far was refused --
    // so its throttle window has never started, and this one is allowed.
    limited.send(JSON.stringify({
      type: 'join-request',
      identity: 'RL',
      keyPackage: KEY_PACKAGE_1
    }))
    await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === 'RL'))

    limited.send(JSON.stringify({
      type: 'join-request',
      identity: 'RL2',
      keyPackage: KEY_PACKAGE_2
    }))
    const refusal = await waitForMessage(limited, 'error')
    assert(
      refusal.reason === 'rate-limited',
      `expected rate-limited, got ${refusal.reason}`
    )
    limited.close()
    await waitForClose(limited)
  })

// The wire length bounds (security-audit M1). The bounds themselves are
// proved in Node against isClientMessage; what this proves is that the
// Worker consults them, and that a refused oversized write is not
// merely unacknowledged but unstored. The creator is used deliberately:
// every other gate lets a creator through, so this is the one socket on
// which only the size rule can refuse.
await check(26, 'an oversized mls payload is refused and stored nowhere',
  async () => {
    const entries = collect(creator, 'entry')
    const errors = collect(creator, 'error')

    // One over MAX_PAYLOAD_LENGTH, inside the frame wall, so this is
    // refused by the per-field bound after being parsed.
    const huge = 'A'.repeat(256 * 1024 + 1)
    creator.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: huge
    }))

    // Over MAX_WIRE_MESSAGE_LENGTH, so this one is refused on frame
    // length alone and never parsed.
    creator.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'A'.repeat(400 * 1024)
    }))

    const errs = await errors
    assert(
      errs.length === 2 && errs.every(e => e.reason === 'bad-message'),
      `expected two bad-message, got ${JSON.stringify(errs)}`
    )

    const seen = await entries
    assert(
      !seen.some(m => m.entry.payload.length > 256 * 1024),
      'an oversized payload still reached the log'
    )

    // A payload at the limit is accepted, so the bound is a ceiling and
    // not a ban on large-but-legal MLS traffic.
    const atLimit = 'B'.repeat(256 * 1024)
    const accepted = waitForMatch(creator, 'entry',
      m => m.entry.payload === atLimit)
    creator.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: atLimit
    }))
    await accepted
  })

creator.close()

// Close remaining sockets. Optional, because these are only assigned if
// their opening check got as far as a socket -- and an unguarded call on
// an undefined one would throw out here, outside every check(), losing
// the summary that says which checks failed. Same reason as the socketA
// guard above.
socketB?.close()
socketB2?.close()

// Summary
console.log('')
console.log(`Results: ${passCount} passed, ${failCount} failed`)
process.exit(failCount > 0 ? 1 : 0)

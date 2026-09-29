#!/usr/bin/env node

/**
 * Operational probe for realistic-demo room verification.
 * Tests AC1.1, AC1.3, AC1.4, AC1.5, AC2.4, AC8.3, AC9.1, AC9.2 and the
 * phase 5 join, ledger, authorization and expiry criteria, and the
 * identity proof at `hello` (security-audit-2026-09 H4) and the paged
 * replay (M8), by running thirty-six checks against a live Worker. Uses
 * a fresh random room ID per run.
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
//
// The room challenges every socket the moment it is accepted, so the
// listener for that goes on before the open, not after it: a check that
// waited for the challenge after `onopen` could miss it. `ws.challenge`
// is the promise of it.
function openSocket (id = roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/api/room/${id}/ws`)
    ws.roomId = id
    ws.challenge = new Promise(resolveChallenge => {
      ws.addEventListener('message', function once (event) {
        const msg = safeParse(event.data)
        if (msg?.type !== 'challenge') return
        ws.removeEventListener('message', once)
        resolveChallenge(msg.challenge)
      })
    })
    ws.onerror = () => reject(new Error('socket error'))
    ws.onopen = () => resolve(ws)
  })
}

// The bytes an identity proof signs. A copy of `identityProofMessage`
// in `protocol.ts`, which this script cannot import: a fixed label, the
// room id and the challenge, each prefixed with its 4-byte length.
function identityProofMessage (room, challenge) {
  const enc = new TextEncoder()
  const parts = ['webcrypto-mls realistic demo hello v1', room, challenge]
    .map(part => enc.encode(part))
  const out = new Uint8Array(
    parts.reduce((n, part) => n + 4 + part.length, 0)
  )
  const view = new DataView(out.buffer)
  let at = 0
  for (const part of parts) {
    view.setUint32(at, part.length)
    out.set(part, at + 4)
    at += 4 + part.length
  }
  return out
}

// A fresh Ed25519 identity, as the client makes one: the identity is the
// base64url of the raw public key.
async function makeIdentity () {
  const subtle = crypto.webcrypto.subtle
  const pair = await subtle.generateKey(
    { name: 'Ed25519' }, true, ['sign', 'verify']
  )
  const raw = await subtle.exportKey('raw', pair.publicKey)
  return {
    identity: Buffer.from(raw).toString('base64url'),
    async prove (room, challenge) {
      const sig = await subtle.sign(
        { name: 'Ed25519' },
        pair.privateKey,
        identityProofMessage(room, challenge)
      )
      return Buffer.from(sig).toString('base64url')
    }
  }
}

// Every name the probe says hello as, each a real key. The room refuses
// a `hello` or `create` that does not prove its identity, so an opaque
// label can no longer connect at all; `ID` is the identity on the wire.
const I = {}
for (const name of [
  'A', 'B', 'C', 'D', 'E', 'F', 'WATCHER', 'WIT', 'X', 'P', 'Q', 'Z',
  'OK1', 'LIM', 'THROWAWAY', 'G', 'H'
]) {
  I[name] = await makeIdentity()
}
const ID = name => I[name].identity

// Say hello as `name`, proving it over the challenge this socket was
// issued, for the room the socket was opened on.
async function hello (ws, name, fields = {}) {
  const challenge = await ws.challenge
  ws.send(JSON.stringify({
    type: 'hello',
    identity: ID(name),
    cursor: 0,
    ...fields,
    proof: await I[name].prove(ws.roomId, challenge)
  }))
}

async function create (ws, name) {
  const challenge = await ws.challenge
  ws.send(JSON.stringify({
    type: 'create',
    identity: ID(name),
    proof: await I[name].prove(ws.roomId, challenge)
  }))
}

// A join request is only taken from a socket that proved the identity it
// asks for, so the requester says hello first. Its own room-state is the
// sign the hello landed.
async function joinRequest (ws, name, keyPackage) {
  const ready = waitForMessage(ws, 'room-state')
  await hello(ws, name)
  await ready
  ws.send(JSON.stringify({
    type: 'join-request', identity: ID(name), keyPackage
  }))
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

// A copy of MLS_WRITE_INTERVAL_MS in room-logic.ts (this script cannot
// import TypeScript); change the two together. Writes sent faster than
// this from one socket are refused as rate-limited, so a check that
// sends several in a row waits a little longer than it between them.
const MLS_WRITE_INTERVAL_MS = 50
const pause = ms => new Promise(r => setTimeout(r, ms))
async function sendPaced (ws, frames) {
  for (const [i, frame] of frames.entries()) {
    if (i > 0) await pause(MLS_WRITE_INTERVAL_MS + 20)
    ws.send(JSON.stringify(frame))
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
  await create(socketA, 'A')
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
    JSON.stringify(first.live) === JSON.stringify([ID('A')]),
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
await sendPaced(socketA, messages.map(msg => ({
  type: 'mls',
  kind: msg.kind,
  payload: msg.payload
})))

let socketB
let logReply

await check(5, 'log entries round-trip byte-identical', async () => {
  socketB = await openSocket()
  await hello(socketB, 'B')
  logReply = await waitForMessage(socketB, 'log')

  assert(logReply.entries, 'missing entries in log reply')
  assert(logReply.entries.length === 3, `expected 3 entries, got ${logReply.entries.length}`)

  for (let i = 0; i < 3; i++) {
    const entry = logReply.entries[i]
    const expected = messages[i]
    assert(entry.seq === i + 1, `entry ${i} seq: expected ${i + 1}, got ${entry.seq}`)
    assert(entry.sender === ID('A'),
      `entry ${i} sender: expected A, got ${entry.sender}`)
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
    // socketA wrote last at the end of check 3; stay outside its
    // throttle window.
    await pause(MLS_WRITE_INTERVAL_MS + 20)

    socketA.send(JSON.stringify({
      type: 'mls',
      kind: 'commit',
      payload: 'Y29tbWl0LWVudHJ5'
    }))

    // Both are positive waits, so neither needs a settle. The check
    // fails by timing out rather than by racing a clock.
    const [mine, theirs] = await Promise.all([aEntry, bEntry])

    assert(
      mine.entry.sender === ID('A'),
      `sender's own copy: expected sender A, got ${mine.entry.sender}`
    )
    assert(
      theirs.entry.sender === ID('A'),
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
  await hello(socketB2, 'B', { cursor: 3 })
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
  await hello(socketB3, 'B')

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
    JSON.stringify(rosterMsg.live) === JSON.stringify([ID('A')]),
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
  await hello(watcher, 'WATCHER')
  const before = await beforeRoster
  assert(
    before.live.includes(ID('A')),
    `roster before the disconnect should list A, got ${JSON.stringify(before.live)}`
  )

  // A is the creator, so it is the identity the roster reports.
  const afterRoster = waitForMatch(
    watcher,
    'roster',
    (m) => !m.live.includes(ID('A'))
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
    await create(socketC, 'C')
    const created = await waitForMessage(socketC, 'created')
    creatorToken = created.creatorToken
    assert(typeof creatorToken === 'string', 'no creatorToken issued')

    // No token at all. Target B, whose standing later checks depend on:
    // if any of these were accepted, B would be admitted or removed and
    // checks 12-14 would fail, so this is not only asserted here.
    const stranger = await openSocket(roomId2)
    await hello(stranger, 'E')
    const strangerState = await waitForMessage(stranger, 'room-state')
    assert(
      strangerState.isCreator === false,
      'a socket with no token must not be told it is the creator'
    )
    const noTokenErrors = collect(stranger, 'error')
    for (const msg of controlMessages(ID('B'))) {
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
    // must buy nothing at all. The claim is even proved here -- the
    // token is a second factor on top of the key, not a stand-in for it.
    const impostor = await openSocket(roomId2)
    await hello(impostor, 'C', { creatorToken: 'not-the-real-token' })
    const impostorState = await waitForMessage(impostor, 'room-state')
    assert(
      impostorState.isCreator === false,
      'a wrong token must not report isCreator'
    )
    const wrongTokenErrors = collect(impostor, 'error')
    for (const msg of controlMessages(ID('B'))) {
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
    await hello(creator, 'C', { creatorToken })
    const creatorState = await waitForMessage(creator, 'room-state')
    assert(
      creatorState.isCreator === true,
      'the correct token must report isCreator'
    )
    const acceptedErrors = collect(creator, 'error')
    for (const msg of controlMessages(ID('THROWAWAY'))) {
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
    await joinRequest(b, 'B', KEY_PACKAGE_1)
    await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === ID('B')))

    // B leaves entirely. Nothing of B remains connected.
    b.close()
    await waitForClose(b)

    // And the creator leaves too, so what is read back on the next visit
    // came out of storage rather than off a socket either party held.
    creator.close()
    creator = await openSocket(roomId2)
    await hello(creator, 'C', { creatorToken })
    const pending = await waitForMessage(creator, 'pending')

    const entry = pending.requests.find(r => r.identity === ID('B'))
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
    await joinRequest(b, 'B', KEY_PACKAGE_2)
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => {
        return r.identity === ID('B') && r.keyPackage === KEY_PACKAGE_2
      }))
    assert(
      (await leakedToB).length === 0,
      'the pending list was sent to a socket that is not the creator'
    )

    const forB = pending.requests.filter(r => r.identity === ID('B'))
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
    creator.send(JSON.stringify({ type: 'deny', identity: ID('B') }))
    await waitForMatch(creator, 'pending',
      m => !m.requests.some(r => r.identity === ID('B')))

    // Denial is not removal. A denied identity was never admitted, so it
    // is still a stranger and may ask again.
    const b = await openSocket(roomId2)
    await joinRequest(b, 'B', KEY_PACKAGE_1)
    const again = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === ID('B')))

    const entry = again.requests.find(r => r.identity === ID('B'))
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
    await hello(witness, 'WIT')
    await waitForMessage(witness, 'room-state')

    // Two application messages and then the commit. The two are what
    // priorCount must count; the commit is what it must not.
    await sendPaced(creator, [
      { type: 'mls', kind: 'application', payload: 'bXNnLW9uZQ==' },
      { type: 'mls', kind: 'application', payload: 'bXNnLXR3bw==' },
      { type: 'mls', kind: 'commit', payload: 'dGhlLWNvbW1pdA==' }
    ])
    const commit = await waitForMatch(witness, 'entry',
      m => m.entry.kind === 'commit')
    const commitSeq = commit.entry.seq

    // B is not connected. The Welcome has to wait in the mailbox.
    creator.send(JSON.stringify({
      type: 'welcome', to: ID('B'), payload: 'V0VMQ09NRS1QQVlMT0FE'
    }))

    const b = await openSocket(roomId2)
    const seen = recordOrder(b)
    await hello(b, 'B')

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
    await hello(b2, 'B')
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
    creator.send(JSON.stringify({ type: 'approve', identity: ID('B') }))
    creator.send(JSON.stringify({ type: 'removed', identity: ID('B') }))

    const b = await openSocket(roomId2)
    await joinRequest(b, 'B', KEY_PACKAGE_2)
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === ID('B')))

    const entry = pending.requests.find(r => r.identity === ID('B'))
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
  await create(s, 'X')
  const created = await waitForMessage(s, 'created')

  const threeDays = 3 * 24 * 60 * 60 * 1000
  const drift = Math.abs(created.expiresAt - (before + threeDays))
  assert(
    drift < 60000,
    `expiresAt is ${drift}ms away from three days out`
  )
  s.close()
})

// Check 18 is not in the plan. replaceExistingSocket matches on
// identity, and an identity is a public key, so anyone could evict the
// creator's live socket just by saying hello as them. Since
// security-audit-2026-09 H4 the claim has to be proved; an unproved one
// is refused before it can replace anything. Check 30 is the same rule
// for an ordinary member, with the proven half.
await check(18, 'an unproved claim cannot evict the creator', async () => {
  let creatorClosed = false
  const closeHandler = () => { creatorClosed = true }
  creator.addEventListener('close', closeHandler)

  const impostor = await openSocket(roomId2)
  await impostor.challenge
  impostor.send(JSON.stringify({
    type: 'hello', identity: ID('C'), cursor: 0, creatorToken
  }))
  const refusal = await waitForMessage(impostor, 'error')

  // A negative with no event to wait for. Sound here because the
  // eviction it would race with happens inside the same hello the
  // refusal above already answered.
  await new Promise(r => setTimeout(r, 300))

  creator.removeEventListener('close', closeHandler)
  impostor.close()
  await waitForClose(impostor)
  assert(
    refusal.reason === 'bad-proof',
    `expected bad-proof, got ${JSON.stringify(refusal)}`
  )
  assert(
    !creatorClosed,
    "the creator's socket was evicted by a claim carrying no proof"
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
    await hello(d, 'D')
    await waitForMessage(d, 'room-state')

    // Connected but not admitted: live, and still not on the roster.
    const beforeApproval = await rosterOnJoin
    assert(
      !beforeApproval.live.includes(ID('D')),
      `D is live but unapproved and must not be listed, got ${
        JSON.stringify(beforeApproval.live)}`
    )

    // The load-bearing assertion. This is the one that fails if `known`
    // goes back to holding only the creator.
    creator.send(JSON.stringify({ type: 'approve', identity: ID('D') }))
    const afterApproval = await waitForMatch(creator, 'roster',
      m => m.live.includes(ID('D')))
    assert(
      afterApproval.live.includes(ID('D')),
      'an admitted, connected identity must appear on the roster'
    )

    // Removal wins over admission.
    creator.send(JSON.stringify({ type: 'removed', identity: ID('D') }))
    const afterRemoval = await waitForMatch(creator, 'roster',
      m => !m.live.includes(ID('D')))
    assert(
      !afterRemoval.live.includes(ID('D')),
      'a removed identity must drop off the roster even while connected'
    )

    // Re-approval is a supported flow -- `previously-removed` exists so
    // the creator can weigh letting someone back in -- and the roster
    // has to survive it. The ledger's removed row is never cleared by
    // anything else, and `known` subtracts removed from admitted, so an
    // approve that leaves the row behind readmits a member who is
    // permanently invisible on the roster.
    creator.send(JSON.stringify({ type: 'approve', identity: ID('D') }))
    const afterReapproval = await waitForMatch(creator, 'roster',
      m => m.live.includes(ID('D')))
    assert(
      afterReapproval.live.includes(ID('D')),
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
  await hello(outsider, 'F')
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
    !seen.some(m => m.entry.sender === ID('F')),
    'a refused write still reached the log'
  )

  // 20b. The creator, who is never in the ledger, must still write. A
  // gate that only consulted `admitted` would lock the one identity that
  // has to be able to commit out of its own room.
  const creatorEntry = waitForMatch(outsider, 'entry',
    m => m.entry.sender === ID('C'))
  creator.send(JSON.stringify({
    type: 'mls', kind: 'commit', payload: 'Y3JlYXRvcg=='
  }))
  await creatorEntry

  // 20c. An admitted member writes. D was approved in check 19.
  const member = await openSocket(roomId2)
  await hello(member, 'D')
  await waitForMessage(member, 'room-state')
  const memberEntry = waitForMatch(creator, 'entry',
    m => m.entry.sender === ID('D'))
  member.send(JSON.stringify({
    type: 'mls', kind: 'application', payload: 'bWVtYmVy'
  }))
  await memberEntry

  // 20d. Removal wins over admission. B was approved and then removed in
  // check 16, so B's `admitted` row is still there.
  const removed = await openSocket(roomId2)
  await hello(removed, 'B')
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
    await create(first, 'P')
    const made = await waitForMessage(first, 'created')
    assert(typeof made.creatorToken === 'string', 'no token on the first')

    // A separate socket, so this is the room's metadata refusing the
    // second create rather than one socket's attachment doing it.
    const second = await openSocket(freshId)
    const refusals = collect(second, 'error')
    const alsoCreated = collect(second, 'created')
    await create(second, 'Q')

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
    await hello(back, 'P', { creatorToken: made.creatorToken })
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
    await hello(s, 'Z')
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
    // One over MAX_KEY_PACKAGE_LENGTH.
    await joinRequest(limited, 'LIM', 'A'.repeat(16 * 1024 + 1))
    const refusal = await waitForMessage(limited, 'error')
    assert(
      refusal.reason === 'key-package-too-large',
      `expected key-package-too-large, got ${refusal.reason}`
    )

    // A request that is allowed, from another socket, is what makes the
    // creator's list arrive. LIM's absence from it is the assertion: the
    // refusal above stored nothing.
    const ok = await openSocket(roomId2)
    await joinRequest(ok, 'OK1', KEY_PACKAGE_1)
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === ID('OK1')))
    assert(
      !pending.requests.some(r => r.identity === ID('LIM')),
      'the oversized request was stored anyway'
    )
    ok.close()
    await waitForClose(ok)
  })

await check(25, 'a second join request from one socket is rate limited',
  async () => {
    // Same socket as check 24, whose only request so far was refused --
    // so its throttle window has never started, and this one is allowed.
    // The socket has already proved LIM, so it asks without a new hello.
    limited.send(JSON.stringify({
      type: 'join-request', identity: ID('LIM'), keyPackage: KEY_PACKAGE_1
    }))
    await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === ID('LIM')))

    limited.send(JSON.stringify({
      type: 'join-request', identity: ID('LIM'), keyPackage: KEY_PACKAGE_2
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

// security-audit-2026-09 H4, the expand half: a proof is checked
// whenever one is offered. Both polarities, on the creator's room, which
// by now holds log entries -- so "no log" is a refusal and not an empty
// room. The rule itself is `verifyIdentityProof`, proved in Node; this
// proves the Worker consults it, and binds the challenge it issued.
await check(27, 'a valid identity proof is attached, a forged one refused',
  async () => {
    const alice = await makeIdentity()

    // Signed over the challenge this socket was actually issued.
    const good = await openSocket(roomId2)
    const goodChallenge = await good.challenge
    assert(
      typeof goodChallenge === 'string' && goodChallenge.length > 0,
      'the room should challenge a socket before it says anything'
    )
    const goodLog = waitForMessage(good, 'log')
    const goodErrors = collect(good, 'error')
    good.send(JSON.stringify({
      type: 'hello',
      identity: alice.identity,
      cursor: 0,
      proof: await alice.prove(roomId2, goodChallenge)
    }))
    await waitForMessage(good, 'room-state')
    await goodLog
    const refusedGood = await goodErrors
    assert(
      refusedGood.length === 0,
      `a valid proof was refused: ${JSON.stringify(refusedGood)}`
    )

    // Signed by the same key, over a challenge this socket was not
    // issued -- the other socket's. Replaying a proof is the forgery a
    // proof exists to stop.
    const forged = await openSocket(roomId2)
    await forged.challenge
    const states = collect(forged, 'room-state')
    const logs = collect(forged, 'log')
    forged.send(JSON.stringify({
      type: 'hello',
      identity: alice.identity,
      cursor: 0,
      proof: await alice.prove(roomId2, goodChallenge)
    }))
    const refusal = await waitForMessage(forged, 'error')
    assert(
      refusal.reason === 'bad-proof',
      `expected bad-proof, got ${JSON.stringify(refusal)}`
    )
    const leakedStates = await states
    const leakedLogs = await logs
    assert(
      leakedStates.length === 0 && leakedLogs.length === 0,
      'a refused proof was still sent the room state or the log'
    )

    good.close()
    await waitForClose(good)
    forged.close()
    await waitForClose(forged)
  })

// Check 28 is security-audit-2026-09.md H6, the room's half. Only the
// creator commits in this demo, so a `commit` from an admitted member is
// a replay or a forgery; one that reached the log would sit there for
// every client to decide about. The member's own chat must still pass,
// or a gate that refuses the member outright would pass this check.
await check(28, 'only the creator may write a commit', async () => {
  // D was admitted in check 19.
  const member = await openSocket(roomId2)
  await hello(member, 'D')
  await waitForMessage(member, 'room-state')

  const peerEntries = collect(creator, 'entry')
  const memberErrors = collect(member, 'error')
  member.send(JSON.stringify({
    type: 'mls', kind: 'commit', payload: 'cmVwbGF5ZWQ='
  }))
  const errs = await memberErrors
  assert(
    errs.length === 1 && errs[0].reason === 'commit-not-creator',
    `expected one commit-not-creator, got ${JSON.stringify(errs)}`
  )
  const seen = await peerEntries
  assert(
    !seen.some(m => m.entry.payload === 'cmVwbGF5ZWQ='),
    'a refused commit still reached a peer'
  )

  const chat = waitForMatch(creator, 'entry',
    m => m.entry.sender === ID('D') && m.entry.payload === 'c3RpbGwgY2hhdHM=')
  member.send(JSON.stringify({
    type: 'mls', kind: 'application', payload: 'c3RpbGwgY2hhdHM='
  }))
  await chat

  member.close()
  await waitForClose(member)
})

// Checks 29 to 33 are security-audit-2026-09 H4, the contract half: the
// proof is mandatory. The room link alone must reveal nothing and let
// nobody act as anyone. Each asserts who is refused, who still gets
// through, and what the refusal did not do -- no frame leaked, no
// Welcome consumed, no live socket closed.

// Everything a room tells an attached socket. An unproven one must see
// none of it.
function collectLeaks (ws, ms = 600) {
  return Promise.all(
    ['room-state', 'log', 'roster', 'welcome-you', 'entry']
      .map(type => collect(ws, type, ms))
  ).then(lists => lists.flat())
}

await check(29, 'a hello without a valid proof is told nothing',
  async () => {
    // No proof at all, under a member's identity. D is admitted, so a
    // log, a roster and entries are all things it would be sent.
    const bare = await openSocket(roomId2)
    await bare.challenge
    const bareLeaks = collectLeaks(bare)
    bare.send(JSON.stringify({ type: 'hello', identity: ID('D'), cursor: 0 }))
    const bareRefusal = await waitForMessage(bare, 'error')
    // A write from the creator while the refused socket is still open:
    // an entry broadcast must not reach it either.
    creator.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'bm90LWZvci1iYXJl'
    }))
    const bareLeaked = await bareLeaks
    assert(
      bareRefusal.reason === 'bad-proof',
      `no proof: expected bad-proof, got ${JSON.stringify(bareRefusal)}`
    )
    assert(
      bareLeaked.length === 0,
      `no proof: leaked ${JSON.stringify(bareLeaked.map(m => m.type))}`
    )

    // A proof, over this socket's own challenge, by another key.
    const other = await openSocket(roomId2)
    const challenge = await other.challenge
    const otherLeaks = collectLeaks(other)
    other.send(JSON.stringify({
      type: 'hello',
      identity: ID('D'),
      cursor: 0,
      proof: await I.E.prove(roomId2, challenge)
    }))
    const otherRefusal = await waitForMessage(other, 'error')
    const otherLeaked = await otherLeaks
    assert(
      otherRefusal.reason === 'bad-proof',
      `another key: expected bad-proof, got ${JSON.stringify(otherRefusal)}`
    )
    assert(
      otherLeaked.length === 0,
      `another key: leaked ${JSON.stringify(otherLeaked.map(m => m.type))}`
    )

    // The refused sockets do not count as live either. D is admitted, so
    // a D counted from either socket would show on the next roster.
    const roster = waitForMessage(creator, 'roster')
    const g = await openSocket(roomId2)
    await hello(g, 'G')
    const live = await roster
    assert(
      !live.live.includes(ID('D')),
      `an unproven socket counted as live: ${JSON.stringify(live.live)}`
    )

    // The other polarity: D proves, and gets the room state, the log
    // after its cursor, and the roster.
    const proven = await openSocket(roomId2)
    const got = {
      state: waitForMessage(proven, 'room-state'),
      log: waitForMessage(proven, 'log'),
      roster: waitForMatch(proven, 'roster', m => m.live.includes(ID('D')))
    }
    await hello(proven, 'D', { cursor: 1 })
    await got.state
    const log = await got.log
    await got.roster
    assert(
      log.entries.length > 0 && log.entries.every(e => e.seq > 1),
      `expected the log after seq 1, got ${JSON.stringify(
        log.entries.map(e => e.seq))}`
    )

    for (const ws of [bare, other, g, proven]) {
      ws.close()
      await waitForClose(ws)
    }
  })

await check(30, 'an unproved claim leaves a member connected; a proof replaces',
  async () => {
    const live = await openSocket(roomId2)
    const ready = waitForMessage(live, 'room-state')
    await hello(live, 'D')
    await ready
    let closed = false
    live.addEventListener('close', () => { closed = true })

    // Unproven: refused, and D's socket stays open.
    const claim = await openSocket(roomId2)
    await claim.challenge
    claim.send(JSON.stringify({ type: 'hello', identity: ID('D'), cursor: 0 }))
    await waitForMessage(claim, 'error')
    await new Promise(r => setTimeout(r, 300))
    assert(!closed, "an unproved claim closed the member's live socket")
    assert(
      live.readyState === WebSocket.OPEN,
      'the live socket is no longer open'
    )

    // Proven: D's own reconnect replaces the old socket.
    const again = await openSocket(roomId2)
    await hello(again, 'D')
    await waitForClose(live)
    assert(closed, 'a proven reconnect did not replace the old socket')

    for (const ws of [claim, again]) {
      ws.close()
      await waitForClose(ws)
    }
  })

await check(31,
  'a pending Welcome waits for a socket that proves its recipient',
  async () => {
    // H is not connected, so the Welcome has to wait in the mailbox.
    creator.send(JSON.stringify({
      type: 'welcome', to: ID('H'), payload: 'SC1XRUxDT01F'
    }))
    // The mailbox is written with no reply. A deny answers with the
    // pending list, and the room handles one socket's frames in order,
    // so that list arriving means the Welcome is stored.
    const stored = waitForMessage(creator, 'pending')
    creator.send(JSON.stringify({ type: 'deny', identity: ID('THROWAWAY') }))
    await stored

    const claim = await openSocket(roomId2)
    await claim.challenge
    const stolen = collect(claim, 'welcome-you', 600)
    claim.send(JSON.stringify({ type: 'hello', identity: ID('H'), cursor: 0 }))
    await waitForMessage(claim, 'error')
    assert(
      (await stolen).length === 0,
      'an unproven socket was handed the Welcome'
    )
    claim.close()
    await waitForClose(claim)

    const h = await openSocket(roomId2)
    const welcome = waitForMessage(h, 'welcome-you')
    await hello(h, 'H')
    const got = await welcome
    assert(
      got.payload === 'SC1XRUxDT01F',
      'the Welcome did not survive the unproven claim'
    )
    h.close()
    await waitForClose(h)
  })

await check(32, 'a join request is taken only for the identity proved',
  async () => {
    // G proves G, then asks as H: refused, and nothing is queued.
    const g = await openSocket(roomId2)
    const ready = waitForMessage(g, 'room-state')
    await hello(g, 'G')
    await ready
    g.send(JSON.stringify({
      type: 'join-request', identity: ID('H'), keyPackage: KEY_PACKAGE_1
    }))
    const refusal = await waitForMessage(g, 'error')
    assert(
      refusal.reason === 'bad-proof',
      `expected bad-proof, got ${JSON.stringify(refusal)}`
    )

    // And asking as G, the proved identity, is queued. The list this
    // produces is also the one that must not name H.
    g.send(JSON.stringify({
      type: 'join-request', identity: ID('G'), keyPackage: KEY_PACKAGE_1
    }))
    const pending = await waitForMatch(creator, 'pending',
      m => m.requests.some(r => r.identity === ID('G')))
    assert(
      !pending.requests.some(r => r.identity === ID('H')),
      'a request for an unproved identity was queued'
    )
    g.close()
    await waitForClose(g)
  })

await check(33, 'a create without a valid proof creates no room', async () => {
  for (const how of ['none', 'another key']) {
    const freshId = crypto.randomUUID().slice(0, 10)
    const s = await openSocket(freshId)
    const challenge = await s.challenge
    const made = collect(s, 'created', 600)
    s.send(JSON.stringify({
      type: 'create',
      identity: ID('X'),
      ...(how === 'none' ?
        {} :
        { proof: await I.E.prove(freshId, challenge) })
    }))
    const refusal = await waitForMessage(s, 'error')
    assert(
      refusal.reason === 'bad-proof',
      `${how}: expected bad-proof, got ${JSON.stringify(refusal)}`
    )
    assert((await made).length === 0, `${how}: a token was issued`)
    const res = await fetch(`${baseUrl}/api/room/${freshId}`)
    assert(res.status === 404, `${how}: the room exists, ${res.status}`)
    s.close()
    await waitForClose(s)
  }

  // The proven create still works: check 17 relies on it too.
  const freshId = crypto.randomUUID().slice(0, 10)
  const s = await openSocket(freshId)
  await create(s, 'X')
  await waitForMessage(s, 'created')
  s.close()
  await waitForClose(s)
})

// Ticket 09 (security-audit-2026-09 M8). A room is listed in the
// registry by the time its creator hears `created`, so a GET made the
// moment after -- as an invitee opening a fresh link would -- finds it.
// Check 1 is the other polarity: an id nobody created is 404.
await check(34, 'a room fetched right after creation is 200, not 404',
  async () => {
    const id = crypto.randomUUID().slice(0, 10)
    const before = await fetch(`${baseUrl}/api/room/${id}`)
    assert(
      before.status === 404,
      `unused id: expected 404, got ${before.status}`
    )

    const maker = await makeIdentity()
    const ws = await openSocket(id)
    ws.send(JSON.stringify({
      type: 'create',
      identity: maker.identity,
      proof: await maker.prove(id, await ws.challenge)
    }))
    await waitForMessage(ws, 'created')

    const res = await fetch(`${baseUrl}/api/room/${id}`)
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const body = await res.json()
    assert(typeof body.expiresAt === 'number', 'missing expiresAt')

    ws.close()
    await waitForClose(ws)
  })

// Upgrades are limited per client address before a room is named. The
// address is a header the local runtime passes through, so this check
// spends a made-up one and every other check keeps its budget. Plain
// requests without an Upgrade header count against the limit too (they
// are answered 426), which is what makes spending it cheap.
await check(35, 'upgrades past the per-address limit are 429',
  async () => {
    const flooder = `10.${[1, 2, 3].map(() => crypto.randomInt(256)).join('.')}`
    const honest = `10.${[1, 2, 3].map(() => crypto.randomInt(256)).join('.')}`
    const url = `${baseUrl}/api/room/${roomId}/ws`
    const opens = headers => new Promise(resolve => {
      const ws = new WebSocket(url, { headers })
      ws.onopen = () => { ws.close(); resolve(true) }
      ws.onerror = () => resolve(false)
    })

    // Within the limit, a real upgrade opens.
    assert(
      await opens({ 'CF-Connecting-IP': flooder }),
      'an upgrade within the limit should open'
    )

    let limited = null
    for (let i = 0; i < 200 && limited === null; i++) {
      const res = await fetch(url, {
        headers: { 'CF-Connecting-IP': flooder }
      })
      if (res.status === 429) limited = i
    }
    assert(limited !== null, 'no 429 after 200 upgrades from one address')

    assert(
      !(await opens({ 'CF-Connecting-IP': flooder })),
      'a limited address still opened a socket'
    )
    assert(
      await opens({ 'CF-Connecting-IP': honest }),
      'another address was limited by the flooder'
    )
  })

// Check 36 is security-audit-2026-09 M8: `onMls` consults
// `classifyMlsWrite`. Only the throttle is exercised here; the row and
// byte caps are proved in Node, where ten thousand writes cost nothing.
await check(36, 'a second mls inside the interval reaches no peer',
  async () => {
    const member = await openSocket(roomId2)
    await hello(member, 'D')
    await waitForMessage(member, 'room-state')

    const first = waitForMatch(creator, 'entry',
      m => m.entry.payload === 'Zmlyc3Q=')
    const peerEntries = collect(creator, 'entry')
    const errors = collect(member, 'error')
    member.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'Zmlyc3Q='
    }))
    member.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'dG9vLXNvb24='
    }))
    await first

    const errs = await errors
    assert(
      errs.length === 1 && errs[0].reason === 'rate-limited',
      `expected one rate-limited, got ${JSON.stringify(errs)}`
    )
    const seen = await peerEntries
    assert(
      !seen.some(m => m.entry.payload === 'dG9vLXNvb24='),
      'a throttled write still reached a peer'
    )

    // After the interval the same socket writes again, and is broadcast.
    const later = waitForMatch(creator, 'entry',
      m => m.entry.payload === 'bGF0ZXI=')
    member.send(JSON.stringify({
      type: 'mls', kind: 'application', payload: 'bGF0ZXI='
    }))
    await later

    member.close()
    await waitForClose(member)
  })

// Ticket 07 (security-audit-2026-09 M8). The replay after `hello` comes
// in pages, each small enough for one WebSocket frame, and a client that
// asks with `replay` from the last seq it received gets the rest. The
// page budget is `REPLAY_PAGE_BUDGET` in `room-logic.ts`, copied here
// because this script cannot import TypeScript; change the two together.
await check(37, 'a log larger than one page replays whole and in order',
  async () => {
    const REPLAY_PAGE_BUDGET = 512 * 1024
    const FRAME_LIMIT = 1024 * 1024
    const owner = await makeIdentity()
    const room = crypto.randomUUID().slice(0, 10)

    const writer = await openSocket(room)
    const ownerProof = await owner.prove(room, await writer.challenge)
    writer.send(JSON.stringify({
      type: 'create', identity: owner.identity, proof: ownerProof
    }))
    await waitForMessage(writer, 'created')

    // Six entries of 200 KiB: well over two pages of the budget, each
    // one still inside `MAX_PAYLOAD_LENGTH`.
    const payloads = Array.from({ length: 6 }, (_, i) => {
      return Buffer.alloc(150 * 1024, i + 1).toString('base64')
    })
    await sendPaced(writer, payloads.map(payload => ({
      type: 'mls', kind: 'application', payload
    })))
    // A socket's frames are handled in order, so the answer to this
    // arriving means every write above has landed.
    const landed = waitForMessage(writer, 'log', 10000)
    writer.send(JSON.stringify({ type: 'replay', cursor: 1e9 }))
    await landed

    const reader = await openSocket(room)
    const frames = []
    const pages = []
    let done
    const finished = new Promise((resolve, reject) => {
      done = { resolve, reject }
      setTimeout(() => reject(new Error('the replay never finished')),
        20000)
    })
    reader.addEventListener('message', event => {
      const msg = safeParse(event.data)
      if (msg?.type !== 'log') return
      frames.push(String(event.data).length)
      pages.push(msg)
      const last = msg.entries[msg.entries.length - 1]
      if (!msg.more) return done.resolve()
      if (!last) return done.reject(new Error('an empty page said more'))
      reader.send(JSON.stringify({ type: 'replay', cursor: last.seq }))
    })
    const readerProof = await owner.prove(room, await reader.challenge)
    reader.send(JSON.stringify({
      type: 'hello', identity: owner.identity, cursor: 0, proof: readerProof
    }))
    await finished

    const got = pages.flatMap(page => page.entries)
    assert(pages.length > 1, `expected several pages, got ${pages.length}`)
    assert(
      got.map(e => e.seq).join(',') === '1,2,3,4,5,6',
      `entries out of order or missing: ${got.map(e => e.seq)}`
    )
    assert(
      got.every((e, i) => e.payload === payloads[i]),
      'a replayed payload differs from what was written'
    )
    for (const page of pages) {
      const size = JSON.stringify(page.entries).length
      assert(size <= REPLAY_PAGE_BUDGET,
        `a page of ${size} characters exceeds the budget`)
    }
    assert(frames.every(n => n <= FRAME_LIMIT), 'a frame exceeds 1 MiB')

    reader.close()
    await waitForClose(reader)
    writer.close()
    await waitForClose(writer)
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

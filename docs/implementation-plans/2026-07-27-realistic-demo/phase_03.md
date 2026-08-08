# Realistic Demo Implementation Plan -- Phase 3: Wire contract and pure room logic

**Goal:** One definition of every message that crosses the socket, and the
room's storage-free decisions, both testable in Node.

**Architecture:** `protocol.ts` is the single source of truth for the wire,
imported by the Worker, the browser client, and the Node test bundle
alike -- so it imports nothing from any of the three environments.
`room-logic.ts` holds the room's decisions that involve no storage, no
globals and no network. Both exist as separate modules precisely so the
existing esbuild-to-Node test harness can exercise them.

**Tech Stack:** TypeScript 5.9, `@substrate-system/tapzero`, esbuild.

**Scope:** Phase 3 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

This phase implements and tests:

### realistic-demo.AC4: Approval, denial, and the identity ledger
- **realistic-demo.AC4.5 Logic:** An identity in neither set classifies
  as `stranger`
- **realistic-demo.AC4.6 Logic:** An admitted identity that has not been
  removed classifies as `pre-approved`
- **realistic-demo.AC4.7 Logic:** A removed identity classifies as
  `previously-removed`, including when it appears in both sets

### realistic-demo.AC10: Cross-cutting behaviors
- **realistic-demo.AC10.1 Logic:** A valid frame of each `ClientMessage`
  and `RoomMessage` type is accepted by its narrowing helper
- **realistic-demo.AC10.2 Logic:** An unknown `type`, a missing required
  field, and a non-object are each rejected
- **realistic-demo.AC10.3 Logic:** The room stores and forwards `payload`
  and `kind` exactly as received and never decodes an MLS payload

---

## Codebase verification findings

- `test/index.ts` registers test modules by plain import line, grouped
  under a comment heading per area (`// Example app tests`, `// Codec
  tests`, and so on). Adding a test file means adding one import line.
- `npm test` runs `test:node`, which bundles `test/index.ts` through
  esbuild with `--platform=node --format=cjs`. Nothing under test may
  touch the DOM, `indexedDB`, `WebSocket`, or `DurableObject`. Both
  modules in this phase are pure, so both are fully testable.
- Tests use `@substrate-system/tapzero`: `import { test } from
  '@substrate-system/tapzero'`, then `test('name - case', (t) => {...})`
  with `t.equal`, `t.deepEqual`, and `t.ok`. Test names use a
  `functionName - case` convention. See `test/example/routing.ts` for the
  canonical shape.
- The existing pure modules (`example/send-plan.ts`, `example/routing.ts`,
  `example/devices.ts`) carry a file-level doc comment stating that they
  are pure so they can be unit tested in node. The two new modules follow
  that convention.
- eslint enforces 4-space indent, no space around type-annotation colons
  (`name:string`), and prefers `import type` for type-only imports. Union
  types are written without spaces around `|`.
- Neither `example-realistic-demo/protocol.ts` nor
  `example-realistic-demo/room-logic.ts` exists yet. Neither does
  `test/example-realistic-demo/`.

**Design inconsistency corrected here.** The design plan puts this
phase's tests in `test/example-realistic-demo/` but later refers to
`test/example/delivery-cursor.ts` (Phase 6) and `test/example/timeline.ts`
(Phase 8). Those would scatter this demo's tests across two directories
and mix them with the existing demos' tests. **All realistic-demo tests
go in `test/example-realistic-demo/`.** Phases 6 and 8 follow this.

## External dependency findings

N/A. This phase adds no dependency. `protocol.ts` deliberately imports
nothing at all, and `room-logic.ts` imports only types from
`protocol.ts`.

---

## Commands used throughout this phase

- **Root typecheck:**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Worker typecheck:**
  `npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Write the wire contract

**Verifies:** None directly -- Task 3 tests this module.

**Files:**
- Create: `example-realistic-demo/protocol.ts`

**Step 1: Create the file**

The types are the design's wire contract verbatim. The narrowing helpers
below them are new.

```ts
/**
 * The wire contract, and the only definition of it. Imported by the
 * Worker, by the browser client, and by the Node test bundle, so it
 * imports nothing -- not the DOM, not Cloudflare globals, not `../src/`.
 *
 * Two kinds of traffic share one socket. MLS payloads are opaque base64
 * the room stores, orders and forwards without ever decoding. Control
 * messages are a small vocabulary the room does understand, enough to
 * keep a ledger of who was admitted.
 *
 * Identity is always the base64url signature public key, never the
 * display name. Names do not appear on the wire at all -- the creator's
 * client reads a name out of a key package when it commits the Add, and
 * every other name comes from the client's own ratchet tree.
 */

export type EntryKind = 'commit'|'proposal'|'application'

export interface LogEntry {
    seq:number
    sender:string          // b64url signature public key
    kind:EntryKind         // asserted by sender, unverified
    payload:string         // b64 MLSMessage
}

export type Standing = 'stranger'|'pre-approved'|'previously-removed'

export interface PendingRequest {
    identity:string
    keyPackage:string
    requestedAt:number
    standing:Standing
}

export type ErrorReason = 'room-exists'|'not-creator'|'bad-message'

export type ClientMessage =
    | { type:'create'; identity:string }
    | { type:'hello'; identity:string; cursor:number;
        creatorToken?:string }
    | { type:'mls'; kind:EntryKind; payload:string }
    | { type:'join-request'; identity:string; keyPackage:string }
    | { type:'approve'; identity:string }
    | { type:'deny'; identity:string }
    | { type:'removed'; identity:string }
    | { type:'welcome'; to:string; payload:string }

export type RoomMessage =
    | { type:'created'; creatorToken:string; expiresAt:number }
    | { type:'no-room' }
    | { type:'room-state'; isCreator:boolean; createdAt:number;
        expiresAt:number }
    | { type:'log'; entries:LogEntry[] }
    | { type:'entry'; entry:LogEntry }
    | { type:'welcome-you'; payload:string; cursor:number;
        priorCount:number }
    | { type:'pending'; requests:PendingRequest[] }
    | { type:'roster'; live:string[] }
    | { type:'error'; reason:ErrorReason }

// Anything arriving off a socket is unknown until proven otherwise.
// These narrow it, and are the only place that decision is made.

function isObject (v:unknown):v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStr (v:unknown):v is string {
    return typeof v === 'string'
}

// Rejects NaN and Infinity, which survive a `typeof === 'number'` check
// and would otherwise corrupt a cursor or a seq comparison.
function isNum (v:unknown):v is number {
    return typeof v === 'number' && Number.isFinite(v)
}

const ENTRY_KINDS:readonly string[] = [
    'commit',
    'proposal',
    'application'
]

const ERROR_REASONS:readonly string[] = [
    'room-exists',
    'not-creator',
    'bad-message'
]

export function isEntryKind (v:unknown):v is EntryKind {
    return isStr(v) && ENTRY_KINDS.includes(v)
}

export function isErrorReason (v:unknown):v is ErrorReason {
    return isStr(v) && ERROR_REASONS.includes(v)
}

export function isLogEntry (v:unknown):v is LogEntry {
    return (
        isObject(v) &&
        isNum(v.seq) &&
        isStr(v.sender) &&
        isEntryKind(v.kind) &&
        isStr(v.payload)
    )
}

export function isPendingRequest (v:unknown):v is PendingRequest {
    return (
        isObject(v) &&
        isStr(v.identity) &&
        isStr(v.keyPackage) &&
        isNum(v.requestedAt) &&
        isStr(v.standing) &&
        ['stranger', 'pre-approved', 'previously-removed']
            .includes(v.standing)
    )
}

export function isClientMessage (v:unknown):v is ClientMessage {
    if (!isObject(v)) return false

    switch (v.type) {
        case 'create':
            return isStr(v.identity)
        case 'hello':
            return isStr(v.identity) && isNum(v.cursor) &&
                (v.creatorToken === undefined || isStr(v.creatorToken))
        case 'mls':
            return isEntryKind(v.kind) && isStr(v.payload)
        case 'join-request':
            return isStr(v.identity) && isStr(v.keyPackage)
        case 'approve':
        case 'deny':
        case 'removed':
            return isStr(v.identity)
        case 'welcome':
            return isStr(v.to) && isStr(v.payload)
        default:
            return false
    }
}

export function isRoomMessage (v:unknown):v is RoomMessage {
    if (!isObject(v)) return false

    switch (v.type) {
        case 'created':
            return isStr(v.creatorToken) && isNum(v.expiresAt)
        case 'no-room':
            return true
        case 'room-state':
            return typeof v.isCreator === 'boolean' &&
                isNum(v.createdAt) && isNum(v.expiresAt)
        case 'log':
            return Array.isArray(v.entries) &&
                v.entries.every(isLogEntry)
        case 'entry':
            return isLogEntry(v.entry)
        case 'welcome-you':
            return isStr(v.payload) && isNum(v.cursor) &&
                isNum(v.priorCount)
        case 'pending':
            return Array.isArray(v.requests) &&
                v.requests.every(isPendingRequest)
        case 'roster':
            return Array.isArray(v.live) && v.live.every(isStr)
        case 'error':
            return isErrorReason(v.reason)
        default:
            return false
    }
}
```

**Step 2: Confirm the module really is environment-free**

```bash
grep -n "^import\|require(" example-realistic-demo/protocol.ts
```

Expected: no output. If this file ever imports anything, it stops being
usable from all three environments and the contract splits in two.

**Step 3: Do not verify or commit yet**

The module is not yet in any tsconfig `include`. Task 2 adds it along
with `room-logic.ts`.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Write the pure room logic and wire both modules into the configs

**Verifies:** None directly -- Task 3 tests this module.

**Files:**
- Create: `example-realistic-demo/room-logic.ts`
- Modify: `tsconfig.json`
- Modify: `example-realistic-demo/tsconfig.json`

**Step 1: Create `example-realistic-demo/room-logic.ts`**

```ts
import type { EntryKind, LogEntry, Standing } from './protocol.js'

/**
 * The room's decisions that touch no storage, no globals and no network.
 * Pure -- so it can be unit tested in node, and so the parts of the
 * delivery service worth being sure about are the parts under test.
 */

/**
 * Sequence numbers start at 1, so an empty room's high-water mark of 0
 * yields 1. This is the only place a seq is minted, and entries are
 * never renumbered.
 */
export function nextSeq (highWater:number):number {
    return Math.max(0, Math.floor(highWater)) + 1
}

/**
 * What a client with this cursor has not seen. A cursor is the last seq
 * the client applied, so it gets everything strictly after it, in seq
 * order. Sorting here rather than trusting the caller means a replay is
 * ordered even if storage returned rows in another order.
 */
export function entriesAfter (
    entries:LogEntry[],
    cursor:number
):LogEntry[] {
    return entries
        .filter(entry => entry.seq > cursor)
        .sort((a, b) => a.seq - b.seq)
}

/**
 * An `mls` message as it goes into the log. `kind` and `payload` cross
 * untouched: the room asserts nothing about either and never decodes an
 * MLS payload. A client that lies about `kind` corrupts its peers'
 * placeholder counts and nothing else.
 */
export function entryFromMls (
    seq:number,
    sender:string,
    kind:EntryKind,
    payload:string
):LogEntry {
    return { seq, sender, kind, payload }
}

/**
 * Who to mark connected. This is a transport observation, not protocol
 * state -- `liveTags` comes from open sockets and `known` from the
 * ledger, and the page presents the result separately from the member
 * list it derives from its own ratchet tree.
 *
 * `known` is every identity the room believes belongs here: the creator,
 * plus everyone admitted and not since removed. A pending requester
 * holds a socket too and is deliberately excluded -- the roster marks
 * members, not visitors.
 *
 * Tags are deduped because a reconnecting client can briefly hold two
 * sockets, and the result is sorted so the message is stable.
 */
export function assembleRoster (
    known:string[],
    liveTags:string[]
):string[] {
    const isKnown = new Set(known)
    const live = new Set(liveTags.filter(tag => isKnown.has(tag)))
    return [...live].sort()
}

/**
 * How the room classifies a requester against its ledger. Removal wins
 * over admission: an identity that was admitted and later removed is
 * exactly the case the creator most needs to see before approving it
 * again.
 *
 * The ledger is fed entirely by claims the creator's client makes and
 * the room can verify none of them, so this classification is a memory
 * aid rather than an authority.
 */
export function classifyStanding (
    identity:string,
    admitted:string[],
    removed:string[]
):Standing {
    if (removed.includes(identity)) return 'previously-removed'
    if (admitted.includes(identity)) return 'pre-approved'
    return 'stranger'
}
```

**Step 2: Add both modules to the Worker tsconfig**

In `example-realistic-demo/tsconfig.json`, extend `include`:

```json
    "include": [
        "index.ts",
        "protocol.ts",
        "room-logic.ts",
        "worker-configuration.d.ts"
    ]
```

**Step 3: Add both modules to the root tsconfig**

Both files are environment-free, so they belong in the browser and test
config too. This is what makes the "typechecks in the Worker, in the
browser, and in the Node test bundle" claim actually enforced rather
than assumed. In `tsconfig.json`:

```json
  "include": [
    "example",
    "example-shared",
    "example-realistic-demo/client",
    "example-realistic-demo/protocol.ts",
    "example-realistic-demo/room-logic.ts",
    "src/**/*",
    "test",
    "lib.es5.d.ts"
  ]
```

Do not add `example-realistic-demo` wholesale -- that pulls `index.ts`
into the browser config, and its Cloudflare types conflict with the DOM
lib, which is the whole reason Phase 2 gave the Worker its own config.

**Step 4: Typecheck both sides**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

Expected: both clean. The same two files are checked by both configs,
under different libs, which is the point.

**Step 5: Lint**

```bash
npm run lint
```

Expected: passes. If it flags spacing on the union types, use the tight
form (`'a'|'b'`) shown above rather than adding spaces.

**Step 6: Do not commit yet**

Task 3 adds the tests. Commit the subcomponent there, so no commit ever
contains an untested pure module.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Test both modules

**Verifies:** realistic-demo.AC4.5, realistic-demo.AC4.6,
realistic-demo.AC4.7, realistic-demo.AC10.1, realistic-demo.AC10.2,
realistic-demo.AC10.3

**Files:**
- Create: `test/example-realistic-demo/protocol.ts` (unit)
- Create: `test/example-realistic-demo/room-logic.ts` (unit)
- Modify: `test/index.ts`

**Step 1: Register the two new test files**

In `test/index.ts`, add a new section after the existing
`// Example app tests` block (which currently ends with
`import './example/how-to-use.js'` on line 37) and before the
`// Codec tests` comment:

```ts
// Realistic demo tests
import './example-realistic-demo/protocol.js'
import './example-realistic-demo/room-logic.js'
```

**Step 2: Write `test/example-realistic-demo/protocol.ts`**

Follow the shape of `test/example/routing.ts`: import `test` from
`@substrate-system/tapzero`, import the helpers under test from
`'../../example-realistic-demo/protocol.js'`, and name tests
`helperName - case`.

Tests must verify these AC cases:

- **realistic-demo.AC10.1** -- Build one valid frame for every single
  `ClientMessage` variant (`create`, `hello` both with and without
  `creatorToken`, `mls` for each of the three `EntryKind` values,
  `join-request`, `approve`, `deny`, `removed`, `welcome`) and assert
  `isClientMessage` returns `true` for each. Then do the same for every
  `RoomMessage` variant (`created`, `no-room`, `room-state`, `log` with
  both an empty and a populated `entries` array, `entry`, `welcome-you`,
  `pending`, `roster`, `error` for each `ErrorReason`) against
  `isRoomMessage`. Every variant in the union needs a case; a variant
  with no test is a variant the room will silently reject at runtime.

- **realistic-demo.AC10.2** -- Three distinct rejection classes, for both
  helpers:
  1. *Unknown `type`*: `{ type: 'nope' }`, and a message whose `type` is
     valid for the other direction (e.g. `{ type: 'roster', live: [] }`
     passed to `isClientMessage`) -- the two directions must not accept
     each other's vocabulary.
  2. *Missing required field*: for each variant, at least one frame with
     one required field absent. Also cover wrong-typed fields, since
     that is the same failure at runtime: `cursor` as a string, `seq` as
     `NaN`, `entries` as a non-array, a `log` whose `entries` contains
     one malformed element, a `roster` whose `live` contains a number.
  3. *Non-object*: `null`, `undefined`, a number, a string, a boolean,
     and an array. The array case matters -- `typeof [] === 'object'`,
     so a helper that only checks `typeof` would wrongly accept it.

Also test `isEntryKind` and `isErrorReason` directly for their valid
values and for a near-miss string.

**Step 3: Write `test/example-realistic-demo/room-logic.ts`**

Tests must verify these AC cases:

- **realistic-demo.AC10.3** -- `entryFromMls` returns an entry whose
  `kind` and `payload` are identical to what was passed in, including a
  payload containing base64 padding and one that is an empty string.
  Assert the payload is not parsed, trimmed, re-encoded or altered in any
  way -- compare with `t.equal` on the exact string. This is the pure
  half of "never decodes an MLS payload"; Phase 4 covers the storage
  half.

- **realistic-demo.AC4.5** -- `classifyStanding` returns `'stranger'`
  for an identity in neither list, including when both lists are empty.

- **realistic-demo.AC4.6** -- returns `'pre-approved'` for an identity in
  `admitted` and not in `removed`.

- **realistic-demo.AC4.7** -- returns `'previously-removed'` for an
  identity in `removed` only, **and** for an identity present in both
  lists. The both-lists case is the one that matters: it is what happens
  after an admitted member is removed, and getting the precedence
  backwards would show a removed member to the creator as already
  trusted.

Also cover the two helpers that carry no AC but whose failure modes are
real:

- `nextSeq` -- returns 1 from a high-water mark of 0, increments by
  exactly 1 thereafter, and never returns a value at or below its input.
- `entriesAfter` -- returns only entries strictly greater than the
  cursor; returns everything for a cursor of 0; returns an empty array
  for a cursor at or beyond the highest seq; and returns results in
  ascending `seq` order even when handed input in shuffled order.
- `assembleRoster` -- includes an identity that is both known and live;
  excludes a live identity that is not known (the pending-requester
  case); excludes a known identity that is not live; dedupes an identity
  appearing twice in `liveTags` (the reconnect case); and returns a
  sorted array.

Generate the test code at implementation time from the actual exported
signatures. Do not test the type declarations themselves -- the compiler
covers those.

**Step 4: Run the tests**

```bash
npm test
```

Expected: passes, with the new test names appearing in the output. Note
the previous total and confirm it went up -- a test file that fails to
register produces no failure, just silence.

**Step 5: Typecheck and lint**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
```

Expected: all clean.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add realistic-demo wire contract and pure room logic"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

---

## Phase 3 completion checklist

- [ ] `protocol.ts` imports nothing at all
- [ ] `protocol.ts` and `room-logic.ts` typecheck under both tsconfigs
- [ ] Every `ClientMessage` and `RoomMessage` variant has an accept test
- [ ] Unknown type, missing field, and non-object are each rejected, for
      both directions, with the array case covered explicitly
- [ ] `entryFromMls` proven to pass `kind` and `payload` through unaltered
- [ ] All three `Standing` outcomes tested, including the both-lists case
- [ ] Both test files registered in `test/index.ts`
- [ ] `npm test` passes and the test count went up
- [ ] `npm run lint` passes

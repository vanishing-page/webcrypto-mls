# PRD: Realistic Demo

## Introduction

A standalone demo application where the browser is one real client rather
than a simulation of many. A visitor creates one user, creates a room,
and sends the room's URL to someone else. The second person opens that
URL in a different browser profile, creates their own user, and asks to
join. Everything between them travels over a WebSocket to a Cloudflare
Durable Object acting as an MLS delivery service.

The existing three demos run every participant inside a single page.
Alice, Bob and Carl share one JavaScript heap, one set of timers, and one
indexedDB. That is the right shape for showing the ratchet tree and the
epoch mechanics, but it cannot show what an application built on this
library actually has to do: move key packages, welcomes, commits and
ciphertext between machines that know nothing about each other, and cope
with the fact that the other side is frequently not there.

The audience is someone who has understood the protocol from the other
demos and now wants to know what integrating it costs.

Unlike the other three, this page is not a route on the GitHub Pages
site. It is served at the root of its own Cloudflare Worker, by the same
Worker that hosts its Durable Object, which is what makes the WebSocket
same-origin. GitHub Pages continues to serve the existing three demos
unchanged.

This PRD implements FDR-002. FDR-002 decision 2 originally placed the
site on GitHub Pages with a separately deployed Worker; that decision is
amended as part of this work. Where the FDR left something open, the
choice made here is recorded in Technical Considerations.

## Goals

- Show one browser acting as exactly one MLS client, talking to a real
  delivery service over a real network.
- Show that joining, approving and messaging all work when the other
  party is not connected at the time.
- Make the boundary between protocol and application explicit: the
  delivery service never parses an MLS message, and the page says so.
- Ship the delivery service as real deployable infrastructure, with
  everything it needs in one directory and everything committable
  committed.
- Extract the code two applications now share, without changing the
  behavior of any existing demo.

## User Stories

### US-001: Extract shared example code

**Description:** As a developer, I need the modules that more than one
application uses to live in one place, so the new standalone app and the
GitHub Pages site can both import them without one reaching into the
other.

**Context:** `example/` currently holds everything. The new app needs
seven of those modules and none of the rest. `persistence-storage.ts`
depends on `DemoUser` from `demo-state.ts`, which also holds `DemoState`
and `createDemoState()` -- the many-client simulation model the new app
explicitly does not use. Splitting the type out keeps shared code from
dragging the simulation along with it.

**Acceptance Criteria:**
- [ ] New `example-shared/` contains `card-header.ts`, `constants.ts`,
      `how-to-use.ts`, `persistence-storage.ts`, `storage-panel.ts`,
      `storage-persistence.ts`
- [ ] New `example-shared/demo-user.ts` holds the `DemoUser` interface,
      moved out of `example/demo-state.ts`; `DemoState` and
      `createDemoState()` stay in `example/`
- [ ] Import paths updated in `example/index.ts`,
      `example/persistence-demo.ts`, `example/multi-device-demo.ts`,
      `example/tree-diagram.ts`, `example/device-info-panel.ts`,
      `example/device-restore.ts`, `example/device-sync.ts`,
      `example/demo-state.ts`, and the affected files under
      `test/example/`
- [ ] No test file changes other than its import lines
- [ ] `tsconfig.json` `include` gains `example-shared`;
      `tsconfig.build.json` `exclude` gains it
- [ ] `npm test` passes, `npm run lint` passes, `npm run build-example`
      succeeds
- [ ] The main demo, persistence demo and multi-device demo behave
      identically in the browser

### US-002: Worker scaffolding and deploy

**Description:** As a developer, I need a deployable Cloudflare Worker
that serves static assets and exports a Durable Object, so every later
story has somewhere to land and the deploy path is proven before any
protocol exists.

**Context:** The repo has no Cloudflare code today. New Durable Object
namespaces must use the SQLite storage backend, which is also what the
Workers free plan requires. The declarative `exports` field supersedes
the `migrations` array and the two are mutually exclusive. Two Workers
cannot share a hostname, so one Worker serves the page, handles the
WebSocket upgrade, and exports the Durable Object.

**Acceptance Criteria:**
- [ ] New `example-realistic-demo/index.ts` exporting a default fetch
      handler and a `Room` class extending `DurableObject`
- [ ] New `example-realistic-demo/wrangler.jsonc` with `main`, an
      `assets` block using
      `not_found_handling: "single-page-application"` and
      `run_worker_first: ["/api/*"]`, a `ROOM` Durable Object binding,
      the declarative `exports` field with `"storage": "sqlite"`, a
      current `compatibility_date`, and `observability`
- [ ] The `Room` class is declared with `exports`, not a `migrations`
      array
- [ ] Everything expressible in `wrangler.jsonc` is set there rather
      than in the Cloudflare dashboard
- [ ] New `example-realistic-demo/tsconfig.json` scoped to the Worker
      entry, using `@cloudflare/workers-types`, so the root config's
      `vite/client` types do not conflict
- [ ] New `example-realistic-demo/vite.config.js` with root `./client`,
      `base: '/'`, `outDir: './dist'`, and a `/api` proxy with
      `ws: true` to `wrangler dev` for development
- [ ] A placeholder `client/index.ts` so there is something to serve
- [ ] `wrangler` added to root `devDependencies`; nothing added to
      `dependencies`, so the published package is unchanged
- [ ] `package.json` gains `build:realistic`, `worker:dev` and
      `worker:deploy` scripts, each passing
      `-c example-realistic-demo/wrangler.jsonc` where applicable
- [ ] `GET /api/health` returns 200 without touching a Durable Object
- [ ] An unmatched path returns 200 with the page, not 404
- [ ] `tsconfig.json` `include` and `tsconfig.build.json` `exclude`
      updated for `example-realistic-demo`
- [ ] `npm run lint` passes over `example-realistic-demo/`
- [ ] Deployed, with `/api/health` answering on the deployed origin

### US-002a: Document the Cloudflare dashboard settings

**Description:** As the person who owns the Cloudflare account, I need a
written list of what I must set by hand, so the split between checked-in
config and account config is explicit rather than folklore.

**Context:** Workers Builds settings have no `wrangler.jsonc` equivalent.
The docs state that Workers Builds does not honor Custom Builds
configuration from the Wrangler config file. Those settings are the only
things that should require the dashboard.

**Acceptance Criteria:**
- [ ] `example-realistic-demo/README.md` lists every dashboard setting
      required, and states that nothing else needs setting by hand
- [ ] Covers the Workers Builds root directory (the repo root), the
      build command (`npm run build:realistic`), and the deploy command
      (`npx wrangler deploy -c example-realistic-demo/wrangler.jsonc`)
- [ ] Explains why the root directory is the repo root: one
      `node_modules` has to cover `vite`, `preact`, `src/` and
      `example-shared/`, and the client imports across that boundary
- [ ] Covers the GitHub repo connection and which branch deploys
- [ ] States that there are no secrets, and that if any are added later
      they go through `wrangler secret put` rather than the config file
- [ ] Names the deployed origin
- [ ] Documents the two-process development workflow

### US-003: Wire contract

**Description:** As a developer, I need one module defining every message
that crosses the WebSocket, so the page and the Durable Object cannot
drift apart and neither side invents a shape the other does not expect.

**Context:** Decision 6 says the delivery service needs no MLS
wire-format knowledge, while decision 13 requires it to remember which
identities were admitted and removed. Both hold only if the socket
carries two kinds of traffic: opaque MLS payloads the room stores and
orders without reading, and a small control vocabulary the room
understands. The ledger is therefore fed by claims the creator's client
makes, and the room can verify none of them.

**Acceptance Criteria:**
- [ ] New `example-realistic-demo/protocol.ts` exporting `ClientMessage`
      and `RoomMessage` as discriminated unions on `type`, plus
      `LogEntry`, `PendingRequest`, `EntryKind`, `Standing` and
      `ErrorReason`
- [ ] `ClientMessage` covers `create`, `hello`, `mls`, `join-request`,
      `approve`, `deny`, `removed`, `welcome`
- [ ] `RoomMessage` covers `created`, `no-room`, `room-state`, `log`,
      `entry`, `welcome-you`, `pending`, `roster`, `error`
- [ ] Every `LogEntry` carries `seq`, `sender`, a client-asserted `kind`
      of `commit`, `proposal` or `application`, and an opaque base64
      `payload`
- [ ] Identity is the base64url signature public key. No display names
      appear anywhere in the protocol
- [ ] `welcome` carries only `to` and `payload`; the room stamps the
      cursor and prior count
- [ ] The module imports nothing from `preact`, the DOM, `../src/`, or
      any Cloudflare global, so both sides can use it and it unit tests
      in Node
- [ ] A narrowing helper per direction rejects an unknown `type`, a
      missing required field, and a non-object
- [ ] New `test/example-realistic-demo/protocol.ts` covers the narrowing
      helpers, registered in `test/index.ts`
- [ ] Typecheck and lint pass

### US-004: Pure room logic

**Description:** As a developer, I need the room's storage-free decisions
in their own module, so they can be unit tested in Node without a Durable
Object.

**Acceptance Criteria:**
- [ ] New `example-realistic-demo/room-logic.ts` exports the next `seq`
      from a high-water mark, replay selection for a cursor, roster
      assembly from members and live identities, and ledger
      classification into `stranger`, `pre-approved` or
      `previously-removed`
- [ ] The module touches no storage and no Cloudflare global
- [ ] New `test/example-realistic-demo/room-logic.ts` covers replay from
      a cursor at zero, mid-log, at the end and beyond the end; a roster
      with some members live and some not; and all three ledger
      classifications including an identity present in both sets
- [ ] Test file registered in `test/index.ts`
- [ ] Typecheck and lint pass

### US-005: Room Durable Object with an append-only log

**Description:** As a developer, I need the room to store every message
in order and replay from any position, so a client that was away can
catch up rather than sitting at an epoch the group has left.

**Context:** A pure fan-out relay would carry a live conversation fine
but would make persistence pointless. Storing the log is what makes
returning work, and storing ciphertext costs the room nothing it can
read.

**Acceptance Criteria:**
- [ ] `Room` uses the WebSocket Hibernation API (`ctx.acceptWebSocket`,
      `webSocketMessage`, `webSocketClose`, `webSocketError`) so the room
      can sleep while sockets stay open
- [ ] SQL tables for `meta` and `log` are created on first use
- [ ] `GET /api/room/:id` returns the room's creation and expiry times,
      or 404 when it has no metadata, so the page can tell a gone room
      from a room needing a user before any user exists
- [ ] `GET /api/room/:id/ws` rejects an id outside the nanoid alphabet
      or matching a reserved prefix such as `api` or `assets`
- [ ] `create` on a room with no metadata records the creation time, the
      creator's identity and a random creator token, and returns
      `created` once
- [ ] `create` on a room that already has metadata is answered
      `error: 'room-exists'`
- [ ] A `hello` carrying the creator token identifies that client as the
      creator; any other client is an ordinary member
- [ ] An `mls` message is appended with the next `seq` and broadcast to
      every other connected client as an `entry`
- [ ] The room never decodes an MLS payload. `payload` and `kind` are
      stored and forwarded exactly as received, with no validation
- [ ] A `hello` carrying a cursor replays every entry after it as a `log`
      batch, then streams live entries
- [ ] Identity is both a hibernation tag and a `serializeAttachment`
      value, so it survives hibernation
- [ ] Liveness is derived from `ctx.getWebSockets()` and never stored; a
      `roster` message is broadcast when it changes
- [ ] A second socket for the same identity replaces the first
- [ ] `ctx.setWebSocketAutoResponse` answers keepalive pings without
      waking the object
- [ ] Typecheck and lint pass
- [ ] Two browser profiles on one room see each other's `mls` entries,
      and a reconnect with a stored cursor replays only what it missed

### US-006: Asynchronous join, in both directions

**Description:** As a developer, I need the room to hold a pending join
request until the creator acts on it, and to hold the resulting Welcome
until its recipient reconnects, so neither party has to be present when
the other one is.

**Context:** With a creator-approved join and only live delivery, the
demo deadlocks in the most ordinary situation there is: two people in
different time zones, one of whom closes a laptop. The Welcome cannot go
into the shared log, because a later joiner replaying that log would
encounter Welcomes addressed to someone else.

**Acceptance Criteria:**
- [ ] A `join-request` is stored in a `pending` table keyed by the
      requester's identity, and survives that client disconnecting
- [ ] Re-requesting from the same identity replaces the stored request
      rather than adding a second
- [ ] The creator receives the full pending queue on connect and each new
      request live
- [ ] `approve` removes the request from the queue and records the
      identity in the ledger as admitted
- [ ] `deny` discards the request without recording an admission
- [ ] A `welcome` addressed to an identity is stored in a per-recipient
      `mailbox`, not in the shared log, and delivered as `welcome-you`
      when that identity connects, then cleared
- [ ] The room stamps `cursor` from the current high-water `seq` and
      `priorCount` from the number of `application` entries at or below
      it, so the page can render placeholders without the room knowing
      what a message is
- [ ] `approve`, `deny`, `removed` and `welcome` from a client that did
      not present the creator token are answered
      `error: 'not-creator'`
- [ ] Typecheck and lint pass
- [ ] A join request survives the requester closing their tab, and a
      Welcome survives the recipient being offline when it is issued

### US-007: The room remembers who it admitted and who it removed

**Description:** As a creator, I want someone I previously removed shown
as a previous removal rather than as a stranger, so the Remove control
does not quietly empty itself of meaning.

**Context:** The ledger is fed entirely by the creator's own claims. The
room cannot verify that an `approve` corresponds to a commit that was
actually issued, and the page should not imply otherwise.

**Acceptance Criteria:**
- [ ] A `ledger` table stores each identity as `admitted` or `removed`
- [ ] `removed` from the creator moves an identity to `removed`
- [ ] A `join-request` from a removed identity is surfaced with
      `standing: 'previously-removed'`
- [ ] A `join-request` from an admitted, not-removed identity is
      surfaced as `'pre-approved'`
- [ ] A `join-request` from an unknown identity is surfaced as
      `'stranger'`
- [ ] Nothing in the room inspects an MLS message to derive any of this
- [ ] Classification reuses the pure function from US-004
- [ ] Typecheck and lint pass

### US-008: Rooms expire three days after creation

**Description:** As a visitor, I want a room to state that it is deleted
three days after it was created, so a URL that stops working is something
I was told about rather than something that silently breaks.

**Context:** Measuring from creation rather than from last use keeps the
log complete from epoch zero for as long as the room exists. Expiring on
inactivity would mean pruning the log from the front while the room runs,
so a returning member could arrive holding a cursor into messages that no
longer exist.

**Acceptance Criteria:**
- [ ] Room creation sets an alarm for creation time plus three days
- [ ] The alarm handler deletes all storage, calls `deleteAlarm()`
      explicitly, and closes live sockets
- [ ] The handler is safe to run twice, since alarms are at-least-once
- [ ] The room reports creation and expiry times in `room-state`, so the
      page can display the rule
- [ ] A `hello` for a room with no stored metadata is answered
      `no-room`, identically for an expired room and an id that never
      existed
- [ ] Typecheck and lint pass

### US-009: Client shell and delivery client

**Description:** As a developer, I need one module owning the WebSocket
and one owning inbound ordering, so reconnection, cursor tracking and
serial processing live in one place rather than spread through the page.

**Context:** Inbound entries must be applied strictly in order, and
applying one is async because it involves crypto. A live `entry` can
arrive while a `log` batch is still being processed. Without a serial
queue, MLS rejects an out-of-order commit and the client is stuck.

**Acceptance Criteria:**
- [ ] New `client/state.ts` holding signals for one user, one room and
      one connection: `user`, `roomId`, `creatorToken`, `expiresAt`,
      `connection`, `cursor`, `live`, `pending`, `messages`, `persist`,
      `status`
- [ ] A computed signal derives the view as `setup`, `waiting`, `room`
      or `gone`
- [ ] Sequential signal writes go through `batch`; component-local state
      uses `useSignal`
- [ ] New `client/delivery-client.ts` connects, sends `hello` with the
      stored cursor, and exposes room-to-client messages to the page
- [ ] The WebSocket URL is derived from the current origin, swapping the
      scheme for `wss`. There is no configured endpoint and no
      environment variable
- [ ] New `client/entry-queue.ts` drains inbound entries one at a time,
      so a live `entry` arriving during a `log` batch is applied after it
- [ ] A `commit` that fails to process stops the queue, reports it, and
      does not advance the cursor
- [ ] An `application` entry that fails to decrypt is counted as
      undecryptable, advances the cursor, and does not stop the queue
- [ ] New `client/delivery-cursor.ts` holds the cursor advance rule and
      the backoff schedule as pure functions, importing nothing from the
      DOM
- [ ] The cursor never moves backward and never skips a gap in `seq`
- [ ] Reconnects automatically with capped backoff, and exposes a
      connection state the page can display
- [ ] Sending while disconnected reports failure rather than silently
      dropping
- [ ] MLS payloads are base64 on the wire and `Uint8Array` at the module
      boundary, reusing `bytesToBase64` from `src/util/byte-array.js`
- [ ] New `test/example/delivery-cursor.ts` covers the cursor and
      backoff rules, registered in `test/index.ts`
- [ ] Typecheck and lint pass

### US-010: Create a user, create a room

**Description:** As a visitor, I want to enter a name, create one user,
and then create a room, so I have a URL to send to someone else.

**Acceptance Criteria:**
- [ ] New `client/index.ts` mounts the app, reads `location.pathname`,
      and listens with `route-event`
- [ ] New `client/mls-actions.ts` holds this page's group operations for
      one client, rather than reusing `example/demo-actions.ts`
- [ ] New `client/views/setup.ts` shows a name field and a "Create User"
      button at the bare route
- [ ] Creating a user generates one key package and one non-extractable
      signature keypair, matching the approach the persistence demo uses
- [ ] Once a user exists, a "Create Room" button appears
- [ ] Creating a room mints a short random id with `nanoid`, creates the
      MLS group with the local user as its only member, connects, sends
      `create`, and navigates to `/<roomId>`
- [ ] The MLS group id is generated independently of the room id
- [ ] The full room URL is displayed with a control for copying it
- [ ] The creator token from `created` is held in page state
- [ ] Typecheck and lint pass
- [ ] Verify in browser

### US-011: Ask to join a room

**Description:** As someone who was sent a room URL, I want to create a
user there and ask to join, so I can be added to the group without the
creator having to be online at that moment.

**Acceptance Criteria:**
- [ ] Opening a room URL probes `GET /api/room/:id` before opening a
      socket, so a gone room and a room needing a user are
      distinguishable with no user present
- [ ] Opening a live room URL without a local user shows the same name
      field and "Create User" button
- [ ] Creating a user there connects, sends `hello`, publishes a
      `join-request`, and shows a waiting state naming the room
- [ ] New `client/views/waiting.ts` renders that state
- [ ] A `welcome-you` received at any point joins the group from the
      Welcome, adopts its `cursor` and `priorCount`, and moves the page
      into the room view
- [ ] A Welcome that arrives while the tab is closed is delivered on the
      next connect
- [ ] Typecheck and lint pass
- [ ] Verify with two browser profiles, including with the requester's
      tab closed at approval time

### US-012: Approve and deny

**Description:** As the room's creator, I want to see who has asked to
join and approve or deny them, so joining is a decision rather than
anyone with the URL inserting themselves.

**Acceptance Criteria:**
- [ ] The creator sees a pending-requests section
- [ ] Each request's display name comes from decoding that request's key
      package and reading its credential, since names are not on the wire
- [ ] Each request is labelled by its `standing`: stranger, pre-approved,
      or previously removed
- [ ] Approving commits an Add and sends `mls{kind:'commit'}`, then
      `welcome` addressed to that identity, then `approve` -- in that
      order, so the commit is in the log before the room stamps the
      cursor, and the ledger records only admissions actually committed
- [ ] Denying sends `deny` and removes the request from the list
- [ ] A `pre-approved` request runs the same sequence with no prompt
      while the creator is connected
- [ ] Requests that arrived while the creator was away appear on their
      next visit
- [ ] The pending section is not rendered for non-creators
- [ ] Typecheck and lint pass
- [ ] Verify with two browser profiles

### US-013: Member list, liveness, and removal

**Description:** As a member, I want to see who is in the group and at
what epoch, and as the creator I want to remove someone, so the gap
between what the protocol knows and what is true is visible and
actionable.

**Context:** The room cannot know the group roster, because it never
parses a commit. So the member list comes from the client's own ratchet
tree and only the connected marks come from the room. Protocol state and
transport state are shown as different things.

**Acceptance Criteria:**
- [ ] The member list and epoch are derived from the client's own ratchet
      tree, not from the room
- [ ] Connected and disconnected marks come from the room's `roster`
- [ ] The list and epoch update on every processed commit, whether it
      arrived live or in a replay batch
- [ ] A member whose socket has dropped is marked disconnected, and
      nothing is removed automatically
- [ ] The page states in plain text that a disconnected member's leaf is
      still in the ratchet tree and the group still encrypts to it
- [ ] Only the creator's client renders a Remove control next to other
      members
- [ ] The page states in plain text that creator-only removal is a rule
      this demo enforces in its own interface, and that MLS itself grants
      no such authority
- [ ] Removing commits a Remove, sends `mls{kind:'commit'}`, then sends
      `removed`
- [ ] A removed member's own page reports that they were removed rather
      than failing to process the commit, reading `GroupActiveState` from
      the processed result
- [ ] Typecheck and lint pass
- [ ] Verify with two browser profiles

### US-014: Chat with replay and undecryptable history

**Description:** As a member, I want to send and read messages, and I
want to see that messages sent before I joined exist but cannot be read,
so forward secrecy is something I can point at rather than something I
have to take on faith.

**Context:** An MLS sender cannot decrypt its own application message.
Live this never arises, because the room broadcasts an entry only to
clients other than its sender. On reconnect it does, because replay
includes the client's own past entries.

**Acceptance Criteria:**
- [ ] New `client/views/room.ts` has a chat pane with an input and a send
      control
- [ ] Sending encrypts to the group and sends `mls{kind:'application'}`
- [ ] Received application entries are decrypted and appended with their
      sender and epoch
- [ ] Returning to a room replays messages sent while away, in order
- [ ] A client's own past entries are skipped on replay, matched by
      `sender`, and rendered from locally recorded plaintext
- [ ] Entries before this member's join cursor render as a single
      placeholder stating how many there are
- [ ] Consecutive undecryptable entries after joining collapse into one
      counted placeholder, since `retainKeysForEpochs` is 4 and a member
      away across more than four commits can lose older messages
- [ ] A member who joined at epoch zero sees no leading placeholder
- [ ] The page explains what a placeholder means, so it does not read as
      an error
- [ ] New `client/timeline.ts` builds the ordered list of message and
      placeholder items as a pure function
- [ ] New `test/example/timeline.ts` covers no prior entries, prior
      entries collapsing into one placeholder, a placeholder before the
      first readable message, and consecutive undecryptable entries after
      joining collapsing together
- [ ] Test file registered in `test/index.ts`
- [ ] Typecheck and lint pass
- [ ] Verify with two browser profiles, including a second member joining
      after messages have been sent

### US-015: Persistence as a standing control

**Description:** As a visitor, I want a Persist toggle in the page's
status area that I can turn on or off at any point, so persistence is a
property of the session rather than a stage I passed through.

**Context:** A waiting joiner has a key package and private keys but no
group state, while `PersistedMember` requires `state` and
`restoredUsersFromRecords` reads `state.groupContext.groupId`. The page
also needs `roomId`, `cursor` and `creatorToken`, none of which are
member state. So a second object store is added beside the member store
in the same database, leaving `PersistedMember` unchanged.

**Acceptance Criteria:**
- [ ] `example-shared/persistence-storage.ts` gains
      `createSessionStore({ dbName })` beside `createMemberStore`,
      backed by a second object store in the same database
- [ ] `PersistedMember` keeps its exact shape and existing signature, so
      the persistence and multi-device demos are untouched
- [ ] The shared open path creates both object stores; the two existing
      databases stay at version 1 and simply never gain a `session`
      store, which they do not need
- [ ] The page uses `mls-realistic-demo` for both stores
- [ ] A Persist toggle is present from the first render, before a user
      exists, and stays present throughout
- [ ] Turning it on writes whatever state already exists: the user, the
      group state if any, the room id, the cursor, and the creator token
      if this client is the creator
- [ ] Turning it off deletes that stored state
- [ ] While on, every state-advancing action re-saves, and a client no
      longer in the group has its member record dropped, reusing
      `partitionPersistedNames`
- [ ] A waiting joiner with no group state is persisted and returns to
      the waiting state on reload
- [ ] On load with stored state, the user and group are restored and the
      client reconnects from its stored cursor
- [ ] Stale-record handling reuses `partitionRestorableRecords`
- [ ] A restore failure is caught and reported into the status line,
      never allowed to escape module evaluation
- [ ] The page shows the origin's storage-persistence status and a
      "Request persistent storage" button, reusing
      `example-shared/storage-persistence.ts`
- [ ] Reset deletes only `mls-realistic-demo` and leaves the room on the
      server untouched
- [ ] Using this page leaves the other two persisting demos' records
      intact, and vice versa
- [ ] New coverage for `createSessionStore` in
      `test/example/persistence-storage.ts` or a sibling file, for the
      pure parts only
- [ ] Typecheck and lint pass
- [ ] Verify in browser, including a reload

### US-016: Expired or unknown room

**Description:** As someone opening an old room URL, I want to be told the
room is gone and be offered a new one, so an expired link is a finished
state rather than a broken page.

**Acceptance Criteria:**
- [ ] New `client/views/gone.ts` renders when the probe returns 404 or a
      `hello` is answered `no-room`
- [ ] It says the room does not exist or has expired, without claiming to
      know which
- [ ] It offers to create a new room
- [ ] A client with persisted state for a group whose room is gone is
      told that, rather than being left showing a group it can no longer
      reach
- [ ] Typecheck and lint pass
- [ ] Verify in browser with a made-up room id

### US-017: Page explainer and demo-rule disclosures

**Description:** As a visitor, I want the page to tell me what it is
demonstrating and where the demo's own rules begin, so I do not leave
believing MLS provides something it does not.

**Acceptance Criteria:**
- [ ] An intro paragraph states that this page is one real client, that a
      second participant means a second browser profile, and that the
      delivery service is a Durable Object that never reads a message
- [ ] A "How to use" card lists the order: create a user, create a room,
      send the URL, approve the request
- [ ] The room displays its expiry rule and the time it expires
- [ ] The creator-only removal disclosure from US-013 is present
- [ ] The disconnected-member disclosure from US-013 is present
- [ ] The placeholder explanation from US-014 is present
- [ ] The page states that the room's record of who was admitted and
      removed is asserted by the creator's client and cannot be verified
      by the room
- [ ] Styling follows `example/style.css` conventions and reuses its
      variables rather than introducing a second palette
- [ ] Typecheck and lint pass
- [ ] Verify in browser

## Functional Requirements

- FR-1: The page holds exactly one key package, one signature keypair,
  and one client state. A second participant means a second browser
  profile.
- FR-2: The client belongs to at most one room at a time.
- FR-3: One Cloudflare Worker serves the page's static assets, handles
  the WebSocket upgrade, and exports the Durable Object class. The whole
  unit lives in `example-realistic-demo/`, and everything expressible in
  `wrangler.jsonc` is set there rather than in the dashboard.
- FR-3a: The page is served at the root of the Worker's hostname, not as
  a route on the GitHub Pages site. A room URL is
  `<worker-host>/<roomId>`.
- FR-3b: GitHub Pages continues to serve `example/` at base
  `/webcrypto-mls`. `build-example`, `example/routing.ts`,
  `example/nav.ts` and `.github/workflows/gh-pages.yml` are unchanged.
- FR-3c: The WebSocket is same-origin, derived from `location`. There is
  no configured delivery origin and no environment variable.
- FR-4: The Durable Object stores every handshake and application message
  in order and replays from a client's cursor.
- FR-5: The Durable Object never decodes an MLS message. Payloads are
  opaque and each entry's `kind` is asserted by the sending client.
- FR-6: Joining is creator-approved and carried by Welcome. External
  commit is not used.
- FR-7: Pending join requests and undelivered Welcomes are held by the
  room until claimed.
- FR-8: A Welcome is stored in a per-recipient mailbox, not in the shared
  log.
- FR-9: The room stores admitted and removed identities. A request from
  an admitted identity is committed without prompting; one from a removed
  identity is marked as a previous removal.
- FR-9a: The room's ledger is client-asserted and unverifiable by the
  room. The page states this.
- FR-10: Only the creator's client renders Remove controls, and the page
  states this is an interface convention with nothing cryptographic
  behind it.
- FR-11: The room tracks socket liveness and marks disconnected members.
  Nothing is removed automatically. Liveness is derived from live sockets
  and never stored.
- FR-11a: The member list and epoch are derived from the client's own
  ratchet tree. Only the connected marks come from the room.
- FR-12: The Persist toggle is present from the first render and governs
  whether account, group and session state are written to browser
  storage. Turning it on writes existing state; turning it off clears it.
- FR-13: Messages before a member's join cursor render as counted
  placeholders. So does any other undecryptable message.
- FR-13a: A client skips its own past entries on replay and renders them
  from locally recorded plaintext, because an MLS sender cannot decrypt
  its own application message.
- FR-14: The room id is a short random routing address. The MLS group id
  is separate and is not derived from it.
- FR-15: The page reuses `createMemberStore` and adds
  `createSessionStore`, both against `mls-realistic-demo`.
- FR-16: The whole room is deleted three days after creation. Every room
  displays the rule.
- FR-17: An unrecognised room id and an expired room are reported as one
  state.
- FR-18: Reset clears only this page's stored data and leaves the room on
  the server untouched.
- FR-19: Inbound entries are applied strictly in order through a serial
  queue. A failed commit halts it; a failed decrypt does not.
- FR-20: Modules used by more than one deployable application live in
  `example-shared/`. Modules used only by the Pages site stay in
  `example/`.

## Non-Goals

- No end-to-end browser automation. Every behavior needing two live
  clients is verified by hand with two browser profiles.
- No unit tests for the Durable Object's storage layer, the WebSocket
  plumbing, or the Preact components. The pure logic they depend on is
  extracted and tested; the I/O around it is not. No test may touch the
  DOM, `indexedDB`, `WebSocket` or `DurableObject`.
- No recovery path when a creator stops coming back. Pending requests
  accumulate until the room expires. There is no administrator to
  transfer, because there is no administrator.
- No warning as a room approaches expiry, and no attempt to tell a former
  member which specific room expired.
- No enforcement of any policy in the delivery service. It does not
  inspect messages and cannot reject an unauthorised removal.
- No external commit path. Joining is by Welcome only.
- No multiple rooms per browser, and no identity shared across rooms.
- No pruning of the log while a room lives.
- No nav entry, route, or `404.html` on the GitHub Pages site. The page
  is standalone on its own origin and does not join the site nav.
- No changes to the behavior of the main demo, the persistence demo, or
  the multi-device demo. The extraction in US-001 is a pure refactor from
  their side.
- No move of `demo-actions.ts`, `demo-state.ts`, `tree-view.ts`,
  `tree-diagram.ts`, `message-*.ts`, `device-*.ts`, `participants.ts`,
  `nav.ts`, `routing.ts` or `state.ts` into `example-shared/`. Only the
  Pages site uses them.
- No ratchet tree diagram on this page.

## Design Considerations

Reuse where it exists. `createMemberStore`, `storage-persistence.ts`, and
the non-extractable signature keypair approach all come from the
persisting demos. `encodeMlsMessage` and `decodeMlsMessage` are already
exercised by `example/demo-actions.ts`, so wire encoding is inherited
rather than invented.

Where reuse does not fit. `createDemoState()` models a map of many
clients, the opposite of this page, so the client gets its own state
module. `example/routing.ts` and `example/nav.ts` are not extended,
because a standalone page on its own origin has no site nav to join.

Two channels on one socket. The room understands the control vocabulary
and is blind to the MLS payloads. Keeping both in one union in
`protocol.ts` means the split is visible in one file rather than being a
convention two codebases separately remember.

Pure logic out, I/O in. Unit tests bundle through esbuild for Node with
no DOM and no Cloudflare globals, so anything worth testing must be
reachable without either. That is why the replay rule, the ledger
classification, the cursor rule and the timeline shape are separate
modules from the socket and the SQL.

CSS. Follow the nested-selector style in `example/style.css` and reuse
its variables. Do not restyle the other three demos.

State. Frontend state uses `@preact/signals`, sequential writes are
wrapped in `batch`, and component-local state uses `useSignal`.

## Technical Considerations

- Two Workers cannot share a hostname. Not on `workers.dev`, and not on a
  custom domain, where a Custom Domain binds every path to one Worker.
  That is why one Worker does all three jobs, and why the WebSocket is
  same-origin.
- `assets.not_found_handling: "single-page-application"` returns 200 with
  `index.html` for an unmatched path, so a room URL renders with a
  correct status. `run_worker_first: ["/api/*"]` keeps the API path from
  being served from the asset manifest.
- Static asset requests are not billed. The free plan's 100,000 requests
  and 100,000 SQL row writes per day apply to WebSocket and API traffic
  only.
- Cloudflare free plan supports Durable Objects with the SQLite backend
  only, and new namespaces must use SQLite regardless of plan.
- The declarative `exports` field replaces the `migrations` array and is
  mutually exclusive with it.
- The WebSocket Hibernation API is what makes holding a room open cheap.
  Per-socket state in `serializeAttachment` is capped at 16KB.
- A Durable Object has one alarm at a time with at-least-once delivery,
  so the expiry handler must be safe to run twice.
- Workers Builds configuration cannot be committed. The docs state it
  does not honor Custom Builds settings from the Wrangler config file. Of
  those settings, only the root directory, build command, deploy command,
  repo and branch are needed here. The root directory is the repo root so
  one `node_modules` covers `vite`, `preact`, `src/` and
  `example-shared/`.
- `tsconfig.json` sets `types: ["vite/client"]`, which conflicts with
  `@cloudflare/workers-types` on globals. The Worker entry therefore gets
  its own tsconfig. `protocol.ts` and `room-logic.ts` reference neither
  set of globals, so they typecheck under both.
- `.gitignore` already ignores any directory named `dist`, so
  `example-realistic-demo/dist/` needs no new entry.
- `defaultLifetime()` gives a key package 30 days, comfortably outlasting
  a three-day room, so a pending request cannot expire underneath the
  creator.
- `defaultKeyRetentionConfig.retainKeysForEpochs` is 4. A member away
  across more than four commits can lose the ability to decrypt older
  application messages even though they were a member at the time. That
  is why every undecryptable message becomes a placeholder, not only
  pre-join ones.
- Creator identification is a random token issued by the room at creation
  and held by that client, persisted with the group state. A creator who
  does not persist loses moderation on reload, the same end state as
  losing group state.
- The client-asserted `kind` tag lets the room count entries without
  parsing them. A client that lies about `kind` corrupts only its peers'
  placeholder counts.
- WebSocket 101 responses over service bindings, and cross-Worker Durable
  Object access by `script_name` on the free plan, are both unconfirmed
  by official docs. The single-Worker design depends on neither.
- `nanoid` and `route-event` are already devDependencies.

## Success Metrics

- Two browser profiles, on different machines, hold a conversation
  through the deployed Worker.
- The second profile can close its tab, be approved while away, reopen
  the room URL, and land in the group.
- The creator can close their tab, receive a request while away, and see
  it on their next visit.
- A member who joins after messages were sent sees a placeholder stating
  how many messages they cannot read, and can read everything sent
  afterward.
- Disconnecting one profile marks it as disconnected in the other's
  member list within a few seconds, without changing the epoch.
- Removing a member advances the epoch, blanks their leaf, and their own
  page reports the removal.
- A removed member who asks to join again is shown to the creator as a
  previous removal.
- Turning Persist on mid-session and reloading restores the group at its
  current epoch and resumes from the stored cursor.
- Reset clears this page's data and leaves the persistence and
  multi-device demos' records intact.
- A made-up room id reports that the room does not exist or has expired.
- A room URL returns HTTP 200, not 404.
- `npm test` passes, including the new pure-module tests, and `npm run
  lint` passes over `example-shared/` and `example-realistic-demo/`.
- The three existing demos on GitHub Pages behave identically after the
  extraction in US-001.
- Every Cloudflare setting a reader must apply by hand is written down in
  `example-realistic-demo/README.md`, and nothing else is needed to
  deploy.

## Open Questions

None blocking. Two are recorded in FDR-002 and deliberately left
unanswered here: what happens when a creator stops coming back, and
whether a room approaching expiry should warn its members.

# Realistic Demo Design

## Summary

This design adds a fourth demo application without touching the three
that already exist. GitHub Pages keeps serving `example/` unchanged;
the new demo is a separate deployable unit under
`example-realistic-demo/`, backed by a single Cloudflare Worker. That
one Worker does three jobs at once -- serves the page's static
assets, upgrades the WebSocket connection, and hosts a Durable
Object -- because two Workers cannot share a hostname, and that
collapse is what makes the socket same-origin with no configured
endpoint to get wrong. Code used by more than one demo
moves into a new `example-shared/` directory; code the new demo
needs uniquely stays under `example-realistic-demo/`.

The approach keeps the server ignorant of MLS. `protocol.ts` defines
a small, shared wire contract that splits one socket into two kinds
of traffic: MLS payloads, which the Durable Object (one per room)
stores and forwards as opaque base64 and never decodes, and a
handful of control messages -- join requests, approvals, removals --
it does understand well enough to keep a ledger of who was admitted.
Each browser client derives its own membership view from its MLS
ratchet tree rather than trusting the server's report, and applies
incoming messages through a serial queue so an async decrypt can
never race an out-of-order commit. Persistence, replay, and expiry
are each handled as an explicit, testable rule: a stored cursor
resumes replay, an alarm deletes an expired room, and undecryptable
history renders as counted placeholders instead of errors. The work
ships in eight phases, moving from shared-code extraction and Worker
scaffolding through the wire contract and room storage to the client
shell and, finally, chat and persistence, with pure logic extracted
into Node-testable modules at every step.

## Definition of Done

**Deliverable:** A standalone demo application where one browser is one
MLS client, served by a single Cloudflare Worker that also hosts one
Durable Object per room acting as the MLS delivery service. The whole
deployable unit lives in `example-realistic-demo/`. Code shared with the
existing demos moves to `example-shared/`. GitHub Pages continues to
serve the three existing demos unchanged.

**Done when:** Two people in different browser profiles create users,
exchange a room URL, request and approve a join, and hold an encrypted
conversation through the deployed Worker -- with all of it surviving
either party being offline at the time. The room keeps an append-only
log replayed from a per-client cursor, marks disconnected members
without evicting them, remembers who was admitted and removed, shows
undecryptable pre-join history as counted placeholders, offers
persistence as a standing toggle, and deletes itself three days after
creation. Pure logic is extracted into modules with Node unit tests, and
every Cloudflare setting that cannot be checked in is documented.

**Out of scope:** End-to-end browser automation, and any test requiring
the DOM, `indexedDB`, `WebSocket`, or `DurableObject`.
Creator-abandonment recovery. Expiry warnings. External commit. Multiple
rooms per browser. Policy enforcement in the delivery service. Any
change to the behavior of the main demo, the persistence demo, or the
multi-device demo.

## Acceptance Criteria

### realistic-demo.AC1: The Worker serves the page and the API
- **realistic-demo.AC1.1 Success:** An unmatched path such as
  `/aB3xK9pQ2m` returns HTTP 200 with the page, not 404
- **realistic-demo.AC1.2 Success:** The page loads from the deployed
  Worker origin and connects to `wss://` on that same origin, with no
  configured endpoint
- **realistic-demo.AC1.3 Success:** `GET /api/room/:id` for an existing
  room returns its creation and expiry times
- **realistic-demo.AC1.4 Failure:** `GET /api/room/:id` for an unknown
  id returns 404
- **realistic-demo.AC1.5 Failure:** A room id containing characters
  outside the nanoid alphabet, or matching a reserved prefix such as
  `api` or `assets`, is rejected rather than routed

### realistic-demo.AC2: A visitor creates one user and one room
- **realistic-demo.AC2.1 Success:** Creating a user generates exactly one
  key package and one non-extractable signature keypair
- **realistic-demo.AC2.2 Success:** Creating a room creates the MLS group
  with the local user as its only member and navigates to `/<roomId>`,
  with the group id generated independently of the room id
- **realistic-demo.AC2.3 Success:** The full room URL is displayed and
  can be copied
- **realistic-demo.AC2.4 Failure:** `create` sent to a room id that
  already has metadata is answered with `error: 'room-exists'`

### realistic-demo.AC3: Asking to join works across absence
- **realistic-demo.AC3.1 Success:** Opening a room URL without a local
  user shows the name field; creating a user there publishes a
  `join-request` and shows the waiting state
- **realistic-demo.AC3.2 Success:** A `welcome-you` joins the group from
  the Welcome and adopts its `cursor` and `priorCount`
- **realistic-demo.AC3.3 Success:** A join request survives its requester
  closing the tab, and is still pending on the creator's next visit
- **realistic-demo.AC3.4 Success:** A Welcome issued while its recipient
  is offline is delivered on their next connect

### realistic-demo.AC4: Approval, denial, and the identity ledger
- **realistic-demo.AC4.1 Success:** Approving commits an Add and sends
  `mls{commit}`, then `welcome`, then `approve`, in that order, and the
  newcomer joins
- **realistic-demo.AC4.2 Success:** A `pre-approved` request is committed
  with no prompt while the creator is connected
- **realistic-demo.AC4.3 Success:** Denying discards the request and
  records no admission
- **realistic-demo.AC4.4 Success:** A repeat request from the same
  identity replaces the stored request rather than creating a second
- **realistic-demo.AC4.5 Logic:** An identity in neither set classifies
  as `stranger`
- **realistic-demo.AC4.6 Logic:** An admitted identity that has not been
  removed classifies as `pre-approved`
- **realistic-demo.AC4.7 Logic:** A removed identity classifies as
  `previously-removed`, including when it appears in both sets
- **realistic-demo.AC4.8 Failure:** `approve`, `deny`, `removed` or
  `welcome` without the creator token is answered with
  `error: 'not-creator'`

### realistic-demo.AC5: Membership, liveness, and removal
- **realistic-demo.AC5.1 Success:** The member list and epoch are derived
  from the client's own ratchet tree and update on every processed
  commit, whether it arrived live or in a replay batch
- **realistic-demo.AC5.2 Success:** A member whose socket has dropped is
  marked disconnected and is not removed from the group
- **realistic-demo.AC5.3 Success:** Only the creator's client renders a
  Remove control
- **realistic-demo.AC5.4 Success:** Removing commits a Remove and sends
  `removed`; the epoch advances and that leaf blanks
- **realistic-demo.AC5.5 Success:** A removed member's own page reports
  the removal rather than failing to process the commit

### realistic-demo.AC6: Chat, replay, and undecryptable history
- **realistic-demo.AC6.1 Success:** A sent message is encrypted to the
  group and decrypted and displayed by other members
- **realistic-demo.AC6.2 Success:** Returning to a room replays messages
  sent while away, in order
- **realistic-demo.AC6.3 Success:** Entries before the member's join
  cursor render as a single placeholder stating how many there are
- **realistic-demo.AC6.4 Success:** Consecutive undecryptable entries
  after joining collapse into one counted placeholder
- **realistic-demo.AC6.5 Success:** A client's own past entries on replay
  render from locally recorded plaintext, not as decrypt failures
- **realistic-demo.AC6.6 Edge:** A member who joined at epoch zero sees
  no leading placeholder

### realistic-demo.AC7: Persistence is a standing control
- **realistic-demo.AC7.1 Success:** Persist is present before any user
  exists and remains present throughout
- **realistic-demo.AC7.2 Success:** Turning it on writes whatever state
  exists: user, group state if any, room id, cursor, and creator token if
  this client is the creator
- **realistic-demo.AC7.3 Success:** Turning it off deletes that stored
  state
- **realistic-demo.AC7.4 Success:** Reloading with stored state restores
  the group at its current epoch and resumes from the stored cursor
- **realistic-demo.AC7.5 Success:** A waiting joiner, who has a key
  package but no group state, is persisted and returns to the waiting
  state on reload
- **realistic-demo.AC7.6 Success:** Reset deletes only
  `mls-realistic-demo`, leaves the room on the server untouched, and
  leaves the persistence and multi-device demos' records intact

### realistic-demo.AC8: Rooms expire and say so
- **realistic-demo.AC8.1 Success:** Room creation sets an alarm for
  creation time plus three days, and the room reports its expiry time
- **realistic-demo.AC8.2 Success:** The alarm handler deletes all
  storage, deletes the alarm, closes live sockets, and is safe to run
  twice
- **realistic-demo.AC8.3 Success:** A `hello` for a room with no stored
  metadata is answered `no-room`, identically for an expired room and an
  id that never existed
- **realistic-demo.AC8.4 Success:** The gone view says the room does not
  exist or has expired, and offers to create a new one

### realistic-demo.AC9: Ordering integrity
- **realistic-demo.AC9.1 Success:** Entries are stored with monotonic
  `seq`, and a replay for a cursor returns only entries after it
- **realistic-demo.AC9.2 Success:** A second socket for the same identity
  replaces the first
- **realistic-demo.AC9.3 Success:** A live `entry` arriving while a `log`
  batch is still being processed is applied after that batch rather than
  interleaved with it

### realistic-demo.AC10: Cross-cutting behaviors
- **realistic-demo.AC10.1 Logic:** A valid frame of each `ClientMessage`
  and `RoomMessage` type is accepted by its narrowing helper
- **realistic-demo.AC10.2 Logic:** An unknown `type`, a missing required
  field, and a non-object are each rejected
- **realistic-demo.AC10.3 Logic:** The room stores and forwards `payload`
  and `kind` exactly as received and never decodes an MLS payload
- **realistic-demo.AC10.4 Logic:** The cursor never moves backward and
  never skips a gap in `seq`
- **realistic-demo.AC10.5 Logic:** Reconnect backoff grows between
  attempts and is capped
- **realistic-demo.AC10.6 Success:** The page states that creator-only
  removal is a rule this demo enforces in its own interface with nothing
  cryptographic behind it, that a disconnected member's leaf is still in
  the ratchet tree, and what a placeholder means

## Glossary

### MLS protocol terms

- **MLS**: Messaging Layer Security, the end-to-end encryption
  protocol this codebase implements. Group membership and keys are
  tracked cryptographically, independent of any server.
- **Group**: The set of members and cryptographic state MLS
  maintains for a conversation. Each client keeps its own copy,
  derived by applying the same commits in the same order.
- **Epoch**: A version number for the group. Every commit advances
  the epoch by one and rotates key material.
- **Commit**: The message type that changes group membership or
  state (adding, removing, or updating members) and advances the
  epoch.
- **Proposal**: A message type that suggests a change, such as an
  Add or Remove, without yet applying it; a commit bundles pending
  proposals into an epoch change.
- **Welcome**: The message MLS sends a newly added member so they
  can construct group state at the epoch they joined.
- **Ratchet tree**: The MLS data structure that derives each
  member's keys from a binary tree of secrets. This design reads a
  room's membership from a client's own ratchet tree rather than
  trusting the server to report it.
- **Leaf**: A ratchet tree's per-member position; a Remove commit
  blanks a leaf rather than deleting it.
- **Key package**: A member's published public keys and credential,
  consumed once to add that member to a group.
- **Credential**: The identity information (here, a display name)
  bound inside a key package.
- **`GroupActiveState` / `removedFromGroup`**: The status returned
  after processing a message; `removedFromGroup` is the normal
  outcome when a client processes its own Remove commit.
- **Forward secrecy**: MLS's guarantee that past messages stay
  unreadable even after a member's current keys are compromised. It
  is also why an absent member can lose access to older messages
  once retained key material rotates out.
- **Non-extractable (key)**: A Web Crypto key generated so its raw
  bits can never be read out of the browser, only used for signing
  or decryption.
- **Application message**: An `EntryKind` for an ordinary encrypted
  chat message, as opposed to a `commit` or `proposal`.

### Cloudflare platform terms

- **Worker**: Cloudflare's serverless JavaScript/TypeScript runtime.
  This design runs one Worker that serves static assets, upgrades
  WebSocket connections, and hosts the Durable Object class.
- **Durable Object (DO)**: A Cloudflare primitive providing a
  single, stateful, addressable instance -- here, one per room --
  that can hold a SQLite database and receive WebSocket connections
  directly.
- **SQLite storage backend**: The Durable Object storage option
  used here; it is both the only backend the free plan allows and
  the only one new namespaces may pick.
- **WebSocket Hibernation API**: A Durable Object feature
  (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`) that
  lets the object evict from memory while sockets stay open,
  resuming only when a message arrives.
- **Alarm**: A Durable Object's built-in scheduled callback. This
  design uses one to delete an expired room three days after
  creation.
- **`assets.not_found_handling`**: A Worker Assets setting that
  returns `index.html` for any unmatched path instead of a 404 --
  required for a single-page application with client-side routing.
- **`run_worker_first`**: A Worker Assets setting listing path
  patterns that reach the fetch handler before the static asset
  manifest is checked.
- **Custom Domain**: A Cloudflare feature binding every path on a
  hostname to one Worker, which is why this design cannot share a
  domain with the existing GitHub Pages site through Cloudflare.
- **`workers.dev`**: Cloudflare's free subdomain for a deployed
  Worker, used here as the room URL's host during review.
- **Compatibility date**: A Worker config field pinning which
  version of the Workers runtime's APIs and defaults apply.
- **Observability**: A Worker config flag enabling Cloudflare's
  built-in logging and metrics collection.
- **Declarative `exports` field**: The current way a Worker
  registers a Durable Object class in `wrangler.jsonc`, replacing
  the older `migrations` array this design deliberately avoids.
- **Wrangler**: Cloudflare's CLI for local development
  (`wrangler dev`) and deployment (`wrangler deploy`) of Workers.
- **Workers Builds**: Cloudflare's dashboard-configured CI that
  builds and deploys a Worker from a connected git repository.

### This project's vocabulary

- **FDR**: Feature Decision Record, this project's format for
  recording a feature's behavior and the reasoning behind it.
  FDR-002 is the one covering this demo's open design questions.
- **ADR**: Architecture Decision Record. ADR-001 is why signature
  keys are generated non-extractable throughout this codebase.
- **Delivery service**: This design's term for the untrusted relay
  a room plays: it stores and forwards MLS messages without parsing
  them.
- **Identity ledger**: The room's own record of which identities it
  has been told were admitted or removed, fed entirely by the
  creator's client and never independently verified.
- **Standing**: This design's three-way classification of a
  requester against the ledger: `stranger`, `pre-approved`, or
  `previously-removed`.
- **Cursor**: A per-client high-water mark into the room's message
  log, used to resume replay after a reconnect without re-sending
  already-seen entries.
- **Roster**: The room's message reporting which identities
  currently have an open socket, used only for the connected and
  disconnected marks, not for group membership.
- **Placeholder**: What the timeline renders in place of a message
  the client cannot decrypt, either because it predates the
  client's join or because key material has since rotated out.
- **nanoid**: The third-party library generating room ids from a
  fixed alphabet, already a devDependency this design reuses.

## Architecture

### Two deploy targets, each complete on its own

GitHub Pages keeps serving `example/` at base `/webcrypto-mls` through
`npm run build-example` and `.github/workflows/gh-pages.yml`. Neither is
modified. The three existing demos keep their URLs.

Cloudflare serves a separate standalone application from one Worker.
Because two Workers cannot share a hostname -- not on `workers.dev` and
not on a custom domain, where a Custom Domain binds every path to a
single Worker -- one Worker does all three jobs: it serves the page's
static assets, it handles the WebSocket upgrade, and it exports the
Durable Object class. That collapse is what makes the WebSocket
same-origin, which in turn removes the configured endpoint, the CORS
surface, and the build-time origin variable entirely.

The page is therefore at the root of its own hostname, not at
`/realistic-demo` under the existing site. A room URL is
`<worker>.workers.dev/<roomId>`.

### Directory layout

```
example-realistic-demo/
  wrangler.jsonc        assets, DO binding, exports, alarm-free config
  tsconfig.json         @cloudflare/workers-types, worker entry only
  vite.config.js        root ./client, base /, outDir ./dist
  index.ts              fetch handler; exports Room
  protocol.ts           wire contract, imported by both sides
  room-logic.ts         pure decisions: no storage, no globals
  README.md             the dashboard settings that cannot be committed
  client/
    index.ts            mount, read location, choose a view
    state.ts            signals for one user, one room, one connection
    delivery-client.ts  owns the WebSocket; all network I/O
    delivery-cursor.ts  pure: cursor advance rule, backoff schedule
    entry-queue.ts      serial ordering discipline for inbound entries
    mls-actions.ts      create user, create group, add, remove, send
    timeline.ts         pure: messages plus placeholders to ordered items
    views/              setup, waiting, room, gone
  dist/                 build output, already covered by .gitignore

example-shared/
  card-header.ts
  constants.ts
  demo-user.ts          DemoUser, split out of example/demo-state.ts
  how-to-use.ts
  persistence-storage.ts
  storage-panel.ts
  storage-persistence.ts
```

`example/` keeps everything only the Pages site uses: `demo-actions.ts`,
`demo-state.ts`, `nav.ts`, `routing.ts`, `state.ts`, `example-users.ts`,
`participants.ts`, `tree-view.ts`, `tree-diagram.ts`, `message-box.ts`,
`message-view.ts`, `user.ts`, `user-highlight.ts`, `send-plan.ts`,
`devices.ts`, and the `device-*.ts` modules.

The rule for the split is stateable: a module belongs in
`example-shared/` when more than one deployable application imports it.

### Asset and API routing

`assets.not_found_handling` is `single-page-application`, so an unmatched
path such as `/aB3xK9pQ2m` returns 200 with `index.html` rather than a
404. `assets.run_worker_first` is `["/api/*"]`, so only the API path
reaches the fetch handler and everything else is served from the asset
manifest. Static asset requests are not billed, so the free plan's
100,000 requests per day applies to WebSocket and API traffic only.

Room ids come from `nanoid`, which is already a devDependency. Id
validation rejects anything outside the nanoid alphabet and rejects a
reserved prefix, so a room id can never shadow `/api` or `/assets`.

### The delivery service

The fetch handler is deliberately thin:

| route | behavior |
|---|---|
| `GET /api/health` | 200, no Durable Object touched |
| `GET /api/room/:id` | `{createdAt, expiresAt}` or 404 |
| `GET /api/room/:id/ws` | validate id, `idFromName(id)`, forward |

`GET /api/room/:id` exists so the page can distinguish "this room is
gone" from "this room exists, you need a user" before any user exists.
Without it, the page would need an identity-less socket state, because
`hello` carries an identity.

One Durable Object per room, SQLite-backed, which is the only backend
available on the free plan and the only one new namespaces may use. Five
tables:

| table | holds |
|---|---|
| `meta` | `created_at`, `expires_at`, `creator_identity`, `creator_token` |
| `log` | `seq` autoincrement, `sender`, `kind`, `payload` |
| `pending` | one row per requesting identity: key package, requested time |
| `mailbox` | per-recipient Welcome, plus start cursor and prior count |
| `ledger` | identity to `admitted` or `removed` |

Sockets are accepted through the WebSocket Hibernation API
(`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`,
`webSocketError`) so the object sleeps while connections stay open. The
identity is both a hibernation tag, making duplicate-socket replacement a
tag lookup, and a `serializeAttachment` value, so it survives
hibernation. `ctx.setWebSocketAutoResponse` answers keepalive pings
without waking the object.

Liveness is never stored. It is derived from `ctx.getWebSockets()` at
read time, which is correct because it is a transport observation rather
than protocol state.

### Where the roster comes from

The room cannot know the group roster, because it never parses a commit.
It knows admitted-minus-removed. So the page renders its member list
from its own ratchet tree and uses the room's `roster` message only for
the connected and disconnected marks. Protocol state and transport state
come from different sources and are presented as different things. This
is the answer to the concern recorded in FDR-002 decision 8's tradeoff,
that liveness displayed next to protocol state risks reading as though
MLS knew about it.

### Two channels on one socket

FDR-002 decision 6 requires that the delivery service need no MLS
wire-format knowledge, while decision 13 requires it to remember which
identities were admitted and removed. Both hold only because the socket
carries two kinds of traffic. MLS payloads are opaque base64 the room
stores, orders and forwards without decoding. Control messages are a
small vocabulary the room does understand.

The consequence is that the identity ledger is fed entirely by claims the
creator's client makes, and the room can verify none of them. An
`approve` is recorded because the creator token was presented, not
because the room checked that a commit exists. The interface states this
rather than implying an authority that is not there.

### Wire contract

`example-realistic-demo/protocol.ts` imports nothing from the DOM, from
Cloudflare globals, or from `../src/`, so it typechecks in the Worker, in
the browser, and in the Node test bundle.

```ts
export type EntryKind = 'commit' | 'proposal' | 'application'

export interface LogEntry {
    seq:number
    sender:string          // b64url signature public key
    kind:EntryKind         // asserted by sender, unverified
    payload:string         // b64 MLSMessage
}

export type Standing = 'stranger' | 'pre-approved' | 'previously-removed'

export interface PendingRequest {
    identity:string
    keyPackage:string
    requestedAt:number
    standing:Standing
}

export type ErrorReason =
    | 'room-exists'
    | 'not-creator'
    | 'bad-message'

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
```

Identity is the base64url signature public key, not the credential name.
Names never appear on the wire. The creator's client decodes a pending
key package to read its credential when it commits the Add, and every
other name comes from the client's own ratchet tree. The room holds no
display names.

The room stamps the cursor, not the client. `welcome` carries only `to`
and `payload`; the room sets `cursor` to the current high-water `seq` and
`priorCount` to the number of `application` entries at or below it.
Because one socket processes messages in order and the creator sends the
commit before the Welcome, the commit is always already in the log. This
removes a round trip and removes the client's opportunity to compute it
wrong.

### Client state and inbound ordering

State is one client, not a map: `user`, `roomId`, `creatorToken`,
`expiresAt`, `connection`, `cursor`, `live`, `pending`, `messages`,
`persist`, `status`. A computed signal derives the view as `setup`,
`waiting`, `room`, or `gone`. Sequential signal writes go through
`batch`. Routing reads `location.pathname` and listens with
`route-event`, already a devDependency.

Inbound entries must be applied strictly in order, and applying one is
async because it involves crypto. A live `entry` can arrive while a `log`
batch is still being processed. `delivery-client.ts` therefore never
applies anything directly; it appends to a serial queue drained one item
at a time. Without that discipline MLS rejects an out-of-order commit and
the client is stuck.

Failure handling differs by kind, and the difference matters. A `commit`
that fails to process is fatal for the group state: stop draining, report
it, and do not advance the cursor. An `application` entry that fails to
decrypt is expected: count it as undecryptable, advance the cursor, and
keep going. Conflating the two would either wedge the client on an
ordinary forward-secrecy miss or silently skip a commit and corrupt the
epoch.

Being removed is a normal outcome rather than an error. The removal
commit arrives like any other and `processMessage` returns state whose
`GroupActiveState` is `removedFromGroup`. The page reads that and says
so.

### A sender cannot read its own message

An MLS sender cannot decrypt its own application message. Live this never
arises, because the room broadcasts an entry only to clients other than
its sender. On reconnect it does arise, because replay includes the
client's own past entries. Every `LogEntry` carries `sender`, so the
client skips its own on replay and renders from locally recorded
plaintext instead. A client that did not persist has no such record and
those entries become placeholders, which is honest rather than wrong.

### Persistence

A waiting joiner holds a key package and private keys but no group
state, while `PersistedMember` requires `state` and
`restoredUsersFromRecords` reads `state.groupContext.groupId`. The page
also needs `roomId`, `cursor` and `creatorToken`, none of which are
member state.

`persistence-storage.ts` therefore gains `createSessionStore({ dbName })`
beside `createMemberStore({ dbName })`, backed by a second object store
in the same database. `PersistedMember` keeps its exact shape, so the
other two demos are untouched.

```
mls-realistic-demo (v1)
  members   PersistedMember, unchanged shape
  session   { name, keyPackage, privateKeys, roomId, cursor,
              creatorToken }
```

The shared `onupgradeneeded` path creates both object stores. The two
existing databases are already at version 1, so their upgrade handler
never re-runs and they simply never gain a `session` store, which they do
not need.

### Expiry

The alarm is set at creation for `created_at` plus three days. The
handler deletes all storage, calls `deleteAlarm()` explicitly rather than
relying on `deleteAll()` to have done so, and closes live sockets.
Alarms are at-least-once, so the handler is written to be safe to run
twice: deleting an already-empty room is a no-op.

Afterward any `hello` finds no `meta` row and receives `no-room`, which
is the same answer an id that never existed receives. Expired and
never-existed are deliberately one state, because after `deleteAll()`
nothing distinguishes them and inventing a tombstone would only need its
own lifetime.

### Local development

Two processes. `vite` on port 1234 serves `client/` with HMR and proxies
`/api` to `wrangler dev` on 8787 with `ws: true` so the upgrade passes
through. `wrangler dev` runs the Worker and a local Durable Object.

## Existing Patterns

Investigation of the current codebase established the following, and this
design follows all of it.

**Wire encoding is already exercised.** `example/demo-actions.ts` round
trips through `encodeMlsMessage` and `decodeMlsMessage` at lines 190, 262
and 824 rather than passing JavaScript objects between simulated clients.
The new page inherits working serialization instead of introducing it.

**Per-demo database naming already exists.** `createMemberStore({
dbName })` at `example/persistence-storage.ts:192` is already the call
shape, used with `mls-persistence-demo` and `mls-multi-device-demo`. The
new page adds a third name and a session store beside the member store,
rather than a new module.

**Pure logic is separated from I/O and tested in Node.** The example
already splits pure modules (`routing.ts`, `nav.ts`, `participants.ts`,
`send-plan.ts`, `devices.ts`) from components, with matching files under
`test/example/` registered in `test/index.ts`. Tests bundle through
esbuild for Node, so nothing under test may touch the DOM or
`indexedDB`. `room-logic.ts`, `delivery-cursor.ts`, `timeline.ts` and the
`protocol.ts` narrowing helpers exist as separate modules for exactly
this reason.

**Non-extractable signature keys.** The persisting demos generate
signature keypairs non-extractable through Web Crypto, downstream of
ADR-001. `mls-actions.ts` does the same.

**Signals with batched writes.** State is `@preact/signals`, and
sequential writes are wrapped in `batch`. Component-local state uses
`useSignal` rather than `useState`.

**CSS.** `example/style.css` uses nested selectors and variables. The new
client follows the same style and reuses the variables rather than
introducing a second palette.

**Divergence, with reasons.** Two departures are deliberate.
`createDemoState()` is not reused, because it models a map of many
clients and this page holds exactly one; the client gets its own state
module. And `example/routing.ts` and `example/nav.ts` are not extended,
because the page is standalone on its own origin and has no site nav to
join.

**No existing pattern for Cloudflare.** The repository contains no
Worker, no `wrangler` configuration, and no Durable Object today.
Everything in `example-realistic-demo/` outside `client/` is new, and
follows current Cloudflare guidance rather than a local precedent: the
declarative `exports` field rather than the superseded `migrations`
array, the SQLite storage backend, and the WebSocket Hibernation API.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Extract shared example code

**Goal:** Create `example-shared/` so two applications can import the
same modules, with no behavior change to any existing demo.

**Components:**
- `example-shared/` receives `card-header.ts`, `constants.ts`,
  `how-to-use.ts`, `persistence-storage.ts`, `storage-panel.ts`,
  `storage-persistence.ts`
- `example-shared/demo-user.ts` receives the `DemoUser` interface split
  out of `example/demo-state.ts`; `DemoState` and `createDemoState()`
  stay behind
- Import paths updated in `example/index.ts`,
  `example/persistence-demo.ts`, `example/multi-device-demo.ts`,
  `example/tree-diagram.ts`, `example/device-info-panel.ts`,
  `example/device-restore.ts`, `example/device-sync.ts`,
  `example/demo-state.ts`, and the affected files under `test/example/`
- `tsconfig.json` `include` gains `example-shared`;
  `tsconfig.build.json` `exclude` gains it

**Dependencies:** None. This is first so that any later regression in the
existing demos is unambiguously attributable to new code.

**Done when:** `npm test` passes with no test file modified other than
its import lines, `npm run lint` passes, `npm run build-example`
succeeds, and the main, persistence and multi-device demos behave
identically in the browser. No acceptance criteria are claimed; this is a
pure refactor verified by the existing suite.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Worker scaffolding and deploy

**Goal:** A deployable Worker serving static assets and answering a
health check, with every committable setting committed and every
non-committable one written down.

**Components:**
- `example-realistic-demo/index.ts` with a fetch handler and an exported
  `Room` class extending `DurableObject`
- `example-realistic-demo/wrangler.jsonc`: `assets` with
  `not_found_handling: "single-page-application"` and
  `run_worker_first: ["/api/*"]`, a `ROOM` Durable Object binding, the
  declarative `exports` field with `"storage": "sqlite"`, compatibility
  date, `observability`
- `example-realistic-demo/tsconfig.json` scoped to the Worker entry with
  `@cloudflare/workers-types`, keeping `vite/client` out of its way
- `example-realistic-demo/vite.config.js` and a placeholder
  `client/index.ts`, so there is something to serve
- `example-realistic-demo/README.md` recording the Workers Builds root
  directory, build command, deploy command, repo and branch, and stating
  that nothing else needs setting by hand
- `wrangler` added to root `devDependencies`; `build:realistic`,
  `worker:dev` and `worker:deploy` scripts in `package.json`
- `tsconfig.json` `include` and `tsconfig.build.json` `exclude` updated

**Dependencies:** Phase 1.

**Done when:** `npm run build:realistic` succeeds, `wrangler dev` serves
the placeholder page, `GET /api/health` returns 200 without touching a
Durable Object, and the Worker is deployed with `/api/health` answering
on the deployed origin. Operational verification; no acceptance criteria
claimed.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Wire contract and pure room logic

**Goal:** One definition of every message that crosses the socket, and
the room's storage-free decisions, both testable in Node.

**Components:**
- `example-realistic-demo/protocol.ts` with `ClientMessage`,
  `RoomMessage`, `LogEntry`, `PendingRequest`, `EntryKind`, `Standing`,
  `ErrorReason`, and a narrowing helper per direction
- `example-realistic-demo/room-logic.ts` with next-`seq` from a
  high-water mark, replay selection for a cursor, roster assembly from
  members and live identities, and ledger classification
- `test/example-realistic-demo/protocol.ts` and
  `test/example-realistic-demo/room-logic.ts`, registered in
  `test/index.ts`

**Dependencies:** Phase 2.

**Covers:** `realistic-demo.AC10.1`, `realistic-demo.AC10.2`,
`realistic-demo.AC10.3`, `realistic-demo.AC4.5`,
`realistic-demo.AC4.6`, `realistic-demo.AC4.7`

**Done when:** those ACs have passing tests, and `npm run lint` passes.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Room log, replay, and liveness

**Goal:** A room that stores every message in order, replays from any
cursor, and reports who is connected.

**Components:**
- `Room` in `example-realistic-demo/index.ts`: hibernation handlers,
  `meta` and `log` table creation, room creation with creator identity
  and creator token, `create` and `hello` handling, `mls` append and
  broadcast, `log` and `entry` delivery, `roster` broadcast on liveness
  change, duplicate-socket replacement by tag
- `GET /api/room/:id` existence probe and `GET /api/room/:id/ws` with id
  validation and reserved-prefix rejection

**Dependencies:** Phase 3.

**Covers:** `realistic-demo.AC1.3`, `realistic-demo.AC1.4`,
`realistic-demo.AC1.5`, `realistic-demo.AC9.1`, `realistic-demo.AC9.2`

**Done when:** those ACs are verified, two sockets on one room exchange
`mls` entries, a reconnect with a stored cursor replays only what it
missed, and a closed socket flips that identity to not-live in the next
`roster`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Asynchronous join, ledger, and expiry

**Goal:** The room holds both halves of a join across absence, remembers
who it admitted and removed, and deletes itself on schedule.

**Components:**
- `pending`, `mailbox` and `ledger` tables and their handling in `Room`:
  `join-request` storage and replacement, `pending` delivery to the
  creator, `approve` and `deny`, `removed`, `welcome` into the mailbox
  with room-stamped cursor and prior count, `welcome-you` on connect
- Creator-token authorization, so `approve`, `deny`, `removed` and
  `welcome` from a non-creator are answered with `error: 'not-creator'`
- The expiry alarm and an idempotent `alarm()` handler that deletes
  storage, deletes the alarm, and closes sockets

**Dependencies:** Phase 4.

**Covers:** `realistic-demo.AC3.3`, `realistic-demo.AC4.3`,
`realistic-demo.AC4.4`, `realistic-demo.AC4.8`,
`realistic-demo.AC8.1`, `realistic-demo.AC8.2`,
`realistic-demo.AC8.3`

**Done when:** those ACs are verified, a join request survives its
requester disconnecting, a Welcome survives its recipient being offline
when issued, a non-creator's control message is rejected, and a room
whose alarm has fired answers `no-room`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Client shell, user and room creation

**Goal:** A page that creates one user, creates a room, and holds an
ordered connection to it.

**Components:**
- `client/state.ts` signals and the computed view
- `client/delivery-client.ts` owning the socket, plus
  `client/delivery-cursor.ts` for the pure cursor and backoff rules and
  `client/entry-queue.ts` for serial draining
- `client/mls-actions.ts` for key package and non-extractable signature
  keypair generation, group creation, and application message encryption
- `client/views/setup.ts` and the room URL display with a copy control
- `client/index.ts` reading `location.pathname` via `route-event`
- `test/example/delivery-cursor.ts`, registered in `test/index.ts`

**Dependencies:** Phase 5.

**Covers:** `realistic-demo.AC1.1`, `realistic-demo.AC1.2`,
`realistic-demo.AC2.1`, `realistic-demo.AC2.2`,
`realistic-demo.AC2.3`, `realistic-demo.AC2.4`,
`realistic-demo.AC9.3`, `realistic-demo.AC10.4`,
`realistic-demo.AC10.5`

**Done when:** those ACs are verified, an unmatched path returns 200 with
the page, creating a room navigates to `/<id>` and shows a copyable URL,
and the cursor tests pass.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Join, approval, membership, and removal

**Goal:** The full two-party choreography, including both directions of
absence.

**Components:**
- `client/views/waiting.ts` and the join path: probe, create user,
  `hello`, `join-request`, then join from `welcome-you` adopting its
  cursor and prior count
- Pending-request rendering in the creator's view, decoding each key
  package for its credential name and labelling by `standing`
- Approve as `mls{commit}` then `welcome` then `approve`, in that order;
  deny as `deny`; automatic commit for `pre-approved`
- Member list from the client's own ratchet tree with epoch, and
  connected or disconnected marks from `roster`
- Creator-only Remove as `mls{commit}` then `removed`, and the
  `removedFromGroup` view on the removed member's own page
- The creator-only and disconnected-member disclosures

**Dependencies:** Phase 6.

**Covers:** `realistic-demo.AC3.1`, `realistic-demo.AC3.2`,
`realistic-demo.AC3.4`, `realistic-demo.AC4.1`,
`realistic-demo.AC4.2`, `realistic-demo.AC5.1`,
`realistic-demo.AC5.2`, `realistic-demo.AC5.3`,
`realistic-demo.AC5.4`, `realistic-demo.AC5.5`

**Done when:** those ACs are verified with two browser profiles,
including approval while the requester's tab is closed and a request
arriving while the creator is away.
<!-- END_PHASE_7 -->

<!-- START_PHASE_8 -->
### Phase 8: Chat, persistence, gone state, explainer

**Goal:** Messaging with replay and honest placeholders, persistence as a
standing control, and the page saying what it demonstrates.

**Components:**
- `client/views/room.ts` chat pane; `client/timeline.ts` pure folding of
  messages, the leading prior-count placeholder, and consecutive
  undecryptable entries; own-sender skip on replay
- `example-shared/persistence-storage.ts` gains `createSessionStore` and
  a second object store in the shared open path
- Persist toggle in the status area from first render, writing and
  clearing existing state in both directions, plus the origin's storage
  persistence status and request button from
  `example-shared/storage-persistence.ts`
- Reset deleting only `mls-realistic-demo`
- `client/views/gone.ts` for `no-room`, offering a new room
- Intro copy, how-to-use card, expiry rule display, placeholder
  explanation
- `test/example/timeline.ts` and coverage for `createSessionStore`,
  registered in `test/index.ts`

**Dependencies:** Phase 7.

**Covers:** `realistic-demo.AC6.1` through `realistic-demo.AC6.6`,
`realistic-demo.AC7.1` through `realistic-demo.AC7.6`,
`realistic-demo.AC8.4`, `realistic-demo.AC10.6`

**Done when:** those ACs are verified, a member joining after messages
were sent sees a counted placeholder and can read everything after,
turning Persist on mid-session and reloading restores the group at its
current epoch and resumes from the stored cursor, and the persistence and
multi-device demos' records are untouched.
<!-- END_PHASE_8 -->

## Additional Considerations

**Error handling.** A failed `commit` stops the inbound queue and reports
it; a failed `application` decrypt becomes a placeholder and the queue
continues. A send attempted while disconnected reports failure to the
caller rather than being dropped. A restore failure is caught and
reported into the status line rather than escaping module evaluation, as
the other persisting demos already do.

**Free-plan limits.** 100,000 requests and 100,000 SQL row writes per
day, 5 GB stored. Static assets are not billed. Every `mls` entry is one
row write, so a demo session is nowhere near the ceiling, but the limits
are worth recording because exceeding one fails operations of that type
rather than degrading.

**Unconfirmed Cloudflare behavior, deliberately avoided.** Official docs
neither confirm nor deny a WebSocket 101 response through a service
binding, and cross-Worker Durable Object access by `script_name` on the
free plan is not explicitly stated. The single-Worker design depends on
neither.

**Known limitations this design accepts.** The room cannot verify any
control-channel claim, so the identity ledger is only as accurate as the
creator's client. A client that lies about an entry's `kind` corrupts its
peers' placeholder counts and nothing else. A creator who resets, or
stops returning, leaves the room unjoinable until it expires; FDR-002
records that as an open question and this design bounds rather than
solves it. `retainKeysForEpochs` is 4, so a member away across more than
four commits can lose older application messages even though they were a
member at the time, which is why every undecryptable entry becomes a
placeholder rather than only pre-join ones.

**Documents to update alongside this design.** FDR-002 decision 2 states
that the site stays on GitHub Pages and records a tradeoff about a
cross-origin WebSocket and a 404 status from a generated fallback
document. Both are now false and are amended as part of this work.
`tasks/prd-realistic-demo.md` is rewritten to match this design.

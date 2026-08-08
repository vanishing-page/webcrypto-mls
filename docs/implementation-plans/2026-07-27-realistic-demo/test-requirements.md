# Test requirements: realistic-demo

This document maps every acceptance criterion in
`docs/design-plans/2026-07-27-realistic-demo.md` to the tier of
verification it gets and where that verification lives.

## The harness constraint

This repo bundles `test/index.ts` through esbuild to a Node CJS
target and runs it with `@substrate-system/tapzero`. Nothing under
test may touch the DOM, `indexedDB`, `WebSocket`, or `DurableObject`.
That rules out running the real client, the real Worker, or the real
Durable Object inside `npm test`. Only pure logic -- functions that
take plain data in and return plain data out, with no browser or
platform API in between -- can be automated in this repo.

## The three tiers

1. **Automated** -- a Node unit test, part of `npm test`, gates every
   commit and runs in CI.
2. **Probe** -- a scripted check in
   `example-realistic-demo/scripts/probe.mjs`, run by hand against
   `wrangler dev`. It exercises the real Worker and Durable Object
   over HTTP and WebSocket, so it cannot live inside the Node/tapzero
   harness. It is repeatable and mechanical, but nothing runs it
   automatically -- a human invokes it.
3. **Human** -- needs a browser, and for several criteria two browser
   profiles acting as two different participants. Verified by eye
   against the running demo.

## Summary table

| Tier      | Count | Notes                                        |
|-----------|-------|-----------------------------------------------|
| Automated | 16    | 13 fully automated + 3 partially automated    |
| Probe     | 12    |                                                |
| Human     | 23    |                                                |
| **Total** | **51**| matches the 51 `realistic-demo.ACn.m` entries |

Arithmetic note: the tier assignment as handed down groups the counts
as "Automated (13)", "Automated in part only (3)", "Probe (12)", and
"Human (23)". Read literally as 13 + 12 + 23, that is 48, three short
of 51. The three missing criteria are AC5.1, AC5.4, and AC6.5 -- the
partially-automated ones. They belong in the Automated tier (a unit
test covers part of each), so the correct tier total is 13 + 3 = 16
for Automated. 16 + 12 + 23 = 51, which reconciles against the full
set of criteria. This document counts AC5.1, AC5.4, and AC6.5 once
each, inside Automated, and does not list them again under Human even
though a human also observes the half a unit test cannot reach.

## AC1: The Worker serves the page and the API

### realistic-demo.AC1.1
> Success: An unmatched path such as `/aB3xK9pQ2m` returns HTTP 200
> with the page, not 404

- Tier: Human
- Where: Phase 6 human verification, one browser
- Steps: Navigate the browser directly to a room-shaped path that has
  never been created, e.g. `/aB3xK9pQ2m`.
- Pass condition: The page loads (HTTP 200, app shell renders), not a
  404 response.

### realistic-demo.AC1.2
> Success: The page loads from the deployed Worker origin and connects
> to `wss://` on that same origin, with no configured endpoint

- Tier: Human
- Where: Phase 6 human verification, one browser
- Steps: Load the deployed demo and inspect the WebSocket connection
  (devtools Network tab).
- Pass condition: The socket URL uses `wss://` and the same origin as
  the page, with no separately configured API host visible anywhere.

### realistic-demo.AC1.3
> Success: `GET /api/room/:id` for an existing room returns its
> creation and expiry times

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 4 probe
  suite, run against `wrangler dev`
- Check: Create a room, then `GET /api/room/:id` for it.
- Pass condition: Response body includes creation time and expiry
  time for that room id.

### realistic-demo.AC1.4
> Failure: `GET /api/room/:id` for an unknown id returns 404

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 4 probe
  suite, run against `wrangler dev`
- Check: `GET /api/room/:id` for an id that was never created.
- Pass condition: Response status is 404.

### realistic-demo.AC1.5
> Failure: A room id containing characters outside the nanoid
> alphabet, or matching a reserved prefix such as `api` or `assets`,
> is rejected rather than routed

- Tier: Automated
- Where: `test/example-realistic-demo/room-logic.ts`
  (`isValidRoomId`)
- Pass condition: `isValidRoomId` returns false for ids with
  characters outside the nanoid alphabet and for ids matching
  reserved prefixes (`api`, `assets`), and true for a well-formed id.

## AC2: A visitor creates one user and one room

### realistic-demo.AC2.1
> Success: Creating a user generates exactly one key package and one
> non-extractable signature keypair

- Tier: Human
- Where: Phase 6 human verification, one browser
- Steps: Create a user in the running demo; inspect via devtools or
  application state that exactly one key package and one signature
  keypair were generated, and that the signature key is
  non-extractable.
- Pass condition: One key package, one non-extractable signature
  keypair, no duplicates.

### realistic-demo.AC2.2
> Success: Creating a room creates the MLS group with the local user
> as its only member and navigates to `/<roomId>`, with the group id
> generated independently of the room id

- Tier: Human
- Where: Phase 6 human verification, one browser
- Steps: Create a room and observe the resulting group state and URL.
- Pass condition: The group has exactly one member (the creator), the
  browser navigates to `/<roomId>`, and the MLS group id is not
  derived from or equal to the room id.

### realistic-demo.AC2.3
> Success: The full room URL is displayed and can be copied

- Tier: Human
- Where: Phase 6 human verification, one browser
- Steps: After creating a room, locate the displayed URL and use the
  copy control.
- Pass condition: The full room URL is visible on the page and the
  copy action places it on the clipboard.

### realistic-demo.AC2.4
> Failure: `create` sent to a room id that already has metadata is
> answered with `error: 'room-exists'`

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs` (or devtools
  console against `wrangler dev`)
- Check: Send `create` for a room id that already has stored metadata.
- Pass condition: Response is `error: 'room-exists'`.

## AC3: Asking to join works across absence

### realistic-demo.AC3.1
> Success: Opening a room URL without a local user shows the name
> field; creating a user there publishes a `join-request` and shows
> the waiting state

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: In a fresh profile with no local user, open an existing
  room's URL, enter a name, and submit.
- Pass condition: The name field appears before user creation; after
  creating the user, a `join-request` is published and the UI shows a
  waiting state.

### realistic-demo.AC3.2
> Success: A `welcome-you` joins the group from the Welcome and adopts
> its `cursor` and `priorCount`

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: Approve a pending joiner from the creator's profile; observe
  the joiner's profile receive `welcome-you`.
- Pass condition: The joiner's client joins the group from the
  Welcome message and its local cursor and priorCount match the
  values carried on `welcome-you`.

### realistic-demo.AC3.3
> Success: A join request survives its requester closing the tab, and
> is still pending on the creator's next visit

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Send a `join-request`, close that connection, then reconnect
  as the creator and query pending requests.
- Pass condition: The request is still present and pending.

### realistic-demo.AC3.4
> Success: A Welcome issued while its recipient is offline is
> delivered on their next connect

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: With the joiner's profile disconnected (tab closed or
  offline), approve their request from the creator's profile, then
  reconnect the joiner's profile.
- Pass condition: The joiner receives the Welcome and joins on
  reconnect, without needing to re-request.

## AC4: Approval, denial, and the identity ledger

### realistic-demo.AC4.1
> Success: Approving commits an Add and sends `mls{commit}`, then
> `welcome`, then `approve`, in that order, and the newcomer joins

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: Approve a join request from the creator's profile; observe
  the message order sent and the newcomer's resulting membership.
- Pass condition: Messages are sent in the order `mls{commit}`,
  `welcome`, `approve`, and the newcomer ends up a member of the
  group.

### realistic-demo.AC4.2
> Success: A `pre-approved` request is committed with no prompt while
> the creator is connected

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: Mark an identity pre-approved, then have that identity
  request to join while the creator's profile is connected.
- Pass condition: The request is committed automatically with no
  approval prompt shown to the creator.

### realistic-demo.AC4.3
> Success: Denying discards the request and records no admission

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Send a `join-request`, then `deny` it; query membership and
  the ledger.
- Pass condition: The request is gone and no admission record was
  created for that identity.

### realistic-demo.AC4.4
> Success: A repeat request from the same identity replaces the
> stored request rather than creating a second

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Send two `join-request` frames from the same identity before
  either is resolved; query pending requests.
- Pass condition: Exactly one pending request exists for that
  identity, reflecting the most recent one sent.

### realistic-demo.AC4.5
> Logic: An identity in neither set classifies as `stranger`

- Tier: Automated
- Where: `test/example-realistic-demo/room-logic.ts`
- Pass condition: The classification helper returns `stranger` for an
  identity present in neither the admitted set nor the removed set.

### realistic-demo.AC4.6
> Logic: An admitted identity that has not been removed classifies as
> `pre-approved`

- Tier: Automated
- Where: `test/example-realistic-demo/room-logic.ts`
- Pass condition: The classification helper returns `pre-approved`
  for an identity in the admitted set and not in the removed set.

### realistic-demo.AC4.7
> Logic: A removed identity classifies as `previously-removed`,
> including when it appears in both sets

- Tier: Automated
- Where: `test/example-realistic-demo/room-logic.ts`
- Pass condition: The classification helper returns
  `previously-removed` for an identity in the removed set, including
  the case where the same identity is also in the admitted set.

### realistic-demo.AC4.8
> Failure: `approve`, `deny`, `removed` or `welcome` without the
> creator token is answered with `error: 'not-creator'`

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Send each of `approve`, `deny`, `removed`, and `welcome`
  without a valid creator token.
- Pass condition: Each is answered with `error: 'not-creator'`.

## AC5: Membership, liveness, and removal

### realistic-demo.AC5.1
> Success: The member list and epoch are derived from the client's
> own ratchet tree and update on every processed commit, whether it
> arrived live or in a replay batch

- Tier: Automated (partial -- see closing caveats)
- Where: `test/example-realistic-demo/membership.ts`
- Pass condition: The unit test covers deriving the member list from
  a given ratchet tree correctly. Whether that derivation actually
  re-runs on every processed commit, live or replayed, is not
  exercised by this test and is human-observed (Phase 7, two browser
  profiles): a member joining or leaving updates the visible member
  list and epoch for other connected participants, and the same is
  true after a reconnect replays a batch of commits.

### realistic-demo.AC5.2
> Success: A member whose socket has dropped is marked disconnected
> and is not removed from the group

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: Close or kill one profile's connection while the other stays
  open; observe the remaining profile's member list.
- Pass condition: The dropped member shows as disconnected, and
  remains present in the member list and the group.

### realistic-demo.AC5.3
> Success: Only the creator's client renders a Remove control

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: Compare the UI for the creator's profile and a non-creator
  member's profile.
- Pass condition: The Remove control appears only for the creator;
  the non-creator profile has no such control.

### realistic-demo.AC5.4
> Success: Removing commits a Remove and sends `removed`; the epoch
> advances and that leaf blanks

- Tier: Automated (partial -- see closing caveats)
- Where: `test/example-realistic-demo/membership.ts`
- Pass condition: The unit test covers that blanking a leaf does not
  renumber the surviving leaves. That the epoch actually advances
  when a Remove commits is not exercised by this test and is
  human-observed (Phase 7, two browser profiles): after the creator
  removes a member, the epoch shown increases and the removed
  member's leaf is blank rather than reused.

### realistic-demo.AC5.5
> Success: A removed member's own page reports the removal rather
> than failing to process the commit

- Tier: Human
- Where: Phase 7 human verification, two browser profiles
- Steps: Have the creator remove a connected member; observe that
  member's own page.
- Pass condition: The removed member's page shows a removal message,
  not an error or a silent failure to process the commit.

## AC6: Chat, replay, and undecryptable history

### realistic-demo.AC6.1
> Success: A sent message is encrypted to the group and decrypted and
> displayed by other members

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: Send a chat message from one profile; observe the other
  profile.
- Pass condition: The message appears decrypted and displayed on the
  receiving profile.

### realistic-demo.AC6.2
> Success: Returning to a room replays messages sent while away, in
> order

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: Disconnect one profile, send messages from the other, then
  reconnect the first profile.
- Pass condition: The reconnecting profile shows the messages sent
  while it was away, in the order they were sent.

### realistic-demo.AC6.3
> Success: Entries before the member's join cursor render as a single
> placeholder stating how many there are

- Tier: Automated
- Where: `test/example-realistic-demo/timeline.ts`
- Pass condition: Given a set of entries with some before the
  member's join cursor, the timeline builder collapses them into one
  placeholder entry whose count matches the number collapsed.

### realistic-demo.AC6.4
> Success: Consecutive undecryptable entries after joining collapse
> into one counted placeholder

- Tier: Automated
- Where: `test/example-realistic-demo/timeline.ts`
- Pass condition: Given a run of consecutive undecryptable entries
  after the join cursor, the timeline builder collapses them into one
  placeholder entry with the correct count.

### realistic-demo.AC6.5
> Success: A client's own past entries on replay render from locally
> recorded plaintext, not as decrypt failures

- Tier: Automated (partial -- see closing caveats)
- Where: `test/example-realistic-demo/timeline.ts`
- Pass condition: The unit test covers that, given a recorded
  plaintext for an entry, the timeline builder renders that entry
  from the recorded plaintext rather than attempting to decrypt it or
  marking it undecryptable. Whether the plaintext is actually
  recorded at send time is not exercised by this test and is
  human-observed (Phase 8, two browser profiles): a client's own
  messages, after a reload and replay, show their original text
  rather than a decrypt failure placeholder.

### realistic-demo.AC6.6
> Edge: A member who joined at epoch zero sees no leading placeholder

- Tier: Automated
- Where: `test/example-realistic-demo/timeline.ts`
- Pass condition: Given a join cursor at epoch zero with no entries
  before it, the timeline builder produces no leading placeholder
  entry.

## AC7: Persistence is a standing control

### realistic-demo.AC7.1
> Success: Persist is present before any user exists and remains
> present throughout

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: Load the app before creating a user; observe the persist
  control. Continue through user and room creation.
- Pass condition: The persist control is visible before any user
  exists, and stays visible at every later stage.

### realistic-demo.AC7.2
> Success: Turning it on writes whatever state exists: user, group
> state if any, room id, cursor, and creator token if this client is
> the creator

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: Reach a state with a user, a group, a room id, a cursor, and
  (for the creator profile) a creator token; enable persist; inspect
  storage.
- Pass condition: All of user, group state, room id, cursor, and (for
  the creator) creator token are written to storage.

### realistic-demo.AC7.3
> Success: Turning it off deletes that stored state

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: With persist on and state stored, turn persist off; inspect
  storage.
- Pass condition: The previously stored state is deleted.

### realistic-demo.AC7.4
> Success: Reloading with stored state restores the group at its
> current epoch and resumes from the stored cursor

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: With persist on and a group in progress, reload the page.
- Pass condition: The group is restored at its current epoch and
  replay resumes from the stored cursor rather than from the start.

### realistic-demo.AC7.5
> Success: A waiting joiner, who has a key package but no group
> state, is persisted and returns to the waiting state on reload

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: As a joiner with a pending request and persist on, reload
  before approval.
- Pass condition: On reload, the waiting state is restored rather
  than losing the pending request.

### realistic-demo.AC7.6
> Success: Reset deletes only `mls-realistic-demo`, leaves the room on
> the server untouched, and leaves the persistence and multi-device
> demos' records intact

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: With persisted state present alongside the persistence and
  multi-device demos' own storage, trigger reset; inspect storage and
  the server-side room.
- Pass condition: Only the `mls-realistic-demo` storage key is
  removed; the room still exists on the server; the persistence and
  multi-device demos' records are untouched.

## AC8: Rooms expire and say so

### realistic-demo.AC8.1
> Success: Room creation sets an alarm for creation time plus three
> days, and the room reports its expiry time

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Create a room; query its reported expiry time and (where
  observable) the scheduled alarm.
- Pass condition: Expiry time equals creation time plus three days,
  and the room's API response reports it.

### realistic-demo.AC8.2
> Success: The alarm handler deletes all storage, deletes the alarm,
> closes live sockets, and is safe to run twice

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Trigger the alarm handler directly (or via a shortened
  expiry in dev) and observe storage, the alarm, and any open
  sockets; trigger it a second time.
- Pass condition: All storage is deleted, the alarm is cleared, live
  sockets are closed, and the second invocation does not error or
  change behavior.

### realistic-demo.AC8.3
> Success: A `hello` for a room with no stored metadata is answered
> `no-room`, identically for an expired room and an id that never
> existed

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 5 probe
  suite
- Check: Send `hello` for an id that never existed, and separately
  for a room that has expired.
- Pass condition: Both are answered `no-room`, with no observable
  difference between the two cases.

### realistic-demo.AC8.4
> Success: The gone view says the room does not exist or has expired,
> and offers to create a new one

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: Navigate to a room id that never existed, and separately to
  one that has expired.
- Pass condition: In both cases the gone view states the room does
  not exist or has expired, and offers a path to create a new room.

## AC9: Ordering integrity

### realistic-demo.AC9.1
> Success: Entries are stored with monotonic `seq`, and a replay for a
> cursor returns only entries after it

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 4 probe
  suite
- Check: Store several entries and inspect their `seq` values; replay
  from a given cursor.
- Pass condition: `seq` values are monotonically increasing, and a
  replay for a given cursor returns only entries with `seq` after
  that cursor.

### realistic-demo.AC9.2
> Success: A second socket for the same identity replaces the first

- Tier: Probe
- Where: `example-realistic-demo/scripts/probe.mjs`, Phase 4 probe
  suite
- Check: Open two sockets for the same identity against `wrangler
  dev`.
- Pass condition: The first socket is closed or superseded, and only
  the second remains live for that identity.

### realistic-demo.AC9.3
> Success: A live `entry` arriving while a `log` batch is still being
> processed is applied after that batch rather than interleaved with
> it

- Tier: Automated
- Where: `test/example-realistic-demo/entry-queue.ts`
- Pass condition: Given a `log` batch that is still being processed
  when a live `entry` arrives, the queue applies the entry only after
  the batch finishes, never interleaved into it.

## AC10: Cross-cutting behaviors

### realistic-demo.AC10.1
> Logic: A valid frame of each `ClientMessage` and `RoomMessage` type
> is accepted by its narrowing helper

- Tier: Automated
- Where: `test/example-realistic-demo/protocol.ts`
- Pass condition: For every `ClientMessage` and `RoomMessage` variant,
  a well-formed example of that type passes its narrowing helper.

### realistic-demo.AC10.2
> Logic: An unknown `type`, a missing required field, and a
> non-object are each rejected

- Tier: Automated
- Where: `test/example-realistic-demo/protocol.ts`
- Pass condition: The narrowing helper rejects a frame with an
  unrecognized `type`, a frame missing a required field, and a
  non-object value, in each case.

### realistic-demo.AC10.3
> Logic: The room stores and forwards `payload` and `kind` exactly as
> received and never decodes an MLS payload

- Tier: Automated
- Where: `test/example-realistic-demo/room-logic.ts`
  (`entryFromMls` passes `kind` and `payload` through unaltered)
- Pass condition: `entryFromMls` produces an entry whose `kind` and
  `payload` are byte-for-byte identical to the input, with no
  decoding of the MLS payload performed.

### realistic-demo.AC10.4
> Logic: The cursor never moves backward and never skips a gap in
> `seq`

- Tier: Automated
- Where: `test/example-realistic-demo/delivery-cursor.ts`
- Pass condition: The cursor helper refuses to move to a smaller
  value than its current one, and refuses to advance past a gap in
  `seq`.

### realistic-demo.AC10.5
> Logic: Reconnect backoff grows between attempts and is capped

- Tier: Automated
- Where: `test/example-realistic-demo/delivery-cursor.ts`
- Pass condition: Successive backoff values strictly increase up to
  some maximum, and never exceed that cap on further attempts.

### realistic-demo.AC10.6
> Success: The page states that creator-only removal is a rule this
> demo enforces in its own interface with nothing cryptographic
> behind it, that a disconnected member's leaf is still in the
> ratchet tree, and what a placeholder means

- Tier: Human
- Where: Phase 8 human verification, two browser profiles
- Steps: Locate and read the explainer text in the running demo.
- Pass condition: The explainer states, in plain terms, that
  creator-only removal is enforced by this demo's interface and not
  by cryptography, that a disconnected member's leaf remains in the
  ratchet tree, and what a timeline placeholder represents.

## Read this before trusting the coverage numbers

Three criteria are only partly covered by an automated test, and the
unit test alone does not prove the criterion:

- **AC5.1** -- `test/example-realistic-demo/membership.ts` proves the
  member-list derivation rule (member list and epoch come from the
  ratchet tree) given a tree. It does not prove that this derivation
  actually re-runs on every processed commit, live or replayed. That
  wiring is human-observed in Phase 7.
- **AC5.4** -- the same file proves that a blanked leaf does not
  renumber survivors. It does not prove that the epoch actually
  advances when a Remove commits. That wiring is human-observed in
  Phase 7.
- **AC6.5** -- `test/example-realistic-demo/timeline.ts` proves that,
  given a recorded plaintext, the timeline renders it instead of
  attempting decryption. It does not prove that the plaintext is
  actually recorded at send time. That wiring is human-observed in
  Phase 8.

In each case, a passing unit test proves the rule, not the wiring. A
regression that broke the wiring -- for example, a code path that
stopped re-deriving membership on a replayed commit, or stopped
recording plaintext at send time -- would leave the corresponding
unit test green. Only the human verification step would catch it.

The Probe tier does not run in `npm test` and is not part of CI. It
requires a human to start `wrangler dev` and run
`example-realistic-demo/scripts/probe.mjs` by hand. Nothing in the
Probe tier gates a commit; treat it as a checklist to run before a
release or a significant change to the Worker or Durable Object, not
as a safety net that catches regressions automatically.

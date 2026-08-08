# Human test plan: realistic demo

A person with two browser profiles and about forty minutes can follow
this from top to bottom. It covers what no standing check reaches, and
it deliberately does not repeat what the Node suite, the probe and the
four Playwright harnesses already cover.

Sources, both under
`docs/implementation-plans/2026-07-27-realistic-demo/`:
`test-requirements.md` for the criteria and their tiers, and
`ac-coverage.md` for what each criterion is actually checked by today.

Every step below states what to do and what you should see. If what you
see differs, the step failed; write down what you saw rather than
retrying until it passes.

## What is already automated, and how that was confirmed

`ac-coverage.md` maps all 51 `realistic-demo.AC*` criteria to evidence.
Before writing this plan, every one of its evidence claims was checked
against the tree rather than taken on trust: each quoted Node test title
was matched in `test/example-realistic-demo/`, each quoted browser check
title in `example-realistic-demo/scripts/verify-phase*.mjs`, and each
probe number against the 23 numbered checks in
`example-realistic-demo/scripts/probe.mjs`. All of them resolved.

Three criteria have no standing automated check, and each is a step in
this plan rather than a gap to close in code:

1. **AC8.2, the alarm handler.** Neither harness can make a Durable
   Object alarm fire. Part 3 below.
2. **AC1.2, the deployed half.** The socket origin rule is covered in
   Node in both polarities, but nothing verifies the deployed Worker,
   because deploying is the repository owner's call. Part 5 below.
3. **AC6.5, across a reload.** Own messages render from recorded
   plaintext while the page is up, which Node covers. The stored session
   holds no plaintexts by design, so after a reload a client's own past
   entries come back as placeholders. Step 2.7 below states that as the
   expected result, because it is one.

Two more things a harness can approximate but not prove, and which this
plan therefore covers by eye: a real operating-system clipboard paste
(AC2.3), and the wording of the page's disclosures (AC10.6), which no
test asserts because tests here do not assert on HTML text.

## Run the standing checks first

There is no point testing by hand against a tree that fails its own
tests. Run these in order and record the numbers.

**Three of these six do not come back clean, and never have.** The gate
is "no new failures", not "no failures". Each expectation below names
what is already red, so a tester can tell an old failure from one they
just caused. Do not treat a named failure as a reason to stop.

1. `npm test`
   Expected: **exit code 1**, and exactly two failures, both of them
   these:
   - `not ok ... should render one heading`, from
     `test/example/how-to-use.ts:40`
   - `not ok ... the explanation stands beside the timeline, always`,
     the `placeholder-disclosure` assertion, which asserts an element
     `room.ts` stopped rendering in commit `e222c20`

   Measured on the `room-you-section` branch: 47708 tests, 47706
   passing. The count grows as tests are added, so read the failure
   names rather than the total. A third failure is yours. Takes over ten
   minutes.
2. `npm run lint`
   Expected: exit code 0 **on a tree that has never been built**. Once
   `npm run build:realistic` has run -- which standing check 5 below
   makes it do -- this reports about 62000 problems, every one of them
   in generated bundles under `example-realistic-demo/public/assets/`.
   `eslint.config.js` ignores `public/*`, which matches a top-level
   `public/` and not that nested one.

   That is a pre-existing gap in the ignore list, not a defect in any
   branch. So either run this before your first build, or scope it:

   ```sh
   npx eslint "./**/*.{ts,js}" \
       --ignore-pattern "example-realistic-demo/public/**"
   ```
   Expected either way: exit code 0. Check the exit code directly, not
   through a pipe.
3. `npx tsc --noEmit -p tsconfig.json`
   Expected: the one known pre-existing error in
   `test/test-vectors/key-schedule.ts(73,9)` and nothing else.
4. `npx tsc -p example-realistic-demo/tsconfig.json --noEmit`
   Expected: no output at all.
5. `npm run build:realistic` then `npm run worker:realistic`, and in another
   shell `node example-realistic-demo/scripts/probe.mjs`
   Expected: 23 of 23 checks pass, exit 0.
6. With the Worker still up, `npm run dev:realistic` in a third shell,
   then each of the four harnesses in `example-realistic-demo/scripts/`.
   These drive real Chromium profiles, so give them a few minutes each.

   Two of the four are already red. Expected, per harness:

   | Harness | Expected | Exit |
   |---|---|---|
   | `verify-phase8-chat.mjs` | 13 passed, 0 failed | 0 |
   | `verify-phase8-e2e.mjs` | 7 passed, 0 failed | 0 |
   | `verify-phase7.mjs` | 19 passed, **3 failed** | 1 |
   | `verify-phase8-gone.mjs` | 7 passed, **3 failed** | 1 |

   `verify-phase7.mjs`'s three are: `both disclosures render beside what
   they describe` (it asserts `p.presence-disclosure` renders in a room
   where nobody is away, but that paragraph is guarded by `anyAway`), `a
   pre-approved request is committed with no prompt` (a `p.status`
   timeout), and `no page logged an uncaught error` (a WebSocket
   `ERR_INTERNET_DISCONNECTED`).

   `verify-phase8-gone.mjs`'s three are all the explainer: `the
   explainer stands beside the setup form` and `the explainer is on the
   room view too` both report `expected one .intro`, and `the explainer
   separates guarantee from trust` times out.

   All six of those failures were measured twice: on the
   `room-you-section` branch, and again at `43b23f2`, the commit before
   it, in a separate worktree running its own server. Same failures,
   same messages, same totals, so none of them belongs to that branch.
   They are the standing baseline until somebody fixes them.

If a check fails in a way not named above, stop and fix that before
continuing; a new failure invalidates everything below. A failure that
matches the baseline is not a reason to stop.

## Setting up for the manual run

The manual run uses the Worker origin, not the Vite dev server, so the
page and the socket share one origin and the SPA fallback under test is
the Worker's own.

1. `npm run build:realistic`
   Expected: writes `example-realistic-demo/dist`, exits 0.
2. `npm run worker:realistic`
   Expected: wrangler listening on `http://localhost:8787`.
3. Open two browser profiles that share no storage. Two separate Chrome
   or Chromium profiles work, and so does one normal window plus one
   window of a different browser. A second tab of the same profile does
   **not**: it shares the indexedDB database, so it is the same client.
   Call them A and B. A is the creator throughout.
   Expected: each profile, at `http://localhost:8787/`, shows the setup
   view with a name field and, beside it, the "Keeping this session"
   panel.

When you are done, stop the dev servers. Kill only this repository's
processes, by path:
`pkill -f "/Users/nick/code/webcrypto-mls/node_modules/@cloudflare/workerd"`
and the same for `.../node_modules/wrangler`, then confirm with
`pgrep -fl "/Users/nick/code/webcrypto-mls"`. Never run a bare
`pkill -f wrangler`; this machine runs other repositories' dev servers.

## Part 1: the two-profile join, by hand

Covers AC1.1, AC2.1, AC2.2, AC2.3, AC3.1, AC3.2, AC3.4, AC4.1, AC4.2,
AC5.1, AC5.2, AC5.3, AC5.4, AC5.5, AC6.1 and AC6.2.

### 1.1 An unshared path is served the page

In profile A, navigate to `http://localhost:8787/aB3xK9pQ2m`, an id no
room was ever created for.

Expected: the page renders, and the network panel shows 200 for the
document. Not a 404 page, and not the Worker's JSON. The view says the
room does not exist or has expired and offers to start a new one.

### 1.2 A creates a user and a room

In profile A, from `http://localhost:8787/`, enter a name and submit
"Start a room".

Expected: the URL becomes `/<roomId>` with a ten-character id
(`ROOM_ID_LENGTH`). The
room view shows epoch 0, one member (A) marked Connected, an empty
message list, and the room's full absolute URL. In devtools, under
Application, the "Keeping this session" panel is present and the persist
checkbox is off; no `mls-realistic-demo` database exists yet.

### 1.3 The signature key is not extractable, and there is one of each

Still in A, open the devtools console and inspect the client's user
state: `keyPackage` and `privateKeys`, whose
`privateKeys.signaturePrivateKey` is the Ed25519 private key.

Expected: exactly one key package and one keypair, and that private key
is a `CryptoKey` with `extractable: false`. An attempt to export it with
`crypto.subtle.exportKey` rejects. `generateKey` is called with `false`
for extractability, which is ADR-001 in one argument, so this step is
checking that the running page matches the decision.

### 1.4 The group id is not the room id

Still in A, read the group's `groupContext.groupId` and compare it with
the room id in the URL.

Expected: the group id is 32 random bytes and bears no relation to the
room id. They are independent identifiers, which is the point.

### 1.5 The room URL copies to the real clipboard

In A, use the copy control beside the room URL. Then focus the browser's
address bar in a new tab and paste with the operating system shortcut.

Expected: the pasted text is the full absolute room URL, scheme and host
included. This is the step the Playwright harnesses cannot make: they
record the `writeText` argument, which is not the same fact as the
system clipboard holding it.

### 1.6 B opens the link with no local user

Copy the room URL into profile B.

Expected: B shows a name field, labelled for joining rather than for
creating ("Join this room"), and no room view. B has no user yet, so it
cannot have a place in the group.

### 1.7 B asks to join, and waits

In B, enter a different name and submit.

Expected: B moves to a waiting state naming the room it is waiting on
and the name it gave. In A, a request from B appears under "Asking to
join", marked as an identity nobody has let in before, with Approve and
Deny controls. B's waiting view says the key that opens the invitation
is held by this tab, and that closing it throws that key away.

### 1.8 A approves, and B joins

In A, approve B's request.

Expected: A's epoch advances to 1 and both A and B appear under "In this
group", each marked Connected. B leaves the waiting state and shows the
room at epoch 1 with the same two members. Both pages agree on the
member list and the epoch. If B joined after any messages had been sent,
B shows a single leading placeholder counting them rather than a run of
failures.

### 1.9 A message each way

Send a message from A, then one from B.

Expected: each message appears on both pages, as text, in the order
sent. In the network panel's WebSocket frames, no frame contains either
message's plaintext: the payload is ciphertext, and the room forwards it
without decoding it.

### 1.10 A dropped socket is Away, not removed

Close B's tab, or take B's profile offline in devtools' network
conditions and then close its room socket.

Expected: A still lists B under "In this group", now marked Away rather
than Connected. The epoch does not change, and B's leaf is still in the
tree. A member being unreachable is not a member leaving.

### 1.11 A Welcome issued during absence is delivered on connect

This one needs a third participant, because B is already in. In a third
profile C (or in B after deleting its stored data), open the room URL,
ask to join, then close C entirely. Approve C's request from A. Then
reopen the room URL in C.

Expected: while C is away, A shows the request as pending and then
resolves it. C, on returning, is a new client with a new identity, so it
asks to join again -- that is the honest result with persistence off,
and it is the reason step 2.5 repeats this with persistence on, where a
returning client is the same client. What the probe already proves, and
what you should confirm on A, is that approving an absent requester does
not error and does not lose the room: A stays at its new epoch with C
listed once, not twice.

### 1.12 Only the creator is offered Remove

Compare A's member list with B's, with B reconnected and both at the
same epoch.

Expected: A shows a Remove control against B and none against itself. B
shows no Remove control against anybody, including A. Below the list,
both pages say that creator-only removal is a rule this demo enforces in
its own interface, with nothing cryptographic behind it.

### 1.13 A removes B

With both pages open, remove B from A.

Expected: A's epoch advances by one and B disappears from A's member
list, with A's own leaf index unchanged. B's own page says plainly that
this client was removed, as a normal ending rather than an error, and
does not report a failed commit. B's message box is gone or inert.

### 1.14 A returning client replays what it missed, in order

Reconnect a member (bring B back in with a fresh request and approval,
or use a third profile), send several messages from A while that member
is briefly offline, then bring it back.

Expected: on reconnect the returning page shows the messages sent while
it was away, in the order they were sent, and then continues to receive
new ones live. Nothing appears twice and nothing is skipped.

### 1.15 The key under "You" copies to the real clipboard

In profile A or B with both clients connected and in the room, find the
"You" block in the left column. Use the copy control beside the key shown
there. Then focus the browser's address bar in a new tab and paste with
the operating system shortcut.

Expected: the pasted text is the full base64url-encoded key, without
spaces or line breaks. This is the step the Playwright harnesses cannot
make: they record the `writeText` argument, which is not the same fact as
the system clipboard holding it.

### 1.16 A refused copy says so, and takes the confirmation back

This is the only check on the failure half of AC3.3, and it needs a
refusal that a harness cannot stage. Copy the key once so the
confirmation appears, and leave it on screen. Then make the next copy
fail and press the control again. Either of these provokes a refusal in
a current browser:

- Open devtools, click into it so the document loses focus, and trigger
  the copy from there. `navigator.clipboard.writeText` rejects with
  `NotAllowedError: Document is not focused`.
- Or deny the site's clipboard permission in the browser's site
  settings, then reload and copy.

Expected: the status line says the copy failed, naming the key, AND the
"Copied" confirmation beside the control goes away. Both halves matter.
A page that reports the failure while still showing "Copied" is saying
two contradictory things at once, which is the defect this step exists
to catch.

Do the same against the room URL's copy control. The two controls share
this behaviour and neither is covered by a test that can fail.

## Part 2: the persistence toggle

Covers AC7.1 through AC7.6, and AC6.5's reload half. Use a profile whose
storage you are willing to lose.

### 2.1 The control exists before there is anything to store

Open a fresh profile at `http://localhost:8787/` with no user created.

Expected: the "Keeping this session" panel is on the page already, with
its checkbox off, its disclosure naming the `mls-realistic-demo`
database and what goes into it, a storage-persistence panel, and a
"Delete stored data" button. It stays present through user creation,
room creation and the room view; check it at each stage.

### 2.2 Turning it on writes what exists

Create a user and a room in this profile, so there is a user, a group, a
room id, a cursor and a creator token. Then tick the checkbox and look
at indexedDB in devtools.

Expected: a database called `mls-realistic-demo` appears, holding one
session record with the display name, the key package, the private keys,
the room id, the cursor, the group state and the creator token. No
message plaintexts, which the panel says outright.

### 2.3 A reload comes back as the same client

With the checkbox on and a group in progress, reload the page.

Expected: the page comes back into the room at the epoch it left, as the
same member with the same identity, and resumes the log from the stored
cursor rather than from the beginning. It does not ask for a name and it
does not ask to join.

### 2.4 Chat still works after the reload

Send a message after the reload, from this profile and to it.

Expected: both directions work. A restored group is a working group, not
a read-only view of one.

### 2.5 A waiting joiner is persisted and returns to waiting

In a fresh profile, open the room URL, tick the persist checkbox, ask to
join, and reload before the creator approves.

Expected: the page comes back to the waiting state with the same name
and the same pending request, and the creator's page still shows exactly
one request from that identity. Approving it now still works, because
the key that opens the Welcome survived the reload -- which is the thing
Part 1 step 1.11 could not do.

### 2.6 Turning it off deletes what was stored

Untick the checkbox and look at indexedDB again.

Expected: the stored session is gone. The page keeps working in memory,
and a reload from here starts over as a new client.

### 2.7 Own messages after a reload are placeholders, and that is a pass

Turn persistence back on, send two messages from this profile, then
reload.

Expected: the timeline comes back without those two messages as text.
They appear as a counted placeholder, or not at all if they fall before
the restored cursor. This is by design: MLS cannot decrypt a message the
client produced itself, the only source is the local plaintext record,
and the stored session deliberately keeps no plaintexts. The panel says
so ("Remembering the session is not a transcript"). Record it as a pass;
if the messages *did* come back as text, something is now storing
plaintexts, and that is the failure.

### 2.8 Delete takes only this demo

Visit the persistence demo and the multi-device demo on the same origin
far enough to create their databases, `mls-persistence-demo` and
`mls-multi-device-demo`. Return to the realistic demo with a stored
session in place and press "Delete stored data".

Expected: `mls-realistic-demo` is gone, the other two databases are
untouched, and the persist checkbox is now off. Reload the room URL in
another profile that is still a member: the room is still there on the
server with its history, because deleting local storage is not deleting
a room.

## Part 3: expiry and the alarm handler

Covers AC8.1, AC8.2, AC8.3 and AC8.4. AC8.2 is the criterion with no
standing check at all, so this part matters most.

A three-day wait is not a test. Both halves of this part need two
temporary edits to `example-realistic-demo/index.ts`, and the last step
is removing them again.

### 3.1 The alarm is set three days out

With a room freshly created, `GET http://localhost:8787/api/room/<id>`.

Expected: 200 with a creation time and an expiry time, and the expiry is
exactly the creation time plus three days
(`ROOM_LIFETIME_MS`, 259200000 ms).

### 3.2 Add the temporary harness

Two edits, both marked so they cannot be forgotten:

1. Change `ROOM_LIFETIME_MS` to `5000` and put `// TEMPORARY` on the
   line above it.
2. Add a `debugAlarm()` method on `Room` that calls `this.alarm()`, and
   a route `/api/debug-alarm/:id` that invokes it, both marked
   `// TEMPORARY`.

Expected: `npm run worker:realistic` reloads cleanly, and a room created now
reports an expiry five seconds after its creation.

### 3.3 The handler closes sockets, empties storage, and clears the alarm

Create a room, join it with a live socket from a browser profile, wait
past the five seconds, and then hit `/api/debug-alarm/<id>` if the alarm
has not already fired.

Expected, in this order: the live socket is closed by the server, with
the page reporting the connection as closed rather than hanging;
`GET /api/room/<id>` then answers 404; a fresh `hello` on a new socket
for that id answers `no-room`; and the room's storage is empty, with no
alarm scheduled.

### 3.4 Running it twice is safe

Hit `/api/debug-alarm/<id>` twice more against the now-empty room.

Expected: neither call throws, neither returns a 500, and neither
resurrects the room. `GET /api/room/<id>` still answers 404 and a
`hello` still answers `no-room`. The handler recreates the empty schema
each time, which is what keeps `readMeta()` from throwing
`no such table: meta` instead of returning null.

### 3.5 An expired room and one that never existed are indistinguishable

Send `hello` for the expired id, and `hello` for an id that was never
created.

Expected: both answer `no-room`, with no difference in the reply. A
client cannot tell "expired" from "never existed", which is deliberate:
the room does not leak that an id was once real.

### 3.6 The gone view says both cases

In a browser, open the expired room's URL, and separately an id that
never existed.

Expected: both render the same view, which states that the room does not
exist or has expired -- both possibilities, since the page has no way to
tell them apart -- and offers a control to start a new room. Taking that
control creates a room and navigates to it.

### 3.7 Remove the temporary harness

Restore `ROOM_LIFETIME_MS` to `3 * 24 * 60 * 60 * 1000` and delete the
`debugAlarm()` method and its route.

Expected: `grep -n "TEMPORARY\|debugAlarm" example-realistic-demo/index.ts`
prints nothing, `git diff example-realistic-demo/index.ts` is empty, the
Worker typecheck is clean and the probe still passes 23 of 23. Do not
commit with the harness in place.

## Part 4: read the words on the page

Covers AC10.6 and the split disclosures AC4.1 and AC4.2. No test asserts
this, because the house rule forbids testing HTML text, so the only check
is a person reading it and asking which line of code makes each sentence
true.

1. In the room view, find the "You" block in the left column. Read the
   disclosure below the key, which states a claim about name privacy.
   Expected: the disclosure says that a member's name is not hidden from
   the server, without making any claim about what else the server sees.
   This is the AC4.2 disclosure, split from the routing claim so a reader
   can understand the naming choice independently.

2. Read the disclosure that heads the list of keys under "Connected
   now". It should now make only the routing claim.
   Expected: the page says the keys are signature public keys, base64url
   encoded, and that the key is what the room routes on rather than a
   display name. It should NOT go on to say anything about whether a
   name is hidden from the server -- that half now lives in the "You"
   block, and the two paragraphs should not repeat each other. This is
   the AC4.1 disclosure.

3. In the room view, find the three remaining disclosures and read them.
   Expected: the page says that creator-only removal is enforced by this
   demo's interface with nothing cryptographic behind it; that a
   disconnected member's leaf is still in the ratchet tree, so Away is
   not gone; and what a timeline placeholder stands for. These are the
   AC10.6 disclosures, which explain other interface choices.

4. Read the persistence panel's three paragraphs.
   Expected: they name the database, name the private keys and the
   creator token as things written to this device, say that anything with
   access to this browser's storage can act as the room's creator, say
   that nothing is sent anywhere, and say that messages are not stored.

5. Read the waiting view.
   Expected: it says the key that opens the invitation is held by this
   tab when persistence is off, and does not promise that the invitation
   can be picked up later from somewhere else.

6. For each sentence in 1 to 5, name the code that makes it true.
   Expected: you can. A sentence you cannot trace is either stale copy
   or an undocumented behaviour, and both are defects of the same kind
   as a wrong epoch.

## Part 5: the deployed origin

Covers AC1.2's deployed half. **Do not run this without the repository
owner's explicit approval**: it deploys the Worker.

1. With approval, `npm run deploy:realistic`.
   Expected: the build succeeds and wrangler reports the deployed URL.
2. Load that URL and create a room.
   Expected: the page loads over `https://`, and the room socket in the
   network panel is `wss://` on that same host.
3. Search the built bundle and the page for any configured API host.
   Expected: none. The socket URL is derived from `location`, so the demo
   works on whatever origin serves it, with nothing to configure.

## Result sheet

Fill this in per run. A blank cell is not a pass.

| Part | What it covers | Result |
| --- | --- | --- |
| Standing checks 1 to 6 | everything already automated | |
| 1.1 to 1.5 | AC1.1, AC2.1 to AC2.3 | |
| 1.6 to 1.9 | AC3.1, AC3.2, AC4.1, AC6.1 | |
| 1.10 to 1.14 | AC5.1 to AC5.5, AC6.2, AC3.4 | |
| 1.15 | room-you-section.AC3.1 and AC3.2, the real clipboard | |
| 1.16 | room-you-section.AC3.3, the refusal -- the only check on it | |
| 2.1 to 2.6 | AC7.1 to AC7.5 | |
| 2.7 | AC6.5 across a reload | |
| 2.8 | AC7.6 | |
| 3.1 to 3.6 | AC8.1 to AC8.4 | |
| 3.7 | the harness is out of the tree again | |
| Part 4 | AC10.6 and the copy on the page | |
| Part 5 | AC1.2 deployed, owner-approved only | |

## Things that look like failures and are not

- Chromium logs every 404 response to the console, so the gone-view
  steps put a red line in the console. That is the page doing its job.
- Nothing in this demo persists unless the checkbox is on, so closing a
  tab in Part 1 makes a *new* client rather than the same one returning.
  Part 2 is where a closed tab comes back as itself.
- `setOffline` alone does not close an already-open WebSocket. If a step
  asks you to drop a connection, close the socket as well, or the page
  will keep reporting the connection as open with no traffic on it.
- A reconnect waits before it retries, and the wait grows: roughly 1, 2,
  4, 8, 16 then 30 seconds, capped there. A page that seems slow to come
  back after several drops is following the backoff, not stuck.

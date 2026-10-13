# Audit 2026-10: staging fixes

**Status:** ready-for-agent
**Source:** `AUDIT-2026-10-11.md` (F1-F7, the `no-labels` lint failure,
and the dependency audit observation under "Validation results")

This spec covers four areas, each tested at its own seam: the
realistic demo (F1, F3), the core library (F2), attachments (F4, F7,
lint), and packaging (F5, F6, dependency audit). Every section below
is split the same way.

## Problem Statement

### Realistic demo

A creator who approves two join requests in quick succession can split
the room permanently. It does not take an attacker: walking a
pre-approved pending list does it, and so does clicking Approve twice.

The room refuses an `mls` write that arrives inside
`MLS_WRITE_INTERVAL_MS` of the socket's last accepted one, before the
write is given a seq. The client never learns that. It treats "the
frame left the socket" as "the room accepted the commit", so after the
second Add is refused it still sends that joiner's Welcome and the
`approve`, and it moves its own `group` to the new epoch. The creator
and the second joiner are now at epoch 2, and the first joiner is at
epoch 1 with no commit in the log to reach epoch 2 from. Replay cannot
repair that, and from then on every message the first joiner receives
fails with "epoch is in the future". A full log (`log-full`,
`log-too-large`) and a socket that drops after the commit is sent end
the same way. Removal has the same flaw: the creator sends its commit,
then the `removed` frame, and adopts the new epoch without waiting for
the room.

Separately, the explainer tells users that the creator's name exists
only inside an encrypted Welcome and that "the server never sees it".
That is false as soon as the creator removes someone. Removal commits
are sent as a PublicMessage, a Remove commit carries an UpdatePath, and
the committer's leaf in that path holds the basic credential with the
creator's literal name. The room can read the name without any group
keys.

### Core library

Once a member processes a ReInit commit, its `ClientState` is
`suspendedPendingReinit`. RFC 9420 section 12.4.2 says it must stop
sending on the old group and wait for the Welcome into the new one.
The library enforces the sending half (`createCommit` and the
application-message API refuse a suspended state), but not the
receiving half.

A member that ignores the ReInit can keep using the old group's keys.
A suspended receiver accepts its application messages, and a normal
commit from it is processed like any other: the receiver's state goes
back to `active`, the ReInit parameters are dropped, and the
application-send API works again. The application gets no signal that
the ReInit it was waiting on is gone, and a later
`joinGroupFromReinit` fails because there is no longer a suspended
state to resume from.

This needs a current member, not an outsider: the traffic is properly
authenticated with the old group's keys.

### Attachments

The attachment subsystem promises that every derived secret in a
`SealState` (the payload key, the snapshot key `acc_key`, the nonce
base) is overwritten once the stream that owns it is finished,
whether it finishes, fails or is cancelled. Two paths break that
promise.

A consumer that cancels a sequential decrypt stream at the wrong
moment leaves the whole schedule live. If the object's first chunk
holds all of it and the cancel lands while the final derivation of
the commitment gate is still settling, the cancel finds no state to
wipe, the derivation then completes, startup finishes from buffered
bytes, and nothing ever pulls the stream again. The CEK is wiped; the
three keys derived from it are not. No error is involved, so the
existing "a later failure will clean up" assumption never fires.

A crypto provider whose KDF rejects partway leaves the same keys
behind on a different path. Schedule construction derives the
commitment, payload key, snapshot key and nonce base one after
another, and if a later derivation rejects, the earlier ones are
dropped unwiped. The range reader's root check has the same gap one
step later: it holds a complete schedule, and if the root check
rejects for any reason other than a mismatch, the schedule is neither
wiped nor handed to the caller who could wipe it.

Neither path is a remote memory read or a plaintext leak. Both are
breaches of the key-overwrite contract that the rest of the subsystem
is held to.

Separately, `npm run lint` fails on two `no-labels` errors in a test
helper, and the CI `build` job runs lint, so the branch does not pass
its own gate.

### Packaging

A CommonJS consumer of the published package does not get one
consistent library. The CommonJS build renames its output files to
`.cjs` but leaves the specifiers inside them pointing at `.js`, so a
`require` of the root entry loads its internal modules from the ESM
build instead. A consumer that also requires a documented subpath,
such as `mls-error`, gets a second, separately evaluated copy of the
same module. A real library exception then fails `instanceof` against
the subpath's class, so the error contract the README documents does
not work from CommonJS. The minified CommonJS build has the same
shape.

The export map also promises a `.d.cts` declaration for every
CommonJS subpath, but the script that produces them reads only the top
level of `dist/`. Nested subpaths, which include the whole opt-in
attachment subsystem and the crypto modules, have no declarations at
all, and a TypeScript consumer on `NodeNext` resolution gets
`TS7016` and an implicit `any`.

Nothing catches either: every existing test imports from `src/`, so
the built package is never consumed the way a user consumes it.

Separately, `npm audit` now reports fifteen tooling entries where
`AGENTS.md` documents only one known, accepted finding, so the
documented baseline no longer matches the tree.

## Solution

### Realistic demo

A commit does not count until the room accepts it. The creator's
Welcome, its ledger frame (`approve` or `removed`), and its own move to
the new epoch all wait for that acceptance. Until then the commit is
held as a pending commit. If the room refuses it, nothing else is sent,
the creator's group state does not change, and the operation reports
the refusal. A rate-limited refusal is retried after the interval; a
full log is reported and not retried. If the socket drops while a
commit is pending, the outcome is settled from the replay after
reconnect: if the room's log has the commit, the pending commit
finishes, and if it does not, the pending commit is dropped.

Every commit the demo sends is a PrivateMessage, so the explainer's
promise holds as written.

### Core library

Suspension holds until the application leaves it by resuming into the
new group. A suspended state refuses every commit and proposal with a
`ValidationError` and does not change. It also refuses application
messages framed at the suspended epoch, because an honest member never
sends one there. Application messages from earlier epochs that the
state's historical receiver data still covers keep decrypting, so mail
that was in flight when the ReInit landed is not lost.

### Attachments

Whoever holds a `SealState` across an await checks, when the await
returns, whether the stream was cancelled meanwhile, and if so wipes
what it just received and stops. Schedule construction wipes any key
it has already derived when a later derivation fails. The root check
wipes the schedule it holds when it rejects, so ownership is never
lost between "derived" and "returned to the caller". Caller-owned
inputs, the CEK above all, are never wiped by the code that borrowed
them. The test helper is rewritten without labels, and lint passes.

### Packaging

The CommonJS build is a closed graph of `.cjs` files, and each
`.cjs` file has a `.d.cts` declaration beside it at every depth, whose
own references also stay in the CommonJS graph. A package consumer
check runs against the built `dist/` the way a real consumer would --
by package name, through the export map, from both CommonJS and ESM,
and through `tsc` on `NodeNext` -- and CI runs it after every build.
The dependency audit is brought back to a baseline that `AGENTS.md`
states accurately.

## User Stories

### Realistic demo

1. As a room creator, I want two quick approvals in a row to leave
   every member at the same epoch, so that approving people quickly
   never strands one of them.
2. As a room creator walking a pre-approved pending list, I want each
   request either admitted or left pending, so that the list never
   admits someone into an epoch the room does not have.
3. As a room creator, I want a refused approval to show me why, and to
   leave the request where I can approve it again, so that I can tell
   a throttle from a full room.
4. As a room creator whose connection dropped mid-approval, I want the
   approval to finish if the room got the commit and to be undone if
   it did not, so that I never end up ahead of or behind my own room.
5. As a joiner, I want a Welcome only for a commit that is in the
   room's log, so that the group I join is the one everyone else is
   in.
6. As a member being removed, or watching someone be removed, I want
   the removal to reach me only if the room accepted it, so that the
   roster I see matches the log.
7. As a room creator, I want my name to stay out of every message the
   server can read, so that the explainer's privacy promise is true.

### Core library

8. As an application whose member has processed a ReInit, I want later
   commits on the old group to be refused, so that one nonconforming
   member cannot cancel the ReInit for me.
9. As an application waiting to resume, I want the ReInit parameters
   to be intact when the Welcome arrives, so that
   `joinGroupFromReinit` succeeds no matter what the old group sent in
   the meantime.
10. As an application, I want my suspended member's send API to stay
    closed until it resumes, so that it cannot be tricked into
    speaking on a group RFC 9420 says is finished.
11. As an application, I want messages sent on the old group before
    the ReInit to still decrypt after it, so that suspension does not
    throw away in-flight mail.
12. As an application, I want refused traffic to fail as a
    `ValidationError`, so that I can treat it like any other bad peer
    input.

### Attachments

13. As an application that cancels an attachment download, I want
    every key derived for it overwritten no matter when the cancel
    lands, so that cancelling is as safe as finishing.
14. As an application using a crypto provider that can fail, I want a
    failed derivation to leave no partial schedule in memory, so that
    a provider error does not quietly cost me the key-overwrite
    guarantee.
15. As an application reading a byte range, I want a root check that
    fails for any reason to leave nothing behind, so that only a
    successful check hands me a schedule to manage.
16. As an application that passed its own CEK in, I want it left as I
    gave it when the library does not own it, so that cleanup never
    corrupts my buffers.
17. As a maintainer, I want `npm run lint` to pass, so that CI's build
    job reflects the code and not a known failure.

### Packaging

18. As a CommonJS consumer, I want an error the library throws to be
    `instanceof` the class I required from any documented entry
    point, so that I can handle errors the way the README says.
19. As a CommonJS consumer, I want requiring the root and a subpath to
    share one copy of each module, so that state and class identity
    are consistent across my imports.
20. As a TypeScript consumer on `NodeNext`, I want declarations for
    nested subpaths like the attachment reader and the crypto
    ciphersuite, so that my code typechecks against the real API
    rather than `any`.
21. As an ESM consumer, I want the same identity guarantees, so that
    the fix for CommonJS does not regress the default build.
22. As a maintainer, I want CI to consume the built package the way a
    user does, so that a packaging regression fails the build instead
    of shipping.
23. As a maintainer, I want the documented `npm audit` baseline to be
    the real one, so that a new finding stands out.

## Implementation Decisions

### Realistic demo

- A pending commit is the unit of acceptance. It holds the commit
  payload, the `newState` it leads to, and the frames that follow it
  (the Welcome and `approve` for an Add, the `removed` for a Remove).
  Only the creator commits in this demo, and commits are serialized by
  the existing approvals chain and the group lock, so at most one is
  pending at a time.
- Acceptance is the room's echo of this client's own entry: an `entry`
  whose `sender` is this client and whose `payload` equals the pending
  commit's payload. The room already broadcasts every accepted write to
  its sender, and the echo is the same shape live or in replay, so one
  rule covers both. Matching by payload is the same rule `apply-entry`
  already uses to credit a chat message to its sender.
- Refusal needs a correlation the wire does not have today. The `mls`
  client message gains an optional `ref`, a short client-chosen opaque
  string with a bounded length. When the room refuses an `mls` write
  that carried a `ref`, its `error` frame carries the same `ref`. The
  protocol narrowing functions accept and bound the new field; an `mls`
  frame without `ref` stays valid, so existing probes keep working.
  The room does not store `ref` in the log or broadcast it.
- The resolution logic -- matching echoes and refusals to the pending
  commit, and settling it after a replay -- is a pure module with no
  DOM, socket or signals, in the same family as `delivery-cursor` and
  `entry-queue`. `connection.ts` stays the only dispatcher: it feeds
  own entries and `error` frames to that module through
  `ConnectionDeps`, and the existing `error` status text still shows.
- `ApprovalDeps` gains a dependency that settles a submitted commit as
  accepted or refused (with the refusal reason). `approve` and `remove`
  send the commit, await that settlement, and only on acceptance send
  the follow-on frames and write `state.group` (inside `batch`, as
  now). The existing ordering rule -- commit first, Welcome before
  `approve`, short-circuit on a closed socket -- is kept; the new step
  sits between the commit and everything after it.
- Refusal handling by reason: `rate-limited` is retried after
  `MLS_WRITE_INTERVAL_MS`, a bounded number of times, rebuilding the
  commit from the creator's current group state only if that state
  changed in between; `log-full` and `log-too-large` are reported in
  `state.status` and not retried. Either way the request stays pending
  in the room, because `approve` was never sent.
- A dropped socket leaves the pending commit in place. After reconnect
  the replay is the authority: an own echo of the payload settles it as
  accepted; reaching the end of the replay (the last page, `more`
  false) without one settles it as lost, which is treated as a refusal
  and reported.
- The comment on `MLS_WRITE_INTERVAL_MS` currently argues that the
  interval must stay short because a refused commit strands the
  creator. That stops being true; update it to the new reasoning
  rather than leaving a stale justification beside the constant.
- `commitRemove` sends a PrivateMessage. `commitAdd` already produces a
  commit with no UpdatePath, but it switches too, so that no demo
  commit is public and a later change to Add (a forced path, say)
  cannot reopen the leak. A member being removed can still process the
  Remove: it holds the keys for the epoch the commit is framed in.
- The explainer copy is correct once commits are private and is not
  changed.

### Core library

- The receive path gains a suspension guard beside
  `throwIfRemovedFromGroup` in `process-messages`. Unlike that guard,
  it cannot be a blanket refusal at the top of the function, because
  historical application messages must pass. The guard runs where the
  message's epoch and content type are known: refuse a commit or
  proposal at any epoch, and refuse an application message framed at
  the state's current epoch. Both `processPrivateMessage` and
  `processPublicMessage` need it; `processMessage` gets it through
  them.
- A refusal is a `ValidationError`. The input comes from a peer, so by
  the error contract it is not an `InternalError` or a `UsageError`.
- A refused message leaves the input state untouched, the same as
  every other rejection: no wipe, no ratchet advance. The functional
  `ClientState` contract already requires this; the new guard should
  sit before anything that consumes a key.
- The commit-processing tail that computes `groupActiveState` keeps
  its current shape. With the guard in front, a suspended state can no
  longer reach it.
- Send-side guards (`checkCanSendApplicationMessages`,
  `checkCanSendHandshakeMessages`) already refuse a suspended state
  and are unchanged.

### Attachments

- The sequential reader latches cancellation in one place, and every
  point where it acquires a `SealState` across an await checks the
  latch immediately after. On a cancelled latch it wipes the acquired
  state and returns without continuing startup. The existing
  two-latch arrangement (one for the state, one for the CEK) stays;
  its comment explains why they must not merge, and the new check
  sits beside them rather than replacing either.
- The same rule applies to any other entry point that acquires a
  schedule across an await while a cancel can land (the group and
  range readers have cancel paths). Each one is checked for the
  shape; any that has it gets the same fix.
- Schedule construction (`deriveSchedule`, reached through
  `startSeal` and `openCommitment`) wipes every buffer it has already
  derived if a later derivation rejects, then rethrows the original
  error. It never wipes the CEK, which it borrows.
- `verifyRoot` owns the schedule from the moment `openCommitment`
  returns until it returns the schedule. If the root check rejects,
  for a mismatch or anything else, it wipes the schedule and rethrows.
  The mismatch-specific cleanup that exists today then becomes
  redundant and can fold into this.
- No new public API. The fixes are internal to the reader, range and
  schedule modules, and the invariants enforced by
  `check-attachment-invariants.mjs` (every `SealState` owner wipes it,
  no `getRandomValues`, `reader` does not pull `range`) still hold.
- The lint fix rewrites the substring search helper in the CEK-wipe
  test without a labeled `continue`. The eslint configuration is not
  changed.

### Packaging

- The CommonJS build rewrites every relative module specifier in its
  output to the CommonJS file it belongs with: `.cjs` for the regular
  build and `.min.cjs` for the minified one. Bundling each entry
  instead is rejected: it would duplicate shared modules per entry,
  which is the same class-identity bug in a different form.
- The declaration step walks `dist/` recursively, writing a `.d.cts`
  (and its map) beside every `.d.ts`, and rewrites relative specifiers
  inside the declarations to their `.cjs` form, so a CommonJS type
  graph never resolves into the ESM one.
- A new package consumer check is the seam for this area. It places
  the built package in a scratch consumer under its real package name
  (linked, so dependencies resolve without a network install), then:
  - requires the root and several subpaths -- at least `mls-error`, a
    nested attachment subpath and a nested crypto subpath -- triggers
    a real library error through a public call, and checks that it is
    `instanceof` the class from every entry point that exports it;
  - does the same from ESM;
  - checks that no `.cjs` file in `dist/` requires a relative `.js`
    path;
  - compiles a CommonJS and an ESM TypeScript consumer of the same
    subpaths under `--module NodeNext --strict`, and requires a clean
    exit. `skipLibCheck` stays off unless a third-party declaration
    forces it on, and the script says which one if so.
- The check has its own npm script and runs in CI's `build` job,
  after `npm run build`, because that job is the one that has `dist/`.
  It is not added to `test:checks`, which runs without a build. The
  root `AGENTS.md` paragraph on gates gets a sentence saying where it
  runs and why, the way it does for `check:style`.
- The check cleans up its scratch consumer whether it passes or fails.
- Dependencies: `npm audit fix` without `--force`, then confirm
  `npm ci`, the build, typecheck and the test suites still pass. The
  runtime set (`@hpke/*`, `@noble/*`) is not upgraded by this, and
  `npm audit --omit=dev` must still report zero. Whatever plain
  `npm audit` still reports afterwards is listed in `AGENTS.md` with
  the reason each one stays, replacing the current single-entry
  description. `package-lock.json` is committed with `package.json`.

## Testing Decisions

Good tests here drive a module's public surface and assert on what
leaves it -- frames sent, epochs, error classes, zeroed buffers, a
clean `require` or `tsc` run. They never assert on status text,
error message text or rendered HTML. Each area has exactly one seam.

### Realistic demo: `createApprovals` and `mls-actions`

- F1 is tested at `createApprovals`, extending the existing approvals
  harness. The harness's fake `send` simulates the room: it applies the
  production `classifyMlsWrite` to each `mls` write with a controllable
  clock, appends accepted writes to a log, answers with the own-entry
  echo or the `error` frame, and delivers accepted commits and Welcomes
  to real joiner states built with `mls-actions`. This is the audit's
  reproduction made into a test.
- The headline regression: two approvals inside one interval, then a
  creator application message; both joiners must process it. Further
  cases: a `log-full` refusal sends no Welcome and leaves the creator's
  epoch unchanged; a rate-limited refusal followed by the interval
  admits the joiner; a drop after the commit with the commit in the
  replay finishes the approval; a drop with the commit absent from the
  replay leaves the creator's epoch unchanged; Remove obeys the same
  rules.
- The pure resolution module gets its own Node tests for echo
  matching, `ref` matching, and settlement at the end of a replay.
- The protocol narrowing tests cover `ref` on `mls` and on `error`,
  including an over-long `ref`.
- F3 is tested at `commitRemove` and `commitAdd`: create a group under
  a distinctive creator name, commit, decode only base64 and the MLS
  envelope, and assert the wireformat is private and the name's bytes
  do not occur in the encoded message. A removed member processing the
  private Remove reaches the removed state.
- Prior art: `test/example-realistic-demo/approvals.ts`,
  `mls-actions.ts`, `connection.ts`, `delivery-client.ts` and
  `protocol.ts` in the same directory; the Durable Object itself is not
  run.

### Core library: public receive APIs on a suspended state

- Tests use the public group operations only: create a group, commit a
  ReInit, process it on the receiver, then deliver traffic through the
  public receive APIs and check what the receiver can and cannot do.
  Assert on outcomes (error class, `groupActiveState`, whether a send
  succeeds, whether `joinGroupFromReinit` works).
- The nonconforming sender is built the way the audit built it: copy
  the sender's own post-ReInit state with `groupActiveState` set to
  `active`. That changes only the sender's local flag, and its traffic
  is genuinely authenticated, which is what makes the test meaningful.
  The receiver's state is never touched directly.
- Cases: a post-ReInit commit is refused and the receiver stays
  suspended with the same ReInit parameters; a post-ReInit proposal is
  refused; a post-ReInit application message is refused; an
  application message from the epoch before the ReInit, delivered
  after it, still decrypts; after all of those, the receiver's send
  API still refuses and `joinGroupFromReinit` into the new group still
  succeeds. Each refusal is a `ValidationError`.
- The test sits next to the existing ReInit scenario and loops over
  `sampleCiphersuites()`: a second suite tells it nothing the first
  does not.
- Prior art: `test/scenario/reinit.ts` for the ReInit setup,
  `test/validation/prior-state-reuse.ts` for asserting an input state
  survives, and `test/validation/peer-input-errors.ts` for the error
  contract.

### Attachments: public stream and range entry points

- Tests drive the public stream and range entry points with a real
  ciphersuite wrapped so that its KDF can be paused or made to reject
  at a named label. The wrapper keeps references to the buffers the
  KDF returns, and the assertion is that each is all zeros once the
  operation has settled. That observes the contract from outside: the
  test never reaches into a `SealState`.
- F4 regression: a fully buffered object, the KDF paused on the last
  derivation of the commitment gate, the output reader cancelled, the
  KDF released, and the operation allowed to settle. Every derived
  key the wrapper saw is zero, and the CEK is wiped. The same shape is
  repeated for each other entry point found to share it.
- F7 regressions: a KDF that rejects at `nonce_base` during schedule
  construction leaves the earlier derived keys zeroed; a KDF that
  rejects at the snapshot epoch root during a range read's root check
  leaves the whole schedule zeroed. A caller-owned CEK passed to a
  borrowing entry point is unchanged afterwards.
- Assertions are taken after the paused derivation is released and
  the stream has settled, because the defect is in what happens once
  the derivation resumes. Races are made deterministic with the pause
  gate, never with timers.
- The lint fix is verified by `npm run lint` exiting 0 and the CEK-wipe
  suite still passing; it needs no test of its own.
- Prior art: the gated suite in `test/attachment/cancel-epoch-key.ts`
  (pausing a derivation by label, then cancelling) and
  `test/attachment/cek-wipe.ts` (zeroization assertions, including the
  two-latch regression).

### Packaging: the built package, consumed by name

- The only seam is the built package, consumed by name through the
  export map. Tests that import `src/` cannot observe either defect
  and do not count as coverage for this area.
- The checks are behavioral: class identity across entry points, a
  successful `require`, and a clean `tsc` run. They do not compare the
  contents of generated files beyond the one structural rule (no
  `.cjs` file reaches a relative `.js`).
- The audit's reproduction is the first case: a fail-closed
  authentication service rejection, caught and checked against
  `UsageError` from the root and from the `mls-error` subpath. The
  audit's `TS7016` consumer on `attachment/reader` is the second.
- CI runs Node 22; the check must pass there, not only on a newer
  local Node.
- Prior art: the structural gates under `scripts/` (plain `.mjs`
  scripts with a nonzero exit on failure) and the audit's own consumer
  probe.

## Out of Scope

- Realistic demo: chat messages refused by the throttle (a refused
  application message does not fork the group; it stays in
  `outbound` unacknowledged; worth its own ticket if it matters, but
  it is not this boundary), changing `MLS_WRITE_INTERVAL_MS` or the
  log caps, making the room parse or validate commits, and the feature
  demo in `example/`.
- Core library: branch (`joinGroupFromBranch`) and other resumption
  paths, which do not enter `suspendedPendingReinit`; any API for
  leaving suspension other than resuming into the new group; external
  commits against a suspended group's GroupInfo, which concern the
  committer's state, not the suspended receiver's.
- Attachments: wiping memory the garbage collector already owns, or
  any guarantee stronger than overwriting the buffers this library
  allocated; the previously documented stream-allocation limits and
  the upstream `snap_id 0x0003` interop gap; changing which KDF labels
  the schedule derives or their order.
- Packaging: changing the export map's shape or adding subpaths,
  publishing a release, dropping the CommonJS build, and upgrading
  tooling with `npm audit fix --force` or replacing `markdown-toc`.

## Further Notes

- The four areas are independent; none blocks another, so tickets
  from different areas can run in parallel.
- The demo fix touches both sides of the wire (`protocol.ts`, the
  Worker's `onMls`, and the client), so the Worker typecheck has to be
  run as well as the root one.
- The demo's `scripts/probe.mjs` sends `mls` frames without a `ref`
  and carries copies of some wire rules; it has to keep passing, which
  is why `ref` is optional on the wire.
- RFC 9420 section 12.4.2 is the ReInit requirement:
  https://www.rfc-editor.org/rfc/rfc9420.html#section-12.4.2
- `src/attachment/AGENTS.md` should be read before the first
  attachment edit; it documents the ownership rules and the invariant
  script.
- The minified ESM build is bundled, so it has no internal specifiers
  and is not affected. The export map does not reach it or the
  minified CommonJS build, so the consumer check covers the minified
  CommonJS output only through its structural rule.
- `check-audit-closed.mjs` only covers `AUDIT-ra.md`, so this audit
  has no resolution table to maintain.

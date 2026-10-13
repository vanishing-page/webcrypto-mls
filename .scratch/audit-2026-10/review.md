<!-- nightralph:review from=4bc1ac8ddc027de9e4544f16092e9344bad0b686 to=e55f607e129a9846562cbd93a1d1e8ebc456a633 status=fixed -->
## 2026-10-11 21:08 -- review 4bc1ac8..e55f607 -- 1 of 3 fixed
- [ ] A commit the room answers without a `ref` never settles, so the creator holds the group lock indefinitely
    example-realistic-demo/client/pending-commit.ts:612 and example-realistic-demo/index.ts:687 / :290-309. `submit` settles only on an own echo, an `error` carrying its `ref`, or a replay end after a reconnect. Two refusals of an `mls` write carry no `ref`. `requireRoom` answers `no-room` (the room expired between the request and the commit). `webSocketMessage` answers a bare `bad-message` for a frame over MAX_WIRE_MESSAGE_LENGTH, or one that fails `isClientMessage`, such as a payload over MAX_PAYLOAD_LENGTH. In either case `commitAndConfirm` (approvals.ts:112) awaits forever inside `lock.run`, so no later approval, removal or apply-entry can run until the socket happens to drop. Either echo `ref` on those paths where the frame was parsed, or settle a pending commit on a `no-room` and on any un-ref'd `error` that can only refer to it.
- [ ] After an accepted Add, a failed Welcome send adopts the new epoch, but the retry never re-sends the Welcome, so the joiner is stranded
    example-realistic-demo/client/approvals.ts:255-264. When `send(welcome) && send(approve)` is false after acceptance, the creator moves to `added.newState` and the comment says the request "stays pending in the room". The next approve of that request (a click, or the `pre-approved` re-broadcast) takes the `already` branch (approvals.ts:198), which sends only `approve` and deletes the row. The joiner's leaf is in the tree, but no Welcome is ever sent, so the joiner cannot reach the group. The window is narrow, because the echo resolves through microtasks, but this branch exists to handle it. Keep `added.welcome` to re-send it, or do not treat an in-tree identity with an unsent Welcome as already admitted.
- [x] New members were inserted under existing JSDoc blocks, so two doc comments now describe the wrong code
    example-realistic-demo/client/index.ts:151-163 and :213-222. The `applyEntry` doc ("Applying an entry is its own module...") now sits directly above the new `observeCommit` doc, so it is detached from `applyEntry`. The `approvals` doc ("Approving is the creator's...") now sits on `const pendingCommits` instead of `const approvals`. Move each comment back above the declaration it describes.

### Fix
- attempts: 1 of 4
- effort: medium
- agent exit code: 0
- result: merged

# Review-fix notes

## Finding 1 -- un-ref'd answers never settle a pending commit (done, e4a26c1)

Fixed on the client, not by echoing `ref` from the room:

- `pending-commit.ts`: new `CommitSignal` `{ type:'no-room' }`, settles
  the pending commit as refused (`no-room` added to the outcome reasons).
  `connection.ts` forwards `no-room` to `observeCommit` before setting
  `roomMissing`.
- `submit` checks the frame with `isClientMessage` and
  `MAX_WIRE_MESSAGE_LENGTH` before sending. A frame that would earn a bare
  `bad-message` (oversized, or failing the narrowing) is refused locally as
  `bad-message` and never sent, so nothing is left pending.
- Reading: "an un-ref'd error that can only refer to it" -- the only
  un-ref'd `bad-message` paths for an `mls` frame are the size wall and
  `isClientMessage`; both are now pre-empted client-side, so no un-ref'd
  error is treated as a commit refusal (other writes still produce them).
- Tests: pending-commit.ts (two cases), connection.ts (no-room is
  observed), approvals.ts (harness `room.gone`; the approval settles and
  the lock is free). The approvals test races against
  `longEnoughToHaveFinished` so a hang fails instead of silently ending
  the file -- verified red with the fix disabled.

## Finding 2 -- unsent Welcome after an accepted Add (done)

`approvals.ts` holds `unsentWelcome` (identity + payload) when
`welcome && approve` fails after acceptance. The `already` branch re-sends
it (Welcome then approve) when it is for that identity. Every other commit
(Add or Remove) flushes it first via `flushUnsentWelcome`, because the room
stamps a Welcome's cursor at high-water on arrival: a Welcome re-sent after
a later commit would make the joiner skip that commit. Removing the
stranded joiner clears it instead of sending it.

Tests (approvals.ts): harness `room.dropAfterEcho` closes the socket as the
commit's echo is delivered. Three cases: re-approve delivers it; approving
someone else first still leaves both able to read the creator; removal
drops it. Each was seen red.

## Finding 3 -- detached doc comments (done, afd0e52)

Moved the `applyEntry` doc above `applyEntry:` and the approvals doc above
`const approvals`. Comment-only; no test is possible or meaningful, so the
TDD loop does not apply. Typecheck and lint clean.

## Final

AGENTS.md (example-realistic-demo) gained two paragraphs under "A commit
counts once the room echoes it". `npm test` passed in full (47808/47808),
lint, typecheck (root, scripts, Worker) clean, check:style clean for the
touched files (pre-existing complaints elsewhere are not from this work).
---

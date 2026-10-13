# 07: An approval waits for the room to accept its commit

**What to build:** audit finding F1, spec stories 1, 2, 3 and 5. Two
quick approvals can split the room permanently. The room refuses an
`mls` write inside `MLS_WRITE_INTERVAL_MS` of the last accepted one,
but the creator treats "the frame left the socket" as "the room
accepted the commit". After the second Add is refused it still sends
that joiner's Welcome and `approve`, and moves its own `group` to the
new epoch, stranding the first joiner one epoch behind with no commit
in the log to catch up from.

A commit does not count until the room accepts it:

- A pending commit holds the commit payload, the `newState` it leads
  to, and the frames that follow it (Welcome and `approve` for an
  Add). At most one is pending at a time: only the creator commits,
  serialized by the approvals chain and the group lock.
- Acceptance is the room's echo of this client's own entry: an `entry`
  whose `sender` is this client and whose `payload` equals the pending
  commit's payload (the same rule `apply-entry` uses to credit a chat
  message to its sender). Refusal is an `error` frame carrying the
  pending commit's `ref` (ticket 06).
- The matching logic is a new pure module -- no DOM, socket or
  signals -- in the family of `delivery-cursor` and `entry-queue`.
  `connection.ts` stays the only dispatcher: it feeds own entries and
  `error` frames to that module through `ConnectionDeps`, and the
  existing `error` status text still shows.
- `ApprovalDeps` gains a dependency that settles a submitted commit as
  accepted or refused (with the reason). `approve` sends the commit
  with a `ref`, awaits settlement, and only on acceptance sends the
  Welcome, then `approve`, and writes `state.group` inside `batch`.
  The existing ordering rule (commit first, Welcome before `approve`,
  short-circuit on a closed socket) is kept.
- On refusal nothing else is sent and the creator's group does not
  change. `rate-limited` is retried after `MLS_WRITE_INTERVAL_MS`, a
  bounded number of times, rebuilding the commit only if the creator's
  group changed in between. `log-full` and `log-too-large` are
  reported in `state.status` and not retried. The request stays
  pending in the room either way, because `approve` was never sent.
- Update the comment on `MLS_WRITE_INTERVAL_MS`, which argues the
  interval must stay short because a refused commit strands the
  creator; that stops being true. Do not change the value.

Testing extends the approvals harness. Its fake `send` simulates the
room: it applies the production `classifyMlsWrite` to each `mls` write
with a controllable clock, appends accepted writes to a log, answers
with the own-entry echo or the `error` frame (with the `ref`), and
delivers accepted commits and Welcomes to real joiner states built
with `mls-actions`. The Durable Object itself is not run. Removal
(ticket 08) and dropped sockets (ticket 09) are out of this ticket.

Read `example-realistic-demo/AGENTS.md` first.

**Blocked by:** 06

**Touches:** `example-realistic-demo/client/approvals.ts`
(`ApprovalDeps`, `createApprovals`, `approve`),
`example-realistic-demo/client/connection.ts` (`ConnectionDeps`,
dispatch of own `entry` and `error` frames), a new pure module under
`example-realistic-demo/client/` for pending-commit resolution,
`example-realistic-demo/client/index.ts` (wiring the new deps),
`example-realistic-demo/room-logic.ts` (the `MLS_WRITE_INTERVAL_MS`
comment only), `test/example-realistic-demo/approvals.ts`,
`test/example-realistic-demo/connection.ts`, a new Node test file for
the pure module (imported from `test/unit.ts`)

**Status:** done

- [x] Headline regression: two approvals inside one interval, then a
      creator application message -- both joiners process it.
- [x] Walking a pre-approved pending list inside one interval admits
      each request or leaves it pending; no joiner receives a Welcome
      for a commit the simulated room's log does not hold.
- [x] A `log-full` refusal sends no Welcome and no `approve`, leaves
      the creator's epoch unchanged, and leaves the request pending.
- [x] A `rate-limited` refusal followed by the interval elapsing on
      the controllable clock admits the joiner, who then processes a
      creator application message.
- [x] Rate-limited retries stop after the bound and are reported as a
      refusal, with the creator's epoch unchanged.
- [x] The pure module: an own `entry` with the pending payload settles
      it as accepted; an own `entry` with a different payload, or
      another sender's `entry` with the same payload, does not; an
      `error` with the pending `ref` settles it as refused with that
      reason; an `error` with another `ref` or none does not.
- [x] Every test is timing-independent: the controllable clock and
      deferred promises only, no sleeps.
- [x] `npm run typecheck`,
      `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` and
      `npm run test:checks` (the signal-batching gate) are clean.

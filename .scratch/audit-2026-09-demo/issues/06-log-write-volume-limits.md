# 06: Log writes are volume-limited

**What to build:** audit finding M8, spec story 10. `onMls` has no rate
limit and no cap on log rows or bytes, and each entry may be 256 KiB,
so one participant can exhaust the room's storage quota.

Add a pure classifier in `room-logic.ts` in the same shape as
`classifyJoinRequest`: named, commented constants for a per-socket
interval between `mls` writes, a cap on log rows and a cap on total log
bytes, and a verdict naming which limit refused. Order the checks
most-specific-first and document why, as `classifyJoinRequest` does. A
`lastMlsAt` in the future counts as no prior write, for the same
hibernation reason.

`onMls` applies it after the membership and commit-kind guards, through
a `requireX` helper. A refusal writes nothing: no row, no broadcast,
and no update to the throttle. The throttle is socket-scoped and rides
`SocketState`, so `attach` carries it across every rewrite. Room totals
come from storage (a count and a sum over the log), not from a counter
that could drift.

Pick the caps so that an honest demo room never reaches them and the
paginated replay in ticket 07 still has a bounded worst case. Each
refusal gets its own `ErrorReason` if the client should tell them
apart, following the join-request precedent (all three edits in
"Adding an error reason"). The client does not need new behaviour
beyond showing the refusal.

Verification: probe checks that the Worker consults the rule (a second
write inside the interval is refused and reaches no peer; a write after
the interval is broadcast), with the caps themselves proved in Node, a
row in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
and the Worker typecheck.

**Blocked by:** 03, 04 (both rewrite `onMls` and `SocketState`; this
ticket goes after them to avoid conflicting rewrites, not because it
needs their behaviour)

**Touches:** `example-realistic-demo/room-logic.ts` (new constants and
classifier), `example-realistic-demo/index.ts` (`onMls`,
`SocketState`, `attach`, `readAttachment`),
`example-realistic-demo/protocol.ts` (`ErrorReason`, `ERROR_REASONS`),
`example-realistic-demo/scripts/probe.mjs`,
`example-realistic-demo/AGENTS.md`,
`test/example-realistic-demo/room-logic.ts`,
`test/example-realistic-demo/protocol.ts`

**Status:** done

- [x] A write within the interval of the same socket's previous write
      is refused as rate-limited; one at or after the interval is
      allowed.
- [x] A write when the log is at its row cap is refused.
- [x] A write that would take the log's total bytes past the byte cap
      is refused, and one that lands exactly on the cap is allowed.
- [x] A previous write timestamped in the future does not refuse the
      write.
- [x] A second `mls` inside the interval on one socket reaches no peer,
      and a write after the interval is broadcast (probe).

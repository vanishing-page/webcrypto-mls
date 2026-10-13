# 06: `mls` writes carry an optional `ref` the room echoes on refusal

**What to build:** the wire half of audit finding F1, a prefactor for
tickets 07 to 09. The room refuses an `mls` write (rate limit, full
log) before giving it a seq, and its `error` frame says why but not
which write it refused, so the client cannot tell its pending commit
was the one refused.

The `mls` client message gains an optional `ref`: a short,
client-chosen opaque string with a bounded length. When the room
refuses an `mls` write that carried a `ref`, its `error` frame carries
the same `ref`. The room does not store `ref` in the log or broadcast
it. The protocol narrowing functions accept and bound the new field on
both message types. An `mls` frame without `ref` stays valid, so
`example-realistic-demo/scripts/probe.mjs`, which sends frames without
one and carries copies of some wire rules, keeps passing.

Nothing in the client sends a `ref` yet; ticket 07 starts doing so.
Read `example-realistic-demo/AGENTS.md` first. This touches both sides
of the wire, so the Worker typecheck has to run.

**Blocked by:** None (can start immediately)

**Touches:** `example-realistic-demo/protocol.ts` (`ClientMessage`,
`RoomMessage`, `isClientMessage`, `isRoomMessage`, a new bound
constant), `example-realistic-demo/index.ts` (`onMls` and the refusal
`error` frame), `example-realistic-demo/scripts/probe.mjs` (only if
its copied wire rules need the new field),
`test/example-realistic-demo/protocol.ts`

**Status:** done

- [x] `isClientMessage` accepts an `mls` frame with a `ref` within the
      bound and one without a `ref`.
- [x] `isClientMessage` rejects an `mls` frame whose `ref` is over the
      bound or is not a string.
- [x] `isRoomMessage` accepts an `error` frame with and without a
      bounded `ref`, and rejects an over-long or non-string one.
- [x] A log entry built from an accepted `mls` write that carried a
      `ref` does not contain the `ref` (asserted at whatever pure
      function builds the entry, if one exists; otherwise by code
      inspection noted in the ticket comments).
- [x] `npm run typecheck` and
      `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` are
      clean.

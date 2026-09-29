# 07: Replay arrives in pages that fit a WebSocket frame

**What to build:** audit finding M8, spec story 11. `onHello` sends
every entry after the cursor in one `log` frame. Once the log outgrows
the frame limit, `send` fails on an open socket, the room only logs it,
and a reconnecting member silently believes it is caught up.

After this ticket no single replay frame can exceed the WebSocket frame
limit. The room sends at most one page per request: a pure function in
`room-logic.ts` picks the longest run of entries after a cursor whose
serialised size fits a named page budget, always at least one entry
(an entry is already bounded by `MAX_PAYLOAD_LENGTH`), and says whether
more remain. The `log` message gains the high-water mark, or a "more"
flag, so the client knows whether to ask again.

The client asks for the next page, from the cursor it has reached, until
it reaches the high-water mark. The asking belongs with the other socket
sends the dispatcher owns in `connection.ts`; do not add a second
switch over `msg.type`. That needs a new `ClientMessage` for "next
page from this cursor", which only a proven member may send. The
delivery cursor semantics do not change: a page is applied through the
entry queue exactly as a single `log` frame is today, and a live entry
arriving between pages is ordered by the queue as it already is.

Apply the same paging to the replay that follows `welcome-you`. Loading
every row in `onWelcome` for `countApplicationsAtOrBelow` is a storage
read, not a frame, but replace it with a `COUNT` query if that is
simple; the pure function stays the tested statement of the rule.

Verification: a probe check that a log larger than one page reaches a
reconnecting client whole and in order, a row in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
the root and Worker typechecks, the `window.state=` grep against
`npm run build:realistic`, and the Phase 7 harness (whose replay
scenario is the one this changes).

**Blocked by:** 03 (replay only happens after a proof; this rewrites the
same part of `onHello`)

**Touches:** `example-realistic-demo/room-logic.ts` (page selection,
page budget constant), `example-realistic-demo/protocol.ts`
(`ClientMessage`, the `log` message, `isClientMessage`,
`isRoomMessage`), `example-realistic-demo/index.ts` (`onHello`,
`onWelcome`, `entriesSince`, a handler for the new message),
`example-realistic-demo/client/connection.ts`,
`example-realistic-demo/client/delivery-client.ts`,
`example-realistic-demo/scripts/probe.mjs`,
`example-realistic-demo/AGENTS.md`,
`test/example-realistic-demo/room-logic.ts`,
`test/example-realistic-demo/protocol.ts`,
`test/example-realistic-demo/connection.ts`

**Status:** done

- [x] Page selection returns every entry after the cursor, in seq
      order, when they fit the budget, and reports that none remain.
- [x] When they do not fit, it returns the longest prefix that fits and
      reports that more remain.
- [x] It returns a single entry even when that entry alone is larger
      than the budget, and never returns zero entries while any remain.
- [x] Concatenating the pages a cursor walk produces yields exactly the
      entries after the starting cursor, with no gap or repeat.
- [x] Given a `log` page reporting more entries remain, the client asks
      for the next page from the last seq it received; given a final
      page, it asks for nothing.
- [x] A client reconnecting to a room whose log exceeds one page
      receives every entry after its cursor, in order, and no frame
      exceeds the budget (probe).

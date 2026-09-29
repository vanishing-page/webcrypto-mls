# 09: Room creation is bounded, and a GET for an unknown id names no object

**What to build:** audit finding M8, spec story 12. Today `route` calls
`env.ROOM.getByName(roomId)` for any syntactically valid id, so a GET
for an id that has no room instantiates a Durable Object to say so, and
anyone can open sockets to fresh ids and create rooms without limit.

Decision (agreed 2026-09-28, replacing the spec's per-socket `create`
throttle): a per-socket throttle bounds nothing, because every new room
is a new object reached over a new socket. Instead:

- **Rate limit at the Worker.** A Workers rate-limiting binding, keyed
  by the client's IP (`CF-Connecting-IP`), limits socket upgrades on
  the `/ws` route before the room is named. The Worker cannot tell a
  `create` from a `hello` before the socket opens, so the limit applies
  to every upgrade and has to be generous enough for an honest client's
  reconnect backoff (see `RECONNECT_BASE_MS`). A limited upgrade gets
  429 and names no object.
- **A room registry the GET route reads first.** `onCreate` records the
  id as live, and the expiry alarm records it as expired. The GET route
  answers 404 without naming an object when the registry has no live
  entry for the id, and only asks the room for its times when it does.
  Keep the decision itself pure in `room-logic.ts` (registry state ->
  answer), applied from `route`.

The registry has to be read-after-write consistent: an invitee opening
a link seconds after the room was created, from another location, must
not be told the room is gone. Workers KV does not guarantee this (a
miss can be cached at the edge for up to a minute), so use a store that
does -- D1, or a single registry Durable Object -- and write down the
choice and why in the Worker's `AGENTS.md`. The object's own tombstone
from ticket 08 stays the authority for refusing `create`; the registry
only lets the GET route avoid instantiating objects.

Any new binding goes in `wrangler.jsonc`, with `npm run
types:realistic` rerun and the regenerated `worker-configuration.d.ts`
committed. Replies still leave only through `route` and
`withSecurityHeaders` (see "Security headers, and the one exit the
Worker has").

Verification: probe checks for both polarities of each rule (an
unknown id's GET is 404, a live room's GET is 200 with times; upgrades
past the limit are 429, an honest reconnect is not), rows in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
the Worker typecheck, and the `window.state=` grep against
`npm run build:realistic`.

**Blocked by:** 08 (the alarm writes both the tombstone and the
registry's expired entry)

**Touches:** `example-realistic-demo/wrangler.jsonc`,
`example-realistic-demo/worker-configuration.d.ts`,
`example-realistic-demo/index.ts` (`route`, `onCreate`, `alarm`),
`example-realistic-demo/room-logic.ts` (the GET decision, the rate
limit's named constants), `example-realistic-demo/scripts/probe.mjs`,
`example-realistic-demo/AGENTS.md`,
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
`test/example-realistic-demo/room-logic.ts`

**Status:** done

- [x] The GET decision answers "no such room" for an id the registry
      does not list, and for one it lists as expired.
- [x] The GET decision asks the room for its times only for an id the
      registry lists as live.
- [x] A GET for a valid but unused id returns 404 (probe check 1 stays
      green) and a GET for a live room returns 200 with its times
      (probe check 4 stays green).
- [x] Upgrades from one client past the limit are answered 429 and
      open no socket, while an upgrade within the limit still opens
      one (probe).
- [x] A room created and immediately fetched by GET returns 200, not
      404 (probe).

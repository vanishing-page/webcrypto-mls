# Audit 2026-09: realistic demo fixes

**Status:** ready-for-agent
**Source:** `docs/security-audit-2026-09.md` (H4, H5, H6, M8, L13,
L14, and the `docs/security-audit.md` record corrections for the demo)
**Depends on:** the core spec's M6 story (authenticated sender on
`processMessage`) for H5.

## Problem Statement

The realistic demo is deployed, and it is meant to show that the
delivery service does not need to be trusted. Today it has to be.

The room link -- which is exactly what people pass around to invite
others -- is enough to connect as any identity. `hello` believes
whatever identity the socket claims, then hands over the whole log,
the roster and that identity's mailbox. Anyone holding the link can
read every commit in the clear (each Add carries the joiner's display
name), write entries as an admitted member, evict that member's live
socket, or consume their pending Welcome so they never get in.

A chat message is credited to whatever `sender` the room wrote next to
it, not to the member MLS authenticated. So an impersonating stranger,
or the Worker operator, can put words in Alice's mouth, and the page
shows them as Alice's.

Any commit the client cannot process stops the client for good. A
stranger replaying an old commit under a member's identity makes every
member's client halt with "Reload to resynchronise", and reloading
replays the same entry, so the room is dead until it expires three
days later.

The room also has no volume limits outside join requests, so the log
can grow past what one WebSocket frame can carry (after which
reconnecting members silently desync), and anyone can create rooms and
Durable Objects without limit. An expired room's id can be claimed by
anyone, so old invitation links and saved sessions reconnect into an
attacker's room. And the `.gitignore` hardening an earlier audit
recorded as done was lost in a squash merge.

## Solution

A socket proves it holds the identity it claims before the room tells
it anything. Messages are credited to the leaf MLS authenticated, and a
disagreement with the room's claim is visible. A commit the client
cannot process stops the client only when it really was a current-epoch
commit from the creator; anything else is skipped. The room bounds the
volume any one socket or client can cost it, replays the log in pages,
refuses to re-create an expired room, and the repository ignores the
secret-looking files it once did.

## User Stories

1. As a room member, I want the room to require proof that a socket
   holds my identity's signing key before attaching it as me, so that a
   stranger with the room link cannot impersonate me.
2. As a room member, I want the log, roster and my mailbox withheld
   from a socket until it has proved its identity, so that the room
   link alone reveals nothing.
3. As an invitee, I want my pending Welcome delivered only to a socket
   that proved it is me, so that nobody can consume it in my place.
4. As a connected member, I want my live socket replaced only by a
   socket that proved it is me, so that a stranger cannot evict me.
5. As a reader, I want each message attributed to the member MLS
   authenticated, so that neither another member nor the operator can
   put words in someone else's mouth.
6. As a reader, I want a message marked when the room's claimed sender
   disagrees with the authenticated one, so that tampering is visible
   rather than silently corrected.
7. As a member, I want a commit from an old or future epoch, for a
   different group, or from anyone but the creator skipped rather than
   treated as fatal, so that a replayed commit cannot halt my client.
8. As a member, I want my client to stop only when a current-epoch
   commit from the creator fails to process, so that genuine desync is
   still reported rather than silently papered over.
9. As a room creator, I want the room to refuse a commit-kind entry
   from anyone but me, so that only the party that commits in this demo
   can write commits to the log.
10. As a room member, I want each socket's write rate and the room's
    total rows and bytes bounded, so that one participant cannot
    exhaust the room's storage quota.
11. As a reconnecting member, I want the log replayed in pages that fit
    a WebSocket frame, so that a long-lived room does not silently
    desync me.
12. As the demo operator, I want room creation throttled and no Durable
    Object instantiated for a GET on a room id that does not exist, so
    that strangers cannot create rooms and objects without limit.
13. As someone holding an old invitation link or saved session, I want
    an expired room id to stay dead, so that I never reconnect into a
    room someone else created under the same id.
14. As a contributor, I want `.env.*`, private key files and
    `.dev.vars*` ignored by git, so that a secret is not committed by
    accident.
15. As a reader of `docs/security-audit.md`, I want the rows claiming
    the room validates commits and the `.gitignore` fix landed
    corrected, so that the record describes the code.

## Implementation Decisions

### Identity proof at `hello` (H4)

- The room issues a fresh random challenge per socket. `hello` carries
  a signature over that challenge (bound to the room id, so a proof
  cannot be replayed into another room) made with the client's leaf
  signature key. An identity is already the base64url of the leaf's
  Ed25519 `signaturePublicKey`, so the room verifies with WebCrypto's
  Ed25519 against the identity itself and needs no other key registry.
- Verifying a proof is a pure rule in `room-logic`, like the other
  authorization rules: it takes identity, challenge, room id and
  signature, and returns whether the proof holds. `index.ts` applies it
  through a small `require` helper that sends the refusal, keeping the
  guard-order convention (the room must exist first).
- Until a socket has proved an identity it gets nothing but the
  challenge: no log, roster or mailbox. The `create` path proves the
  same way, and the creator token check stays in place on top of it.
- The socket-replacement rule protects every proven identity, not only
  the creator: only a socket that proved the same identity may replace
  a live one.
- The challenge rides the socket attachment and is carried across every
  attachment rewrite, following the rule already written down for the
  join-request throttle.
- The wire contract in `protocol.ts` gains the challenge message and
  the proof field; the client signs from `onOpen`, which already owns
  what a fresh socket says, in order.

### Authenticated attribution (H5)

- The client's entry processing returns the authenticated sender the
  core spec adds to `processMessage`. The leaf index is resolved to an
  identity through `membership` at decrypt time, not at render time,
  because a removed member's leaf index can later be reused.
- `buildTimeline` takes the authenticated identity per decrypted entry
  and credits the message to it. `entry.sender` is kept only as a
  routing hint; when it disagrees with the authenticated identity the
  timeline item carries a mismatch flag, and the view marks it. Copy
  for that mark follows the demo's rule that copy is reviewed by
  reading, not by test.

### Commit failure verdict (H6)

- The decision "skip or stop" for a commit that failed to process is
  extracted from `delivery-client` into a pure function. Its inputs are
  what can be read without processing: the commit's framed epoch and
  group id (a PublicMessage's framing is cleartext), the client's
  current epoch and group id, and whether the room-proven sender is
  the creator. It returns `stop` only for a current-epoch commit for
  this group from the creator, and `skip` otherwise. Decode failures
  keep their existing malformed-entry handling.
- `delivery-client` advances the cursor past a skipped commit exactly
  as it does for an undecryptable application entry, and consults the
  function rather than stopping on every commit failure.
- The room refuses `commit`-kind entries from any identity but the
  creator, as a pure rule next to `mayWriteLog`. Only the creator
  commits in this demo (approvals and removals), so this closes the
  server-side half the earlier audit wrongly recorded as done.

### Volume limits (M8)

- New limits live in `room-logic` as named constants and a pure
  classifier, in the same shape as `classifyJoinRequest`: a per-socket
  interval on `mls`, a cap on log rows and on total log bytes. A
  refusal writes nothing, including the throttle.
- Replay after `hello` and the Welcome replay are paginated so that no
  single frame exceeds the WebSocket frame limit; the client requests
  the next page until it reaches the high-water mark. The delivery
  cursor semantics do not change.
- `create` is throttled per socket, and routing does not instantiate a
  Durable Object for a GET on a room id that has no room.

### Expired room ids (L13)

- The room's expiry alarm leaves a tombstone instead of deleting
  everything, and `create` refuses an id that carries one. The
  tombstone holds no group data. A tombstoned id answers as "room
  gone", which the client already renders.

### Repository hygiene (L14)

- `.gitignore` regains the patterns from the lost hardening commit and
  adds `.dev.vars*`. `git check-ignore` is the verification.
- `docs/security-audit.md` is corrected at the row that says the room
  validates commit entries (true after this spec, with this spec named)
  and at the row that says the `.gitignore` fix landed.

## Testing Decisions

- A good test calls a pure demo module as a plain function and asserts
  on its return value: a verdict, a boolean, a list of timeline items.
  No test asserts on rendered HTML text, and none needs a Worker or a
  browser.
- The seams are the three pure modules the audit points at, all
  already tested in Node from `test/example-realistic-demo/`:
  `room-logic` (identity-proof verification, the commit-kind rule, the
  volume classifier, the tombstone rule), the extracted commit-failure
  verdict, and `buildTimeline`.
- Identity-proof tests use real Ed25519 keys through WebCrypto in
  Node: a valid proof passes, and a proof over another challenge,
  another room id, or by another key fails.
- The verdict is tested over its whole input table: old epoch, future
  epoch, foreign group id and non-creator sender all skip; current
  epoch, this group, creator stops.
- `buildTimeline` tests show a message credited to the authenticated
  identity when the room's `sender` names someone else, carrying the
  mismatch flag, and unflagged when the two agree.
- `delivery-client` is covered through its existing fake-WebSocket
  harness only for the change in cursor behaviour on a skipped commit;
  the rules themselves are tested at the pure seam.
- Prior art: `test/example-realistic-demo/room-logic.ts`,
  `test/example-realistic-demo/delivery-client.ts`,
  `test/example-realistic-demo/timeline.ts`,
  `test/example-realistic-demo/membership.ts`. New files are imported
  from `test/unit.ts`.
- After any change to the demo, `npm run build:realistic` and the
  `window.state=` grep from AGENTS.md must still find nothing, and the
  Worker's own tsconfig must typecheck.

## Out of Scope

- Sending commits as PrivateMessage. It would hide Add contents from
  the log, but with H4 fixed only proven members read the log, and the
  change touches every place the client and room handle commits.
- The Informational demo items: plaintext secrets in IndexedDB (opt-in
  and disclosed), inline sourcemaps in the realistic build, and the
  `===` comparison of the creator token.
- Any change to the library itself; M6 is delivered by the core spec.

## Further Notes

- H4 is the root of H5's and H6's worst cases, because it lets a
  stranger write under a member's identity. It should land first.
- The audit did not run a live Worker; H4 and M8 were exercised through
  the logic halves in Node. The Worker probe checks that already prove
  the room consults `classifyJoinRequest` are the model for proving it
  consults the new rules.
- `example-shared/` persistence is touched by the core spec (its
  IndexedDB version bumps for the H2 state-shape change); that is
  shared with the feature demo, so check both callers.

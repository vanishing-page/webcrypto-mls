# 04: A replayed or foreign commit cannot halt a client

**What to build:** audit finding H6, spec stories 7 to 9, and the
"room validates commits" half of story 15. Today any commit that fails
to process returns `'stop'` from `onError` in `delivery-client.ts`, and
reconnecting replays the same entry, so one replayed commit kills the
room for all of its three days.

Client half. Extract the skip-or-stop decision for a commit that failed
to process into a pure function, in its own module beside
`malformed-entry.ts` so it can be tested in Node. Its inputs are what
can be read without processing:
- the commit's framed epoch and group id (a PublicMessage's framing is
  cleartext, and a PrivateMessage's group id and epoch are too), read
  from the decode step `processEntry` already does
- the client's current epoch and group id
- whether the entry's sender is the creator

It returns `stop` only for a current-epoch commit for this group from
the creator, and `skip` otherwise. `onError` consults it rather than
stopping on every commit failure, and advances the cursor past a
skipped commit exactly as it does for an undecryptable application
entry. Decode failures keep their `MalformedEntryError` handling;
do not widen where that error is thrown (see "A failed entry is two
different failures" in `example-realistic-demo/AGENTS.md`). The status
line should tell a skipped commit apart from a fatal one.

Decision (departs from the spec's wording, agreed 2026-09-28): the
creator is the identity at leaf 0 of the client's own ratchet tree,
resolved through `membership.ts`, and "sender is the creator" means
`entry.sender` equals that identity. The client never takes the
creator's identity from the room, following "Membership comes from the
tree, never from the room". This holds because only the creator
removes members, so leaf 0 is never vacated.

Room half. A pure rule next to `mayWriteLog` refuses a `commit`-kind
entry from any socket that is not the creator, applied in `onMls`
through a `requireX` helper after `requireMember`, with its own
`ErrorReason` (all three edits in "Adding an error reason"). A refusal
writes nothing and broadcasts nothing.

Record correction: the H2 row in the resolution table of
`docs/security-audit.md` says the room validates a `commit`-kind entry
before appending it. Rewrite it to say what is true after this ticket
-- the room refuses commits from anyone but the creator, and the client
skips a commit it cannot process unless it is a current-epoch commit
from the creator -- naming this spec.

Verification: a probe check for both polarities of the room rule, a
row in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
the root and Worker typechecks, and the `window.state=` grep against
`npm run build:realistic`.

**Blocked by:** None (can start immediately)

**Touches:** a new pure module under `example-realistic-demo/client/`
for the verdict, `example-realistic-demo/client/delivery-client.ts`
(`onError`), `example-realistic-demo/client/mls-actions.ts`
(`processEntry`, exposing the framed epoch and group id),
`example-realistic-demo/client/membership.ts`,
`example-realistic-demo/room-logic.ts` (a sibling of `mayWriteLog`),
`example-realistic-demo/index.ts` (`onMls`),
`example-realistic-demo/protocol.ts` (`ErrorReason`, `ERROR_REASONS`),
`example-realistic-demo/scripts/probe.mjs`,
`example-realistic-demo/AGENTS.md`, `docs/security-audit.md`,
a new test file under `test/example-realistic-demo/` imported from
`test/unit.ts`, `test/example-realistic-demo/delivery-client.ts`,
`test/example-realistic-demo/room-logic.ts`,
`test/example-realistic-demo/protocol.ts`

**Status:** done

- [x] The verdict is `skip` for a commit from an older epoch.
- [x] The verdict is `skip` for a commit from a future epoch.
- [x] The verdict is `skip` for a commit framed for another group id.
- [x] The verdict is `skip` for a current-epoch commit for this group
      whose sender is not the creator.
- [x] The verdict is `stop` for a current-epoch commit for this group
      from the creator.
- [x] Through the fake-WebSocket harness, a commit that fails and is
      skipped advances the cursor past its seq and the next entry is
      applied; a commit that fails with a `stop` verdict leaves the
      cursor where it was.
- [x] The room rule allows a `commit` from the creator, refuses one
      from an admitted non-creator, and allows an `application` from
      that same non-creator (Node).
- [x] An admitted member's `commit` is refused and reaches no peer,
      while the same member's `application` is still broadcast
      (probe).

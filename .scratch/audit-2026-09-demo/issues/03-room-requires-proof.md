# 03: The room serves nothing to a socket that has not proved its identity

**What to build:** audit finding H4, the contract half; spec stories 1
to 4. Ticket 02 has every client proving its identity. This ticket
makes the proof mandatory, so the room link on its own reveals nothing
and lets nobody act as anyone.

- `hello` and `create` without a valid proof are refused. The creator
  token check stays in place on top of the proof for `hello`.
- Until a socket has proved an identity it receives nothing but the
  challenge: no `room-state`, no `log`, no roster and no mailbox, and
  it does not count as live in the roster.
- A pending Welcome is delivered only to a socket that proved the
  recipient's identity.
- `replaceExistingSocket` protects every proven identity, not only the
  creator: a live socket is replaced only by a socket that proved the
  same identity. Rewrite its header comment, which currently argues
  the creator-only version.
- Every handler that reads `SocketState.identity` (`requireMember`,
  `requireCreator`, `onMls`, `onJoinRequest`, the roster) sees only a
  proven identity. Record "proven" in the attachment so an unproven
  socket cannot reach them at all.

`onJoinRequest` is the one handler a non-member may use. The join flow
stays open, but the requester must now have proved the identity it is
asking for, which closes the gap between the two halves of a join
request that only `keyPackageBelongsTo` on the creator's side checks
today.

Most of the work is in `probe.mjs`. Its clients say `hello` under
opaque random identities, so each has to become a real Ed25519 key
that answers the challenge. Keep every existing check's meaning. Add
checks for both polarities of each rule above -- who is refused, and
that the proven socket still gets through -- and assert the refusal's
effect, not only its reply: no `log` frame, no `welcome-you`, the live
socket not closed. Update the `mayWriteLog` comment in `room-logic.ts`,
which says the room does not authenticate identities.

Verification: probe checks as above, rows in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
the four Playwright harnesses passing against `npm run dev:realistic`,
the root and Worker typechecks, and the `window.state=` grep against
`npm run build:realistic`.

**Blocked by:** 02

**Touches:** `example-realistic-demo/index.ts` (`onHello`, `onCreate`,
`onJoinRequest`, `SocketState`, `attach`, `readAttachment`,
`deliverMailbox`, `replaceExistingSocket`, `broadcastRoster`,
`requireMember`), `example-realistic-demo/room-logic.ts` (comments,
any new pure rule for the replacement decision),
`example-realistic-demo/scripts/probe.mjs`,
`example-realistic-demo/AGENTS.md`,
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
`test/example-realistic-demo/room-logic.ts`

**Status:** done

- [x] A `hello` with no proof, or with a proof by another key, gets no
      `room-state`, `log`, roster or `welcome-you` (probe).
- [x] A `hello` with a valid proof still gets `room-state`, the log
      after its cursor and the roster (probe).
- [x] A pending Welcome survives a `hello` from an unproven socket
      claiming the recipient's identity and is still delivered to the
      recipient's proven socket afterwards (probe).
- [x] A member's live socket stays open when an unproven socket claims
      that member's identity, and is replaced when a socket proves it
      (probe).
- [x] If the replacement rule is a pure function, it refuses an
      unproven incoming socket for every identity and allows a proven
      one for the same identity (Node).
- [x] `create` with no valid proof creates no room (probe).

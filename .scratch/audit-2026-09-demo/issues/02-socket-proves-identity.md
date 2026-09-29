# 02: A socket can prove the identity it claims

**What to build:** audit finding H4, the expand half. After this ticket
every client proves its identity and the room checks every proof it is
given, but a `hello` or `create` that carries no proof is still
accepted, so `probe.mjs` keeps passing unchanged. Ticket 03 makes the
proof mandatory.

The room issues a fresh random challenge to each socket as soon as it
is accepted, before the socket has said anything. The challenge rides
the socket attachment and has to survive every `attach` rewrite, the
same way `lastJoinRequestAt` does (see "A join request is the one
write a stranger can cause" in `example-realistic-demo/AGENTS.md`).

The client signs a domain-separated message binding a fixed label, the
room id and the challenge, using its leaf signature key, and sends the
signature on `hello` and `create`. An identity is already the base64url
of the leaf's Ed25519 `signaturePublicKey`, so the room verifies with
WebCrypto's Ed25519 against the identity itself and needs no key
registry.

Verification is a pure rule in `room-logic.ts`, `verifyIdentityProof`
(identity, challenge, room id, signature -> whether the proof holds),
applied from `index.ts` through a small `requireX` helper that sends
the refusal, after `requireRoom` in guard order. Signing lives in
`mls-actions.ts`, the only place the client calls the library.

The client can no longer send `hello` from `onOpen` directly, because
the challenge has not arrived yet. The ordered messages `onOpen` sends
today -- `create` or `hello`, then the join request -- move to the
dispatcher's handling of the new challenge message, in the same order,
and still re-send on every reconnect. `connection.ts` stays the only
dispatcher; do not add a second switch over `msg.type`. The queue
reset stays in `onOpen`.

Wire contract: a new `RoomMessage` for the challenge and a proof field
on `hello` and `create`, each string bounded by the predicates in
`protocol.ts` (see "Adding a wire field that carries a string"), and a
new `ErrorReason` for a refused proof (all three edits in "Adding an
error reason").

Verification: a probe check that asserts both polarities (a valid
proof is attached, a forged one is refused and receives no `log`),
a row in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
the root and Worker typechecks, and the `window.state=` grep against
`npm run build:realistic` from the root `AGENTS.md`.

**Blocked by:** None (can start immediately)

**Touches:** `example-realistic-demo/room-logic.ts`
(`verifyIdentityProof`), `example-realistic-demo/protocol.ts`
(`ClientMessage`, `RoomMessage`, `ErrorReason`, `ERROR_REASONS`,
`isClientMessage`, `isRoomMessage`), `example-realistic-demo/index.ts`
(`fetch`, `SocketState`, `attach`, `readAttachment`, `onHello`,
`onCreate`), `example-realistic-demo/client/connection.ts` (`onOpen`,
the dispatcher), `example-realistic-demo/client/mls-actions.ts`,
`example-realistic-demo/scripts/probe.mjs`,
`test/example-realistic-demo/room-logic.ts`,
`test/example-realistic-demo/protocol.ts`,
`test/example-realistic-demo/connection.ts`,
`test/example-realistic-demo/mls-actions.ts`

**Status:** done

- [x] `verifyIdentityProof` accepts a signature made by the identity's
      own Ed25519 key over the challenge and room id (real keys through
      WebCrypto in Node).
- [x] It rejects a proof over a different challenge, over a different
      room id, and one made by a different key.
- [x] It rejects an identity that does not decode to an Ed25519 public
      key, returning false rather than throwing.
- [x] A proof produced by the client's signing function in
      `mls-actions.ts` passes `verifyIdentityProof` for the same
      identity, challenge and room id.
- [x] On receiving the challenge, the connection sends `hello` carrying
      a proof, followed by the join request when one is wanted, in that
      order; a creating client sends `create` carrying a proof instead.
- [x] Nothing but the queue reset happens in `onOpen` before the
      challenge arrives.
- [x] `isClientMessage` accepts `hello` and `create` with and without a
      proof, and rejects a proof that exceeds its bound.

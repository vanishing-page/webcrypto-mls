# 04: A suspended member refuses old-group traffic

**What to build:** audit finding F2, spec stories 8 to 12. Once a
member processes a ReInit commit, its state is `suspendedPendingReinit`,
and RFC 9420 section 12.4.2 says it must stop using the old group. The
send side is enforced; the receive side is not. A nonconforming member
can keep sending on the old group: a suspended receiver accepts its
application messages, and processing a normal commit from it puts the
receiver back to `active`, drops the ReInit parameters, and reopens
the send API. A later `joinGroupFromReinit` then fails.

Fix: a suspension guard on the receive path, beside
`throwIfRemovedFromGroup` in `process-messages`. It cannot be a blanket
refusal at the top, because historical application messages must
pass. It runs where the message's epoch and content type are known:

- refuse a commit or a proposal at any epoch;
- refuse an application message framed at the state's current epoch;
- let an application message from an earlier epoch that the state's
  historical receiver data still covers decrypt as before.

Both `processPrivateMessage` and `processPublicMessage` need it;
`processMessage` gets it through them. A refusal is a
`ValidationError` (peer input, per the error contract) and leaves the
input state untouched: the guard sits before anything that consumes a
key or advances a ratchet. The tail that computes `groupActiveState`
keeps its shape, and the send-side guards
(`checkCanSendApplicationMessages`, `checkCanSendHandshakeMessages`)
are unchanged.

Testing: public group operations only. Build the nonconforming sender
the way the audit did -- copy the sender's own post-ReInit state with
`groupActiveState` set to `active` -- so its traffic is genuinely
authenticated. Never touch the receiver's state directly. The test
sits next to `test/scenario/reinit.ts`, loops over
`sampleCiphersuites()`, and is imported from `test/matrix.ts`.

**Blocked by:** None (can start immediately)

**Touches:** `src/process-messages.ts` (`processPrivateMessage`,
`processPublicMessage`, a new guard beside `throwIfRemovedFromGroup`),
a new `test/scenario/` file next to `test/scenario/reinit.ts`
(imported from `test/matrix.ts`); prior art in
`test/validation/prior-state-reuse.ts` and
`test/validation/peer-input-errors.ts`

**Status:** done

- [x] A commit from the nonconforming member, delivered after the
      ReInit, is refused with `ValidationError`; the receiver stays
      `suspendedPendingReinit` with the same ReInit parameters.
- [x] A proposal from the nonconforming member, delivered after the
      ReInit, is refused with `ValidationError`.
- [x] An application message framed at the suspended epoch is refused
      with `ValidationError`.
- [x] An application message sent in the epoch before the ReInit and
      delivered after it still decrypts to the original plaintext.
- [x] Each refusal leaves the receiver's input state usable: the same
      state still decrypts the historical message above afterwards.
- [x] After all of the above, the receiver's application-send API
      still refuses, and `joinGroupFromReinit` into the new group
      succeeds.
- [x] The existing ReInit scenario still passes, and
      `npm run typecheck` is clean.

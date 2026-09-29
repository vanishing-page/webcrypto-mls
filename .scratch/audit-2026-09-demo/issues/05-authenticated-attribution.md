# 05: Messages are credited to the member MLS authenticated

**What to build:** audit finding H5, spec stories 5 and 6. `buildTimeline`
credits each message with `input.names[entry.sender]`, and
`entry.sender` is whatever the room wrote beside the ciphertext. So
another member, or the Worker operator, can put words in Alice's mouth
and the page shows them as Alice's.

Core ticket 13 makes `processMessage` report the authenticated sender
(leaf index and sender type) on an application message. Consume it:

- When an application entry decrypts, resolve the sender's leaf index
  to an identity through `membership.ts` against the tree the message
  was processed under, at decrypt time, not at render time. A removed
  member's leaf can be reused later, so a lookup at render time can
  name the wrong person.
- `state.decrypted` records that identity beside the plaintext for each
  seq. The client's own sent messages, matched from `state.outbound` by
  ciphertext, are credited to this client's own identity.
- `buildTimeline` credits each text item to the authenticated identity.
  `entry.sender` is kept only as a routing hint: when it disagrees with
  the authenticated identity the item carries a mismatch flag.
- The room view marks a flagged item, with the mark exposed as a
  `data-` attribute so the Node suite can assert which rendering it
  got. The mark is a real element with its space inside its own text
  (see "The views" in `example-realistic-demo/AGENTS.md`). The copy is
  reviewed by reading, not by test.

If the persisted session record holds `decrypted`, check whether its
shape change needs handling on restore; if it does not persist it, say
so in the PR.

Verification: the root typecheck, the `window.state=` grep against
`npm run build:realistic`, and the Phase 8 chat harness against
`npm run dev:realistic`.

**Blocked by:** core ticket 13
(`.scratch/audit-2026-09-core/issues/13-process-message-reports-sender.md`)

**Touches:** `example-realistic-demo/client/apply-entry.ts`,
`example-realistic-demo/client/state.ts` (`decrypted`),
`example-realistic-demo/client/timeline.ts` (`buildTimeline`,
`TimelineText`), `example-realistic-demo/client/membership.ts`,
`example-realistic-demo/client/views/room.ts`,
`example-realistic-demo/client/style.css` (the mark, using existing
variables), `test/example-realistic-demo/timeline.ts`,
`test/example-realistic-demo/apply-entry.ts`,
`test/example-realistic-demo/views.ts`

**Status:** done

- [x] `buildTimeline` credits a message to the authenticated identity
      when the entry's `sender` names another member, and that item
      carries the mismatch flag.
- [x] `buildTimeline` leaves the mismatch flag off when the entry's
      `sender` and the authenticated identity agree.
- [x] Applying an application entry from the member at leaf 2 records
      leaf 2's identity for that seq, even when the entry's `sender`
      names someone else.
- [x] The identity recorded for a seq does not change when the leaf
      that sent it is later removed and reused by another member.
- [x] The room view renders a flagged item with the mismatch `data-`
      attribute set and an unflagged item without it.

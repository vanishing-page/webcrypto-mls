# 02: Proposal refs and external PSK ids use own-property lookups

**What to build:** audit finding L5, spec story 24. This is also the
prefactor for the pending-proposal work in tickets 05 and 06. A
proposal reference or external PSK id that happens to spell an
`Object.prototype` member (`toString` and `propertyIsEnumerable` are
valid base64) is handled as an ordinary unknown id. Today the pending
set and the external PSK index are plain objects indexed by base64
string, so such an id finds an inherited function and processing
throws `TypeError: Cannot read properties of undefined`.

Use own-property lookups for both: either a `Map` or a null-prototype
record. The implementer picks, but must use the same choice for both.
A `Map` changes the exported `UnappliedProposals` type, and so the
`ClientState` shape. If you choose it, add a CHANGELOG entry and update
every read and write of `unappliedProposals`, including the
"any pending?" check that gates application messages and the bundling
in `createCommit`.

**Blocked by:** None (can start immediately)

**Touches:** `src/unapplied-proposals.ts` (`UnappliedProposals`,
`addUnappliedProposal`), `src/client-state.ts` (`applyProposals`
by-reference lookup, `makePskIndex`, the pending check before
application messages, `processProposal`), `src/create-commit.ts`
(`bundleAllProposals`), `src/create-message.ts` (`createProposal`),
`src/process-messages.ts` (the places that reset the pending set),
`test/scenario/external-psk.ts` or a new file under `test/validation/`,
`CHANGELOG.md` if the type changes

Note: tickets 03, 04, 05 and 06 all edit the pending-set code in
`client-state.ts` and `create-commit.ts`.

**Status:** done

- [x] A commit that references a proposal whose reference is `toString`
      (or another `Object.prototype` name) is rejected with
      `ValidationError`, the same way as any unknown reference, and no
      `TypeError` escapes.
- [x] A commit or Welcome naming an external PSK whose id is `toString`
      is treated as a missing PSK (`ValidationError`) when no such PSK
      was supplied, and no `TypeError` escapes.
- [x] Existing proposal-by-reference and external-PSK scenarios still
      pass unchanged.

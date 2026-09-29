# 13: `processMessage` reports the authenticated sender

**What to build:** audit finding M6, spec stories 13 and 14. The library
verifies each message's sender and then drops it: the
`applicationMessage` result carries only `message` and `newState`. So
every consumer, both demos included, attributes messages by transport
metadata instead of by what MLS authenticated. The demo spec's H5 fix
depends on this ticket.

After this ticket, both changes to `ProcessMessageResult` are
additive:
- the `applicationMessage` result also carries the sender (leaf index
  and sender type) and `authenticatedData`
- the result for a processed commit also carries the committer's
  sender (leaf index for a member commit, sender type
  `new_member_commit` for an external commit)

Document the new fields in the README and add a CHANGELOG entry. The
demos do not need to change in this ticket. The demo spec's tickets
consume the new fields.

**Blocked by:** None (can start immediately)

**Touches:** `src/process-messages.ts` (`ProcessMessageResult`, the
application-message branches for public and private messages, the
commit branch), `src/index.ts` if a new sender type is exported, a new
scenario under `test/scenario/` imported from `test/unit.ts`,
`README.md`, `CHANGELOG.md`

**Status:** done

- [x] In a three-member group, an application message from the member
      at leaf 2 yields a result whose sender is leaf 2, type `member`.
- [x] The result's `authenticatedData` equals the bytes the sender
      passed.
- [x] Processing a member's commit yields that member's leaf index as
      the committer.
- [x] Processing an external commit yields sender type
      `new_member_commit`, with the joiner's new leaf index where the
      library knows it.
- [x] Existing callers that read only `message` and `newState` compile
      and pass unchanged.

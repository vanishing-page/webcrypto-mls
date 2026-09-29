# 08: An expired room id stays dead

**What to build:** audit finding L13, spec story 13. `alarm()` deletes
everything, after which nothing distinguishes an expired room from one
that never existed, so `onCreate` accepts the same id again. Anyone who
knows an old id can create a room under it, and old invitation links
and saved sessions reconnect into that room.

The expiry alarm leaves a tombstone instead of an empty object: it
still closes every socket and deletes the group data (log, ledger,
pending requests, mailbox, meta), then records that this id expired,
with no group data of any kind. A pure rule in `room-logic.ts` decides
whether a create may proceed given the room's state (absent, live,
tombstoned), and `onCreate` applies it. A tombstoned id refuses
`create` and answers `hello` with `no-room`. `roomInfo` returns null
for it, so the GET route answers 404 and the client shows the gone
view it already renders.

The alarm is retried on failure, so running it twice must still leave
exactly one tombstone and no group data. Update the comments on
`roomInfo` and `alarm`, which say nothing distinguishes expired from
never-existed.

The alarm handler has no harness (see the test plan named in "Two
origins to run the pages on" in `example-realistic-demo/AGENTS.md`), so
the rule is proved in Node and the alarm is covered by adding a step
to `docs/test-plans/2026-07-28-realistic-demo.md` and a row in
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`
saying so.

**Blocked by:** None (can start immediately)

**Touches:** `example-realistic-demo/room-logic.ts` (the create rule),
`example-realistic-demo/index.ts` (`alarm`, `ensureSchema`,
`onCreate`, `onHello`, `roomInfo`),
`example-realistic-demo/AGENTS.md`,
`docs/test-plans/2026-07-28-realistic-demo.md`,
`docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`,
`test/example-realistic-demo/room-logic.ts`

**Status:** done

- [x] The create rule allows a create for an id with no room and no
      tombstone.
- [x] The create rule refuses a create for a live room.
- [x] The create rule refuses a create for a tombstoned id.
- [x] Creating a fresh room still succeeds end to end (probe check for
      create stays green).

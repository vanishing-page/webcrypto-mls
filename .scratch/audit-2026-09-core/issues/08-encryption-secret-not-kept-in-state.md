# 08: The epoch's encryption secret is not kept in state

**What to build:** part of audit finding H2, spec story 6.
`encryptionSecret` stays on the `KeySchedule` held by state for the
whole epoch. Nothing reads it except `createSecretTree`, and anyone who
has it can regenerate the whole secret tree, including every consumed
generation.

After this ticket, `encryptionSecret` is no longer a field of
`KeySchedule`. The key-schedule derivation hands it to the caller,
which passes it to `createSecretTree` and then zeroes it. Every call
site allocates it in the same call, so the wipe respects the ownership
rule. `KeySchedule` is exported, so the CHANGELOG records this as
breaking. The key-schedule vector test compares `encryptionSecret` at
the derivation seam instead of reading it from state.

`applicationExportSecret` and `exporterSecret` stay on `KeySchedule`.
That is out of scope for this spec.

**Blocked by:** None (can start immediately)

**Touches:** `src/key-schedule.ts` (`KeySchedule`, `initializeEpoch`
or the function that derives `encryptionSecret`),
`src/process-messages.ts` (the `createSecretTree` call on commit
receipt), `src/create-commit.ts` (`createCommit`, `joinGroupExternal`),
`src/client-state.ts` (`joinGroup`, `createGroup`),
`src/resumption.ts` if it builds a key schedule, `test/key-schedule.ts`,
`test/test-vectors/key-schedule.ts`, `CHANGELOG.md`

Note: ticket 01 reorders the commit receive and send paths in the same
functions. Expect a merge conflict if they run in parallel.

**Status:** done

- [x] After `createGroup`, `joinGroup`, `joinGroupExternal`,
      `createCommit` and processing a commit, no secret reachable from
      the resulting state regenerates the secret tree's root, as a
      compromise-simulating test observes.
- [x] The RFC key-schedule test vectors still pass, including the
      `encryption_secret` comparison, now made at the derivation seam.
- [x] Every group scenario (create, join, external join, commit,
      resumption) still exchanges application messages successfully.

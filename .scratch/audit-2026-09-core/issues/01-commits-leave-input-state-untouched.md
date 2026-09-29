# 01: Commit processing and creation leave the input state untouched

**What to build:** audit finding H1, spec stories 1 to 4. Processing or
creating a commit never alters the `ClientState` the caller passed in,
whether the operation succeeds or fails. Today `mergePrivateKeyPaths`
and `pruneBlankedNodes` `fill(0)` superseded HPKE path keys that belong
to the input state's `privatePath`, and on the receive path that
happens before `verifyConfirmationTag` runs. One commit with a bad
confirmation tag therefore zeroes a member's path keys, and the next
honest commit fails with an HPKE `OpenError`. The same wipe breaks the
"my commit lost, process the winner from my prior state" recovery and
any retry after `createCommit` throws.

The fix:
- Remove the `fill(0)` from both functions. Neither owns its inputs,
  so this applies the ownership rule in AGENTS.md, as the earlier
  audit's C1 did for the secret tree. Superseded keys go to the
  garbage collector untouched.
- Receive path: finish the whole derivation (`toPrivateKeyPath`, the
  commit secret, `initializeEpoch`, the confirmation tag check) before
  building the merged private path.
- Send path: build the merged path only after every step that can
  throw, including `createWelcome`.

An explicit "zeroize superseded keys" helper is out of scope.

Record correction belongs in this ticket. In `docs/security-audit.md`,
amend the "Confirmed correct" row ("Signature/MAC verification is
performed before state mutation") to say the confirmation tag was the
exception. Name `.scratch/audit-2026-09-core/spec.md` as the fix. Add a
CHANGELOG entry.

**Blocked by:** None (can start immediately)

**Touches:** `src/private-key-path.ts` (`mergePrivateKeyPaths`,
`pruneBlankedNodes`), `src/process-messages.ts` (the commit receive
path around `applyTreeUpdate` and `verifyConfirmationTag`),
`src/create-commit.ts` (`createCommit`, `createWelcome`),
`test/validation/prior-state-reuse.ts`, `docs/security-audit.md`,
`CHANGELOG.md`

Note: ticket 08 also edits the epoch-initialization code in
`process-messages.ts` and `create-commit.ts`. Expect a merge conflict
if they run in parallel.

Note for the retry test: do not make `createCommit` throw with a
pending Add whose `initKey` is malformed. Ticket 03 rejects that
proposal on receipt, and ticket 04 filters it at commit time, so the
test would stop exercising anything. Force the throw during Welcome
construction some other way, for example with a crypto provider
wrapper whose `importPublicKey` fails on demand.

**Status:** done

- [x] A member rejects a path commit whose confirmation tag was
      flipped (with a valid signature and a re-MACed membership tag)
      with `CryptoVerificationError`. It then processes an honest path
      commit from a different committer from the same retained state,
      and that succeeds.
- [x] The same holds when the bad-tag commit arrives as a
      PrivateMessage (re-encrypted).
- [x] The same holds when the bad-tag commit is an external commit
      (`new_member_commit`).
- [x] Two members commit concurrently. The loser processes the
      winner's commit from the state it held before calling
      `createCommit`, and later epochs still decrypt.
- [x] When `createCommit` throws after generating its UpdatePath, a
      retry of `createCommit` from the same input state succeeds, and
      every other member processes the resulting commit.
- [x] After a successful `createCommit` or `processMessage`, a second
      operation from the retained input state still succeeds (retry or
      fork resolution).
- [x] The existing secret-tree cases in
      `test/validation/prior-state-reuse.ts` still pass.

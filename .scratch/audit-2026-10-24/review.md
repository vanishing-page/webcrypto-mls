<!-- nightralph:review from=1f99330b0154f4c321f2af1157ad6cdfa07c3f3c to=1b970cfff1ace56bec2a1e51c8b19ea450f77e62 status=fixed -->
## 2026-10-24 14:43 -- review 1f99330..1b970cf -- 1 of 1 fixed
- [x] The dishonest-committer refusals have no in-suite control that the forgery itself is accepted, so a drift in `forgeAddCommit` would leave them passing without testing anything
    test/validation/leaf-key-dishonest-committer.ts:84-157 -- every refusal case asserts only `error instanceof ValidationError`, and the positive control (`honestCommitIsProcessed`, line 463, and the honest Welcome at line 135) goes through `createCommit`, not `forgeAddCommit`. If a later edit breaks the forge (a wrong `confirmedTranscriptHash` input, a stale tree hash, a wrong `initSecret`), Bob's `processMessage` and Carol's `joinGroup` still reject it with a `ValidationError` (confirmation tag or tree-hash mismatch), and all of these cases stay green with the leaf key check deleted. I checked by hand that the forge is consistent today: swapping in Mallory's honest key package (`forgeAddCommit(alice, [mallory.publicPackage], impl)`, and the same in the Welcome case) makes Bob accept the commit and Carol join. AGENTS.md treats that as a manual step ("Disable the check and rerun"). It should be an assertion: per suite, run one `forgeAddCommit` with an honest key package and require that it is processed and joined. Do the same for `withCommitLeafKey` with a freshly generated key.

### Fix
- attempts: 1 of 4
- effort: medium
- agent exit code: 0
- result: merged

# Review fix notes

## Finding: dishonest-committer refusals had no in-suite forgery control -- DONE

Implemented: a new first test per ciphersuite in
`test/validation/leaf-key-dishonest-committer.ts`, "the forged commit,
Welcome and UpdatePath are accepted when every key is usable". It runs
`forgeAddCommit(alice, [mallory, carol])` with honest key packages and
requires Bob to process the commit (epoch + 1) and Carol to join the
Welcome; then `withCommitLeafKey(impl, fresh)` with a freshly generated
HPKE key, requiring Alice to process Bob's path commit and that Bob's
leaf in her new tree carries exactly `fresh` (so the control also proves
the swap happened, not just that an unswapped commit is accepted).

Files: test/validation/leaf-key-dishonest-committer.ts, AGENTS.md
(replaced the "disable the check and rerun" advice with the in-suite
control rule).

Red evidence: with `forgeAddCommit` drifted (tree hash of the old tree),
the new control throws CryptoVerificationError. With the same drift, the
HEAD version of the file, and the src leaf-key check disabled, the
Welcome refusal cases still passed (joinGroup throws ValidationError for
the tree hash mismatch). The Add refusal under that drift surfaced as
CryptoVerificationError, so the reviewer's claim held for the Welcome
path, not literally every case. The fix covers both.

Not covered: the external-join GroupInfo case uses the library's
createGroupInfoWithExternalPubAndRatchetTree on a hand-edited state,
which the finding did not name; its honest control already goes through
the same function.

Gates: full matrix of the file 258/258, npm run typecheck clean, worker
tsc clean, eslint clean on the file, npm test 48818/48818.
`npm run check:style` reports only pre-existing issues (.scratch/ files,
WHOLE_FILE entries), none in changed lines.
---

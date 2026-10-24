<!-- nightralph:entry ticket=audit-2026-10-24:7 attempt=1 outcome=done -->
## 2026-10-24 13:43 -- audit-2026-10-24/07 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.74. Checked items: "`npm audit --omit=dev` reports 0 vulnerabilities.", "Every entry plain `npm audit` reports is named in `AGENTS.md` with the reason it stays, and nothing listed there is absent from the report.", "The lockfile diff shows no downgraded version and no change to any `@hpke/*` or `@noble/*` version.", "`npm ci` from the committed lockfile succeeds.", "`npm run test:checks`, `npm run typecheck`, the Worker typecheck, `npm run build`, `npm run check:package` and `npm test` pass on the updated tree.".

### Agent notes
# Ticket 07: npm audit baseline matches AGENTS.md

Test-first skipped for every item: this ticket is lockfile and docs only.
The seam is the lockfile plus the commands run against it (npm ci,
npm audit, npm audit --omit=dev, the lockfile diff), which were run
directly.

Done:
- `npm update vite` moved vite 7.3.6 -> 7.3.7 (in ^7 range). Only that
  entry changed in package-lock.json; package.json unchanged. No
  downgrade, no @hpke/@noble change.
- `npm update undici toml gray-matter` was a no-op.
- wrangler NOT updated: report does not mark it fixable in range. Latest
  wrangler 4.152.0 pins miniflare 5.20261019.2-beta, which pins undici
  7.29.1 exactly (below fixed 7.30.1). Installed miniflare also pins
  7.29.1 exactly, so the lockfile caret claim in the spec doesn't help.
- Plain npm audit after: toml, gray-matter, undici, miniflare, wrangler
  (5 entries). AGENTS.md Dependencies section rewritten to list those.
- Did not re-verify the `npm audit fix` remarkable-downgrade claim (would
  require running audit fix); kept the previous ticket's description.
- Gates all exit 0: test:checks, typecheck, worker tsc, build,
  check:package, lint, npm test (47808 pass), npm ci.
- check:style reports pre-existing issues in other files (WHOLE_FILE
  entries, the ticket file itself), none in AGENTS.md.

---
<!-- nightralph:entry ticket=audit-2026-10-24:6 attempt=1 outcome=done -->
## 2026-10-24 13:44 -- audit-2026-10-24/06 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.47. Checked items: "`npm run typecheck` and `npm test` pass.".

### Agent notes
# Ticket 06: invalid PSK proposal refused on arrival

## Implemented
- `src/client-state.ts`: `validateProposalOnReceipt` gains a `psk` arm.
  New `validatePskNonce` (nonce length must equal `cs.kdf.size`), then
  the existing `validatePskProposals([id], state.groupContext)` for the
  branch/reinit-usage-after-epoch-0 rule. No PSK index lookup.
- `createProposal` and `filterPendingProposals` unchanged; they inherit.
- New suite `test/validation/psk-proposal-on-receipt.ts`, registered in
  `test/matrix.ts`, loops `sampleCiphersuites()`. Alice+Bob at epoch 1;
  Bob signs with `protectProposalPublic`; Alice runs `processMessage`
  with the default callback (`undefined`).
- AGENTS.md: one sentence on the PSK arm beside the receipt-check text.

## Verification
- Ran the new suite against the pre-fix `src/client-state.ts`: every
  case fails except the well-formed-external-PSK positive control
  (expected). The stored-invalid case throws the audit's
  "pskNonce length does not match KDF.Nh" from createCommit pre-fix.
- `npm run typecheck` exit 0, Worker tsc exit 0, eslint clean,
  `npm test` 47908/47908 pass.

## Readings / notes
- "pending set of the state she passed in is still empty" is read
  literally: `listPendingProposals(f.alice)` after the refusal, and the
  commit/send are done from that same input state.
- Items 2 and 3 were committed together (one edit to the test file).
  Item 2 (short nonce) was green on first run because item 1's nonce
  check covers any wrong length; item 3 was red before the epoch rule.
- `check:style` reports pre-existing hits only (WHOLE_FILE list entries
  unchanged against main, a `.scratch` ticket line); none in my files.

---
<!-- nightralph:entry ticket=audit-2026-10-24:1 attempt=1 outcome=done -->
## 2026-10-24 13:44 -- audit-2026-10-24/01 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.23. Checked items: "Each listed X448 low-order value, and its non-canonical encoding plus p where it fits in 56 bytes, answers true.".

### Agent notes
# Ticket 01: low-order X25519 and X448 key check

## Implemented
- `src/crypto/small-order.ts`: `isLowOrderX25519`, `isLowOrderX448`,
  `isLowOrderKemPublicKey(alg:KemAlgorithm, key)`. KemAlgorithm comes from
  `src/crypto/kem.ts` (the type `CiphersuiteImpl.hpke` names).
- `test/crypto/small-order-kem.ts`, registered in `test/unit.ts`.
- Root AGENTS.md: paragraph next to the EdDSA small-order rule.

## Reading of the acceptance criteria
- "plus p where it fits": for X25519 only u=0 and u=1 have a u+p below
  2^255; p-1 and both order-8 values overflow, so their only alternate
  form is the top-bit-set encoding. Same for X448: 0+p and 1+p fit in
  56 bytes, (p-1)+p does not.
- Test values are hand-written little-endian hex literals (the order-8
  values from the well-known libsodium blocklist), not derived via the
  helper's decoding, so the tests are not tautological.
- Dispatcher test keys a `Record<KemAlgorithm, ...>` so a new KEM fails
  typecheck in the test until classified.

## TDD notes
- The "+p" test, the "fresh key" test and the "wrong length" test went
  green on first run: mod-p reduction and the length guard were part of
  the minimal implementation that made the first test of each curve pass.
  I mutation-checked the length guards (removed them -> 6 failures).
- No library behavior changed; nothing calls the dispatcher yet (ticket 02).

## Gotchas
- /tmp is shared with other sessions: a helper script I wrote to /tmp was
  overwritten mid-run. Run commands inline or keep scripts in the worktree.
- `npm run check:style` reports pre-existing failures in unrelated files
  (WHOLE_FILE entries, a .scratch ticket); none in files this ticket
  touched.

## Verification
- npm run typecheck: exit 0. eslint on changed files: clean.
- npm run test:unit and full npm test: all pass (47935).

---
<!-- nightralph:entry ticket=audit-2026-10-24:4 attempt=1 outcome=done -->
## 2026-10-24 13:50 -- audit-2026-10-24/04 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.30. Checked items: "`npm run typecheck` and `npm test` pass.".

### Agent notes
# Ticket 04: joinGroupFromBranch requires a branch PSK

## Implemented
- `src/client-state.ts`: `joinGroup` takes a 9th optional arg
  `expectedResumption?:ExpectedResumption` (`'branch' | 'reinit'`,
  exported type, also from `src/index.ts`). Missing prior state with an
  expectation -> `UsageError` (checked first, before any decrypt). After
  PSK accumulation: prior-state resumption PSKs must number exactly one
  and match the expected usage, else `ValidationError`. All before the
  init key wipe.
- `src/resumption.ts`: `joinGroupFromBranch` passes `'branch'`.
- Tests in `test/validation/branch-welcome.ts` (already in unit.ts).
- AGENTS.md: note on `expectedResumption` and building Welcomes with a
  chosen PSK list.

## Decisions
- Kept the old in-loop "branch carries exactly one resumption PSK"
  check: it still guards direct `joinGroup` callers that pass a prior
  state with no expectation. With an expectation it is unreachable
  (subsumed by the count check).
- Red verified against pre-fix src: unrelated Welcome and
  application-only PSK cases failed; ReInit-usage and branch+reinit
  two-PSK cases were already refused by the old reinit check (pins).
- Forged Welcomes are built by committing PSK proposals into a fresh
  group with `makePskIndex(aliceGroup, {})`, no re-encryption needed.

## For ticket 05
- `joinGroupFromReinit` still passes no expectation; add `'reinit'`
  and the README sentence.

---
<!-- nightralph:entry ticket=audit-2026-10-24:5 attempt=1 outcome=done -->
## 2026-10-24 14:09 -- audit-2026-10-24/05 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.29. Checked items: "The audit repro: after a ReInit of Alice and Bob's group, `joinGroupFromReinit` against Bob's suspended state and an ordinary Welcome to an unrelated group rejects with `ValidationError`.", "A Welcome whose only prior-state resumption PSK has branch usage is refused by `joinGroupFromReinit` with `ValidationError`.", "A Welcome carrying only an application-usage resumption PSK, and one carrying two prior-state resumption PSKs, are each refused with `ValidationError`.", "After each refusal the init private key passed in is still non-zero, and the honest ReInit Welcome then joins with the same key material.", "The honest ReInit still succeeds under every test ciphersuite.", "`npm run typecheck` and `npm test` pass, and `npm run test:checks` passes after the README edit.".

### Agent notes
# Ticket 05: joinGroupFromReinit requires a ReInit PSK

## Implemented
- `src/resumption.ts`: `joinGroupFromReinit` passes `'reinit'` as
  `joinGroup`'s `expectedResumption` (ticket 04's argument). Signature
  unchanged.
- `test/validation/resumption-validation.ts` (already in matrix.ts,
  loops over `testCiphersuites()`): new test per suite. One ReInit setup
  per suite, then for each forged Welcome (unrelated group, branch-only
  PSK, application-only PSK, reinit+branch, reinit+reinit) a fresh
  aliceNew/bobNew pair: the forged Welcome is refused with
  ValidationError, bob's init key is still non-zero, and the honest
  `reinitCreateNewGroup` Welcome for the same bobNew then joins
  (groupId == new-group1). The honest join also covers "honest ReInit
  succeeds under every suite".
- README: one sentence under the `resumptionPsk` key schedule bullet.
  No new heading, so no `npm run toc`. README edit: docs-only, no test.

## Red evidence (pre-fix)
- Unrelated Welcome and application-only PSK: joined (red).
- Branch-only PSK: already refused pre-fix by the branch membership
  check (new KeyPackages have fresh signature keys) -- a pin.
- reinit+branch: already refused by the old in-loop branch count check.
- reinit+reinit: not separately observed pre-fix (earlier case crashed
  the run); with the old code both PSKs pass the reinit checks, so it
  would have joined.

## Verification
- `npm run typecheck` 0, `npm run test:checks` 0, `npm run lint` 0,
  `npm test` 48334/48334 pass.
- No AGENTS.md change: root AGENTS.md already documents
  `expectedResumption` for both wrappers.

---
<!-- nightralph:entry ticket=audit-2026-10-24:2 attempt=1 outcome=done -->
## 2026-10-24 14:11 -- audit-2026-10-24/02 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.82. Checked items: "Alice's `createCommit` carrying by value an Add of a key package re-signed with a one-byte leaf encryption key rejects with `ValidationError`.", "The same Add, signed as a proposal from a peer with `protectProposalPublic`, is refused by `processMessage` with `ValidationError`, and the pending set of the state passed in is unchanged.", "Under an X25519 suite, a key package whose leaf key is `u = 0`, and one whose leaf key is the same point with the top bit set, are both refused on Add with `ValidationError`; under an X448 suite, `u = 0` is refused the same way.", "An Update proposal whose new leaf key is low-order is refused on receipt with `ValidationError`.", "A key package whose init key is low-order is refused with `ValidationError`.", "After each refusal, an honest Add of a normal key package from the same state succeeds, and the next path commit from every member succeeds.", "The suite loops over `testCiphersuites()` and skips a suite whose KEM is not installed through `skipReason`; no case under any suite surfaces a `CryptoError`.", "`npm run typecheck`, the Worker typecheck and `npm test` pass.".

### Agent notes
# Ticket 02: leaf encryption key refused at committer and on receipt

## Implemented
- `src/client-state.ts`: new `validateHpkePublicKey(key, groupContext,
  hpke, what)` -- `isLowOrderKemPublicKey` keyed on the group context's
  KEM, then `hpke.importPublicKey`, any throw -> ValidationError.
  `validateLeafNodeCommon` calls it first for `leafNode.hpkePublicKey`;
  `validateKeyPackage` uses it for the init key (replacing the bare
  import try/catch, adding the low-order check).
- `hpke:Hpke` param added after `s` to `validateLeafNodeCommon`,
  `validateLeafNodeKeyPackage`, `validateLeafNodeUpdateOrCommit` (before
  the optional `priorCredential`). Callers wired: validateRatchetTree
  (both arms; covers join and joinGroupExternal, which pass `cs`
  already, so create-commit.ts needed no edit), Update loop in
  applyTreeMutations, Update receipt, commit path leaf in
  process-messages.ts (covers external commit leaf). Add receipt and
  by-value Add reach it via validateKeyPackage.
- Two existing tests call validateLeafNodeUpdateOrCommit directly
  (credential-capability-floor, credential-continuity): pass impl.hpke.
- New suite `test/validation/leaf-encryption-key.ts`, registered in
  `test/matrix.ts`, loops over testCiphersuites(). Bad keys per suite:
  a one-byte key (fails import under every KEM) plus X25519 u=0 and
  u=0-with-top-bit, or X448 u=0. Four tests: by-value Add at committer,
  Add proposal on receipt (protectProposalPublic, pending set stays
  empty), Update on receipt, init key on Add. Each ends with the
  positive control: honest Add of carol, then an empty (path) commit
  from each of the three members processed by the other two.
- AGENTS.md: paragraph after the KEM low-order note.

## Reading of criteria
- "no case under any suite surfaces a CryptoError": rejects() requires
  instanceof ValidationError, and skip detection only wraps suite
  setup (`implOrSkip`), so a provider error in a case is a failure,
  not a skip.
- All checklist items share one implementation, so they landed in one
  commit rather than one per item.

## Verification
- Red first: 20 failures on MLS_SUITES=fast before the fix.
- Mutation: disabling the low-order branch fails 8 cases (incl. the
  low-order init key, which otherwise throws a non-ValidationError).
- Full matrix for the new file: 226/226 pass, no skips locally.

---
<!-- nightralph:entry ticket=audit-2026-10-24:3 attempt=1 outcome=done -->
## 2026-10-24 14:28 -- audit-2026-10-24/03 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.96. Checked items: "Bob's `processMessage` of a commit whose Add carries a key package with a one-byte leaf encryption key rejects with `ValidationError`.", "Bob's `processMessage` of a commit whose UpdatePath leaf carries a low-order (X25519/X448 suites) or non-importing encryption key rejects with `ValidationError`.", "`joinGroup` of a Welcome whose ratchet tree carries the bad leaf rejects with `ValidationError`, and the init private key passed in is still non-zero.", "`joinGroupExternal` against a GroupInfo whose tree carries the bad leaf rejects with `ValidationError`.", "The same cases with a low-order key: `u = 0` and its top-bit-set encoding under an X25519 suite, `u = 0` under an X448 suite.", "After each refusal, the receiver's state still processes an honest commit from the same epoch.", "The suite loops over `testCiphersuites()` with `skipReason` skips; no case surfaces a `CryptoError`.", "`npm run typecheck` and `npm test` pass.".

### Agent notes
# Ticket 03: leaf key refused from a dishonest committer

## Implemented
- New suite `test/validation/leaf-key-dishonest-committer.ts`, registered
  in `test/matrix.ts`, loops over testCiphersuites() with skipReason
  skips (setup only, as in leaf-encryption-key.ts). Bad keys per suite:
  one-byte key, plus X25519 u=0 and u=0 with the top bit set, or X448 u=0.
- Four tests:
  1. forged Add-only commit (`forgeAddCommit`) -> bob processMessage
     refuses; then honest Add from alice + path commit back from bob.
  2. UpdatePath leaf: bob's createCommit run through `withCommitLeafKey`
     (wrapped impl: records rng outputs of kdf.size, and exportPublicKey
     swaps the key derived as "node" from one of them for the bad key),
     public wire -> alice refuses; then honest commits both ways.
  3. forged Welcome adding mallory(bad) + carol -> carol joinGroup refuses,
     initPrivateKey copy still non-zero; same carol KP joins honest Welcome.
  4. GroupInfo signed by alice over her tree + bad leaf (treeHash
     recomputed) -> joinGroupExternal refuses; same dave KP joins against
     the honest GroupInfo and alice processes the external commit.
- AGENTS.md: paragraph on the forging shapes, after the HPKE key note.
- No src/ change: ticket 02's wiring covers every path.

## Verification
- Mutation: `validateHpkePublicKey` made to return undefined -> 30/46
  fail on MLS_SUITES=fast (forgeries accepted; GroupInfo case surfaces a
  non-ValidationError provider error). Restored.
- Full matrix for the file: 201/201, no skips. npm test: 48761 pass.
  typecheck, Worker typecheck, lint clean. check:style flags only
  pre-existing .scratch/ files.

## Reading of criteria
- All checklist items share one suite and need no src change, so one
  commit.
- "receiver still processes an honest commit from the same epoch": for
  join paths the "receiver" is the joiner; shown by the same key package
  joining the honest Welcome / GroupInfo.

---

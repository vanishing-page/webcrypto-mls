# 03: Unusable leaf encryption key refused from a dishonest committer

**What to build:** spec story 9 for the paths a fixed `createCommit`
cannot reach (F3). A dishonest committer can still push a bad leaf
into a receiver's tree by building the commit or Welcome by hand. Each
path a leaf arrives by from someone else's commit must refuse it as a
`ValidationError`: a commit whose Add carries the bad leaf, a commit
whose UpdatePath leaf carries a bad encryption key, a Welcome whose
tree carries it, and the GroupInfo tree an external join commits
against.

Ticket 02 wires the check into every caller. This ticket builds the
forged inputs that prove it, and fixes any caller ticket 02 missed if
a forged input slips through or surfaces a provider error. Build the
commit by constructing the tree and signing directly at the shape the
unfixed revision produced, or by editing the Welcome's GroupInfo tree
and re-encrypting (the decrypt-edit-re-encrypt shape). Pass
`initPrivateKey` copies with `.slice()` wherever a key is reused,
since `joinGroup` zeroizes in place.

**Blocked by:** 02

**Touches:** a new scenario suite under `test/validation/` registered
in `test/matrix.ts`; `src/client-state.ts`, `src/process-messages.ts`
or `src/create-commit.ts` only if a caller turns out to be missed.
Prior art: `test/validation/welcome-path-secret-required.ts`
(decrypt-edit-re-encrypt), `test/validation/ratchet-tree-validation.ts`
(a bad tree in a Welcome), `test/validation/small-order-signature-key.ts`
(a forged commit leaf), `docs/audit-repros/2026-10-24.mjs` (the
audit's forging steps).

**Status:** done

- [x] Bob's `processMessage` of a commit whose Add carries a key
      package with a one-byte leaf encryption key rejects with
      `ValidationError`.
- [x] Bob's `processMessage` of a commit whose UpdatePath leaf carries
      a low-order (X25519/X448 suites) or non-importing encryption key
      rejects with `ValidationError`.
- [x] `joinGroup` of a Welcome whose ratchet tree carries the bad leaf
      rejects with `ValidationError`, and the init private key passed
      in is still non-zero.
- [x] `joinGroupExternal` against a GroupInfo whose tree carries the
      bad leaf rejects with `ValidationError`.
- [x] The same cases with a low-order key: `u = 0` and its top-bit-set
      encoding under an X25519 suite, `u = 0` under an X448 suite.
- [x] After each refusal, the receiver's state still processes an
      honest commit from the same epoch.
- [x] The suite loops over `testCiphersuites()` with `skipReason`
      skips; no case surfaces a `CryptoError`.
- [x] `npm run typecheck` and `npm test` pass.

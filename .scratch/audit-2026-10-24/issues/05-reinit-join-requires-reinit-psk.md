# 05: `joinGroupFromReinit` refuses a Welcome without a ReInit PSK

**What to build:** spec stories 2 and 3 (F1, ReInit half). After a
ReInit, `joinGroupFromReinit` accepts an unrelated Welcome as the
successor, so the agreed group id, version, ciphersuite and extensions
are never compared against the group joined. With ticket 04's
expectation argument in place, `joinGroupFromReinit` always passes
`'reinit'` and keeps its signature, so the Welcome must carry exactly
one ReInit-usage resumption PSK and the existing ReInit parameter
comparison then runs against it.

The README gains one sentence, where it describes resumption (the
Reinit proposal bullet and the `resumptionPsk` key schedule entry are
the only places today), stating that the two join wrappers refuse a
Welcome without the matching resumption PSK. If that sentence lands
under a new heading, run `npm run toc`.

**Blocked by:** 04

**Touches:** `src/resumption.ts` (`joinGroupFromReinit`), `README.md`
(one sentence), `test/validation/resumption-validation.ts` (extend;
registered in `test/matrix.ts`, loops over `testCiphersuites()`).
Prior art: `test/scenario/reinit.ts` for the ReInit setup.

**Status:** done

- [x] The audit repro: after a ReInit of Alice and Bob's group,
      `joinGroupFromReinit` against Bob's suspended state and an
      ordinary Welcome to an unrelated group rejects with
      `ValidationError`.
- [x] A Welcome whose only prior-state resumption PSK has branch usage
      is refused by `joinGroupFromReinit` with `ValidationError`.
- [x] A Welcome carrying only an application-usage resumption PSK, and
      one carrying two prior-state resumption PSKs, are each refused
      with `ValidationError`.
- [x] After each refusal the init private key passed in is still
      non-zero, and the honest ReInit Welcome then joins with the same
      key material.
- [x] The honest ReInit still succeeds under every test ciphersuite.
- [x] `npm run typecheck` and `npm test` pass, and
      `npm run test:checks` passes after the README edit.

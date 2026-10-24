# 04: `joinGroupFromBranch` refuses a Welcome without a branch PSK

**What to build:** spec stories 1, 3 and 4 (F1, branch half). Today
`joinGroupFromBranch` hands its prior state to `joinGroup`, whose
continuity checks run only over the resumption PSKs the Welcome
carries, so an ordinary invitation to an unrelated group is accepted as
the branch and the init private key is consumed.

`joinGroup` gains an optional expected-resumption argument typed
`'branch' | 'reinit'` (narrower than the resumption usage name;
`'application'` is not an expectation), added so every existing call
compiles and behaves as today. With an expectation set: a missing
prior state is a `UsageError`; the resumption PSKs that require prior
state (type resumption, usage other than application) must number
exactly one and its usage must equal the expectation, or the Welcome
is refused with `ValidationError`. External PSKs and application-usage
resumption PSKs may still accompany it. The existing per-PSK
continuity checks run unchanged for the PSK that satisfied the
expectation, and the existing "a branch carries exactly one resumption
PSK" rule is subsumed by the count check. Every new check runs before
the init private key is wiped. `joinGroupFromBranch` always passes
`'branch'` and keeps its signature.

Ticket 05 wires the ReInit wrapper and adds the README sentence.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`joinGroup`, the
`resumptionPsksRequiringPriorState` checks),
`src/resumption.ts` (`joinGroupFromBranch`),
`test/validation/branch-welcome.ts` (extend; registered in
`test/unit.ts`, runs under the default suite). Prior art: the
`rejects` helper and `sameSignerKeyPackage` in that suite,
`test/validation/welcome-path-secret-required.ts` for editing a
Welcome's PSK list.

Note: tickets 02 and 06 also edit `src/client-state.ts`, so expect a
small merge if they run in parallel.

**Status:** done

- [x] The audit repro: Alice and Bob form a group, Alice forms an
      unrelated group and issues an ordinary Welcome to a fresh Bob
      key package; `joinGroupFromBranch` against Bob's state and that
      Welcome rejects with `ValidationError`.
- [x] A Welcome whose only prior-state resumption PSK has ReInit usage
      is refused by `joinGroupFromBranch` with `ValidationError`.
- [x] A Welcome carrying only an application-usage resumption PSK is
      refused with `ValidationError`.
- [x] A Welcome carrying two resumption PSKs that require prior state
      is refused with `ValidationError`.
- [x] After each refusal the init private key passed in is still
      non-zero, and the honest branch Welcome then joins with the same
      key material.
- [x] `joinGroup` with an expectation set and no prior state throws
      `UsageError`.
- [x] An ordinary `joinGroup` of the unrelated Welcome, with no
      expectation, still succeeds and returns a state in that group.
- [x] `npm run typecheck` and `npm test` pass.

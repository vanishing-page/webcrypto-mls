# 11: A branch Welcome must match the resuming group

**What to build:** audit finding M3, spec story 17. For
`usage === 'branch'`, `joinGroup` checks only the epoch, the old group
id, and that the new epoch is 1. Version, ciphersuite and extensions
are compared only for `reinit`, and nothing checks the membership.
`joinGroupFromBranch` therefore accepts a subgroup under a different
ciphersuite whose members include a stranger.

After this ticket, RFC 9420 section 11.3 holds for a branch Welcome:
- its version and ciphersuite equal the resuming state's
- every leaf in the new group matches a leaf of the old group. "The
  same member" is defined by the configured `keyPackageEqualityConfig`,
  falling back to signature-key equality when none is configured
- it carries exactly one resumption PSK

A failure is a `ValidationError`.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`joinGroup`, the resumption PSK
checks), `src/resumption.ts` (`joinGroupFromBranch`, `branchGroup`),
`src/key-package-equality-config.ts`, `test/scenario/resumption.ts`,
`test/validation/resumption-validation.ts`, `README.md` if it documents
branching

**Status:** done

- [x] A branch Welcome whose ciphersuite differs from the resuming
      group's is rejected with `ValidationError`.
- [x] A branch Welcome whose protocol version differs is rejected with
      `ValidationError`.
- [x] A branch Welcome whose new group contains a member with no match
      in the old group is rejected with `ValidationError`.
- [x] A branch Welcome carrying two resumption PSKs is rejected with
      `ValidationError`.
- [x] An honest branch of a subset of the old members is still accepted
      and exchanges messages, both with the default equality config and
      with a custom one.

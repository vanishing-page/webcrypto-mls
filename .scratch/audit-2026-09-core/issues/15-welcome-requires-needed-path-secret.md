# 15: A Welcome missing a needed `path_secret` is rejected

**What to build:** audit finding L2, spec story 21. A joiner that needs
a `path_secret` gets none, joins holding only its leaf key, and then
cannot follow the first later path commit. The joiner needs one when
its common ancestor with the signer is non-blank and does not list the
joiner in `unmerged_leaves`. Today `joinGroup` accepts such a Welcome.

After this ticket:
- `joinGroup` rejects that Welcome with `ValidationError`.
- The "No overlap between provided private keys and update path"
  failure in `applyUpdatePathSecret` is currently an `InternalError`
  that a peer can reach. It becomes a `ValidationError`.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`joinGroup`, the path-secret
handling around `deriveWelcomePrivateKeyPath`),
`src/private-key-path.ts` (`deriveWelcomePrivateKeyPath`),
`src/update-path.ts` (`firstCommonAncestor`), `src/create-commit.ts`
(`applyUpdatePathSecret`), `test/validation/welcome-path-derivation.ts`,
`test/validation/unmerged-leaves-validation.ts`

**Status:** done

- [x] A Welcome produced by a path commit, with the joiner's
      `path_secret` stripped and re-encrypted, is rejected by
      `joinGroup` with `ValidationError`.
- [x] A Welcome produced by an Add-only commit (so that the common
      ancestor lists the joiner as unmerged, or is blank) still joins
      without a `path_secret`, and the joiner follows the next path
      commit.
- [x] An honest path-commit Welcome still joins, and the joiner follows
      the next path commit.
- [x] The input that previously reached "No overlap between provided
      private keys and update path" now rejects with `ValidationError`.

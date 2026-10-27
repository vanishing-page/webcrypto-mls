# 05: Separate KeyPackage and leaf node extensions

**What to build:** spec story 6. An application gives
`generateKeyPackage` the KeyPackage's extensions and the leaf node's
extensions as separate lists. A KeyPackage-only extension such as
`last_resort` stays in the KeyPackage and never reaches the ratchet
tree, so it no longer has to be listed in the leaf's capabilities.

The existing `extensions` argument keeps meaning the KeyPackage
extensions. The leaf list comes through `GenerateKeyPackageOptions`
(for example `leafExtensions`) and defaults to empty. This package has
no named type for `last_resort`, so the test uses a custom KeyPackage
extension type standing in for it. Check every caller of
`generateKeyPackage` in `src/`, `test/`, `example/`,
`example-shared/` and `example-realistic-demo/` for one that relies on
its extensions reaching the leaf, and move those to the new option.
Read upstream `ae4a991` for intent only.

This changes behavior for any caller whose extensions reached the
leaf. The changelog is generated from commit messages, so the commit
message carries a `BREAKING CHANGE:` line saying so; do not edit
`CHANGELOG.md` by hand.

**Blocked by:** None (can start immediately)

**Touches:** `src/key-package.ts` (`generateKeyPackage`,
`GenerateKeyPackageOptions`), callers found by the search above, a
scenario suite registered in `test/matrix.ts`. Prior art:
`test/scenario/custom-extensions.ts`, `test/key-package.ts`.

**Status:** done

- [x] A KeyPackage carrying a KeyPackage-only extension, whose leaf
      capabilities do not list that extension type, is added to a
      group, and the new member joins from the Welcome.
- [x] In every member's state after that join, the new member's leaf
      carries exactly the leaf extensions passed through the option
      and not the KeyPackage extension.
- [x] With no leaf extensions passed, the new member's leaf has no
      extensions.
- [x] A leaf extension whose type the leaf's capabilities do not list
      is still refused with `ValidationError`.
- [x] The commit message contains a `BREAKING CHANGE:` line describing
      the change.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

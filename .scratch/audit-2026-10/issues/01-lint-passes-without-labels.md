# 01: Lint passes without labels

**What to build:** spec story 17, the `no-labels` lint failure.
`npm run lint` fails on two `no-labels` errors in the substring search
helper in the CEK-wipe test (a labeled `outer` loop with
`continue outer`). CI's `build` job runs lint, so the branch does not
pass its own gate. Rewrite the helper without a label -- an inner
helper that returns a boolean, or an `every` over the needle, keeps the
same behavior. The eslint configuration is not changed.

**Blocked by:** None (can start immediately)

**Touches:** `test/attachment/cek-wipe.ts` (the substring search helper
only)

**Status:** done

- [x] `npm run lint` exits 0.
- [x] The CEK-wipe suite still passes, including the two-latch
      regression, so the rewritten helper still finds and still misses
      the same byte runs it did before.
- [x] No eslint configuration file or inline `eslint-disable` comment
      is added or changed.

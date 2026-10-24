# 07: The `npm audit` baseline matches `AGENTS.md`

**What to build:** spec story 10, the dependency observation. Plain
`npm audit` reports six entries: `gray-matter` and `toml` (the
`markdown-toc` chain), `vite` (fixable in range), and `undici`,
`miniflare` and `wrangler` (GHSA-xjj6-f33q-929c, `undici` below
7.30.1). The Dependencies section of the root `AGENTS.md` documents an
older six-entry list, so the written baseline and the report disagree.

Clear the fixable advisories with `npm update <name>` for each package
the report marks fixable in range. Do not run `npm audit fix`, do not
pass `--force`, do not downgrade `wrangler` (the fix `npm audit fix`
offers is a downgrade to 4.35.0), and do not hand-edit the lockfile.
The lockfile's `undici` range already admits 7.30.1, but the latest
`miniflare` pins below it, so it may remain. Diff the lockfile: nothing
moves backwards and no `@hpke/*` or `@noble/*` version changes. Then
rewrite the Dependencies section to list what plain `npm audit` still
reports, with the reason each stays. Keep the `markdown-toc`
explanation, and if `undici` remains, say why and name 7.30.1 as the
fixed version to check for. Commit `package-lock.json` with
`package.json` if it changed.

Out of scope: `npm audit fix`, `--force`, replacing `markdown-toc`,
upgrading `vite` across a major.

**Blocked by:** None (can start immediately)

**Touches:** `package.json`, `package-lock.json`, `AGENTS.md`
(Dependencies section). Prior art: `.scratch/audit-2026-10/issues/12-npm-audit-baseline-matches-agents.md`.

**Status:** done

- [x] `npm audit --omit=dev` reports 0 vulnerabilities.
- [x] Every entry plain `npm audit` reports is named in `AGENTS.md`
      with the reason it stays, and nothing listed there is absent
      from the report.
- [x] The lockfile diff shows no downgraded version and no change to
      any `@hpke/*` or `@noble/*` version.
- [x] `npm ci` from the committed lockfile succeeds.
- [x] `npm run test:checks`, `npm run typecheck`, the Worker
      typecheck, `npm run build`, `npm run check:package` and
      `npm test` pass on the updated tree.

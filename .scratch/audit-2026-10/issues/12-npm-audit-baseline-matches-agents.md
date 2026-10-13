# 12: The `npm audit` baseline matches `AGENTS.md`

**What to build:** the dependency audit observation, spec story 23.
`npm audit` now reports fifteen tooling entries, while the
Dependencies section of the root `AGENTS.md` documents one known,
accepted finding (`toml`, through `markdown-toc` and `gray-matter`).
The documented baseline no longer matches the tree.

Run `npm audit fix` without `--force`. Then confirm `npm ci`, the
build, both typecheck invocations and the test suites still pass. The
runtime set (`@hpke/*`, `@noble/*`) is not upgraded by this, and
`npm audit --omit=dev` must still report zero. Whatever plain
`npm audit` still reports afterwards is listed in `AGENTS.md` with the
reason each one stays, replacing the current single-entry description.
Commit `package-lock.json` with `package.json`.

Out of scope: `npm audit fix --force` and replacing `markdown-toc`.

**Blocked by:** None (can start immediately)

**Touches:** `package.json`, `package-lock.json`, `AGENTS.md`
(Dependencies section)

Note: ticket 10 also edits `package.json`, so expect a small conflict
if they run in parallel.

**Status:** done

- [x] `npm audit --omit=dev` reports 0 vulnerabilities.
- [x] Every finding plain `npm audit` reports is named in `AGENTS.md`
      with the reason it stays, and nothing listed there is absent
      from the report.
- [x] No `@hpke/*` or `@noble/*` version changes in
      `package-lock.json`.
- [x] `npm ci` from the committed lockfile succeeds.
- [x] `npm run build`, `npm run typecheck`,
      `npx tsc -p example-realistic-demo/tsconfig.json --noEmit`,
      `npm run lint` (once ticket 01 has landed) and `npm test` pass.

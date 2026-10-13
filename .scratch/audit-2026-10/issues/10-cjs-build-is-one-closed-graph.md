# 10: The CommonJS build is one closed graph, checked as a consumer

**What to build:** audit finding F5, spec stories 18, 19, 21 and 22.
The CommonJS build renames its outputs to `.cjs` but leaves the
specifiers inside them pointing at `.js`, so a `require` of the root
loads its internal modules from the ESM build. Requiring a documented
subpath such as `mls-error` then yields a second, separately evaluated
copy, and a real library exception fails `instanceof` against the
subpath's class. The minified CommonJS build has the same shape.

Fix: the CommonJS build rewrites every relative module specifier in
its output to the CommonJS file it belongs with -- `.cjs` for the
regular build, `.min.cjs` for the minified one. Bundling each entry
instead is rejected: it duplicates shared modules per entry, which is
the same class-identity bug in another form.

Add a package consumer check, the seam for this area. It places the
built package in a scratch consumer under its real package name
(linked, so dependencies resolve without a network install), and
cleans the scratch consumer up whether it passes or fails. It:

- requires the root and several subpaths -- at least `mls-error`, a
  nested attachment subpath and a nested crypto subpath -- triggers a
  real library error through a public call (the audit's case: a
  fail-closed authentication service rejection, checked against
  `UsageError`), and checks it is `instanceof` the class from every
  entry point that exports it;
- does the same from ESM;
- checks that no `.cjs` file in `dist/` requires a relative `.js`
  path.

It is a plain `.mjs` script under `scripts/` with a nonzero exit on
failure, like the existing gates. It has its own npm script and runs
in CI's `build` job after `npm run build`, because that job has
`dist/`. It is not added to `test:checks`, which runs without a build.
Add a sentence to the gates paragraph of the root `AGENTS.md` saying
where it runs and why, the way it does for `check:style`. CI runs
Node 22, and the check must pass there. Ticket 11 adds the TypeScript
consumers to this script.

**Blocked by:** None (can start immediately)

**Touches:** `package.json` (`build-cjs`, `build-cjs:min`, `build`, a
new script entry), a new `scripts/` file for the specifier rewrite if
esbuild flags cannot do it, a new `scripts/check-package-consumer.mjs`
(or similar), `.github/workflows/nodejs.yml` (`build` job),
`AGENTS.md` (gates paragraph)

Note: ticket 12 also edits `package.json` and `package-lock.json`, so
expect a small conflict if they run in parallel.

**Status:** done

- [x] From CommonJS, the error thrown by a fail-closed authentication
      service is `instanceof` `UsageError` required from the root and
      from the `mls-error` subpath.
- [x] From CommonJS, requiring the root and then a nested attachment
      subpath and a nested crypto subpath succeeds, and any class
      exported by more than one of them is the same object from each.
- [x] The same identity checks pass from ESM.
- [x] No `.cjs` or `.min.cjs` file in `dist/` requires a relative
      `.js` path.
- [x] The check fails (nonzero exit) against a build with the old
      `build-cjs` script, demonstrated once and noted in the ticket
      comments.
- [x] The scratch consumer is removed after both a passing and a
      failing run.
- [x] CI's `build` job runs the check after the build.
- [x] `npm run build`, `npm run typecheck` and `npm run test:checks`
      are clean.

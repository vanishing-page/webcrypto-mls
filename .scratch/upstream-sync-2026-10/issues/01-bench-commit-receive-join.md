# 01: Benchmark of commit, receive and join

**What to build:** spec story 18. A maintainer runs `npm run bench`
and sees how long `createCommit`, `processMessage` and `joinGroup`
take at 64, 256 and 1024 members, so tickets 12 and 13 can show what
they change. Adapt upstream's `bench/index.ts` (read it at
`b2e85a4`); drive only the public API and pass `testClientConfig` to
every group. The script prints its results and is not part of
`npm test`, `test:checks` or any CI job.

The benchmark file has to be covered by one of the typecheck
configurations described in AGENTS.md, or nothing reads its types.
`scripts/` under `tsconfig.scripts.json` is the natural home; if it
lives elsewhere, add that directory to an `include` and say why in
the commit. Run it the way the existing `.ts` files under `scripts/`
are run.

The benchmark library is a dev dependency. Install it with
`npm install -D`, so `package.json` and `package-lock.json` change
together; never hand-edit the lockfile.

**Blocked by:** None (can start immediately)

**Touches:** `package.json` (`bench` script, dev dependency),
`package-lock.json`, a new benchmark file under `scripts/`,
`tsconfig.scripts.json` only if the file needs it. Prior art: upstream
`bench/index.ts`, `test/scenario/large-group-full-lifecycle.ts` for
building a large group, `test/helpers/client-config.ts`.

**Status:** done

- [x] `npm run bench` prints a timing for `createCommit`,
      `processMessage` and `joinGroup` at each of 64, 256 and 1024
      members, and exits 0.
- [x] Neither `npm test` nor any job in `.github/workflows/nodejs.yml`
      runs the benchmark.
- [x] The lockfile diff adds the benchmark dependency and moves no
      `@hpke/*` or `@noble/*` version; `npm ci` succeeds from it and
      `npm audit --omit=dev` still reports 0 vulnerabilities.
- [x] `npm run typecheck` reads the benchmark file (a deliberate type
      error in it fails the run) and passes on the committed file.
- [x] `npm run test:checks`, `npm run check:style`, the Worker
      typecheck and `npm test` pass.

# 17: CI workflows use least privilege, and the `npm audit` record is corrected

**What to build:** audit finding L15, spec story 29, and the
`npm audit` part of story 30.

`auto-dependabot.yml`:
- `paths: - 'dependabot/**'` filters file paths, not branch names.
  Guard on the Dependabot branch name (`github.head_ref` starting
  with `dependabot/`, or `github.actor`) instead.
- The label guard compares an array to a string, so it is always true.
  Test label membership correctly.
- The merge call is not awaited. Await it.
- Add an explicit least-privilege `permissions:` block.

`nodejs.yml` has no `permissions:` block. Add one that grants only
what its jobs need (`contents: read` unless a job needs more).

AGENTS.md says `npm audit` reports 0 vulnerabilities. In fact
`npm audit --omit=dev` is clean and `npm audit` reports 8 dev-only
findings, all fixable with `npm audit fix`. Either run `npm audit fix`
and commit the regenerated lockfile, so the statement becomes true, or
correct the statement to say the runtime set is clean. Pick whichever
leaves the lockfile valid under `npm ci`. Never hand-edit
`package-lock.json`.

No test asserts on workflow files or docs. This ticket is verified by
inspection and by CI running green.

**Blocked by:** None (can start immediately)

**Touches:** `.github/workflows/auto-dependabot.yml`,
`.github/workflows/nodejs.yml`, `AGENTS.md` (the Dependencies
section), `package.json` and `package-lock.json` if `npm audit fix`
is run

**Status:** done

- [x] `auto-dependabot.yml` runs its merge step only for a Dependabot
      branch carrying the intended label, awaits the merge call, and
      declares `permissions:`.
- [x] `nodejs.yml` declares `permissions:` at the workflow or job
      level, and every existing job (build, checks, browser, the matrix
      shards, macOS interop) still passes on push.
- [x] `npm ci` succeeds on a clean checkout, and the AGENTS.md
      statement about `npm audit` matches what `npm audit` prints.

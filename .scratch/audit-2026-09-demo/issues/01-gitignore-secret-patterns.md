# 01: `.gitignore` regains its secret-file patterns

**What to build:** audit finding L14, spec stories 14 and 15 (the
`.gitignore` half). Commit 8fc74e5 widened `.gitignore` for the earlier
audit's M10 and was lost in a squash merge, so today only a bare `.env`
is ignored. Restore that commit's patterns -- `.env.*` with an
`!.env.example` negation, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
`*.keystore`, `id_rsa`, `id_ed25519` -- and add `.dev.vars*`, which is
where wrangler reads local Worker secrets from.

Then correct the M10 row in the resolution table of
`docs/security-audit.md` so it records that the fix was lost and
restored, naming this spec (`.scratch/audit-2026-09-demo/spec.md`).

**Blocked by:** None (can start immediately)

**Touches:** `.gitignore`, `docs/security-audit.md` (the M10 row)

**Status:** done

- [x] `git check-ignore` reports each of `.env.production`,
      `.env.local`, `id_ed25519`, `id_rsa`, `key.pem`, `server.key`,
      `.dev.vars` and `.dev.vars.staging` as ignored.
- [x] `git check-ignore` does not report `.env.example` as ignored.
- [x] `git ls-files -ci --exclude-standard` prints nothing: no file
      already tracked is newly matched.
- [x] The M10 row in `docs/security-audit.md` no longer claims a fix
      that is absent from the tree.

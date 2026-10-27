# 16: Post-quantum code points follow ts-mls 2.x

**What to build:** spec story 22. A member using a post-quantum
ciphersuite interoperates with ts-mls 2.x: groups, KeyPackages,
Welcomes and GroupInfos name the same suite on both sides. Today the
same number names a different suite in each, and a crossing message
fails late and confusingly.

The twelve post-quantum entries in the ciphersuite tables take ts-mls
2.x's code points at `b2e85a4`, in their current order. Names do not
change, and the seven IANA suites are untouched:

| Name | Today | New |
| ---- | ----- | --- |
| `MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519` | `0xF001` | `0xf007` |
| `MLS_128_MLKEM512_CHACHA20POLY1305_SHA256_Ed25519` | `0xF002` | `0xf008` |
| `MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519` | `0xF003` | `0xf009` |
| `MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519` | `0xF004` | `0xf00a` |
| `MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519` | `0xF005` | `0xf00b` |
| `MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519` | `0xF006` | `0xf00c` |
| `MLS_256_XWING_AES256GCM_SHA512_Ed25519` | `0xF007` | `0xf00d` |
| `MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519` | `0xF008` | `0xf00e` |
| `MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87` | `0xF009` | `0xf00f` |
| `MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87` | `0xF00A` | `0xf010` |
| `MLS_256_XWING_AES256GCM_SHA512_MLDSA87` | `0xF00B` | `0xf011` |
| `MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87` | `0xF00C` | `0xf012` |

This table is derived from the spec's statement that the order is
shared. Before changing code, check it against upstream's table at
`b2e85a4`; if they disagree, upstream wins and the disagreement goes
in this ticket's Comments.

Both tables in `src/crypto/ciphersuite.ts` change (name to code point,
and code point to implementation), along with the comment on the
private-use range. Search `src/`, `test/`, `example*/` and `docs/` for
the old literals. The `suite-filter` cost table is keyed by name and
needs no change. `ATTACHMENT_COMPONENT_ID` (`0xF001`) is a component
id in a different registry and does not change.

A persisted `ClientState` stores the suite by name and survives, but a
KeyPackage, Welcome or GroupInfo encoded by 0.0.17 under a
post-quantum suite decodes as unknown or as the wrong suite, so
post-quantum groups must be recreated. The README and the glossary
entry for "Private-use ciphersuite" in `docs/GLOSSARY.md` say so.
AGENTS.md records that these code points follow ts-mls and must not be
renumbered independently. The changelog is generated from commit
messages, so the commit message carries a `BREAKING CHANGE:` line; do
not edit `CHANGELOG.md` by hand. Read upstream `7fda61e` for intent
only.

**Blocked by:** None (can start immediately)

**Touches:** `src/crypto/ciphersuite.ts`, `test/ciphersuite.ts`,
`README.md`, `docs/GLOSSARY.md`, `AGENTS.md`. Prior art:
`test/suite-filter.ts`, `test/codec/key-package.ts`.

**Status:** done

- [x] Each post-quantum name maps to the code point in the table
      above, pinned in the test as the interop contract.
- [x] A KeyPackage generated under each post-quantum suite the
      environment supports carries that code point in its encoded
      `cipher_suite` field; an unsupported suite skips through
      `skipReason`.
- [x] A KeyPackage whose `cipher_suite` is `0xF001` decodes as an
      unknown suite, not as any named one.
- [x] The seven IANA suites keep their code points.
- [x] `test/suite-filter.ts` still finds the shards a partition of the
      matrix.
- [x] README, glossary and AGENTS.md carry the notes above, and the
      commit message contains a `BREAKING CHANGE:` line.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style`, `npm test` and `npm run test:browser`
      pass.

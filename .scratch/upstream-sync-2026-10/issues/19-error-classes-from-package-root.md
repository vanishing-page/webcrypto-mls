# 19: Error classes and byte helpers are exported from the package root

**What to build:** spec story 25. A consumer imports every error class
from the package root and matches a thrown error with `instanceof`, so
it can tell a peer's bad input from a bug in the library. Today the
root exports only `UsageError`.

The package root exports `MlsError`, `ValidationError`, `CodecError`,
`DependencyError`, `CryptoVerificationError`, `CryptoError` and
`InternalError` beside `UsageError`, and `base64ToBytes` and
`base64urlToBytes` beside the existing byte encoders. (Upstream
`70ef399`, `83acbce`.)

The proof is on the built package, not on `src/`:
`scripts/check-package-consumer.mjs` (`npm run check:package`, after
`npm run build`) consumes `dist/` by package name from ESM and
CommonJS. It gains a check that every error class and both byte
helpers import from the root in each module system, and that an error
a public operation throws on bad peer input is an instance of the
`ValidationError` imported from the root in the same module system.
Choose any public operation that throws `ValidationError` on bad
input today; once ticket 14 lands, a malformed `external_pub` is the
spec's example. The CommonJS build is where this can go wrong: a
second copy of `mls-error` in the CommonJS graph makes `instanceof`
fail there and nowhere else.

**Blocked by:** None (can start immediately)

**Touches:** `src/index.ts`, `scripts/check-package-consumer.mjs`.
Prior art: `src/mls-error.ts`, `src/util/byte-array.ts`,
`test/base64.ts`, `scripts/cjs-specifiers.mjs`.

**Status:** done

- [x] From ESM and from CommonJS, each of the eight error classes and
      both byte helpers is importable from the package root of the
      built `dist/`.
- [x] In each module system, an error thrown by a public operation on
      bad input is `instanceof` both `ValidationError` and `MlsError`
      as imported from the root.
- [x] `base64ToBytes` and `base64urlToBytes` imported from the root
      invert `bytesToBase64` and `bytesToBase64url`.
- [x] `npm run build` and `npm run check:package` pass, and the check
      fails if any one of those exports is removed.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

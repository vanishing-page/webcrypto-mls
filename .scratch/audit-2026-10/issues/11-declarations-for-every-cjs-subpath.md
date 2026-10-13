# 11: Declarations for every CommonJS subpath

**What to build:** audit finding F6, spec story 20. The export map
promises a `.d.cts` declaration for every CommonJS subpath, but
`scripts/cts.mjs` reads only the top level of `dist/`. Nested
subpaths -- the whole opt-in attachment subsystem and the crypto
modules -- have none, and a TypeScript consumer on `NodeNext`
resolution gets `TS7016` and an implicit `any`.

Fix: the declaration step walks `dist/` recursively, writing a
`.d.cts` (and its map) beside every `.d.ts`, and rewrites relative
specifiers inside the declarations to their `.cjs` form, so a
CommonJS type graph never resolves into the ESM one.

Extend the package consumer check from ticket 10: compile a CommonJS
and an ESM TypeScript consumer of the same subpaths under
`--module NodeNext --strict`, and require a clean exit. The audit's
`TS7016` consumer on `attachment/reader` is the first case.
`skipLibCheck` stays off unless a third-party declaration forces it
on, and the script says which one if so.

**Blocked by:** 10

**Touches:** `scripts/cts.mjs`, the package consumer check script
from 10

**Status:** done

- [x] A CommonJS TypeScript consumer importing `attachment/reader`, a
      nested crypto subpath, `mls-error` and the root compiles under
      `--module NodeNext --strict` with exit 0.
- [x] An ESM TypeScript consumer of the same subpaths compiles the
      same way.
- [x] The CommonJS consumer fails to compile against a build with the
      old `cts.mjs` (the `TS7016` case), demonstrated once and noted
      in the ticket comments.
- [x] Every `.d.cts` in `dist/` reaches only other `.d.cts` files
      through its relative references (checked by the CommonJS
      consumer resolving cleanly, not by comparing file contents).
- [x] `npm run build` and the full package consumer check pass on
      Node 22.

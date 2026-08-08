# webcrypto-mls

`src/` is the library. Everything else in the repository is either a
demonstration of it or a test of it, and the layout below is the part
that is not obvious from the file names.

## Three applications, one library

`example/` is the feature demo: many MLS clients in one page, driven by
buttons, showing what each operation does to the tree. `example-realistic-demo/`
is a Worker and a client: one MLS client per browser profile, talking to
a Durable Object room over a socket. It has its own `AGENTS.md`, and a
change inside that directory should start there.

`example-shared/` is what both of them import. A module belongs there
once the second application needs it, and moving one there is not a
neutral refactor: both demos then render from the same code, so a change
made for one is a change to the other. Check both callers before editing
anything in that directory. It has its own `AGENTS.md`.

Neither demo is published. `tsconfig.build.json` excludes all three
directories, so the shipped types are `src/` only.

## Two typecheck configurations

The root `tsconfig.json` covers `src`, `test`, `example`,
`example-shared` and `example-realistic-demo/client`. The Worker's own
`example-realistic-demo/tsconfig.json` has an explicit four-file
`include` and different `lib` and `types` settings, because Worker code
runs against Cloudflare globals rather than the DOM. Both have to be run:

```sh
npx tsc -p tsconfig.json --noEmit
npx tsc -p example-realistic-demo/tsconfig.json --noEmit
```

The Worker one must be completely clean. The root one reports one
pre-existing error, `test/test-vectors/key-schedule.ts(73,9)` TS2769;
that is the passing state, and any second error is yours.

Do not add `--declaration false` to either invocation. It conflicts with
`declarationDir` and emits two TS5069 errors whatever the code does.

## Tests

Test files under `test/` are tapzero suites that register themselves as a
side effect. A new file is invisible until it is imported from one of the
two entries, and an unimported file fails nothing and reports nothing.
The entries are `test/matrix.ts` for tests that fan out over the
ciphersuites and `test/unit.ts` for everything else; `test/index.ts` is
both of them, and is what `npm test` and the browser run bundle.

Which entry a file belongs to is not a matter of taste. Every test that
loops over ciphersuites loops over `testCiphersuites()` from
`test/helpers/suite-filter.ts`, never over `ciphersuites` itself, because
`MLS_SUITES` narrows that helper and CI relies on it to split the matrix
across four parallel shards:

```sh
npm run test:fast                  # the representative sample, ~1 minute
npm run test:unit                  # the non-matrix half, ~30 seconds
npm run test:matrix -- shard:1/4   # one shard of the matrix
npm test                           # everything, several minutes
```

A test whose cost is out of proportion to what a second ciphersuite would
tell it loops over `sampleCiphersuites()` instead, which is the sample
intersected with whatever the current shard is running -- so it still
divides across shards rather than repeating in each of them.
`test/suite-filter.ts` asserts the shards remain a partition of the
matrix, so a ciphersuite added to `src/` without a line in that helper's
cost table fails the suite rather than quietly going untested.

For one file:

```sh
npx esbuild test/<file>.ts --bundle --platform=node --format=cjs \
  --loader:.json=json --keep-names --outfile=.tmp.cjs && \
  node .tmp.cjs; rm .tmp.cjs
```

esbuild only strips types, so a bundled run says nothing about whether
the code typechecks. Run both.

Never assert on rendered HTML text. Components are asserted on by calling
them as plain functions and reading the returned vnode, which means a
component that calls a hook cannot be tested that way at all; the demos
split each view into a presentational half and a stateful half for this
reason.

`test/example/vnode.ts` holds the vnode helpers both test directories
import, and two of them are not interchangeable. `findByClass` compares
the whole `class` attribute by equality, so it finds nothing at all on
an element carrying two classes; `findByClassToken` is the one that
matches a single class among several. The wrong choice returns an empty
array rather than an error, so a present element reads as an absent one.

## Conventions worth knowing before the first edit

Tree index arithmetic lives in `src/treemath.ts`. Reuse `root`, `left`,
`right`, `leafWidth`, `isLeaf` and `nodeToLeafIndex` rather than writing
`/ 2` inline; a leaf index that disagrees with the tree retargets a
removal at the wrong member.

Frontend state is `@preact/signals`. Sequential writes go inside
`batch()`, and component-local state is `useSignal`, never `useState`.

htm strips whitespace-only text around a newline, so a marker element
written on its own line beside a value renders flush against it and a
screen reader announces the two as one word. The space goes inside the
marker's own text. Margin and padding cannot stand in for it -- they are
box model, and the accessible text run does not see them.

TypeScript lines stay within 80 columns. Markdown and comments use `--`
and `->`, never an em dash or an arrow character.

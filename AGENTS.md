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

Both demo entry points (`example/index.ts`,
`example-realistic-demo/client/index.ts`) expose `window.state` and set
the `DEBUG` key only inside `if (import.meta.env.DEV)`. Anything new that
reaches into the global scope from a demo belongs inside that same gate:
`state` holds live group secrets.

Gate on `import.meta.env.DEV` and nothing else. It is true only under the
dev server, and Vite replaces it with a literal `false` in every build,
so the block is dropped rather than merely skipped. A
`MODE !== 'production'` test reads as equivalent and is not:
`npm run build-example` -- the build `gh-pages.yml` deploys to the live
demo -- runs `--mode staging`, so that form shipped `window.state` to the
one page where it mattered. Verify a change here against the built
artifact, not the source: `npm run build-example` then
`grep -o 'window\.state=' public/assets/*.js` must find nothing, and the
same for `npm run build:realistic` and
`example-realistic-demo/public/assets/`. Grep for the assignment, `=`
included: the bare string `window.state` is in the shipped bundle either
way, because the `DevTools` panel names it in its copy.

## Dependencies

`package-lock.json` is committed and CI installs with `npm ci`, so a
dependency change is only real once the lockfile is regenerated and
committed alongside `package.json`. Use `npm install` locally (it updates
both) or `npm install --package-lock-only` to refresh the lockfile alone;
never hand-edit it. `npm audit` reports 0 vulnerabilities as the tree
stands, and every dependency is a dev dependency except the runtime set
(`@hpke/*`, `@noble/*`), so an audit finding is almost always in the
tooling chain and fixable with plain `npm audit fix`.

The one workflow that still runs `npm install` is
`.github/workflows/auto-dependabot.yml`, deliberately: its job is to
resolve newer versions rather than reproduce the pinned ones.

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

Both must be completely clean; they exit 0 today, so any error is yours.
Note that the root invocation prints its whole file list, so check the
exit code or grep for `error TS` rather than reading the output.

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

Any test that builds or joins a group passes `testClientConfig` from
`test/helpers/client-config.ts` as the `ClientConfig` argument.
`defaultClientConfig` fails closed on credentials -- its `authService`
throws a `UsageError` -- so a call site that omits the config compiles
and then dies at the first Add. Tests that exercise credential checking
build their own config with a real `AuthenticationService` instead.

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

Zeroization has an ownership rule: `fill(0)` only a buffer the current
call allocated. `ClientState` is functional, node objects are shared
across state versions by `updateArray`, and the caller still holds the
state an operation was given -- so wiping a buffer that arrived as an
input corrupts a live state rather than reclaiming forward secrecy. Where
a function cannot tell, the ownership is passed in explicitly (see the
`ownsSecret` parameter in `src/secret-tree.ts`). A secret that is merely
being dropped from a record goes to the garbage collector untouched.

Every AEAD key/nonce pair in `src/message-protection.ts` and
`src/private-message.ts` is derived inside the function that uses it, so
each is wiped in a `finally` around the AEAD call. The `finally` is the
point: a forged ciphertext makes `decryptAead` reject, and a wipe placed
after the call would be skipped exactly on the path an attacker controls.

The retention limits in `KeyRetentionConfig` trim with `slice(-max)`, and
`slice(-0)` is `slice(0)` -- it keeps everything. Every retention-trimming
helper needs an explicit `if (max <= 0) return <empty>` branch before the
slice, or a limit of 0 silently means "retain forever". Both trimmers have
one now: `removeOldGenerations` in `src/secret-tree.ts` and
`removeOldHistoricalReceiverData` in `src/client-state.ts`.

Credential-type support in `validateLeafNodeCommon`
(`src/client-state.ts`) is a pairwise rule from RFC 9420 7.3, and both
halves have to hold: every member's `capabilities.credentials` must list
the new leaf's `credential.credentialType`, and the new leaf's
`capabilities.credentials` must list the credential type of every member
already in the tree. Adding a credential type to the library means
widening `defaultCapabilities` too, or the first leaf to use it is
rejected by its own peers.

`validateExternalSenders` (`src/client-state.ts`) has three callers, and a
new way of entering a group needs a fourth: `createGroup` checks the
extension it is handed, `joinGroup` checks the one in the Welcome's
GroupInfo, and `joinGroupExternal` checks the one in the GroupInfo it
commits against. A commit that carries a `group_context_extensions`
proposal reaches it through `validateProposals`. Skipping it anywhere
lets a client accept an external signer its own `authService` would
refuse.

Frontend state is `@preact/signals`. Sequential writes go inside
`batch()`, and component-local state is `useSignal`, never `useState`.

htm strips whitespace-only text around a newline, so a marker element
written on its own line beside a value renders flush against it and a
screen reader announces the two as one word. The space goes inside the
marker's own text. Margin and padding cannot stand in for it -- they are
box model, and the accessible text run does not see them.

The error type is part of the contract. `InternalError` means "this
library has a bug"; anything an attacker or a peer can trigger by sending
a message is a `ValidationError`. `extendRatchetTree` in
`src/ratchet-tree.ts` is the shape to watch for: a low-level invariant
guard that is reachable from a remote message needs the caller to reject
the input before the guard fires, not to let an `InternalError` escape.

TypeScript lines stay within 80 columns. Markdown and comments use `--`
and `->`, never an em dash or an arrow character.

A fenced code block inside a bullet has to be indented to the bullet's
text column. At column 0 it ends the list, so every bullet after it
starts a new one and the prose that was meant to follow the example
detaches from it. The README's "Security Considerations" section is
mostly bullets with examples under them, and this renders wrong on
GitHub while looking fine in a plain-text diff. `npm run toc` rewrites
the table of contents in place; run it after adding or renaming a
heading and commit what it produces.

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

## The library has an opt-in half

`src/attachment/` implements random-access encrypted attachments over
four Internet-Drafts (draft-sullivan-seal-concrete-00,
draft-sullivan-cfrg-raae-02, draft-sullivan-mls-attachments, and
draft-ietf-mls-extensions-09), and nothing in `src/index.ts` refers to
it. That is enforced, not merely intended: `npm run test:node` runs
`scripts/check-attachment-invariants.mjs` first, which checks: src/index.ts
stays attachment-free; reader.ts does not pull range.ts; keys.ts pulls
no SEAL code; no file calls getRandomValues; every module that owns
SealState wipes it; the wrapper functions derive and wipe CEKs; and all
vendored test vectors are imported. `scripts/check-vector-determinism.mjs`
runs next, regenerating the self-generated SEAL vectors and diffing them
against the committed copies. `scripts/check-signal-batching.mjs` runs
third; it scans `example/` for two signal writes in a row outside a
`batch()` call, which is the house rule the demo has to follow and
which a render test can only observe indirectly.
`scripts/check-readme-attachments.mjs` runs fourth; it pins the README's
"Encrypted attachments" section, requiring every code block in it to be
a verbatim excerpt of `example/attachment-end-to-end.ts` so the
published walkthrough cannot drift into pseudocode, and holding the
section to 80 columns with no em dashes or arrows. Editing that example
means re-copying the affected block into the README.
`scripts/check-audit-closed.mjs` runs last; it derives the finding list
from the body of `AUDIT-ra.md` and requires the resolution table there
to have exactly one row per finding, each naming the stories that
closed it or writing down why it stays open. The finding list is
derived rather than listed in the script, so the table cannot drift
from the audit. All five live in
`npm run test:checks`, which `test:node` chains and which CI runs as
its own `checks` job, so a violation fails the build on every push and
not only a local test run. Add a new structural gate to that npm
script, not to `test:node` directly, or CI will not run it.

`scripts/check-house-style.mjs` is the exception to that rule, and
`npm run check:style` is how you run it. It enforces the two mechanical
rules from CLAUDE.md -- 80 columns, and no em dash or arrow -- over the
branch's own work, so it needs the base branch and the full history to
diff against. CI checks out shallow, so it stays a local gate rather
than a `test:checks` entry. The character rule covers every line of
every changed file; the length rule covers the files in the script's
`WHOLE_FILE` list end to end and, everywhere else, only the lines the
branch added. Its exemptions are for lines that *cannot* wrap -- URLs,
a bare long path, a markdown table row, a fenced code block, the
generated table of contents -- and each one is argued in the header
comment. Add to that list only with the same kind of argument.
Callers reach the subsystem through the
package's `./*` subpath export. The directory has its own `AGENTS.md`,
and a change inside it should start there.

The one part of that work that reaches the rest of the library is
`KeySchedule.applicationExportSecret` in `src/key-schedule.ts`, a
sibling of the RFC 9420 Table 4 secrets that every `KeySchedule`
consumer now sees.

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

## Three typecheck configurations

The root `tsconfig.json` covers `src`, `test`, `example`,
`example-shared` and `example-realistic-demo/client`.
`tsconfig.scripts.json` covers `scripts`; it exists only to override
`types` to node's, because the build and interop scripts need
`process`, `Buffer` and `node:*` while the root config deliberately
narrows `types` to vite's so a node import inside `src/` or `test/` is
a type error rather than something that only fails in a browser. The
Worker's own `example-realistic-demo/tsconfig.json` has an explicit
four-file `include` and different `lib` and `types` settings, because
Worker code runs against Cloudflare globals rather than the DOM. All
three have to be run:

```sh
npm run typecheck   # tsconfig.json and tsconfig.scripts.json
npx tsc -p example-realistic-demo/tsconfig.json --noEmit
```

The root config also maps the package's own name back onto the source:
`@vanishing.page/webcrypto-mls` to `src/index.ts` and
`@vanishing.page/webcrypto-mls/*` to `src/*.ts`. That exists so an
example can import itself the way a consumer does -- through the
published subpath export -- and still typecheck against `src/` rather
than a stale `dist/`. tsc applies `paths` before the export map, and
esbuild reads the same `paths` out of `tsconfig.json`, so the test
bundles resolve identically. Vite does not read `paths`, so a file
using the subpath form must not end up in the demo's import graph.

All must be completely clean; they exit 0 today, so any error is yours.
Note that a bare `npx tsc -p tsconfig.json --noEmit` prints its whole
file list, so check the exit code or grep for `error TS` rather than
reading the output. `npm run typecheck` passes `--listFiles false` to
keep CI logs readable.

Do not add `--declaration false` to any invocation. It conflicts with
`declarationDir` and emits two TS5069 errors whatever the code does.
`tsconfig.scripts.json` instead sets `declarationDir` to `null`
alongside `declaration: false`, which is the only combination tsc
accepts when extending the root config.

Nothing else typechecks `test/` or `scripts/`. `tsconfig.build.json`
excludes both, so `npm run build` is clean while a test file is broken,
and esbuild only strips types, so a passing `npm test` says nothing
either. `npm run typecheck` is the only check that reads those files at
all, and two type errors reached commits during the attachment work
through exactly that gap. CI runs it as its own step in the `build`
job; the Worker config is still not wired into CI.

## Tests

Test files under `test/` are tapzero suites that register themselves as a
side effect. A new file is invisible until it is imported from one of the
two entries, and an unimported file fails nothing and reports nothing.
The entries are `test/matrix.ts` for tests that fan out over the
ciphersuites and `test/unit.ts` for everything else; `test/index.ts` is
both of them, and is what `npm test` and the browser run bundle.

`npm run test:browser` bundles that same `test/index.ts` and runs it in
headless Chromium through tapout, and CI runs it as its own `browser`
job. Two things about that environment are easy to trip over. A global
a test replaces has to be installed with `Object.defineProperty`: in a
browser `indexedDB` is a getter-only accessor inherited from
`Window.prototype`, so plain assignment throws and takes the rest of
the run with it. And anything a test prints has to stay clear of the
tokens tapout reads as evidence of failure, `Failed`, `FAIL` and
`Error:`. Chromium words an algorithm it does not implement as
`Failed to execute 'importKey' on 'SubtleCrypto'`, which is exactly
what a skipped ciphersuite has to say, so skips route their reason
through `skipReason` in `test/helpers/skip.ts`.

The browser run is checked for completeness, not only for failures.
tapout ends a run that has gone quiet for three seconds and exits 0, so
a suite that stalls midway reports a green tick having run a fraction
of its assertions. `scripts/run-browser-tests.mjs` therefore runs the
suite and hands the TAP stream to `browserRunOutcome` in
`scripts/browser-tap.ts`, which requires tapzero's closing plan and
totals to agree; `test/browser-tap.ts` covers that decision. A step
that has to be silent for longer than three seconds has to report
progress, or its run is treated as truncated.

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

`npm run test:interop` is separate from all of those and runs in
neither `npm test` nor the Linux CI jobs. It builds a Swift executable
against swift-raae, so it needs a Swift toolchain and only runs on the
`macos-14` job; see `src/attachment/AGENTS.md` for why the build has to
be a debug build.

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

The attachments demo cannot be split that way -- it is one component
holding an AudioContext and a stream reader -- so its logic lives in
plain modules the component calls: `example/attachment-plan.ts` (the
seek window, range formatting and slicing, the status text, the
teardown) and `example/playback-loop.ts` (the scheduling loop, driven
by an injected `ChunkScheduler`). Neither imports preact. Put new demo
logic there and test it directly; nothing tests `attachments-demo.ts`.

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

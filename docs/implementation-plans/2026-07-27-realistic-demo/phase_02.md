# Realistic Demo Implementation Plan -- Phase 2: Worker scaffolding and deploy

**Goal:** A deployable Cloudflare Worker serving static assets and answering
a health check, with every committable setting committed and every
non-committable one written down.

**Architecture:** One Worker does three jobs, because two Workers cannot
share a hostname. In this phase it does two of them: it serves the client's
static assets from an asset manifest, and its fetch handler answers
`/api/*`. It also exports a `Room` class extending `DurableObject`, which
is registered but does nothing yet. Local development runs two processes:
Vite serves the client with HMR and proxies `/api` to `wrangler dev`.

**Tech Stack:** Cloudflare Workers, Wrangler 4, Durable Objects with the
SQLite storage backend, Vite 7, preact + htm, TypeScript 5.9.

**Scope:** Phase 2 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

**Verifies: None.**

The design plan states: "Operational verification; no acceptance criteria
claimed." Do not write unit tests for this phase. Verification is that the
commands succeed and the deployed Worker answers.

Two acceptance criteria from later phases become *observable* here and are
checked operationally rather than claimed:
`realistic-demo.AC1.1` (unmatched path returns 200) and
`realistic-demo.AC1.2` (page connects same-origin). They are formally
claimed in Phase 6, which is where the client actually opens a socket.

---

## Codebase verification findings

- The repository contains no Cloudflare code today. Zero hits for
  `wrangler`, `workers.dev`, `DurableObject`, `@cloudflare`,
  `wrangler.toml`, `wrangler.jsonc`, or `.dev.vars`.
- `package.json` has no `package-lock.json` beside it. The package manager
  is npm. There is a `start` script (`vite`) but no `dev` script, so the
  four script names added below do not collide.
- `nanoid@^5.1.16` and `route-event@^8.1.2` are already devDependencies.
  Neither is needed in this phase but both are available later.
- `.gitignore` contains a bare `dist` entry. A bare pattern matches at any
  depth, so `example-realistic-demo/dist/` is already ignored. It does not
  contain `.wrangler`, which this phase adds.
- `eslint.config.js` `ignores` is
  `['lib.es5.d.ts', 'dist/*', 'public/*', 'test/*.js']`. The lint glob is
  `./**/*.{ts,js}`, so it will pick up new Worker files. The generated
  types file must be ignored.
- `.github/workflows/nodejs.yml` runs `npm install`, `npm run build`,
  `npm run lint`, then `npm test` on **every push**. A lint failure in
  the new directory breaks CI, so the eslint ignore change is required,
  not cosmetic.
- `.github/workflows/gh-pages.yml` runs `npm run build-pages` and uploads
  `public/`. Adding a new top-level directory does not affect it. The
  three existing demos are unaffected by this phase.
- `docs/fdr/FDR-002-realistic-demo.md` was **already amended** on
  2026-07-27; decision 2 already describes the single-Worker design.
  `tasks/prd-realistic-demo.md` has **already been rewritten** to match
  this design. The design document's "Documents to update alongside this
  design" section describes work that is already complete. Do not redo it.

## External dependency findings

Verified against the npm registry and current Cloudflare documentation on
2026-07-27.

- `wrangler` current published version: **4.114.0**.
- `@cloudflare/vite-plugin` current published version: 1.47.0. **Not
  used** -- see "Decisions taken during planning" below.
- `assets.not_found_handling: "single-page-application"` returns **HTTP
  200 with `index.html`** for an unmatched path. This is what makes a room
  URL work.
  https://developers.cloudflare.com/workers/static-assets/
- `assets.run_worker_first` accepts an array of path globs. The array form
  is what routes only `/api/*` to the fetch handler.
- Static asset requests are **free and unbilled** on both plans. Only
  requests that invoke the Worker script count against the free plan's
  100,000 per day.
  https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- The declarative `exports` field is GA and supersedes the `migrations`
  array; the two are mutually exclusive.
  https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/
- **`exports` does not replace `durable_objects.bindings`.** `exports`
  registers the class and its storage backend. `durable_objects.bindings`
  establishes the binding name the fetch handler reads as `env.ROOM`. Both
  blocks are required, and `class_name` in the binding must match the key
  in `exports`.
  https://developers.cloudflare.com/durable-objects/get-started/
- SQLite is the only Durable Object storage backend available on the free
  plan and the only one new namespaces may choose.
- Free plan limits: 100,000 requests/day, 100,000 DO SQL row writes/day,
  5 million row reads/day, 5 GB stored.
  https://developers.cloudflare.com/durable-objects/platform/pricing/
- `nodejs_compat` is **not needed**. Web Crypto and WebSockets work
  without it.
- `wrangler dev` defaults to port **8787**, runs Durable Objects locally,
  and persists their SQLite storage between runs under `.wrangler/state`.
- Cloudflare now recommends `wrangler types` generating a
  `worker-configuration.d.ts` over depending on the
  `@cloudflare/workers-types` package. The generated file includes an
  `Env` type derived from the actual bindings, and the docs recommend
  committing it for use in CI.
  https://developers.cloudflare.com/workers/languages/typescript/

## Decisions taken during planning

Two decisions diverge from the design and PRD text. Both were made
deliberately with the repository owner during planning. They are recorded
here so review sees them rather than mistaking them for drift.

**1. `wrangler types` instead of `@cloudflare/workers-types`.**
The design says the Worker tsconfig uses `@cloudflare/workers-types`, and
PRD US-002 lists that as an acceptance criterion. Current Cloudflare
guidance is to generate `worker-configuration.d.ts` with `wrangler types`
instead. The generated file types `Env` from the bindings actually
declared in `wrangler.jsonc`, so a config/code mismatch becomes a compile
error rather than a runtime surprise. **This supersedes the
`@cloudflare/workers-types` bullet in PRD US-002.** No package is added
for types; `wrangler` generates them.

**2. Two processes, not `@cloudflare/vite-plugin`.**
The plugin was considered and rejected for this specific application.
Cloudflare's documentation is explicitly silent on three things this demo
depends on simultaneously: how Vite's `root` resolves `configPath` and
`main`, monorepo layouts with `node_modules` above the Worker directory,
and WebSocket upgrade to a Durable Object through the plugin's dev server.
There are also open issues against WebSocket handling under the plugin
(`cloudflare/workers-sdk#12047`, ECONNRESET on abrupt client disconnect;
`#10045`, WS proxy rejects non-localhost Host headers). The plugin also
auto-overwrites `assets.directory` and requires deploying the generated
`dist/wrangler.json` rather than the committed config, which would
invalidate the deploy command PRD US-002a requires be documented. The
two-process setup the design specifies is fully documented and has none of
these unknowns. This confirms rather than supersedes the design.

---

## Commands used throughout this phase

- **Root typecheck (browser + test code):**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Worker typecheck:**
  `npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Existing example build (must keep working):** `npm run build-example`

---

<!-- START_TASK_1 -->
### Task 1: Add wrangler and the four npm scripts

**Verifies:** None (infrastructure).

**Files:**
- Modify: `package.json`

**Step 1: Install wrangler as a devDependency**

```bash
npm install --save-dev wrangler@4.114.0
```

**This may already be done.** As of 2026-07-28 `package.json` already
carries `"wrangler": "^4.114.0"` in `devDependencies` as an uncommitted
change, and `node_modules/wrangler` is present at 4.114.0. Run the
command anyway -- it is idempotent -- or skip to Step 2 if the check
below already passes.

It must land in `devDependencies`, never `dependencies`. The published
package ships only `dist/` (see the `files` field), and adding a runtime
dependency would change what consumers install.

Verify:

```bash
node -e "const p=require('./package.json'); console.log('dev:', !!p.devDependencies.wrangler, 'runtime:', !!(p.dependencies||{}).wrangler)"
```

Expected: `dev: true runtime: false`

**Step 2: Add the scripts**

Add these four entries to the `scripts` block in `package.json`. Place
them after the existing `build-pages` entry to keep related scripts
together.

```json
"worker:types": "wrangler types example-realistic-demo/worker-configuration.d.ts -c example-realistic-demo/wrangler.jsonc",
"build:realistic": "vite build -c example-realistic-demo/vite.config.js",
"dev:realistic": "vite -c example-realistic-demo/vite.config.js",
"worker:dev": "wrangler dev -c example-realistic-demo/wrangler.jsonc",
"worker:deploy": "npm run build:realistic && wrangler deploy -c example-realistic-demo/wrangler.jsonc"
```

The design and PRD name three scripts (`build:realistic`, `worker:dev`,
`worker:deploy`). Two more are required and added here: `worker:types`,
because the generated types decision above needs a repeatable command,
and `dev:realistic`, because the two-process workflow needs a way to
start the client dev server. Neither collides with an existing name.

`worker:deploy` builds before deploying on purpose. `assets.directory`
points at build output, so deploying without building would upload stale
or missing assets.

**Step 3: Verify nothing existing broke**

```bash
npm run lint
npm test
npm run build-example
```

Expected: all three succeed exactly as before. No new files exist yet, so
nothing else can have changed.

**Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add wrangler and realistic-demo scripts"
```

**Do not look for a `package-lock.json`.** The repository's `.npmrc`
sets `package-lock=false`, so npm never writes one. That is a deliberate
project setting -- do not add a lockfile and do not change `.npmrc`.
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->
<!-- START_TASK_2 -->
### Task 2: Create the Worker config and entry

**Verifies:** None (infrastructure).

**Files:**
- Create: `example-realistic-demo/wrangler.jsonc`
- Create: `example-realistic-demo/index.ts`

**Step 1: Create `example-realistic-demo/wrangler.jsonc`**

Every path in this file resolves relative to the config file itself, not
to the repository root.

```jsonc
{
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "mls-realistic-demo",
    "main": "index.ts",
    "compatibility_date": "2026-07-27",
    "observability": {
        "enabled": true
    },
    "assets": {
        "directory": "./dist",
        "not_found_handling": "single-page-application",
        "run_worker_first": ["/api/*"]
    },
    "durable_objects": {
        "bindings": [
            {
                "name": "ROOM",
                "class_name": "Room"
            }
        ]
    },
    "exports": {
        "Room": {
            "type": "durable-object",
            "storage": "sqlite"
        }
    }
}
```

Four things about this file are deliberate and must not be simplified:

- Both `durable_objects.bindings` and `exports` are present. `exports`
  registers the class and picks the SQLite backend. `bindings` is what
  makes `env.ROOM` exist. Dropping either one breaks the Worker.
- There is no `migrations` array. `exports` supersedes it and the two are
  mutually exclusive; adding `migrations` alongside `exports` is a config
  error.
- There is no `assets.binding`. That is only needed when Worker code
  fetches assets programmatically via `env.ASSETS.fetch()`, which this
  Worker never does -- `run_worker_first` means non-API paths never reach
  the handler at all.
- `run_worker_first` is the array form, not `true`. The boolean form would
  route every request through the Worker and bill every page load.

**Step 2: Create `example-realistic-demo/index.ts`**

```ts
import { DurableObject } from 'cloudflare:workers'

/**
 * One room. In this phase it is registered but inert -- Phase 4 gives it
 * storage and sockets. It exists now so the Durable Object binding is
 * proven to deploy before anything depends on it.
 */
export class Room extends DurableObject {
    async fetch (_req:Request):Promise<Response> {
        return new Response('not implemented', { status: 501 })
    }
}

export default {
    async fetch (req:Request):Promise<Response> {
        const url = new URL(req.url)

        // Answered without touching a Durable Object, so a health check
        // never spins one up.
        if (url.pathname === '/api/health') {
            return Response.json({ ok: true })
        }

        return new Response('not found', { status: 404 })
    }
}
```

The handler takes no `env` parameter yet, because nothing in this phase
reads a binding. Task 3 generates the `Env` type and Task 4 confirms it
compiles; later phases add the parameter when the Room is actually used.

**Step 3: Do not verify yet**

This task cannot typecheck on its own -- `cloudflare:workers` has no types
until Task 3 generates them. That is expected. Do not attempt a typecheck
or a commit here; Task 4 verifies and commits the whole subcomponent.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Generate and wire the Worker types

**Verifies:** None (infrastructure).

**Files:**
- Create: `example-realistic-demo/tsconfig.json`
- Create (generated): `example-realistic-demo/worker-configuration.d.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.build.json`
- Modify: `eslint.config.js`
- Modify: `.gitignore`

**Step 1: Create `example-realistic-demo/tsconfig.json`**

This config covers the Worker side only. The client under `client/` is
browser code and is covered by the root config instead, because the two
need incompatible `lib` and `types` settings.

```json
{
    "extends": "../tsconfig.json",
    "compilerOptions": {
        "types": [],
        "lib": ["ES2022"],
        "moduleResolution": "Bundler",
        "noEmit": true
    },
    "include": [
        "index.ts",
        "worker-configuration.d.ts"
    ]
}
```

`lib` is `["ES2022"]` with no `DOM` and no `WebWorker` on purpose. The
generated `worker-configuration.d.ts` declares the entire Workers runtime
including `Request`, `Response`, and `WebSocket`. Leaving `DOM` or
`WebWorker` in scope declares those same names a second time and produces
duplicate-identifier errors.

`"types"` is the **empty array**, not a path to the generated file.
Entries in `types` resolve as package names under `typeRoots`, not as
relative file paths, so `"./worker-configuration.d.ts"` is not reliably
resolvable. The empty array does the one job needed here -- cancelling
the root config's inherited `"types": ["vite/client"]` -- and the
generated file is already pulled in by `include` below, which is the
resolution-safe way to get it.

`include` is narrow and grows in later phases: Phase 3 adds `protocol.ts`
and `room-logic.ts` to it.

**Step 2: Generate the types**

```bash
npm run worker:types
```

Expected: writes `example-realistic-demo/worker-configuration.d.ts`.

**Step 3: Read the generated file and note how `Env` is exposed**

```bash
grep -n "interface Env" -A 6 example-realistic-demo/worker-configuration.d.ts
```

The generated file is the authority on this, and the exact shape depends
on the wrangler version. Read the result and confirm two things:

1. `Env` contains a `ROOM` member typed as
   **`DurableObjectNamespace<Room>`** -- the parameterized form, with the
   class as its type argument. The bare `DurableObjectNamespace` is not
   sufficient: Phase 4 calls `roomInfo()` on the stub as an RPC method,
   and without the type argument the stub has no such method and Phase 4
   will not typecheck.

   If the binding is missing, the `durable_objects.bindings` block in
   `wrangler.jsonc` is wrong -- fix it and regenerate. If the binding is
   present but unparameterized, confirm `exports` names the same
   `class_name`, and regenerate after fixing.
2. Whether `Env` is declared globally or exported. Later phases need to
   reference it; use whichever form the generated file actually provides.

**Step 4: Commit the generated file, ignore the state directory**

Cloudflare's documentation recommends committing
`worker-configuration.d.ts` so CI typechecks against the same types. It is
not build output and must not be gitignored.

The local Durable Object state directory must be ignored. Add one line to
`.gitignore`, after the existing `dist` entry:

```
.wrangler
```

`example-realistic-demo/dist/` needs no new entry -- the existing bare
`dist` pattern already matches it at any depth.

**Step 5: Add the new directory to the TypeScript configs**

In `tsconfig.json`, add the client directory to `include`. Do not add
`example-realistic-demo` wholesale -- that would pull `index.ts` into the
browser config and reintroduce the type conflict Step 1 just avoided.

```json
  "include": [
    "example",
    "example-shared",
    "example-realistic-demo/client",
    "src/**/*",
    "test",
    "lib.es5.d.ts"
  ]
```

In `tsconfig.build.json`, add the whole directory to `exclude`, so no part
of the demo ships in the published package:

```json
    "exclude": [
        "example",
        "example-shared",
        "example-realistic-demo",
        "test"
    ]
```

Both files already gained `example-shared` in Phase 1; the arrays above
show the expected final state.

**Step 6: Keep the generated file out of lint**

`worker-configuration.d.ts` is machine-generated and thousands of lines
long. Lint would fail on it and the failure would be meaningless. In
`eslint.config.js`, extend the `ignores` array passed to
`newneostandard`:

```js
        ignores: [
            'lib.es5.d.ts',
            'dist/*',
            'public/*',
            'test/*.js',
            'example-realistic-demo/dist/*',
            'example-realistic-demo/worker-configuration.d.ts'
        ]
```

This is required, not cosmetic: `.github/workflows/nodejs.yml` runs
`npm run lint` on every push, so an unignored generated file breaks CI for
every future commit.

**Step 7: Do not commit yet**

Task 4 adds the client placeholder, which the Worker needs before anything
can be built or served. Verify and commit there.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Create the client placeholder and Vite config

**Verifies:** None (infrastructure).

The Worker serves assets from `example-realistic-demo/dist`, so something
has to build into that directory before the Worker can serve anything.

**Files:**
- Create: `example-realistic-demo/vite.config.js`
- Create: `example-realistic-demo/client/index.html`
- Create: `example-realistic-demo/client/index.ts`

**Step 1: Create `example-realistic-demo/vite.config.js`**

```js
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// The client is its own application at the root of the Worker's
// hostname, so `base` is '/' rather than the '/webcrypto-mls' the
// GitHub Pages build uses.
export default defineConfig({
    define: {
        global: 'globalThis'
    },
    root: './client',
    base: '/',
    plugins: [
        preact({
            devtoolsInProd: false,
            prefreshEnabled: true
        })
    ],
    esbuild: {
        logOverride: { 'this-is-undefined-in-esm': 'silent' }
    },
    server: {
        port: 1234,
        host: true,
        proxy: {
            // ws:true is what lets the WebSocket upgrade through to
            // wrangler dev. Without it the socket fails in development
            // only, which is a confusing way to find out.
            '/api': {
                target: 'http://localhost:8787',
                changeOrigin: true,
                ws: true
            }
        }
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        sourcemap: 'inline'
    }
})
```

Two path notes. `root` and `build.outDir` resolve relative to this config
file's directory, so `root` is `example-realistic-demo/client` and
`outDir` is `example-realistic-demo/dist` -- which is exactly what
`assets.directory` in `wrangler.jsonc` points at. `emptyOutDir` is
required because `outDir` sits outside `root`; Vite refuses to clear such
a directory silently.

This config uses port 1234, the same port as the root `vite.config.js`.
The two servers serve different applications and are never run at once. If
`dev:realistic` reports the port is in use, stop the other Vite server.

**Step 2: Create `example-realistic-demo/client/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MLS realistic demo</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="./index.ts"></script>
</body>
</html>
```

**Step 3: Create `example-realistic-demo/client/index.ts`**

A placeholder, replaced wholesale in Phase 6. It exists so the build has
an entry and the deploy can be proven end to end before any protocol
exists.

```ts
const root = document.getElementById('root')

if (root) {
    root.textContent = 'MLS realistic demo -- scaffolding'
}
```

**Step 4: Typecheck both sides**

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npx tsc -p example-realistic-demo/tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
```

Expected: both report no errors.

If the Worker typecheck reports duplicate identifiers for `Request`,
`Response`, or `WebSocket`, a DOM or WebWorker lib is still in scope --
recheck the `lib` and `types` overrides from Task 3, Step 1.

**Step 5: Lint and confirm the existing suite is unaffected**

```bash
npm run lint
npm test
npm run build-example
```

Expected: all three succeed. `npm test` must report the same count as
before this phase -- this phase adds no tests.

**Step 6: Build the client**

```bash
npm run build:realistic
ls example-realistic-demo/dist
```

Expected: `index.html` and an `assets/` directory.

**Step 7: Commit the whole subcomponent**

```bash
git add -A
git commit -m "feat: scaffold realistic-demo worker, client and config"
```
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Verify locally, then deploy

**Verifies:** None (this is the design's "Done when" check).

**Files:** None modified unless a defect is found.

**Step 1: Start the Worker**

```bash
npm run worker:dev
```

Expected: wrangler serves on `http://localhost:8787` and reports the
`ROOM` Durable Object binding. If it reports an unknown field or a
migrations error, `wrangler.jsonc` is wrong -- fix before continuing.

**Step 2: Check the health endpoint**

In a second terminal:

```bash
curl -i http://localhost:8787/api/health
```

Expected: `HTTP/1.1 200 OK` and body `{"ok":true}`.

Confirm in the `wrangler dev` output that no Durable Object was
instantiated for this request. The handler returns before reading any
binding, so none should appear.

**Step 3: Check the SPA fallback**

```bash
curl -o /dev/null -w '%{http_code}\n' http://localhost:8787/aB3xK9pQ2m
```

Expected: `200`, not `404`. This is the behavior a room URL depends on. If
this returns 404, `assets.not_found_handling` is not
`single-page-application` or `assets.directory` does not point at a
directory containing `index.html`.

```bash
curl -s http://localhost:8787/aB3xK9pQ2m | grep -c 'id="root"'
```

Expected: `1` -- the unmatched path served the page itself.

**Step 4: Check the two-process development workflow**

Leave `wrangler dev` running. In a third terminal:

```bash
npm run dev:realistic
```

Open `http://localhost:1234/`. Expected: the placeholder text renders.

```bash
curl -i http://localhost:1234/api/health
```

Expected: `200` with `{"ok":true}`, proving the Vite proxy reaches
`wrangler dev`. This is the path the WebSocket will later take, so it
working now is what makes a later socket failure diagnosable.

**Step 5: Stop both dev servers**

Stop the Vite process and the wrangler process. Do not leave either
running.

**Step 6: Deploy**

```bash
npm run worker:deploy
```

Expected: wrangler builds, uploads the assets, and prints the deployed
origin, of the form `https://mls-realistic-demo.<subdomain>.workers.dev`.

Record that origin -- Task 6 writes it into the README.

**Step 7: Verify the deployed Worker**

Substitute the real origin:

```bash
curl -i https://mls-realistic-demo.<subdomain>.workers.dev/api/health
curl -o /dev/null -w '%{http_code}\n' https://mls-realistic-demo.<subdomain>.workers.dev/aB3xK9pQ2m
```

Expected: `200` with `{"ok":true}` for the first, and `200` for the
second.

**Step 8: Confirm GitHub Pages is untouched**

```bash
npm run build-pages
ls public public/persistence public/multi-device
```

Expected: succeeds and produces all three html files, exactly as before
this phase. Nothing in this phase should have changed the Pages build.
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Write the Cloudflare settings README

**Verifies:** None (documentation).

Workers Builds settings have no `wrangler.jsonc` equivalent and are not
honored from the config file, so they are the only things that must be set
by hand. Writing them down is what keeps the split between checked-in
config and account config explicit.

**Files:**
- Create: `example-realistic-demo/README.md`

**Step 1: Write the README**

It must cover every item below. Use the real deployed origin recorded in
Task 5, Step 6.

- **What this directory is:** a standalone application deployed to
  Cloudflare, separate from the three demos GitHub Pages serves. One
  Worker serves the page, handles the WebSocket upgrade, and hosts one
  Durable Object per room.
- **Workers Builds settings, and that these are the only manual ones:**
  - Root directory: **the repository root**, not
    `example-realistic-demo/`. This is deliberate and needs its reason
    stated: a single `node_modules` has to cover `vite`, `preact`, `src/`
    and `example-shared/`, and the client imports across that boundary.
    Setting the root to the subdirectory would break the install.
  - Build command: `npm run build:realistic`
  - Deploy command:
    `npx wrangler deploy -c example-realistic-demo/wrangler.jsonc`
  - The connected GitHub repository and which branch deploys.
- **That everything else is committed:** the assets config, the SPA
  fallback, the API routing, the Durable Object binding and its SQLite
  storage, the compatibility date and observability all live in
  `wrangler.jsonc` and need no dashboard equivalent.
- **Secrets:** there are none. If any are added later they go through
  `wrangler secret put`, never into `wrangler.jsonc`, which is committed.
- **The deployed origin**, named explicitly.
- **The two-process development workflow:** `npm run worker:dev` on 8787
  and `npm run dev:realistic` on 1234, with the note that Vite proxies
  `/api` including the WebSocket upgrade, and that the root `vite.config.js`
  also uses port 1234 so the two dev servers cannot run at once.
- **Free plan limits worth knowing**, since exceeding one fails
  operations of that type rather than degrading: 100,000 requests/day,
  100,000 Durable Object SQL row writes/day, 5 GB stored. Static asset
  requests are unbilled, so only API and WebSocket traffic counts.
- **Regenerating types:** `npm run worker:types` after any change to
  bindings in `wrangler.jsonc`, and that
  `worker-configuration.d.ts` is committed on purpose.

Follow the repository's documentation conventions: no em dashes (use
`--`), no arrow characters (use `->`), and no emoji.

**Step 2: Verify**

```bash
npm run lint
```

Expected: passes. Markdown is not linted, but confirm nothing else broke.

**Step 3: Commit**

```bash
git add example-realistic-demo/README.md
git commit -m "docs: record cloudflare dashboard settings for realistic demo"
```
<!-- END_TASK_6 -->

---

## Phase 2 completion checklist

- [ ] `wrangler@4.114.0` in `devDependencies`, not `dependencies`
- [ ] Five scripts added and working
- [ ] `wrangler.jsonc` has both `durable_objects.bindings` and `exports`
- [ ] `wrangler.jsonc` has no `migrations` array
- [ ] `worker-configuration.d.ts` generated, committed, and lint-ignored
- [ ] `.wrangler` gitignored
- [ ] `eslint.config.js` ignores `example-realistic-demo/dist/*`
- [ ] Root typecheck and Worker typecheck both clean
- [ ] `npm run lint` and `npm test` pass; test count unchanged
- [ ] `npm run build:realistic` writes `example-realistic-demo/dist`
- [ ] `GET /api/health` returns 200 without instantiating a Durable Object
- [ ] An unmatched path returns 200 with the page, not 404
- [ ] Vite proxy reaches `wrangler dev` on `/api`
- [ ] Deployed, with `/api/health` answering on the deployed origin
- [ ] `npm run build-pages` still produces all three existing demos
- [ ] Both dev servers stopped
- [ ] `README.md` records every dashboard setting and the deployed origin

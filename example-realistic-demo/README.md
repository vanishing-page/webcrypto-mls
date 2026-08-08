# MLS Realistic Demo

A standalone Cloudflare Workers application deployed separately from the three
demos GitHub Pages serves.

One Worker handles three responsibilities: it serves the client's static
assets from a built asset manifest, answers `/api/*` requests, and hosts one
Durable Object per room to coordinate WebSocket connections and shared state.

## Deployed origin

https://mls-realistic-demo.nichoth.workers.dev

## Workers Builds configuration

Workers Builds settings are the only configuration that does not live in
committed config files and must be set by hand in the Cloudflare dashboard.
This section records what those settings are.

### Root directory

Set the build root directory to the repository root, not to
`example-realistic-demo/`.

Why: `build:realistic` is defined only in the root `package.json`, and
there is no `package.json` in `example-realistic-demo/`. Setting the build
root to the subdirectory therefore fails the build outright, with a
missing-script error, rather than failing later. The build also invokes
Vite from the root `node_modules`.

A second reason arrives in Phase 6, when the client imports from
`example-shared/` and `src/`. Those cross-directory imports resolve only
against a single `node_modules` at the repository root.

### Build command

`npm run build:realistic`

This runs Vite to build the client assets into
`example-realistic-demo/public`, the directory `wrangler.jsonc` names as
`assets.directory`. The two must agree: pointing the build somewhere else
deploys an empty asset directory rather than failing. `public` is
gitignored, so the build is not optional before a deploy.

### Deploy command

`npx wrangler deploy -c example-realistic-demo/wrangler.jsonc`

This deploys the Worker with the committed configuration.

### Connected repository

- GitHub repository: https://github.com/nichoth/webcrypto-mls
- Deploy branch: `main`

The repository's default branch is `main`. Push to `main` to trigger
Workers Builds deploy.

## Configuration in version control

Everything else is committed to `wrangler.jsonc`:

- Assets configuration, including `assets.directory` (points at built
  output), `assets.not_found_handling` (single-page-application to serve
  index.html for unmatched paths, enabling room URLs), and
  `assets.run_worker_first` (routes only `/api/*` through the Worker so
  static asset requests are unbilled).
- The `fetch` handler routing, which answers `/api/health` and returns 404
  elsewhere.
- Durable Object binding (`ROOM`), its class definition, and the SQLite
  storage backend.
- Compatibility date and observability settings.

None of these require dashboard equivalents.

## Secrets

There are no secrets in this application today. If secrets are added later,
add them via `wrangler secret put <name>`, never by editing
`wrangler.jsonc`, which is committed to version control.

## Development workflow

### Starting both servers

```
npm run start:realistic
```

Runs both servers below in one terminal via `concurrently`, prefixing each
line with `worker` or `client` so the two output streams stay legible. The
`-k` flag kills both when either one exits, so a crashed Worker does not
leave an orphaned Vite server behind (or the reverse).

Use the individual scripts below when you want to restart one server
without restarting the other.

### Two local servers

The development setup runs two processes simultaneously:

1. **Worker server** on port 8787:
   ```
   npm run worker:realistic
   ```
   Runs `wrangler dev` to serve the Worker, its Durable Objects, and static
   assets locally.

2. **Client dev server** on port 1234 (in a separate terminal):
   ```
   npm run dev:realistic
   ```
   Runs Vite to serve the client with hot module replacement. Vite's dev
   server proxies `/api` requests to the Worker server on 8787, including
   WebSocket upgrades (enabled by the `ws:true` setting in
   `vite.config.js`). This proxy path is what the client's WebSocket will
   later take.

Note: The root `vite.config.js` also uses port 1234, so the two Vite dev
servers cannot run at once. If `npm run dev:realistic` says the port is in
use, stop the root Vite server first.

### Verification steps

After starting `wrangler dev`, test in a second terminal:

```
curl -i http://localhost:8787/api/health
```

Expected: `200` with body `{"ok":true}`.

Test the unmatched path fallback (required for room URLs):

```
curl -o /dev/null -w '%{http_code}\n' http://localhost:8787/aB3xK9pQ2m
```

Expected: `200`, not `404`.

After starting `npm run dev:realistic`, open `http://localhost:1234/` in
a browser. You should see the placeholder text. Test the proxy:

```
curl -i http://localhost:1234/api/health
```

Expected: `200` with body `{"ok":true}`, proving Vite reaches `wrangler
dev`.

## Free plan limits

The Cloudflare Workers free plan imposes limits that fail operations when
exceeded, rather than degrading gracefully:

- **100,000 requests per day** total
- **100,000 Durable Object SQL row writes per day**
- **5 million Durable Object SQL row reads per day**
- **5 GB total storage**

Static asset requests are unbilled, so only `/api` and WebSocket traffic
consume request quota. Health checks and heartbeats add up quickly; monitor
request counts closely during development.

## Regenerating type definitions

Whenever you change the bindings in `wrangler.jsonc` (e.g., add a new
Durable Object binding), regenerate the TypeScript types:

```
npm run types:realistic
```

This runs `wrangler types` to create
`example-realistic-demo/worker-configuration.d.ts`, which declares the
`Env` type used by the Worker's fetch handler. The generated file is
committed to version control on purpose, so CI typechecks against the same
types as your development environment.

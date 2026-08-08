# PRD: Persistence Demo Page and /docs Routing Fix

## Introduction

The example app is a single-page Preact app deployed to GitHub Pages at the
base path `/webcrypto-mls`. Two changes are needed:

1. The typedoc-generated documentation is deployed as static files under
   `/webcrypto-mls/docs/`. The example app uses `route-event` for
   client-side routing, which intercepts anchor clicks. Any link to the
   docs must bypass the client-side router and do a real page load, so the
   static typedoc HTML is served.

2. A second demo page, client-side routed at `/persistence`
   (`/webcrypto-mls/persistence/` when deployed), that mirrors the main
   demo where each simulated member has a "persist" button that saves
   that member's signature keypair and MLS `ClientState` to `indexedDB`,
   restored on reload. This demonstrates the
   "Persistence" section of the README. The page also includes a button
   that calls `navigator.storage.persist()` and shows the persisted
   status. Both pages get navigation linking the two demos (and the docs).

## Goals

- Links to `/docs` (i.e. `/webcrypto-mls/docs/` when deployed) always do a
  full page load and serve the typedoc output, never the SPA.
- A `/persistence` client-side route renders a persistence-focused demo,
  and a direct load of `/webcrypto-mls/persistence/` on GitHub Pages
  works (no 404).
- Each simulated member in the persistence demo has a "persist" button
  that saves that member's signature keypair and MLS `ClientState` to
  the demo's own `indexedDB` database, under a per-member key so any
  number of members can be saved side by side.
- Saved members are restored automatically on reload.
- The persistence demo's keypairs are separate from the main demo (the
  main demo remains fully in-memory).
- A visible control shows `navigator.storage.persisted()` status and lets
  the user request persistent storage via `navigator.storage.persist()`.
- All example pages share navigation between the "main" demo, the
  "persistence" demo, and the docs.

## User Stories

### US-001: Exclude /docs from client-side routing
**Description:** As a visitor to the deployed site, I want links to the
API docs to load the typedoc pages so that I can read the documentation
instead of being trapped in the SPA.

**Acceptance Criteria:**
- [ ] `Route()` in `example/state.ts` is constructed with the
      `handleLink` option (see the route-event README, "Use a function to
      check clicks"): return `false` for any href whose pathname starts
      with `/docs` or `<base>/docs`, so the browser handles it natively
- [ ] The base path is not hard-coded twice: derive it from
      `import.meta.env.BASE_URL` so dev (`/`) and Pages
      (`/webcrypto-mls/`) both work
- [ ] Clicking a docs link in the built app performs a full page load
      (document request, not an SPA route change)
- [ ] All other internal links continue to route client-side
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill (use `vite preview` or a
      static server over `public/` after `npm run build-pages`, since dev
      mode has no `docs/` output)

### US-002: Client-side route for the persistence demo
**Description:** As a visitor, I want to open `/persistence` and see the
persistence demo so that the two demos are separately addressable pages.

**Acceptance Criteria:**
- [ ] Navigating to `/persistence` in-app (via route-event) renders the
      persistence demo; the root path renders the existing main demo
- [ ] Route matching accounts for the base path: `/persistence` in dev,
      `/webcrypto-mls/persistence` on Pages (compare against
      `import.meta.env.BASE_URL`)
- [ ] A direct load / hard refresh of `/webcrypto-mls/persistence/` on
      GitHub Pages serves the app: the build emits
      `public/persistence/index.html` (copy of the built `index.html`)
      so no 404 occurs, and the app reads the pathname on startup to
      render the right demo
- [ ] The dev server (`vite`) also serves the route on hard refresh
      (single-page fallback covers it, or document why not)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill (include a hard refresh
      on `/persistence` against the built `public/` output)

### US-003: Shared navigation between demos and docs
**Description:** As a visitor, I want navigation on every example page so
that I can move between the main demo, the persistence demo, and the docs.

**Acceptance Criteria:**
- [ ] A nav component renders on both demo pages with three links:
      "Main demo" (base path), "Persistence" (`<base>/persistence`),
      and "Docs" (`<base>/docs/`)
- [ ] The main/persistence links navigate client-side via route-event
      (no full page load)
- [ ] The current page's link is visually marked as active
- [ ] The docs link triggers a full page load (per US-001)
- [ ] Nav styles live in the existing `example/style.css` using nested
      selectors and existing CSS variables
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-004: Persistence demo mirrors the main demo
**Description:** As a developer evaluating this library, I want a working
group-messaging demo whose members can survive page reloads so that I
can see how persistence is meant to work.

**Acceptance Criteria:**
- [ ] The persistence demo reuses the main demo's UI patterns (create
      group, add members, send messages) -- shared components/functions
      are extracted rather than copy-pasted where practical
- [ ] Each member uses a **non-extractable** signature keypair generated
      on this page, distinct from anything the main demo creates
- [ ] Demo state is modeled with `@preact/signals`; sequential signal
      writes use `batch`
- [ ] The main demo's behavior is unchanged (still fully in-memory)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-005: Per-member "persist" buttons saving to indexedDB
**Description:** As a visitor, I want a "persist" button on each member
so that I can save any member's keypair and group state and see it
restored after a reload -- the saved `ClientState` *is* the membership
(no re-join needed).

**Acceptance Criteria:**
- [ ] Each member in the persistence demo shows a button labeled
      "persist"
- [ ] Clicking it saves that member's signature keypair and current
      `ClientState` to a dedicated database (e.g. `mls-persistence-demo`)
      under a key unique to that member (e.g. `${groupId}:${name}`), so
      multiple members can be saved side by side without collisions
- [ ] The `ClientState` (including the non-extractable
      `signaturePrivateKey`) is stored via structured clone, following
      the README's `saveState`/`loadState` helper pattern
- [ ] Once a member has been persisted, their saved record is updated
      after every subsequent state advance (`createCommit`,
      `createApplicationMessage`, `processMessage`), so the stored
      state tracks the group's current epoch
- [ ] The UI shows which members are currently persisted (e.g. the
      button becomes "persisted" or shows a marker)
- [ ] On page load, all saved members are restored (group, epoch,
      member list) instead of starting fresh, and the UI indicates the
      state was restored
- [ ] A "Reset" control deletes the demo's database and returns the page
      to its fresh state
- [ ] Persisting two different members, reloading, and sending another
      message works (epochs advance from the restored states)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill (persist two members,
      reload, confirm both are restored)

### US-006: Storage persist() request UI
**Description:** As a visitor, I want to ask the browser for persistent
storage so that my saved MLS state is not evicted under storage pressure.

**Acceptance Criteria:**
- [ ] On load, the page shows the current `navigator.storage.persisted()`
      result (e.g. "Storage: best-effort" / "Storage: persistent")
- [ ] A button calls `navigator.storage.persist()` and updates the
      displayed status with the result (granted or denied)
- [ ] The button is disabled once storage is already persistent
- [ ] Absence of the StorageManager API does not crash the page (feature
      check; hide or disable the control)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: Construct `route-event`'s `Route({ handleLink })` so hrefs whose
  pathname begins with the docs path (`${BASE_URL}docs`) return `false`
  and are handled by the browser natively.
- FR-2: Derive the docs path from `import.meta.env.BASE_URL`; do not
  hard-code `/webcrypto-mls` in the example source.
- FR-3: Render the persistence demo when the pathname (relative to
  `import.meta.env.BASE_URL`) is `persistence`; render the main demo at
  the root; both on in-app navigation and on initial page load.
- FR-4: Render a shared navigation component on both demos with links to
  the main demo, `${BASE_URL}persistence`, and `${BASE_URL}docs/`;
  demo links navigate client-side.
- FR-4a: The `build-example` step emits `public/persistence/index.html`
  (a copy of the built `index.html`) so a direct load of the route on
  GitHub Pages does not 404.
- FR-5: Generate each member's signature keypair with
  `extractable: false` and pass it as a pre-existing keypair per the
  README's "Use with pre-existing keypairs" section.
- FR-6: Render a "persist" button per member; clicking it stores that
  member's keypair and `ClientState` in an `indexedDB` database used
  only by the persistence demo, keyed per member so all members can be
  saved concurrently.
- FR-6a: For members already persisted, rewrite their record after
  every state advance so the saved state stays at the current epoch.
- FR-7: On load of the persistence demo, read the database and restore
  every saved member's state when present; re-derive the cipher suite
  with `getCipherSuite` (it is stateless and cannot be persisted).
- FR-8: Provide a reset control that deletes the demo database.
- FR-9: Show `navigator.storage.persisted()` on load and provide a
  button that calls `navigator.storage.persist()` and reflects the
  result.
- FR-10: Do not log key material or other sensitive data.

## Non-Goals (Out of Scope)

- No multi-tab or cross-device sync; persistence is single-origin,
  single-profile `indexedDB` only.
- No persistence added to the main demo; it stays in-memory.
- No changes to the library source in `src/` -- example-app and build
  configuration only.
- No server component; all members are simulated in-page as today.
- No migration/versioning story for the demo database schema beyond a
  simple `onupgradeneeded` store creation.
- No changes to the typedoc build itself (`build-docs` already outputs to
  `public/docs`).

## Design Considerations

- Follow the existing example-app style: `htm/preact` templates, signals
  in a `State()` factory, `batch` for multi-signal writes.
- Nav should be small and textual; reuse colors from the existing CSS
  variables; nested CSS selectors per house style.
- The "restored from indexedDB" indicator can be a simple status line;
  no toast/modal machinery.
- Two different "persist" concepts appear on this page: the per-member
  "persist" buttons (save to indexedDB) and the page-level
  `navigator.storage.persist()` request (US-006). Label the latter
  distinctly (e.g. "Request persistent storage") so they are not
  confused.

## Technical Considerations

- `route-event`'s `handleLink` receives the href; compare against
  `import.meta.env.BASE_URL + 'docs'`.
- GitHub Pages has no SPA fallback, so the deployed site needs a real
  file at `persistence/index.html`. Simplest approach: after the vite
  build, copy `public/index.html` to `public/persistence/index.html`
  (e.g. a small script step appended to `build-example`). Built asset
  URLs are already root-relative to the base path, so the copy works
  from the subdirectory unchanged; verify this against the built output.
- On startup the app must read `location.pathname` (minus
  `import.meta.env.BASE_URL`) to pick the initial demo; route-event
  covers subsequent navigation.
- The current `onRoute` handler treats any path containing `#` as an
  in-page anchor (`example/state.ts:91`); confirm `/persistence` passes
  through the scroll logic sensibly.
- `indexedDB` structured clone holds non-extractable `CryptoKey`s; this
  is the crux of the demo and is already documented in the README's
  Persistence section -- the demo should match those helpers closely so
  README and demo stay consistent.
- `navigator.storage.persist()` may auto-deny without a prompt in some
  browsers (notably Chrome decides heuristically); the UI copy should
  present "denied" as a normal outcome, not an error.
- Dev mode (`vite`) serves no `docs/` directory; docs-link verification
  requires `npm run build-pages` plus a static server over `public/`.

## Success Metrics

- On the deployed Pages site, navigating to `/webcrypto-mls/docs/` from
  the example app shows typedoc output (full page load).
- Loading `/webcrypto-mls/persistence/` directly (fresh tab, hard
  refresh) renders the persistence demo with no 404.
- Persisting multiple members, then reloading `/persistence`, restores
  each of them at the group's current epoch and allows sending a new
  message with no re-join.
- The two demos never share stored data: clearing the persistence demo's
  database does not affect the main demo, and vice versa.

## Open Questions

- Should the nav also link to the GitHub repository?

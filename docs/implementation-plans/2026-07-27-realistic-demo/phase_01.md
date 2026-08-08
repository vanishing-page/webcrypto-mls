# Realistic Demo Implementation Plan -- Phase 1: Extract shared example code

**Goal:** Create `example-shared/` so two deployable applications can import
the same modules, with no behavior change to any existing demo.

**Architecture:** Six modules move out of `example/` into a new sibling
directory `example-shared/`, and the `DemoUser` interface is split out of
`example/demo-state.ts` into `example-shared/demo-user.ts`. Every import
site in the repository is updated to the new path. `example/` keeps
everything only the GitHub Pages site uses. This is a pure refactor
verified by the existing test suite and build.

**Tech Stack:** TypeScript, preact + htm, `@preact/signals`, Vite (build),
esbuild + `@substrate-system/tapzero` (Node tests), eslint
(`newneostandard`).

**Scope:** Phase 1 of 8 from `docs/design-plans/2026-07-27-realistic-demo.md`

**Codebase verified:** 2026-07-27

---

## Acceptance Criteria Coverage

**Verifies: None.**

This is a pure refactor phase. The design plan states: "No acceptance
criteria are claimed; this is a pure refactor verified by the existing
suite." Do not invent tests for this phase. The existing test suite,
lint, typecheck, and build are the verification.

---

## Codebase verification findings

Confirmed by investigation before writing this plan:

- All six move-list modules exist under `example/` with the exports
  listed below.
- No circular dependency will be created. Of the six, only
  `persistence-storage.ts` imports anything that stays in `example/`
  (the `DemoUser` type), and that type moves in Task 3.
- `tsconfig.json` `include` is currently
  `["example", "src/**/*", "test", "lib.es5.d.ts"]`.
- `tsconfig.build.json` `exclude` is currently `["example", "test"]`.
- `vite.config.js` uses `root: 'example'` and `build.outDir: '../public'`
  with no explicit entry enumeration; the entry is `example/index.html`.
- `npm test` runs `test:node`, which bundles `test/index.ts` through
  esbuild to Node CJS. Nothing under test may touch the DOM,
  `indexedDB`, `WebSocket`, or `DurableObject`.
- There is no project-level `CLAUDE.md` or `AGENTS.md`. Follow the
  existing code in each file for style.

Discrepancies found against the design document, which this plan
corrects:

1. The design's import-update list omits `example/state.ts`, which
   re-exports `DemoUser as User` on line 22. It is included below.
2. The design's list omits `example/demo-actions.ts`,
   `example/device-info.ts`, `example/user.ts`, and
   `example/user-highlight.ts`, all of which import `DemoUser`. They are
   included below.
3. The design's list says "the affected files under `test/example/`"
   without enumerating them. The exhaustive list is given below.
4. The design does not state that `persistence-storage.ts` imports
   `DemoUser`. It does, so the `DemoUser` split (Task 3) must complete
   before `persistence-storage.ts` moves (Task 4). This plan orders them
   accordingly.

---

## Commands used throughout this phase

Establish these once. They are referenced by number in every task.

- **Typecheck:**
  `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Example build:** `npm run build-example`

Run all four after every task. All four must succeed before you commit.

---

<!-- START_TASK_1 -->
### Task 1: Move the three dependency-free modules

**Verifies:** None (infrastructure refactor).

`constants.ts`, `card-header.ts`, and `how-to-use.ts` import nothing
from `example/`, so they can move first with no ordering constraints.

**Files:**
- Create directory: `example-shared/`
- Move: `example/constants.ts` -> `example-shared/constants.ts`
- Move: `example/card-header.ts` -> `example-shared/card-header.ts`
- Move: `example/how-to-use.ts` -> `example-shared/how-to-use.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.build.json`
- Modify: 9 import sites listed below

**Step 1: Move the files with git so history follows**

```bash
mkdir -p example-shared
git mv example/constants.ts example-shared/constants.ts
git mv example/card-header.ts example-shared/card-header.ts
git mv example/how-to-use.ts example-shared/how-to-use.ts
```

Do not edit the contents of these three files. They import only `preact`
and `htm/preact` (or nothing at all), so their own import lines are
already correct at the new location.

**Step 2: Add `example-shared` to the TypeScript configs**

In `tsconfig.json`, change the `include` array from:

```json
  "include": [
    "example",
    "src/**/*",
    "test",
    "lib.es5.d.ts"
  ]
```

to:

```json
  "include": [
    "example",
    "example-shared",
    "src/**/*",
    "test",
    "lib.es5.d.ts"
  ]
```

In `tsconfig.build.json`, change the `exclude` array from:

```json
    "exclude": [
        "example",
        "test"
    ]
```

to:

```json
    "exclude": [
        "example",
        "example-shared",
        "test"
    ]
```

The build config excludes it because `example-shared/` is demo code, not
library code, and must not ship in the published package.

**Step 3: Update every import of `constants.js`**

Six sites. In each, replace `'./constants.js'` with
`'../example-shared/constants.js'`. Leave the imported names unchanged.

| File | Line | Current import |
|---|---|---|
| `example/device-info-panel.ts` | 5 | `import { SPACE } from './constants.js'` |
| `example/persistence-demo.ts` | 42 | `import { NBSP, SPACE } from './constants.js'` |
| `example/multi-device-demo.ts` | 69 | `import { NBSP, SPACE } from './constants.js'` |
| `example/tree-diagram.ts` | 15 | `import { NBSP } from './constants.js'` |
| `example/storage-panel.ts` | 7 | `import { NBSP } from './constants.js'` |
| `example/index.ts` | 29 | `import { NBSP, SPACE } from './constants.js'` |

Note `example/storage-panel.ts` is in this list even though it moves in
Task 2. Update it now to `'../example-shared/constants.js'`; Task 2
changes it again to `'./constants.js'` once the file itself has moved.
Doing it this way keeps the tree compiling after every task.

**Step 4: Update every import of `card-header.js`**

Four sites.

| File | Line | Current | New specifier |
|---|---|---|---|
| `example/tree-diagram.ts` | 14 | `import { CardHeader } from './card-header.js'` | `'../example-shared/card-header.js'` |
| `example/device-info-panel.ts` | 3 | `import { CardHeader } from './card-header.js'` | `'../example-shared/card-header.js'` |
| `test/example/card-header.ts` | 2 | `import { CardHeader } from '../../example/card-header.js'` | `'../../example-shared/card-header.js'` |
| `test/example/device-info-panel.ts` | 5 | `import { CardHeader } from '../../example/card-header.js'` | `'../../example-shared/card-header.js'` |

**Step 5: Update every import of `how-to-use.js`**

Two sites.

| File | Line | Current | New specifier |
|---|---|---|---|
| `example/multi-device-demo.ts` | 67 | `import { HowToUse } from './how-to-use.js'` | `'../example-shared/how-to-use.js'` |
| `test/example/how-to-use.ts` | 2 | `import { HowToUse, SETUP_STEPS } from '../../example/how-to-use.js'` | `'../../example-shared/how-to-use.js'` |

Only the module specifier changes. Do not rename or reorder the imported
bindings -- the two `test/example/` files are test files, and the design
requires that no test file be modified other than its import lines.

**Step 6: Verify**

Run all four commands:

```bash
npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false
npm run lint
npm test
npm run build-example
```

Expected: typecheck reports no errors; lint reports no errors; every
test passes with the same count as before this task; the Vite build
writes `public/index.html`, `public/persistence/index.html`, and
`public/multi-device/index.html` without errors.

If `tsc` reports "Cannot find module '../example-shared/...'", you
missed a `git mv` or mistyped a specifier. Fix before continuing.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move constants, card-header, how-to-use to example-shared"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Move the storage presentation pair

**Verifies:** None (infrastructure refactor).

`storage-panel.ts` imports `storage-persistence.ts`, so the two move
together. Moving them in one task means the relative import between them
stays `'./storage-persistence.js'` and never needs a temporary form.

**Files:**
- Move: `example/storage-persistence.ts` ->
  `example-shared/storage-persistence.ts`
- Move: `example/storage-panel.ts` -> `example-shared/storage-panel.ts`
- Modify: `example-shared/storage-panel.ts` (its own `constants` import)
- Modify: 6 import sites listed below

**Step 1: Move the files**

```bash
git mv example/storage-persistence.ts example-shared/storage-persistence.ts
git mv example/storage-panel.ts example-shared/storage-panel.ts
```

**Step 2: Fix `storage-panel.ts`'s own imports**

`example-shared/storage-panel.ts` now sits beside both of its local
dependencies. Two of its import lines need attention:

- Line 6 imports `'./storage-persistence.js'`. This is already correct
  at the new location. Leave it alone.
- Line 7 was changed in Task 1 to
  `'../example-shared/constants.js'`. Change it back to
  `'./constants.js'`, because both files now live in `example-shared/`.

Do not change the imported bindings, only the specifier.

**Step 3: Update every import of `storage-persistence.js`**

Three remaining sites outside `example-shared/`.

| File | Line | Current | New specifier |
|---|---|---|---|
| `example/persistence-demo.ts` | 28 | `import { StorageStatus, checkPersisted, requestPersistentStorage } from './storage-persistence.js'` | `'../example-shared/storage-persistence.js'` |
| `example/multi-device-demo.ts` | 60 | same bindings, `'./storage-persistence.js'` | `'../example-shared/storage-persistence.js'` |
| `test/example/storage-persistence.ts` | 6 | `import { storageStatusLabel, checkPersisted, requestPersistentStorage } from '../../example/storage-persistence.js'` | `'../../example-shared/storage-persistence.js'` |

**Step 4: Update every import of `storage-panel.js`**

Three sites.

| File | Line | Current | New specifier |
|---|---|---|---|
| `example/persistence-demo.ts` | 33 | `import { PersistRequest, StoragePanel, persistOutcome } from './storage-panel.js'` | `'../example-shared/storage-panel.js'` |
| `example/multi-device-demo.ts` | 65 | same bindings, `'./storage-panel.js'` | `'../example-shared/storage-panel.js'` |
| `test/example/storage-panel.ts` | 5 | `import { PERSIST_MESSAGES, persistOutcome } from '../../example/storage-panel.js'` | `'../../example-shared/storage-panel.js'` |

**Step 5: Verify**

Run the same four commands as Task 1, Step 6. All four must pass.

Pay attention to the test count: `test/example/storage-panel.ts` and
`test/example/storage-persistence.ts` exercise these modules. If either
file's tests vanish from the output rather than passing, the import
specifier is wrong and the module silently resolved to nothing.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move storage-panel and storage-persistence to example-shared"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Split `DemoUser` into `example-shared/demo-user.ts`

**Verifies:** None (infrastructure refactor).

`DemoUser` is the one type both the existing demos and the new realistic
demo need. `DemoState` and `createDemoState()` stay in `example/`,
because they model a map of many simulated clients and the new demo
holds exactly one real client.

This task must complete before Task 4, because
`example/persistence-storage.ts` imports `DemoUser` and Task 4 moves
that file.

**Files:**
- Create: `example-shared/demo-user.ts`
- Modify: `example/demo-state.ts` (remove the interface, import it back)
- Modify: `example/state.ts:22` (re-export from the new location)
- Modify: 14 further import sites listed below

**Step 1: Create `example-shared/demo-user.ts`**

The interface moves verbatim. Its three field types come from
`../src/index.js`, and `example-shared/` sits at the same depth as
`example/`, so the specifier is unchanged.

```ts
import type {
    KeyPackage,
    ClientState,
    PrivateKeyPackage
} from '../src/index.js'

/**
 * One MLS client as the demos model it. The existing demos hold a map
 * of many of these; the realistic demo holds exactly one.
 */
export interface DemoUser {
    name:string
    state?:ClientState
    keyPackage?:KeyPackage
    privateKeys?:PrivateKeyPackage
}
```

**Step 2: Update `example/demo-state.ts`**

Delete the `DemoUser` interface declaration (currently lines 9-14).

`DemoState.users` still references `DemoUser`, so import it back. Also
narrow the `../src/index.js` type import: after the interface is gone,
`KeyPackage`, `ClientState`, and `PrivateKeyPackage` are unused in this
file and only `CiphersuiteImpl` remains.

Replace the file's current import block:

```ts
import { signal, type Signal } from '@preact/signals'
import type {
    KeyPackage,
    ClientState,
    CiphersuiteImpl,
    PrivateKeyPackage
} from '../src/index.js'
```

with:

```ts
import { signal, type Signal } from '@preact/signals'
import type { CiphersuiteImpl } from '../src/index.js'
import type { DemoUser } from '../example-shared/demo-user.js'
```

Leave `DemoMessage`, `DemoMessageQueue`, `DemoState`, and
`createDemoState()` exactly as they are, including the doc comment above
`createDemoState()`.

**Step 3: Update `example/state.ts`**

Line 22 currently re-exports both types from `demo-state.js`:

```ts
export type { DemoUser as User, DemoMessage as Message } from './demo-state.js'
```

`DemoUser` no longer originates there, so split the re-export into two
lines pointing at the correct sources:

```ts
export type { DemoUser as User } from '../example-shared/demo-user.js'
export type { DemoMessage as Message } from './demo-state.js'
```

This keeps the `User` and `Message` aliases working for every existing
consumer of `example/state.ts`.

**Step 4: Update the eight remaining `example/` import sites**

Where a line imports only `DemoUser`, change its specifier. Where a line
imports `DemoUser` alongside something that stays in `demo-state.ts`,
split it into two import statements.

| File | Line | Current | Action |
|---|---|---|---|
| `example/demo-actions.ts` | 22 | `import type { DemoState, DemoUser } from './demo-state.js'` | Split: keep `import type { DemoState } from './demo-state.js'`, add `import type { DemoUser } from '../example-shared/demo-user.js'` |
| `example/persistence-demo.ts` | 7 | `import { createDemoState, type DemoUser } from './demo-state.js'` | Split: keep `import { createDemoState } from './demo-state.js'`, add `import type { DemoUser } from '../example-shared/demo-user.js'` |
| `example/multi-device-demo.ts` | 5 | `import { createDemoState, type DemoUser } from './demo-state.js'` | Split, same as above |
| `example/device-info.ts` | 2 | `import type { DemoUser } from './demo-state.js'` | Change specifier to `'../example-shared/demo-user.js'` |
| `example/device-sync.ts` | 3 | `import type { DemoUser } from './demo-state.js'` | Change specifier to `'../example-shared/demo-user.js'` |
| `example/persistence-storage.ts` | 14 | `import type { DemoUser } from './demo-state.js'` | Change specifier to `'../example-shared/demo-user.js'` |
| `example/user-highlight.ts` | 3 | `import type { DemoUser } from './demo-state.js'` | Change specifier to `'../example-shared/demo-user.js'` |
| `example/user.ts` | 7 | `import type { DemoUser } from './demo-state.js'` | Change specifier to `'../example-shared/demo-user.js'` |

The eslint config prefers type-only imports for types
(`@typescript-eslint/consistent-type-imports`), so use
`import type { ... }` for every new `DemoUser` line.

**Step 5: Update the six `test/example/` import sites**

Change only the specifier on each. Do not touch anything else in these
files.

| File | Line | Current specifier | New specifier |
|---|---|---|---|
| `test/example/device-sync.ts` | 3 | `'../../example/demo-state.js'` | `'../../example-shared/demo-user.js'` |
| `test/example/device-info.ts` | 7 | `'../../example/demo-state.js'` | `'../../example-shared/demo-user.js'` |
| `test/example/send-plan.ts` | 9 | `'../../example/demo-state.js'` | `'../../example-shared/demo-user.js'` |
| `test/example/persistence-storage.ts` | 9 | `'../../example/demo-state.js'` | `'../../example-shared/demo-user.js'` |
| `test/example/user-highlight.ts` | 7 | `'../../example/demo-state.js'` | `'../../example-shared/demo-user.js'` |
| `test/example/user.ts` | 14 | `'../../example/demo-state.js'` | `'../../example-shared/demo-user.js'` |

Each of these six lines imports only `DemoUser`, so no splitting is
needed.

**Step 6: Verify no stale `DemoUser` references remain**

```bash
grep -rn "DemoUser" --include="*.ts" example example-shared test
```

Expected: every result either declares `DemoUser` in
`example-shared/demo-user.ts`, imports it from
`'../example-shared/demo-user.js'` or `'../../example-shared/demo-user.js'`,
or is a use of the type in a signature. No result should import
`DemoUser` from any `demo-state.js` path.

**Step 7: Verify**

Run the same four commands as Task 1, Step 6. All four must pass.

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor: split DemoUser into example-shared/demo-user"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Move `persistence-storage.ts`

**Verifies:** None (infrastructure refactor).

This module moves last because it depends on `DemoUser`, which Task 3
relocated. Its shape is unchanged here -- Phase 8 later adds
`createSessionStore()` to it, but nothing in this phase alters its
behavior or its exports.

**Files:**
- Move: `example/persistence-storage.ts` ->
  `example-shared/persistence-storage.ts`
- Modify: `example-shared/persistence-storage.ts` (its `DemoUser` import)
- Modify: 7 import sites listed below

**Step 1: Move the file**

```bash
git mv example/persistence-storage.ts example-shared/persistence-storage.ts
```

**Step 2: Fix its own `DemoUser` import**

Line 14 was changed in Task 3 to
`import type { DemoUser } from '../example-shared/demo-user.js'`. Now
that the file lives in `example-shared/`, change the specifier to
`'./demo-user.js'`.

**Step 3: Update every import of `persistence-storage.js`**

Seven sites. Replace the specifier only; the imported bindings are
unchanged everywhere.

| File | Line | Current specifier | New specifier |
|---|---|---|---|
| `example/persistence-demo.ts` | 23 | `'./persistence-storage.js'` | `'../example-shared/persistence-storage.js'` |
| `example/device-restore.ts` | 4 | `'./persistence-storage.js'` | `'../example-shared/persistence-storage.js'` |
| `example/multi-device-demo.ts` | 54 | `'./persistence-storage.js'` | `'../example-shared/persistence-storage.js'` |
| `example/device-sync.ts` | 2 | `'./persistence-storage.js'` | `'../example-shared/persistence-storage.js'` |
| `test/example/member-store.ts` | 5 | `'../../example/persistence-storage.js'` | `'../../example-shared/persistence-storage.js'` |
| `test/example/persistence-storage.ts` | 8 | `'../../example/persistence-storage.js'` | `'../../example-shared/persistence-storage.js'` |
| `test/example/device-restore.ts` | 3 | `'../../example/persistence-storage.js'` | `'../../example-shared/persistence-storage.js'` |

**Step 4: Verify the directory split matches the design**

```bash
ls example-shared
```

Expected exactly these seven files and nothing else:

```
card-header.ts
constants.ts
demo-user.ts
how-to-use.ts
persistence-storage.ts
storage-panel.ts
storage-persistence.ts
```

```bash
grep -rn "from '\.\./example/" example-shared
```

Expected: no output. Nothing in `example-shared/` may import from
`example/`. If this prints anything, a module that stays behind was
pulled in by accident and the two directories now depend on each other
in both directions.

**Step 5: Verify**

Run the same four commands as Task 1, Step 6. All four must pass.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move persistence-storage to example-shared"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Confirm no behavior changed in the three existing demos

**Verifies:** None (this is the design's "Done when" check).

The design's completion condition for this phase is that the main,
persistence, and multi-device demos behave identically in the browser.
Automated checks cannot establish that, so this task is a manual pass.

**Files:** None modified, unless a defect is found.

**Step 1: Confirm the test suite is untouched apart from imports**

```bash
git diff --stat main -- test/
```

Expected: every changed file under `test/` shows a small line count,
and inspecting the diff shows only module specifiers changed. If any
assertion, test name, or fixture changed, revert that hunk -- the design
requires no test file be modified other than its import lines.

```bash
git diff main -- test/ | grep '^[-+]' | grep -v "^[-+][-+][-+]" | grep -v "example-shared\|example/"
```

Expected: no output. Any line here is a change that is not an import
path.

**Step 2: Start the dev server**

```bash
npm start
```

If `npm start` is not defined, use `npx vite`. The server listens on
port 1234 per `vite.config.js`.

**Step 3: Check each demo renders and works**

Open each route and confirm it behaves as it did before this phase:

1. `http://localhost:1234/` -- the main demo. Create users, create the
   group, send a message. The tree diagram and card headers render.
2. `http://localhost:1234/persistence` -- the persistence demo. The
   storage panel renders with its persist control, and the storage
   status label reads correctly.
3. `http://localhost:1234/multi-device` -- the multi-device demo. The
   how-to-use card renders, and device panels render.

Check the browser console on each page. Expected: no module resolution
errors, no `Failed to fetch dynamically imported module`, no uncaught
exceptions.

The three moved presentational modules (`card-header`, `how-to-use`,
`storage-panel`) are the ones most likely to fail visibly if an import
broke, which is why each route above names the component to look for.

**Step 4: Stop the dev server**

Stop the process you started in Step 2. Do not leave it running.

**Step 5: Confirm the production build output**

```bash
npm run build-example
ls public public/persistence public/multi-device
```

Expected: `public/index.html`, `public/persistence/index.html`, and
`public/multi-device/index.html` all exist, and `public/assets/`
contains the built bundle.

**Step 6: Commit only if a fix was needed**

If Steps 1-5 all passed with no edits, there is nothing to commit and
this phase is complete. If a defect was found and fixed:

```bash
git add -A
git commit -m "fix: correct import path missed in example-shared extraction"
```
<!-- END_TASK_5 -->

---

## Phase 1 completion checklist

- [ ] `example-shared/` contains exactly seven files
- [ ] Nothing in `example-shared/` imports from `example/`
- [ ] `tsconfig.json` `include` contains `example-shared`
- [ ] `tsconfig.build.json` `exclude` contains `example-shared`
- [ ] `npx tsc -p tsconfig.json --noEmit --declaration false --declarationMap false --listFiles false` reports no errors
- [ ] `npm run lint` passes
- [ ] `npm test` passes with the same test count as before the phase
- [ ] `npm run build-example` succeeds and writes all three html files
- [ ] No test file changed other than its import lines
- [ ] All three existing demos verified in the browser
- [ ] Dev server stopped

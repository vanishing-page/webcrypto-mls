# Substrate form controls -- Phase 1: registration and CSS imports

**Goal:** Register `substrate-input`, `substrate-button` and `check-box`
in the two browser entries, and import their default stylesheets into
the realistic demo's CSS, without converting any control yet.

**Architecture:** Each package calls `customElements.define` as a
side effect of importing its main entry, so registration is a bare
`import '...'` with no `.define()` call. The imports live only in the
two browser entry modules, neither of which the Node suite reaches --
`@substrate-system/web-component/util` binds `document.querySelector`
at module top level and `CheckBox extends HTMLElement`, so both throw
under Node. The three stylesheets come in through CSS `@import`, beside
the normalize import already there.

**Tech Stack:** TypeScript, Preact + htm, vite, lightningcss,
`@substrate-system/{input,button,check-box}`, tapzero.

**Scope:** Phase 1 of 5.

**Codebase verified:** 2026-08-05.

---

## Acceptance Criteria Coverage

### realistic-demo-form-controls.AC1: The components are registered

- **realistic-demo-form-controls.AC1.1 Success:**
  `example-realistic-demo/client/index.ts` imports all three packages
  for side effect, so all three custom elements are defined on every
  realistic-demo page.
- **realistic-demo-form-controls.AC1.2 Success:** `example/index.ts`
  imports `@substrate-system/button` for side effect, so the shared
  storage panel's button renders as a button on
  `example/persistence-demo.ts` and `example/multi-device-demo.ts`
  rather than as inert inline text.
- **realistic-demo-form-controls.AC1.3 Failure:** No registration
  import is reachable from `test/index.ts`, so `npm run test:node`
  still runs with no DOM present.

### realistic-demo-form-controls.AC2: The packages' CSS styles them

- **realistic-demo-form-controls.AC2.1 Success:** `client/style.css`
  imports the three package sheets and `npm run build:realistic`
  resolves each `@substrate-system/<pkg>/css` specifier.

---

## Verified state before this phase

Facts confirmed by reading the tree on 2026-08-05. Trust these over
memory; if one is false, stop and report rather than working around it.

- `example-realistic-demo/client/index.ts` exists. Its own AGENTS.md
  (`example-realistic-demo/AGENTS.md`) says this file "is wiring only
  -- no rules, no decisions" and "is not unit tested, which is only
  acceptable while it stays that thin". Adding side-effect imports
  keeps it that thin.
- `example/index.ts` exists and imports `PersistenceDemo` from
  `./persistence-demo.js` (line 18) and `MultiDeviceDemo` from
  `./multi-device-demo.js` (line 19). Both of those render
  `StoragePanel` from `example-shared/storage-panel.ts`
  (`persistence-demo.ts:453`, `multi-device-demo.ts:986`).
- `example-realistic-demo/client/style.css` line 1 is
  `@import url("@substrate-system/css-normalize");` and line 8 is
  `@import url("./_variables.css");`. The bare-package `url()` form is
  what already works here.
- All three packages are in `devDependencies`:
  `@substrate-system/input` `^0.0.27`, `@substrate-system/button`
  `^0.0.49`, `@substrate-system/check-box` `^0.0.19`. Nothing is
  installed by this work.
- Each package's `package.json` has a `"./css"` export that resolves
  to a `dist/index.css` that exists on disk.
- Each package's `dist/index.js` ends in a `define(...)` call:
  `define(SubstrateInput.TAG, SubstrateInput)` where
  `SubstrateInput.TAG === 'substrate-input'`,
  `define("substrate-button", SubstrateButton)`, and
  `define("check-box", CheckBox)`.
- `test/example-realistic-demo/views.ts` imports the view modules
  directly and imports neither entry, directly or transitively.
- `example-realistic-demo/vite.config.js` sets
  `css.transformer: 'lightningcss'` and `build.cssMinify:
  'lightningcss'`, and `outDir` to `example-realistic-demo/public`
  (line 50). The build output goes to `public/`, not to `dist/`.
- The `@substrate-system/<pkg>/css` subpath `@import` was tried against
  this tree during planning: the build succeeded and the emitted CSS
  contained the package rules. The design flagged this as its
  load-bearing risk; it is not one. The fallback in Task 3 stays
  documented, but expect not to need it.

---

## Standing hazard: the build breaks lint until you clean up

This bites at every phase boundary in this plan, so read it once here.

`npm run build:realistic` writes minified bundles to
`example-realistic-demo/public/`. `eslint.config.js` ignores `public/*`
(repo root) and `example-realistic-demo/dist/*` (which does not exist),
but **not** `example-realistic-demo/public/`. So a `npm run lint`
immediately after a build exits 1 with tens of thousands of errors from
generated code.

This is pre-existing and has nothing to do with this work. **Do not fix
it by editing `eslint.config.js`** -- eslint settings are out of bounds
here. Instead, after any `npm run build:realistic` or
`npm run build-example`, remove the output before linting:

```sh
rm -rf example-realistic-demo/public
```

Where a task lists both a build and a lint, run the lint first, or
clean between them. Every "Phase N done when" list in this plan assumes
you have done so.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Register the three components in the realistic demo entry

**Verifies:** realistic-demo-form-controls.AC1.1,
realistic-demo-form-controls.AC1.3

**Files:**
- Modify: `example-realistic-demo/client/index.ts` (import block at the
  top of the file)

**Implementation:**

Add three side-effect imports to the existing import block. Put them
after the third-party imports and before the local `./` imports, so the
block keeps its existing ordering convention. Do not call `.define()`
-- each package already does that on import, and calling it a second
time throws `NotSupportedError` for an already-defined name.

```ts
import '@substrate-system/input'
import '@substrate-system/button'
import '@substrate-system/check-box'
```

Add a short comment above them saying why they are here rather than in
the view modules, because the reason is not local:

```ts
/**
 * Registration only. These must not be imported from a view module:
 * the node suite calls the views as plain functions, and both
 * `@substrate-system/web-component/util` (which binds
 * `document.querySelector` at module top level) and `check-box`
 * (whose class extends `HTMLElement`) throw under Node. This entry is
 * the one place the suite never reaches.
 */
```

Nothing else in the file changes. No component is converted in this
phase, so the three elements are defined and unused, which is correct
and temporary.

**Testing:**

No new test. This is registration wiring in a module the suite does not
import and AGENTS.md records as deliberately untested. AC1.3 is
verified operationally by the suite continuing to pass -- if a
registration import leaked into a module the suite reaches, the bundle
would throw on `document` at load.

**Verification:**

Run: `npm run lint`
Expected: exits 0, no new errors.

Run: `npm run test:node`
Expected: the full suite passes, same as before the change. This is
AC1.3: an import that leaked into the suite's reach would throw
`ReferenceError: document is not defined` at bundle load, before any
test ran.

**Commit:** `feat: register substrate components in the realistic demo entry`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Register substrate-button in the example entry

**Verifies:** realistic-demo-form-controls.AC1.2

**Files:**
- Modify: `example/index.ts` (import block at the top of the file)

**Implementation:**

`example-shared/storage-panel.ts` is shared: `example/persistence-demo.ts`
and `example/multi-device-demo.ts` both render `StoragePanel`. Phase 4
converts that panel's button to `<substrate-button>`, which reaches
those two pages whether or not they were the point of this work. An
undefined custom element does not render -- without this import,
`<substrate-button>` on those pages would leave "Request persistent
storage" as inert inline text with no button around it.

So this import is obligatory, and it lands before the conversion rather
than after, so no commit in this plan leaves those two pages broken.

Add one side-effect import to `example/index.ts`:

```ts
import '@substrate-system/button'
```

with a comment recording why an entry that has no substrate markup of
its own needs it:

```ts
/**
 * Registration only, and not optional. `example-shared/storage-panel.ts`
 * renders `<substrate-button>`, and both pages this entry loads render
 * that panel. An undefined custom element does not render: without
 * this, the button's label would be inert inline text and the control
 * would be gone.
 */
```

Only the button package. The other two are not used by anything
`example/index.ts` loads, and importing them would pull two sheets'
worth of behaviour into pages this work is not changing.

**Testing:**

No new test. `example/index.ts` is a browser entry that the node suite
does not import, for the same reason as Task 1.

**Verification:**

Run: `npm run lint`
Expected: exits 0.

Run: `npm run test:node`
Expected: full suite passes.

**Commit:** `feat: register substrate-button in the example entry`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Import the three package stylesheets

**Verifies:** realistic-demo-form-controls.AC2.1

**Files:**
- Modify: `example-realistic-demo/client/style.css` (lines 1-8, the
  existing import block)

**Implementation:**

Add three `@import` lines to the top of the file. They go after the
normalize import and before the `./_variables.css` import.

Order matters and is not arbitrary. Normalize comes first because it is
the baseline every later rule overrides. The package sheets come next,
because they are third-party control styling that the demo's own rules
may need to override. `./_variables.css` stays last of the imports,
where it already is, so the custom properties it defines are declared
after anything a package sheet declares -- `check-box`'s sheet sets
`--primary-accent` on `:root`, and while `_variables.css` happens not
to define that name today, keeping the demo's palette last is what
makes that stay true of any name it gains later.

The file's first eight lines become:

```css
@import url("@substrate-system/css-normalize");

/* The control styling is the packages', not this demo's. Importing
   their default sheets is the point rather than a convenience: a
   re-skin would put the same focus, disabled and hover rules back
   under different selectors, which is the duplication this replaces.
   Every control selector is scoped under its own tag, so nothing
   here restyles a bare `button` or `input`. check-box is the one
   exception: its sheet also sets --primary-accent on :root. Nothing
   in this demo reads that name, so it collides with nothing today.
   Keeping the palette import last is what would settle it if a later
   _variables.css ever did define it. */
@import url("@substrate-system/button/css");
@import url("@substrate-system/check-box/css");
@import url("@substrate-system/input/css");

/* The palette is copied from `example/style.css`, deliberately, rather
   than imported. Importing that sheet would pull the other demos' whole
   ruleset into this separate application and tie the two appearances
   together; copying the variable block keeps one palette without that
   coupling. Do not edit `example/style.css` from here. */
@import url("./_variables.css");
```

Keep the existing palette comment exactly as it is. Do not touch any
rule below the import block -- the demo's own control rules are deleted
in Phase 5, deliberately, after the controls that depend on them have
been converted.

Expect the demo to look wrong between this task and Phase 5: both the
package rules and the demo's own `button` rule are live, and
`substrate-button button` outspecifies a bare `button`. That is the
known intermediate state, not a defect.

**Testing:**

No test. This is a stylesheet import; the project asserts on vnodes and
never on rendered CSS. Verified operationally by the build.

**Verification:**

Run: `npm run build:realistic`
Expected: the build succeeds and emits CSS.

This is the check the design called load bearing: it is what proves
vite and lightningcss resolve the `@substrate-system/<pkg>/css` subpath
export from a CSS `@import`. The existing `css-normalize` import only
proves the bare-package form works, and a subpath export is a different
resolution path. This exact change was tried against this tree during
planning and it worked, so treat a failure here as a signal that
something else has changed rather than as the expected outcome.

Then confirm the rules actually landed rather than merely that the
build exited 0 -- a silently dropped `@import` also exits 0:

```sh
grep -c "substrate-button" example-realistic-demo/public/assets/*.css
```
Expected: a non-zero count. If it is zero, the import resolved to
nothing and the fallback below applies.

The path is `public/`, not `dist/`: `vite.config.js:50` sets `outDir`
to `example-realistic-demo/public`. A glob against `dist/` matches
nothing and would read as a failed import when the import was fine.

Then clean up before linting anything, per the standing hazard above:

```sh
rm -rf example-realistic-demo/public
```

**If the subpath does not resolve:**

Do not invent a third form. Fall back to importing the three sheets
from `example-realistic-demo/client/index.ts` instead, which is the
form the packages document:

```ts
import '@substrate-system/input/css'
import '@substrate-system/button/css'
import '@substrate-system/check-box/css'
```

and leave `client/style.css` with only its two original imports. If you
take the fallback, say so in the commit message, because it changes
where a later reader looks for the demo's stylesheet graph.

**Commit:** `feat: import the substrate control stylesheets`
<!-- END_TASK_3 -->

---

## Phase 1 done when

1. `npm run test:node` passes -- the same suite that passed before,
   proving no registration import leaked into the suite's reach.
2. `npm run build:realistic` succeeds and
   `example-realistic-demo/public/assets/*.css` contains
   `substrate-button`.
3. `rm -rf example-realistic-demo/public`, then `npm run lint` exits 0.
   Lint last, after the cleanup, for the reason in the standing hazard
   above.

No control has been converted yet. The three elements are registered
and their sheets are loaded, and the demo's own control rules are still
in place, so the page looks wrong until Phase 5. That is expected.

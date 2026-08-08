# Substrate form controls -- Phase 4: persistence, gone and the shared panel

**Goal:** Convert the persistence checkbox and reset button, the
gone view's create-new button, and the shared storage panel's
request-persistence button.

**Architecture:** Two tag swaps and one change of shape. The
`<label class="persist-toggle">` wrapper collapses into a
`<check-box class="persist-toggle">` with the sentence as its text
content -- the component reads `textContent` once at connect and
renders its own `label.checkbox-label`. The storage panel is shared:
converting it reaches `example/persistence-demo.ts` and
`example/multi-device-demo.ts` too. That is accepted rather than worked
around, and Phase 1 already registered `substrate-button` in
`example/index.ts` so those pages are never broken by a commit here.

**Tech Stack:** TypeScript, Preact + htm, tapzero.

**Scope:** Phase 4 of 5.

**Codebase verified:** 2026-08-05.

---

## Acceptance Criteria Coverage

### realistic-demo-form-controls.AC3: Behaviour is preserved

- **realistic-demo-form-controls.AC3.5 Success:** The persistence
  checkbox is unchecked when persistence is off and checked when it is
  on, and reports being switched on; the reset control reports itself
  when clicked.
- **realistic-demo-form-controls.AC3.6 Success:** The gone view's
  create-new control reports itself when clicked.
- **realistic-demo-form-controls.AC3.7 Success:** The storage panel's
  request button reports clicks and is disabled when storage is
  already persistent or a request is pending.

### realistic-demo-form-controls.AC5: Layout survives the swap

- **realistic-demo-form-controls.AC5.4 Success:** The two `example/`
  pages keep their present button look, styled by `example/style.css`'s
  bare `button` rule applying to the inner button.

---

## Verified state before this phase

Line numbers as read on 2026-08-05.

### `example-realistic-demo/client/views/persistence.ts`

Hook-free, called directly in the node suite. Lines 43-54:

```
<label class="persist-toggle">
    <input
        type="checkbox"
        checked=${persist}
        onChange=${(ev:{ currentTarget:{ checked:boolean } }) => {
            props.onToggle(ev.currentTarget.checked)
        }}
    />
    Remember this session in this browser
</label>
```

and the reset button at lines 89-91:

```
<button class="reset" onClick=${props.onReset}>
    Delete stored data
</button>
```

The sentence at line 53 is static -- it does not branch on any prop or
signal.

### `example-realistic-demo/client/views/gone.ts`

Lines 49-51:

```
<button class="create-new" onClick=${props.onCreateNew}>
    Start a new room
</button>
```

### `example-shared/storage-panel.ts`

Lines 62-71:

```
<button
    class="request-persist-btn"
    onClick=${onRequest}
    disabled=${status === 'persistent' || request === 'pending'}
>
    ${request === 'pending' ?
        'Requesting...' :
        'Request persistent storage'}
</button>
```

The button is rendered only when `status !== 'unsupported'` (line 61).

`example-shared/AGENTS.md` states the rule for this directory: "Two
consumers, so every edit is two edits ... Before editing, `grep -rn`
the export across both `example/` and `example-realistic-demo/client/`
and decide for both." Both consumers are known and named below, and
Phase 1 handled what the second one needs.

### Consumers of the shared panel

- `example/persistence-demo.ts:453-457` renders `<${StoragePanel} ... />`
- `example/multi-device-demo.ts:986-990` renders the same
- `example-realistic-demo/client/views/persistence.ts:83-87` renders it

### `example/style.css`

- lines 135-145: `input, & button { font-size: 1rem; transition: ...;
  outline: 1px solid transparent; &:focus-visible { ... } }`
- lines 151-175: bare `button { cursor: pointer; border: 1px solid
  var(--color-text); padding: 0.3rem 0.8rem; ... }`

There is **no** rule in `example/style.css` for `.request-persist-btn`,
`.copy`, `.create-new` or `.persist-toggle` -- confirmed by grep. So
the only thing styling that button on those two pages is the bare
`button` rule, which will apply to the inner `<button>` that
`substrate-button` renders. `example/style.css` does not import the
button package's sheet, so nothing outspecifies it there. This is why
the design puts `example/style.css` out of scope.

### Component behaviour confirmed from the package source

From `node_modules/@substrate-system/check-box/dist/index.js`:

- The tag is `check-box`.
- `connectedCallback` calls `render()`, which reads
  `this.textContent?.trim()` **once** (line 103) and then calls
  `replaceChildren()`, so the light-DOM children Preact placed are
  discarded after that read. This is exactly why the sentence must be
  static -- it is, so once is enough.
- With label text it renders
  `<label class="checkbox-label"><input type="checkbox" ...
  /><span>text</span></label>`.
- `checked`, `disabled`, `name` and `value` are real accessors that
  sync both the inner input and the host attribute.
- A `change` on the inner input bubbles to the host and also syncs the
  host's `checked` attribute, so `onChange` on the host fires.
- The host's own `class` attribute is untouched by the component, so
  `class="persist-toggle"` stays where the test and the CSS look for it.

### Tests

In `test/example-realistic-demo/views.ts`. These line numbers are as
read on 2026-08-05 and shift as you edit; treat them as identifiers and
match on the surrounding code rather than jumping to a line:

- lines 1096-1120 `Persistence offers a toggle that reflects and
  reports its state`. Uses `findByClass(off, 'persist-toggle')` (1100),
  then **`findByType(off, 'input').filter(node => node.props.type ===
  'checkbox')`** (1103-1104) asserting `props.checked` is `false`, then
  calls `props.onChange`, then the same filtered lookup on the `on`
  tree (1115-1116) asserting `props.checked` is `true`.
- lines 1122-1146 `Persistence says what is stored and where` --
  `findByClass` on three disclosure classes. Unaffected.
- lines 1148-1160 `Persistence reuses the shared storage panel` --
  filters `allNodes` on the `StoragePanel` component reference.
  Unaffected.
- lines 1164-1173 `Persistence offers a reset that reports itself` --
  `findByClass(tree, 'reset')`, calling `props.onClick`. Unaffected.
- lines 1181-1192 `Gone offers a way to start a new room` --
  `findByClass(..., 'create-new')`, calling `props.onClick`.
  Unaffected.
- lines 1194-1207 `Gone says both cases at once` -- `findByClass` on
  `gone-disclosure` and `findByType(gone(), 'h1')`. Unaffected: `h1`
  is not a control.

`test/example/storage-panel.ts` exercises `persistOutcome` and
`PERSIST_MESSAGES` only, never the component, so it needs no change.

So the only test edit in this phase is the checkbox lookup, in two
places: lines 1103-1104 and 1115-1116.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Convert the persistence toggle and reset

**Verifies:** realistic-demo-form-controls.AC3.5

**Files:**
- Modify: `example-realistic-demo/client/views/persistence.ts`
  lines 43-54 (the label wrapper and its checkbox)
- Modify: `example-realistic-demo/client/views/persistence.ts`
  lines 89-91 (the reset button)

**Implementation:**

The `<label class="persist-toggle">` wrapper and the `<input
type="checkbox">` inside it collapse into a single element. The class
moves to the `check-box` host, and the sentence becomes its text
content:

```ts
<check-box
    class="persist-toggle"
    checked=${persist}
    onChange=${(ev:{
        currentTarget:{ checked:boolean }
    }) => {
        props.onToggle(ev.currentTarget.checked)
    }}
>Remember this session in this browser</check-box>
```

`check-box` reads `textContent` once at connect and then calls
`replaceChildren()`, discarding what Preact put there. That is safe
here and only here: this sentence is static, so it is never re-rendered
into a node the component has already thrown away. If a later change
makes this copy branch on a signal, this element stops being the right
component -- do not make it dynamic without revisiting that.

`onChange` keeps reading `ev.currentTarget.checked`. The `change` event
bubbles from the inner input to the host, `currentTarget` is the host,
and the host's `checked` getter reads the inner input. Do not rewrite
it to `ev.target.checked`.

The reset button is a straight tag swap keeping its class:

```ts
<substrate-button class="reset" onClick=${props.onReset}>
    Delete stored data
</substrate-button>
```

Leave every `<p>` in this view alone -- the disclosures are prose, not
controls, and three tests assert they are present.

**Testing:**

One test edit, in `test/example-realistic-demo/views.ts`, inside
`Persistence offers a toggle that reflects and reports its state`
(lines 1096-1120).

Find it by its code rather than by line number, since the first edit
shifts the second:

```sh
grep -n "props.type === 'checkbox'" test/example-realistic-demo/views.ts
```
Expected before the edit: two matches, at 1104 and 1116.

Each is the tail of a
`findByType(<tree>, 'input').filter(node => node.props.type ===
'checkbox')` lookup. The filter existed to pick the checkbox out of the
view's inputs; there is now a distinct vnode type for it, so the whole
lookup becomes `findByType(<tree>, 'check-box')` and the filter goes.
The two trees differ -- the first is `off`, the second is `on` -- so
keep each one's own argument.

Everything the test asserts stays: **AC3.5** needs the box unchecked
when persistence is off, `onChange` reporting `true` when switched on,
and the box checked when persistence is on. `props.checked` and
`props.onChange` are passed to the host, so those assertions are
unchanged.

`findByClass(off, 'persist-toggle')` at line 1100 needs no change --
the class moved from the `<label>` to the `<check-box>` host, and
`findByClass` matches `props.class` either way. Confirm it still finds
exactly one.

The reset test at lines 1164-1173 uses `findByClass(tree, 'reset')` and
needs no change. **AC3.5**'s second half is verified by it continuing
to pass.

**Verification:**

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: all assertions pass.

Confirm no checkbox-by-filter lookup survives anywhere in the suite:

```sh
grep -rn "props.type === 'checkbox'" test/
```
Expected: no matches.

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Run: `npm run lint`
Expected: exits 0.

**Commit:** `feat: substrate controls in the persistence view`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Convert the gone view's create-new button

**Verifies:** realistic-demo-form-controls.AC3.6

**Files:**
- Modify: `example-realistic-demo/client/views/gone.ts` lines 49-51

**Implementation:**

A straight tag swap keeping the class:

```ts
<substrate-button class="create-new" onClick=${props.onCreateNew}>
    Start a new room
</substrate-button>
```

Nothing else in the file changes. The two disclosure paragraphs and the
`<h1>` stay as they are.

**Testing:**

No test edits. `Gone offers a way to start a new room` (lines
1181-1192) uses `findByClass(..., 'create-new')` and calls
`props.onClick`, and the class stays on the host. **AC3.6** is verified
by that test continuing to pass unedited.

`Gone says both cases at once` (lines 1194-1207) asserts
`findByType(gone(), 'h1').length === 1`. `h1` is not a control and is
not converted, so this is unaffected. Confirm it still passes rather
than assuming.

**Verification:**

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: all assertions pass with no test edits.

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Run: `npm run lint`
Expected: exits 0.

**Commit:** `feat: substrate button in the gone view`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Convert the shared storage panel's request button

**Verifies:** realistic-demo-form-controls.AC3.7,
realistic-demo-form-controls.AC5.4

**Files:**
- Modify: `example-shared/storage-panel.ts` lines 62-71

**Implementation:**

This is a shared module. Per `example-shared/AGENTS.md`, decide for
both consumers rather than for the caller that prompted the change.
Both are known: `example/persistence-demo.ts:453` and
`example/multi-device-demo.ts:986` render this panel, alongside
`example-realistic-demo/client/views/persistence.ts:83`. The conversion
is right for all three, and it does not need a prop to vary by page --
the button is the same control everywhere.

A straight tag swap keeping every prop:

```ts
<substrate-button
    class="request-persist-btn"
    onClick=${onRequest}
    disabled=${status === 'persistent' ||
        request === 'pending'}
>
    ${request === 'pending' ?
        'Requesting...' :
        'Request persistent storage'}
</substrate-button>
```

The conditional label is safe. Both branches are plain strings in the
same child position, so Preact diffs text to text and mutates the same
text node's data -- and that node is the one `substrate-button` moved
into its inner `<span class="btn-content">` at connect. The label
therefore still changes to `Requesting...` and back.

Keep the `${status !== 'unsupported' ? ... : null}` guard at line 61 as
it is. A browser with no storage API is still offered nothing.

Leave `PERSIST_MESSAGES`, `persistOutcome` and the whole
`.persist-result-slot` block untouched -- no control lives in them, and
`test/example/storage-panel.ts` covers that half.

**What this does to the `example/` pages.** Their look is preserved,
and by a mechanism worth stating so a later reader does not "fix" it:
`example/style.css` has a bare `button` rule (lines 151-175) that now
applies to the inner `<button>` rather than to the host, and there is
no `.request-persist-btn` rule anywhere in that file. `example/`'s
pages do not import the button package's sheet, so nothing there
outspecifies the bare rule. Do not add `@substrate-system/button/css`
to `example/style.css` -- that would restyle those two pages, which is
out of scope for this work.

**Testing:**

No test edits. `test/example/storage-panel.ts` exercises
`persistOutcome` and `PERSIST_MESSAGES` and never renders the
component, so it is unaffected -- confirm it still passes rather than
assuming.

`Persistence reuses the shared storage panel` (views.ts lines
1148-1160) filters `allNodes` on the `StoragePanel` component
reference, not on any tag, so it is unaffected too.

**AC3.7** -- the request button reporting clicks and disabling when
persistent or pending -- has **no existing automated coverage**: no
test renders `StoragePanel` and reads its button. This task does not
add one, because doing so would be new coverage rather than a
conversion, and the phase's job is to not change behaviour. It is
recorded instead in `test-requirements.md`, alongside these phase files
in this plan directory, which names AC3.7 explicitly as knowingly
uncovered and says how to check it by hand.

Do not silently treat this AC as covered. If `test-requirements.md` is
present and does not mention AC3.7, say so before finishing the phase
-- that would mean the deferral was lost. Its absence is not a reason
to stop working: the conversion in this task stands on its own.

**Verification:**

```sh
npx esbuild test/example/storage-panel.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: all assertions pass.

Run: `npm run test:node`
Expected: the full suite passes. Run the whole suite here rather than
one file -- this is the shared module, and the whole-suite run is what
covers the second consumer.

Run: `npm run build-example`
Expected: succeeds. This is what proves the `example/` pages still
build with a custom element in a shared component.

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Run: `npm run lint`
Expected: exits 0.

**Commit:** `feat: substrate button in the shared storage panel`
<!-- END_TASK_3 -->

---

## Phase 4 done when

1. `npm run test:node` passes in full.
2. `npx tsc -p tsconfig.json --noEmit` reports no errors.
3. `npm run build:realistic` succeeds.
4. `npm run build-example` succeeds.
5. `rm -rf example-realistic-demo/public`, then `npm run lint` exits 0.
   See the standing hazard in `phase_01.md`. `npm run build-example`
   writes to the repo-root `public/`, which eslint does already ignore,
   so only the realistic demo's output needs removing.

All thirteen controls are now substrate components -- four in Phase 2,
five in Phase 3 and four here. Only the CSS is left.

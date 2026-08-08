# Substrate form controls -- Phase 2: setup and room link

**Goal:** Convert the four controls in `setup.ts` and `room-link.ts` to
`substrate-input` and `substrate-button`, and move their tests onto the
new vnode types.

**Architecture:** Most of this is a tag swap that keeps the existing
class, `type` and `aria-label`. One site changes shape: `setup.ts`
drops its `<label for>` in favour of a `label="Your name"` prop, and
the component generates the `for`/`id` pair itself. Tests move with the
code in the same phase, because `test/example-realistic-demo/views.ts`
asserts on vnode types and a converted view with unconverted
assertions is a failing phase.

**Tech Stack:** TypeScript, Preact + htm, tapzero.

**Scope:** Phase 2 of 5.

**Codebase verified:** 2026-08-05.

---

## Acceptance Criteria Coverage

### realistic-demo-form-controls.AC3: Behaviour is preserved

- **realistic-demo-form-controls.AC3.1 Success:** The setup name field
  reports what was typed, the submit button reports submission, and
  both are disabled while the form is busy. An empty or
  whitespace-only name disables the button.
- **realistic-demo-form-controls.AC3.2 Success:** The room-link URL
  field is readonly and holds the whole absolute URL; the copy button
  reports clicks and carries an accessible name; the confirmation
  appears only after a copy.

### realistic-demo-form-controls.AC4: Every field is labelled

- **realistic-demo-form-controls.AC4.1 Success:** The setup name field
  carries a non-empty `label`, so it is labelled -- asserted as
  "labelled", not as what the label says.

---

## Verified state before this phase

Line numbers are as read on 2026-08-05.

### `example-realistic-demo/client/views/setup.ts`

`SetupForm` is the presentational half, driven entirely by props and
hook-free so the node suite can call it as a plain function. It renders,
at lines 46-67:

```
<form class="setup-form" onSubmit=${...}>
    <label for="display-name">Your name</label>      line 54
    <input                                            lines 55-64
        id="display-name"
        name="display-name"
        autocomplete="nickname"
        value=${name}
        disabled=${busy}
        onInput=${...}
    />
    <button type="submit" disabled=${!ready}>${label}</button>   line 65
</form>
```

`label` at lines 42-44 is the button's text, and it varies: `Creating...`
/ `Create room` / `Asking...` / `Ask to join`.

### `example-realistic-demo/client/views/room-link.ts`

`RoomLink` is the presentational half; `ShareRoomLink` is the stateful
one holding the clipboard call. Only `RoomLink` has controls, at lines
26-43:

```
<div class="room-link">
    <input class="room-url" readonly=${true}          lines 28-32
           value=${url} aria-label="Room URL" />
    <button class="copy" type="button"                lines 33-38
            aria-label="Copy room URL" onClick=${onCopy}>Copy</button>
    ${copied ? html`<span class="copied" role="status">Copied</span>`
             : null}
</div>
```

### Tests in `test/example-realistic-demo/views.ts`

- Lines 47-77 `SetupForm offers a name field and a submit button`.
  Uses `findByType(tree, 'input')` (line 50), asserts `props.value`
  (53), asserts a non-empty `props.id` (57-60), then
  `findByType(tree, 'label')` (62) and asserts `labels[0].props.for ===
  inputs[0].props.id` (64-68), then `findByType(tree, 'button')` (70)
  and asserts `props.type === 'submit'` (72-76).
- Lines 79-100 `SetupForm will not submit without a name`. Three
  `findByType(..., 'button')[0].props.disabled` assertions (82, 89, 96).
- Lines 102-115 `SetupForm disables itself while a room is being
  created`. `findByType(tree, 'button')[0].props.disabled` (106) and
  `findByType(tree, 'input')[0].props.disabled` (111).
- Lines 117-136 `SetupForm reports what was typed and when it was
  submitted`. `findByType(tree, 'input')[0].props.onInput` (127) and
  `findByType(tree, 'form')[0].props.onSubmit` (132).
- Lines 147-162 `RoomLink shows the whole absolute URL`. Uses
  `findByClass(tree, 'room-url')` -- class-based, so unaffected.
- Lines 164-177 `RoomLink has a copy control that reports the copy`.
  Uses `findByClass(tree, 'copy')` -- unaffected.
- Lines 179-190 `RoomLink confirms a copy only once one has happened`.
  Uses `findByClass(..., 'copied')` on the span -- unaffected.

`findByType(root, type)` and `findByClass(root, className)` are defined
in `test/example/vnode.ts` (lines 54-60). `findByType` matches
`node.type === type` against the vnode type string; `findByClass`
matches `node.props.class === className`. htm builds a vnode whose type
is the string `'substrate-input'` whether or not the element is
registered, so no test needs a DOM.

### Component behaviour confirmed by reading the package source

From `node_modules/@substrate-system/input/dist/index.js`:

- The tag is `substrate-input` (`static TAG` on line 10).
- `label` and `value` are real accessors (lines 94-116). Preact assigns
  properties when they exist on the element, so `value=${name}` goes
  through the setter, which syncs both the host attribute and the inner
  `<input>`.
- `disabled` is not an accessor but is in `observedAttributes`, so
  Preact sets it as an attribute and `handleChange_inputAttribute`
  (lines 57-71) forwards it to the inner input. `disabled=${false}`
  removes the attribute. So the busy-disable still works.
- `readonly` is in `observedAttributes` too and reaches the inner input
  the same way.
- The component renders `<label class="label-content" for="...">` only
  when the `label` attribute is present, and generates the id itself
  (`generatedInputId`, line 18) when the host carries no `id`.
- The host's `class` is copied to the inner wrapper div and is **not**
  removed from the host, so `.room-url` still matches the host.
- `aria-*` and `id` attributes are moved off the host onto the inner
  input after render (lines 156-163). This is DOM-time behaviour and
  does not affect vnode props, which is what the tests read.
- Native `input` and `change` events bubble from the inner input to the
  host, so `onInput` on the host tag fires unchanged.

From `node_modules/@substrate-system/button/dist/index.js`: the tag is
`substrate-button`, light-DOM children are moved into an inner
`<span class="btn-content">` inside an inner `<button>` at
`connectedCallback`, and the host's `class` is copied to the inner
button. Preact diffs children in before `connectedCallback`, and a
label that changes is a text node Preact mutates in place -- the same
node that was moved -- so `Creating...` / `Create room` still updates.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Convert the setup form's field and button

**Verifies:** realistic-demo-form-controls.AC3.1,
realistic-demo-form-controls.AC4.1

**Files:**
- Modify: `example-realistic-demo/client/views/setup.ts` lines 46-67
  (the returned template inside `SetupForm`)

**Implementation:**

Replace the `<label>` + `<input>` pair with a single `<substrate-input>`
carrying a `label` prop, and swap `<button>` for `<substrate-button>`.

The `<label for="display-name">` and the matching `id="display-name"`
both go. `substrate-input` renders its own `label.label-content` and
generates the `for`/`id` pair, so keeping a hand-written pair would
either duplicate the id or fight the component for it. Keep `name` --
it is what the field is called on submit, not what it is labelled.

The template becomes:

```ts
return html`
    <form
        class="setup-form"
        onSubmit=${(ev?:Event) => {
            ev?.preventDefault()
            onSubmit()
        }}
    >
        <substrate-input
            label="Your name"
            name="display-name"
            autocomplete="nickname"
            value=${name}
            disabled=${busy}
            onInput=${(ev:{ currentTarget:{ value:string } }) => {
                onName(ev.currentTarget.value)
            }}
        />
        <substrate-button
            type="submit"
            disabled=${!ready}
        >${label}</substrate-button>
    </form>
`
```

Note on `onInput`: the handler reads `ev.currentTarget.value`. The
event bubbles from the inner `<input>` to the host, and
`currentTarget` is the element the listener is attached to -- the
`<substrate-input>` host. The host's `value` getter reads the inner
input's value, so this keeps working unchanged. Do not rewrite it to
`ev.target.value`.

Do not add a `type` to the `substrate-input`: the component defaults to
`text`, which is what an untyped `<input>` was.

Keep the component's doc comment at lines 28-32 as it is -- the reason
`SetupForm` is split from `Setup` has not changed.

**Testing:**

Update `test/example-realistic-demo/views.ts`. Tests must verify:

- **AC4.1:** the field carries a non-empty `label` prop. Replace the
  label-and-`for` assertion at lines 62-68, and the `props.id`
  assertion at lines 57-60, with a single assertion that
  `props.label` is a non-empty string. Assert that it is labelled, not
  what the label says -- the root AGENTS.md forbids asserting on
  rendered copy, and the `for`/`id` pair is now the component's
  business rather than this view's.
- **AC3.1:** the field reports typing; the button submits; an empty,
  whitespace-only or busy state disables the button; busy disables the
  field.

Mechanical moves, all in
`test/example-realistic-demo/views.ts`. Line numbers are as read on
2026-08-05 and shift as you edit; treat them as identifiers and match
on the surrounding code:

- line 50 `findByType(tree, 'input')` -> `findByType(tree,
  'substrate-input')`
- lines 70, 82, 89, 96, 106 `findByType(..., 'button')` ->
  `findByType(..., 'substrate-button')`
- line 111 `findByType(tree, 'input')` -> `findByType(tree,
  'substrate-input')`
- line 127 `findByType(tree, 'input')` -> `findByType(tree,
  'substrate-input')`
- line 132 `findByType(tree, 'form')` -- unchanged, still a real
  `<form>`

A faster way to catch all of them at once, since every remaining
`findByType(..., 'input')` and `findByType(..., 'button')` in the
SetupForm tests is being moved:

```sh
grep -n "findByType([a-z]*, '\(input\|button\)')" \
    test/example-realistic-demo/views.ts
```
Expected before this task: 10 matches. Eight are SetupForm's, at 50,
70, 82, 89, 96, 106, 111 and 127, and all eight move. The other two, at
1103 and 1115, are the persistence checkbox lookups; those belong to
Phase 4 and stay for now.

The composer does not appear in this grep. Its only `findByType` is
`findByType(tree, 'label')` at 993, which Phase 3 handles.

The assertions on `props.value`, `props.disabled`, `props.type` and
`props.onInput` all stay: those props are passed to the host tag, and
`findByType` reads the vnode, not the DOM.

**Verification:**

Run the one file, per the root AGENTS.md, rather than the ten-minute
whole suite:

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: every assertion in the file passes.

esbuild only strips types, so that run says nothing about whether the
code typechecks. Also run:

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Then `npm run lint`. Expected: exits 0.

**Commit:** `feat: substrate controls in the setup form`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Convert the room link's URL field and copy button

**Verifies:** realistic-demo-form-controls.AC3.2

**Files:**
- Modify: `example-realistic-demo/client/views/room-link.ts` lines 26-43
  (the returned template inside `RoomLink`)

**Implementation:**

A straight tag swap. Both controls keep every prop they have, including
`class`, which is what the tests and the layout CSS find them by.

```ts
return html`
    <div class="room-link">
        <substrate-input
            class="room-url"
            readonly=${true}
            value=${url}
            aria-label="Room URL"
        />
        <substrate-button
            class="copy"
            type="button"
            aria-label="Copy room URL"
            onClick=${onCopy}
        >Copy</substrate-button>
        ${copied ?
            html`<span class="copied" role="status">Copied</span>` :
            null}
    </div>
`
```

This field has no `label` prop, on purpose. It carries `aria-label="Room
URL"` instead, which the component moves onto the inner input. A
visible label here would be a second name for a field whose content is
self-evidently the room's URL, and the design does not add one.

The `<span class="copied">` is untouched -- it is not a form control.

`ShareRoomLink` (lines 57-76) needs no change at all. It renders
`RoomLink` and holds the clipboard call; no control lives in it.

**Testing:**

All three `RoomLink` tests use `findByClass`, and `substrate-input` and
`substrate-button` both keep the author's `class` on the host, so
**no test changes are required**. Confirm this rather than assume it:

- lines 147-162 `findByClass(tree, 'room-url')`, asserting
  `props.value` and `props.readonly`
- lines 164-177 `findByClass(tree, 'copy')`, asserting
  `props['aria-label']` and calling `props.onClick`
- lines 179-190 `findByClass(..., 'copied')` on the span

If any of these fail, the cause is a real difference in what the vnode
carries, not a stale selector. Do not "fix" a test by loosening it --
report instead.

**Verification:**

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: all assertions pass with no edits to the RoomLink tests.

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Run: `npm run lint`
Expected: exits 0.

**Commit:** `feat: substrate controls in the room link`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

---

## Phase 2 done when

1. `npm run test:node` passes in full.
2. `npx tsc -p tsconfig.json --noEmit` reports no errors.
3. `npm run build:realistic` succeeds.
4. `rm -rf example-realistic-demo/public`, then `npm run lint` exits 0.
   See the standing hazard in `phase_01.md`: linting before that
   cleanup fails on the build's own output.

The setup form and room link now render substrate controls. The demo's
own `button` and `input` rules are still live and still fighting the
package sheets; Phase 5 removes them.

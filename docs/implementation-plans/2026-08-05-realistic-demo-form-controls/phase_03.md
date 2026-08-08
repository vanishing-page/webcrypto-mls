# Substrate form controls -- Phase 3: the room

**Goal:** Convert the five controls in `room.ts` -- approve, deny,
remove, the composer field and send -- to `substrate-button` and
`substrate-input`, and move their tests.

**Architecture:** Four of the five are a tag swap that keeps the class
every test and every layout rule finds them by. The composer field is
the one that changes shape: like the setup field, it drops its
`<label for>` for a `label="Say something"` prop. The remove button
needs no CSS change, because `substrate-button` keeps the author's
class on the host element and `grid-column: 4` therefore still lands on
a grid item.

**Tech Stack:** TypeScript, Preact + htm, tapzero.

**Scope:** Phase 3 of 5.

**Codebase verified:** 2026-08-05.

---

## Acceptance Criteria Coverage

### realistic-demo-form-controls.AC3: Behaviour is preserved

- **realistic-demo-form-controls.AC3.3 Success:** Approve reports the
  whole request and Deny reports the identity; both are shown to the
  creator and to nobody else; Remove reports the member and their leaf
  index, is offered only to the creator, and never against the person
  looking at it.
- **realistic-demo-form-controls.AC3.3 Failure:** A request whose key
  package will not decode, or whose key package belongs to somebody
  else, renders with Approve disabled rather than absent.
- **realistic-demo-form-controls.AC3.4 Success:** The composer field
  reports what was typed into `state.draft`, and Send is disabled for
  an empty or whitespace-only draft and enabled for a real one.

### realistic-demo-form-controls.AC4: Every field is labelled

- **realistic-demo-form-controls.AC4.2 Success:** The composer field
  carries a non-empty `label`.

### realistic-demo-form-controls.AC5: Layout survives the swap

- **realistic-demo-form-controls.AC5.1 Success:** The remove button
  still lands in grid column 4 of `.members .member`, with no CSS
  change, because the class stays on the host.

---

## Verified state before this phase

`example-realistic-demo/client/views/room.ts`, as read on 2026-08-05.
`Room` is hook-free and testable whole -- the root AGENTS.md says to
keep it that way, so do not add a hook while converting.

Controls, with line numbers:

- **Approve**, lines 96-100, inside the `requestItem` helper:
  `<button class="approve" disabled=${!coherent}
  onClick=${() => onApprove(request)}>Approve</button>`
- **Deny**, lines 101-104:
  `<button class="deny" onClick=${() => onDeny(request.identity)}>Deny</button>`
- **Remove**, lines 138-142, inside the `memberItem` helper:
  `<button class="remove" onClick=${() => onRemove(member)}>Remove
  ${member.name}</button>` -- note two children, the text `Remove ` and
  the interpolated name.
- **Composer label and field**, lines 375-386:
  `<label for="message-text">Say something</label>` then
  `<input id="message-text" class="draft" value=${draft}
  autocomplete="off" onInput=${...} />`. The id is the hard-coded
  string `message-text`, not generated.
- **Send**, lines 387-391: `<button class="send" type="submit"
  disabled=${draft.trim() === ''}>Send</button>`

`requestItem`, `memberItem`, `messageItem`, `placeholderItem` and
`outboundItem` are plain functions returning vnodes rather than
components, so they expand in the tree and the tests find their
controls directly.

Relevant CSS in `example-realistic-demo/client/style.css`:

- line 524: `.members .member` is
  `display: grid; grid-template-columns: var(--seq) minmax(0, 1fr) auto auto;`
- lines 561-563: `& .remove { grid-column: 4; }`
- lines 849-857, narrow viewport: `.members .member` regrids to three
  columns and `& .remove { grid-column: 2 / -1; justify-self: start; }`
- lines 478-480: `.pending .request & button { margin-right: 0.5rem; }`
  -- retargeted in Phase 5, not here
- lines 658-660: `.composer & label { flex-basis: 100%; }` -- deleted
  in Phase 5
- lines 662-665: `.composer & .draft { flex: 1 1 18rem; min-width: 0; }`

Tests in `test/example-realistic-demo/views.ts` that touch these
controls. Every one of them uses `findByClass` except the composer's
label assertion:

- 371-414 pending list shown to the creator and nobody else --
  `findByClass` on `request`, `approve`, `deny`
- 428-444 an unreadable request is listed with Approve disabled --
  `findByClass(tree, 'approve')[0].props.disabled`
- 446-485 a stolen key package disables Approve, an honest one does not
  -- `findByClass` on `approve`, `mismatch-warning`
- 529-553 approve and deny report their targets -- `findByClass` on
  `approve`, `deny`, calling `props.onClick`
- 743-754 Remove offered to the creator only -- `findByClass(...,
  'remove').length`
- 756-776 Remove never offered against the viewer -- `findByClass` on
  `member` then `remove`
- 778-798 Remove reports the member and leaf index --
  `findByClass(tree, 'remove')[0].props.onClick`
- 802-825 a removed client is offered no controls -- `findByClass` on
  `removed`, `members`, `remove`, `composer`
- 985-1010 the composer reports typing and submission --
  `findByClass(tree, 'draft')` for the field, then
  **`findByType(tree, 'label')` filtered on `props.for ===
  inputs[0].props.id`** at lines 993-998, then `findByClass(tree,
  'composer')` for the form
- 1012-1050 the composer records what is typed -- `findByClass` on
  `send` and `draft`, using `props.disabled` and `props.onInput`
- 1052-1068 Send refuses an empty message -- `findByClass(...,
  'send')[0].props.disabled`

So only one test in this phase needs an edit: the label assertion at
lines 993-998.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Convert approve, deny and remove

**Verifies:** realistic-demo-form-controls.AC3.3,
realistic-demo-form-controls.AC5.1

**Files:**
- Modify: `example-realistic-demo/client/views/room.ts` lines 96-104
  (approve and deny, in `requestItem`)
- Modify: `example-realistic-demo/client/views/room.ts` lines 138-142
  (remove, in `memberItem`)

**Implementation:**

Three tag swaps. Every prop stays, including `class`, which is what
both the tests and `grid-column: 4` find these by.

Approve and deny become:

```ts
<substrate-button
    class="approve"
    disabled=${!coherent}
    onClick=${() => onApprove(request)}
>Approve</substrate-button>
<substrate-button
    class="deny"
    onClick=${() => onDeny(request.identity)}
>Deny</substrate-button>
```

Remove becomes:

```ts
<substrate-button
    class="remove"
    onClick=${() => onRemove(member)}
>Remove ${member.name}</substrate-button>
```

Keep both children of the remove button as they are. `substrate-button`
moves light-DOM children into an inner `<span class="btn-content">` at
`connectedCallback`, which happens after Preact has placed them, and a
name that changes is a text node Preact mutates in place -- the node
that moved. So the interpolation keeps working.

No CSS change is needed for `grid-column: 4`. `substrate-button` copies
the host's `class` to its inner button but does not remove it from the
host, so `.members .member .remove` still matches the host, which is
still the grid item. The inner button also carries `remove` and so also
matches that selector, but `grid-column` on something that is not a
grid item has no effect, so it is inert rather than wrong.

Do not add `type="button"` to any of these three. They are not inside a
`<form>`, so the implicit type is already right, and adding one is a
behaviour change smuggled in under a refactor.

**Testing:**

No test edits. Every assertion for these three uses `findByClass`, and
the class stays on the host. AC3.3 is verified by the existing tests
continuing to pass:

- both polarities of who sees the pending list (371-414)
- Approve disabled for an undecodable key package (428-444) and for a
  stolen one, with the honest case still approvable (446-485)
- approve and deny reporting their targets (529-553)
- Remove offered to the creator only (743-754), never against the
  viewer (756-776), reporting member and leaf index (778-798)
- a removed client offered no controls (802-825)

Run them and confirm they pass unedited. If one fails, the vnode really
does carry something different -- report it rather than relaxing the
assertion.

**Verification:**

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: all assertions pass, with no edits to the tests above.

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Run: `npm run lint`
Expected: exits 0.

**Commit:** `feat: substrate buttons for approve, deny and remove`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Convert the composer field and send button

**Verifies:** realistic-demo-form-controls.AC3.4,
realistic-demo-form-controls.AC4.2

**Files:**
- Modify: `example-realistic-demo/client/views/room.ts` lines 375-391
  (the composer's label, field and send button)

**Implementation:**

The `<label for="message-text">` and the hard-coded `id="message-text"`
both go, replaced by a `label` prop. `substrate-input` renders its own
`label.label-content` and generates the `for`/`id` pair, so a
hand-written pair would fight it for the id.

```ts
<substrate-input
    label="Say something"
    class="draft"
    value=${draft}
    autocomplete="off"
    onInput=${(ev:{
        currentTarget:{ value:string }
    }) => {
        state.draft.value = ev.currentTarget.value
    }}
/>
<substrate-button
    class="send"
    type="submit"
    disabled=${draft.trim() === ''}
>Send</substrate-button>
```

Keep `class="draft"` -- three tests find the field by it, and Phase 5
retargets `.composer .draft` to the host.

Keep `autocomplete="off"`. It is in the component's forwarded attribute
list and reaches the inner input.

`onInput` keeps reading `ev.currentTarget.value`. The event bubbles
from the inner input to the host, `currentTarget` is the host, and the
host's `value` getter reads the inner input's value. Do not rewrite it
to `ev.target.value`.

`type="submit"` stays on the send button: this one *is* inside the
composer `<form>`, and `substrate-button` forwards `type` to the inner
button, which is what makes Enter submit.

**Testing:**

One test edit, at `test/example-realistic-demo/views.ts` lines 993-998,
inside `Room composer reports what was typed and what was submitted`.

Replace the label-and-`for` assertion:

```ts
const labels = findByType(tree, 'label')
t.equal(
    labels.filter(node => node.props.for === inputs[0].props.id).length,
    1,
    'with a label pointing at it'
)
```

with an assertion that the field is labelled -- **AC4.2** -- rather
than an assertion about how it is labelled. The `for`/`id` pair is the
component's business now, and the root AGENTS.md forbids asserting on
rendered copy, so assert that `props.label` is a non-empty string and
nothing about its words.

`inputs` on line 989 is already `findByClass(tree, 'draft')`, which
still finds the host, so the surrounding test needs no other change.

Everything else in this task's scope is already class-based and needs
no edit:

- lines 985-1010, the rest of the test: `findByClass(tree, 'draft')`
  asserting `props.value`, and `findByClass(tree, 'composer')` calling
  `props.onSubmit` -- **AC3.4**
- lines 1012-1050, typing reaching `state.draft` and enabling send:
  `findByClass(..., 'send')[0].props.disabled` and
  `findByClass(..., 'draft')[0].props.onInput` -- **AC3.4**, including
  the transition rather than just the empty case
- lines 1052-1068, send disabled for empty and whitespace-only drafts
  and enabled for a real one -- **AC3.4**, both polarities

**Verification:**

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: all assertions pass.

Confirm no `findByType(..., 'label')` remains in the composer test --
the whole point of the edit is that the view no longer renders one:

```sh
grep -n "findByType(tree, 'label')" test/example-realistic-demo/views.ts
```
Expected: no match inside the composer test.

```sh
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Run: `npm run lint`
Expected: exits 0.

**Commit:** `feat: substrate controls in the room composer`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

---

## Phase 3 done when

1. `npm run test:node` passes in full.
2. `npx tsc -p tsconfig.json --noEmit` reports no errors.
3. `npm run build:realistic` succeeds.
4. `rm -rf example-realistic-demo/public`, then `npm run lint` exits 0.
   See the standing hazard in `phase_01.md`.

Every control in `room.ts` is now a substrate component. The demo's own
control rules are still live; Phase 5 removes them.

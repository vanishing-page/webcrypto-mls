# Room "You" section -- Phase 1: The copy control

**Goal:** Add a copy control that works on a plain string, testable
without a browser.

**Architecture:** One new file, `views/copy-value.ts`, holding the same
presentational/wired split that `views/room-link.ts` already uses.
`CopyControl` is the button plus the `role="status"` confirmation and
takes `copied` as a prop, so it can be called as a plain function in the
Node suite. `CopyValue` holds the `copied` signal, calls
`navigator.clipboard.writeText` and reports a refusal through `onError`.
Nothing else in the app changes this phase -- `Room` does not render
`CopyValue` until Phase 2.

**Tech Stack:** TypeScript, Preact, `htm/preact`, `@preact/signals`,
`@substrate-system/tapzero`. No new dependency.

**Scope:** Phase 1 of 4 from
`docs/design-plans/2026-08-06-room-you-section.md`.

**Codebase verified:** 2026-08-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### room-you-section.AC3: The key can be copied

- **room-you-section.AC3.1 Success:** the block renders one copy
  control, labelled for the key rather than "Copy"
- **room-you-section.AC3.2 Success:** the confirmation appears only
  after a copy has happened
- **room-you-section.AC3.3 Failure:** a clipboard refusal goes to
  `state.status` and the confirmation does not appear

**How much of each this phase can prove.** Two of these three are only
partly reachable here, and the reason is structural rather than a
shortcut:

- **AC3.1 -- partial.** There is no block until Phase 2, so this phase
  proves only that `CopyControl` renders exactly one button and that the
  button's accessible name is the `label` it was given. Phase 2
  completes it by asserting the `.you` block renders one `CopyValue`
  whose `label` differs from the room link's.
- **AC3.2 -- complete.** `CopyControl` takes `copied` as a prop, so both
  polarities are directly assertable here.
- **AC3.3 -- partial.** `CopyValue` calls `useSignal`, and
  `/Users/nick/code/webcrypto-mls/AGENTS.md` lines 63-66 state that a
  component which calls a hook cannot be tested by calling it as a plain
  function at all -- which is the only way this suite tests views. There
  is also no `navigator.clipboard` stub anywhere in `test/`. So this
  phase proves only the second half, that no confirmation renders
  without a copy. Phase 2 proves the refusal reaches `state.status`, by
  taking the `CopyValue` vnode out of the rendered `Room` tree and
  calling its `onError` prop. The real clipboard refusal is
  human-verified; `example-realistic-demo/AGENTS.md` lines 598-602
  already record "a real clipboard paste" as something neither harness
  reaches.

---

## Conventions this phase must follow

Read these before writing code. They are the project's own rules, not
this plan's.

- `/Users/nick/code/webcrypto-mls/AGENTS.md` lines 44-66 -- how tests
  are registered, the fast single-file run, and the rule that components
  are asserted on by calling them as plain functions and reading the
  returned vnode. Never assert on rendered HTML text.
- `/Users/nick/code/webcrypto-mls/AGENTS.md` line 78 -- TypeScript lines
  stay within 80 columns.
- ESLint (`/Users/nick/code/webcrypto-mls/eslint.config.js` lines 55-90)
  enforces `@typescript-eslint/consistent-type-imports` (use
  `import type`) and `@stylistic/type-annotation-spacing` with no space
  either side of the colon -- write `value:string`, not
  `value: string`.
- The practised component style in
  `example-realistic-demo/client/views/`: a named exported
  `interface {Name}Props`, and the component typed as
  `FunctionComponent<{Name}Props>` assigned from a `function`
  expression. See `views/room-link.ts` lines 5-25 and 47-60.

`test/example-realistic-demo/views.ts` is already imported by
`test/index.ts` at line 48, so tests added to it need no registration.

---

## The branch baseline is one test short of green

Run the view suite before you touch anything:

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```

Expected on a clean tree: **`# fail 1`**. The one failure reports as
`not ok 105 the explanation stands beside the timeline, always`, which is
the assertion message inside the test
`Room says what a placeholder stands for`
(`test/example-realistic-demo/views.ts:1074-1080`). It asserts a
`placeholder-disclosure` that `room.ts` stopped rendering in commit
`e222c20` ("better ux"). It predates this feature and nothing in this
plan touches it.

Two consequences for every phase of this plan:

- Verification steps expect `# fail 1`, not `# fail 0`, and the named
  failure must be that one. A second failure is yours.
- `npm run test:node` is red for the same reason, so the phase gate is
  "no new failures", not "the suite passes".

Fixing that test is out of scope here. Whether the disclosure should come
back into `room.ts` or the test should go is a question about the
timeline work, not about this block. If somebody fixes it first, every
expectation below becomes `# fail 0`.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: `CopyControl` and `CopyValue` in a new `copy-value.ts`

**Verifies:** none directly -- this task creates the code that Task 2
tests.

**Files:**
- Create:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/client/views/copy-value.ts`

Verified: this file does not currently exist. The directory holds
`explainer.ts`, `gone.ts`, `persistence.ts`, `room-link.ts`, `room.ts`,
`setup.ts`, `waiting.ts` and no barrel/index file, so nothing needs to
be updated to register a new view module.

**Implementation:**

Write the file exactly as below. It mirrors `views/room-link.ts`
deliberately: same import list, same split, same `onError` contract,
same `class="copy"` on the button and `class="copied" role="status"` on
the confirmation, so the two copy controls behave and read the same way.

```ts
import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { useSignal } from '@preact/signals'

export interface CopyControlProps {
    /** Whether a copy has happened, so it can be confirmed. */
    copied:boolean

    /**
     * The button's accessible name. Required, and not defaulted: once
     * the room has two copy buttons in one column, "Copy" alone does
     * not say which value it takes.
     */
    label:string

    onCopy:() => void
}

/**
 * A control that copies some value the caller renders itself, and says
 * so once it has. Presentational only -- the clipboard call and the
 * "copied" flag live in `CopyValue` below, which is what keeps this
 * half assertable without a browser.
 */
export const CopyControl:FunctionComponent<CopyControlProps> = function ({
    copied,
    label,
    onCopy
}) {
    return html`
        <div class="copy-value">
            <substrate-button
                class="copy"
                type="button"
                aria-label=${label}
                onClick=${onCopy}
            >Copy</substrate-button>
            ${copied ?
                html`<span class="copied" role="status">Copied</span>` :
                null}
        </div>
    `
}

export interface CopyValueProps {
    /** The string the control puts on the clipboard. */
    value:string

    /** The button's accessible name; see `CopyControlProps`. */
    label:string

    /** Where a clipboard refusal goes; the views send it to `status`. */
    onError:(err:unknown) => void
}

/**
 * The same control, wired to the clipboard. The caller renders the
 * value and passes it here, so the value stays in the caller's own
 * vnode tree and remains assertable.
 */
export const CopyValue:FunctionComponent<CopyValueProps> = function (
    { value, label, onError }
) {
    const copied = useSignal(false)

    async function copy ():Promise<void> {
        try {
            await navigator.clipboard.writeText(value)
            copied.value = true
        } catch (err) {
            onError(err)
        }
    }

    return html`<${CopyControl}
        copied=${copied.value}
        label=${label}
        onCopy=${() => { copy() }}
    />`
}
```

Two points worth not changing:

1. `CopyControl` does not take `value`. It never renders it -- the
   caller does -- and an unused prop would fail
   `@typescript-eslint/no-unused-vars`.
2. `substrate-button` needs no import. It is a custom element
   registered elsewhere in the app; `views/room-link.ts` uses it with
   the same three imports and nothing more.

**Verification:**

Run:
```sh
npx eslint example-realistic-demo/client/views/copy-value.ts
```
Expected: no output, exit 0.

Run:
```sh
npx tsc --noEmit
```
Expected: exactly one error, and it is the pre-existing one on this
branch:
```
test/test-vectors/key-schedule.ts(73,9): error TS2769: No overload matches this call.
```
`tsconfig.json` sets `"listFiles": true`, so this command also prints
every file it checked -- that output is normal. Confirm with
`npx tsc --noEmit 2>&1 | grep "error TS"` that the key-schedule line is
the only error. Any error naming `copy-value.ts` is yours to fix.

**Commit:**
```sh
git add example-realistic-demo/client/views/copy-value.ts
git commit -m "feat: add a copy control for a plain string"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for `CopyControl`

**Verifies:** `room-you-section.AC3.1` (partial -- one control, named by
its `label`), `room-you-section.AC3.2` (complete),
`room-you-section.AC3.3` (partial -- no confirmation without a copy)

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/test/example-realistic-demo/views.ts`
  (unit)

Two edits to that file, both alongside the existing `RoomLink` tests.

**Edit 1 -- add the import.** The file currently imports the room link
at lines 18-19:

```ts
import { RoomLink, ShareRoomLink } from
    '../../example-realistic-demo/client/views/room-link.js'
```

Add directly beneath it:

```ts
import { CopyControl } from
    '../../example-realistic-demo/client/views/copy-value.js'
```

The `.js` extension on a `.ts` source is this suite's convention; every
import in the file is written that way.

**Edit 2 -- add a helper and two tests** immediately after the existing
`RoomLink confirms a copy only once one has happened` test, which ends
at line 188. Put them there rather than at the end of the file so the
two copy controls' tests read together.

The helper mirrors `roomLink` at lines 136-143, including the trailing
`{}` second argument that calls a `FunctionComponent` as a plain
function:

```ts
function copyControl (
    props:Partial<Parameters<typeof CopyControl>[0]> = {}
) {
    return CopyControl({
        copied: false,
        label: 'Copy your signature public key',
        onCopy: () => {},
        ...props
    }, {})
}
```

The spread comes last, so a caller's `props` override the defaults.

**Testing:**

Tests must verify the ACs listed above:

- **AC3.1 (partial):** exactly one copy button renders, and its
  accessible name is the `label` it was given. Assert the `aria-label`
  prop equals the string the helper passed -- a props-flow assertion,
  the same idiom as `inputs[0].props.value` at views.ts line 53. Do not
  assert a literal label string chosen by the component; the component
  chooses no label.
- **AC3.2:** with `copied: false` no element of class `copied` renders;
  with `copied: true` exactly one does.
- **AC3.3 (partial):** covered by the `copied: false` half of AC3.2 --
  a refusal leaves `copied` false, and false renders no confirmation.

Write:

```ts
test('CopyControl has one copy button, named for its value', t => {
    let copies = 0
    const label = 'Copy your signature public key'
    const tree = copyControl({ label, onCopy: () => { copies++ } })

    const buttons = findByClass(tree, 'copy')
    t.equal(buttons.length, 1, 'should render one copy button')
    t.equal(
        buttons[0].props['aria-label'],
        label,
        'the button should be named for the value it copies'
    )

    ;(buttons[0].props.onClick as () => void)()
    t.equal(copies, 1, 'clicking should call onCopy')
})

test('CopyControl confirms a copy only once one has happened', t => {
    t.equal(
        findByClass(copyControl({ copied: false }), 'copied').length,
        0,
        'should show no confirmation before a copy'
    )
    t.equal(
        findByClass(copyControl({ copied: true }), 'copied').length,
        1,
        'should show one confirmation after a copy'
    )
})
```

`findByClass` and `test` are already imported by this file --
`findByClass` comes from `../example/vnode.js` at line 35. Note that
`findByClass` matches `node.props.class` by exact string equality, so
the button's `class` must stay the single word `copy` as written in Task
1; adding a second class to it would make these tests stop finding it.

The leading `;` before `(buttons[0]...` is required and is the existing
idiom at views.ts line 173 -- without it the previous line's `)`
continues into a call expression.

**Verification:**

Run the fast single-file bundle (the pattern from AGENTS.md lines 52-56):
```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: TAP output including
`# CopyControl has one copy button, named for its value` and
`# CopyControl confirms a copy only once one has happened`, every
assertion in those two passing, and `# fail 1` -- the pre-existing
`placeholder-disclosure` failure and nothing else.

Run:
```sh
npx eslint test/example-realistic-demo/views.ts
```
Expected: no output, exit 0.

Run:
```sh
npx tsc --noEmit 2>&1 | grep "error TS"
```
Expected: only the pre-existing `key-schedule.ts(73,9)` error.

**Commit:**
```sh
git add test/example-realistic-demo/views.ts
git commit -m "test: cover the copy control"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

---

## Phase 1 done when

1. `npx eslint example-realistic-demo/client/views/copy-value.ts test/example-realistic-demo/views.ts`
   is clean.
2. `npx tsc --noEmit 2>&1 | grep "error TS"` reports only the
   pre-existing `key-schedule.ts(73,9)` error.
3. `npm run test:node` reports no failure other than the pre-existing
   `placeholder-disclosure` one. This runs the whole suite and takes over
   ten minutes (AGENTS.md line 51), so use the single-file bundle above
   during the work and run this once to close the phase.

`CopyValue` is exported and unused at the end of this phase. That is
expected -- Phase 2 is what renders it. It is exported rather than
local, so no lint rule objects.

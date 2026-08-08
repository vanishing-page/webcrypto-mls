# Substrate form controls -- Phase 5: CSS cleanup

**Goal:** Delete the demo's private copy of control styling, retarget
the layout rules that survive onto the new tags, and keep the one rule
that is about content rather than about controls.

**Architecture:** The package sheets and the demo's own rules describe
the same controls differently, and `substrate-button button`
outspecifies a bare `button`, so leaving both in place yields neither
design. The control rules go. Layout is the demo's, not the packages',
so it survives -- but its selectors move to the new tags. One rule is
kept and moved deliberately: `.room-url` stays monospaced, because "a
machine value is set in mono" is a rule about content that also governs
`.seq`, `.epoch` and `.status`.

**Tech Stack:** CSS with nested selectors, lightningcss via vite.

**Scope:** Phase 5 of 5.

**Codebase verified:** 2026-08-05.

---

## Acceptance Criteria Coverage

### realistic-demo-form-controls.AC2: The packages' CSS styles them

- **realistic-demo-form-controls.AC2.2 Success:** The demo's own
  control rules are gone, so no demo rule competes with a package rule
  for the same control.

### realistic-demo-form-controls.AC5: Layout survives the swap

- **realistic-demo-form-controls.AC5.2 Success:** The setup field, the
  composer field and the room URL field keep their flex sizing.
- **realistic-demo-form-controls.AC5.3 Success:** The room URL is still
  set in mono, and so are `.seq`, `.epoch`, `.presence` and `.status`.

### realistic-demo-form-controls.AC6: The suite passes

- **realistic-demo-form-controls.AC6.1 Success:** `npm run lint` exits 0.
- **realistic-demo-form-controls.AC6.2 Success:** `npm run test:node`
  passes.
- **realistic-demo-form-controls.AC6.3 Success:**
  `npm run build:realistic` succeeds.

---

## Verified state before this phase

All in `example-realistic-demo/client/style.css`, 868 lines total, read
on 2026-08-05. Every line range the design cites was checked against
the file and every one matches.

**Important:** these line numbers are for the file as it stands *now*.
Each deletion shifts everything below it. Work **bottom-up**, from the
highest line number to the lowest, or locate each rule by its selector
text rather than by number. Do not work top-down off this list.

### To delete

| Lines | Rule |
|-------|------|
| 195-202 | The `Controls` section comment |
| 204-231 | `button` -- filled accent, uppercase, square |
| 233 | The comment `/* The second rank: ... */` |
| 234-247 | `.deny, .remove, .reset, .request-persist-btn` |
| 249-263 | `input[type="text"], input:not([type])` |
| 265-269 | `input[type="checkbox"]` |
| 271-273 | `input:focus-visible` |
| 275-285 | `label` |

The two comments at 195-202 and 233 are not in the design's table, but
they go with the rules they explain. 195-202 reads "Square, hairlined,
and uppercase. Two ranks only: a filled one for the action a view
exists to offer, and an outlined one for everything else" -- a
description of exactly the design being removed. Leaving it would
document the page as it is no longer.

The `label` rule goes because after Phases 2-4 the demo has no bare
`<label>` of its own left. Verified: the only three in
`example-realistic-demo/client/` and `example-shared/` were
`setup.ts:54`, `room.ts:375` and `persistence.ts:43`, all converted.
`substrate-input` renders `label.label-content` and `check-box` renders
`label.checkbox-label`, both inside the component and both styled by
the package sheets.

### To retarget

- **334-340** `.room-link & .room-url`
  -> `& substrate-input.room-url`, keeping `flex` and `min-width`
- **364-366** `.setup .setup-form & label` -> deleted
- **368-372** `.setup .setup-form & input`
  -> `& substrate-input`, keeping `flex` and `min-width`
- **478-480** `.pending .request & button`
  -> `& substrate-button`, keeping every declaration
- **658-660** `.composer & label` -> deleted
- **662-665** `.composer & .draft`
  -> `& substrate-input.draft`, keeping every declaration
- **727-737** `.persistence & .persist-toggle`
  -> `& check-box.persist-toggle`, keeping `margin-bottom`

The design describes the `.room-url` change as dropping "border and
background". This plan drops its `padding` as well, which is one step
past what the design says. The reason is the design's own: padding is
control skin, and the package sheet sets its own. Keeping the demo's
padding would add to the package's rather than replace it. Flagged
here because it is an extension of the design, not a reading of it.

### To keep, moved

Lines 149-160 are the machine-values group. The file writes one
selector per line, at 149-155:

```css
.epoch,
.live li,
.room-url,
.seq,
.seq-pending,
.presence,
.status {
    font-family: var(--font-mono);
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
    hyphens: none;
}
```

`.room-url` comes out of that selector list and gets its own rule
targeting the inner input, because an `<input>` does not inherit the
host's font.

### Needs no change

- Lines 561-563, `.members .member & .remove { grid-column: 4; }`.
  `substrate-button` copies the host's class to its inner button but
  does not remove it from the host, so this still matches the grid
  item. It also matches the inner button, where `grid-column` is inert.
- Lines 849-857, the narrow-viewport `.members .member` block and its
  `& .remove { grid-column: 2 / -1; justify-self: start; }`, for the
  same reason.
- Lines 739-741, `.persistence & .reset { margin-top: 1rem; }`. This
  one is easy to delete by association, because its sibling rule
  `.deny, .remove, .reset, .request-persist-btn` at 234-247 *is*
  deleted. Keep it. That rule was control skin; this one is spacing,
  it is the demo's, and the class stays on the `substrate-button` host,
  so it still applies. It sits directly below the `.persist-toggle`
  block you are editing in Task 2 -- do not take it with you.

### Deliberately out of scope

- `example/style.css`. Its bare `button` rule (lines 151-175) now
  styles the inner `<button>` that `substrate-button` renders, which is
  what keeps those pages looking as they do. Do not touch it, and do
  not add a package sheet import to it.
- `example-shared/card-header.ts`'s `<button class="clear">`. It looks
  like a fourteenth control, and it is not in scope: it is rendered
  only by `example/tree-diagram.ts:156` and
  `example/device-info-panel.ts:68`, both `example/` pages, and never
  by the realistic demo. Converting it would change two pages this work
  is not about, and `test/example/card-header.ts` asserts on it. Leave
  it alone.

---

<!-- START_TASK_1 -->
### Task 1: Delete the demo's control rules

**Verifies:** realistic-demo-form-controls.AC2.2

**Files:**
- Modify: `example-realistic-demo/client/style.css`, deleting lines
  195-285

**Implementation:**

Delete the whole `Controls` section: the comment header at 195-202, the
`button` rule at 204-231, the second-rank comment at 233 and its rule
at 234-247, the two `input` rules at 249-263 and 265-269, the
`input:focus-visible` rule at 271-273, and the `label` rule at 275-285.

That is one contiguous span, lines 195 through 285 inclusive. Delete it
whole, and delete the blank line left behind so the file does not gain
a double gap between the sections that were on either side of it.

Do not replace it with a comment saying the styling moved. The three
`@import` lines added in Phase 1 already say where the control styling
comes from, and a note here would be a second place to keep true.

Nothing else in the file changes in this task. Layout retargeting is
Task 2 and the mono rule is Task 3, kept separate so a bisect can tell
"the controls lost the demo's skin" apart from "the layout moved".

**Testing:**

No test. The project asserts on vnodes and never on CSS -- the root
AGENTS.md forbids asserting on rendered HTML text, and there is no
stylesheet test harness here. Verified operationally by the build, and
by human review recorded in `test-requirements.md`.

**Verification:**

Confirm the bare control selectors are gone:

```sh
grep -nE "^(button|label|input)[ ,{:[]" \
    example-realistic-demo/client/style.css
```
Expected: no matches. The `:` and `[` in the character class matter:
without them the pattern misses `input[type="text"]` at 249,
`input[type="checkbox"]` at 265 and `input:focus-visible` at 271, which
are three of the six rules this task deletes.

Confirm nothing else was taken with them -- the other bare element
selectors in this file are prose styling and must survive:

```sh
grep -nE "^(html|body|h1|p|li|a|code)[ ,{]" \
    example-realistic-demo/client/style.css
```
Expected: 8 matches, at lines 30, 34, 97, 111, 112, 116, 121 and 138 --
`html`, `body`, `h1`, the `p,` / `li {` pair, a second `p {` rule at
116, `a`, and `code`. The count is 8 both before and after the
deletion: every one of them sits above line 195, so none of them moves.

`dt`, `dd` and `ol` are prose selectors too but are nested (`& dt` at
404, `& dd` at 413, `& ol` at 792), so an anchored pattern cannot see
them. Check them separately if you want the reassurance:

```sh
grep -nE "^\s+& (dt|dd|ol)[ ,{]" example-realistic-demo/client/style.css
```
Expected: 3 matches.

Run: `npm run build:realistic`
Expected: succeeds. Then `rm -rf example-realistic-demo/public` before
any lint run, per the standing hazard in `phase_01.md`.

**Commit:** `refactor: delete the demo's private control styling`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Retarget the layout rules onto the new tags

**Verifies:** realistic-demo-form-controls.AC5.2

**Files:**
- Modify: `example-realistic-demo/client/style.css`, seven rules

**Implementation:**

Work bottom-up by line number, or find each rule by its selector text.
The numbers below are from the file *before* Task 1's deletion, so they
have already shifted by the time you get here -- treat them as
identifiers, not as addresses.

**`.persistence & .persist-toggle`** (was 727-737). The component
supplies the label layout -- `check-box` renders
`label.checkbox-label` containing the input and a `<span>`, and its own
sheet handles the alignment, gap and type. Everything except the outer
spacing goes:

```css
    & check-box.persist-toggle {
        margin-bottom: 1.5rem;
    }
```

**`.composer & .draft`** (was 662-665). Scope it to the host. The class
is copied onto the component's inner wrapper as well, and while `flex`
on a non-flex-item is inert, an unscoped selector that matches two
elements is a trap for whoever edits it next:

```css
    & substrate-input.draft {
        flex: 1 1 18rem;
        min-width: 0;
    }
```

**`.composer & label`** (was 658-660). Delete. `flex-basis: 100%` was
what put the hand-written label on its own row; the label is inside the
component now.

**`.pending .request & button`** (was 478-480):

```css
        & substrate-button {
            margin-right: 0.5rem;
        }
```

**`.setup .setup-form & input`** (was 368-372). Keep the flex sizing,
drop `font-size: 1.375rem` -- type is the package's business now:

```css
    & substrate-input {
        flex: 1 1 16rem;
        min-width: 0;
    }
```

**`.setup .setup-form & label`** (was 364-366). Delete, same reason as
the composer's.

**`.room-link & .room-url`** (was 334-340). Keep `flex` and
`min-width`; drop `background-color`, `border` and `padding`, which now
come from the package:

```css
    & substrate-input.room-url {
        flex: 1 1 20rem;
        min-width: 0;
    }
```

Keep the file's existing nesting style throughout -- these are all
nested `&` selectors inside their parent block, not new top-level
rules. Keep spacing as literal rem values; this file uses no
`--space-*` tokens and must not gain any.

**Testing:**

No test, for the same reason as Task 1.

**Verification:**

Confirm no retargeted rule still names an old tag:

```sh
grep -nE "& (input|label|button)[ ,{]" \
    example-realistic-demo/client/style.css
```
Expected: no matches. All four nested control selectors -- the two
`& label` rules, `& input` and `& button` -- have either been deleted
or renamed by this task, and no other rule in the file nests a bare
control element.

Confirm the new selectors are present:

```sh
grep -n "substrate-input\|substrate-button\|check-box" \
    example-realistic-demo/client/style.css
```
Expected: 6 matches after this task.

Five are the selectors added here, one per retargeted rule:
`check-box.persist-toggle`, `substrate-input.draft`,
`substrate-button`, `substrate-input` and `substrate-input.room-url`.
So `substrate-input` appears on three of the five.

The sixth is the `@import` line for `check-box` -- and only that one.
Of the three imports Phase 1 added, `@substrate-system/check-box/css`
is the one whose specifier happens to spell a tag name.
`@substrate-system/button/css` and `@substrate-system/input/css`
contain `substrate-system/button` and `substrate-system/input`, which
are not `substrate-button` and `substrate-input`. Do not expect three
import matches here.

Task 3 adds a sixth selector line (`substrate-input.room-url input`),
taking the total to 7. Do not run this check after Task 3 and expect 6.

Run: `npm run build:realistic`
Expected: succeeds. Then `rm -rf example-realistic-demo/public` before
any lint run, per the standing hazard in `phase_01.md`.

**Commit:** `refactor: retarget the demo's layout rules onto the substrate tags`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Keep the room URL in mono

**Verifies:** realistic-demo-form-controls.AC5.3

**Files:**
- Modify: `example-realistic-demo/client/style.css`, the machine-values
  group (was lines 149-160)

**Implementation:**

This is the one control-adjacent rule that stays, and it stays because
it is not about controls. "A machine value is set in mono" governs
`.seq`, `.epoch`, `.presence` and `.status` too, none of which are
being touched. Dropping it for `.room-url` alone would make the room's
URL the one machine value on the page set in the body face.

Remove the `.room-url,` line from the group's selector list, leaving
the remaining six selectors one per line as they already are:

```css
.epoch,
.live li,
.seq,
.seq-pending,
.presence,
.status {
```

Then add a rule for the inner input, immediately after the group so the
two stay together:

```css
/* An input does not inherit the host's font, so the room URL needs the
   machine-value treatment applied to the control the component
   renders rather than to the element this demo writes. */
substrate-input.room-url input {
    font-family: var(--font-mono);
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
    hyphens: none;
}
```

Keep all four declarations. `hyphens: none` in particular is load
bearing and the file already explains why at lines 132-137: the
normalize sheet turns automatic hyphenation on for the whole page, and
a soft hyphen inside a URL renders an address that is not the one you
would have to type.

**Testing:**

No test, for the same reason as Task 1.

**Verification:**

Confirm `.room-url` no longer appears in the group selector but does
appear in its own rule:

```sh
grep -n "room-url" example-realistic-demo/client/style.css
```
Expected: exactly two matches -- the `substrate-input.room-url` layout
rule from Task 2 and the `substrate-input.room-url input` rule added
here. Neither is a bare `.room-url,` on its own line, which is what the
machine-values group had.

Run: `npm run build:realistic`
Expected: succeeds. Then `rm -rf example-realistic-demo/public` before
any lint run, per the standing hazard in `phase_01.md`.

**Commit:** `refactor: keep the room URL set in mono after the swap`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Verify the whole conversion

**Verifies:** realistic-demo-form-controls.AC6.1,
realistic-demo-form-controls.AC6.2,
realistic-demo-form-controls.AC6.3

**Files:** none. This task changes nothing; it is the phase's gate.

**Implementation:**

Nothing to implement. Run the three commands the design names as the
verification, plus the typecheck the root AGENTS.md warns is not
implied by the test run, and confirm each before claiming the work is
done. Do not report success from any of them without having seen its
output.

**Verification:**

Run these in this order. The order is not cosmetic: the builds leave
output that lint reads, so lint goes last, after the cleanup.

Run: `npm run test:node`
Expected: the whole suite passes. This takes over ten minutes -- the
root AGENTS.md says so; let it finish rather than sampling one file.
**AC6.2.**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors. esbuild only strips types, so the suite passing
says nothing about whether the code typechecks. The realistic demo's
`client/` is covered by the **root** config, not by
`example-realistic-demo/tsconfig.json`, whose `include` stops at the
Worker.

Run: `npm run build:realistic`
Expected: succeeds. **AC6.3.**

Then confirm the built CSS actually carries the package rules, rather
than trusting an exit code -- a dropped `@import` also exits 0:

```sh
grep -c "substrate-button\|check-box" \
    example-realistic-demo/public/assets/*.css
```
Expected: a non-zero count. The path is `public/`, not `dist/`:
`vite.config.js:50` sets `outDir` to `example-realistic-demo/public`.

Run: `npm run build-example`
Expected: succeeds. The shared storage panel reaches these pages too.

Now clean up, then lint:

```sh
rm -rf example-realistic-demo/public
npm run lint
```
Expected: lint exits 0 with no output. **AC6.1.** Linting before that
`rm` fails with tens of thousands of errors from the minified bundles;
see the standing hazard in `phase_01.md`, and do not respond to it by
editing `eslint.config.js`.

**Human verification.** Three things no automated check here reaches,
recorded in `test-requirements.md` and to be confirmed by eye with
`npm run start:realistic`:

1. The intended visible change actually happened: buttons are
   transparent with a hairline border rather than filled accent
   uppercase, and the controls no longer match the uppercase label
   register used elsewhere on the page. This is the design's stated,
   accepted consequence -- confirm it rather than being surprised by it.
2. The setup field and the composer field are visibly labelled, the
   name field disables while a room is being created, and the room URL
   is still in mono and still readonly.
3. The storage panel's request button on `example/persistence-demo` and
   `example/multi-device-demo` looks as it did before -- that is
   **AC5.4**, and it is the check that says converting a shared
   component did not change two pages this work is not about.

**Commit:** none. This task adds no change to commit.
<!-- END_TASK_4 -->

---

## Phase 5 done when

1. `npm run test:node` passes in full.
2. `npx tsc -p tsconfig.json --noEmit` reports no errors.
3. `npm run build:realistic` succeeds and
   `example-realistic-demo/public/assets/*.css` contains the package
   rules.
4. `npm run build-example` succeeds.
5. `rm -rf example-realistic-demo/public`, then `npm run lint` exits 0.
6. The three human verification items above have been looked at.

# Room "You" section -- Phase 4: Style

**Goal:** The block reads as part of the page.

**Architecture:** Two new rules, `.you` and `.own-mark`, plus three
additions to existing selector lists so the new elements inherit rules
that already exist rather than restating them. No new colour and no new
variable. Then the two documentation obligations the project imposes on
any new acceptance criterion.

**Tech Stack:** CSS with native nesting, as the sheet already uses.

**Scope:** Phase 4 of 4 from
`docs/design-plans/2026-08-06-room-you-section.md`. Depends on Phase 3.

**Codebase verified:** 2026-08-06

---

## Acceptance Criteria Coverage

**Verifies: none.** This is a presentation phase, verified
operationally -- lint, build, and the block checked in a browser at both
widths. The design's Phase 4 carries no `Covers:` line, and no
acceptance criterion in this feature is about appearance.

Task 4 does close out the two criteria that no harness can reach, by
recording them where this project keeps that record. That is
bookkeeping, not new verification.

---

## What the investigation found

Every assumption in the design's CSS section is correct, with one
line-number drift. Confirmed verbatim:

- The machine-value block is at **lines 187-197**, not 182, and its
  selector list is `.epoch`, `.live li`, `.seq`, `.seq-pending`,
  `.presence`, `.status`. It sets `font-family: var(--font-mono)`,
  `font-size: 1rem`, `font-variant-numeric: tabular-nums` and
  `hyphens: none` -- but **not** `overflow-wrap`, so the key needs that
  separately, exactly as the design says.
- The disclosure selector list is at **lines 267-276** and sets
  `line-height: var(--leading-loose)` and `padding-top: 1rem`.
- `.readout` is at **lines 571-611**, and its label register lives in a
  nested `& dt` block.
- `.members` is at **lines 695-747** and its nested `.member` at
  **700-746**, with
  `grid-template-columns: var(--seq) minmax(0, 1fr) auto auto` on line
  705 and `.member-name` at `grid-column: 2`.
- The narrow override is `@media (max-width: 52rem)` at **lines
  1221-1239**, dropping `.member` to three columns at line 1231.
- All seven variables exist in
  `example-realistic-demo/client/_variables.css`: `--font-mono` (64),
  `--font-display` (60), `--color-ink-muted` (30), `--color-rule` (23),
  `--hairline` (91), `--tracking-label` (79), `--leading-loose` (77).
- None of `.you`, `.own-mark`, `.copy-value`, `.own-name`,
  `.own-identity`, `.own-leaf`, `.own-role`, `.you-identity`,
  `.you-item` or `.name-disclosure` has any existing rule.
- Every `font-size` in the sheet is at least `1rem`. Keep it that way --
  the marker is differentiated by weight and letter-spacing, not by
  shrinking it.
- The file is 1249 lines and uses `&` nesting throughout.

Two things the design did not anticipate:

1. **`.block > h2` is already styled** (lines 92-127, the
   `.block, .instructions` rule). The block's `<h2>You</h2>` gets the
   uppercase display register for free because the element carries
   `class="block you"`. Do not restyle it.
2. **`.copy-value` needs the same treatment `.room-link` already has** --
   flex, a gap, and the green uppercase `.copied` confirmation nested
   inside it. Task 2 reuses that by adding `.copy-value` to
   `.room-link`'s selector list rather than copying nine declarations.

---

<!-- START_TASK_1 -->
### Task 1: Join the three existing selector lists

**Verifies:** none.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/client/style.css`

Three edits, each adding a selector to a list that already exists. None
of them changes how any current element renders.

**Edit 1 -- the machine values.** Lines 187-192 currently read:

```css
.epoch,
.live li,
.seq,
.seq-pending,
.presence,
.status {
```

Add the two new machine values:

```css
.epoch,
.live li,
.own-identity,
.own-leaf,
.seq,
.seq-pending,
.presence,
.status {
```

The list is alphabetical apart from the trailing three; keep the new
entries in that order.

The design named only the key as joining this list. `.own-leaf` is added
too, deliberately: a leaf index is the same kind of value as the epoch
already in the list, and it reads wrong beside the key in a different
face. If a reviewer disagrees, dropping `.own-leaf` from this list is a
one-line change with no other consequence.

**Edit 2 -- the disclosures.** Lines 267-273 currently read:

```css
.presence-disclosure,
.removal-disclosure,
.identity-disclosure,
.persist-disclosure,
.history-disclosure,
.reset-disclosure,
.waiting .disclosure {
```

Add `.name-disclosure`:

```css
.presence-disclosure,
.removal-disclosure,
.identity-disclosure,
.name-disclosure,
.persist-disclosure,
.history-disclosure,
.reset-disclosure,
.waiting .disclosure {
```

**Edit 3 -- hoist the label register so both `dl`s share it.**

`.readout`'s labels are styled by a nested block at lines 591-598.
Delete it by matching the text below, not by line number -- the range is
bounded by a `& dd { margin: 0; }` block immediately after it, and
deleting one line too many leaves the sheet unparseable:

```css
    & dt {
        color: var(--color-ink-muted);
        font-family: var(--font-display);
        font-size: 1rem;
        font-weight: 700;
        letter-spacing: var(--tracking-label);
        text-transform: uppercase;
    }
```

The `.you` block's identity list needs the same labels but not the flex
strip, so it cannot simply reuse `class="readout"`. Rather than copy
six declarations, delete that eight-line `& dt { ... }` block from
inside `.readout` -- and nothing else; leave the `& dd` block that
follows it alone -- then add one top-level rule immediately **before**
the `.readout` rule (which begins at line 571):

```css
/* The label register, shared by the two `dl`s that use it: the
   Connection/Epoch strip and the "You" block's identity list. Hoisted
   out of `.readout` so the second one does not restate it. */
.readout dt,
.you-identity dt {
    color: var(--color-ink-muted);
    font-family: var(--font-display);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
}
```

This is behaviour-preserving for `.readout`: a nested `& dt` resolves to
`.readout dt`, the same selector and the same specificity, with the same
six declarations. Nothing else in the sheet sets `dt`. The visual check
in Task 3 covers the Connection/Epoch strip explicitly for this reason.

**Verification:**

Do not run ESLint on the stylesheet. The lint script globs
`./**/*.{ts,js}`, so a CSS path reports only `File ignored because no
matching configuration was supplied`. Nothing in this project lints CSS;
the build is what catches a malformed rule.

Run:
```sh
npm run build:realistic
```
Expected: a successful vite build. A malformed rule fails here.

Then confirm the hoist landed as intended, and that the sheet still has
exactly one `dt` rule:
```sh
grep -n "dt {" example-realistic-demo/client/style.css
```
Expected: one match, the new top-level `.readout dt, .you-identity dt`.
If a `& dt {` remains inside `.readout`, Edit 3 was applied twice or not
at all. Grep for `dt {` rather than `dt` -- the bare string also matches
`width`, `max-width` and `min-width`, which appear about thirty times.

**Commit:**
```sh
git add example-realistic-demo/client/style.css
git commit -m "style: share the label register and the existing lists"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: The `.you` and `.own-mark` rules

**Verifies:** none.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/client/style.css`

**Edit 1 -- let the copy control reuse the room link's rule.**

Line 291 currently reads:

```css
.room-link {
```

Change it to:

```css
.room-link,
.copy-value {
```

That gives `.copy-value` the flex row, the `0.5rem` gap and the green
uppercase `.copied` confirmation nested at lines 303-311. The
`& substrate-input.room-url` child rule inside it matches nothing in a
`.copy-value` and is harmless. `.room-link`'s own rendering does not
change -- the rule gains a selector, not a declaration.

**Edit 2 -- the two new rules.**

Add both immediately before the `@media (max-width: 52rem)` block, so
the narrow override still comes after them and can override them. That
block is not the end of the file -- an
`@media (prefers-reduced-motion: reduce)` block follows it -- so insert
before the 52rem query specifically, and find it by searching for
`@media (max-width: 52rem)` rather than by line number: Task 1 Edit 3
changed the line count above it.

```css
/* Who this client is. The values are the page's existing registers:
   the name in display type like a member name, the key and the leaf in
   the mono machine face they share with the epoch, the role in the
   muted label case the readout labels use. Nothing here introduces a
   colour. */
.you {
    & .you-identity {
        margin: 0 0 1rem;

        & .you-item + .you-item {
            margin-top: 1rem;
        }

        & dd {
            margin: 0.25rem 0 0;
        }
    }

    & .own-name {
        font-family: var(--font-display);
        font-weight: 700;
    }

    /* 43 characters with no spaces in it. Same treatment as the keys
       in the list above, which break the same way. */
    & .own-identity {
        overflow-wrap: anywhere;
    }

    & .copy-value {
        margin: 0.5rem 0 0;
    }

    & .own-role {
        color: var(--color-ink-muted);
        letter-spacing: var(--tracking-label);
        text-transform: uppercase;
    }
}

/* The marker on this client's own row, in both lists. A real element
   rather than generated content, so it is announced; lighter than the
   name it sits beside, so it reads as an annotation and not as part of
   it. Never smaller than 1rem. */
.own-mark {
    color: var(--color-ink-muted);
    font-family: var(--font-display);
    font-size: 1rem;
    font-weight: 400;
    letter-spacing: var(--tracking-label);
    margin-left: 0.5rem;
    text-transform: uppercase;
}
```

Every length is a literal rem, matching the sheet -- there are no
`--space-*` tokens in `_variables.css` and none should be introduced.
The `.own-mark` rule is top level rather than nested inside `.you`
because the marker renders in `.members` and `ul.live`, not in the
block.

**Verification:**

Run:
```sh
npm run build:realistic
```
Expected: a successful build.

Run:
```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: `# fail 1`, the pre-existing `placeholder-disclosure` failure
only. CSS cannot break these, but this confirms Phase 3 is still green
before the browser check.

**Commit:**
```sh
git add example-realistic-demo/client/style.css
git commit -m "style: the You block and the own-row marker"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Check it in a browser, at both widths

**Verifies:** none automatically. This is the check that the design
calls the load-bearing one, and nothing above it can substitute --
everything else passes with the same client rendered twice.

**Files:** none. This task changes nothing; it either passes or sends
you back to Task 2.

**Steps:**

1. Build and serve from the Worker, so the page and the room socket
   share one origin. Per `example-realistic-demo/AGENTS.md` lines
   591-596 this is the way to hand test:
   ```sh
   npm run build:realistic
   npm run worker:dev
   ```
   Then browse `http://localhost:8787`.

   `npm run build:realistic` must run first: wrangler serves the page
   from `dist/`, which is gitignored, so a fresh tree serves nothing.

2. Open **two separate browser profiles**, not two tabs of one. A second
   tab shares the database, so both clients would be the same client and
   every check below would pass for the wrong reason
   (`AGENTS.md` lines 566-569).

3. Create a room in profile A. Join from profile B and approve it.

4. Check, in each profile:
   - The "You" block is the last block in the left column, after
     "Connected now".
   - Its name, key, leaf and role are this client's, and the two
     profiles disagree about all of them except possibly the name.
   - The key each profile shows under "You" is one of the keys the
     other profile lists under "Connected now".
   - Exactly one row in "In this group" carries the "You" marker, and it
     is the right one.
   - Exactly one row in "Connected now" carries it.
   - The leaf and role sit side by side in a divided strip, like
     Connection and Epoch at the top of the same column.
   - The Connection/Epoch strip itself still looks as it did -- this is
     the check for the label-register hoist in Task 1.

5. Use the copy control beside the key, then paste into a text field.
   The real clipboard is not reachable by any harness in this project
   (`AGENTS.md` lines 598-600), so this is the only thing that verifies
   it.

6. Narrow the window below `52rem` and repeat step 4. The member rows
   drop to three columns there; confirm the "You" marker still sits with
   the name and does not push the presence badge or the Remove control
   onto a new line.

7. Read the two disclosures against each other. "Connected now" should
   now make only the routing claim, and the naming claim should appear
   once, in the "You" block. Neither should say the other's half.

8. Run the two Playwright harnesses that read a member's name. Phase 3
   Task 4 rewrote both readers, and this is the first time either is
   exercised. They drive the Vite origin rather than the Worker one
   (`example-realistic-demo/AGENTS.md` lines 584-589), so start that
   server as well as `npm run worker:dev`:
   ```sh
   npm run dev:realistic
   ```
   Then, in another shell:
   ```sh
   node example-realistic-demo/scripts/verify-phase7.mjs
   node example-realistic-demo/scripts/verify-phase8-e2e.mjs
   ```
   Expected: both pass. `verify-phase7.mjs` is the one that would fail
   loudest if the marker still leaked into a name -- watch for its
   `expected Alice, got ...` assertion, which is the first member check
   it makes.

   If either harness cannot run in this environment (no Playwright
   browsers installed, for instance), say so explicitly in the phase
   write-up rather than reporting the phase clean. An unrun harness is
   not a passing one.

9. Stop both dev servers when you are done.

**If anything fails here, fix it in Task 2 and re-run this task.** Do
not proceed to Task 4 with a failing visual check.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Record the coverage this project requires

**Verifies:** none. This records where the two human-verified criteria
are checked.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`
- Modify:
  `/Users/nick/code/webcrypto-mls/docs/test-plans/2026-07-28-realistic-demo.md`

**Why this is in scope.** The design's Scope table names four files and
does not mention these two. The project requires them anyway:
`example-realistic-demo/AGENTS.md` lines 349-354 says which criterion is
covered by which test "is written down once" in `ac-coverage.md` and to
"add a row when you add a criterion", and lines 598-602 says the same of
the test plan for anything no harness reaches. This feature adds fifteen
criteria -- AC1.1 through AC1.6, AC2.1 through AC2.4, AC3.1 through
AC3.3, AC4.1 and AC4.2 -- and two things no harness reaches. Skipping
this leaves the project's own index wrong.

**Edit 1 -- the coverage map.**

`ac-coverage.md` is 158 lines and groups criteria under `## AC1:`-style
headings, one table each, with a two-column `| Criterion | Evidence |`
body. The existing clipboard row at line 38 is the pattern to follow:

```
| AC2.3 the full URL is shown and can be copied | Node `RoomLink shows the whole absolute URL`, `RoomLink has a copy control that reports the copy`; browser, US-008, a real OS-clipboard paste |
```

Add a new section at the end of the file, in that shape, with one row
per criterion. Name the Node tests by their actual test titles, which
you now know because you wrote them:

- `room-you-section.AC1.1` through `.AC1.6` -- Node, the "You" block
  tests from Phase 2.
- `room-you-section.AC2.1` through `.AC2.4` -- Node, the marker tests
  from Phase 3.
- `room-you-section.AC3.1` and `.AC3.2` -- Node, the `CopyControl` and
  copy-control tests from Phases 1 and 2.
- `room-you-section.AC3.3` -- Node for the refusal reaching
  `state.status`; a real clipboard refusal is not reachable, so say so,
  the way line 38 does.
- `room-you-section.AC4.1` -- Node for the paragraph still rendering;
  the wording is checked by hand against the test plan. Mark the wording
  half as the weaker "Recorded" kind of evidence the file's own preamble
  defines at lines 17-21.
- `room-you-section.AC4.2` -- Node.

Use the real test titles, not paraphrases -- the file's value is that
someone can grep a title and find the test.

**Edit 2 -- the test plan.**

`docs/test-plans/2026-07-28-realistic-demo.md` is 486 lines. Section
`### 1.5 The room URL copies to the real clipboard` at line 147 is the
model. Add a section in the same shape covering:

- the key under "You" copying to the real clipboard, and
- the wording of the two split disclosures, which is what line 42 of
  that file already claims the plan covers by eye.

Match the file's existing numbering and its steps/expected format. Do
not renumber existing sections.

**Verification:**

Run:
```sh
grep -c "room-you-section" docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md
```
Expected: 15 or more -- one per criterion.

Read both edits back and confirm every Node test title you cited exists:
```sh
grep -n "^test(" test/example-realistic-demo/views.ts | grep -i "you\|copy\|mark\|routes"
```
Expected: every title you wrote into the coverage map appears here. A
cited test that does not exist is worse than no row.

**Commit:**
```sh
git add docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md \
    docs/test-plans/2026-07-28-realistic-demo.md
git commit -m "docs: record coverage for the You section"
```
<!-- END_TASK_4 -->

---

## Do not gate this phase on `npm run lint`

The design's Verification list opens with `npm run lint`, and on a fresh
tree that passes. It does not pass once you have built, which this phase
requires you to do repeatedly.

`npm run lint` is `eslint "./**/*.{ts,js}"`.
`example-realistic-demo/vite.config.js` puts the build output in
`example-realistic-demo/public/`, and `eslint.config.js` ignores
`public/*`, which matches only a top-level `public/` and not that nested
one. So the moment `npm run build:realistic` runs, ESLint starts linting
16 generated bundles: measured on this branch, `npm run lint` reports
62771 problems, every one of them in
`example-realistic-demo/public/assets/`.

That is a pre-existing gap in the ignore list, not something this feature
introduces, and it is out of scope here -- fixing it means editing
`eslint.config.js`, which this project does not permit as a side effect
of unrelated work. (For what it is worth, the fix is a `**/` glob;
`eslint.config.js` lines 13-17 already carry that treatment, and a
comment describing this exact failure, for `.wrangler`.)

So gate on ESLint over the files this feature touches, which is what
every per-task verification above already does. If you want the
whole-repo run, do it before your first build, or scope it:

```sh
npx eslint "./**/*.{ts,js}" \
    --ignore-pattern "example-realistic-demo/public/**"
```
Expected: exit 0.

---

## Phase 4 done when

1. `npx eslint example-realistic-demo/client/views/room.ts test/example-realistic-demo/views.ts test/example/vnode.ts example-realistic-demo/client/views/copy-value.ts`
   is clean. Do not use `npm run lint` as this gate; see above.
2. `npm run build:realistic` succeeds.
3. `npm run test:node` reports no failure other than the pre-existing
   `placeholder-disclosure` one. Over ten minutes; this is the full-suite
   run that closes the feature, so run it here even though CSS cannot
   affect it -- it is the first time the whole suite has seen all three
   code phases together.
4. The browser check in Task 3 passed at both widths, in two separate
   browser profiles.
5. `node example-realistic-demo/scripts/verify-phase7.mjs` and
   `verify-phase8-e2e.mjs` both pass, or it is stated plainly that they
   could not be run and why.
6. `ac-coverage.md` has a row per new criterion and the test plan has a
   section for the two things no harness reaches.
7. The dev servers you started are stopped.

# Room "You" section -- test requirements

Which of this feature's fifteen acceptance criteria are proved by a test,
which are checked by a person, and where each one lives.

Source of truth for the criteria:
`docs/design-plans/2026-08-06-room-you-section.md`, "Acceptance
criteria". Source of truth for every test title and file path below: the
four phase plans in this directory. Nothing here invents a title -- the
phases already name every test, and the titles are copied verbatim so a
reader can grep for them.

**Every criterion maps to exactly one row of section 1 or section 2.**
Two of them (AC3.1 and AC3.3) are proved across two phases, and two of
them (AC3.3 and AC4.1) have a half that only a person can check.

## Test type

Every automated test in this feature is a **unit test in the Node
suite**, and all of them live in one file:

`/Users/nick/code/webcrypto-mls/test/example-realistic-demo/views.ts`

That file is already imported by `test/index.ts` at line 48, so nothing
added to it needs registering (phase_01.md, "Conventions this phase must
follow"). The suite calls a view as a plain function and asserts on the
returned vnode; it never asserts on rendered HTML text.

There are no new integration or browser tests. The project's standing
browser coverage is the two Playwright harnesses in
`example-realistic-demo/scripts/`, and this feature does not add to them
-- it only repairs two readers inside them. See section 4.

Run one file fast with the bundle from AGENTS.md lines 52-56:

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```

## 1. Criteria covered by an automated test

### AC1: The block says who this client is

Verbatim, from the design:

- **room-you-section.AC1.1 Success:** the room renders exactly one
  `.you` block
- **room-you-section.AC1.2 Success:** it shows the name from this
  client's own leaf in the ratchet tree
- **room-you-section.AC1.3 Success:** it shows `ownIdentity`, the
  base64url signature public key, in full
- **room-you-section.AC1.4 Success:** it shows the leaf index from
  `group.privatePath.leafIndex`
- **room-you-section.AC1.5 Success:** the role reads "Room creator"
  when `state.isCreator` is true and "Member" when it is false
- **room-you-section.AC1.6 Edge:** when this client's leaf is not in
  the tree, the name falls back to `state.user.value.name` and the key
  row is not rendered

| Criterion | Test title | Phase |
|-----------|------------|-------|
| AC1.1 | `Room says who this client is` | 2 (Task 3) |
| AC1.2 | `Room says who this client is`, and `the You block follows the leaf, not the first member` | 2 (Task 3) |
| AC1.3 | `Room says who this client is`, and `the You block follows the leaf, not the first member` | 2 (Task 3) |
| AC1.4 | `Room says who this client is`, and `the You block follows the leaf, not the first member` | 2 (Task 3) |
| AC1.5 | `the You block says which of the two roles this client has` | 2 (Task 3) |
| AC1.6 | `the You block survives a leaf that is not in the tree` | 2 (Task 3) |

AC1.2, AC1.3 and AC1.4 each take two tests on purpose. The first proves
the value renders; the second proves it follows `ownLeaf` rather than
happening to be the first leaf in the tree, which is the only way a
single-fixture assertion could pass for the wrong reason.

AC1.5 asserts `data-role` -- `'creator'` or `'member'` -- rather than the
words "Room creator" and "Member". That is phase_02.md's instruction, and
the reason is the project's rule against asserting rendered text; the
`data-role` attribute exists so no assertion depends on the wording. The
criterion is still fully covered by the test: the attribute and the words
come off the same ternary in one `<dd>`.

### AC2: The lists say which row is this client

Verbatim:

- **room-you-section.AC2.1 Success:** exactly one `.member` carries
  `data-own="true"`, and it holds an `.own-mark`
- **room-you-section.AC2.2 Success:** exactly one `.live` item carries
  `data-own="true"` when this client's key is in `state.live`
- **room-you-section.AC2.3 Edge:** when two members share a display
  name, `data-own` is on the one whose leaf index matches `ownLeaf`
- **room-you-section.AC2.4 Edge:** no `.live` item is marked when this
  client's key is absent from `state.live`

| Criterion | Test title | Phase |
|-----------|------------|-------|
| AC2.1 | `Room marks which member is the person looking at it` | 3 (Task 3) |
| AC2.2 | `Room marks this client in the connected list, when it is in it` | 3 (Task 3) |
| AC2.3 | `the mark follows the leaf when two members share a name` | 3 (Task 3) |
| AC2.4 | `Room marks nobody live when this client is not connected` | 3 (Task 3) |

Two shapes these tests must keep, both from phase_03.md's testing notes.
AC2.1 and AC2.3 assert the whole `data-own` sequence across the rows, not
a count, so a mark on the wrong row cannot pass. AC2.4 asserts against a
**non-empty** live list holding somebody who is not this client -- an
empty roster has no marks whatever the code does, so it would pass
against code that never marks anything.

### AC3: The key can be copied

Verbatim:

- **room-you-section.AC3.1 Success:** the block renders one copy
  control, labelled for the key rather than "Copy"
- **room-you-section.AC3.2 Success:** the confirmation appears only
  after a copy has happened
- **room-you-section.AC3.3 Failure:** a clipboard refusal goes to
  `state.status` and the confirmation does not appear

| Criterion | Test title | Phase |
|-----------|------------|-------|
| AC3.1 (part 1) | `CopyControl has one copy button, named for its value` | 1 (Task 2) |
| AC3.1 (part 2) | `the You block offers to copy the key, named for the key` | 2 (Task 3) |
| AC3.2 | `CopyControl confirms a copy only once one has happened` | 1 (Task 2) |
| AC3.3 (part 1) | `CopyControl confirms a copy only once one has happened` | 1 (Task 2) |
| AC3.3 (part 2) | `a refused copy of the key is reported to the person` | 3 -- see below |

**AC3.1 splits across Phases 1 and 2**, and the reason is ordering rather
than a shortcut: there is no `.you` block until Phase 2. Phase 1 proves
`CopyControl` renders exactly one button and that its accessible name is
the `label` it was passed -- a props-flow assertion, not a literal
string, because the component chooses no label. Phase 2 completes it by
proving the block renders one `CopyValue`, that its `value` is the key
rather than the room URL, and that its `label` differs from the name
`RoomLink`'s copy button already carries. Phase 2 reads both names out of
the components rather than writing either into the test, so the
assertion still fails if one control is renamed to match the other.

**AC3.3 splits across Phases 1 and 2** as well, and has a third part no
harness reaches. `CopyValue` calls `useSignal`, and AGENTS.md lines 63-66
state that a component calling a hook cannot be tested by calling it as a
plain function -- the only way this suite tests views. So Phase 1 proves
only the second half of the criterion, that no confirmation renders
without a copy, which is the `copied: false` half of the AC3.2 test.
Phase 2 proves the refusal reaches `state.status`, by pulling the
`CopyValue` vnode out of the rendered `Room` tree and calling its
`onError` prop directly; that is the test
`a refused copy of the key is reported to the person`, added in phase_02
Task 3. The real clipboard refusal is human-verified -- section 2, row 1.

Note on that table row: the test is created in **Phase 2** Task 3, not
Phase 3. It is listed last here because it is the last of the three parts
to land.

### AC4: The disclosure is said once

Verbatim:

- **room-you-section.AC4.1 Success:** `identity-disclosure` states the
  routing claim and no longer states the naming claim
- **room-you-section.AC4.2 Success:** `name-disclosure` renders inside
  the `.you` block

| Criterion | Test title | Phase |
|-----------|------------|-------|
| AC4.1 (structural half) | `Room says what the room routes on, beside the keys` | 3 (Task 3) |
| AC4.2 | `the You block says a name is not hidden from the server` | 2 (Task 3) |

AC4.1's automated half proves only that `identity-disclosure` still
renders exactly once -- that the split did not delete the paragraph. The
wording claim is human-verified; section 2, row 2. Do not write a test
that greps the paragraph for a phrase (phase_03.md, "A note on how AC4.1
is verified").

AC4.2 lands in Phase 2 rather than Phase 3, even though the design put
both halves of the disclosure split in Phase 3. The `name-disclosure` is
part of the block's own markup, and the block is written in Phase 2, so
splitting the two halves is what lets Phase 2's block land complete
rather than half-written. Its test searches inside the `.you` block
element, not the whole tree.

## 2. Criteria and checks verified by a person

Three things in this feature are checked by hand. Two of them are halves
of criteria already in section 1; the third belongs to no criterion.

The justification is the project's own, not this plan's.
`example-realistic-demo/AGENTS.md` lines 598-602 records the standing
list of what neither harness reaches -- "the alarm handler, a real
clipboard paste, the deployed origin, and the wording of the page's
disclosures" -- and names
`docs/test-plans/2026-07-28-realistic-demo.md` as the record of those
checks, with the instruction that adding a criterion means adding a row
to `docs/implementation-plans/2026-07-27-realistic-demo/ac-coverage.md`.
Two of the four things on that list are exactly the two halves below.

| What | Why no test reaches it | How it is verified |
|------|------------------------|--------------------|
| AC3.3, the refusal | A real clipboard refusal is on AGENTS.md's standing list of what neither harness reaches; there is no `navigator.clipboard` stub anywhere in `test/`, and `CopyValue` calls a hook so it cannot be called as a plain function. Note this row is the FAILURE path -- a successful copy and paste proves AC3.1 and AC3.2, not this | Test plan Part 1 step 1.16: provoke a refusal after a successful copy, and check both that the status line says so and that the confirmation goes away |
| AC4.1, the wording | A claim about wording. AGENTS.md line 62 and the global rule forbid asserting on rendered text, and "the wording of the page's disclosures" is on the same standing list | Phase 4 Task 3 step 7: read the two disclosures against each other -- "Connected now" makes only the routing claim, the naming claim appears once in the "You" block, neither says the other's half |
| Appearance, no criterion attached | Phase 4 is a presentation phase and carries no `Covers:` line; no acceptance criterion in this feature is about appearance | Phase 4 Task 3 steps 1-4, 6 and 9: two separate browser profiles in one room, checked above and below 52rem |

The appearance row is the design's load-bearing check, and nothing
automated substitutes for it, because everything above it passes with the
same client rendered twice. Specifically it confirms: the block is the
last block in the left column after "Connected now"; its four values are
this client's and the two profiles disagree about all of them except
possibly the name; the key each profile shows under "You" is one the
other lists under "Connected now"; exactly one row in each list carries
the marker and it is the right one; the leaf and role sit in a divided
strip; the Connection/Epoch strip still looks as it did, which is the
check for Phase 4's label-register hoist; and at narrow widths the marker
stays with the name without pushing the presence badge or the Remove
control onto a new line.

Two separate browser profiles, not two tabs. A second tab shares the
database, so both clients would be the same client and every check would
pass for the wrong reason (AGENTS.md lines 566-569).

Phase 4 Task 4 writes both human-verified halves into `ac-coverage.md`
and the test plan. AC4.1's wording half is recorded as the weaker
"Recorded" kind of evidence that `ac-coverage.md`'s own preamble defines
at lines 17-21.

## 3. Two verification facts that are easy to get wrong

**`data-own` is a boolean in the Node suite, not the string `"true"`.**
The criteria say `data-own="true"` because that is what the rendered DOM
carries. `room.ts` renders `data-own=${own}`, and the Node suite reads
the raw vnode prop, so a test comparing to the string `'true'` fails.
Compare to boolean `true`. The precedent is the existing assertion on
`data-connected` at views.ts:696-700, which compares against
`[true, false]`. This is phase_03.md's first investigation finding.

**`findByClass` matches the whole class attribute by exact equality.**
From `test/example/vnode.ts:58-60`, it filters on
`node.props.class === className`. The block is `<div class="block you">`,
so `findByClass(tree, 'you')` finds nothing. Phase 2 Task 1 adds
`findByClassToken` beside it, which splits the attribute on spaces and
checks membership, and every assertion on the block itself uses that.
The same fact cuts the other way elsewhere and constrains the
implementation: the copy button's `class` must stay the single word
`copy` or Phase 1's tests stop finding it, and the live list's `<li>`
must gain no class at all or the existing test at views.ts:254-260 stops
finding the list.

## 4. Regression risk, and where it is covered

The plan knowingly breaks three existing readers of the member name cell,
because the "You" marker goes inside that cell -- it has to, since a
third child of the `<li>` would be a third grid item and would force
`grid-template-columns` changes in both the base rule and the narrow
override.

**One Node test must be repaired.**
`Room lists every member of its own tree, by name`
(`test/example-realistic-demo/views.ts:671-682`) asserts the exact
children of every `.member-name` as `[['Alice'], ['Bob']]`. Once Alice's
cell holds a second child the assertion becomes
`[['Alice', <span>], ['Bob']]` and fails. Phase 3 Task 3 step 2 repairs
it by filtering children to strings instead of to defined values, which
keeps the test's actual subject -- that each member is named from the
credential in their leaf -- and stops it depending on the cell holding
exactly one thing. Phase 3 Task 3 step 1 has the engineer run the suite
first and confirm **exactly two** failures, this one and the pre-existing
one in section 5, so the breakage is observed rather than guessed at. A
third failure is not accounted for by the plan.

**Two Playwright harness readers must be rewritten.** Neither is visible
to `npm run test:node`, which bundles `test/index.ts` only; they run
separately as the project's standing browser coverage
(`example-realistic-demo/AGENTS.md` lines 344-347).

1. `example-realistic-demo/scripts/verify-phase7.mjs:250`, inside
   `membersOf` -- reads
   `el.querySelector('.member-name')?.textContent?.trim()`
2. `example-realistic-demo/scripts/verify-phase8-e2e.mjs:222`, inside
   `memberNames` -- the same read through `$$eval`

After the marker lands, the own row's cell yields `"AliceYou"` rather
than `"Alice"`, because htm strips the whitespace-only text around the
newline. phase_03.md counts at least eight assertions in
`verify-phase7.mjs` that this fails: lines 327, 475, 479, 553, 634, 686,
693 and 753. Phase 3 Task 4 rewrites both readers to take the cell's own
text nodes only, and greps
`example-realistic-demo/scripts/` for other `member-name` readers rather
than trusting the list of two. Phase 4 Task 3 step 8 is where both
harnesses actually run -- Phase 3 leaves them correct but unexercised,
which is the one loose end it hands forward deliberately. An unrun
harness is not a passing one; if Playwright browsers are not installed,
that must be said plainly rather than reporting the phase clean.

Three smaller regression guards, each in the phase that needs it:

- The live list is safe by inspection. No harness reads a live item's
  text, it is only counted (`verify-phase7.mjs:561`); nothing reads
  `identity-disclosure`, and nothing counts `.block`.
- Phase 2 Task 2 runs `grep -rn "findByClass(.*'block'" test/` before
  adding a fifth `.block`, expecting no matches. A match means a test
  counts blocks and its expected number changes in the same commit.
- Phase 2 Task 3's `memberRoom` refactor is signature-preserving across
  all 12 call sites, and the engineer confirms the count with
  `grep -c "memberRoom(" test/example-realistic-demo/views.ts` before
  starting, so they know what they are protecting. The `location` stub it
  wraps must stay restored in a `finally` -- `Room` reads
  `location.origin`.

## 5. The expected suite state is `# fail 1`, not `# fail 0`

The branch baseline is one test short of green before any of this work.
`Room says what a placeholder stands for`
(`test/example-realistic-demo/views.ts:1074-1080`) asserts a
`placeholder-disclosure` that `room.ts` stopped rendering in commit
`e222c20`. It reports as
`not ok 105 the explanation stands beside the timeline, always`.

It is unrelated to this feature, nothing in the plan touches it, and
fixing it is out of scope -- whether the disclosure should come back into
`room.ts` or the test should go is a question about the timeline work.

Two consequences that hold for all four phases. Every verification step
expects `# fail 1`, and that named failure must be the only one; a second
failure belongs to whoever is working. And `npm run test:node` is red for
the same reason, so the phase gate is "no new failures", not "the suite
passes". If somebody repairs that test first, every expectation becomes
`# fail 0`.

# Room "You" section -- Phase 3: Marked rows and the split disclosure

**Goal:** This client's row is marked in both lists, and the name
disclosure sits with the name.

**Architecture:** `memberItem` gains an `own:boolean` parameter and sets
`data-own` on the `<li>`, the attribute `.message` already uses. Both
marked rows carry a real `<span class="own-mark"> You</span>` rather than
a CSS `::after`, because generated content is not reliably announced and
a marker only sighted readers get would answer the question for some of
the people asking it. `identity-disclosure` loses its second half, which
Phase 2 already moved into the `.you` block.

**Tech Stack:** TypeScript, Preact, `htm/preact`,
`@substrate-system/tapzero`. No new dependency.

**Scope:** Phase 3 of 4 from
`docs/design-plans/2026-08-06-room-you-section.md`. Depends on Phase 2.

**Codebase verified:** 2026-08-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### room-you-section.AC2: The lists say which row is this client

- **room-you-section.AC2.1 Success:** exactly one `.member` carries
  `data-own="true"`, and it holds an `.own-mark`
- **room-you-section.AC2.2 Success:** exactly one `.live` item carries
  `data-own="true"` when this client's key is in `state.live`
- **room-you-section.AC2.3 Edge:** when two members share a display
  name, `data-own` is on the one whose leaf index matches `ownLeaf`
- **room-you-section.AC2.4 Edge:** no `.live` item is marked when this
  client's key is absent from `state.live`

### room-you-section.AC4: The disclosure is said once

- **room-you-section.AC4.1 Success:** `identity-disclosure` states the
  routing claim and no longer states the naming claim

AC4.2 was completed in Phase 2, because the `name-disclosure` is part of
the block's own markup and the block was written there. The design put
both halves of the disclosure split in this phase; splitting them across
the two is what let Phase 2's block render complete rather than land
half-written.

---

## What the investigation changed

Three things. Each one changes an instruction below.

1. **`data-own` is a boolean in the Node suite, not the string
   `"true"`.** `messageItem` renders `data-own=${own}` (room.ts:473) and
   the analogous existing assertion reads the raw prop:

   ```ts
   t.deepEqual(
       members.map(node => node.props['data-connected']),
       [true, false],
       'only the identity the roster named is marked connected'
   )
   ```
   (views.ts:696-700.) The ACs say `data-own="true"` because that is
   what the rendered DOM carries; a Node test that compares to the
   string `'true'` will fail. Compare to boolean `true`.

2. **Putting `.own-mark` inside the name cell breaks a passing test.**
   The existing test at views.ts:671-682 asserts the exact children of
   every `.member-name`:

   ```ts
   t.deepEqual(
       findByClass(tree, 'member-name').map(node => {
           return childrenOf(node).filter(kid => kid !== undefined)
       }),
       [['Alice'], ['Bob']],
       'should name each member from the credential in their leaf'
   )
   ```

   `memberRoom({})` uses `ownLeaf: 0`, so Alice's name cell gains a
   second child and this becomes `[['Alice', <span>], ['Bob']]`. Task 3
   fixes it by filtering to strings, which keeps the test's actual
   subject -- that each member is named from their credential -- and
   stops it depending on the cell holding exactly one thing.

   The marker has to go inside the name cell rather than beside it: a
   third child of the `<li>` would be a third grid item and would need
   `grid-template-columns` changed in both the base rule
   (style.css:705) and the narrow override (style.css:1231). Inside the
   cell, both stay untouched.

3. **Two Playwright harnesses read that cell's text as a display name**,
   and putting an element inside it breaks them. This is the cost of the
   choice above, and it is not optional to pay:

   - `example-realistic-demo/scripts/verify-phase7.mjs:250` --
     `name: el.querySelector('.member-name')?.textContent?.trim() ?? ''`
   - `example-realistic-demo/scripts/verify-phase8-e2e.mjs:222-223` --
     the same read, through `$$eval`

   After this phase the own row's cell yields `"AliceYou"` rather than
   `"Alice"` -- htm strips the whitespace-only text around the newline,
   so the two run together -- which fails at least eight assertions in
   `verify-phase7.mjs`: line 327 (`members[0].name === 'Alice'`, a room
   of one whose only row is always the own row), 475 and 479
   (`names(...).join() === 'Alice,Bob'`), 553, 634, 686
   (`forCarl.join() === forAlice.join()`), 693 and 753.

   `npm run test:node` cannot see any of this -- it bundles
   `test/index.ts` only, and the harnesses run separately as the
   project's standing browser coverage
   (`example-realistic-demo/AGENTS.md` lines 344-347). Task 4 fixes both
   readers, and Phase 4 runs them.

   The live list is safe: no harness reads a live item's text, it is
   only counted (`verify-phase7.mjs:561`). Nothing reads
   `identity-disclosure`, and nothing counts `.block`.

4. **No fixture has two members sharing a name**, which AC2.3 needs, and
   `memberRoomState` hardcodes its tree as
   `[aliceLeaf, undefined, bobLeaf]`. Task 3 adds a third leaf fixture
   and a `tree` option.

### A note on how AC4.1 is verified

AC4.1 is a claim about wording, and this project deliberately does not
assert wording in tests. `AGENTS.md` line 62 and the global rule both
forbid asserting on rendered text, and
`example-realistic-demo/AGENTS.md` lines 598-600 records "the wording of
the page's disclosures" as one of the four things neither harness
reaches, checked by hand against
`docs/test-plans/2026-07-28-realistic-demo.md`.

So AC4.1 splits: a Node test asserts `identity-disclosure` still renders
exactly once (that the split did not delete it), and the wording itself
is human-verified. Phase 4 records that in the coverage map. Do not write
a test that greps the paragraph for a phrase.

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->
<!-- START_TASK_1 -->
### Task 1: Mark this client's row in the member list

**Verifies:** none directly -- Task 3 tests it.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/client/views/room.ts`

**Implementation, step 1 -- `memberItem` takes `own`.**

The helper currently begins at line 421. Replace its signature and the
`<li>` it opens. Current:

```ts
function memberItem (
    member:Member,
    connected:boolean,
    canRemove:boolean,
    onRemove:(member:Member) => void
) {
    return html`
        <li
            key=${member.identity}
            class="member"
            data-connected=${connected}
        >
            <span class="member-name">${member.name}</span>
```

New:

```ts
function memberItem (
    member:Member,
    connected:boolean,
    canRemove:boolean,
    own:boolean,
    onRemove:(member:Member) => void
) {
    return html`
        <li
            key=${member.identity}
            class="member"
            data-connected=${connected}
            data-own=${own}
        >
            ${/* The marker is a real element, not a `::after`:
                  generated content is not reliably announced, and a
                  mark only sighted readers get would answer this
                  question for some of the people asking it. It sits
                  inside the name cell so the row stays two grid
                  columns wide.

                  The leading space inside the span is load-bearing. htm
                  strips the whitespace-only text around the newline
                  above, so without it the name and the marker flatten
                  to one word -- "AliceYou" -- and that is what a screen
                  reader announces. No CSS can put the boundary back:
                  margin and padding are box-model, and the accessible
                  text run does not see them. */''}
            <span class="member-name">${member.name}${own ? html`
                <span class="own-mark"> You</span>
            ` : null}</span>
```

**The space before `You` is not a typo.** It was added after code
review found that the original markup announces as `"AliceYou"` -- the
exact failure this phase chose a real element over a `::after` to
avoid. Do not remove it, and do not replace it with a margin.

`own` goes before `onRemove` so the callback stays last, which is what
`requestItem` and `memberItem` already do.

Leave the rest of the function -- `.presence`, the `canRemove` block and
the closing `</li>` -- exactly as it is.

**Implementation, step 2 -- pass it at the call site.**

The call site is lines 192-200. Current:

```ts
                        ${members.map(member => {
                            return memberItem(
                                member,
                                state.live.value.includes(member.identity),
                                state.isCreator.value &&
                                    member.leafIndex !== ownLeaf,
                                onRemove
                            )
                        })}
```

New:

```ts
                        ${members.map(member => {
                            return memberItem(
                                member,
                                state.live.value.includes(member.identity),
                                state.isCreator.value &&
                                    member.leafIndex !== ownLeaf,
                                member.leafIndex === ownLeaf,
                                onRemove
                            )
                        })}
```

`ownLeaf` is `number|null`. When it is null no member matches, so no row
is marked -- which is correct: without a group this client has no leaf.

**Verification:**

Run:
```sh
npx tsc --noEmit 2>&1 | grep "error TS"
```
Expected: only the pre-existing `key-schedule.ts(73,9)` error. A missing
argument at the call site would show up here, which is why this runs
before the tests.

Run:
```sh
npx eslint example-realistic-demo/client/views/room.ts
```
Expected: no output, exit 0.

Do not commit yet -- Task 3 fixes the test this breaks, and the tree
should not carry a commit with a failing suite. Task 2 is the other half
of the same edit.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Mark the row in the live list, and split the disclosure

**Verifies:** none directly -- Task 3 tests it.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/client/views/room.ts`

**Implementation, step 1 -- the live list item.**

Lines 231-235 currently read:

```ts
                    <ul class="live">
                        ${state.live.value.map(identity => {
                            return html`<li key=${identity}>${identity}</li>`
                        })}
                    </ul>
```

Replace with:

```ts
                    <ul class="live">
                        ${state.live.value.map(identity => {
                            const own = identity === ownIdentity
                            return html`<li
                                key=${identity}
                                data-own=${own}
                            >${identity}${own ? html`
                                <span class="own-mark"> You</span>
                            ` : null}</li>`
                        })}
                    </ul>
```

Do not add a class to the `<li>` and do not change the `<ul class="live">`.
`findByClass` matches the whole class attribute, so the existing test at
views.ts:254-260 finds this list by `'live'` and counts its `li`
children by type -- both survive this edit, and a class on either would
break one of them.

`ownIdentity` is `string|null` and every entry in `state.live.value` is a
string, so a null identity marks nothing.

**Implementation, step 2 -- the disclosure loses its second half.**

Lines 223-229 currently read:

```ts
                    <p class="identity-disclosure">
                        The signature public key, base64url encoded.
                        That is what the room routes on, never a display
                        name. The names are not hidden from the server,
                        though. A key package carries its name
                        as a credential, in plain text.
                    </p>
```

Replace with:

```ts
                    <p class="identity-disclosure">
                        The signature public key, base64url encoded.
                        That is what the room routes on, never a display
                        name.
                    </p>
```

The two sentences removed are now the `name-disclosure` in the `.you`
block, written in Phase 2. Check that they are there before deleting
them here:

```sh
grep -n "name-disclosure" example-realistic-demo/client/views/room.ts
```
Expected: one match, inside `youBlock`. If there is no match, Phase 2 is
incomplete -- stop and finish it, or this edit loses the disclosure
entirely.

**Verification:**

Run:
```sh
npx eslint example-realistic-demo/client/views/room.ts
```
Expected: no output, exit 0.

Run:
```sh
npx tsc --noEmit 2>&1 | grep "error TS"
```
Expected: only the pre-existing `key-schedule.ts(73,9)` error.

Do not commit yet -- Task 3 closes this out.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Fix the broken test, and cover the marks

**Verifies:** `room-you-section.AC2.1`, `.AC2.2`, `.AC2.3`, `.AC2.4`,
`.AC4.1` (the structural half; the wording is human-verified)

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/test/example-realistic-demo/views.ts`
  (unit)

**Implementation, step 1 -- confirm the breakage is the expected one.**

Run the suite first, so you see the failure this task is fixing rather
than guessing at it:

```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```

Expected: **exactly two failures.**

1. `Room lists every member of its own tree, by name`, on the
   `member-name` children assertion. That is the one this task fixes.
2. `the explanation stands beside the timeline, always`, the assertion
   inside `Room says what a placeholder stands for`
   (views.ts:1074-1080). That one is pre-existing -- it asserts a
   `placeholder-disclosure` that `room.ts` stopped rendering in commit
   `e222c20`, it fails on a clean tree, and it is not yours. Leave it
   alone.

A third failure is not accounted for by this plan -- read it before
continuing.

**Implementation, step 2 -- fix that test.**

At views.ts:676-682, change the filter so the assertion is about the
name rather than about the cell holding exactly one child. Current:

```ts
    t.deepEqual(
        findByClass(tree, 'member-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Alice'], ['Bob']],
        'should name each member from the credential in their leaf'
    )
```

New:

```ts
    t.deepEqual(
        findByClass(tree, 'member-name').map(node => {
            return childrenOf(node).filter(kid => typeof kid === 'string')
        }),
        [['Alice'], ['Bob']],
        'should name each member from the credential in their leaf'
    )
```

**Implementation, step 3 -- add a twin fixture and a tree option.**

Beside the existing fixtures at views.ts:630-633, add a third leaf that
shares Alice's display name and nothing else:

```ts
// Two members may show the same name -- a name is a credential, not an
// identifier, and nothing stops two people choosing one. Which row is
// this client has to follow the leaf index.
const twinLeaf = fixtureLeaf('Alice', [3, 3, 3])
```

Then let a test choose the tree. In `memberRoomState` (rewritten in
Phase 2), add `tree?:RatchetTree` to the options type and change the one
line that builds the tree. Current:

```ts
        const tree:RatchetTree = [aliceLeaf, undefined, bobLeaf]
```

New:

```ts
        const tree:RatchetTree = opts.tree ??
            [aliceLeaf, undefined, bobLeaf]
```

`RatchetTree` is already imported at views.ts:33 -- do not add an
import.

**Testing:**

Tests must verify each AC listed above:

- **AC2.1:** exactly one `.member` carries `data-own` `true`, and that
  one holds exactly one `.own-mark`. Assert both together, so a mark
  rendered on the wrong row cannot pass.
- **AC2.2:** exactly one `.live` item carries `data-own` `true` when
  this client's key is in `state.live`, and it holds an `.own-mark`.
- **AC2.3:** with two members named "Alice", the marked row is the one
  at `ownLeaf` -- assert the whole `data-own` sequence, not just a
  count, so marking the wrong twin fails.
- **AC2.4:** no `.live` item is marked when this client's key is not in
  `state.live`, **with the list non-empty**. An empty roster proves
  nothing -- a list with no items has no marks whatever the code does.
  The roster must name somebody, just not this client. Assert both
  polarities, per the project's rule that a check asserting only the
  negative passes against something that marks nothing at all.
- **AC4.1 (structural):** `identity-disclosure` still renders exactly
  once.

Add these after the "You" block tests from Phase 2:

```ts
test('Room marks which member is the person looking at it', t => {
    const members = findByClass(memberRoom({ ownLeaf: 1 }), 'member')

    t.deepEqual(
        members.map(node => node.props['data-own']),
        [false, true],
        'exactly one row is this client'
    )
    t.deepEqual(
        members.map(node => findByClass(node, 'own-mark').length),
        [0, 1],
        'and the mark is on that row, in words, not only in CSS'
    )
})

test('the mark follows the leaf when two members share a name', t => {
    const members = findByClass(
        memberRoom({ tree: [aliceLeaf, undefined, twinLeaf], ownLeaf: 1 }),
        'member'
    )

    t.equal(members.length, 2, 'both members are listed')
    t.deepEqual(
        members.map(node => {
            return childrenOf(findByClass(node, 'member-name')[0])
                .filter(kid => typeof kid === 'string')
        }),
        [['Alice'], ['Alice']],
        'and they are telling the truth: the names are the same'
    )
    t.deepEqual(
        members.map(node => node.props['data-own']),
        [false, true],
        'the mark follows the leaf index, not the name'
    )
})

test('Room marks this client in the connected list, when it is in it', t => {
    const marked = findByType(
        findByClass(memberRoom({ live: [aliceIdentity] }), 'live')[0],
        'li'
    )

    t.deepEqual(
        marked.map(node => node.props['data-own']),
        [true],
        'the key this client holds is marked'
    )
    t.equal(
        findByClass(marked[0], 'own-mark').length,
        1,
        'and it says so in words'
    )

    const others = findByType(
        findByClass(memberRoom({ live: [bobIdentity] }), 'live')[0],
        'li'
    )
    t.deepEqual(
        others.map(node => node.props['data-own']),
        [false],
        'and somebody else holding a socket is not marked'
    )
})

test('Room marks nobody live when this client is not connected', t => {
    // A roster with somebody on it, and that somebody is not us. An
    // empty list would pass against code that never marks anything.
    const live = findByClass(memberRoom({ live: [bobIdentity] }), 'live')[0]

    t.equal(
        findByType(live, 'li').length,
        1,
        'somebody is holding a socket open'
    )
    t.equal(
        findByClass(live, 'own-mark').length,
        0,
        'but it is not this client, so nothing is marked'
    )
})

test('Room says what the room routes on, beside the keys', t => {
    t.equal(
        findByClass(memberRoom({}), 'identity-disclosure').length,
        1,
        'the disclosure still heads the list it is about'
    )
})
```

The third test asserts both polarities in one place on purpose: a
`data-own` that is never true would pass a test that only checked
somebody else is unmarked.

**Verification:**

Run:
```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: `# fail 1` -- the pre-existing `placeholder-disclosure`
failure only. The five new tests pass, so does the repaired
`member-name` test, and so does every existing `memberRoom` test.

Run:
```sh
npx eslint example-realistic-demo/client/views/room.ts test/example-realistic-demo/views.ts
```
Expected: no output, exit 0.

Run:
```sh
npx tsc --noEmit 2>&1 | grep "error TS"
```
Expected: only the pre-existing `key-schedule.ts(73,9)` error.

**Commit** -- one commit for Tasks 1 through 4, since Tasks 1 and 2
leave both the Node suite and the browser harnesses red on their own.
Hold the commit until Task 4 is done.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Stop the harnesses reading the marker as a name

**Verifies:** none. This keeps two existing browser harnesses passing.
They are this project's standing browser coverage, so leaving them red
is not an option and `npm run test:node` will not tell you they are.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/scripts/verify-phase7.mjs`
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/scripts/verify-phase8-e2e.mjs`

**Before you start -- find every reader.** The two below are the ones
this plan verified, but check for others rather than trusting the list:

```sh
grep -rn "member-name" example-realistic-demo/scripts/
```

Expected: exactly two matches, `verify-phase7.mjs:250` and
`verify-phase8-e2e.mjs:222`. If there are more, each one needs the same
change.

**Edit 1 -- `verify-phase7.mjs`.** `membersOf` at lines 247-255 currently
reads:

```js
function membersOf (page) {
  return page.$$eval('section.room ul.members li.member', els => {
    return els.map(el => ({
      name: el.querySelector('.member-name')?.textContent?.trim() ?? '',
      presence: el.querySelector('.presence')?.textContent?.trim() ?? '',
      connected: el.getAttribute('data-connected'),
      remove: el.querySelector('substrate-button.remove') !== null
    }))
  })
}
```

Replace with:

```js
function membersOf (page) {
  return page.$$eval('section.room ul.members li.member', els => {
    // The name cell also holds the "You" marker on this client's own
    // row, and that marker is an element. Read only the cell's own text
    // nodes, so the marker does not become part of the name.
    const nameOf = el => {
      const cell = el.querySelector('.member-name')
      if (!cell) return ''
      return Array.from(cell.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join('')
        .trim()
    }

    return els.map(el => ({
      name: nameOf(el),
      presence: el.querySelector('.presence')?.textContent?.trim() ?? '',
      connected: el.getAttribute('data-connected'),
      remove: el.querySelector('substrate-button.remove') !== null
    }))
  })
}
```

**Edit 2 -- `verify-phase8-e2e.mjs`.** `memberNames` at lines 221-225
currently reads:

```js
function memberNames (page) {
  return page.$$eval('section.room ul.members li.member .member-name', els => {
    return els.map(el => el.textContent.trim())
  })
}
```

Replace with:

```js
function memberNames (page) {
  return page.$$eval('section.room ul.members li.member .member-name', els => {
    // Only the cell's own text: the "You" marker is an element inside
    // it on this client's own row.
    return els.map(el => {
      return Array.from(el.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join('')
        .trim()
    })
  })
}
```

`Node.TEXT_NODE` resolves in the page context, which is where `$$eval`
runs its callback. These are `.mjs` files and the lint script globs only
`{ts,js}`, so ESLint does not cover them -- match the surrounding
two-space indentation by hand.

**Verification:**

These harnesses need two dev servers and Playwright, so they are run in
Phase 4 Task 3 where the servers are already up. Here, check the edits
are syntactically sound and that nothing else reads the cell:

```sh
node --check example-realistic-demo/scripts/verify-phase7.mjs
node --check example-realistic-demo/scripts/verify-phase8-e2e.mjs
```
Expected: no output, exit 0 for both.

```sh
grep -rn "member-name" example-realistic-demo/scripts/
```
Expected: the same two matches, now inside the rewritten readers.

**Commit** -- all four tasks together:
```sh
git add example-realistic-demo/client/views/room.ts \
    test/example-realistic-demo/views.ts \
    example-realistic-demo/scripts/verify-phase7.mjs \
    example-realistic-demo/scripts/verify-phase8-e2e.mjs
git commit -m "feat: mark this client in both lists, split the disclosure"
```
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

---

## Phase 3 done when

1. `npx eslint example-realistic-demo/client/views/room.ts test/example-realistic-demo/views.ts`
   is clean.
2. `npx tsc --noEmit 2>&1 | grep "error TS"` reports only the
   pre-existing `key-schedule.ts(73,9)` error.
3. The single-file bundle of `views.ts` reports `# fail 1`, and that one
   is the pre-existing `placeholder-disclosure` failure.
4. `npm run test:node` reports no failure other than that one. Over ten
   minutes; run it once to close the phase.
5. `node --check` passes on both harness scripts, and
   `grep -rn "member-name" example-realistic-demo/scripts/` shows both
   readers taking text nodes only. The harnesses themselves run in Phase
   4 Task 3 -- this phase leaves them correct but unexercised, which is
   the one loose end it hands forward deliberately.

`.own-mark` has no CSS yet, so it renders as plain inline text beside the
name. That is Phase 4's job, and the marker is legible without it --
which is the point of it being a real element.

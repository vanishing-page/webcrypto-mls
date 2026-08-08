# Room "You" section -- Phase 2: The block

**Goal:** The "You" block renders, with the four values and the copy
control, as the last child of `.room-meta`.

**Architecture:** A `youBlock` plain function in `views/room.ts`, called
by `Room` rather than rendered as a child component -- the convention
`requestItem`, `memberItem`, `messageItem`, `placeholderItem` and
`outboundItem` already follow, and what keeps the block's own content
assertable in the Node suite. It takes primitives, not `state`, so it
stays a pure function of four derived values. `Room` renders the key text
itself and passes only the value to `CopyValue`, so the key stays in
`Room`'s vnode tree where a test can read it.

**Tech Stack:** TypeScript, Preact, `htm/preact`,
`@substrate-system/tapzero`. No new dependency.

**Scope:** Phase 2 of 4 from
`docs/design-plans/2026-08-06-room-you-section.md`. Depends on Phase 1.

**Codebase verified:** 2026-08-06

---

## Acceptance Criteria Coverage

This phase implements and tests:

### room-you-section.AC1: The block says who this client is

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

This phase also completes two criteria Phase 1 could only partly reach:

- **room-you-section.AC3.1 Success:** the block renders one copy
  control, labelled for the key rather than "Copy"
- **room-you-section.AC3.3 Failure:** a clipboard refusal goes to
  `state.status` and the confirmation does not appear

### room-you-section.AC4 (partial)

- **room-you-section.AC4.2 Success:** `name-disclosure` renders inside
  the `.you` block

AC4.1 is Phase 3's -- it is the other half of the same edit and belongs
with the disclosure split.

---

## What the investigation changed

Read this before writing code. Four things differ from what the design
assumed, and each one changes an instruction below.

1. **The design's line numbers are slightly off, and the types are
   wider than it says.** The real derivations, verbatim:
   - `room.ts:86` -- `const ownLeaf = group ? group.privatePath.leafIndex : null`.
     Type `number|null`, not `number`. The design calls it
     "`group.privatePath.leafIndex`" without saying it is null when
     there is no group, and `Room` *is* called with a null group by an
     existing test (views.ts:208).
   - `room.ts:115` -- `const own = members.find(member => member.leafIndex === ownLeaf)`.
     Type `Member|undefined`.
   - `room.ts:116` -- `const ownIdentity = own ? own.identity : null`.
     Type `string|null`.

   So the leaf row must be conditional on `ownLeaf !== null` as well as
   the key row being conditional on `ownIdentity !== null`.

2. **`state.user` can be null, and in the tests it is.** The design says
   the name "falls back to `state.user.value.name`". `state.user` is
   `Signal<DemoUser|null>` (state.ts:38) and `memberRoom` never sets it,
   so a bare `state.user.value.name` throws. Use optional chaining with
   a final `''`. In the running app the fallback is unreachable -- the
   `view` computed at state.ts returns `'setup'` while `user` is null, so
   `Room` never renders without a user -- but the expression still has to
   be total.

3. **`findByClass` matches the whole class attribute by exact
   equality** (`test/example/vnode.ts:58-60`):
   ```ts
   export function findByClass (root:unknown, className:string):Element[] {
       return allNodes(root).filter(node => node.props.class === className)
   }
   ```
   The block is `<div class="block you">`, which `findByClass(tree,
   'you')` cannot find. Task 1 adds a `findByClassToken` helper next to
   it. This is a fifth file, beyond the design's four-file scope; see
   "Scope note" below.

4. **A `<p>` is not valid between `<dt>`/`<dd>` groups in a `<dl>`.**
   The design orders the block "Name, then the name disclosure, then the
   key", and also puts name and key in one `dl`. Both hold only if the
   disclosure goes outside the list, so the name disclosure follows the
   identity `dl` rather than splitting it.

   The alternative was two `dl`s -- name, then the `<p>`, then key --
   which would preserve the design's stated reading order exactly. It is
   rejected because two single-item description lists to place one
   paragraph is more markup than the ordering is worth, and the ordering
   was the design's weakest-held preference: it says outright that the
   strip "could open the block" instead. Everything the design wanted
   survives the reorder -- the disclosure still sits with the name and
   key, above the machine values, and AC4.2 only requires that it render
   inside `.you`. If a reviewer prefers the design's literal order, two
   `dl`s is the change, and it is a local one.

### The branch baseline is one test short of green

`test/example-realistic-demo/views.ts` fails one assertion on a clean
tree, before any of this work: the test
`Room says what a placeholder stands for` (views.ts:1074-1080), whose
assertion reports as `the explanation stands beside the timeline,
always`, asserts a `placeholder-disclosure` that `room.ts` stopped
rendering in commit `e222c20`. It predates this feature and nothing here
touches it.

So every expectation below is **`# fail 1`**, not `# fail 0`, and that
named failure must be the only one. `npm run test:node` is red for the
same reason, so the phase gate is "no new failures". See phase_01.md for
the full note.

### Scope note

The design's Scope table names four files. This phase touches a fifth,
`test/example/vnode.ts`, to add one test helper. The reason is
mechanical: the block carries two classes because it is both a
`.block` and the `.you` block, and the existing finder cannot match one
class out of two. The alternatives were worse -- duplicating `.block`'s
rules onto `.you`, or nesting a second div purely to give the test
something to match. Flagging it rather than hiding it.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: A finder that matches one class out of several

**Verifies:** none directly -- this is test infrastructure Task 3 needs.

**Files:**
- Modify: `/Users/nick/code/webcrypto-mls/test/example/vnode.ts`

**Implementation:**

Append to the end of the file, after `findByClass` (which ends at line
60):

```ts
/**
 * Elements carrying `className` among their classes. `findByClass`
 * compares the whole attribute, so it cannot find an element that
 * carries two -- which is what a `.block` that is also the `.you`
 * block does.
 */
export function findByClassToken (
    root:unknown,
    className:string
):Element[] {
    return allNodes(root).filter(node => {
        const classes = node.props.class
        return typeof classes === 'string' &&
            classes.split(' ').includes(className)
    })
}
```

`Element` and `allNodes` are already in scope in that file -- do not add
imports.

**Verification:**

Run:
```sh
npx eslint test/example/vnode.ts
```
Expected: no output, exit 0.

Run:
```sh
npx tsc --noEmit 2>&1 | grep "error TS"
```
Expected: only the pre-existing `key-schedule.ts(73,9)` error.

**Commit:**
```sh
git add test/example/vnode.ts
git commit -m "test: find an element by one of its classes"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `youBlock` and its call from `Room`

**Verifies:** none directly -- Task 3 tests all of it.

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/example-realistic-demo/client/views/room.ts`

**Before you start -- check two things:**

1. Confirm no test finds the existing blocks by class, because this task
   adds a fifth one:
   ```sh
   grep -rn "findByClass(.*'block'" test/
   ```
   Expected: no matches. If there are matches, a test counts `.block`
   elements and this task changes that count -- update that test's
   expected number in the same commit and say so in the commit message.

2. Confirm the current `.room-meta` closes where this plan says it does:
   ```sh
   sed -n '218,240p' example-realistic-demo/client/views/room.ts
   ```
   Expected: the "Connected now" block, then a `</div>` closing
   `.room-meta` at line 237.

**Implementation, step 1 -- import `CopyValue`.**

`room.ts` line 21 currently ends the import list with:
```ts
import { ShareRoomLink } from './room-link.js'
```
(Line 19 is the `EM_DASH` import; the room-link import is the last of
the three that follow it.)

Add directly beneath it:
```ts
import { CopyValue } from './copy-value.js'
```

**Implementation, step 2 -- add the `youBlock` helper.**

Put it immediately before `memberItem`'s doc comment, which opens with
`/**` at line 410 and closes at 420, with the function itself at 421.
Insert above line 410, not into the comment, so the block helpers stay in
the order the page renders them and that comment stays with its function.

It takes primitives rather than `state`: everything it shows is already
derived in `Room`, and a pure function of four values is the whole
reason the block is assertable.

```ts
/**
 * Who this client is: the name and key that identify it, then its
 * standing in the group. Every value is already derived in `Room` --
 * this holds no state and looks nothing up.
 *
 * The name is a plain string rather than `Member|undefined` because the
 * fallback is `Room`'s to choose, not this function's; see the call.
 */
function youBlock (
    name:string,
    identity:string|null,
    leaf:number|null,
    isCreator:boolean,
    onCopyError:(err:unknown) => void
) {
    return html`
        <div class="block you">
            <h2>You</h2>

            ${/* `dt` above `dd` rather than the flex strip below: the
                  key is 43 characters and does not sit beside a
                  label. The disclosure cannot go between these two
                  items -- a `p` is not valid between the `dt`/`dd`
                  groups of a `dl` -- so it follows the list. */''}
            <dl class="you-identity">
                <div class="you-item">
                    <dt>Name</dt>
                    <dd><span class="own-name">${name}</span></dd>
                </div>

                ${identity !== null ? html`
                    <div class="you-item">
                        <dt>Signature public key</dt>
                        <dd>
                            <span class="own-identity">${identity}</span>
                            <${CopyValue}
                                value=${identity}
                                label="Copy your signature public key"
                                onError=${onCopyError}
                            />
                        </dd>
                    </div>
                ` : null}
            </dl>

            <p class="name-disclosure">
                Your name is not a secret. It rides in your key package
                as a credential, in plain text, and the server can read
                it.
            </p>

            ${/* The same shape as the Connection/Epoch strip at the top
                  of this column, and the same class, so it inherits
                  that rule's dividers and label register rather than
                  restating them. */''}
            <dl class="readout">
                ${leaf !== null ? html`
                    <div class="readout-item">
                        <dt>Leaf</dt>
                        <dd><span class="own-leaf">${
                            String(leaf)
                        }</span></dd>
                    </div>
                ` : null}

                <div class="readout-item">
                    <dt>Role</dt>
                    ${/* The word is for a person; `data-role` is what a
                          test reads, so no assertion depends on the
                          wording. */''}
                    <dd
                        class="own-role"
                        data-role=${isCreator ? 'creator' : 'member'}
                    >${isCreator ? 'Room creator' : 'Member'}</dd>
                </div>
            </dl>
        </div>
    `
}
```

**Implementation, step 3 -- derive the name and call it.**

`room.ts` lines 115-116 currently read:
```ts
    const own = members.find(member => member.leafIndex === ownLeaf)
    const ownIdentity = own ? own.identity : null
```

Add a third line directly beneath them:
```ts
    const ownName = own?.name ?? state.user.value?.name ?? ''
```

A blanked leaf costs the key row, not the block: the tree no longer
carries the name, so it comes from the session instead.

**Implementation, step 4 -- render it.**

The "Connected now" block ends at line 236 and `.room-meta` closes at
line 237. Insert the call between them, so the block is the last child
of `.room-meta`:

```ts
                ${youBlock(
                    ownName,
                    ownIdentity,
                    ownLeaf,
                    state.isCreator.value,
                    (err:unknown) => {
                        state.status.value =
                            `Could not copy the key: ${err}`
                    }
                )}
```

The `onError` body matches the two existing clipboard failures verbatim
in shape -- room.ts:167-170 and setup.ts:190-193 both assign
`state.status.value` directly, and there is no helper to route it
through.

This goes inside `.room-meta`, not inside `.room`. The warning comment
at room.ts:125-137 about a third child needing placing in the sheet
applies to `.room`'s own children -- `.room` is `display: contents` and
its children are page-grid items. `.room-meta` is a plain flow
container, so a fifth `.block` inside it needs no grid change.

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

Run the existing tests, which must all still pass before any new ones
are added:
```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: `# fail 1`, the pre-existing `placeholder-disclosure` failure
and nothing else. If a test that counts `.block` fails, that is the grep
check above -- fix the count.

**Commit:**
```sh
git add example-realistic-demo/client/views/room.ts
git commit -m "feat: say who this client is in the room"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for the block

**Verifies:** `room-you-section.AC1.1`, `.AC1.2`, `.AC1.3`, `.AC1.4`,
`.AC1.5`, `.AC1.6`, `.AC3.1` (completing Phase 1),
`.AC3.3` (completing Phase 1), `.AC4.2`

**Files:**
- Modify:
  `/Users/nick/code/webcrypto-mls/test/example-realistic-demo/views.ts`
  (unit)

**Implementation, step 1 -- extend the imports.**

Two edits. The vnode helper import begins at line 34:
```ts
import { allNodes, childrenOf, findByType, findByClass } from
    '../example/vnode.js'
```
Add `findByClassToken` to that list.

Then add, beneath the `copy-value.js` import added in Phase 1:
```ts
import { CopyValue } from
    '../../example-realistic-demo/client/views/copy-value.js'
```
Phase 1 imported only `CopyControl` from that module; this adds
`CopyValue` to the same import statement rather than a second one.

**Implementation, step 2 -- let a test reach the state, and set a user.**

`memberRoom` at lines 640-669 returns only the rendered tree, and never
sets `state.user`. Two tests below need the state object (to read
`state.status` after a refused copy) and one needs a session name (the
AC1.6 fallback).

Refactor it so the existing call sites keep working unchanged. There are
12 of them -- `grep -c "memberRoom(" test/example-realistic-demo/views.ts`
-- and the refactor below is signature-preserving, so all 12 keep
working without edits. Run that grep and confirm the count before you
start, so you know what you are protecting.

Replace the current `memberRoom` with these two functions:

```ts
function memberRoomState (opts:{
    isCreator?:boolean
    live?:string[]
    ownLeaf?:number
    removed?:boolean
    userName?:string
    onRemove? (member:Member):void
}) {
    const g = globalThis as unknown as { location?:unknown }
    const previous = g.location
    g.location = { origin: 'https://demo.test' }

    try {
        const tree:RatchetTree = [aliceLeaf, undefined, bobLeaf]
        const state = createRealisticState()

        state.roomId.value = 'abcdeFGH12'
        state.isCreator.value = opts.isCreator ?? false
        state.live.value = opts.live ?? []
        state.removed.value = opts.removed ?? false
        state.group.value = {
            groupContext: { epoch: 2n },
            ratchetTree: tree,
            privatePath: { leafIndex: opts.ownLeaf ?? 0, privateKeys: {} }
        } as unknown as typeof state.group.value

        if (opts.userName !== undefined) {
            state.user.value = {
                name: opts.userName
            } as unknown as typeof state.user.value
        }

        return { tree: room(state, { onRemove: opts.onRemove }), state }
    } finally {
        g.location = previous
    }
}

function memberRoom (opts:Parameters<typeof memberRoomState>[0]) {
    return memberRoomState(opts).tree
}
```

Everything inside `memberRoomState` except the `userName` block and the
`return` is the current body, unchanged. The `location` stub is still
restored in a `finally`, and it must stay that way -- `Room` reads
`location.origin` for the room URL.

**Testing:**

Add these after the existing member and disclosure tests (the last of
which ends at line 796), so the "You" tests read as a group.

Tests must verify each AC listed above:

- **AC1.1:** exactly one element carries the `you` class. Use
  `findByClassToken`, not `findByClass` -- the element is
  `class="block you"`.
- **AC1.2:** `.own-name` holds the name from the leaf this client sits
  at, and it follows `ownLeaf` rather than always being the first leaf.
  Read text with the `childrenOf` idiom from the existing member-name
  test at views.ts:676-682.
- **AC1.3:** `.own-identity` holds `ownIdentity` in full -- compare
  against the `aliceIdentity` fixture, so the assertion is on the whole
  base64url string.
- **AC1.4:** `.own-leaf` holds the leaf index, and follows `ownLeaf`.
- **AC1.5:** `.own-role` carries `data-role` `'creator'` when
  `state.isCreator` is true and `'member'` when false. Assert the
  attribute, not the words -- the wording is checked by eye, per the
  project's standing test plan.
- **AC1.6:** with `ownLeaf` set to a leaf the tree does not hold, the
  name comes from the session and no `.own-identity` renders.
- **AC3.1:** exactly one `CopyValue` renders, its `value` is the key,
  and its `label` differs from the name the room link's copy button
  already carries. Read that name out of `RoomLink` rather than writing
  it into the test as a literal: the point of the criterion is that the
  two controls in this column are distinguishable, and hardcoding either
  name would leave the test passing if one of them changed to match the
  other. `RoomLink`'s button is named `'Copy room URL'`
  (room-link.ts:37), so a check against the bare string `'Copy'` proves
  nothing.
- **AC3.3:** calling that `CopyValue`'s `onError` moves
  `state.status`, and no confirmation renders (the block never renders
  one itself -- `CopyValue` owns it, and it is unexpanded here).
- **AC4.2:** exactly one `.name-disclosure` renders inside the `.you`
  block -- search within the block element, not the whole tree.

Write:

```ts
test('Room says who this client is', t => {
    const tree = memberRoom({})

    const you = findByClassToken(tree, 'you')
    t.equal(you.length, 1, 'should render one You block')

    t.deepEqual(
        findByClass(tree, 'own-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Alice']],
        'should name this client from its own leaf'
    )
    t.deepEqual(
        findByClass(tree, 'own-identity').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [[aliceIdentity]],
        'should show the whole signature public key'
    )
    t.deepEqual(
        findByClass(tree, 'own-leaf').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['0']],
        'should show the leaf index the group holds'
    )
})

test('the You block follows the leaf, not the first member', t => {
    const tree = memberRoom({ ownLeaf: 1 })

    t.deepEqual(
        findByClass(tree, 'own-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Bob']],
        'the name should come from the leaf this client sits at'
    )
    t.deepEqual(
        findByClass(tree, 'own-identity').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [[bobIdentity]],
        'and so should the key'
    )
    t.deepEqual(
        findByClass(tree, 'own-leaf').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['1']],
        'and so should the leaf index'
    )
})

test('the You block says which of the two roles this client has', t => {
    const asCreator = findByClass(
        memberRoom({ isCreator: true }),
        'own-role'
    )
    t.equal(asCreator.length, 1, 'should render one role')
    t.equal(
        asCreator[0].props['data-role'],
        'creator',
        'the room creator is marked as the creator'
    )

    const asMember = findByClass(
        memberRoom({ isCreator: false }),
        'own-role'
    )
    t.equal(
        asMember[0].props['data-role'],
        'member',
        'and everybody else is marked a member'
    )
})

test('the You block survives a leaf that is not in the tree', t => {
    const tree = memberRoom({ ownLeaf: 5, userName: 'Zara' })

    t.equal(
        findByClassToken(tree, 'you').length,
        1,
        'the block is still rendered'
    )
    t.deepEqual(
        findByClass(tree, 'own-name').map(node => {
            return childrenOf(node).filter(kid => kid !== undefined)
        }),
        [['Zara']],
        'the name falls back to the one held for the session'
    )
    t.equal(
        findByClass(tree, 'own-identity').length,
        0,
        'and there is no key to show, so no key row'
    )
})

test('the You block offers to copy the key, named for the key', t => {
    const tree = memberRoom({})
    const copies = allNodes(tree).filter(node => {
        return (node.type as unknown) === CopyValue
    })

    t.equal(copies.length, 1, 'should render one copy control')
    t.equal(
        copies[0].props.value,
        aliceIdentity,
        'it should copy the key, not the room URL'
    )

    // Both names are read out of the components rather than written
    // here, so this fails if either one changes to match the other.
    const linkLabel = findByClass(roomLink({}), 'copy')[0]
        .props['aria-label']
    t.ok(linkLabel, 'the room link copy button has a name')
    t.notEqual(
        copies[0].props.label,
        linkLabel,
        'the two copy controls in this column are named differently'
    )
})

test('a refused copy of the key is reported to the person', t => {
    const { tree, state } = memberRoomState({})
    const before = state.status.value

    const copies = allNodes(tree).filter(node => {
        return (node.type as unknown) === CopyValue
    })
    ;(copies[0].props.onError as (err:unknown) => void)(
        new Error('no clipboard')
    )

    t.notEqual(
        state.status.value,
        before,
        'the refusal should reach the status line'
    )
    t.equal(
        findByClass(tree, 'copied').length,
        0,
        'and nothing should claim a copy happened'
    )
})

test('the You block says a name is not hidden from the server', t => {
    const you = findByClassToken(memberRoom({}), 'you')[0]

    t.equal(
        findByClass(you, 'name-disclosure').length,
        1,
        'the disclosure sits with the name it is about'
    )
})
```

Three things worth not changing: `roomLink` is the existing helper at
views.ts:136-143, already in scope -- do not write a second one; the
leading `;` before `(copies[0]...` is required, matching views.ts:173
and :783; and
`childrenOf(node).filter(kid => kid !== undefined)` is how this suite
reads an element's text, from views.ts:676-682.

**Verification:**

Run:
```sh
npx esbuild test/example-realistic-demo/views.ts --bundle \
    --platform=node --format=cjs --loader:.json=json --keep-names \
    --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```
Expected: `# fail 1` -- the pre-existing `placeholder-disclosure`
failure only. All seven new tests pass, and so do the eight existing
`memberRoom` tests (views.ts:671, 687, 715, 724, 741, 754, 776, 800).

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
git commit -m "test: cover the You block"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

---

## Phase 2 done when

1. `npx eslint example-realistic-demo/client/views/room.ts test/example-realistic-demo/views.ts test/example/vnode.ts`
   is clean.
2. `npx tsc --noEmit 2>&1 | grep "error TS"` reports only the
   pre-existing `key-schedule.ts(73,9)` error.
3. The single-file bundle of `views.ts` reports `# fail 1`, and that one
   is the pre-existing `placeholder-disclosure` failure.
4. `npm run test:node` reports no failure other than that one. Over ten
   minutes; run it once to close the phase.

The block is unstyled at this point. It renders in document order with
no `.you` rule, which is Phase 4's job. Do not add CSS here.

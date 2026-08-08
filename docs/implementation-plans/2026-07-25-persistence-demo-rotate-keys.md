# Rotate Keys Controls in the Persistence Demo -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the persistence demo the same per-member "Rotate Keys"
controls as the main demo, so hovering a button highlights that member's
direct path in the ratchet tree and shows the key-change count, and
clicking it performs the MLS self-update commit without leaving any
persisted indexedDB record behind at a dead epoch.

**Architecture:** `rotateKeys` moves out of `example/state.ts` into
`example/demo-actions.ts`, typed against `DemoState` like every other
shared action, and gains an injected user-creation function so each page
controls how a not-yet-joined member's key package is regenerated. The
persistence demo injects its non-extractable keypair generator; the main
demo injects nothing and keeps today's behaviour behind a thin wrapper.
The persistence demo then renders the main demo's `.controls.user` block
verbatim, wraps its click in the existing `syncPersistedMembers`, and
brings its Status card up to the main demo's structure so the hover
readout lands in the same place.

**Tech Stack:** TypeScript, Preact + htm, @preact/signals, tapzero tests
bundled with esbuild (`npm test`), eslint (`npm run lint`).

**Scope:** 3 tasks, executed in order. Tasks 2 and 3 both edit
`example/persistence-demo.ts`; Task 2 must land before Task 3.

**Codebase verified:** 2026-07-25, by direct read of
`example/index.ts`, `example/persistence-demo.ts`, `example/state.ts`,
`example/demo-state.ts`, `example/demo-actions.ts`,
`example/tree-view.ts`, `example/tree-diagram.ts`, `example/style.css`,
`test/example/demo-actions.ts`, `test/index.ts`, `package.json`.

## Background (why)

The persistence demo already has every piece of the hover machinery: the
`hoveredUser` and `selectedNodeIndex` signals, the `hoveredPath` and
`panelDetail` computeds, `TreeDiagram`, `TreeNodeDetailPanel`, and the
Escape-to-deselect effect are byte-for-byte equivalent to the main
demo's. What is missing is the *trigger*. In the main demo the
hover/focus handlers hang off the Rotate Keys buttons
(`example/index.ts:423-433`); the persistence demo has no such buttons,
so nothing ever produces the blue direct-path highlight or the
"Rotating keys would change n keys" readout. Its only hover affordance
is a `tabindex="0"` span on the "In group (Epoch: N)" list text
(`example/persistence-demo.ts:462-476`), which is not an affordance the
main demo has.

Adding the main demo's control verbatim would break this page's premise.
`State.rotateKeys` has a branch for a member who exists but is not in a
group (`example/state.ts:107-115`): it calls `State.createUser`, which
routes to `createUser(state, name)` with **no options**, producing an
extractable keypair from the ciphersuite's own keygen. The persistence
demo deliberately generates non-extractable Ed25519 keys
(`example/persistence-demo.ts:197-204`) because a non-extractable
private key is what a real persisted identity would use. A rotation that
silently downgraded a member to an extractable identity would defeat the
whole page.

Rotation also advances the epoch for every in-group member. Every other
state-advancing handler in the persistence demo already awaits
`syncPersistedMembers()` (lines 336, 546, 578, 627) precisely so a saved
record never restores at a dead epoch -- the class of bug fixed in
`983d955` and `a1c75fa`. A rotate handler that skipped it would
reintroduce it.

## Design decisions (settled before planning)

1. **Not-yet-joined members:** regenerate the key package, but with a
   non-extractable keypair on the persistence page. Implemented by
   injecting a creation function rather than eagerly generating a
   keypair on every rotate click -- keygen then only happens on the
   branch that needs it.
2. **Placement:** match the main demo exactly, in the `.controls.user`
   row above the Users list. Reuses the existing `.rotate-control` CSS
   (`example/style.css:158-168`); no new styles.
3. **Status card:** full parity -- member count, current epoch, epoch
   authenticator, status text, plus the existing node detail panel.
4. **Old hover:** the `tabindex="0"` span hover is removed; the rotate
   button becomes the single hover affordance.

## Global Constraints

- TypeScript style: no space around type colons (`name:string`), max 80
  columns, ternaries formatted `cond ?` / `value :` / `value`.
- No em dashes and no `->` arrow characters in docs or comments; use
  `--` and `->`.
- Tests: tapzero, run with `npm test`. Do not test for specific UI text
  content in HTML. The example tests use real crypto, no mocks -- see
  `test/example/demo-actions.ts` for the established shape (build a
  `createDemoState()`, run actions, assert on the resulting signals).
- `test/index.ts:19` already imports `./example/demo-actions.js`; no
  test-registry change is needed for the new tests.
- Deep imports from `../src/...` are the established pattern in
  `example/`, and `../../src/...` in `test/example/`.
- `example/demo-actions.ts` swallows per-member broadcast failures with
  a bare `catch { /* comment */ }` (see lines 411-414) rather than
  logging. It has no `Debug` import and must not gain one.
- Batch sequential signal writes with `batch()` from @preact/signals.
- NEVER run manual browser verification against
  `http://localhost:1234` -- that origin holds the user's real demo
  data. Use `http://127.0.0.1:1234` (same dev server, separate origin,
  separate indexedDB).
- Do not change CSS. Every class this plan uses already exists.

## File Structure

- Modify `example/demo-actions.ts` -- add the exported `rotateKeys`
  action. Every MLS symbol it needs (`createCommit`,
  `encodeMlsMessage`, `decodeMlsMessage`, `makePskIndex`,
  `processPublicMessage`) is **already imported** at lines 2-20. No new
  imports.
- Modify `example/state.ts` -- `State.rotateKeys` becomes a delegating
  wrapper like `State.createUser` and `State.removeUserFromGroup`. The
  entire `../src/index.js` import block (lines 10-16) and the `Debug`
  import plus `debug` const (lines 18-19) become unused and are deleted.
- Modify `example/persistence-demo.ts` -- add the rotate controls, the
  `rotateAndSync` helper, and the Status card parity; remove the span
  hover and the standalone status paragraph.
- Modify `test/example/demo-actions.ts` -- add tests for `rotateKeys`.

No file is created or deleted.

---

<!-- START_SUBCOMPONENT_A (tasks 1-1) -->
<!-- START_TASK_1 -->
### Task 1: Move `rotateKeys` into `demo-actions.ts`

**Files:**
- Modify: `example/demo-actions.ts` (insert after `removeUserFromGroup`,
  which ends at line 426, before the
  `// Decrypt a message for a specific user` comment at line 428)
- Modify: `example/state.ts:1-19` (imports) and `:88-177`
  (`State.rotateKeys`)
- Test: `test/example/demo-actions.ts` (append; unit)

**What this task proves:**
- Rotating an in-group member advances the epoch for the rotator and
  every other in-group member, and changes the rotator's leaf HPKE key.
- With no options, a member who is not in the group has their key
  package regenerated by the default creator.
- With `options.createUser` injected, the injected function runs
  instead, so a page can control how the identity is regenerated.

- [ ] **Step 1: Write the failing tests**

Append to `test/example/demo-actions.ts`. Extend the existing import
block at lines 1-11 to add `rotateKeys`, and add the three new imports
below it:

```ts
import { test } from '@substrate-system/tapzero'
import { createDemoState } from '../../example/demo-state.js'
import {
    initCiphersuite,
    createUser,
    createMLSGroup,
    addUserToGroup,
    sendMessage,
    decryptMessage,
    removeUserFromGroup,
    rotateKeys
} from '../../example/demo-actions.js'
import { bytesToBase64url } from '../../src/index.js'
import { getHpkePublicKey } from '../../src/ratchet-tree.js'
import { leafToNodeIndex, toLeafIndex } from '../../src/treemath.js'
```

Then append these two tests to the end of the file:

```ts
test('demo-actions - rotateKeys advances the epoch for every member',
    async (t) => {
        const state = createDemoState()
        await initCiphersuite(state)

        await createUser(state, 'Alice')
        await createUser(state, 'Bob')
        await createMLSGroup(state, 'Alice')
        await addUserToGroup(state, 'Alice', 'Bob')

        const before = state.users.value.get('Alice')!.state!
        const epochBefore = before.groupContext.epoch
        const leafNode = leafToNodeIndex(
            toLeafIndex(before.privatePath.leafIndex)
        )
        const keyBefore = bytesToBase64url(
            getHpkePublicKey(before.ratchetTree[leafNode]!)
        )

        await rotateKeys(state, 'Alice')

        const after = state.users.value.get('Alice')!.state!

        t.ok(after.groupContext.epoch > epochBefore,
            'the rotator epoch advances')
        t.equal(
            state.users.value.get('Bob')?.state?.groupContext.epoch,
            after.groupContext.epoch,
            'the other member processes the commit and shares the epoch'
        )
        t.notEqual(
            bytesToBase64url(
                getHpkePublicKey(after.ratchetTree[leafNode]!)
            ),
            keyBefore,
            'the rotator leaf HPKE key changes'
        )
    }
)

test('demo-actions - rotateKeys regenerates the key package for a ' +
    'member who is not in a group',
    async (t) => {
        const state = createDemoState()
        await initCiphersuite(state)
        await createUser(state, 'Alice')
        await createUser(state, 'Bob')

        // Default path: no options, the built-in creator regenerates.
        const bobFirst = state.users.value.get('Bob')?.keyPackage
        await rotateKeys(state, 'Bob')
        t.notEqual(state.users.value.get('Bob')?.keyPackage, bobFirst,
            'the default creator regenerates the key package')

        // Injected path: the caller supplies the creation function.
        const aliceFirst = state.users.value.get('Alice')?.keyPackage
        let injectedFor:string | null = null

        await rotateKeys(state, 'Alice', {
            createUser: async (name:string) => {
                injectedFor = name
                const signatureKeyPair =
                    await globalThis.crypto.subtle.generateKey(
                        { name: 'Ed25519' },
                        false, // not extractable
                        ['sign', 'verify']
                    )
                await createUser(state, name, { signatureKeyPair })
            }
        })

        t.equal(injectedFor, 'Alice',
            'the injected creator runs instead of the default')
        t.notEqual(state.users.value.get('Alice')?.keyPackage,
            aliceFirst, 'the key package is regenerated')
        t.equal(
            (state.users.value.get('Alice')?.privateKeys
                ?.signaturePrivateKey as CryptoKey).extractable,
            false,
            'the regenerated identity keeps a non-extractable key'
        )
    }
)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: the build fails, because `rotateKeys` is not exported from
`example/demo-actions.ts`. A build failure is a valid "red" here -- the
export does not exist yet.

- [ ] **Step 3: Add `rotateKeys` to `example/demo-actions.ts`**

Insert after `removeUserFromGroup` (which ends at line 426), before the
`// Decrypt a message for a specific user` comment. Add no imports --
every symbol used below is already imported at lines 2-20.

```ts
/**
 * Rotate a member's own keys (MLS self-update via an empty commit).
 *
 * A member who is not yet in the group has no leaf to rotate, so their
 * key package is regenerated instead. `options.createUser` supplies
 * that regeneration -- the persistence demo passes its non-extractable
 * keypair generator, so a rotation there never downgrades a member to
 * an extractable identity.
 */
export async function rotateKeys (
    state:DemoState,
    rotatorName:string,
    options?:{ createUser?:(name:string) => Promise<void> }
):Promise<void> {
    const { ciphersuite, status, users } = state

    if (!ciphersuite.value) {
        status.value = 'Error: Ciphersuite not initialized'
        return
    }

    const rotator = users.value.get(rotatorName)

    if (!rotator) {
        status.value = `Error: ${rotatorName} not created`
        return
    }

    if (!rotator.state) {
        const create = options?.createUser ??
            ((name:string) => createUser(state, name))

        await create(rotatorName)

        // A replaced map entry means regeneration succeeded. On
        // failure createUser reports into `status` and leaves the
        // entry alone, so do not overwrite that message.
        if (users.value.get(rotatorName) !== rotator) {
            status.value = `${rotatorName} rotated key package`
        }

        return
    }

    try {
        status.value = `${rotatorName} rotating keys...`

        // Empty proposal list -> createCommit forces an UpdatePath,
        // rotating the committer's leaf key and advancing the epoch.
        const result = await createCommit(
            { state: rotator.state, cipherSuite: ciphersuite.value },
            {
                extraProposals: [],
                wireAsPublicMessage: true,
                ratchetTreeExtension: true
            }
        )

        users.value = new Map(users.value).set(rotatorName, {
            ...rotator,
            state: result.newState
        })

        // Broadcast the commit to every other in-group member
        if (result.commit) {
            const commitBytes = encodeMlsMessage(result.commit)

            for (const [userName, user] of users.value.entries()) {
                if (userName === rotatorName || !user.state) continue

                try {
                    const decoded = decodeMlsMessage(commitBytes, 0)
                    if (decoded?.[0].wireformat === 'mls_public_message') {
                        const processResult = await processPublicMessage(
                            user.state,
                            decoded[0].publicMessage,
                            makePskIndex(user.state, {}),
                            ciphersuite.value
                        )
                        users.value = new Map(users.value).set(userName, {
                            ...user,
                            state: processResult.newState
                        })
                    }
                } catch {
                    // Best-effort: simulates each member's own machine
                    // independently processing the commit.
                }
            }
        }

        const newEpoch = result.newState.groupContext.epoch
        status.value = `${rotatorName} rotated keys ` +
            `(now Epoch ${newEpoch.toString()})`
    } catch (err) {
        status.value = `Error rotating keys: ${err instanceof Error ?
            err.message :
            String(err)
        }`
    }
}
```

- [ ] **Step 4: Reduce `State.rotateKeys` to a wrapper in
      `example/state.ts`**

Replace the import block at lines 1-19 with:

```ts
import { signal, type Signal } from '@preact/signals'
import Route from 'route-event'
import { createDemoState, type DemoState } from './demo-state.js'
import {
    initCiphersuite,
    createUser as createUserAction,
    decryptMessage as decryptMessageAction,
    removeUserFromGroup as removeUserFromGroupAction,
    rotateKeys as rotateKeysAction
} from './demo-actions.js'
import { isDocsPath } from './routing.js'
```

The `../src/index.js` import block and the `Debug` import plus the
`debug` const are deleted -- `rotateKeys` was their only consumer.

Then replace the whole `State.rotateKeys` body (lines 88-177) with:

```ts
// Rotate a user's own keys (MLS self-update via an empty commit)
State.rotateKeys = async function (
    state:ReturnType<typeof State>,
    rotatorName:string
):Promise<void> {
    await rotateKeysAction(state, rotatorName)
}
```

The main demo's call site in `example/index.ts:436` is unchanged --
it still calls `State.rotateKeys(state, name)`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: all tests pass, including the two new `rotateKeys` tests.

- [ ] **Step 6: Lint**

```bash
npm run lint
```

Expected: clean. This is what catches the now-unused imports in
`example/state.ts` if Step 4 missed any.

- [ ] **Step 7: Commit**

```bash
git add example/demo-actions.ts example/state.ts \
    test/example/demo-actions.ts
git commit -m "refactor: move rotateKeys into demo-actions with an injectable creator"
```
<!-- END_TASK_1 -->
<!-- END_SUBCOMPONENT_A -->

---

<!-- START_SUBCOMPONENT_B (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Rotate controls and hover in the persistence demo

**Files:**
- Modify: `example/persistence-demo.ts` -- imports (lines 8-16), a new
  `rotateAndSync` helper after `createPersistentUser` (ends line 204),
  the `.controls.user` block (lines 438-451), and the users list entry
  (lines 461-483)

**Verification:** manual, in the browser. This is Preact + htm view
wiring over already-tested actions; there is no headless DOM harness in
this repo (`test/example/` covers pure modules only), and asserting on
rendered text would violate the project's "no brittle tests" rule. The
behaviour underneath was proven in Task 1.

- [ ] **Step 1: Import `rotateKeys`**

In `example/persistence-demo.ts`, add `rotateKeys` to the existing
`./demo-actions.js` import block (lines 8-16):

```ts
import {
    initCiphersuite,
    createUser,
    createMLSGroup,
    addUserToGroup,
    removeUserFromGroup,
    sendMessage,
    decryptMessage,
    rotateKeys
} from './demo-actions.js'
```

- [ ] **Step 2: Add the `rotateAndSync` helper**

Insert directly after `createPersistentUser` (which ends at line 204),
before `export const PersistenceDemo`:

```ts
/**
 * Rotating advances the epoch for every in-group member, so every
 * already-persisted record has to be re-saved or it would restore at a
 * dead epoch. A member who is not in the group yet gets their key
 * package regenerated by `createPersistentUser`, keeping the
 * non-extractable identity this page exists to demonstrate.
 */
async function rotateAndSync (name:string):Promise<void> {
    await rotateKeys(state, name, { createUser: createPersistentUser })
    await syncPersistedMembers()
}
```

- [ ] **Step 3: Replace the `.controls.user` block**

Replace lines 438-451 with the main demo's structure. The only
difference from `example/index.ts:416-453` is that creation goes
through `createPersistentUser` and the click goes through
`rotateAndSync`:

```ts
                    <div class="controls user">
                        ${EXAMPLE_USERS.map((name) => {
                            const user = users.value.get(name)
                            return user ? html`
                                <div key=${name} class="rotate-control">
                                    <span class="rotate-label">${name}</span>
                                    <button
                                        onMouseEnter=${() => {
                                            hoveredUser.value = name
                                        }}
                                        onMouseLeave=${() => {
                                            hoveredUser.value = null
                                        }}
                                        onFocus=${() => {
                                            hoveredUser.value = name
                                        }}
                                        onBlur=${() => {
                                            hoveredUser.value = null
                                        }}
                                        onClick=${() => rotateAndSync(name)}
                                    >
                                        Rotate Keys
                                    </button>
                                </div>
                            ` : html`
                                <button
                                    key=${name}
                                    onClick=${() => createPersistentUser(name)}
                                    disabled=${!ciphersuite.value}
                                >
                                    Create ${name}
                                </button>
                            `
                        })}
                    </div>
```

`.rotate-control` and `.rotate-label` are already styled at
`example/style.css:158-168`. No CSS change.

- [ ] **Step 4: Remove the span hover from the users list**

In the users list, replace lines 461-483 with a plain span. The
`persist` / `persisted` button below it is unchanged:

```ts
                                ${user.state ? html`
                                    <span>
                                        In group (Epoch:
                                        ${user.state.groupContext.epoch
                                            .toString()})
                                    </span>
                                ` : html`
                                    <span>Key package ready</span>
                                `}
```

- [ ] **Step 5: Lint and run the test suite**

```bash
npm run lint && npm test
```

Expected: both clean. No test changes in this task; this confirms
nothing regressed.

- [ ] **Step 6: Manual browser verification**

```bash
npm start
```

Open `http://127.0.0.1:1234/persistence` -- **not** `localhost:1234`,
which holds the user's real demo data in a separate origin's indexedDB.

Verify, in order:

1. Before any users exist, the controls row shows "Create Alice",
   "Create Bob", etc., exactly as the main demo does.
2. Create three users, start a group, add the other two. Each created
   user's Create button is replaced by a labelled Rotate Keys button.
3. Hover a Rotate Keys button: that member's direct path lights up blue
   in the ratchet tree and the Status card reads "Rotating keys would
   change n keys."
4. Tab to a Rotate Keys button with the keyboard: the same highlight
   appears on focus and clears on blur.
5. Hover the "In group (Epoch: N)" text in the Users list: nothing
   highlights, and it is no longer a tab stop.
6. Click persist for one member, then click Rotate Keys for a different
   member. Every in-group member's epoch advances in the Users list.
7. Reload the page. The restored member comes back at the **new** epoch,
   and the status line reports a restore with no dropped stale records.
8. Click Reset to clear indexedDB before finishing.

Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add example/persistence-demo.ts
git commit -m "feat: add rotate keys controls to the persistence demo"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Status card parity in the persistence demo

**Files:**
- Modify: `example/persistence-demo.ts` -- two new computeds after
  `treeLayout`, a `statusCard` fragment, the render block, and deletion
  of the standalone status paragraph

**Why the wrapper divs matter:** `.card.status` is a fixed-height flex
column whose **direct children** `> .status-layout` and `> .detail` are
the scroll regions (`example/style.css:262-274`). The persistence demo
currently renders `TreeNodeDetailPanel` as a direct child, so `.detail`
is the scroll region. The main demo nests it inside
`.status-layout > .status-content`, making `.status-layout` the scroll
region. Reproducing that nesting is what makes the card behave the same
under overflow. Skipping the wrappers gives a card that scrolls in the
wrong place.

**Note on the source pointer:** the main demo's epoch-authenticator
block carries `(see example/index.ts:108-116)`, which is already stale
-- the computed sits at lines 101-107. The persistence demo's copy
cites the file with no line numbers so it cannot go stale. Fixing the
main demo's reference is out of scope; see below.

- [ ] **Step 1: Add the epoch computeds**

In `PersistenceDemo`, insert after the `treeLayout` computed (which ends
at line 242) and before `hoveredPath`:

```ts
    // Every in-group member shares the same epoch, so any member's copy
    // stands in for the group's current epoch.
    const currentEpoch = useComputed(() => {
        const groupUser = Array.from(users.value.values())
            .find((user) => user.state)
        const epoch = groupUser?.state?.groupContext.epoch
        if (epoch === undefined) return null
        return epoch.toString()
    })

    // Every in-group member derives the identical epoch authenticator,
    // so any member's copy stands in for the group's.
    const epochAuthenticator = useComputed(() => {
        const groupUser = Array.from(users.value.values())
            .find((user) => user.state)
        const ks = groupUser?.state?.keySchedule
        if (!ks) return null
        return bytesToBase64url(ks.epochAuthenticator)
    })
```

`bytesToBase64url` is already imported at line 5. `useComputed` is
already imported at line 1.

- [ ] **Step 2: Build the `statusCard` fragment**

Insert immediately after `const detail = panelDetail.value` (line 353)
and before `const treeDiagramCard`:

```ts
    const statusCard = html`
        <div class="card status">
            <div class="status-layout">
                <div class="status-content">
                    <h3>Status</h3>
                    <p class="member-count">
                        Members in group:${NBSP}${participants.length}
                    </p>
                    ${currentEpoch.value !== null ? html`
                        <p class="current-epoch">
                            Current epoch:${NBSP}${currentEpoch.value}
                        </p>
                    ` : null}
                    ${epochAuthenticator.value ? html`
                        <p class="epoch-secret">
                            <span class="label">
                                Epoch authenticator:
                            </span>${NBSP}
                            <span class="value">
                                ${epochAuthenticator.value}
                            </span>
                            <br />
                            <span>
                                (see <code>
                                    example/persistence-demo.ts
                                </code>).
                            </span>
                        </p>
                    ` : null}
                    <p>${status.value}</p>
                    <${TreeNodeDetailPanel} detail=${detail} />
                </div>
            </div>
        </div>
    `
```

`participants` is already computed from `users.value` at line 218, read
during render, so the member count stays reactive. `NBSP` is already
imported at line 40.

- [ ] **Step 3: Render the card unconditionally**

Replace the conditional block at lines 424-432 -- which currently
renders an inline Status card only when a tree exists -- with the main
demo's form (`example/index.ts:404-409`):

```ts
            ${treeDiagramCard ? html`
                <div class="grid status-row">
                    ${statusCard}
                    ${treeDiagramCard}
                </div>
            ` : statusCard}
```

- [ ] **Step 4: Delete the standalone status paragraph**

Status text now lives inside the card. Delete this line (currently 596,
sitting between the closing `</div>` of the `.grid` and the messaging
block):

```ts
            <p class="status">${status.value}</p>
```

- [ ] **Step 5: Lint and run the test suite**

```bash
npm run lint && npm test
```

Expected: both clean.

- [ ] **Step 6: Manual browser verification**

```bash
npm start
```

Open `http://127.0.0.1:1234/persistence` (again, not `localhost:1234`).

Verify:

1. On a fresh load with no users, the Status card is visible and shows
   "Members in group: 0" with no epoch lines.
2. After starting a group, the card shows the member count, current
   epoch, and epoch authenticator, and sits side by side with the
   ratchet tree.
3. Status messages ("Created user: Alice", "Alice rotated keys (now
   Epoch N)") appear inside the card, and no duplicate status paragraph
   remains below the grid.
4. Hovering a Rotate Keys button still shows "Rotating keys would change
   n keys" in the card, below the status text.
5. Click a tree node to pin it: the node detail replaces the peek
   readout in the same place, and Escape clears it.
6. Shrink the window until the card overflows: the card scrolls
   internally, matching the main demo, rather than spilling past its
   bottom edge.
7. Click Reset to clear indexedDB before finishing.

Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add example/persistence-demo.ts
git commit -m "feat: bring the persistence demo status card to parity with the main demo"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_B -->

---

## Definition of done

- [ ] Every user in the persistence demo has a labelled Rotate Keys
      button in a `.controls.user` row above the Users list, laid out as
      the main demo does. Not-yet-created users still show "Create X".
- [ ] Hovering or focusing a Rotate Keys button highlights that member's
      direct path in the ratchet tree and shows "Rotating keys would
      change n keys" in the Status card.
- [ ] Clicking it performs the MLS self-update commit, broadcasts to the
      group, and re-syncs every already-persisted member so indexedDB
      records track the new epoch.
- [ ] `rotateKeys` lives in `example/demo-actions.ts` with a `DemoState`
      signature; the persistence demo's variant regenerates key packages
      with non-extractable Ed25519 keys.
- [ ] The Status card shows member count, current epoch, epoch
      authenticator, status text, and the node detail panel.
- [ ] The `tabindex="0"` hover affordance on the epoch span is gone.
- [ ] `npm test` and `npm run lint` both pass.

## Out of scope

- **The main demo's stale source pointer.** `example/index.ts:272` says
  `(see example/index.ts:108-116)` but the computed it points at moved
  to lines 101-107. Pre-existing, unrelated to this change.
- **Key Package Info panel.** The main demo's `.kpinfo` block is driven
  by a `showKeyPackage` button the persistence demo does not have -- its
  list shows plain "Key package ready" text. Adding the button is a
  separate decision, not part of Status card parity.
- **Auto-persisting on rotate.** `syncPersistedMembers` only re-saves
  members already in `persistedNames`, so a never-persisted member stays
  unpersisted after a rotation. That is existing, intended behaviour;
  this plan does not change it.
- **Headless view tests.** There is no DOM test harness in this repo and
  the project rule forbids asserting on rendered HTML text. Tasks 2 and
  3 are verified manually.

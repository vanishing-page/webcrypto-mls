# PRD: Persistence Demo Parity (Remove Member + Ratchet Tree)

## Introduction

The persistence demo (`/persistence`) mirrors the main demo's group
messaging but is missing two capabilities the main demo has:

1. Controls to remove a member from the group.
2. The interactive "Ratchet Tree" diagram.

This feature brings the persistence demo to parity on those two pieces.
Because the user asked to "re-use components as much as possible," the
work is done by extracting the relevant logic and rendering out of the
main demo into shared modules, then consuming them from both demos.
Duplication is explicitly a non-goal.

## Goals

- Add "Remove Member" controls to the persistence demo, matching the
  main demo's behavior.
- Add the interactive Ratchet Tree diagram to the persistence demo,
  with full parity: hover-to-highlight a member's direct path plus
  key-change count, and click-a-node to pin its detail panel.
- Share a single implementation of the remove-member action and the
  tree rendering between both demos (no copy/paste duplication).
- Keep the main demo's existing behavior and appearance unchanged.
- Keep persisted members in sync with the current epoch after a remove,
  reusing the persistence demo's existing `syncPersistedMembers` hook.

## User Stories

### US-001: Move `removeUserFromGroup` into shared actions
**Description:** As a developer, I want the remove-member action to live
in `demo-actions.ts` (alongside `addUserToGroup`, `sendMessage`, etc.)
so both demos can call the same implementation.

**Acceptance Criteria:**
- [ ] `removeUserFromGroup` is defined in `example/demo-actions.ts` and
      operates on `DemoState` (it only needs `ciphersuite`, `status`,
      `users`, which are all in `createDemoState()`).
- [ ] `State.removeUserFromGroup` in `example/state.ts` delegates to the
      `demo-actions.ts` implementation (or is removed and callers import
      directly) so there is a single implementation.
- [ ] The main demo's "Remove Member" buttons behave exactly as before.
- [ ] Typecheck/lint passes.

### US-002: Extract the Ratchet Tree diagram into a shared component
**Description:** As a developer, I want the tree SVG rendering to live in
a reusable module so both demos render the identical diagram from the
existing pure helpers in `tree-view.ts`.

**Acceptance Criteria:**
- [ ] A shared Preact component (e.g. `example/tree-diagram.ts`) renders
      the ratchet-tree SVG from a `TreeViewLayout`, including edges,
      nodes, node labels, and the interactive states (on-path highlight,
      selected node).
- [ ] The component owns / accepts the `treeEdgeView`, `treeNodeView`,
      and `treeNodeLabel` rendering currently inlined in `index.ts`.
- [ ] The interactive node-detail panel behavior (hover key-change
      count and clicked-node public key / JSON) is shared as well, not
      re-implemented per demo. It may be a second shared component or
      part of the same module.
- [ ] The main demo consumes the shared component and its Ratchet Tree
      card looks and behaves identically to before (hover highlight,
      click-to-pin, Escape-to-clear, key-change count text).
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using the dev-browser skill that the main demo
      tree still highlights on hover and pins node detail on click.

### US-003: Add Remove Member controls to the persistence demo
**Description:** As a user of the persistence demo, I want to remove a
member from the group, just like in the main demo.

**Acceptance Criteria:**
- [ ] When a group is active and has more than one member, the
      persistence demo shows a "Remove Member" section with
      "X removes Y" buttons, matching the main demo's control layout.
- [ ] A member cannot remove themselves (no "X removes X" button), and
      only in-group members appear as removable, matching the main demo.
- [ ] Clicking a remove button removes the target member from the group
      and advances the epoch for remaining members.
- [ ] After a successful remove, `syncPersistedMembers()` runs so any
      still-persisted members' indexedDB records reflect the new epoch.
- [ ] The removed member's own indexedDB record is left untouched (no
      deletion). A reload may still restore that record; this is
      acceptable and out of scope to change.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using the dev-browser skill.

### US-004: Add the Ratchet Tree diagram to the persistence demo
**Description:** As a user of the persistence demo, I want to see the
interactive Ratchet Tree diagram, just like in the main demo.

**Acceptance Criteria:**
- [ ] When a group is active, the persistence demo renders the shared
      tree diagram component built from the persistence demo's group
      state (via the existing `selectTreeLayout` helper and the same
      leaf-name mapping the main demo uses).
- [ ] Hovering a tree node / member highlights that member's direct path
      and shows the key-change count, identical to the main demo.
- [ ] Clicking a node pins its detail panel (kind, public key, JSON,
      root note); Escape / Clear dismisses it, identical to the main
      demo.
- [ ] The tree updates when members are added, removed, or messages
      change the epoch.
- [ ] No tree is shown before a group exists.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using the dev-browser skill.

## Functional Requirements

- FR-1: `removeUserFromGroup(state, removerName, removedName)` must be
  defined in `example/demo-actions.ts` and importable by both demos.
- FR-2: `example/state.ts` must not hold a second, independent copy of
  the remove logic; it delegates to or re-exports the shared action.
- FR-3: A shared module must render the ratchet-tree SVG (edges, nodes,
  labels) and its interactive states from a `TreeViewLayout`.
- FR-4: The interactive node-detail / key-change-count panel must be
  shared, not duplicated per demo.
- FR-5: The persistence demo must show a "Remove Member" section, shown
  only when a group is active and has more than one in-group member.
- FR-6: The persistence demo must call `syncPersistedMembers()` after a
  successful remove, matching how it already does after add / send /
  decrypt.
- FR-7: The persistence demo must render the shared tree diagram when a
  group is active, wired to its own `groupId` / `users` signals.
- FR-8: The main demo's rendered output and interactions must be
  unchanged after the extraction.

## Non-Goals (Out of Scope)

- Deleting a removed member's indexedDB record. Records are left
  untouched on removal.
- Changing restore-on-reload behavior. A removed-but-persisted member's
  record may still be restored on reload; not addressed here.
- Any change to the main demo's visual design or interactions.
- New tree features not already present in the main demo.
- Changing the underlying MLS / crypto logic.
- Adding key-rotation ("Rotate Keys") controls to the persistence demo
  (this PRD covers only remove + tree).

## Design Considerations

- Reuse the existing pure helpers in `example/tree-view.ts`
  (`selectTreeLayout`, `directPathNodeIndices`, `rotationKeyChangeCount`,
  `selectNodeDetails`) unchanged; only the rendering moves.
- The main demo currently computes `treeLayout`, `hoveredPath`,
  `panelDetail`, and holds `hoveredUser` / `selectedNodeIndex` signals in
  `index.ts` (lines ~73-159, ~356-380, ~773-843). The shared component
  should accept these (or accept the layout + callbacks) so each demo
  owns its own hover/selection signals.
- Match the existing control markup/classes (`.controls.members`,
  `.card.tree-diagram`, `.card.status`) so existing CSS in
  `example/style.css` applies with no new styles. Do not change CSS that
  is unrelated to this task.
- The persistence demo already imports `selectParticipants` and builds
  message columns the same way the main demo does; follow that pattern.

## Technical Considerations

- The main demo uses `State()` (which wraps `createDemoState()` plus a
  `route` signal); the persistence demo uses `createDemoState()`
  directly. The shared action must therefore depend only on
  `DemoState`, not on the `route`-augmented type.
- The node-detail panel in the main demo is embedded inside the Status
  card (`statusCard`), interleaved with epoch-authenticator display.
  When extracting, separate the reusable node-detail rendering from the
  main-demo-specific status content so the persistence demo can include
  the tree + node detail without pulling in unrelated status markup.
- Follow the repo TypeScript style: no space after the colon in type
  annotations, 80-column lines, `batch()` for multiple signal writes.
- SVG-returning templates are tagged with the `svg` alias of `html`;
  preserve that convention in the extracted module.

## Success Metrics

- Both demos import a single remove-member action and a single tree
  rendering module (verifiable by grep: no duplicated SVG render
  functions or remove logic).
- The persistence demo can remove a member and display the interactive
  ratchet tree, verified in-browser.
- The main demo shows no behavioral or visual regression, verified
  in-browser.

## Open Questions

- Should the shared tree module take fully-derived `treeLayout` /
  `hoveredPath` / `panelDetail` values as props, or take the group
  `users` map and derive them internally? (Leaning toward passing the
  derived layout plus hover/select callbacks so each demo keeps its own
  signals; to be settled during implementation.)

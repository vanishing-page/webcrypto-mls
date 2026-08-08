# PRD: Group Ratchet Tree Diagram

## Introduction

The browser example (`example/`) demonstrates MLS group messaging but never
shows the tree structure that underpins the protocol. The README explains the
ratchet tree at length (leaves, parent nodes, copath, blanks), yet a user
running the GUI has no way to see the tree that their group actually forms.

This feature adds a visual diagram of the group's ratchet tree, rendered
above the "How to use" section. It shows the full MLS binary tree -- member
leaves plus the internal parent nodes and any blank nodes -- so the concepts
described in the README become concrete and observable as users are added,
removed, and rotated.

## Goals

- Render the current group's full ratchet tree (leaves + parent nodes +
  blanks) as a visual diagram in the example GUI.
- Place the diagram directly above the "How to use" card.
- Visually distinguish populated nodes from blank nodes.
- Keep the diagram in sync with group state (add, remove, rotate, epoch
  changes) via the existing `@preact/signals` reactivity.
- Hide the diagram entirely when no group exists.

## User Stories

### US-001: Derive tree structure from ratchet tree state
**Description:** As a developer, I need a pure helper that turns a
`RatchetTree` into a renderable tree model so the view has clean data to draw.

**Acceptance Criteria:**
- [ ] Add a pure function (e.g. in `example/tree-view.ts` or `state.ts`) that
      takes a `RatchetTree` and returns a nested/positional model describing
      each node: node index, kind (`leaf` | `parent` | `blank`), and for
      leaves the associated member name.
- [ ] Uses existing `treemath` helpers (`root`, `left`, `right`,
      `leafWidth`, `nodeToLeafIndex`, `isLeaf`) rather than re-deriving index
      math.
- [ ] Blank entries (`undefined` in the array) are represented as `blank`
      nodes, not omitted, so tree shape is preserved.
- [ ] Leaf nodes are mapped to the correct member display name (Alice, Bob,
      Carl) using the same leaf-index source already used elsewhere
      (`state.privatePath.leafIndex`).
- [ ] Function is pure (no signals, no DOM) and unit-testable.
- [ ] Typecheck passes.

### US-002: Render the tree diagram component
**Description:** As a user, I want to see my group drawn as a tree so I can
understand how members map onto the MLS structure.

**Acceptance Criteria:**
- [ ] A new tree-diagram card renders directly above the
      `<div class="card instructions">` ("How to use") block in
      `example/index.ts`.
- [ ] The full binary tree is drawn: root, parent nodes, and leaves, with
      connecting lines showing parent/child relationships.
- [ ] Leaf nodes are labelled with their member name.
- [ ] Rendering approach is graphical (SVG or nested CSS boxes + connectors),
      chosen for whichever produces the cleaner result; not required to be
      ascii.
- [ ] The diagram updates reactively when group membership or epoch changes.
- [ ] Typecheck / lint passes.
- [ ] Verify in browser using dev-browser skill.

### US-003: Distinguish blank vs populated nodes
**Description:** As a user, I want blank nodes to look different from real
nodes so I can see the effect of removals and tree topology.

**Acceptance Criteria:**
- [ ] Populated leaf nodes, populated parent nodes, and blank nodes each have
      a visually distinct style (e.g. filled vs dashed/faded).
- [ ] After a member is removed, their former leaf renders as a blank node in
      the diagram (matching the underlying `undefined` in the ratchet tree).
- [ ] All colors come from CSS variables in the example stylesheet; reuse
      existing variables before adding new ones.
- [ ] Typecheck / lint passes.
- [ ] Verify in browser using dev-browser skill.

### US-004: Hide the diagram when no group exists
**Description:** As a user, I don't want to see an empty or broken diagram
before a group is created.

**Acceptance Criteria:**
- [ ] When `groupId` is `null` (no group), the tree-diagram card does not
      render at all (no placeholder, no empty box).
- [ ] As soon as a group is created, the diagram appears.
- [ ] Typecheck / lint passes.
- [ ] Verify in browser using dev-browser skill.

## Functional Requirements

- FR-1: The system must render a ratchet-tree diagram in the example GUI,
  positioned directly above the "How to use" card
  (`example/index.ts`, the `<div class="card instructions">` block).
- FR-2: The diagram must show the full MLS binary tree for the current group:
  member leaf nodes, internal parent nodes, and blank nodes.
- FR-3: The system must derive node structure from a member's
  `ClientState` ratchet tree using existing `treemath` helpers, treating
  `undefined` array entries as blank nodes.
- FR-4: Each leaf node must display the corresponding member's name.
- FR-5: Populated nodes and blank nodes must be visually distinguishable.
- FR-6: The diagram must re-render reactively on any group state change
  (member added, member removed, key rotation / epoch change).
- FR-7: When no group exists (`groupId` is `null`), the diagram must not
  render.
- FR-8: All colors and sizing must use existing CSS variables where possible;
  new variables only when no suitable one exists.

## Non-Goals (Out of Scope)

- No copath / direct-path highlighting for a selected member (deferred; the
  README covers this conceptually but it is not part of this diagram).
- No interactivity beyond viewing (no click-to-inspect, no tooltips required).
- No animation of key rotation or commits.
- No display of raw key material, secrets, or byte-level node contents.
- No changes to the MLS library in `src/` -- this is example-app-only.
- No pre-group "unlinked leaves" view (diagram is hidden until a group forms).

## Design Considerations

- Add the diagram as a new `card` to match existing card styling
  (`.card` in `example/style.css`).
- A classic binary-tree layout (root centered on top, children fanning out
  below) mirrors the README ascii diagram and reads naturally.
- Blank nodes: a dashed outline or faded fill communicates "empty slot"
  without adding new colors.
- Keep leaf labels to member names; avoid rendering node indices unless it
  aids clarity during development.
- Follow the repo TypeScript style (no space after colon in type
  annotations, 80-column limit) and use `batch` if setting multiple signals.

## Technical Considerations

- Tree source data: a `RatchetTree` from any in-group member's `ClientState`.
  All members share the same public tree, so any active member's state works;
  pick a stable one (e.g. the group creator / first active member).
- `RatchetTree` is the MLS array representation: even indices are leaves, odd
  indices are parents, `undefined` entries are blanks. Use `treemath` (`root`,
  `left`, `right`, `leafWidth`, `nodeToLeafIndex`, `isLeaf`) for structure.
- State lives in `@preact/signals`; the component must read the relevant
  signals (`users`, `groupId`) so Preact re-renders on change.
- Keep the structure-derivation logic pure and separate from the Preact view
  so it can be unit-tested without a DOM.

## Success Metrics

- After creating a group with N members, the diagram shows N leaves plus the
  correct parent/blank structure for that group size.
- Removing a member visibly turns their leaf into a blank node.
- Rotating keys does not break or duplicate the diagram (it stays consistent
  across epoch changes).
- No console errors when the group is empty (diagram simply absent).

## Open Questions

- For odd group sizes (e.g. 3 members), confirm the desired visual treatment
  of the blank leaf that MLS pads with -- render as a blank node (assumed) or
  omit visually?
- Which member's `ClientState` should be the canonical source for the tree
  when several are active -- always the creator, or the first active member in
  `users`? (Any is correct since the public tree is shared; pick one for
  determinism.)

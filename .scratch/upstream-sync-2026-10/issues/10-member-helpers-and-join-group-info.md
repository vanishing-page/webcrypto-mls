# 10: Read helpers: members, own leaf, GroupInfo on join

**What to build:** spec stories 11 and 12. An application lists the
group's members and reads its own leaf node without walking the
ratchet tree by hand, and a member joining through a Welcome reads the
GroupInfo extensions of the group it joined.

`getGroupMembers(state)` returns the leaf index and leaf node of every
non-blank leaf. `getOwnLeafNode(state)` returns the member's own leaf
node. Both are pure and use the tree-math helpers in
`src/treemath.ts` rather than inline index arithmetic.
`joinGroupWithGroupInfo` takes `joinGroup`'s arguments and returns the
state together with the verified GroupInfo; `joinGroup` is rewritten
to call it and return only the state, so its signature, its callers
and the demos are unchanged. Read upstream `0dd1702`, `4c3b0ef` and
`0b59ac1` for intent only.

**Blocked by:** None (can start immediately)

**Touches:** `src/client-state.ts` (`joinGroup`), a module for the
member helpers, `src/index.ts`, a scenario suite registered in
`test/matrix.ts`. Prior art: `test/scenario/group-info-extensions.ts`,
`test/scenario/three-party-join.ts`.

Note: ticket 06 also edits `src/client-state.ts`.

**Status:** done

- [x] In a group of alice, bob and charlie where bob was then removed,
      `getGroupMembers` returns alice and charlie with their leaf
      indices and not bob.
- [x] `getOwnLeafNode` returns, for each member, the leaf node whose
      credential is that member's.
- [x] A Welcome whose GroupInfo carries an application extension is
      joined with `joinGroupWithGroupInfo`, which returns that
      extension, and the joined state exchanges messages with the
      group.
- [x] `joinGroup` still joins from the same Welcome, and its existing
      suites pass unchanged.
- [x] `getGroupMembers`, `getOwnLeafNode` and `joinGroupWithGroupInfo`
      are exported from the package root.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

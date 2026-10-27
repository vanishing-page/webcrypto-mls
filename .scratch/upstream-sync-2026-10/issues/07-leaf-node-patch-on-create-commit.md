# 07: `LeafNodePatch` on `createCommit`

**What to build:** spec story 8, commit half. A committer can rotate
its credential, signature key pair, capabilities or leaf extensions in
its own UpdatePath leaf, so it no longer has to leave and rejoin to
change them. With every member able to widen its capabilities, the
group can raise its required capabilities beyond what its members
joined with.

Add an exported `LeafNodePatch` type of optional changes to the
member's own leaf: credential, signature key pair, capabilities, leaf
extensions. Accept the signature key in the forms `createGroup` and
`generateKeyPackage` already accept. `createCommit` takes an optional
patch for the committer's UpdatePath leaf; today that leaf always
reuses the old credential, signature key and capabilities. A patch on
a commit that would otherwise have no UpdatePath forces one. Before
signing, the new leaf is validated by the member's own
`AuthenticationService` with the old credential as `priorCredential`,
exactly as a peer will validate it. The new state signs with the new
key from then on. Read upstream `2b0309a` for intent only.

If ticket 06 has landed, a replaced signature private key held as
bytes appears in `consumed`; extend its lifecycle test with a patched
commit. If not, ticket 06 covers it.

**Blocked by:** None (can start immediately)

**Touches:** a new `LeafNodePatch` type (in `src/leaf-node.ts` or a
module of its own), `src/create-commit.ts` (`CreateCommitOptions`,
`createCommit`), `src/update-path.ts` (`createUpdatePath`),
`src/client-state.ts` (`validateLeafNodeUpdateOrCommit`), `src/index.ts`,
a scenario suite registered in `test/matrix.ts`. Prior art:
`test/validation/credential-continuity.ts`,
`test/scenario/gce-committer-leaf-validation.ts`,
`test/scenario/required-capabilites.ts`.

Note: tickets 03, 04, 06, 08 and 13 also edit these files.

**Status:** done

- [x] Alice commits with a patch rotating her signature key; bob
      processes the commit, and a message alice then sends verifies at
      bob.
- [x] Alice commits with a patch rotating her credential; bob's
      `AuthenticationService` is shown the new credential with the old
      one as `priorCredential`, and bob's state holds the new
      credential in alice's leaf.
- [x] Every member commits a patch adding extension X to its
      capabilities, and a GroupContextExtensions commit requiring X
      then succeeds for every member.
- [x] A patch on an Add-only commit forces an UpdatePath: bob's state
      holds alice's patched leaf after processing it.
- [x] A patch whose credential alice's own `AuthenticationService`
      refuses makes `createCommit` reject, and the state passed in is
      unchanged.
- [x] `LeafNodePatch` is exported from the package root.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

# 06: `consumed` on every state-advancing result

**What to build:** spec stories 9 and 10. Every public operation that
returns a new state also returns `consumed:Uint8Array[]`: the secret
buffers the input state references and the new state does not. The
application wipes them once the new state is persisted, and wiping
them never breaks the new state.

The results that gain the field: `CreateCommitResult` (and so
`branchGroup` and `reinitCreateNewGroup`, which return it), every
branch of `ProcessMessageResult`, and the results of
`createApplicationMessage` and `createProposal`. The rule is exact: a
buffer is listed if and only if the input state references it and the
output state does not. That includes the previous epoch's init secret
and secret tree, a historical epoch evicted by `KeyRetentionConfig`, a
ratchet's superseded chain secret, and a signature private key held as
bytes that the new state replaces. A buffer the call allocated and
already wiped is not listed. A buffer shared by both states, through
`updateArray` or otherwise, is never listed. The package never wipes a
listed buffer itself, because the caller still holds the input state
(the zeroization ownership rule in AGENTS.md). A non-extractable
`CryptoKey` is not a buffer and is not listed.

Upstream's version (`8fc07af`, `2ff7b69`) drops the list when evicting
historical epochs and preallocates the array with holes; copy neither.

The README gains a section on deleting secrets: what `consumed` holds,
that the application wipes it after persisting the new state and not
before, and that the input state is unusable afterwards. Run
`npm run toc` after adding the heading and commit what it produces.

Tickets 07, 08 and 09 add new kinds of superseded secret (a rotated
signature key, dropped pending Update keys); each of them extends the
lifecycle test below with its own operation.

**Blocked by:** None (can start immediately)

**Touches:** `src/create-commit.ts` (`CreateCommitResult`),
`src/process-messages.ts` (`ProcessMessageResult`),
`src/create-message.ts`, `src/client-state.ts`, `src/secret-tree.ts`,
`src/resumption.ts`, `README.md`, a new suite under `test/validation/`
registered in `test/matrix.ts`, `test/validation/prior-state-reuse.ts`.
Prior art: `test/validation/encryption-secret-retention.ts` (the walk
over every buffer in a state), `test/validation/prior-state-reuse.ts`,
`test/validation/key-material-retention.ts`.

Note: tickets 03, 04, 07, 08, 11 and 13 also edit these files.

**Status:** done

- [x] Through a full lifecycle (create, add, application messages both
      ways, an out-of-order message, a proposal, a commit received,
      a commit sent, an epoch eviction under a small
      `KeyRetentionConfig`, a branch and a reinit), wiping every
      buffer in each result's `consumed` leaves the new state able to
      send, receive and commit.
- [x] After each of those operations, no buffer in `consumed` is
      reachable from the new state, by identity.
- [x] After each of those operations, every secret buffer reachable
      from the input state and not from the new state is in
      `consumed`, and nothing in `consumed` was unreachable from the
      input state.
- [x] `prior-state-reuse.ts` wipes `consumed` after each step, and its
      four-leaf case, where the next commit needs a key the previous
      one superseded, still succeeds.
- [x] The README has a section on deleting secrets, and the table of
      contents is regenerated.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style`, `npm test` and `npm run test:browser`
      pass.

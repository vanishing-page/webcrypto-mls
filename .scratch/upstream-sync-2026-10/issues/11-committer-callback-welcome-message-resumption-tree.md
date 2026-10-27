# 11: Committer in the callback, `welcomeMessage`, resumption trees

**What to build:** spec stories 13, 14 and 15, three additive changes
on the commit side.

1. The commit variant of the incoming-message callback's argument
   gains `committer`, in the same `AuthenticatedSender` shape
   `ProcessMessageResult` already carries, so an application can
   refuse a commit by policy before it is accepted. (Upstream
   `5298228`.)
2. `CreateCommitResult` gains `welcomeMessage`, the Welcome wrapped as
   an `MLSMessage` with the `mls_welcome` wire format, beside the
   existing `welcome`. (Upstream `8375d8e`.)
3. `branchGroup` and `reinitCreateNewGroup` accept the
   `ratchetTreeExtension` and `wireAsPublicMessage` options
   `createCommit` already has, with the same defaults, so the Welcome
   they send can carry the ratchet tree. (Upstream `c759bc2`.)

All three are additive: no existing caller changes. Read upstream for
intent only.

**Blocked by:** None (can start immediately)

**Touches:** `src/incoming-message-action.ts`,
`src/process-messages.ts` (the commit callback call),
`src/create-commit.ts` (`CreateCommitResult`), `src/resumption.ts`,
a scenario suite registered in `test/matrix.ts`. Prior art:
`test/scenario/reject-incoming-message.ts`,
`test/scenario/process-message-sender.ts`,
`test/scenario/resumption.ts`, `test/scenario/reinit.ts`,
`test/validation/branch-welcome.ts` (branch joins need
`sameSignerKeyPackage`).

Note: ticket 06 also edits `CreateCommitResult` and
`src/process-messages.ts`.

**Status:** done

- [x] Bob's callback receives alice's leaf index and credential as
      `committer` for alice's commit.
- [x] A callback that rejects a commit by its committer leaves bob's
      state unchanged: bob stays in the old epoch and still decrypts a
      message from that epoch.
- [x] A commit's `welcomeMessage` round-trips through
      `encodeMlsMessage` and `decodeMlsMessage`, and the decoded
      Welcome joins the group.
- [x] A `branchGroup` with `ratchetTreeExtension: true` produces a
      Welcome that a member joins without being given the ratchet tree
      separately; the same holds for `reinitCreateNewGroup`.
- [x] With the options omitted, branch and reinit behave as today.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

# 04: `createCommit` drops pending proposals per RFC 9420 section 12.2

**What to build:** part of audit finding H3, spec story 8. Today
`bundleAllProposals` puts every entry of the pending set into the
commit, so ordinary honest concurrency (two members both proposing to
remove the same leaf) makes the next commit throw
`Commit cannot contain multiple update and/or remove proposals`, and
the group wedges. After this ticket, `createCommit` bundles only the
pending proposals that survive section 12.2 filtering:

- invalid ones are dropped, using the receipt validation from ticket
  03 against the progressively applied proposal list. A proposal that
  was valid on arrival can become invalid once an earlier one in the
  same commit applies.
- one Remove per leaf
- no Update for a leaf that is being removed
- no Update from the committer itself
- duplicates collapsed

A proposal dropped this way does not appear in the commit, and it is
not in the committed state's pending set. Proposals the caller passes
by value are not filtered. An invalid by-value proposal still fails
the call, because the caller asked for it explicitly.

**Blocked by:** 03 (reuses its proposal validation)

**Touches:** `src/create-commit.ts` (`createCommit`,
`bundleAllProposals`), `src/client-state.ts` (the validation exposed by
ticket 03, `validateProposals`), `test/validation/proposal-validation.ts`
or a new scenario under `test/scenario/`, `CHANGELOG.md`

Note: ticket 01 edits the send path of `createCommit`, and ticket 02
changes the pending-set type `bundleAllProposals` iterates.

**Status:** done

- [x] Two members each propose Remove of the same third member. A
      fourth member receives both and commits. The commit succeeds,
      removes the target once, and every remaining member processes it.
- [x] A pending Update from a leaf that a pending Remove targets is
      left out of the commit, and the commit succeeds.
- [x] The committer's own pending Update is left out of its commit,
      and the commit succeeds.
- [x] Two identical pending proposals produce one proposal in the
      commit.
- [x] After any of the above, the committer's new state has no pending
      proposals, and `createApplicationMessage` succeeds.
- [x] An invalid proposal passed by value to `createCommit` still makes
      the call reject with `ValidationError`.

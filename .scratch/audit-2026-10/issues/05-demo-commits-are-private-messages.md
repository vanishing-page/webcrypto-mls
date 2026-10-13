# 05: Demo commits are PrivateMessages

**What to build:** audit finding F3, spec story 7. The realistic demo's
explainer says the creator's name exists only inside an encrypted
Welcome and that the server never sees it. That is false once the
creator removes someone: `commitRemove` sends a PublicMessage, a Remove
commit carries an UpdatePath, and the committer's leaf in it holds the
basic credential with the creator's literal name.

Fix: `commitRemove` sends a PrivateMessage. `commitAdd` already has no
UpdatePath, but it switches too, so that no demo commit is public and
a later change to Add (a forced path, say) cannot reopen the leak. A
member being removed can still process the Remove: it holds the keys
for the epoch the commit is framed in. The explainer copy is correct
once commits are private and is not changed.

Check `processEntry` and the commit-verdict path still handle the
private framing (they already branch on wireformat), and read
`example-realistic-demo/AGENTS.md` first.

**Blocked by:** None (can start immediately)

**Touches:** `example-realistic-demo/client/mls-actions.ts`
(`commitAdd`, `commitRemove`, the `wireAsPublicMessage` options),
`test/example-realistic-demo/mls-actions.ts`

**Status:** done

- [x] With a group created under a distinctive creator name,
      `commitRemove`'s encoded message, decoded only from base64 and
      the MLS envelope, is `mls_private_message`, and the name's bytes
      do not occur anywhere in the encoded message.
- [x] The same holds for `commitAdd`.
- [x] The removed member, processing the private Remove through
      `processEntry`, reaches the removed state.
- [x] A remaining member processes the private Remove and the private
      Add and lands at the committer's epoch.
- [x] `npm run typecheck` and
      `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` are
      clean.

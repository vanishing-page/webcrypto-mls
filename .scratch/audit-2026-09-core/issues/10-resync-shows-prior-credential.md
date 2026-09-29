# 10: External resync shows the authentication service the prior credential

**What to build:** audit finding M2, spec story 16. When an external
commit carries a Remove (a resync), the joiner's new leaf is validated
against the tree after the Remove is applied, so the authentication
service is asked with `priorCredential` undefined. The Remove requires
only an equal signature key. A member can therefore resync under a new
identity (`carol` becomes `carol-the-admin`), and the authentication
service never sees the old one.

After this ticket, when an external commit carries a Remove, the
removed leaf's credential is passed to the authentication service as
`priorCredential` when the joiner's leaf is validated. This happens on
both sides: in the members processing the commit, and in
`joinGroupExternal` if it runs the same check.

**Blocked by:** None (can start immediately)

**Touches:** `src/process-messages.ts` (the external-commit branch that
validates the joiner's leaf), `src/client-state.ts` (the external
commit validation and the `credentialAtLeaf` helper),
`src/create-commit.ts` (`joinGroupExternal`),
`test/scenario/external-join-resync.ts`,
`test/validation/credential-continuity.ts`

**Status:** done

- [x] During a resync external commit, the authentication service's
      `priorCredential` is the removed leaf's credential.
- [x] An authentication service that refuses identity changes makes
      every member reject a resync that changes the identity, with
      `ValidationError`.
- [x] An ordinary resync under the same identity is still accepted.
- [x] An external commit with no Remove still passes `priorCredential`
      undefined.

# 14: `external_pub` is length-prefixed

**What to build:** spec story 20. External joins work across
implementations in both directions. RFC 9420 defines the
`external_pub` extension's data as a length-prefixed HPKE public key;
this package writes and reads the bare key, so two copies of it
interoperate and nothing else does.

`Extension.extensionData` keeps holding the extension's wire bytes, as
for every other extension. `createGroupInfoWithExternalPub` and
`createGroupInfoWithExternalPubAndRatchetTree` write the key with its
variable-length prefix, using the codec's existing variable-length
encoder. `joinGroupExternal` decodes the prefixed key and refuses a
missing, truncated or over-long prefix, or trailing bytes, with a
`ValidationError`, since the GroupInfo is peer input. A decoder
failure must not escape as an `InternalError` or a provider error (see
AGENTS.md on the error contract). Read upstream `4e625a5` for intent
only.

The tests need GroupInfos whose `external_pub` bytes this package
would not produce, so they re-sign the GroupInfo after editing the
extension. The re-signing helper gets an honest control: a GroupInfo
re-signed with unchanged bytes still joins.

A GroupInfo produced by 0.0.17 can no longer be joined, and no
compatibility path is kept. The changelog is generated from commit
messages, so the commit message carries a `BREAKING CHANGE:` line
saying so; do not edit `CHANGELOG.md` by hand.

**Blocked by:** None (can start immediately)

**Touches:** `src/create-commit.ts`
(`createGroupInfoWithExternalPub`,
`createGroupInfoWithExternalPubAndRatchetTree`, `joinGroupExternal`),
`src/client-state.ts` (`exportSecret`, if the decoded key is passed
there), a suite under `test/validation/` registered in
`test/matrix.ts`. Prior art: `test/scenario/external-join.ts`,
`test/scenario/external-join-resync.ts`, `test/codec/group-info.ts`,
`test/validation/peer-input-errors.ts`.

**Status:** done

- [x] The `external_pub` extension data in a GroupInfo from
      `createGroupInfoWithExternalPub` is the variable-length prefix
      followed by the exported HPKE public key, byte for byte.
- [x] An external join against a GroupInfo whose `external_pub` data
      is built by hand to RFC 9420 succeeds, and the existing members
      process the external commit.
- [x] A GroupInfo carrying the bare key, a truncated prefix, an
      over-long prefix, or the prefixed key with trailing bytes each
      makes `joinGroupExternal` reject with `ValidationError`.
- [x] The re-signing helper's honest control joins.
- [x] The commit message contains a `BREAKING CHANGE:` line.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

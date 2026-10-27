# 15: Open protocol versions inside `Capabilities`

**What to build:** spec story 21. A KeyPackage, leaf node or ratchet
tree whose leaf advertises a protocol version newer than MLS 1.0 in
its capabilities decodes, so one forward-looking peer does not lock
the member out of the group. Ciphersuites and credential types in the
same structure already decode unknown values; versions do not.

The `versions` list inside `Capabilities` is decoded and encoded with
the open-enum helpers already used for the ciphersuites and credential
types beside it, so an unknown version round-trips to the same bytes.
The strict `decodeProtocolVersion` stays for the version fields of
`MLSMessage`, KeyPackage and GroupContext. The `Capabilities.versions`
type widens accordingly; GREASE and `defaultCapabilities` keep
working. Because the leaf's signature covers its capabilities, the
test builds the KeyPackage through `generateKeyPackage` with the
widened type rather than editing bytes. Read upstream `a671d55` for
intent only.

**Blocked by:** None (can start immediately)

**Touches:** `src/capabilities.ts`, `src/protocol-version.ts`,
`src/grease.ts`, `src/default-capabilities.ts`, `src/util/` enum
helpers, `test/codec/capabilities.ts`, a scenario case registered in
`test/matrix.ts`. Prior art: `test/codec/roundtrip.ts`,
`test/codec/protocol-version.ts`, `test/grease.ts`.

**Status:** done

- [x] A `Capabilities` listing versions 1 and 2 decodes and re-encodes
      to the same bytes.
- [x] A KeyPackage whose leaf lists versions 1 and 2 decodes,
      re-encodes to the same bytes, and is added to a group whose
      members process the commit and whose new member joins.
- [x] A ratchet tree containing that leaf decodes, re-encodes to the
      same bytes, and is accepted by a joiner given it separately.
- [x] An `MLSMessage` whose top-level version is unknown is still
      refused by `decodeMlsMessage`, and a KeyPackage whose own
      version field is unknown is still refused.
- [x] The GREASE suite passes unchanged.
- [x] `npm run typecheck`, the Worker typecheck, `npm run test:checks`,
      `npm run check:style` and `npm test` pass.

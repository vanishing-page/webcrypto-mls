# Audit 2026-09: core library fixes

**Status:** ready-for-agent
**Source:** `docs/security-audit-2026-09.md` (H1-H3, M1-M4, M6, L1-L9,
L12, L15, and the record corrections that concern the library)

## Problem Statement

An application that uses this library to keep a group in sync can be
knocked out of that group, or have its secrets outlive their deletion,
by inputs the library currently accepts.

A single malicious member -- or, in some cases, an outsider who can get
a message delivered -- can send a commit with a bad confirmation tag.
The library rejects it, but has already zeroed the receiver's HPKE path
keys in the state the application still holds, so the next honest
commit fails and the member is silently expelled from every future
epoch. The same wipe happens to a committer's own prior state, which
breaks the RFC-mandated "my commit lost, process the winner from my
prior state" recovery.

Anyone who knows a group's id and epoch (both cleartext) can send a
self-signed `new_member_proposal`. The library stores it without
checking it, and the next routine commit bundles every stored proposal:
either the commit throws on the invalid one and the group is wedged
(nobody can commit or send application messages, and there is no API
to discard the proposal), or, under the default callback, the outsider
is silently added and receives a Welcome.

After a single lost or reordered message, the state retains the
application ratchet chain secret for the skipped generation, and the
key schedule retains the epoch's encryption secret. A state compromise
then recovers every message of the epoch, including ones already
consumed -- defeating the deletion RFC 9420 section 9.2 requires.

The library also verifies each message's sender and then drops it, so
every consumer attributes messages by transport metadata instead.

A long tail of smaller gaps lets one member poison the tree so no one
can join again (M1, L3), lets an external resync change identity
without the authentication service seeing the prior credential (M2),
lets a branch Welcome smuggle in unrelated members under a different
ciphersuite (M3), lets noble- and WebCrypto-provider members fork on a
non-canonical Ed25519 signature or accept an identity-point signing key
(M4), and lets peers trigger `InternalError`, `TypeError` or
`UsageError` where the error contract promises `ValidationError` (L1,
L4, L8).

## Solution

Processing or creating a commit never alters the `ClientState` the
caller passed in, whether the operation succeeds or fails. Every
retained secret is the narrowest one RFC 9420 permits. Proposals are
validated when they arrive, filtered when they are committed, and can
be listed and discarded by the application. A `new_member_proposal` is
never accepted without an explicit application decision. Application
messages and commits report their authenticated sender. Every
peer-triggerable rejection is a `ValidationError` (or `CodecError` for
undecodable bytes), and the two crypto providers agree on which
signatures are valid.

## User Stories

1. As a group member, I want a commit that fails its confirmation tag
   check to leave my state exactly as it was, so that a malicious
   member cannot expel me by sending one bad commit.
2. As a committer whose commit lost a race, I want to process the
   winning commit from my prior state, so that I can follow the RFC
   recovery path without being expelled.
3. As a committer whose `createCommit` threw partway (for example while
   building a Welcome), I want my input state still usable, so that a
   bad pending proposal cannot also destroy my keys.
4. As an application holding a `ClientState` after a successful
   operation, I want that state to remain usable for a retry or fork
   resolution, so that the functional-state contract holds on every
   path.
5. As a user whose device is seized mid-epoch, I want messages I have
   already read to be unrecoverable from my state, even if an earlier
   message was lost, so that in-epoch forward secrecy holds as RFC 9420
   section 9.2 requires.
6. As a user whose device is seized, I want the epoch's encryption
   secret to be absent from my state, so that it cannot regenerate the
   whole secret tree.
7. As a group member, I want a proposal that could never be committed
   (a Remove of a blank leaf, an Add with an unusable KeyPackage, an
   ExternalInit from a member, an invalid Update) rejected with a
   `ValidationError` on receipt, so that it never enters my pending
   set.
8. As a committer, I want `createCommit` to leave out pending proposals
   that RFC 9420 section 12.2 says to drop (invalid ones, a second
   Remove of the same leaf, an Update for a removed leaf, my own
   Update, duplicates), so that honest concurrency does not make my
   commit throw.
9. As an application, I want to list pending proposals and discard any
   of them, so that a wedged group can always be recovered without
   hand-editing state.
10. As an application, I want the pending proposal set to be bounded,
    so that an outsider cannot grow my state without limit.
11. As an application, I want the incoming-message callback to tell me
    whether a proposal came from a member, an external sender, or a
    `new_member_proposal`, so that I can decide on each kind.
12. As an application using the default callback, I want a
    `new_member_proposal` rejected unless I opted in, so that a
    stranger cannot be added to my group by the next routine commit.
13. As an application displaying a message, I want `processMessage` to
    return the authenticated sender (leaf index and sender type) and
    the authenticated data, so that I attribute messages by what MLS
    verified rather than by transport metadata.
14. As an application applying a commit, I want the result to name the
    committer, so that I can show who changed the group.
15. As a prospective joiner, I want a group whose tree contains
    duplicate HPKE keys or a pairwise credential violation to be
    impossible to create, so that the group always stays joinable.
16. As an authentication service, I want an external resync commit to
    present the removed leaf's credential as the prior credential, so
    that I can refuse an identity change.
17. As a member resuming into a branch, I want the Welcome rejected
    unless the version and ciphersuite match my current group, every
    new member matches an old one, and it carries exactly one
    resumption PSK, so that a branch cannot import strangers.
18. As a member of a group mixing crypto providers, I want every
    provider to accept exactly the same Ed25519 signatures, so that the
    group cannot fork deterministically.
19. As a group member, I want a leaf or KeyPackage whose signature key
    is the identity point (or any small-order point) rejected, so that
    no member can register a universal-forgery key.
20. As a joiner, I want a malformed `ratchet_tree` extension rejected
    as a decode failure rather than an `InternalError`, so that the
    error contract holds for peer input.
21. As a joiner, I want a Welcome that omits a `path_secret` I need
    rejected at join time, so that I am not admitted into a group I
    will be unable to follow.
22. As a group member, I want a commit rejected when the committer's
    new leaf reuses an HPKE key from its own UpdatePath, so that the
    tree stays joinable.
23. As a group member, I want an Add committed alongside a
    GroupContextExtensions proposal checked against the new
    extensions, and a failure reported as `ValidationError`, so that no
    member joins unable to support the group.
24. As a group member, I want proposal references and external PSK ids
    that collide with `Object.prototype` names (such as `toString`)
    handled as ordinary unknown ids, so that peers cannot crash my
    processing.
25. As a group member, I want a PrivateMessage labelled with a future
    epoch rejected before it is unprotected, so that it is never
    processed under current keys.
26. As a group member, I want an Update that keeps the sender's current
    encryption key rejected, so that RFC 9420 section 12.1.2 holds.
27. As an application, I want an unknown or GREASE credential type, a
    PublicMessage carrying application content, a wrong-length
    signature key, and an AEAD failure inside HPKE to surface as the
    documented error types, so that my error handling does not need
    to catch `TypeError` or `DOMException`.
28. As an application, I want `createProposal` to refuse to run for a
    removed or suspended client, so that I cannot emit proposals from a
    state that may no longer send handshake messages.
29. As a maintainer, I want the auto-dependabot workflow to guard on
    the branch and label it means to, await its merge call, and every
    workflow to declare least-privilege `permissions`, so that a later
    trigger change cannot turn it into an exposure.
30. As a reader of `docs/security-audit.md` and `AGENTS.md`, I want the
    rows the 2026-09 audit proved inaccurate corrected, so that the
    records describe the code.

## Implementation Decisions

### Ownership of private path keys (H1)

- The functions that merge and prune the private key path stop zeroing
  anything. Neither owns its inputs, so this applies the same ownership
  rule already applied to the secret tree (the earlier audit's C1).
  Superseded HPKE path keys go to the garbage collector untouched,
  exactly as a secret that is merely being dropped does today.
- On receive, the whole derivation -- converting path secrets to a
  private key path, the commit secret, epoch initialization and the
  confirmation tag check -- completes before the merged private path
  is built. Nothing in the returned or retained state is touched until
  the tag verifies.
- On send, the merged path is built only after every step that can
  throw, including Welcome construction.
- An explicit "zeroize superseded keys" helper for callers that have
  provably discarded the old state is out of scope (see Out of Scope).

### Retained ratchet material (H2)

- For each skipped generation, the ratchet stores the derived
  `{key, nonce}` pair for that generation, never the chain secret. The
  stored nonce is the raw derived nonce; the reuse guard is applied at
  use, as today. Every intermediate chain secret the ratchet allocates
  (all except its input) is wiped once the next one is derived.
- The retained-generation record changes shape from a map of chain
  secrets to a map of key/nonce pairs. This is a change to the exported
  `ClientState` type and is recorded in the CHANGELOG as breaking.
  There is no in-library migration, because the library has no state
  serialization format. The shared demo persistence store bumps its
  IndexedDB version so sessions saved in the old shape are discarded
  rather than loaded; both demos pick that up because the store is
  shared.
- `encryptionSecret` is no longer kept on the `KeySchedule` held by
  state. It is passed to secret-tree creation and zeroed by the call
  that allocated it. Every call site allocates it in the same call, so
  this respects the ownership rule. The key-schedule vector test
  compares it at the derivation seam instead of reading it from state.
  `KeySchedule` is exported, so this is also a CHANGELOG entry.
- `applicationExportSecret` and `exporterSecret` stay on `KeySchedule`
  (see Out of Scope).

### Proposal lifecycle (H3)

- Receipt validation: a proposal that can never be valid in the current
  epoch is rejected with `ValidationError` before it is stored. That
  covers a Remove naming a blank or out-of-range leaf, an Add whose
  KeyPackage fails validation (which now includes that its `initKey`
  imports under the group's ciphersuite), an ExternalInit from any
  sender, and an Update whose leaf fails leaf validation.
- Commit-time filtering follows RFC 9420 section 12.2: `createCommit`
  bundles only the pending proposals that survive filtering -- invalid
  ones dropped, one Remove per leaf, no Update for a leaf being
  removed, no Update from the committer, duplicates collapsed. A
  proposal dropped this way is also removed from the committed state's
  pending set.
- Pending proposal API: the library exports a way to list pending
  proposals with their references and senders, and a way to return a
  new state without a given proposal. Both are pure functions over
  `ClientState`, in keeping with the functional-state model.
- Bound: the pending set is capped by a new `ClientConfig` field with a
  documented default. A proposal arriving at the cap is rejected with
  `ValidationError`; nothing already pending is evicted, so an outsider
  flood cannot push out an honest proposal. The cap check uses an
  explicit `max <= 0` branch, following the retention-trimming rule.
- The pending set is keyed so that no reference can collide with an
  `Object.prototype` member (L5, see below).
- Callback: the incoming-message callback's proposal input gains the
  sender type (`member`, `external`, `new_member_proposal`,
  `new_member_commit`). This is an additive change to the input
  object.
- Default callback: the default the library uses when none is passed
  rejects `new_member_proposal` and accepts everything else. `acceptAll`
  remains exported and keeps its literal meaning for applications that
  deliberately allow open self-add. The README states which default
  applies and why.
- Pending application messages remain refused while proposals are
  pending (RFC behaviour); the discard API is what unblocks a wedged
  group.

### Authenticated sender (M6)

- The `applicationMessage` result gains the sender (leaf index and
  sender type) and `authenticatedData`. The `newState` result for a
  commit gains the committer's sender. Both are additive fields on
  `ProcessMessageResult`.

### Tree and membership integrity (M1, M2, M3, L2, L3, L4, L7)

- M1: each Update in a commit is validated against the progressively
  updated tree, the same way Adds already are, so uniqueness and the
  pairwise credential rule see earlier proposals in the same commit.
- M2: when an external commit carries a Remove, the removed leaf's
  credential is passed to the authentication service as
  `priorCredential` when validating the joiner's leaf.
- M3: a branch Welcome is rejected unless version and ciphersuite equal
  the resuming state's, and it carries exactly one resumption PSK.
  Matching every new leaf to an old leaf needs a definition of "the
  same member"; that is supplied by the existing key-package equality
  configuration, falling back to signature-key equality when none is
  configured.
- L2: a Welcome whose joiner needs a `path_secret` (the common ancestor
  with the signer is non-blank and does not list the joiner as
  unmerged) and does not carry one is rejected. The "no overlap between
  provided private keys and update path" failure on the external-join
  side becomes a `ValidationError`.
- L3: a commit whose new committer leaf HPKE key equals any key on its
  own UpdatePath is rejected.
- L4: Adds in a commit that also carries GroupContextExtensions are
  checked against the proposed extensions; a failure is a
  `ValidationError`, including at `joinGroup`, where a peer-caused
  failure is currently reported as `UsageError`.
- L7: an Update whose `hpkePublicKey` equals the sender's current leaf
  key is rejected.

### Message handling (L1, L5, L6, L8, L9)

- L1: the ratchet tree decoder returns a decode failure for an empty
  node list or one ending in a blank node, so `joinGroup` and
  `joinGroupExternal` surface `CodecError` rather than the extend-tree
  `InternalError`. This follows the AGENTS.md rule for low-level guards
  reachable from the wire.
- L5: proposal-reference and external-PSK lookups use own-property
  lookups (a `Map` or a null-prototype record); the choice is left to
  the implementer, but the same choice is used for both.
- L6: a PrivateMessage whose epoch is greater than the current epoch is
  rejected before unprotection.
- L8: the credential decoder has a default arm (unknown or GREASE type
  becomes a decode failure); a PublicMessage carrying application
  content and a wrong-length Ed25519 key surface as `ValidationError`;
  AEAD failure inside HPKE surfaces as `CryptoVerificationError`, the
  same class as MAC and signature failures.
- L9: `createProposal` runs the same can-send gate as the other
  handshake constructors.

### Signature verification (M4, L12)

- Both noble EdDSA verifies use strict (non-zip215) verification,
  matching WebCrypto's RFC 8032 behaviour.
- LeafNode and KeyPackage validation reject a signature public key that
  is the identity point or of small order, for Ed25519 and Ed448.
- L12 (ECDSA high-S) is documented, not enforced. WebCrypto's ECDSA
  verify accepts high-S, so enforcing low-S in the noble provider alone
  would recreate the provider-fork M4 fixes. The README's security
  considerations state that signed bytes are malleable in `s` and that
  applications must not key anything on a hash of a signature.

### CI and records (L15, record corrections)

- `auto-dependabot.yml` guards on the Dependabot branch name and label
  correctly and awaits its merge call; it and `nodejs.yml` declare
  explicit least-privilege `permissions`.
- `docs/security-audit.md` "Confirmed correct" is corrected for the
  confirmation tag. `AGENTS.md`'s statement about `npm audit` is
  corrected to match reality (clean for runtime dependencies), or
  `npm audit fix` is run so the statement becomes true; the implementer
  picks whichever leaves the lockfile valid under `npm ci`.

## Testing Decisions

- A good test drives the public `ClientState` operations
  (`createGroup`, `joinGroup`, `createCommit`, `processMessage` and
  friends) through a group scenario and asserts on what an application
  would observe: which call resolves or rejects, the error class, and
  whether a later honest operation still succeeds. Tests do not reach
  into private helpers, and do not assert on error message text.
- One seam for almost everything: group scenarios through the public
  operations. Hostile inputs are built by a test-only peer that
  constructs a valid message and then alters one field (flipped
  confirmation tag re-MACed or re-encrypted, a proposal naming a blank
  leaf, a Welcome missing a path secret) -- the same shape the existing
  scenario tests use.
- The crypto provider's `verifyWithLabel` is the second, narrower seam,
  for M4 and L12 only: a crafted non-canonical-R signature and an
  identity-point key, asserted to verify identically across the noble
  and WebCrypto providers.
- H1 is tested by holding the prior state, as
  `test/validation/prior-state-reuse.ts` already does for the secret
  tree: reject a bad-tag commit, then process an honest commit from the
  same retained state; lose a commit race and process the winner; make
  `createCommit` throw after path generation and retry.
- H2 is tested by observable behaviour, not by inspecting fields: after
  a skipped generation and in-order receipt of later ones, a test
  simulating state compromise shows that nothing in the state decrypts
  an already-consumed generation. The existing generation-out-of-order
  scenario remains the positive control.
- Proposal lifecycle tests cover receipt rejection, section 12.2
  filtering under honest concurrency (two concurrent Removes of the
  same leaf), the list/discard API unwedging a group, the cap, and the
  default callback rejecting a `new_member_proposal`.
- Tests that fan out over ciphersuites use `sampleCiphersuites()`
  unless a second suite genuinely tells them something; every group
  test passes `testClientConfig`. New files are imported from
  `test/unit.ts` or `test/matrix.ts`, or they do not run.
- Prior art: `test/validation/prior-state-reuse.ts`,
  `test/validation/proposal-validation.ts`,
  `test/validation/credential-continuity.ts`,
  `test/scenario/external-join-resync.ts`,
  `test/scenario/resumption.ts`,
  `test/scenario/generation-out-of-order.ts`,
  `test/scenario/proposal-epoch-mismatch.ts`, and
  `test/crypto/signature-interop.ts`.
- L15 and the record corrections are verified by inspection and by the
  existing CI jobs running green; no test asserts on docs or workflow
  files.

## Out of Scope

- An explicit API to zeroize superseded HPKE path keys once a caller
  has discarded the old state. Removing the wipe restores correctness;
  reclaiming those keys early is a separate forward-secrecy feature.
- The Informational items in the audit: transient secrets that are
  never zeroed, `applicationExportSecret` and `exporterSecret` held for
  the epoch, trailing bytes after SenderData, forward-ratchet cost,
  blanking outside the filtered direct path, lifetime expiry with
  path-less Adds, and the PQ suite naming and ML-DSA observations.
- Sending commits as PrivateMessage in the demo, and every other demo
  or attachment finding (see the sibling specs).

## Further Notes

- Suggested order, from the audit: H1 and H3 first (both are remote
  denial of service and they compound), then H2, then M1-M4, then M6
  (the demo spec's H5 depends on it), then the Lows.
- H1 contradicts the earlier audit's claim that verification precedes
  state mutation; the correction in `docs/security-audit.md` should say
  the confirmation tag was the exception and name this spec.
- The CHANGELOG needs entries for the `ClientState`, `KeySchedule`,
  `ProcessMessageResult`, callback input, default callback and
  `ClientConfig` changes.

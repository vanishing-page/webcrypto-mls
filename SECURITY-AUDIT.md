# Security & RFC 9420 Conformance Audit

Audit of `src/` against RFC 9420 (The Messaging Layer Security Protocol).
Scope: five parallel reviews covering tree math/hashing, key schedule &
secrets, message framing/protection, group evolution (proposals / commits /
welcome / joining), and cryptographic primitives / codec.

Status legend for tasks: `[ ]` open, `[x]` done.

Note on verification: the node test suite passes (`npm run test:node`, exit 0),
so every issue below is a gap the current tests do not exercise. Several are
interop or security failures that only appear against a second, conformant
implementation or a malicious peer.

Corrected during audit: an initial report flagged the ProposalRef label
(`authenticated-content.ts:93`) as wrong. Verified against RFC 9420 section 5.2
-- `"MLS 1.0 Proposal Reference"` is correct. No action needed.

--------------------------------------------------------------------------------

## CRITICAL

### C1. Single Update/Remove/GroupContextExtensions commits are built and accepted without an UpdatePath

- Files: `src/client-state.ts:635-636` (decision), consumed at
  `src/create-commit.ts:122-130,148-151` (creation) and
  `src/process-messages.ts:248` (receive enforcement).
- Current code:
  ```js
  const needsUpdatePath =
      allProposals.length === 0 ||
      Object.values(grouped.update).length > 1 ||
      Object.values(grouped.remove).length > 1
  ```
  `grouped.update` / `grouped.remove` are arrays, so `> 1` requires two or more
  proposals. A single Update or Remove is treated as not needing a path, and
  `group_context_extensions` is not considered at all.
- RFC 9420 section 12.4: the `path` field MUST be populated if the Commit covers
  at least one Update, Remove, ExternalInit, or GroupContextExtensions proposal,
  or if it is empty.
- Impact: with no path, `commitSecret` is the all-zero vector
  (`create-commit.ts:148-151`, receiver `process-messages.ts:334`). The next
  epoch is derived from the previous `init_secret` -- known to every current
  member including the just-removed one -- plus a zero commit secret. A removed
  member can derive the new epoch's key schedule and keep reading group traffic.
  Member removal provides no confidentiality until a later path-bearing commit.
  Confirmed independently by two reviewers and by direct read.

Fix tasks:
- [ ] Change the condition to require a path when there is at least one Update,
      Remove, or GroupContextExtensions proposal, or the proposal list is empty:
      `allProposals.length === 0 || grouped.update.length > 0 ||
      grouped.remove.length > 0 || grouped.group_context_extensions.length > 0`
      (external-init commits already force a path elsewhere; keep that).
- [ ] Add a regression test: a commit with a single Remove and no path MUST be
      rejected on receive, and `createCommit` MUST generate a path for it.
- [ ] Add a test asserting a removed member cannot derive the new epoch secret
      (commit secret is non-zero after a single-Remove commit).

--------------------------------------------------------------------------------

## HIGH

### H1. Sender does not exclude commit-added leaves from copath resolutions

- Files: `src/update-path.ts:220` (`sendTo: resolution`),
  `:145-171` (`encryptSecretsForPath`); called from `create-commit.ts:123`.
- RFC 9420 section 7.6: the resolution of the copath node MUST exclude all new
  leaf nodes added in the current Commit; the `encrypted_path_secret` vector
  length MUST equal the resolution length excluding new leaves.
- The receiver side (`create-commit.ts:465`, `filterNewLeaves`) does exclude new
  leaves and indexes ciphertext by the filtered position. Because the sender
  does not, a commit that both adds a member and sends a path can misalign
  ciphertext indices: an existing member picks the ciphertext encrypted for the
  new leaf, HPKE open fails, and the commit is unprocessable for that member.
  Also an interop break against conformant peers.

Fix tasks:
- [ ] In `applyInitialTreeUpdate` / `encryptSecretsForPath`, exclude leaves added
      by the current commit from each copath resolution before encrypting, so the
      sender and receiver agree on the filtered resolution ordering.
- [ ] Add a test: commit containing both an Add and an UpdatePath, verified by a
      pre-existing member decrypting successfully (blank parent with children
      `[newLeaf, existingLeaf]`).

### H2. Parent-hash verification omits the resolution / unmerged-leaves criterion

- File: `src/parent-hash.ts:74-117` (`parentHashCoverage`).
- Verifies only the hash chain (each node's stored `parent_hash` equals the
  recomputed hash of its first non-blank ancestor) and single coverage.
- RFC 9420 section 7.9.2 additionally requires: D is in the resolution of C, and
  the intersection of P's `unmerged_leaves` with the subtree under C equals the
  resolution of C with D removed. Section 7.9.1 states these checks prevent a
  malicious insider from constructing a tree with a node D whose secret key the
  insider knows without being assigned a leaf under D.
- Impact: a malicious inviter can craft a tree that passes the hash chain but
  places attacker-controlled keys to receive path secrets they should not.

Fix tasks:
- [ ] Implement the section 7.9.2 resolution / unmerged-leaves check in
      `parentHashCoverage` (or a companion function called during tree
      validation on join and commit).
- [ ] Add a negative test with a crafted tree that passes the hash chain but
      violates the unmerged-leaves intersection condition.

### H3. Unvalidated `unmergedLeaves` indices -> infinite loop (remote DoS) and OOB access

- Files: `src/treemath.ts:88-98` (`directPath`), `:25-33` (`level`),
  `:76-81` (`parent`); triggered from `src/client-state.ts:321` and
  `src/ratchet-tree.ts:243`; also `src/update-path.ts:159`.
- `unmergedLeaves` is decoded as arbitrary uint32 (`parent-node.ts`) and never
  range-checked. An out-of-range entry (e.g. `0xFFFFFFFF`) makes `parent()`
  diverge upward; past 2^31 the 32-bit shifts go negative and `level(-1)` loops
  unboundedly. `resolution()` / `encryptSecretsForPath` also index `tree[huge]`.
- Impact: a Welcome/GroupInfo carrying a ratchet tree with a bogus
  `unmergedLeaves` hangs the joining client inside its own validation before any
  error is raised.

Fix tasks:
- [ ] Validate every decoded node/leaf index (including all `unmergedLeaves`
      entries) against the tree width immediately on decode; reject out-of-range.
- [ ] Add bounds guards in `treemath` helpers (defensive) and a test with an
      oversized `unmergedLeaves` entry that must reject, not hang.

### H4. No `group_id` check on inbound messages -> cross-group replay for external / new-member senders

- Files: `src/process-messages.ts:170-206`, `:75-121`;
  `src/message-protection-public.ts:138-178`.
- Neither the public nor private receive path compares `content.groupId` with
  `state.groupContext.groupId`; only an epoch check exists.
- For `member` / `new_member_commit` senders the GroupContext is in the signed
  TBS, so a wrong-group message fails signature/decryption. But for `external`
  and `new_member_proposal` senders the TBS has no GroupContext
  (`framed-content.ts:165-174`), so the only group binding is the unchecked
  `content.groupId`.
- Impact: an external sender (e.g. a moderation service) configured in groups A
  and B at the same index -- an attacker replays its signed Remove proposal from
  A into B; signature verifies, epoch matches, proposal is accepted into B.

Fix tasks:
- [ ] Reject any inbound message whose `groupId` != local group id, on both the
      public and private paths, before further processing.
- [ ] Add a cross-group replay test for an external-sender proposal.

### H5. External commits skip full proposal-list validation; resync Remove identity not bound

- Files: `src/client-state.ts:651-690` (external-init branch),
  `validateExternalInit` at `:524-535`.
- The external-commit branch calls only `validateExternalInit` (at most one
  external_init, at most one remove, no add/gce/reinit/update). It never calls
  `validateProposals` and applies `removeLeafNode` without `validateRemove`, so
  the removed leaf is not checked for validity, PSK rules are unenforced, and --
  per RFC 9420 section 12.4.3.2 -- the Remove is not bound to the joiner's own
  identity (resync). Receiver performs no identity binding.
- Impact: an external joiner (or forged `new_member_commit`) can evict an
  arbitrary victim leaf while joining.

Fix tasks:
- [ ] Run the standard proposal-list validation (or the external-commit subset
      per section 12.4.3.2) on the receive path, including `validateRemove`.
- [ ] Bind an external-commit Remove to the joiner's identity/credential
      (resync semantics); reject Removes that target unrelated leaves.

### H6. `validateSenderData` result is discarded (sender-leaf authorization guard is a no-op)

- File: `src/message-protection.ts:236` (and `:274-276`).
- `validateSenderData` returns an `MlsError` object rather than throwing, and the
  only call site ignores the return value. The intended guard (recovered sender
  leaf index must point at a non-blank leaf before its key is used) never runs.
- Impact: currently degrades to a less-specific error downstream, but the
  authorization check is inert -- a latent gap for any path that tolerates a
  missing/again-out-of-range key.

Fix tasks:
- [ ] Throw on the validation result: `throwIfDefined(validateSenderData(...))`
      (or convert `validateSenderData` to throw) at the call site.
- [ ] Add a test: PrivateMessage whose decrypted SenderData points at a blank
      leaf is rejected cleanly.

--------------------------------------------------------------------------------

## MEDIUM

### M1. `filteredDirectPath` uses a wrong leaf-width computation

- File: `src/ratchet-tree.ts:248`:
  `const leafWidth = nodeToLeafIndex(toNodeIndex(tree.length))` computes
  `tree.length / 2`, not the leaf width. The correct helper `leafWidth(...)` is
  used by the sibling function at `:260`. For `tree.length = 7` (4 leaves) this
  yields 3 instead of 4, so `directPath` / `copath` compute against the wrong
  width and produce wrong node indices / a wrong root.
- Used in `applyUpdatePath` (`update-path.ts:261`) to place update-path keys and
  length-check the UpdatePath; corrupts the applied tree or rejects valid
  commits, and the two functions disagreeing is part of why H1 is reachable.

Fix tasks:
- [ ] Replace with `leafWidth(tree.length)`; add a test at a tree size where
      `tree.length/2 != leafWidth` (e.g. 4 leaves) exercising `applyUpdatePath`.

### M2. Unmerged-leaves join validation logic is wrong in both directions

- File: `src/client-state.ts:323` and `:331`.
- Line 323 uses `&&` where the RFC requires both conditions
  ("non-blank leaf AND descendant of the parent") -- should be `||` so that a
  blank-leaf-but-descendant entry, or a non-blank-leaf-but-not-descendant entry,
  is rejected.
- Line 331 requires intermediate nodes to have identical `unmergedLeaves` arrays;
  RFC 9420 section 7.9 only requires that each intermediate node contain an entry
  for the leaf (membership, not equality), so valid trees are falsely rejected.

Fix tasks:
- [ ] Fix the boolean logic at `:323` to reject unless (non-blank leaf) AND
      (descendant).
- [ ] Change `:331` from array-equality to membership (leaf present in each
      intermediate node's `unmergedLeaves`).

### M3. Non-minimal QUIC varint encodings are accepted on decode

- File: `src/codec/variable-length.ts:29-55` (`determineLength`).
- The decoder reads the 2-bit length prefix without a minimality check, so a
  small value encoded in a wider form (e.g. 5 as `0x40 0x05`) is accepted.
- RFC 9420 section 2.1.2: non-minimal encodings MUST be treated as malformed and
  rejected. Non-canonical encodings break the canonical-serialization property
  the ref-hash and transcript-hash designs rely on (differing refs / transcript
  inputs vs conformant peers).

Fix tasks:
- [ ] Enforce minimal-length on decode; reject over-long forms.
- [ ] Add decode tests for each non-minimal form of a small value.

### M4. `decodeOptional` accepts invalid presence octets and can read past the buffer

- File: `src/codec/optional.ts:10-20`.
- Any presence octet other than 1 (i.e. 2..255) is treated as "absent"; RFC
  8446-style optionals (inherited via RFC 9420 section 2.1) permit only 0 or 1
  and other values MUST be rejected. When `offset >= b.length`, `decodeUint8`
  returns `undefined`, the check is false, and the decoder returns
  `[undefined, 1]`, "consuming" a nonexistent byte -- a truncated
  Welcome/Commit/RatchetTree can decode as valid.

Fix tasks:
- [ ] Reject presence octets other than 0 or 1.
- [ ] Bounds-check before reading the presence octet; fail on truncation.

### M5. `encodeOptional` uses truthiness instead of an `undefined` check

- File: `src/codec/optional.ts:7`.
- A present-but-falsy value (`0`, `''`, `false`) is encoded as absent. Latent
  today (call sites pass objects/Uint8Arrays) but a data-loss bug for the first
  optional numeric field.

Fix tasks:
- [ ] Change the guard to `t !== undefined`.

### M6. Noble provider MAC verification is not constant time

- File: `src/crypto/implementation/noble/make-hash-impl.ts:31-34`.
- `verifyMac` uses `mac.every((b, i) => b === expectedMac[i])`, short-circuiting
  on first mismatch. This path verifies the confirmation tag
  (`framed-content.ts:278`, `group-info.ts:86`) and membership tag
  (`authenticated-content.ts:89`) when the noble provider is selected. A correct
  `constantTimeEqual` already exists in `src/util/constant-time-compare.ts`.
  (The default WebCrypto provider uses `subtle.verify` and is fine.)

Fix tasks:
- [ ] Replace the comparison with `constantTimeEqual`.

### M7. `interim_transcript_hash_[0]` is not initialized to the empty string

- File: `src/client-state.ts:708-726` (`nextEpochContext`), with the epoch-0
  `confirmationTag` at `:898`.
- Every transition, including 0 -> 1, computes
  `interim = Hash(confirmed || encodeVarLen(confirmationTag))`. RFC 9420 section
  8.2 sets `interim_transcript_hash_[0]` to the zero-length octet string; the
  confirmation-tag term applies only for n >= 1.
- Impact: self-consistent internally, but the first commit's transcript hash --
  and thus confirmation tag -- diverges from any conformant peer; interop and
  test-vector conformance fail at the first commit.

Fix tasks:
- [ ] Initialize `interim_transcript_hash_[0]` to empty; only fold in the
      confirmation tag for epochs >= 1.
- [ ] Validate against RFC 9420 test vectors (transcript-hash).

### M8. `processMessage` drops the caller's PSK index for private messages

- File: `src/process-messages.ts:410`:
  `processPrivateMessage(state, message.privateMessage, emptyPskIndex, cs, action)`
  ignores the `pskIndex` argument (the public path at `:407` passes the real
  one).
- Impact: since commits normally arrive as PrivateMessages, any commit carrying
  a PSK proposal fails with "Could not find pskId" even when the client knows the
  PSK. Availability/correctness bug.

Fix tasks:
- [ ] Pass the real `pskIndex` through to `processPrivateMessage`.
- [ ] Add a test: commit with a PSK proposal sent as a PrivateMessage resolves.

### M9. ExternalInit from a member sender is not rejected on receive

- Files: `src/process-messages.ts:208-286`, `src/client-state.ts:581-690`.
- `applyProposals` picks the external branch from proposal contents, not sender
  type. RFC 9420 section 12.1.8 / 12.4.3.2 allow ExternalInit only in an external
  commit (`new_member_commit`). A member-sent commit containing `external_init`
  is processed via the external branch with an attacker-influenced init secret.

Fix tasks:
- [ ] Reject `external_init` unless the sender is `new_member_commit`; reject a
      `new_member_commit` commit lacking exactly one `external_init`.

### M10. Sender-type / content-type / proposal-type policy not enforced on receive

- Files: `src/process-messages.ts:170-206`,
  `src/message-protection-public.ts:138-178`.
- No check that external senders send only the permitted proposal types
  (Add/Remove/PSK/ReInit/GroupContextExtensions -- not Update, not Commit, not
  application), nor that `new_member_commit` is only for external commits.
  Malformed authority is caught only as incidental downstream crashes.

Fix tasks:
- [ ] Enforce sender-type / proposal-type restrictions up front in the framing
      layer per RFC 9420 section 12.1.7 / 12.1.8.2.

### M11. External-sender lookup keyed by extension position, not the list index

- Files: `src/public-message.ts:103-114` (`senderFromExtension`),
  `src/external-sender.ts:18-20` (`decodeExternalSender` decodes a single
  struct), `src/external-proposal.ts:56-73`.
- RFC 9420 section 12.1.8.2 models `external_senders` as one extension containing
  a variable-length vector of ExternalSender entries; `SenderIndex` indexes into
  that vector. The code appears to model each external sender as a separate
  extension and decodes only the first entry.
- Impact: interop break and potential key misattribution when more than one
  external sender is configured.

Fix tasks:
- [ ] Decode `external_senders` as a vector inside a single extension; index the
      SenderIndex into that vector. Confirm against the encoder.

### M12. GroupContextExtensions: existing members' support not checked

- File: `src/client-state.ts:229-233,245-268`.
- `validateProposals` checks only that Add KeyPackages support the current group
  extensions, not that all existing members support the new extensions a
  GroupContextExtensions proposal introduces (RFC 9420 section 12.1.6).

Fix tasks:
- [ ] Verify every existing leaf's capabilities support the proposed new group
      context extensions before accepting a GroupContextExtensions proposal.

### M13. PreSharedKey proposal type/usage not validated in commits

- Files: `src/client-state.ts:167-271`, `src/psk-index.ts:15-31`.
- No enforcement of RFC 9420 section 12.1.5: PreSharedKey proposals must be
  `external` PSKs or `resumption` PSKs with usage `application`. Only duplicate
  PSKID is checked.

Fix tasks:
- [ ] Validate PSK type/usage for PreSharedKey proposals in commit processing.

### M14. PQ ciphersuites: unregistered IDs and internal inconsistencies

- File: `src/crypto/ciphersuite.ts:25-36,152-191`.
- Suites 77-88 (0x004D-0x0058) are not IANA-registered and are not marked
  experimental; a future allocation of those code points would cause algorithm
  confusion. Also internal mismatches: suite 77
  `MLS_128_MLKEM512_AES128GCM_...` is defined with `aead: 'AES256GCM'`; several
  PQ suites declare a `hash` that differs from their `kdf` hash, and the MLS KDF
  is derived from `cs.hpke.kdf`, so ExpandWithLabel/DeriveSecret run over a hash
  inconsistent with the suite name. (Standard suites 0x0001-0x0007 are correct.)

Fix tasks:
- [ ] Move experimental PQ suites into the private-use range (0xF000-0xFFFF) or
      clearly mark them non-standard, and stop decoding them as standard suites.
- [ ] Fix the AEAD/hash/kdf mismatches so each suite is internally consistent
      with its name.

### M15. `epoch_secret` retained for the whole epoch; no zeroization anywhere

- File: `src/key-schedule.ts:62-63` (stored in `KeySchedule`); no `fill(0)`
  anywhere in `src/`.
- RFC 9420 sections 8/9 expect intermediate secrets to be discarded once their
  outputs are derived. Keeping `epoch_secret` in `ClientState` lets a state
  compromise recompute every secret of the epoch -- including secret-tree
  segments already deleted for forward secrecy.

Fix tasks:
- [ ] Drop `epochSecret` from `KeySchedule` after deriving its outputs.
- [ ] Best-effort `fill(0)` on consumed secrets (joiner/welcome/commit/path
      secrets, consumed ratchet segments).

--------------------------------------------------------------------------------

## LOW

Grouped; each is a hardening or minor-conformance item.

- [ ] **L1 ECDSA malleability** (`crypto/implementation/default/make-noble-signature-impl.ts`):
      `lowS: false` on sign and verify. Conformant, but signatures are malleable,
      so one proposal can have two valid ProposalRefs. Consider `lowS: true`.
- [ ] **L2 `Math.random` in GREASE** (`src/grease.ts:20`): the only `Math.random`
      in `src`. GREASE is not security-relevant, but use the threaded `Rng` to
      keep the "secure randomness only" invariant auditable.
- [ ] **L3 Padding zero-check not constant time** (`src/private-message.ts:225-239`):
      `every` short-circuits. Ordering is correct (AEAD before padding), so low
      risk; prefer a constant-time zero-scan for defense in depth.
- [ ] **L4 `decodeVarLenType` can loop forever on a zero-length item decoder**
      (`src/codec/variable-length.ts:108-115`): add an `if (len === 0) reject`.
- [ ] **L5 `verifyParentHashes` early-returns true with no parent nodes and the
      blank-node branch does not advance the index** (`src/parent-hash.ts:64,85-91`):
      make the loop advance via `findFirstNonBlankAncestor`.
- [ ] **L6 `applyUpdatePath` uniqueness check is incomplete** (`src/update-path.ts:247-255`):
      compares new keys only against existing parent keys, not leaves or
      within-path duplicates. Covered later on join by `validateRatchetTree` but
      not on every commit-apply path.
- [ ] **L7 `maximumTotalLifetime` never enforced** (`src/client-state.ts:470-476`,
      `src/lifetime-config.ts`): only `notBefore <= now <= notAfter` is checked;
      an arbitrarily large lifetime window passes.
- [ ] **L8 Resumption-PSK handling in `joinGroup` over/under strict**
      (`src/client-state.ts:751-772`): rejects valid `application`-usage
      resumption PSKs; validates only the first resumption PSK in the list.
- [ ] **L9 Missing PSK field validations** (`src/presharedkey.ts:115-118`,
      psk-nonce length): `index`/`count` written as uint16 without bounds check;
      no check that `pskNonce` length == KDF.Nh.
- [ ] **L10 Historical epoch data keeps unusable handshake ratchets**
      (`src/client-state.ts:1008-1034`): old-epoch handshake content is rejected
      anyway, so retained handshake ratchets are pure forward-secrecy liability;
      strip them when snapshotting.
- [ ] **L11 Internal-node ratchet roots derived and retained**
      (`src/secret-tree.ts:42-53`): ratchets are only needed for leaves; wasted
      long-lived key material (not a compromise amplifier).
- [ ] **L12 Path/node secrets never zeroized** (`src/update-path.ts`,
      `src/path-secrets.ts`, `src/private-key-path.ts`): forward-secrecy
      weakness; clear superseded secrets.
- [ ] **L13 External-sender proposal construction unrestricted by type**
      (`src/external-proposal.ts:49-82`): API can build non-conformant external
      Update/ExternalInit proposals (sender-side only).
- [ ] **L14 npm audit**: 3 high-severity advisories in devDependencies only
      (`trim` via `tap-out`/`tap-spec`, ReDoS). Not shipped; update the test
      tooling when convenient.

--------------------------------------------------------------------------------

## Verified correct (no action)

Standard ciphersuites 0x0001-0x0007 (KEM/KDF/AEAD/hash/signature); SignWithLabel
/ VerifyWithLabel / EncryptWithLabel with the `"MLS 1.0 "` prefix and never
skipping verification; RefHash labels including `"MLS 1.0 Proposal Reference"`;
ExpandWithLabel / DeriveSecret KDFLabel encoding; the full epoch-secret label
set and extract/expand ordering; PSK chaining (section 8.4); confirmation-tag and
transcript-hash structures; exporter (section 8.5); external-init using HPKE
export and forcing a path; secret-tree derivation, generation handling, 4-byte
reuse-guard XOR, bounded out-of-order tolerance with delete-on-use; membership
and confirmation tags created and MUST-verified; signature verified before
content is trusted; application data confined to PrivateMessage; GroupInfo
signature verified against the signer leaf; ratchet-tree validation (parent-hash
chain, tree hash, per-leaf signature/credential/uniqueness); UpdatePath
parent-hash binding; KeyPackage validation including `init_key != encryption_key`
and `KeyPackageTBS`; LeafNodeTBS context including `group_id`+`leaf_index`; the
tree-hash / parent-hash structure encodings and treemath formulas for in-range
indices; WebCrypto AES keys imported non-extractable.

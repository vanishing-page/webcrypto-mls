# Upstream sync 2026-10: ts-mls changes since 1.3.1

**Status:** ready-for-agent
**Source:** the upstream audit of 2026-10-26, which compared this
package against LukaJCB/ts-mls at `b2e85a4` (identical to
nichoth/ts-mls). This package was copied from ts-mls 1.3.1, upstream
commit `c276037`, on 2025-10-15, with no shared git history.
**Companion spec:**
`.scratch/upstream-sync-2026-10-tree-hash-cache/spec.md` covers a
tree-hash cache carried across epochs, and records why lazy
secret-tree derivation is not ported. Neither is in this spec.

This spec covers four areas, each tested at its own seam: the core
library (group behavior through the public `ClientState` operations),
the wire format (the public encoders and decoders on raw bytes), the
crypto provider (P-curve signing), and packaging (what the built
`dist/` exports). Every section below is split the same way.

Upstream commit ids are given in parentheses so an implementer can
read upstream's version of the change. Upstream's code is a
reference for intent only: both trees have been refactored since
1.3.1, and several upstream versions carry bugs this spec calls out.

## Problem Statement

### Core library

A member running this package cannot process some valid commits that
other MLS implementations, ts-mls 2.x among them, produce and accept.
When one commit carries a GroupContextExtensions proposal that changes
the group's required capabilities together with an Add or an Update,
the package checks the added or updated leaf node against the *old*
required capabilities. RFC 9420 applies the GroupContextExtensions
proposal first. The result: a commit that adds a member who supports
only the new requirement is rejected, and the receiver is left behind
in the old epoch with no way forward. The same happens to an Update
that drops a capability only the old requirement needed, and to a
commit whose GroupContextExtensions proposal removes the requirement
altogether. The receipt check makes it worse: it refuses such an Add
or Update outright when it first arrives, although a commit in the
same epoch could make it valid, which breaks this package's own rule
for receipt checks.

A KeyPackage built by `generateKeyPackage` uses one extension list for
both the KeyPackage and its leaf node. A KeyPackage-only extension,
such as `last_resort`, ends up in the ratchet tree for as long as the
member stays in the group, and must be listed in the leaf's
capabilities or the leaf is rejected. An application cannot express a
leaf-only extension at all.

A member cannot rotate its own leaf through an Update proposal. There
is no API that builds a signed Update and keeps its new HPKE private
key, so when another member commits that Update, the proposer cannot
decrypt the path secret encrypted to its new key. The only workaround
in this repository's tests has a different member check the commit. A
member also has no way to rotate its credential or signature key, or
to widen its capabilities, short of being removed and re-added, so a
group can never raise its required capabilities beyond what its
members joined with.

Forward secrecy for superseded state depends entirely on the
application dropping the old `ClientState` and the garbage collector
reclaiming it. The package wipes only the buffers a call allocated
itself, correctly, because the caller still holds the state it passed
in. But it gives the application no way to learn which secrets the
new state no longer needs, so the application cannot wipe them once
the new state is safely persisted.

Several small things that applications need are missing: a list of
the group's members, the member's own leaf node, the GroupInfo
extensions of the group just joined through a Welcome, the committer
of a commit inside the incoming-message callback (needed to refuse a
commit by policy before it is accepted), a Welcome ready to send as an
`MLSMessage`, and a ratchet tree in the Welcome that `branchGroup` and
`reinitCreateNewGroup` send.

Joining a large group costs quadratic time. Ratchet-tree validation
verifies every parent hash by recomputing sibling subtree hashes from
scratch for each leaf, and it scans the whole tree several times for
every leaf to check key uniqueness and the credential rule. Each
commit also hashes the full tree once more than it needs to, on the
sending and the receiving side. There is no benchmark, so none of this
can be measured.

Several regression tests upstream added have no counterpart here.

### Wire format

External joins fail in both directions between this package and any
other implementation. RFC 9420 defines the `external_pub` extension's
data as a length-prefixed HPKE public key. This package writes and
reads the bare key. An external joiner here takes the length byte of
another implementation's GroupInfo for the first byte of the key, and
another implementation reading this package's GroupInfo takes the
first key byte for a length. Two copies of this package interoperate,
so nothing in the test suite has noticed.

A peer whose leaf node advertises an MLS protocol version newer than
1.0 in its capabilities makes this package fail to decode the whole
KeyPackage, leaf node or ratchet tree. Ciphersuites and credential
types in the same structure already decode values the package does not
know; protocol versions do not.

The twelve post-quantum private-use ciphersuites have the same names
here as in ts-mls 2.x but different code points. This package numbers
them `0xF001` to `0xF00C`; ts-mls 2.x numbers them `0xf007` to
`0xf012`, in the same order. The same number therefore names a
different suite in each: upstream's `0xf007` is ML-KEM-512 with
AES-128, this package's `0xF007` is X-Wing with AES-256. A KeyPackage,
Welcome or GroupInfo crossing between the two does not fail cleanly.
It selects the wrong algorithms and fails later, confusingly. We want
post-quantum interoperability with ts-mls 2.x.

The top-level decoder accepts input of any size, so a peer can make a
member parse an arbitrarily large buffer.

### Crypto provider

ts-mls 2.x left-pads a P-256, P-384 or P-521 private key to its field
length before signing, because the noble release it moved to rejects a
key whose leading zero bytes were trimmed. This package signs those
suites through noble in the default provider and in
`nobleCryptoProvider` alike, passes the key bytes through unchanged,
and depends on a newer noble than the one that started rejecting short
keys. Keys this package generates are always full length, so the
exposure is a caller importing a raw key from somewhere that trims
leading zeros. One key in 256 has a leading zero byte. Whether noble
2.4 rejects such a key has not been confirmed.

### Packaging

The error type is part of this package's contract, but the package
root exports only `UsageError`. `ValidationError`,
`CryptoVerificationError`, `InternalError` and the rest exist and are
thrown, and a consumer importing from the package root cannot
`instanceof` against them. Two byte helpers the package uses are also
unexported. CI never runs a dependency audit, so a vulnerability in
the runtime dependencies (`@hpke/*`, `@noble/*`) is only found when
someone runs `npm audit` by hand.

## Solution

### Core library

Proposals in a commit are validated in the order RFC 9420 applies
them: the group context that Updates and Adds are checked against is
the one the commit's GroupContextExtensions proposal produces. The
receipt check stops refusing an Add or Update for its capabilities
alone, and the committer's pending-proposal filter drops one that
fails the new requirement instead.

`generateKeyPackage` takes the KeyPackage's extensions and the leaf
node's extensions as separate lists.

A new `createUpdateProposal` builds and signs an Update for the
member's own leaf, optionally with a new credential, signature key,
capabilities or extensions, and records the new private keys in the
state so the proposer can process whichever commit includes it.
`createCommit` accepts the same leaf changes for the committer's own
UpdatePath leaf.

Every public operation that returns a new state also returns
`consumed`: the secret buffers the input state holds and the new state
no longer references. The application wipes them once it has
persisted the new state. The README gains a section on deleting
secrets.

The package exports `getGroupMembers` and `getOwnLeafNode`, returns
the GroupInfo extensions to a Welcome joiner through
`joinGroupWithGroupInfo`, passes the committer to the commit callback,
returns the Welcome as an `MLSMessage` beside the bare one, and lets
`branchGroup` and `reinitCreateNewGroup` include the ratchet tree in
their Welcome.

Joining becomes linear: parent hashes are memoized within one
validation, a single tree-hash cache is shared by parent-hash and
tree-hash verification within that call, and the uniqueness and
credential scans are computed once per tree. Each commit stops
hashing the tree twice. A benchmark script measures these.

The missing upstream regression tests are ported.

### Wire format

`external_pub` carries a length-prefixed key, on write and on read. A
malformed one is refused as a `ValidationError`.

The protocol versions inside `Capabilities` decode openly, like
ciphersuites and credential types beside them. The version fields of
an `MLSMessage`, a KeyPackage and a GroupContext stay strict.

The post-quantum private-use ciphersuites are renumbered to ts-mls
2.x's code points, `0xf007` to `0xf012`, keeping their names.

The top-level message decoder refuses input over 64 MiB before
parsing it.

### Crypto provider

P-curve signing left-pads a short private key to the curve's field
length and refuses one longer than that as a `UsageError`.

### Packaging

The package root exports every `MlsError` subclass and the two byte
helpers. The built-package consumer check proves the error classes are
importable from the root under ESM and CommonJS and that an error a
public operation throws is an instance of the exported class. CI runs
`npm audit --omit=dev` on every push.

## User Stories

### Core library

1. As a member, I want a commit that changes the required capabilities
   and adds a member who supports only the new requirement to be
   accepted, so that I stay in the same epoch as members running other
   MLS implementations.
2. As a member, I want an Update in such a commit to be checked
   against the new requirement, so that a member can drop a capability
   the group no longer requires.
3. As a member, I want a commit whose GroupContextExtensions proposal
   removes the required capabilities to accept an Add of a member who
   does not support what the old requirement named, so that clearing a
   requirement and adding that member works in one commit.
4. As a member, I want an Add or Update that a later proposal could
   make valid not to be refused when it arrives, so that I can process
   the commit that does make it valid.
5. As a committer, I want a pending proposal that fails the new
   requirement to be dropped from my commit rather than to make my
   commit throw, so that one stale proposal does not block the group.
6. As an application, I want to set KeyPackage extensions and leaf
   node extensions separately, so that a KeyPackage-only extension
   such as `last_resort` stays out of the ratchet tree.
7. As a member, I want to propose an Update for my own leaf and still
   process the commit another member makes from it, so that I can
   rotate my leaf key without committing myself.
8. As a member, I want to rotate my credential, my signature key or my
   capabilities through an Update proposal or my own commit, so that I
   do not have to leave and rejoin to change them.
9. As an application, I want each operation that advances my state to
   tell me which secret buffers the new state no longer needs, so that
   I can wipe them once the new state is persisted.
10. As an application, I want wiping those buffers never to break the
    new state, so that wiping is safe to do on every advance.
11. As an application, I want a list of the group's members with their
    leaf indices, and my own leaf node, so that I do not have to walk
    the ratchet tree by hand.
12. As a member joining through a Welcome, I want the GroupInfo
    extensions of the group I joined, so that I can read application
    metadata the group publishes there.
13. As an application, I want the committer's identity inside the
    incoming-message callback for a commit, so that I can reject a
    commit by policy before it is accepted.
14. As a committer, I want the Welcome as an `MLSMessage`, so that I
    can encode and send it without building the wrapper myself.
15. As a member branching or reinitializing a group, I want the
    ratchet tree in the Welcome I send, so that joiners do not have to
    fetch it separately.
16. As a member joining a large group, I want ratchet-tree validation
    to take time linear in the group size, so that joining a group of
    thousands is practical.
17. As a member of a large group, I want each commit I send or receive
    to hash the ratchet tree once, so that commits stay fast as the
    group grows.
18. As a maintainer, I want a benchmark of commit, receive and join at
    several group sizes, so that I can see what a change costs before
    I merge it.
19. As a maintainer, I want the regression scenarios upstream wrote
    for these behaviors to run here too, so that a regression is
    caught where upstream would catch it.

### Wire format

20. As a member, I want to join a group through an external commit
    using a GroupInfo another MLS implementation published, and to
    publish a GroupInfo another implementation can join through, so
    that external joins work across implementations.
21. As a member, I want a KeyPackage or ratchet tree whose leaves
    advertise a future protocol version to decode, so that one forward-
    looking peer does not lock me out of the group.
22. As a member using a post-quantum ciphersuite, I want its code
    point to be the one ts-mls 2.x uses, so that groups, KeyPackages
    and Welcomes interoperate with ts-mls 2.x.
23. As a member, I want an oversized message refused before it is
    parsed, so that a peer cannot make me parse an arbitrarily large
    buffer.

### Crypto provider

24. As an application importing a P-curve private key from a source
    that trims leading zero bytes, I want signing to succeed, so that
    one key in 256 does not fail at random.

### Packaging

25. As a consumer, I want to import every error class from the
    package root and match a thrown error with `instanceof`, so that I
    can tell a peer's bad input from a bug in the library.
26. As a maintainer, I want CI to fail when a runtime dependency has a
    known vulnerability, so that I find out on the push, not by
    chance.

## Implementation Decisions

### Core library

- **Proposal order in `applyProposals`.** The post-GroupContextExtensions
  group context is computed once, before the tree mutations, and the
  Update and Add validation in `applyTreeMutations` runs against it.
  The receive path already builds this context for the committer's
  own leaf; the sender path and the receive path must agree on one
  derivation. Validation still runs against the running tree. An
  empty GroupContextExtensions proposal clears the extensions, as it
  does today. (Upstream `bc9ce9e`.)
- **Receipt check.** `validateProposalOnReceipt` no longer refuses an
  Add or an Update because its leaf fails the current required
  capabilities, since a GroupContextExtensions proposal in the same
  epoch could change them. Every other receipt rule stays. This
  follows the rule already written in AGENTS.md: a receipt check may
  only refuse what no commit in this epoch could make valid.
- **Commit-time filter.** `filterPendingProposals` checks each kept
  pending Add and Update against the required capabilities of the
  commit it is building (after its GroupContextExtensions proposal, if
  any) and drops a failing one, per RFC 9420 12.2. By-value
  `extraProposals` still throw. The remaining-members check against a
  new requirement is unchanged.
- **Extension separation.** `generateKeyPackage` gains a way to give
  the leaf node its own extension list, separate from the KeyPackage
  extensions. The existing `extensions` argument keeps meaning the
  KeyPackage extensions; the leaf list comes through
  `GenerateKeyPackageOptions` and defaults to empty. This is a
  behavior change for any caller that relied on its extensions
  reaching the leaf; the changelog says so. (Upstream `ae4a991`.)
- **Leaf changes (`LeafNodePatch`).** A new exported type describes
  optional changes to the member's own leaf: credential, signature key
  pair, capabilities, leaf extensions. The new leaf is validated by
  the member's own `AuthenticationService` with the old credential as
  `priorCredential`, as a peer will validate it. (Upstream `2b0309a`.)
- **`createUpdateProposal`.** A new exported operation builds and
  signs an Update proposal for the member's own leaf, with a fresh
  HPKE key pair and an optional `LeafNodePatch`, and runs it through
  `validateProposalOnReceipt` before signing, as `createProposal` does.
  It returns the new state and the message. The new HPKE private key,
  and the new signature private key if the patch rotates it, are held
  in the new state keyed by the proposal reference. When the proposer
  processes a commit that applies that proposal, the pending keys are
  installed into its private key path and identity before path
  decryption, and every other pending Update key of the epoch is
  dropped. When the epoch advances without it, the pending keys are
  dropped. Dropped keys go to the garbage collector untouched,
  following the zeroization ownership rule, and appear in `consumed`.
  A proposer that commits its own pending Update installs the keys the
  same way. Note that a pending key is a new kind of secret in
  `ClientState`: `test/validation/encryption-secret-retention.ts` and
  `test/validation/prior-state-reuse.ts` must cover it. (Upstream
  `361e756`.)
- **Committer leaf changes.** `createCommit` accepts an optional
  `LeafNodePatch` applied to the committer's UpdatePath leaf. Today
  the UpdatePath leaf always reuses the old credential, signature key
  and capabilities. A patch on a commit without an UpdatePath forces
  one.
- **`consumed`.** `CreateCommitResult`, every branch of
  `ProcessMessageResult`, and the results of `createApplicationMessage`
  and `createProposal` and `createUpdateProposal` gain
  `consumed:Uint8Array[]`. The rule: a buffer is listed if and only if
  the input state references it and the output state does not. That
  includes the previous epoch's init secret and secret tree, a
  historical epoch evicted by `KeyRetentionConfig`, a ratchet's
  superseded chain secret, and dropped pending Update keys. A buffer
  the call allocated and already wiped is not listed. A buffer shared
  between the two states, through `updateArray` or otherwise, is never
  listed. The package never wipes a listed buffer itself; the caller
  still holds the input state. Upstream's version drops the list when
  evicting historical epochs and preallocates the array with holes;
  neither is copied. (Upstream `8fc07af`, `2ff7b69`.)
- **Member helpers.** `getGroupMembers(state)` returns the leaf index
  and leaf node of every non-blank leaf. `getOwnLeafNode(state)`
  returns the member's own leaf node. Both are pure, reuse the
  tree-math helpers, and are exported from the package root.
  (Upstream `0dd1702`, `4c3b0ef`.)
- **GroupInfo extensions on join.** A new exported
  `joinGroupWithGroupInfo` takes `joinGroup`'s arguments and returns
  the state together with the verified GroupInfo. `joinGroup` is
  rewritten to call it and return only the state, so its signature
  and the demos are unchanged. (Upstream `0b59ac1`.)
- **Committer in the commit callback.** The commit variant of the
  incoming-message callback's argument gains `committer`, in the same
  `AuthenticatedSender` shape `ProcessMessageResult` already carries.
  Additive. (Upstream `5298228`.)
- **Welcome as `MLSMessage`.** `CreateCommitResult` gains
  `welcomeMessage`, the Welcome wrapped with the `mls_welcome` wire
  format, beside the existing `welcome`. Additive, so no caller
  changes. (Upstream `8375d8e`.)
- **Resumption options.** `branchGroup` and `reinitCreateNewGroup`
  accept the `ratchetTreeExtension` and `wireAsPublicMessage` options
  `createCommit` already has, with the same defaults. (Upstream
  `c759bc2`.)
- **Linear ratchet-tree validation.** Inside one `validateRatchetTree`
  call: `calculateParentHash` results are memoized per node index;
  `removeLeaves` is skipped when a node has no unmerged leaves and
  takes a set rather than scanning a list when it does; one tree-hash
  cache is shared by parent-hash verification and the tree-hash check;
  the sets of HPKE keys, signature keys and credential types in the
  tree are computed once. Every rule this package checks beyond
  upstream stays, each with its existing test: the pairwise credential
  rule in both directions, `priorCredential`, `validateHpkePublicKey`
  and small-order keys, the resolution criterion and the constant-time
  comparisons. Nothing cached leaves the call. (Upstream `664ea24`,
  `2a83288`, `0e8748f`, `16e489b`, `1d9f892`.)
- **One tree hash per commit.** `createUpdatePath` and the receive
  path's tree update return the tree hash they already compute, and
  their callers use it instead of hashing again. The external-join
  path does the same. (Upstream `1e46263`, `7b5d210`.)
- **Locally owned arrays.** `createSecretTree` and `createUpdatePath`
  take one copy of the array they build and write into it, instead of
  copying the whole array once per node. This is safe because the
  array is the call's own; the per-message `updateArray` calls that
  share nodes across state versions are not changed. (Upstream
  `df2dc49`.)
- **UpdatePath encryption.** The encoded group context is computed
  once per UpdatePath rather than once per recipient, and HPKE
  encryptions run in batches of at most 512. (Upstream `9d3f1a7`.)
- **Benchmark.** A `bench` npm script adapted from upstream's
  `bench/index.ts` measures `createCommit`, `processMessage` and
  `joinGroup` at 64, 256 and 1024 members, through the public API with
  `testClientConfig`. It prints its results and does not run in CI or
  in `npm test`. Its benchmark dependency is a dev dependency, with the
  lockfile regenerated in the same change.

### Wire format

- **`external_pub`.** `Extension.extensionData` keeps holding the
  extension's wire bytes, as it does for every other extension.
  `createGroupInfoWithExternalPub` and
  `createGroupInfoWithExternalPubAndRatchetTree` write the key with its
  variable-length prefix. `joinGroupExternal` decodes the prefixed key
  and refuses a missing, truncated or over-long prefix, or trailing
  bytes, with a `ValidationError`, since the GroupInfo is peer input.
  A GroupInfo produced by 0.0.17 can no longer be joined; GroupInfos
  are published per epoch, so no compatibility path is kept, and the
  changelog says so. (Upstream `4e625a5`.)
- **Open protocol versions in `Capabilities`.** The `versions` list
  inside `Capabilities` is decoded and encoded with the open-enum
  helpers already used for the ciphersuites and credential types in
  the same structure, so an unknown version round-trips. The strict
  `decodeProtocolVersion` stays for the version fields of
  `MLSMessage`, KeyPackage and GroupContext. The `Capabilities.versions`
  type widens accordingly; GREASE and `defaultCapabilities` keep
  working. (Upstream `a671d55`.)
- **Post-quantum code points.** The twelve post-quantum entries in the
  ciphersuite table take ts-mls 2.x's code points at `b2e85a4`:
  `MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519` is `0xf007`, and the
  rest follow in their current order up to
  `MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87` at `0xf012`. Names
  are unchanged, and the seven IANA suites are untouched. The
  `suite-filter` cost table is keyed by name and needs no change. The
  attachment subsystem's `ATTACHMENT_COMPONENT_ID` (`0xF001`) is a
  component id in a different registry and is unaffected. A
  `ClientState` stores the ciphersuite by name, so a persisted state
  survives, but a KeyPackage, Welcome or GroupInfo encoded by 0.0.17
  under a post-quantum suite decodes as unknown or as the wrong suite,
  so post-quantum groups must be recreated across this upgrade. The
  README, the glossary entry for "Private-use ciphersuite" and the
  changelog say so. AGENTS.md records that these code points follow
  ts-mls and must not be renumbered independently. (Upstream
  `7fda61e`.)
- **Size cap.** `decodeMlsMessage` refuses input longer than 64 MiB
  before parsing, by failing the same way any malformed input fails,
  so callers' existing error mapping applies. (Upstream `8e58578`.)

### Crypto provider

- **Short P-curve keys.** The noble signature implementation, used by
  the default provider and by `nobleCryptoProvider` for P-256, P-384
  and P-521, left-pads a private key shorter than the field length (32,
  48 and 66 bytes) before signing, and refuses a longer one with a
  `UsageError`. The padded copy is allocated by the call and wiped
  after signing; the caller's key is not touched. Verification is
  unchanged. (Upstream `ff55ddd`.)

### Packaging

- **Error exports.** The package root exports `MlsError`,
  `ValidationError`, `CodecError`, `DependencyError`,
  `CryptoVerificationError`, `CryptoError` and `InternalError` beside
  `UsageError`. (Upstream `70ef399`.)
- **Byte helpers.** The package root exports `base64ToBytes` and
  `base64urlToBytes` beside the existing encoders. (Upstream
  `83acbce`.)
- **New exports.** Everything the core section adds to the public
  surface (`createUpdateProposal`, `LeafNodePatch`, `getGroupMembers`,
  `getOwnLeafNode`, `joinGroupWithGroupInfo`) is exported from the
  package root.
- **CI audit.** The `build` job in the Node.js workflow runs
  `npm audit --omit=dev --audit-level=high`. `--omit=dev` keeps the
  documented tooling findings under `markdown-toc` and `wrangler` out
  of it. AGENTS.md's dependency section records the step. (Upstream
  `5f15ed0`.)

## Testing Decisions

A good test here drives the package the way an application does and
asserts on what the application can observe: whether an operation
succeeds or throws which error class, the epoch the state reaches,
whether members can still exchange messages, and the bytes on the
wire. It does not assert on internal data structures, call counts or
error message text. Every test that loops over ciphersuites uses
`testCiphersuites()`, or `sampleCiphersuites()` where a second suite
adds nothing; every test that builds a group passes `testClientConfig`.
Each new test file is imported from `test/unit.ts` or `test/matrix.ts`,
or it does not run.

### Core library

The seam is the public `ClientState` operations: `createGroup`,
`generateKeyPackage`, `createProposal`, `createUpdateProposal`,
`createCommit`, `processMessage`, `joinGroup` and
`joinGroupWithGroupInfo`, `joinGroupExternal`, `branchGroup`,
`reinitCreateNewGroup`, and the member helpers. Prior art:
`test/scenario/*`, `test/scenario/gce-committer-leaf-validation.ts`
and `test/scenario/required-capabilites.ts` for required capabilities,
`test/scenario/update.ts` for Updates, and
`test/validation/leaf-key-dishonest-committer.ts` for forged commits.

- Required capabilities: port upstream's `bc9ce9e` scenarios. The
  central case: the group requires extension A; one commit carries a
  GroupContextExtensions proposal requiring B and an Add of a member
  supporting B only; every member processes it and reaches the next
  epoch. Variants: the same with an Update; a GroupContextExtensions
  proposal that removes the requirement; proposals by reference and by
  value; the receipt check accepting the proposal; a committer whose
  pending Add fails the new requirement dropping it. A commit that
  this package's `createCommit` refuses to build is forged with the
  helpers in `test/validation/leaf-key-dishonest-committer.ts`, each
  forging helper with an honest control in the same suite.
- Extension separation: a KeyPackage carrying `last_resort` joins, and
  the joined group's leaf for that member carries only the leaf
  extensions.
- Update proposals: bob proposes an Update with `createUpdateProposal`,
  alice commits it, and bob processes alice's commit and exchanges
  messages in the new epoch. Variants: the Update rotates bob's
  signature key and credential and peers accept it; bob's own commit
  rotates his capabilities; a commit that does not include bob's
  Update leaves bob's pending keys dropped and bob still working; an
  Update from the member at leaf index 0 (upstream `9a7b8c6`).
- `consumed`: after every operation in a full lifecycle, wiping every
  listed buffer leaves the new state able to send, receive and commit;
  and none of the listed buffers is reachable from the new state. The
  reachability walk follows the pattern of
  `test/validation/encryption-secret-retention.ts`. The retained-state
  shape of `test/validation/prior-state-reuse.ts` is extended so the
  next commit needs a key the previous one superseded, after wiping.
- Member helpers, GroupInfo extensions on join, committer in the
  callback, `welcomeMessage`, resumption options: one scenario each,
  through the public operations. A callback that rejects a commit by
  committer leaves the state unchanged.
- Performance: the existing scenario suite, the RFC 9420 test vectors
  (`tree-validation.json`, `treekem.json`, `tree-operations.json`) and
  `test/scenario/large-group-full-lifecycle.ts` passing unchanged is
  the test for every optimization. Each validation rule this package
  checks beyond upstream keeps a failing-input case. No test asserts
  on timing.
- Ported upstream tests with no counterpart today:
  join-time ratchet-tree rejections (a tampered parent hash, a
  GroupInfo tree-hash mismatch, duplicate HPKE keys leaf to leaf and
  leaf to parent, duplicate signature keys, a bad leaf signature for
  each leaf node source, a rejecting `AuthenticationService` at join,
  an Add with the wrong ciphersuite or version inside a commit);
  an `external_senders` extension with two entries and a proposal
  signed by the second; a GroupContextExtensions commit with a Remove,
  processed by a remaining member, by value and by reference
  (upstream `60b737b`); a three-member GroupContextExtensions commit
  over the private wire format that sets `external_senders`, after
  which everyone can still message.

### Wire format

The seam is the public encoders and decoders on raw bytes,
`encodeMlsMessage` and `decodeMlsMessage` above all, plus
`joinGroupExternal` for `external_pub`. Prior art: `test/codec/*`,
`test/codec/roundtrip.ts`, `test/scenario/external-join.ts`,
`test/ciphersuite.ts`.

- `external_pub`: a GroupInfo's `external_pub` extension data is the
  key with its length prefix; an external join against a GroupInfo
  whose extension data is built byte for byte to RFC 9420 succeeds;
  a bare key, a truncated prefix and trailing bytes are each refused
  with a `ValidationError`.
- Open versions: a KeyPackage and a ratchet tree whose leaf lists
  versions 1 and 2 decode, re-encode to the same bytes, and join;
  an `MLSMessage` with an unknown top-level version is still refused.
- Post-quantum code points: each post-quantum ciphersuite name maps to
  the ts-mls 2.x code point, taken from upstream's table at `b2e85a4`
  and pinned in the test as the interop contract it is; a KeyPackage
  encoded under each post-quantum suite carries that code point in
  its `cipher_suite` field; a code point this package has never
  assigned (`0xF001`) decodes as unknown rather than as a suite.
- Size cap: an input one byte over 64 MiB is refused without being
  parsed; an input at the cap still goes through ordinary decoding.

### Crypto provider

The seam is the signature implementation the provider returns, as in
`test/crypto/signature.ts` and `test/crypto/signature-interop.ts`.

- A P-256, P-384 and P-521 private key with its leading zero bytes
  trimmed signs, and the signature verifies under the public key of
  the full-length key, in both providers. The ticket's first step is
  that test, run against the current code: if noble 2.4 already accepts
  short keys, the ticket reduces to keeping the test as a pin.
- A key one byte longer than the field length is refused with a
  `UsageError`.

### Packaging

The seam is `scripts/check-package-consumer.mjs` (`npm run
check:package`), which consumes the built `dist/` by package name.

- Every `MlsError` subclass is importable from the package root under
  ESM and CommonJS, and an error a public operation throws on bad
  input (a `ValidationError` from a malformed `external_pub`, for
  example) is an instance of the class imported from the root in the
  same module system.
- The CI audit step is a workflow change and is checked by reading
  the workflow; it has no test.

## Out of Scope

- A tree-hash cache that lives across epochs (upstream `1d55ca0`,
  `16e489b`), and lazy secret-tree derivation (upstream `950ed8a`).
  The companion spec
  `.scratch/upstream-sync-2026-10-tree-hash-cache/spec.md` covers the
  first and explains why the second is not ported.
- The encoder rewrite (upstream `10aa992`, `4226ee0`, `fe37bc0`):
  it changes a type nearly fifty files import, for a constant factor.
- Per-context extension types (upstream `028922d`) and upstream's 2.0
  renames (`eccc4fc`, `d7d1209`, `eb49684`). This package has already
  chosen its own names, several of them more explicit about security
  posture.
- Removing noble for Ed25519 (upstream `78e38d6`). The default
  provider here is WebCrypto.
- The sender-side commit-secret change in upstream `ff827dc`. This
  package derives the commit secret from the last filtered path secret
  on both sides, which is what RFC 9420 12.4.2 says.
- A single mutable ratchet tree threaded through the tree mutations
  (upstream `cab95b2`) and finding the own leaf by signature key
  (upstream `295ad48`): small gains for real risk to the running-tree
  validation.
- A binary codec for group state and private key packages (upstream
  `8f2376d`, `23b9942`). Persistence here is structured clone, which
  can hold a non-extractable `CryptoKey` and a byte codec cannot.
- Batched authentication (upstream `7615c56`), building the PSK index
  from state inside the package (upstream `d18781f`), the gRPC MLS
  interop harness (upstream `d0c95b8`), and blanking the whole direct
  path before writing a filtered UpdatePath (part of upstream
  `94060ac`). See Further Notes.

## Further Notes

- The audit found this package ahead of upstream in several places,
  which an implementer should not regress while porting: the
  fail-closed default `AuthenticationService`, `priorCredential` on an
  external resync, the unmerged-leaves check (upstream still accepts
  an entry that points at a blank leaf), UpdatePath key uniqueness
  against the whole tree, small-order key rejection, and the
  completeness check on the browser test run.
- The gRPC interop harness upstream runs against OpenMLS is the only
  way to test RFC 9420 interop beyond the test vectors, and both wire
  bugs in this spec would have shown up in it. It is a candidate for
  its own spec once this one lands, now that the post-quantum code
  points match.
- Blanking the whole direct path before writing a filtered UpdatePath
  is what RFC 9420 7.5 says. No honest history the audit could build
  leaves a node to blank, so it is deferred rather than dropped.
- The audit could not run noble against a short key; that is why the
  crypto-provider ticket starts with a test.
- Two changes break callers at 0.x: `external_pub` bytes and the
  post-quantum code points. A third changes behavior: KeyPackage
  extensions no longer reach the leaf. All three go in the changelog
  entry for the release that ships them.

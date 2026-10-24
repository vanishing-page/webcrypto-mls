# Audit 2026-10-24: library fixes

**Status:** ready-for-agent
**Source:** `AUDIT-2026-10-24.md` (F1, F2, F3, and the dependency
observation under "Dependency observations")

This spec covers four areas. The first three are core-library findings
and share one seam, the public group operations. The fourth is
dependency hygiene and has its own seam, the lockfile and the audit
report. The `how-to-use` presentation failure the audit lists under
"Validation results" does not reproduce at the current commit and is
not covered.

Vocabulary follows `docs/GLOSSARY.md`: Welcome, resumption PSK,
pre-shared key (PSK), branching, init key, leaf node, proposal,
proposal reference, key package. The set of stored proposal references
awaiting a commit is called the pending set, as the README's "Pending
proposals" section does.

## Problem Statement

### Resumption joins (F1)

An application that follows a ReInit or a branch calls
`joinGroupFromReinit` or `joinGroupFromBranch` and hands over the prior
state. It expects those APIs to enforce the resumption relationship:
that the Welcome it was given really is the successor of the group it
is leaving. They do not. Both wrappers delegate to `joinGroup`, whose
continuity checks run only over the resumption PSKs the Welcome
actually carries. A Welcome with none passes every check, so an
ordinary, correctly signed invitation to an unrelated group is accepted
as the branch or the ReInit successor. The returned state is active in
the wrong group, and the init private key is consumed.

Anyone who can get a Welcome for the member's published key package in
front of them, and whose signature the application's
`AuthenticationService` accepts, can substitute a different group at
the moment the application asked to resume.

### A stored PSK proposal that no commit can carry (F2)

A member receives a PSK proposal from a peer, or from an authorized
external sender, whose nonce has the wrong length for the ciphersuite's
KDF. The receipt check does not look at PSK proposals at all, so the
proposal is stored in the pending set. The commit-time filter reuses the
same check and keeps it. Accumulating the PSK secret then rejects the
nonce, so every `createCommit` from that state throws, and every
`createApplicationMessage` throws because the pending set is not
empty. One signed proposal stops the recipient's commits and sends until
the application discovers the cause and discards the proposal by hand,
or a commit from someone else happens to exclude it.

This is the same class of defect the September audit found for Add and
Update proposals. The fix then covered those types and the pending
count; PSK was left out.

### A leaf encryption key that cannot be used (F3)

Leaf validation checks the signature, the credential, the capabilities
and key uniqueness, but never asks whether the leaf's HPKE public key is
a valid key for the ciphersuite. Key package validation imports the init
key only. A signed key package can carry a working init key beside a
leaf encryption key that is one byte long, or that is a low-order
X25519 point. The committer accepts the Add, every receiving member
accepts the commit, and the joiner accepts the Welcome tree. The failure
surfaces later, when some member's path commit has to encrypt to that
leaf: a `CryptoError` from the HPKE provider, on a commit unrelated to
the Add, with nothing to tie it back to the key package that caused it.
Until the bad leaf is removed, members whose copath resolves through it
cannot commit with a path.

Probed during spec writing: the HPKE provider rejects a one-byte X25519
key and an off-curve P-256 point at import, but imports the low-order
X25519 keys `u = 0` and `u = 1` and then fails at seal time with an
`EncapError`. So import alone is not the whole check.

### Dependency baseline

Plain `npm audit` now reports six entries: `gray-matter` and `toml`
(the documented `markdown-toc` chain), `vite` (fixable in range), and
`undici`, `miniflare` and `wrangler` (GHSA-xjj6-f33q-929c in `undici`
below 7.30.1). The root `AGENTS.md` still documents the older
six-entry list (`toml`, `gray-matter`, `js-yaml`, `argparse`,
`sprintf-js`, `remarkable`), so the written baseline and the report
disagree. `npm audit fix` offers a `wrangler` downgrade to 4.35.0,
which is wrong. The latest `miniflare` still pins `undici` below the
fixed release, so no `wrangler` upgrade resolves it today, but the
lockfile's `undici` is a caret range that already admits 7.30.1.

## Solution

### Resumption joins

`joinGroup` learns what kind of join the caller expects. The two
wrappers always say so: `joinGroupFromBranch` expects a branch,
`joinGroupFromReinit` expects a ReInit. When an expectation is given,
the Welcome must carry exactly one resumption PSK whose usage matches
it, and the existing continuity checks for that usage then run as they
do today. A Welcome with no resumption PSK, with one of a different
usage, or with more than one is refused as a `ValidationError` before
the init private key is wiped, so the application can retry with the
right Welcome. An ordinary `joinGroup` call with no expectation keeps
today's behavior for ordinary invitations.

### Stored PSK proposals

A PSK proposal is checked on arrival for the things that depend only on
the proposal and the current epoch: the nonce length must equal the
KDF's output size, and a resumption PSK with branch or ReInit usage is
only acceptable while the group is at epoch 0, which is the rule the
commit path already applies. A proposal that fails is refused as a
`ValidationError` and never enters the pending set, so the member's
commits and sends keep working. Whether the referenced PSK is actually
available stays a commit-time decision, because that is the layer with
the PSK lookup and a receiver may not hold the secret yet. Because the
commit-time filter and `createProposal` both reuse the receipt check, a
stored invalid PSK from before the fix is dropped at commit time, and a
client refuses to author one.

### Leaf encryption keys

Common leaf validation checks the leaf's HPKE public key before the
leaf enters any tree: it must import under the ciphersuite's HPKE, and,
for the X25519 and X448 KEMs, it must not be a low-order point. The
init key gets the same low-order check beside its existing import
check. A failure is a `ValidationError`, on every path a leaf arrives
by: an Add validated by its committer, an Add proposal on receipt, an
Update on receipt and at commit, the leaf on a commit's UpdatePath, an
external commit's leaf, and every leaf of a tree received in a Welcome
or in the GroupInfo an external join commits against. The low-order
check follows the shape of the existing small-order EdDSA check, and
answers false for the NIST curves and the post-quantum KEMs, where
import is the whole check.

### Dependency baseline

The fixable advisories are cleared with in-range `npm update` of the
packages the report marks fixable, never with the suggested `wrangler`
downgrade and never with `--force`. The lockfile is diffed to confirm
nothing was downgraded and no `@hpke/*` or `@noble/*` version moved,
and `npm ci` is confirmed to install it. The `AGENTS.md` Dependencies
section is rewritten to name what plain `npm audit` still reports
afterwards and why each entry stays.

## User Stories

1. As an application branching a group, I want `joinGroupFromBranch` to
   refuse a Welcome that carries no branch-usage resumption PSK, so that
   an unrelated invitation cannot be substituted for the branch.
2. As an application following a ReInit, I want `joinGroupFromReinit` to
   refuse a Welcome that carries no ReInit-usage resumption PSK, so that
   the agreed group id, version, ciphersuite and extensions are always
   checked against the new group.
3. As an application whose resumption join was refused, I want my init
   private key left intact, so that I can retry with the right Welcome.
4. As an application accepting an ordinary invitation with `joinGroup`,
   I want its behavior unchanged, so that existing callers keep working.
5. As a group member, I want a peer's PSK proposal that no commit in
   this epoch could carry to be refused on arrival, so that one signed
   proposal cannot stop my commits and application sends.
6. As a group member, I want that refusal to leave my state and pending
   set exactly as they were, so that a refused proposal has no lasting
   effect.
7. As a group member holding a pending PSK proposal stored before this
   fix, I want the next commit to drop it rather than throw, so that the
   group recovers without a manual discard.
8. As a committer validating an Add, I want a key package whose leaf
   encryption key does not import, or is a low-order point, refused as
   invalid input, so that I never produce a commit admitting it.
9. As a receiving member or a joiner, I want the same refusal when the
   bad leaf arrives in a commit, an Update, or a Welcome tree, so that a
   dishonest committer cannot push it into my tree.
10. As a maintainer, I want the `npm audit` baseline documented in
    `AGENTS.md` to match what the report says, and fixable advisories
    cleared without downgrading anything, so that the next audit can
    tell a known entry from a new one.

## Implementation Decisions

### Resumption joins

- `joinGroup` gains an optional expected-resumption argument whose
  value is `'branch'` or `'reinit'`. It is added so that every existing
  call keeps compiling and behaving as it does today: callers that do
  not pass it get the current behavior. `'application'` is not a valid
  expectation; the type is narrower than the resumption usage name.
- `joinGroupFromBranch` always passes `'branch'`; `joinGroupFromReinit`
  always passes `'reinit'`. Both keep their current signatures.
- With an expectation set, a prior state is required; its absence is a
  caller mistake and a `UsageError`. The resumption PSKs that require a
  prior state (type resumption, usage other than application) must
  number exactly one, and its usage must equal the expectation.
  Anything else is a `ValidationError`: none present, two or more, or a
  single one of the other usage. External PSKs and application-usage
  resumption PSKs may still accompany it and are resolved through the
  PSK index as today.
- The per-PSK continuity checks that exist today (epoch and group id
  against the prior state, new group at epoch 1, the ReInit parameter
  comparison, the branch version and suite comparison, the branch
  membership comparison) are unchanged and still run for the PSK that
  satisfied the expectation. The existing "a branch carries exactly one
  resumption PSK" rule is subsumed by the count check, which now fires
  on zero as well.
- Every new check runs before the init private key is wiped, in keeping
  with the documented contract that a thrown validation error leaves
  the key intact.
- The README's description of the reinit and branch flows states, in
  one sentence, that the two join wrappers refuse a Welcome without the
  matching resumption PSK.

### Stored PSK proposals

- `validateProposalOnReceipt` gains an arm for PSK proposals. It
  refuses a nonce whose length differs from the KDF output size, and a
  resumption PSK of branch or ReInit usage when the group's epoch is not
  0. The epoch rule reuses the commit-time PSK usage check rather than
  restating it, so the two cannot drift.
- The receipt arm does not consult the PSK index. Availability is
  decided at commit time, where the lookup lives.
- Proposal types without a receipt check keep passing through, as they
  do now. Custom proposal types in particular must not be refused here.
- No change to the commit-time filter or to `createProposal` is needed
  beyond what they inherit by calling the receipt check. The filter
  therefore drops a stored invalid PSK, and the committed state starts
  its epoch with an empty pending set, which is the existing filter
  contract.
- The refusal is a `ValidationError`. It is thrown by the receive path
  before anything is stored, so the input state is untouched, which is
  the same shape the Add and Update refusals already have.

### Leaf encryption keys

- Common leaf validation checks the leaf's `hpkePublicKey`. First the
  low-order check, then the import. An import failure from the provider
  is caught and reported as a `ValidationError`; the provider's own
  `CryptoError` must not escape, because the input is peer-controlled
  and the error contract reserves other classes for the library's own
  faults.
- The common validator needs the ciphersuite's HPKE handle, so
  `validateLeafNodeUpdateOrCommit` and the key package leaf validator
  take it, and every caller passes it. The callers are: Add receipt,
  Update receipt, the Update loop in tree mutation, the commit path
  leaf, the external commit leaf, and tree validation at join and
  external join. The by-value Add a committer validates reaches it
  through the same key package validator.
- The key package validator keeps its init key import and adds the
  low-order check for the init key, since a low-order init key fails
  the Welcome encryption in the same way.
- The small-order module gains X25519 and X448 public key checks and a
  dispatcher keyed on the KEM algorithm. X25519: the u coordinate is
  read little-endian with the top bit of the last byte masked, as RFC
  7748 requires, reduced mod p, and compared against 0, 1, p - 1 and
  the two order-8 u values. X448: reduced mod p and compared against 0,
  1 and p - 1. The dispatcher answers false for the P-256, P-384 and
  P-521 KEMs, for ML-KEM and for X-Wing, where the provider's import is
  the whole check. Reducing mod p is what catches the non-canonical
  encodings of the same points, as the EdDSA check already does.
- The checks are keyed on the group context's ciphersuite, the same way
  the signature small-order check is.

### Dependency baseline

- Clear the fixable advisories with `npm update <name>` for each
  package the report marks fixable in range. Do not run
  `npm audit fix`, do not pass `--force`, and do not downgrade
  `wrangler`. Hand-editing the lockfile is not allowed; `npm` writes
  it.
- After the update, diff the lockfile: no version may have moved
  backwards, and no `@hpke/*` or `@noble/*` version may have changed.
  `npm ci` must install the result, and `npm audit --omit=dev` must
  still report zero.
- Rewrite the `AGENTS.md` Dependencies section to list what plain
  `npm audit` reports after the update, with the reason each entry
  stays. The `markdown-toc` chain keeps its explanation. If `undici`
  still appears because `miniflare` pins below the fixed release, say
  so and name the fixed version, so the next reader knows what to
  check for.

## Testing Decisions

Good tests here drive a public operation and assert on what comes out:
the error class, the group id of the returned state, whether a buffer
is still non-zero, the size of the pending set, whether a later commit
succeeds. They never assert on error message text. Each core-library
area is reached through the same seam, the public group operations,
and the dependency area through the lockfile and the audit report.

### Resumption joins: `joinGroupFromBranch`, `joinGroupFromReinit`, `joinGroup`

- Reproduce the audit: Alice and Bob form a group, Alice forms an
  unrelated group and issues an ordinary Welcome to a fresh Bob key
  package. `joinGroupFromBranch` against Bob's state and that Welcome
  must reject with `ValidationError`. After a ReInit of the original
  group, `joinGroupFromReinit` against Bob's suspended state and the
  same Welcome must reject with `ValidationError`.
- Further cases: a Welcome whose only resumption PSK has the other
  usage (a ReInit PSK offered to the branch wrapper and the reverse);
  a Welcome carrying only an application-usage resumption PSK; two
  resumption PSKs requiring prior state. Each rejects with
  `ValidationError`.
- After each refusal, the init private key passed in is still
  non-zero, and the honest resumption with the right Welcome then
  succeeds with the same key material. Pass copies with `slice()`
  where a key is reused, since a successful join zeroizes in place.
- The honest branch and the honest ReInit still succeed, and an
  ordinary `joinGroup` of the unrelated Welcome with no expectation
  still succeeds, which pins the "ordinary invitations unchanged"
  story.
- The branch cases extend the existing branch Welcome suite, which
  already forges Welcomes against `joinGroupFromBranch` and runs once
  under the default suite. The ReInit cases extend the existing
  resumption validation suite, which loops over the test ciphersuites.
- Prior art: `test/validation/branch-welcome.ts` (forged branch
  Welcomes, the `rejects` helper, `sameSignerKeyPackage`),
  `test/validation/resumption-validation.ts` (ReInit parameter
  mismatches), `test/scenario/reinit.ts` (the ReInit setup),
  `test/validation/welcome-path-secret-required.ts` (the
  decrypt-edit-re-encrypt Welcome shape, if a PSK list needs editing).

### Stored PSK proposals: `processMessage`, then commit and send

- Reproduce the audit from the receiver's side. The sender cannot be
  `createProposal`, which will refuse the proposal once fixed, so the
  peer's proposal is signed with `protectProposalPublic`, as the
  proposal validation suite does. Alice processes a PSK proposal with
  an empty nonce under the default incoming-message policy: it rejects
  with `ValidationError`, the pending set of the state she passed in is
  still empty, and from that same state `createCommit` and
  `createApplicationMessage` both succeed.
- Repeat with a wrong non-empty nonce length, and with a branch-usage
  and a ReInit-usage resumption PSK at an epoch other than 0. Each is
  refused the same way. A well-formed external PSK proposal is still
  stored, and the existing external PSK commit scenario still passes,
  which pins that availability is not checked on receipt.
- `createProposal` with an empty-nonce PSK throws and leaves the
  pending set unchanged.
- The pre-fix recovery story is tested by inserting the invalid
  proposal into the pending set directly with `addUnappliedProposal`
  (supplying `senderType`), then committing: the commit succeeds and
  the new state's pending set is empty.
- The suite loops over `sampleCiphersuites()`: the nonce length depends
  on the KDF, so one suite per KDF size is enough, and the sample is
  already chosen with that in mind.
- Prior art: `test/validation/proposal-validation.ts` (signing a
  proposal a peer would refuse, and asserting the pending set),
  `test/validation/psk-field-validation.ts` (nonce length at
  accumulation), `test/scenario/psk-proposal-usage-policy.ts` (the
  epoch rule at commit time), `test/validation/pending-proposals.ts`
  (reading the pending set through its public helpers).

### Leaf encryption keys: `createCommit`, `processMessage`, `joinGroup`

- Reproduce the audit: Mallory's key package is re-signed with a
  one-byte leaf encryption key, as the audit's proof does with
  `signLeafNodeKeyPackage` and `signKeyPackage`. Alice's `createCommit`
  carrying that Add by value rejects with `ValidationError`. Separately,
  the Add signed as a proposal from a peer is refused on receipt with
  `ValidationError`, and the pending set is unchanged.
- The dishonest-committer path cannot use `createCommit` once it is
  fixed. Build the commit and Welcome at the current, unfixed revision's
  shape by constructing the tree and signing the commit directly, or by
  editing the Welcome's GroupInfo tree and re-encrypting, following the
  decrypt-edit-re-encrypt shape. Bob's `processMessage` of a commit
  whose Add carries the bad leaf rejects with `ValidationError`, and
  `joinGroup` of a Welcome whose tree carries it rejects with
  `ValidationError`.
- The same shape with a low-order X25519 key (`u = 0`, and the
  non-canonical encoding of the same point with the top bit set) under
  an X25519 suite, and `u = 0` under an X448 suite. An Update whose new
  leaf key is low-order is refused on receipt. A key package whose init
  key is low-order is refused.
- A positive control: after each refusal, the honest Add of a normal
  key package from the same state succeeds and the next path commit
  from every member succeeds, which is the behavior the audit saw
  broken.
- The low-order helper gets a direct unit test beside the signature
  small-order test: the listed points and their non-canonical
  encodings answer true, a generated X25519 or X448 key answers false,
  the wrong length answers false, and the dispatcher answers false for
  every NIST and post-quantum KEM.
- The scenario cases loop over `testCiphersuites()`, since the check
  is per-KEM and the matrix is what proves every KEM takes the
  `ValidationError` path rather than a provider error. Under a suite
  whose KEM is not installed, skip through `skipReason`.
- Prior art: `test/validation/small-order-signature-key.ts` (a forged
  leaf refused as a key, before its signature),
  `test/validation/add-key-uniqueness.ts` (re-signed key packages),
  `test/validation/ratchet-tree-validation.ts` (a bad tree in a
  Welcome), `test/validation/peer-input-errors.ts` (a provider
  exception mapped at the boundary), `test/crypto/hpke.ts`.

### Dependency baseline: the lockfile and the audit report

- The seam is the committed lockfile and the commands run against it:
  `npm ci`, `npm audit --omit=dev` (zero), plain `npm audit` (every
  entry named in `AGENTS.md`), and the lockfile diff (no downgrade, no
  runtime package moved). The existing structural gates, both
  typechecks, the build, `check:package` and `npm test` must still
  pass on the updated tree.
- Prior art: ticket 12 of `.scratch/audit-2026-10/`, which did the
  same for the previous audit.

## Out of Scope

- Resumption: a strict mode for `joinGroup` when no expectation is
  passed; the shape of the Welcome's PSK list beyond the count and
  usage of resumption PSKs requiring prior state; any change to
  `reinitGroup`, `reinitCreateNewGroup` or `branchGroup`, which already
  attach the right PSK.
- Proposals: receipt-time checks for ReInit and
  `group_context_extensions` proposals. The same wedge shape may exist
  there and is worth its own ticket; it was not reproduced and is not
  in this spec. Also out: checking PSK availability on receipt, and
  changing the pending-set bound.
- Leaf keys: validating parent node keys on an UpdatePath or in a
  Welcome tree (the same wedge, from a committer rather than an
  applicant; a follow-up); low-order checks inside X-Wing's X25519
  component; any check on a leaf's signature key beyond the existing
  small-order rule.
- Dependencies: `npm audit fix`, `--force`, downgrading `wrangler`,
  replacing `markdown-toc`, and upgrading `vite` across a major.
- The `how-to-use` presentation test: it passes at the current commit.

## Further Notes

- The four areas are independent and can run in parallel. F2 and F3
  both touch `validateProposalOnReceipt`'s file, so expect a small
  merge if they run at once.
- `docs/audit-repros/2026-10-24.mjs` asserts the vulnerable behavior at
  the audited revision and is not run by anything. It stays as
  evidence of what was found; the regression tests in this spec
  replace it as the thing that runs. Once the three fixes land, the
  script's assertions fail, which is the outcome its header predicts.
- `check-audit-closed.mjs` covers `AUDIT-ra.md` only, so this audit
  has no resolution table to maintain.
- RFC 9420 section 11.2 is the ReInit contract and 11.3 the branch
  contract; 7.3 lists leaf node validity, and 5.1.1 the key validity
  rule. RFC 7748 section 5 is the X25519 top-bit masking rule.
- The error contract is part of every story here: anything a peer can
  trigger is a `ValidationError`, a caller mistake is a `UsageError`,
  and a provider's own exception never escapes. `AGENTS.md` describes
  the two recurring leak shapes and where a new case belongs.
- The signature small-order check runs before the signature so that a
  forged signature cannot verify. The encryption key check has no such
  ordering need; its only constraint is that it runs before the leaf
  enters any tree, on every path.

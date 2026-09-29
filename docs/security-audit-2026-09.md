# Security Audit -- webcrypto-mls, branch `wip` (2026-09-27)

Commit audited: ff9b026 (`wip`), compared against `origin/main` at 87af3eb.
Baseline at audit time, run in a clean worktree after `npm ci`:
`npm run typecheck` exit 0, `npm run lint` exit 0, `npm run test:fast`
40652/40652 pass. Every finding below is therefore something the suite
does not cover.

Method: five independent adversarial reviewers, each on a distinct slice
of the code (commit processing and zeroization; message protection and
ratchets; tree, membership and proposal validation; the attachment
subsystem; the crypto layer and the deployed demo). Every finding is
backed by a repro that was run against the worktree, and the highest
severity repros were re-run a second time by the coordinating reviewer.
"Unverified" marks the few claims that rest on reading alone.

Two leads arrived from an earlier session and both are confirmed here:
a commit with an invalid confirmation tag zeroes live HPKE keys (H1),
and retained ratchet material defeats message-key deletion within an
epoch (H2).

Repro scripts are referenced by name. They lived in the session
scratchpad (`agentA/` to `agentE/`) and are not part of the repository;
each finding gives enough detail to rebuild the scenario as a test.

## How to read this

Severity follows impact and who can trigger it. "Outsider" means a
party with no group keys who can get a message delivered, which
includes the delivery service. "Member" means a current group member
acting maliciously. "Local" means only the application using the
library can trigger it. Findings marked "demo" concern
`example-realistic-demo`, which is deployed, and not the published
package.

## High

### H1. Commit processing zeroes the caller's HPKE keys before the tag check

Location:
- `src/private-key-path.ts:27` in `mergePrivateKeyPaths`:
  `if (oldValue !== undefined && oldValue !== newValue) oldValue.fill(0)`
- `src/private-key-path.ts:86-87` in `pruneBlankedNodes`:
  `if (tree[nodeIndex] === undefined) { value.fill(0)`
- Receive path `src/process-messages.ts:462-471`, reached from
  `applyTreeUpdate` at :320. The only validation that runs after it is
  `verifyConfirmationTag` at :353-360.
- Send path `src/create-commit.ts:152-160`; `createWelcome` at :220 can
  still throw afterwards (`cs.hpke.importPublicKey(keyPackage.initKey)`
  at :336).

Both functions `fill(0)` buffers that belong to the input
`ClientState.privatePath`, which violates the ownership rule in
AGENTS.md. On a rejected commit the caller keeps its old state object,
but that state's non-leaf keys are now zero. The next honest commit
from a different committer fails with an HPKE OpenError and the member
is effectively removed from every future epoch.

Who can trigger it (all reproduced, `agentA/lead1.cjs`, `lead1b.cjs`,
`lead1c.cjs`, `lead1d.cjs`):
1. Any member: send its own path commit with a flipped confirmation
   tag, re-MACed (public) or re-encrypted (private). The signature
   covers `FramedContentTBS`, which excludes the tag.
2. An outsider holding a GroupInfo with `external_pub` and a credential
   the `authService` accepts: an external commit with a bad tag. There
   is no membership tag on `new_member_commit`.
3. No attacker: `createCommit` wipes the committer's own input state, so
   the RFC-mandated "your commit lost, process the winner from your
   prior state" path fails.
4. Success also wipes the input state, so a retry or fork resolution
   from the retained state fails.
5. An outsider plus any path commit (see H3): a `new_member_proposal`
   with a malformed `initKey` makes every committer's `createCommit`
   throw in `createWelcome` after its keys are already zero.

Repro output (X25519 suite; P-256 gives the same with
`DeserializeError: Invalid keyData`):

```
S1 A keys before bad commit: 0:ok 1:ok 3:ok
S1 A processes B commit with bad confirmation tag -> THREW
    CryptoVerificationError: Could not verify confirmation tag
S1 A keys after rejected commit: 0:ok 1:ZERO 3:ZERO
S1 A (retained old state) processes honest C commit -> THREW
    CryptoError: OpenError
S3 A keys after createCommit (discarded): 0:ok 1:ZERO 3:ZERO
S4 A input-state keys after success: 0:ok 1:ZERO 3:ZERO
```

The path-less branch (`pruneBlankedNodes(state.privatePath, tree)` at
process-messages.ts:399) is benign: Add, PSK and ReInit commits blank
nothing. `joinGroup`, `joinGroupExternal`, `reinitCreateNewGroup` and
`branchGroup` were checked and do not have this problem.

This contradicts `docs/security-audit.md` "Confirmed correct":
"Signature/MAC verification is performed before state mutation". The
confirmation tag is the exception.

Fix:
- Remove `fill(0)` from `mergePrivateKeyPaths` and `pruneBlankedNodes`;
  neither owns its inputs. This is the same policy C1 applied to the
  secret tree.
- On receive, finish the whole derivation (`toPrivateKeyPath`, commit
  secret, `initializeEpoch`, tag check) before building the merged path.
- Optionally add an explicit `zeroizeSupersededKeys(old, new)` for
  callers that have provably discarded the old state.
- Regression test beside `test/validation/prior-state-reuse.ts`
  covering commit, receive, reject and retry.

### H2. Retained ratchet and encryption secrets defeat in-epoch deletion

Location:
- `src/secret-tree.ts:132-167`, `updateUnusedGenerations`:
  `const withNew = { ...s.unusedGenerations, [s.generation]: s.secret }`
  and its use at :234-254.
- `src/key-schedule.ts:62` and :80: `encryptionSecret` stays on
  `KeySchedule`; assigned into state at process-messages.ts:379,
  create-commit.ts:253 and :669, client-state.ts:1124 and :1176. It is
  read only by `createSecretTree`.

`ratchetUntil` stores the application ratchet secret AR_g for each
skipped generation, not K_g/N_g. AR_g derives AR_{g+1} and every later
key. RFC 9420 section 9.2: "As soon as a group member consumes a value,
they MUST immediately delete ... that value"; for out-of-order delivery
only the key and nonce may be kept. With the default
`retainKeysForGenerations: 10`, one lost or reordered message defeats
deletion for the rest of the epoch, and `addHistoricalReceiverData`
keeps the tree for `retainKeysForEpochs` (4) more epochs.

Attacker model: state compromise (device seizure, persisted
`ClientState`, memory dump) plus recorded ciphertexts.

Repro (`agentB/t5.cjs`; gen 0 lost, 1 to 3 received in order, two
commits later):

```
T13 epoch 2 alice app chain: generation 4 retained unusedGenerations ['0']
T13 recovered already-consumed gen 1 plaintext from retained secret_0
T13 recovered already-consumed gen 2 plaintext from retained secret_0
T13 recovered already-consumed gen 3 plaintext from retained secret_0
T13 (control) library refuses consumed gen 2: Desired gen in the past
```

Repro (`agentA/lead2.cjs`): from `state.keySchedule.encryptionSecret`,
consumed generations 0 to 7 of the live epoch are all recomputed.

Fix:
- In `ratchetUntil`, derive `{key, nonce}` for each skipped generation
  and store that pair (nonce before the reuse guard is applied). Never
  store the chain secret. Each intermediate chain secret except the
  input is allocated inside `ratchetUntil`, so it can be wiped.
- Stop storing `encryptionSecret` on `KeySchedule`, or zero it right
  after `createSecretTree`. Every call site allocated it in the same
  call. The key-schedule vector test reads it; compare there first.

This is the remainder of the earlier audit's H1, whose resolution only
fixed the `max <= 0` case.

### H3. Unvalidated proposals are stored and all of them get committed

Location:
- `src/client-state.ts:1266-1282`, `processProposal`: stores any
  proposal with a valid signature; no semantic checks.
- `src/create-commit.ts:114` and :266-275, `bundleAllProposals`: every
  entry of `unappliedProposals` goes into the commit; no RFC 9420
  section 12.2 filtering. `applyProposals` then throws on the first
  invalid one.
- `src/client-state.ts:133`: application messages refused while any
  proposal is pending.
- No API discards a proposal (`grep unappliedProposals src` finds only
  writes and clears).
- `src/public-message.ts:109-113`: a `new_member_proposal` is
  authenticated only by the KeyPackage's own signature, and its TBS
  (`framed-content.ts:165-173`) carries no GroupContext. Anyone who
  knows group_id and epoch, both cleartext on every PrivateMessage, can
  send one.
- `validateKeyPackage` (client-state.ts:613-642) never checks that
  `initKey` imports.

Attacker: outsider (if the DS relays), any member, any external sender.
Ordinary honest concurrency triggers it too.

Impact:
- Nobody can commit or send application messages until the application
  hand-edits `state.unappliedProposals`.
- With the default `acceptAll` callback an outsider's self-signed Add is
  committed silently by the next routine commit and the outsider
  receives a Welcome. The callback cannot distinguish
  `new_member_proposal` from `external`; it only gets `senderLeafIndex`
  (process-messages.ts:233-236).
- Combined with H1(5), a commit that needs a path also wipes the
  committer's keys.
- `unappliedProposals` is unbounded: 1000 outsider proposals accepted in
  under 9 s, and `addUnappliedProposal` spreads the record on each
  insert.

Repro output (`agentC/r1.mjs`, `r1b.mjs`, `r1c.mjs`, `r1d.mjs`,
`agentA/lead1b.cjs`, `misc.cjs`):

```
[remove blank leaf 9] m0 createCommit: ValidationError: Tried to
    remove empty leaf node
[remove blank leaf 9] m0 createApplicationMessage: UsageError: Cannot
    send application message with unapplied proposals
m0 createCommit after two honest concurrent Remove(3): ValidationError:
    Commit cannot contain multiple update and/or remove proposals ...
outsider joinGroup from resulting Welcome: ACCEPTED
outsider now at leaf 2 epoch 3n same epoch secret as m0: true
```

Fix:
- Validate each proposal on receipt (target leaf non-blank, KeyPackage
  valid including `initKey` import, ExternalInit never from a member,
  Update leaf valid) and reject with `ValidationError`.
- In `createCommit`, filter per section 12.2: drop invalid proposals,
  one Remove per leaf, drop an Update whose leaf is removed, drop the
  committer's own Update, dedupe.
- Add an API to list and discard pending proposals; cap the record.
- Pass the sender type to `onMessage` and require explicit acceptance
  of `new_member_proposal`.

### H4 (demo). `hello` accepts any identity and serves the log to anyone

Location: `example-realistic-demo/index.ts:379-422` (`onHello`). The
only check is `readMeta()`. It then attaches the socket under the
claimed identity (:401), delivers the mailbox (:413), sends the full
log with no `requireMember` (:415-418) and broadcasts the roster.
`requireMember` (:884-894) trusts that attachment.

Attacker: anyone holding the room link (a 10-character nanoid that is
exactly what gets passed around to invite people).

Impact:
1. Unauthenticated read of the whole log. Commits are sent as
   PublicMessage (`mls-actions.ts:237,278`), so every Add carries the
   joiner's KeyPackage and display name in the clear
   (`agentE/leak.cjs`: "joiner display name in clear: Joan Q. Public").
2. Impersonation of any admitted non-creator identity: write entries as
   them (feeds H5 and H6), evict their live socket
   (`replaceExistingSocket` :912-928 protects only the creator), or
   consume their pending Welcome from the mailbox (`deliverMailbox`
   deletes after sending, :753-756) so the joiner never gets in.
3. The creator is protected by the token check at :394-398.

Live behaviour unverified (no Worker was run); the logic halves were
exercised in Node.

Fix: challenge-response at `hello` (room sends a nonce, client signs it
with the leaf signature key; the identity is the Ed25519 public key so
the room can verify with WebCrypto). Serve `log`, `roster` and mailbox
only after that proof. Consider sending commits as PrivateMessage.

### H5 (demo). Messages are credited to the server-supplied sender

Location: `example-realistic-demo/client/timeline.ts:129`
`from: input.names[entry.sender] ?? 'unknown'`; `entry.sender` is set by
the room from the socket's self-claimed `hello` identity
(`index.ts:443`). Root cause in the library: M6.

Attacker: any admitted member via H4, or the Worker operator. In the
MLS model the delivery service is untrusted, and here it writes
`sender` directly.

Repro (`agentE/spoof.cjs`, Mallory's ciphertext logged with
`sender = aliceId`):

```
room mayWriteLog(aliceId, isCreator=false): true
bob processEntry result keys: [ 'kind', 'message', 'newState' ]
timeline item: {"from":"alice","text":"Alice here: send the invoice
    to IBAN XX00"}
```

Fix: credit the leaf MLS authenticated (needs M6) and map leaf index to
identity through `membership.ts`; treat `entry.sender` as a routing
hint and flag disagreement.

### H6 (demo). Any unprocessable commit still stops the client for good

Location: `client/delivery-client.ts:102-106` returns `'stop'` for any
commit failure; `mls-actions.ts:303-338` throws `MalformedEntryError`
only for decode failures. `onMls` (`index.ts:440-449`) validates
nothing server-side.

Attacker: any admitted member, or via H4 any stranger replaying a
commit copied from the log under a member's identity.

Repro (`agentE/wedge.cjs`): a replayed commit is rejected with
`ValidationError: epoch too old`, `isMalformedEntry = false`, verdict
`stop`; reload replays the same entry, so members are stuck until the
room expires (3 days).

`docs/security-audit.md:588` says "The demo room validates a
`commit`-kind entry before appending it"; it does not. The actual fix
(3ba47c2) is client-side and decode-only.

Fix: classify `epoch !== current`, groupId mismatch and a sender that
is not the creator as skippable; stop only for a current-epoch commit
from an authorised committer that then fails.

## Medium

### M1. Update proposals are validated against the pre-commit tree

Location: `src/client-state.ts:1219-1226` checks each Update against
`ratchetTree` rather than the running `acc`; Adds were fixed to use the
progressive tree (comment at :1238-1241), Updates were not.

Attacker: a member copying another member's newly advertised HPKE key
(no private key needed).

Impact: duplicate HPKE keys or a pairwise credential violation in the
tree; every later `joinGroup` rejects it, so the group cannot be
joined.

Repro (`agentC/r2.mjs`, `r2b.mjs`):

```
[A] m0 commits both Updates (same HPKE key): ACCEPTED
[A] later joiner joinGroup: ValidationError: Multiple public keys with
    the same value
m0 commits both Updates: ACCEPTED
later joiner: ValidationError: LeafNode does not support a credential
    type in use by a member of the group
```

Fix: validate each Update against `await acc`, or run uniqueness and
pairwise checks over the final tree.

### M2. Resync external commit passes no `priorCredential` to the AS

Location: `src/process-messages.ts:295-304` validates the joiner's leaf
against `result.tree`, which already has the Remove applied
(client-state.ts:878-880), so `credentialAtLeaf` (:486-492) returns
undefined. The Remove requires only an equal signature key (:869-875).

Repro (`agentC/r9.mjs`): identity changes from `carol` to
`carol-the-admin`; `authService` sees `prior=undefined` and accepts.

Fix: when an external commit carries a Remove, pass the removed leaf's
credential as `priorCredential`.

### M3. Branch resumption skips the RFC 9420 section 11.3 checks

Location: `src/client-state.ts:1010-1030`. For `usage === 'branch'` only
epoch, old group_id and new epoch 1 are checked. Version, ciphersuite
and extensions are compared only for `reinit`. Nothing checks that
every new leaf matches an old one.

Repro (`agentC/r5.mjs`): `joinGroupFromBranch` accepts a subgroup with
a different ciphersuite whose members are `m0-new`, `m1-new` and
`mallory`.

Fix: require version and ciphersuite equal to `resumingFromState`;
require every leaf to match an old leaf (needs an app hook or
`keyPackageEqualityConfig`); reject Welcomes with more than one
reinit/branch PSK.

### M4. Noble EdDSA verify is zip215, and identity-point keys are accepted

Location: `src/crypto/implementation/default/make-noble-signature-impl.ts:14`
and :38 use noble's default `{ zip215: true }`, which accepts y >= p
encodings. The default provider's Ed25519 is WebCrypto (RFC 8032
strict). `nobleCryptoProvider` is public (`src/index.ts:132`).

Impact: a member signs with a normal key but a non-canonical R;
noble-provider members accept and WebCrypto-provider members reject,
so a mixed group forks deterministically. Separately both providers
accept the identity point as a leaf signing key, and with it
(R=identity, S=0) verifies for every message: a universal-forgery leaf
key a member can register.

Repro (`agentE/ed2.cjs`, `ed.cjs`, Node v25.8.2; browsers unverified):

```
canonical A, crafted sig with non-canonical R:
  noble verifyWithLabel    : true
  webcrypto verifyWithLabel: false
A=identity, R=identity, S=0 | noble: true | webcrypto: true
```

Fix: `{ zip215: false }` on both noble verifies; reject small-order or
identity `signaturePublicKey` in LeafNode and KeyPackage validation.

### M5. Attachments: a cancel mid-derivation leaves a live epoch key

Location: `src/attachment/schedule.ts:199-211` (`segmentKey`) and
:349-357 (`wipeSealState`); reached from `reader.ts:608-611` and
`range.ts:344-345`, :415-418.

`wipeSealState` clears and zeroes the map, then the in-flight
derivation `set`s the real key into it. The `stateWiped` latch is
already set so nothing wipes it again, and the reader's `pull` runs
`aead.decrypt` with it after the cancel. Regression from the US-020
cache (AUDIT-ra.md row 1.15). The tests at
`test/attachment/streams.ts:1653` and :1807 gate exactly this step but
assert before `gate.release()`, and `assertScheduleWiped` never checks
the epoch key.

Repro (`agentD/repro-epochkey*.cjs`): gated run shows the epoch key
equal to the real key and one `aead.decrypt` after cancel on both the
reader and range paths; natural timing hits it in 12 of 200 cancels.

Fix: a `wiped` flag on `SealState`; in `segmentKey`, after the await,
`if (state.wiped) { key.fill(0); throw }` before caching; assert after
release in the tests.

### M6. `processMessage` drops the authenticated sender

Location: `src/process-messages.ts:69` result type
`{ kind:'applicationMessage'; message; newState }`; :138 and :157 drop
`result.content.content.sender`.

Impact: the library verifies the sender and then hides it, so every
consumer attributes by transport metadata (H5). RFC 9420 authenticates
the sender precisely so the application can rely on it.

Fix: return sender (leaf index and type) and `authenticatedData` on
`applicationMessage`, and the committer on `newState`.

### M7. Attachments: the range path drains the server with no cap

Location: `src/attachment/range.ts:425-443` (`drainStream`), called at
:183-187; the length check comes only afterwards at :198-200.

Attacker: a malicious storage server or network path.

Repro (`agentD/repro-drain.cjs`): 537 MB pulled for a 128 KiB range;
an endless body never settles (1.6 GB after 3 s). The sequential
reader stops after the first trailing byte.

Fix: pass the expected length into `drainStream`, throw and
`reader.cancel()` once exceeded, and cancel undrained streams on
failure.

### M8 (demo). No volume limits outside `join-request`

Location: `onMls` (`index.ts:424-465`) has no rate limit and no cap on
log rows or bytes (each entry up to 256 KiB, `protocol.ts:188`);
`onHello` sends the entire log in one frame; `onWelcome` loads every
row; `onCreate` (:339-377) has no creation limit; `route` (:1065,
:1080) instantiates a Durable Object for any syntactically valid id.

Impact: row-write quota exhaustion via `mls`; a log that outgrows the
WebSocket frame limit so `send` only logs (:940-955) and reconnecting
members silently desync; unbounded room and object creation.

Unverified live; from code reading.

Fix: per-socket interval on `mls`, caps on rows and bytes, paginated
replay, a throttle on `create`, and no object instantiation for GET on
an unknown id.

## Low

### L1. Malformed ratchet_tree extension throws `InternalError` pre-signature

Location: `src/ratchet-tree.ts:80-82` via `decodeRatchetTree`
(:140-146) and `ratchetTreeFromExtension` (`group-info.ts:59-66`).
Callers `joinGroup` (client-state.ts:1045, before the signature check
at :1063) and `joinGroupExternal` (create-commit.ts:548, before :571).
Repro: `agentC/r3.mjs`, `agentA/misc.cjs`. Fix: return `undefined`
(becomes `CodecError`) from the decoder when the list is empty or ends
blank.

### L2. Welcome without a needed `path_secret` is accepted

Location: `src/client-state.ts:962` and `src/create-commit.ts:516`
("No overlap between provided private keys and update path"). Repro
`agentC/r4.mjs`: the victim joins holding only its leaf key and is
stuck at the first later path commit. Fix: require `pathSecret` when
the common ancestor with the signer is non-blank and does not list the
joiner in `unmerged_leaves`; make :516 a `ValidationError`.

### L3. Committer leaf may reuse one of its own UpdatePath node keys

Location: `src/update-path.ts:284-300` never compares against
`path.leafNode.hpkePublicKey`. Repro `agentC/r8.mjs`: accepted by all
members, then every join fails with "Multiple public keys with the same
value". Fix: reject if the leaf key equals any path node key.

### L4. GCE plus Add accepts a member lacking the new extensions

Location: `src/client-state.ts:242-246` checks Adds against the current
extensions; the new-extension check at :262-268 excludes Adds.
`joinGroup` then reports it as `UsageError` (:1036) although a peer
caused it. Repro `agentC/r6.mjs`: a ghost member. Fix: check Adds
against the proposed extensions; throw `ValidationError`.

### L5. Proposal refs and external PSK ids index plain objects

Location: `src/client-state.ts:738` and :921. `"toString"` and
`"propertyIsEnumerable"` are valid base64. Repro `agentC/r11.mjs`:
`TypeError: Cannot read properties of undefined`. Fix: `Object.hasOwn`,
a `Map`, or `Object.create(null)`.

### L6. Future-epoch PrivateMessages are processed under current keys

Location: `src/process-messages.ts:103` checks only
`pm.epoch < state.groupContext.epoch`; the proposal branch at :172-192
has no `content.epoch !== state.groupContext.epoch` check, unlike the
public path at :225-231. Member-only (needs `senderDataSecret`). Repro
`agentB/t2.cjs`: an app message labelled epoch 3 and a proposal
labelled epoch 7 are both accepted at epoch 2. Fix: reject
`pm.epoch > current` before unprotecting.

### L7. An Update that keeps the sender's current encryption key is accepted

Location: `src/client-state.ts:557-566`; RFC 9420 section 12.1.2
requires a new key. Repro `agentC/r2.mjs` [B]. Fix: reject an Update
whose `hpkePublicKey` equals the sender's current leaf key.

### L8. Error-type contract breaks reachable from the wire

- `src/credential.ts:61-71`: an unknown credential type (including
  GREASE 0x0A0A) makes `decodeCredentialType` return a non-function and
  `tls-decoder.ts:93` throws `TypeError: decoderU is not a function`
  (`agentB/t3b.cjs` fuzz, `t4.cjs`).
- `src/message-protection-public.ts:147`: a PublicMessage carrying
  application content throws `UsageError` before the membership tag
  check (`agentB/t3.cjs`).
- `make-webcrypto-signature-impl.ts:42-55`: a 31-byte Ed25519 key
  surfaces as `DOMException DataError` (`agentE/dataerr.cjs`).
- `src/crypto/implementation/hpke.ts:80`: AEAD rejections are
  `CryptoError` where MAC and signature failures are
  `CryptoVerificationError`.

Fix: `default:` arm in the credential decoder, `ValidationError` at
the two sites, length-check or catch on key import.

### L9. `createProposal` skips the can-send gate

Location: `src/create-message.ts:11-67` never calls
`checkCanSendHandshakeMessages`. Local misuse only. Repro
`agentB/t5.cjs`: a removed or suspended client still emits proposals.

### L10. Attachments: KDF scratch buffers keep CEK and payloadKey copies

Location: `src/attachment/kdf.ts:112-118`; neither `extractInput` nor
`prk` is wiped. Repro `agentD/repro-residue.cjs`: four extract-input
buffers still hold the CEK after the caller wiped it. Fix: `fill(0)`
both in a `finally`; `sealKdf` allocated them.

### L11. Attachments: the whole header is buffered before the 64-byte gate

Location: `src/attachment/reader.ts:425-437` then :462. Repro
`agentD/repro-header.cjs`: 98 MiB consumed before rejecting a wrong
commitment at the 128 GiB design target; a member-signed
`plaintextLength` can push that to hundreds of MiB. Fix: run
`startOpen` at `32+nh` bytes and stream metadata per epoch.

### L12. ECDSA verify accepts high-S

Location: `make-noble-signature-impl.ts:62,85,112` (`lowS: false`).
Repro `agentE/ed2.cjs`. RFC 9420 does not require low-S, but anything
keyed by a hash of signed bytes (KeyPackageRef) can be re-minted by a
relayer. Document or verify with `lowS: true`.

### L13 (demo). An expired room id can be re-created by anyone

`alarm()` does `deleteAll` (:274-299); `onCreate` then accepts the same
id. Old invitation links and persisted sessions reconnect into an
attacker-owned room. Fix: tombstone or refuse re-creation.

### L14 (demo). The M10 `.gitignore` hardening was lost in a squash merge

`.gitignore:7` has only `.env`; `git merge-base --is-ancestor 8fc74e5
HEAD` exits 1; `git check-ignore` ignores none of `.env.production`,
`id_ed25519`, `key.pem`, `.dev.vars`. `docs/security-audit.md:598`
still claims it is fixed. No secret-looking file is tracked. Fix:
restore the 8fc74e5 patterns and add `.dev.vars*`.

### L15. `auto-dependabot.yml` is broken and its guard is ineffective

`paths: - 'dependabot/**'` filters file paths, not branch names; the
label guard compares an array to a string so it is always true; the
merge call is not awaited. It runs on `pull_request` with the read-only
default token, so the exposure is low today but becomes real if anyone
switches it to `pull_request_target` or adds write permissions.
`nodejs.yml` also has no `permissions:` block. Static read only.

## Informational

- Transient secrets (`joinerSecret`, `welcomeSecret`, `commitSecret`,
  `pskSecret`, `externalInitSecret`) are never zeroed; when
  `toPrivateKeyPath` throws inside `updatePrivateKeyPath`,
  `zeroPathSecrets` at process-messages.ts:473 is skipped; the old
  leaf private key dropped by `updateLeafKey` is never reclaimed.
- `applicationExportSecret` stays on `KeySchedule` for the epoch.
  draft-ietf-mls-extensions-09 says a component's exported secret MUST
  be regarded as consumed and its source material deleted. Same
  pattern as `exporterSecret`; document the deviation or cache the
  component secret and drop the root.
- Trailing bytes after SenderData are accepted
  (`private-message.ts:187`); member-only malleability.
- A member can charge each receiver up to `maximumForwardRatchetSteps`
  KDF steps per message; the cap is enforced before derivation, so
  bounded (200 steps measured at 27 ms).
- `applyUpdatePath` does not blank direct-path nodes outside the
  filtered direct path (RFC 7.5); honest flows never produce such a
  node. Unverified.
- Joins stop working after about 30 days if members only ever commit
  Adds without a path, because `validateLifetimeOnReceive` runs on
  every key_package-sourced leaf (`agentC/r12.mjs`).
- Attachments: `decryptAttachmentStream` and `openAttachmentRange` do
  not call `assertCekLength` (fail closed at the commitment);
  `rangesFor` accepts `NaN` through the subpath export;
  `openAttachmentRange` returns its internal `ranges` array; the CEK is
  not bound to the sender, so dedupe on `(objectId, snapshot)`.
- Demo persistence writes raw HPKE private keys, epoch and secret-tree
  secrets and the creator token in plaintext to IndexedDB (opt-in and
  disclosed); the realistic build ships inline sourcemaps; the creator
  token is compared with `===` (122-bit UUID, remote timing
  impractical).
- AGENTS.md says `npm audit` reports 0 vulnerabilities. Real output:
  `npm audit --omit=dev` is clean, `npm audit` reports 8 dev-only
  findings, all fixable with `npm audit fix`.
- Suites 0xF001-0xF004 are named SHA256/SHA384 but use SHA-512;
  `@hpke/ml-kem` `deriveKeyPair` uses the ikm directly as the seed
  (documented at `ciphersuite.ts:155-161`); `importSignatureKey` for
  ML-DSA returns the seed, which `ml_dsa87.sign` cannot use; ML-DSA
  keygen calls `getRandomValues` directly, bypassing the provider RNG.

## Inaccurate rows in earlier audit records

- `docs/security-audit.md` "Confirmed correct": signature/MAC before
  state mutation. False for the confirmation tag (H1).
- `docs/security-audit.md:588`: the room validates commit entries.
  False (H6).
- `docs/security-audit.md:598`: M10 `.gitignore` fixed. Lost (L14).
- `AUDIT-ra.md` rows 1.4 and 2.2 (cancel anywhere in `start()` leaves
  the state zero): false for epoch-key derivation (M5). Row 1.15
  introduced M5. Row 1.12 is accurate as worded but two entry points
  still take any CEK length.
- `src/attachment/AGENTS.md` "Two gaps remain" should also list M5 and
  L10.

## Checked and found sound

- Signature and membership-tag checks run before any state change on
  both wire formats; the outer sender type comes from the decoder so
  the membership-tag branch cannot be bypassed.
- Replay of a consumed generation, out-of-order delivery, retention
  limits 0/1/2, the `maximumForwardRatchetSteps` boundary, uint32
  generation arithmetic, sender-data sample length, blank and
  out-of-range sender leaf indices, old-epoch handling, AEAD `finally`
  wipes, AAD binding of authenticated data, content type and epoch,
  zero-padding enforcement, and non-minimal varint rejection all behave
  correctly under repro and 10000+ fuzz mutations with no
  `InternalError`.
- A tampered ciphertext does not consume the ratchet.
- Welcome and external-join trees get a structural check, parent-hash
  coverage exactly once with the section 7.9.2 resolution criterion, a
  tree-hash match, unmerged-leaf checks, and every leaf validated
  (signature, AS, pairwise credentials, required_capabilities, key
  uniqueness, lifetime). UpdatePath leaf parent_hash and signature are
  verified; path keys are unique against the tree and within the path;
  derived keys are checked against advertised keys.
- Proposal-list rules that do hold: duplicate Remove, Update plus
  Remove, committer's own Update or Remove, duplicate Adds, Add with an
  existing signature or HPKE key, ciphersuite and version, `init_key !=
  encryption_key`, lifetime, ExternalInit only once and only in
  `new_member_commit`, ReInit alone, at most one GCE, external sender
  restrictions, `new_member_proposal` Add-only, unknown refs rejected,
  `validateExternalSenders` in all three callers plus
  `validateProposals`. External commit: no by-reference proposals, at
  most one Remove of a same-key leaf, path required, mismatched
  `external_pub` caught by the tag.
- PSK nonce length, duplicate ids in commits, reinit/branch only at
  epoch 0, reinit Welcome checks. Tree geometry and the ordering of
  Removes are correct; the sole-leaf Remove is a `ValidationError`.
- Ratchet ownership (`ownsSecret`) never zeroes input-tree buffers;
  `stripHandshakeRatchets` copies; no `state.secretTree` or
  `state.keySchedule` buffer is mutated on any failing path; node index
  and proposal-ref keys cannot be `__proto__`; epochs are bigints.
- Attachments: the integrity matrix (block/leaf swap, same-plaintext
  swap, cross-object splice, head transplant, substitution, truncation,
  append, off-by-one length, short or long or missing range streams)
  rejected every tamper with zero plaintext released on the stream
  path. Segment index and finality are in the nonce, the epoch in
  `epoch_key`, leaf order in the root, objectId and salt in the
  commitment. The CEK derivation was re-derived independently in Python
  and matches the frozen vectors; mutated vectors fail the tests. A
  20000-mutation fuzz of encoded refs threw only `AttachmentError`.
- Crypto layer: `constantTimeEqual` branches only on public length;
  MAC checks use `subtle.verify` or `constantTimeEqual`; RFC 9420
  label, TBS, EncryptContext, ExpandWithLabel and DeriveTreeSecret
  encodings are correct; RFC crypto-basics vectors 56/56; suites 1 to 7
  match section 17.1; node, leaf and external keys use HPKE
  `deriveKeyPair`; AEAD keys are imported non-extractable per call; all
  randomness goes through `getRandomValues` with no `Math.random`; PQ
  suites fail closed with `DependencyError` when a peer is missing;
  runtime dependencies are pinned exactly.
- Demo: `window.state=` is absent from both built bundles
  (`npm run build-example`, `npm run build:realistic`, grep exit 1);
  no `innerHTML`, `dangerouslySetInnerHTML` or `eval`; CSP
  `default-src 'none'` with self-only script/style/connect and
  `frame-ancestors 'none'`, XFO DENY and nosniff on every non-101
  response; frame wall before `JSON.parse`; room ids validated before
  `getByName`; join-request cap and throttle in place; `approve`,
  `deny`, `removed` and `welcome` token-gated; parameterised SQL; no
  tracked secrets; `gh-pages.yml` least-privilege; CI uses `npm ci`.

## Suggested order of work

1. H1 and H3: both are remote denial of service against the whole
   group, and they compound.
2. H2: forward secrecy within the epoch.
3. M1, M2, M3, M4: tree integrity and authentication gaps a single
   member can exploit.
4. M6, then H4, H5, H6 in the demo, which depend on it.
5. M5, M7 and the attachment Lows, plus the AUDIT-ra.md corrections.
6. The remaining Lows and the record corrections in
   `docs/security-audit.md`.

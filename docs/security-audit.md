# Security Audit -- webcrypto-mls

Date: 2026-08-09
Branch audited: `audit`
Scope: `src/` (library), `example-realistic-demo/` (Worker + client),
`example-shared/`, `example/`, and repo hygiene (secrets, dependencies,
CI, randomness, timing safety).

This is a read-only audit. No files were changed. Findings that were
directly reproduced or re-read in the source are marked "verified". This
library is a fork of `LukaJCB/ts-mls`; some findings may be inherited from
upstream.

Re-reviewed 2026-08-09: every finding was independently re-verified
against the source. All findings stand. Corrections from that pass
(line-reference drift, one over-claim in M3's test note, a scope
qualifier on M1 and M8, and L9's numbers being unreproducible without a
lockfile) are folded into the finding texts below and marked
"re-review".

The audit itself was read-only. Every finding has since been fixed on
this branch; see "Resolution status" at the end for the finding-to-story
map. The finding texts below are left as written, in the present tense of
the audit, so they still describe the code as it was.

## How to read this

Severity reflects impact assuming the library is used as an MLS
end-to-end-encryption library in production. The two most serious items
(C1, H1) are memory-aliasing bugs in the ratchet that can silently
destroy confidentiality and forward secrecy. Several MEDIUM handshake
items are missing RFC 9420 validation checks that let any single group
member either impersonate peers or permanently wedge the group.

Two items (M6, M7) are already documented in the README as intentionally
permissive defaults; they are repeated here because "insecure by default"
is still a gap a downstream fork can ship unnoticed.

---

## Critical

### C1. In-place zeroization corrupts the caller's live group state, leaking plaintext under an all-zero key

Files: `src/secret-tree.ts:319` (`createRatchetResultWithSecret`),
reached via `createRatchetResult:291` and `consumeRatchet` / `ratchetToGeneration`.

`createRatchetResult` passes the ratchet node's *current* secret buffer
(`currentSecret.secret`, which is literally `tree[index].application.secret`)
down to `createRatchetResultWithSecret`, which calls `secret.fill(0)` at
line 319. `updateArray` only installs a *new* node object into the
returned `newTree`; the input `tree` -- which the caller's `ClientState`
still references, because the API is functional and returns a new state
each call -- now holds an all-zero secret with its `generation` counter
unchanged. The code comment at 314-318 reasons only about `ratchetState`
and `newTree`; it misses that the input tree still aliases the wiped
buffer. (The sibling `stripHandshakeRatchets` comment at 73-80 shows the
author already knew about this exact aliasing hazard elsewhere.)

Failure scenario (agent reproduced this by execution through the public
`index.ts` API): a caller sends a message, then re-uses the *same* prior
state for the next send -- the natural pattern on a transport failure, a
rejected-commit retry, or any signal/React re-render that keeps the old
state object. The second send derives its AEAD key from
`ExpandWithLabel(0^Nh, "key", uint32(0), Nk)`, a constant depending on
nothing secret. Any outsider or evicted member recovers the key and needs
only to brute the 4-byte reuse guard (instant for a current member).
Complete loss of confidentiality and forward secrecy for messages sent
from a stale state.

Re-review: the reach is wider than deliberate state reuse. `consumeRatchet`
(`:254-267`) passes the live tree's node object straight through, so the
send path always wipes the live buffer, and an in-order receive
(`ratchetUntil` with zero steps) does the same. If the subsequent AEAD
call or signature check throws (`message-protection.ts:185`, `:252`,
`:277`), the caller's retained state already holds a zeroed ratchet
secret with its generation counter unchanged -- no caller mistake
required. `removeOldGenerations` also mutates the values of the input
`unusedGenerations` record itself, not just the shared buffers.

Same aliasing class at `src/secret-tree.ts:181` (`removeOldGenerations`
zeroes `Uint8Array`s copied by reference out of a still-live prior state's
`unusedGenerations`).

Fix direction: never `fill(0)` a buffer owned by an input structure the
caller still holds. Copy before wiping, or only wipe buffers this function
allocated. Treat state objects as immutable inputs.

---

## High

### H1. `retainKeysForGenerations: 0` retains every skipped generation forever (forward-secrecy loss + memory DoS)

File: `src/secret-tree.ts:177` (`removeOldGenerations`), gated at `:164`.

`sortedGenerations.slice(-max)` with `max === 0` is `slice(-0)` === `slice(0)`,
which returns the *entire* array. So `keptSet` contains every generation,
the `fill(0)` loop zeroes nothing, and the full map is returned. The sibling
`removeOldHistoricalReceiverData` (`client-state.ts:1207`) has the guard
that is missing here (`if (max <= 0) return new Map()`).

Failure scenario (verified): a deployment sets
`retainKeysForGenerations = 0` meaning "retain no out-of-order keys".
Receiving a single message at a high generation retains and never zeroes
every skipped generation's secret (up to `maximumForwardRatchetSteps`, 200,
per received message per leaf). Each retained secret regenerates all later
generations, destroying in-epoch forward secrecy, and memory grows without
bound -- a remote exhaustion vector. The setting does the exact opposite of
its name.

Fix direction: add `if (max <= 0) return {}` (and zero all buffers) at the
top of `removeOldGenerations`.

### H2. A single unverified `commit`-kind entry permanently bricks the demo room for every member

Files: `example-realistic-demo/protocol.ts:26` (`kind` "asserted by sender,
unverified"), `client/delivery-client.ts:61-70` (`onError` returns `'stop'`
without advancing the cursor), `client/delivery-cursor.ts:22-25`,
`index.ts:401-442` (`onMls` trusts `kind`).

The server stores an entry's `kind` exactly as the sender asserts it, with
no correlation to what `payload` actually decodes as. On the client, any
entry whose `kind === 'commit'` that fails to process is treated as fatal:
`onError` returns `'stop'` and the cursor is *not* advanced. Reconnecting
resends `hello` with the same stuck cursor, `entriesSince` returns the same
poisoned entry, and it fails identically forever.

Failure scenario (verified): any admitted member sends one WebSocket
message `{type:'mls', kind:'commit', payload:'AAAA'}`. Every other member's
queue stops on it and cannot advance past it across reconnects. The room is
dead for everyone but the attacker until its 3-day expiry. This is a demo,
but it is a logic gap (not a documented tradeoff) of exactly the kind a
production fork inherits.

### H3. Unauthenticated, unbounded join-request flood (quota-exhaustion DoS)

Files: `example-realistic-demo/index.ts:449-469` (`onJoinRequest`),
`:128-134` (`pending` schema keyed by `identity`), `:694-717`.

`onJoinRequest` requires only that the room exist -- no membership, no rate
limit, no cap on distinct identities, no size ceiling on `keyPackage`.
Because `pending` is keyed by `identity`, each fresh random identity is a
new row. A scripted client sending thousands of join-requests/second with
random identities and large key packages burns the Cloudflare free-tier
row-write quota (documented as a hard daily failure) in minutes, taking the
deployment offline, and forces an ever-growing list to the creator on each
request. Open join is intentional; the total absence of any cap is the gap.

---

## Medium

### M1. No size limit on any client-supplied wire string (storage-growth DoS)

Files: `example-realistic-demo/protocol.ts:186-208` (`isClientMessage`
checks type only), `index.ts:401-442`, `:553-586`.

Every string off the wire (`mls`/`welcome` payload, `keyPackage`,
`identity`) is checked with `isStr`/`isNum` only, never bounded. An
admitted member can append multi-MB `application`/`commit`/`proposal`
payloads to the room log, persisted for 3 days and re-broadcast to every
peer on every reconnect. The authors reasoned about *who* may write but not
*how large* a write may be.

Re-review: the `welcome` path (`index.ts:559`) is `requireCreator`-gated,
so the oversized-write vectors are any admitted member's `mls` payload
and any stranger's unauthenticated `join-request` key package (see H3),
not welcomes.

### M2. Missing "derived key matches advertised key" check on UpdatePath / Welcome (targeted group split)

Files: `src/process-messages.ts:412-453` (`updatePrivateKeyPath`),
`src/create-commit.ts:471-516`, `src/client-state.ts:872-887`. Verified:
`grep hpkePublicKey` across the path-processing files returns nothing.

After decrypting a path secret, the receiver derives node key pairs but
never checks that each derived public key equals the `hpkePublicKey`
carried in the corresponding `UpdatePathNode` / installed into the tree
(RFC 9420 sections 7.5 / 12.4.3.1). A malicious committer can publish an
UpdatePath whose advertised public keys it controls while the encrypted
path secret for victim V is unrelated. The confirmation tag covers the tree
hash of the *advertised* keys, so V accepts the epoch, then holds a private
path that cannot decrypt future commits -- a silent, targeted group split /
permanent DoS. Same gap on the Welcome path.

### M3. Over-strict unmerged-leaves validation rejects RFC-valid trees (no new member can ever join)

Files: `src/client-state.ts:344-365` (`validateUnmergedLeaves`). Verified
empirically by the agent. Re-review: the test at
`test/validation/unmerged-leaves-validation.ts:51-72` documents the
over-strict rule only in its assertion message; its fixture satisfies
both the strict and the correct semantics, so it does not mechanically
lock in the wrong behavior and would still pass after a fix.

The check walks the unmerged leaf's *entire* root-ward direct path and
requires every non-blank node to list that leaf, instead of only the nodes
strictly between the leaf and the parent under inspection (RFC 9420 7.9) --
contradicting the function's own docstring. An ordinary honest `Add`
followed by the committer clearing its filtered direct path produces a tree
where an ancestor legitimately does not list the leaf, and
`validateUnmergedLeaves` throws. Every subsequent `joinGroup` /
`joinGroupExternal` on that group then fails permanently. No attacker
needed. The test's assertion message should be corrected along with the
code so it stops documenting the wrong rule.

### M4. Key-uniqueness check for Add is incomplete (self-inflicted permanent join failure)

Files: `src/client-state.ts:1134-1156`, `:498-507` (`keysAreNotUnique`,
called with `leafIndex: undefined` and only over leaf nodes, against the
pre-mutation tree).

Two `Add`s in one commit are never compared to each other, and an added
leaf's `encryption_key` is never compared against parent-node HPKE keys. A
member can commit two Adds sharing an HPKE key (with distinct signature
keys, so the KeyPackage-equality guard does not fire), or an Add whose
`encryption_key` equals a parent node key. Every current member accepts it,
but the resulting tree fails this same library's stricter
`hasDuplicateUint8Arrays` check at join time (`:391-395`), so all future
joins are rejected. Same DoS class as a leaf key colliding with a parent
node key on UpdatePath.

### M5. No identity continuity on leaf replacement (impersonation within the group)

Files: `src/client-state.ts:442-457` (`validateLeafNodeUpdateOrCommit`),
`:485-492`, `src/process-messages.ts:275-284`,
`src/authentication-service.ts:3-5`. Verified: the function checks the new
self-signature and `validateCredential(newCred, newKey)` but never compares
against the credential currently at that leaf.

When an `Update` or a commit's UpdatePath replaces the leaf at index i, the
new leaf's self-signature binds only `groupId`+`leafIndex`, and
`AuthenticationService.validateCredential` is given no view of the prior
credential -- so it *cannot* enforce continuity even if it wanted to. With
`basic` credentials (a shipped, RFC-sanctioned type), member Mallory at
leaf 3 can send an Update whose `credential.identity` is `alice`, validly
bound to Mallory's own fresh key. After the commit, every member attributes
leaf 3's messages to Alice. Full identity impersonation of an arbitrary
identity string by any member. Also missing: the reverse RFC 7.3
capability direction -- the new leaf is not required to support the
credential types already in use by existing members (`:485-492`), allowing
a silent downgrade of the group's credential floor.

### M6. `validateLifetimeOnReceive` defaults to `false` (expired KeyPackages accepted)

Files: `src/lifetime-config.ts:17-20`, `src/client-state.ts:524-533`.
Documented in README "Security Considerations".

Received leaf-node lifetime is enforced only when this client authored the
leaf. By default a replayed long-expired KeyPackage (whose signing key may
have been rotated or compromised) is accepted as an Add. RFC 9420 7.3
requires the check on receipt. A production app must set
`validateLifetimeOnReceive: true`.

### M7. `defaultAuthenticationService` accepts every credential (insecure by default)

Files: `src/authentication-service.ts:17-21`, `src/client-config.ts:34-41`,
default param at `src/client-state.ts:903`, `:1043`,
`src/create-commit.ts:525`. Documented in README "Security Considerations".

`validateCredential` returns `true` unconditionally and is the default for
`joinGroup`/`createGroup`/`joinGroupExternal`. Every credential check in the
codebase no-ops out of the box, so the documented 5-arg `joinGroup` form
accepts any identity from any peer on Add, Update, GroupInfo signer, and
`external_senders`. Consider making the default fail closed or requiring an
explicit `unsafeAcceptAllCredentials` opt-in rather than silent acceptance.

### M8. `window.state` exposed unconditionally in the teaching demo

Files: `example/index.ts:50-51` (unconditional), vs.
`example-realistic-demo/client/index.ts:55-59` (gated behind `isDev()`).

The feature demo assigns `window.state = state` in every build. Signature
private keys are safe (confirmed non-extractable `CryptoKey`, generated with
`extractable:false`), but `ClientState` also carries HPKE/tree secrets as
plain `Uint8Array`s and the full decrypted-message history, all readable
through the global. `example/` is the more copy-pasted of the two demos and
has no dev gate; it should be gated like the realistic demo already is.
Re-review: the non-extractable guarantee holds only for the WebCrypto
Ed25519 suite; other ciphersuites route to noble implementations whose
signature secrets are raw `Uint8Array`s, also reachable through the
global.

### M10. `.gitignore` ignores only literal `.env`, not `.env.*` or key files

File: `.gitignore:7`.

The entry is `.env` (exact), so a future `.env.local` / `.env.production`
is not ignored and could be committed. No `*.pem` / `*.key` / `*.p12`
patterns either. No env or key files exist in the working tree today, so
this is defense-in-depth, but the rule is too narrow for a crypto project.

---

## Low

### L1. Sender-data key/nonce never zeroized

`src/private-message.ts:168-169`, `:188-189`. Unlike content key/nonce
(`message-protection.ts:192-193`, `:254-255`), the sender-data key/nonce are
returned without wiping. A heap snapshot after N messages yields N
sender-data keys, each deanonymizing a PrivateMessage's sender leaf index
and generation -- defeating the metadata hiding PrivateMessage is meant to
provide.

### L2. Content key/nonce leak on the AEAD error path (no `try`/`finally`)

`src/message-protection.ts:185-193`, `:252-255`. The `fill(0)` calls are
straight-line after `encryptAead`/`decryptAead`; if the AEAD call rejects
they are skipped and the live key escapes. A flood of corrupt-ciphertext
PrivateMessages leaves one un-wiped content key per attempt resident. Wrap
in `try`/`finally`.

### L3. Commit self-removal leaves the client at the old epoch (fork/replay)

`src/process-messages.ts:289-298`. When a commit removes this client,
`processCommit` returns early with the group context unchanged (epoch not
incremented) and only flips `groupActiveState`. Nothing gates further
inbound traffic on that state, so a remaining member can feed the removed
client an alternative commit at the same epoch and resurrect it into a
fork; the removing commit can also be replayed indefinitely.

### L4. `needsUpdatePath` ignores custom proposal types (no PCS on custom-only commit)

`src/client-state.ts:746-750`, `:681-686`, `src/process-messages.ts:287`.
A commit consisting solely of an opted-in custom proposal is accepted with
no UpdatePath and an all-zero commit secret, so no key material rotates --
no forward secrecy / post-compromise security despite a state change. RFC
12.4 requires a path for any non-add/psk/reinit proposal.

### L5. External-senders extension not re-validated on join

`validateExternalSenders` is defined at `src/client-state.ts:291-310`,
with exactly two call sites: `:288` (proposal validation, reached only
when the commit carries a `GroupContextExtensions` proposal) and `:1064`
(`createGroup`). Neither `joinGroup` (`:895-1035`) nor
`joinGroupExternal` (`src/create-commit.ts:518` on) validates an
`external_senders` extension already present in the joined group. A joiner
can end up accepting proposals signed by an unvetted external identity.

### L6. Welcome path-secret derivation walks to the geometric root

`src/client-state.ts:872-887`, `src/path-secrets.ts:49-67`. The Welcome
path uses `findFirstNonBlankAncestor` (root-ward) where the commit path
deliberately uses the filtered direct path. They diverge if a non-blank
node sits above the committer's filtered path; combined with M2's absent
key-match check, the mismatch is silent until a later decrypt fails. Also
stores a key for a blank root index without pruning.

### L7. `decodeReuseGuard` has no bounds check, mis-reports length

`src/sender.ts:109-111`. `subarray` clamps silently, so a short buffer
yields a 1-3 byte value cast to the branded `ReuseGuard` (`length:4`) and
reports consuming 4 bytes. Currently fails closed downstream
(`derivePrivateMessageNonce` throws), but the type guarantee is violated
for any future consumer trusting `.length === 4`.

### L8. `alwaysPad` padding mode hides no length

`src/padding-config.ts:7-10`. `alwaysPad` returns a constant pad length
independent of plaintext length, so ciphertext length is an exact affine
function of plaintext length -- the name implies length hiding but a passive
observer subtracts the constant and recovers exact payload lengths. The
default `padUntilLength: 256` mode hides length only up to 256 bytes.

### L9. No lockfile committed; dev-chain `npm audit` findings unreproducible

Re-review: the repository commits no lockfile at all (`package-lock.json`
is absent from disk and git), so `npm audit` fails with `ENOLOCK` and the
originally reported numbers (7 dev-only vulnerabilities: 3 moderate, 4
high, in the `brace-expansion`, `js-yaml`, `nanoid`/`postcss`, and
`undici` via `wrangler` -> `miniflare` chains) came from a transiently
generated lockfile and cannot be re-checked as the tree stands. The
missing lockfile is itself the finding: dev installs are unpinned and
audits unreproducible for a crypto library. Commit a lockfile, then run
`npm audit` and fix the dev-chain findings at low urgency. Runtime
dependencies remain a small pinned set (`@hpke/*`, `@noble/*`).

### L10. Missing version check on join; internal-error type on empty-tree remove; no CSP/security headers on demo

- `src/client-state.ts:979`: `joinGroup` checks ciphersuite but not
  `groupContext.version` vs `keyPackage.version`.
- `src/client-state.ts:796-798` (external commit; member-commit
  equivalent at `:1128-1132`) / `src/ratchet-tree.ts:217-238`, throw at
  `:81` (`extendRatchetTree`): a resync remove of a single-member group's
  sole leaf throws `InternalError` (bug-shaped) rather than
  `ValidationError` (rejected-input-shaped) from remote input.
- `example-realistic-demo` sets no CSP / `X-Frame-Options` /
  `X-Content-Type-Options`; no active injection vector was found, so this is
  defense-in-depth (would blunt any future bug reaching `window.state`).

---

## Confirmed correct (not gaps)

These were checked and found sound; listed so a re-audit does not re-cover
them.

- Nonce derivation and reuse-guard XOR (RFC 6.3.2): per-generation nonce,
  reuse guard XORed into the first 4 bytes only, fails closed on length.
- Reuse-guard entropy: `crypto.getRandomValues` (both providers), fresh per
  message. No `Math.random` anywhere in `src/`; `Date.now` only for
  lifetime checks, never as entropy.
- Key schedule labels/structure (RFC 8): init/sender-data/encryption/
  exporter/external/confirm/membership/resumption/authentication all
  correct; joiner/epoch/welcome secret extraction and PSK secret binding
  correct; `ExpandWithLabel`/`DeriveTreeSecret` encoding correct.
- Sender-data encryption: key/nonce from ciphertext sample, correct AAD,
  correctly not XORed with the reuse guard.
- AAD binding and signatures: `PrivateContentAAD` and `FramedContentTBS`
  include group context; a forged epoch/group_id fails the signature.
- Signature/MAC verification is performed before state mutation on both
  message paths; membership tag and confirmation tag verified; MAC compares
  are constant-time (WebCrypto `verify` or `constantTimeEqual`); group_id
  compared with `constantTimeEqual`.
- Padding validation is constant-time and post-authentication (no oracle);
  trailing bytes rejected on the outer envelope.
- Welcome/GroupInfo: signer leaf existence + credential + GroupInfo
  signature + full `validateRatchetTree` (parent hashes per 7.9, tree hash
  vs signed context, duplicate-key check) + confirmation tag, all verified
  before returning; init private key zeroized on success.
- Commit processing: epoch equality enforced first; transcript hashes
  correct; extensive proposal-conflict validation; external-commit rules
  (12.4.3.2) enforced; `applyUpdatePath` rejects duplicate/pre-existing keys
  and verifies parent hashes.
- Per-epoch secret-tree freshness; bounded epoch retention; replay of
  same/old-epoch handshake messages rejected before decryption.
- No hardcoded secrets in source, `wrangler.jsonc`, or git history; no
  `console.*` in `src/`; no `eval`/`new Function`; demo chat rendering uses
  auto-escaping `htm`/preact templates (no XSS found); no `postinstall`
  hooks. Signature private keys are non-extractable `CryptoKey`s for the
  WebCrypto Ed25519 suite (noble-backed suites hold raw bytes; see M8).

---

## Suggested priority order

1. C1 and H1 -- ratchet aliasing bugs; fix the in-place `fill(0)` on
   caller-owned buffers and the `slice(-0)` guard. These break the core
   security guarantee.
2. M2, M3, M4, M5 -- RFC 9420 validation gaps that let one member
   impersonate peers (M5) or permanently wedge the group (M2, M3, M4).
   M3 also blocks legitimate joins today.
3. H2, H3, M1 -- demo Worker hardening (verify/validate `kind`, cap join
   requests and payload sizes) before anyone forks it into production.
4. M6, M7 -- change the insecure-by-default posture to fail-closed or
   explicit opt-in.
5. M8, M10 and the Low items as cleanup.

---

## Resolution status

Appended 2026-08-09 at the end of branch `audit`, after every finding was
fixed. Each row names the story that fixed it and the commit subject to
read for the reasoning; the tests are the ones added or rewritten for
that story.

There are 23 findings: C1, H1 to H3, M1 to M8 and M10, and L1 to L10.
Every one is fixed on this branch, and none was deliberately left open.
The table has 22 rows because L1 and L2 were one fix. Nothing is numbered
M9 -- the audit's medium findings skip from M8 to M10, so the absence is
a numbering gap, not an unaddressed item.

| Finding | Story | What changed |
| --- | --- | --- |
| C1 | US-001 | `createRatchetResultWithSecret` takes an `ownsSecret` flag and wipes only what its own call chain allocated; `removeOldGenerations` stopped wiping evicted buffers. |
| H1 | US-002 | `removeOldGenerations` returns `{}` when the retention max is 0 or less, instead of `slice(-0)` retaining everything. |
| H2 | US-008 | The demo room validates a `commit`-kind entry before appending it, so one garbage entry can no longer wedge every member. |
| H3 | US-009 | `classifyJoinRequest` caps the pending queue, bounds a join request's key package, and rate-limits per socket. |
| M1 | US-010 | Every client-supplied wire string in `protocol.ts` is length-bounded, and an oversized frame is refused before `JSON.parse`. |
| M2 | US-003 | `toPrivateKeyPath` takes the tree and verifies each derived public key against the node's advertised `hpkePublicKey`, on both the commit and the Welcome path. |
| M3 | US-004 | `validateUnmergedLeaves` constrains only the non-blank nodes strictly between the unmerged leaf and the parent under inspection. |
| M4 | US-005 | Adds are validated against the incrementally mutated tree, and a leaf key colliding with any parent node key is rejected. |
| M5 | US-006, US-007 | `validateCredential` receives the credential being replaced (US-006), and a new leaf must support every credential type already in use (US-007). |
| M6 | US-011 | `defaultLifetimeConfig.validateLifetimeOnReceive` defaults to `true`. |
| M7 | US-012 | `defaultAuthenticationService` is replaced by `failClosedAuthenticationService` (the new default) and `unsafeAcceptAllAuthenticationService` (opt-in by name). |
| M8 | US-013 | The teaching demo assigns `window.state` only behind a dev check. |
| M10 | US-014 | `.gitignore` covers `.env.*` and key files. |
| L1, L2 | US-015 | Sender-data and content key/nonce are zeroized in a `finally`, so they are wiped on the AEAD error path too. |
| L3 | US-016 | `processPrivateMessage`/`processPublicMessage` refuse all inbound traffic once `groupActiveState.kind === 'removedFromGroup'`. |
| L4 | US-017 | `needsUpdatePath` reads `allProposals`, so a custom-proposal-only commit still rotates key material. |
| L5 | US-018 | `joinGroup` and `joinGroupExternal` run `validateExternalSenders` on the group they are joining. |
| L6 | US-019 | The Welcome path derives its private key path along the committer's filtered direct path, matching the commit path. |
| L7 | US-020 | `decodeReuseGuard` bounds-checks its offset instead of letting `subarray` clamp. |
| L8 | US-022 | `padding-config.ts` and the README state what each padding mode does and does not hide. |
| L9 | US-014 | `package-lock.json` is committed, so `npm audit` numbers are reproducible. |
| L10 | US-021, US-023 | Version check on join and `ValidationError` on a sole-leaf remove (US-021); CSP and security headers on the demo Worker (US-023). |

The "Confirmed correct (not gaps)" list above was not re-verified as part
of the fix work. It describes the code as audited; several of those areas
were touched by the fixes, so treat it as a record of the audit rather
than as a standing guarantee.

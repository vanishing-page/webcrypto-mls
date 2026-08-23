# Random-Access Encrypted Attachments

Status: implemented, phases 1-6 completed 2026-08-21. Test vectors pinned
to draft-02 SEAL and draft-01 mls-attachments.

## Summary

This subsystem now ships; see the status line above. What follows is
the design as written, retained because the reasoning is still the
reasoning behind the code.

At design time webcrypto-mls was a pure MLS protocol library: it
encrypted application messages as single `PrivateMessage` ciphertexts
and had no concept of attachments, segmented encryption, or random
access. The goal was the property described by Germ's announcement:

> "instead of encrypting the whole audio message as a single
> ciphertext, we're using segmented encryption. That lets us play even
> partial downloads, useful when you're in poor connectivity."

This design adds an attachment subsystem that implements
`draft-sullivan-mls-attachments`: large objects (audio, images, files)
are encrypted with SEAL (the construction from `draft-sullivan-cfrg-raae`,
renamed SEAL in revision -02) using a content encryption key exported
from the MLS group. Every 64 KiB segment is independently decryptable
and verifiable, so a receiver can begin playback from a partial
download, fetch arbitrary byte ranges, and stream decryption of data
at rest.

## References

1. draft-sullivan-cfrg-raae-00 -- original raAE construction.
2. draft-sullivan-cfrg-raae-02 -- renamed SEAL; the normative base.
   NOTE: -00 and -02 are wire-incompatible (payload_info became
   binary, nonces encode finality, the accumulator became pluggable
   "snapshot authenticators"). A -03 exists (2026-07-23); swift-raae
   (the only other implementation, see below) still pins -02. This
   implementation targets -02 to match it; diff -02 against -03 before
   moving, and pin whichever revision the interop peer targets.
3. draft-sullivan-seal-concrete-00 -- cipher suites, layouts,
   snapshot instantiations, and the named instantiation
   `SEAL-attachment` that the MLS draft uses. Note the vendored
   `Spec/NOTES.md` assigns snap_id 0x0002 to the digest transcript and
   0x0003 to the epoch digest tree, which is what `SEAL-attachment`
   uses; there is no `instantiation_id` registry in the vendored spec.
4. draft-sullivan-mls-attachments-01 -- how the CEK is exported from
   MLS and how references are authenticated.
5. draft-ietf-mls-extensions -- Safe Extensions framework
   (`SafeExportSecret`, `ComponentOperationLabel`); the keying in (4)
   is defined in its terms.
6. github.com/germ-network/swift-raae -- the only public
   implementation of these drafts in any language (verified by
   GitHub/registry/mailing-list sweep, 2026-08-19). Swift, MIT,
   v0.2.0, targets raae-02. Implements both SEAL-RO-v1 and
   SEAL-RW-v1 with Appendix F JSON vectors (F1, F5, F9, F16, F17,
   F23) but NOT the mls-attachments keying. This
   library would be the first web/TypeScript implementation.
7. RFC 9605 (SFrame) -- prior art for the exporter-based keying
   pattern.
8. FLOE (ePrint 2025/2275; github.com/snowflakedb/floe and
   Snowflake-Labs/floe-specification) -- the raAE-notion sibling
   construction SEAL borrows its epoch-key structure from. Not
   wire-compatible, but its multi-language known-answer-test layout
   is the model for how we should publish our own vectors.

Cached plaintext copies of drafts 1-4 were fetched during research;
re-fetch current versions before relying on them. The drafts are
individual I-Ds, not adopted; swift-raae explicitly warns that stored
bytes are not stable across draft revisions. See "Versioning" below.

## Current state at design time (2026-08-19 audit result)

This section records the pre-implementation audit state and is now history.

* No attachment, segment, chunk, or random-access code existed in
  `src/`.
* The extension point the design required already existed:
  `src/key-schedule.ts` derives `exporterSecret` per epoch and
  implements `mlsExporter()` (RFC 9420 MLS-Exporter). It is reachable
  from `ClientState.keySchedule.exporterSecret` and via the `./*`
  subpath export, though not re-exported from `src/index.ts`.
* `src/crypto/kdf.ts` had `expandWithLabel` (needed for the CEK
  derivation) and the `Kdf` interface (HKDF over the suite hash).
* `src/crypto/hpke.ts` exposed raw AEAD with caller-supplied key,
  nonce, and AAD (`encryptAead` / `decryptAead`), plus `keyLength`
  and `nonceLength`. `cs.hash.digest` provides the hash, `cs.rng`
  provides randomness. SEAL needs nothing else from the crypto layer.

## Goals

1. Encrypt an attachment once, upload anywhere, and let any group
   member decrypt and verify any byte range without downloading the
   whole ciphertext.
2. Play partial downloads: segment `i` is decryptable as soon as the
   header region and segment `i` have arrived.
3. Stream at-rest decryption (same property applied to disk reads).
4. Whole-object integrity and writer attribution rooted in the MLS
   group's authentication, not in the storage server.
5. Browser-first: Web Crypto, WHATWG streams, no Node-only APIs.

## Non-goals

* Upload/download transport, storage, quotas, and mailbox delivery.
  Those live in the application (compare Germ's CommProtocol
  `MailboxGrant`; out of scope here).
* Rewritable objects. `SEAL-attachment` is the write-once profile
  (SEAL-RO-v1). No `RewriteSeg`.
* Padding or oblivious access. Exact plaintext length is visible.

## Acceptance criteria

Scoped ids use the slug `random-access-attachments` (abbreviated
`raa` nowhere -- always the full slug in plan documents).

### random-access-attachments.AC1: SEAL segment encryption core

- **random-access-attachments.AC1.1 Success:** Given draft
  test-vector inputs (CEK, salt, payload_info), the payload schedule
  (commitment, payload_key, snap_key, nonce_base) and each segment
  ciphertext match the vector bytes exactly.
- **random-access-attachments.AC1.2 Success:** A sealed segment
  opens only with the same index and finality flag it was sealed
  with; any other (index, finality) pair fails.
- **random-access-attachments.AC1.3 Failure:** Opening with a wrong
  CEK or wrong object_id (global associated data) fails at the
  commitment check before any AEAD operation, surfacing a single
  opaque error type.
- **random-access-attachments.AC1.4 Failure:** A modified ciphertext
  byte or tag fails to open.

### random-access-attachments.AC2: Snapshot and aligned layout

- **random-access-attachments.AC2.1 Success:** An encoded object
  verifies end-to-end: commitment, snapshot root, each epoch head,
  each leaf, each segment.
- **random-access-attachments.AC2.2 Failure:** Dropping the final
  segment, reordering two segments, substituting a same-index
  segment from another object, or altering segment bytes each cause
  verification failure.
- **random-access-attachments.AC2.3 Success:** Layout math maps any
  in-bounds plaintext (offset, length) to the exact set of encrypted
  byte ranges needed, for single-segment, exact-boundary, and
  multi-epoch object sizes; empty objects and out-of-bounds ranges
  are rejected.

### random-access-attachments.AC3: MLS keying and reference

- **random-access-attachments.AC3.1 Success:** CEK derivation from a
  ClientState is deterministic for (epoch, object_id), differs
  across object_ids and across epochs, and matches vectors frozen
  with the implementation.
- **random-access-attachments.AC3.2 Failure:** An empty object_id
  and an object_id longer than 255 octets are rejected.
- **random-access-attachments.AC3.3 Success:** AttachmentRef
  encodes and decodes round-trip; truncated or trailing-garbage
  encodings are rejected.

### random-access-attachments.AC4: Streaming writer and readers

- **random-access-attachments.AC4.1 Success:** The writer stream
  produces ciphertext byte-identical to the pure-function encoding
  of the same plaintext, and the sequential reader round-trips it to
  the original plaintext.
- **random-access-attachments.AC4.2 Success:** A range read returns
  exactly the requested plaintext bytes for arbitrary in-bounds
  (offset, length), consuming only the byte ranges reported by the
  range map.
- **random-access-attachments.AC4.3 Failure:** The reader rejects a
  snapshot that mismatches the reference, a missing needed segment,
  and a range beyond the reference's plaintext length.

### random-access-attachments.AC5: Interoperability

- **random-access-attachments.AC5.1 Success:** Vendored swift-raae
  Appendix F vectors pass in the standard node test run.
- **random-access-attachments.AC5.2 Success:** When a Swift
  toolchain is available, the interop harness round-trips the SEAL
  core in both directions (TypeScript encrypt then Swift decrypt,
  and the reverse), including epoch crossing, final-segment handling,
  and tamper rejection, under the two parameter tuples swift-raae
  implements (SEAL-RO-v1 + snap_id 0x0000 and SEAL-RW-v1 +
  snap_id 0x0001). It does not cover snap_id 0x0003; the negative
  case in the test suite will signal when upstream support lands.

### random-access-attachments.AC6: Demo

- **random-access-attachments.AC6.1 Success (human verification):**
  In the demo app, an attachment fetched progressively begins
  playback before the full ciphertext has downloaded.

## Construction

Everything below instantiates `SEAL-attachment(aead_id, kdf_id)` where
`aead_id` and `kdf_id` are the IANA code points (RFC 5116 / RFC 9180)
of the group's MLS cipher suite AEAD and KDF. Fixed parameters from
the named instantiation:

* profile: SEAL-RO-v1 (write-once)
* `segment_max`: 65536
* `nonce_mode`: derived (no per-segment nonces stored)
* `epoch_length`: 10 (2^10 = 1024 segments per SEAL epoch)
* snapshot: epoch digest tree (snap_id 0x0003)
* layout: aligned, header at offset 0, segment commitment set

"Epoch" below means the SEAL key epoch (`i >> 10`), not the MLS group
epoch, except where marked.

### Keying from MLS

Per draft-sullivan-mls-attachments-01, via the Safe Extensions
framework:

```
component_secret = SafeExportSecret(ComponentID)
CEK = ExpandWithLabel(
    component_secret,
    ComponentOperationLabel(ComponentID, "attachment"),
    object_id,
    32)
```

* `ComponentID` is the "attachment_encryption" component (IANA value
  TBD in the draft; pin when implementing).
* `SafeExportSecret` roots in an `application_export_secret`, a new
  epoch-secret sibling (label `"application_export"`) that phase 3
  adds to the key schedule. The exporter-tree walk itself lives in
  `attachment/keys.ts`, not `key-schedule.ts`, keeping the core
  library free of attachment code (layering rule 3). Labels are
  pinned to draft-ietf-mls-extensions; do not invent labels, copy
  them from the draft and lock them with test vectors.
* `object_id`: caller-supplied, 1..255 octets, unique within the MLS
  epoch, never reused across epochs. SHOULD be random (UUIDv4). It is
  used twice: as the KDF context above, and as SEAL's global
  associated data `G`, so the commitment check fails if ciphertext
  and reference disagree about the object identity.
* CEK is deterministic from (MLS epoch, object_id). The 32-octet
  random salt inside the SEAL header is therefore the only separator
  between two encryptions under one CEK -- see Security rules.

### Payload schedule (per object)

`protocol_id` is the string defined by the SEAL-attachment
instantiation in draft-sullivan-seal-concrete (pin exact value against
the draft's test vectors). `KDF` is the framed HKDF construction from
raae-02 (lp16 length-prefixed `Encode`, protocol_id as extract salt,
output length committed in the expand info).

The KDF input is seven separately lp16-framed raw fields (not a
single concatenated payload_info blob), because `sealKdf` frames each
element independently:

```
payload_fields = [
  aead_id(u16), segment_max(u32), kdf_id(u16),
  snap_id(u16), nonce_mode(u8), epoch_length(u8), salt(32)
]

commitment = KDF(pid, "commit",      [CEK], [...payload_fields, G], Nh)
payload_key= KDF(pid, "payload_key", [CEK], payload_fields,          Nk)
snap_key   = KDF(pid, "acc_key",     [CEK], payload_fields,          Nh)
nonce_base = KDF(pid, "nonce_base",  [CEK], payload_fields,          Nn)
```

(`"acc_key"` is the historical label for the snapshot key, kept for
wire compatibility.) `G = object_id`. Decryption MUST recompute the
commitment and constant-time-compare it against the stored value
before any AEAD operation; mismatch aborts.

### Per-segment encryption

```
epoch_index    = i >> 10
segment_key(i) = KDF(pid, "epoch_key", [payload_key],
                     [uint64(epoch_index)], Nk)
nonce(i)       = nonce_base[0:Nn-8] ||
                 (nonce_base[Nn-8:Nn] XOR uint64((i << 1) | is_final))
C_i            = AEAD.Seal(segment_key(i), nonce(i), aad = "", P_i)
```

Index and finality are bound through the nonce, so the AAD is empty
(when a caller supplies extra associated data it is framed with the
profile's `"SEAL-DATA"` label). Derived nonces with AES-GCM /
ChaCha20-Poly1305 are safe here only because the profile is
write-once: each nonce is used exactly once. The AEAD tag is stored
in the header's metadata table, not inline, so every ciphertext
block except the last is a full 65536 octets carrying 65536
plaintext octets; the last may be shorter.

### Snapshot authenticator (epoch digest tree)

Per-segment leaves bind the ciphertext bytes by collision resistance:

```
leaf(i)  = LH(ct_i) || tag_i   ;; LH(x) = Extract("raAE-LP-v1", x)
d_e      = KDF(pid, "snap_epoch", [snap_key],
               [LH(leaves of epoch e)], Nh)
snapshot = KDF(pid, "snap_epoch_root", [snap_key],
               [commitment, uint64(n_seg), LH(d_0 || ... || d_last)],
               Nh)
```

The snapshot binds segment count, every ciphertext byte, and the
commitment. Because leaves are hashes of ciphertext, the binding holds
even against adversaries who hold the CEK -- which every group member
does. That is what restores position commitment (no MLS AEAD is
key-committing on its own).

### Aligned layout

Header at offset 0, no prefix; first segment starts at the next
64 KiB boundary; the gap is zero-padded.

```
salt(32) | commitment(Nh) | snapshot(Nh) |
epoch heads: n_ep * Nh    |
metadata:    n_seg * (Nh + 16)   ;; leaf(i) = LH(ct_i) || tag(16)
... zero pad to 64 KiB boundary ...
seg0 | seg1 | ... | segLast
```

No per-segment nonce is stored (derived mode). Every offset is
computable from (plaintext length, cipher suite) alone:
length gives `n_seg`, `n_seg` gives `n_ep` and the header size, and
segments sit at `first_boundary + i * 65536`. This is what makes HTTP
Range requests possible without a manifest.

### Random-access read path

To read and verify one segment of a cold object:

1. Fetch the header region once (through the metadata table for the
   epochs you need); verify the commitment, then verify the snapshot
   against the value from the authenticated reference (never the
   stored copy).
2. Fetch the 48 KiB metadata run for the segment's SEAL epoch; check
   it against that epoch's head `d_e`.
3. Fetch the 64 KiB segment; check `LH(ct_i) || tag_i` against
   `leaf(i)`; then `AEAD.Open`.

About 176 KiB of reads verifies one segment of an object up to
~128 GiB (SHA-256 suites). Sequential playback amortizes steps 1-2
across all segments of an epoch, which is the partial-download
playback property.

### The attachment reference

Storage is untrusted and every member can forge a whole object
(everyone can derive the CEK). Attribution and whole-object
authenticity come only from the MLS message that announces the
attachment. New type, TLS-encoded with the existing codec layer:

```ts
interface AttachmentRef {
    version:number           // library format version, starts at 1
    objectId:Uint8Array      // 1..255 octets
    plaintextLength:bigint   // locates segments, validates ranges
    snapshot:Uint8Array      // Nh octets
    locator:Uint8Array       // application-owned (URL, mailbox, CID)
}
```

The `version` field is the library-level format tag this design's
Versioning section requires: the drafts are wire-unstable, and the
reference (already carried in signed data) is the natural place to
record which format an object was written with, so stored
attachments can be migrated when the drafts change. Decoders reject
unknown versions.

The encoded reference MUST ride in the `authenticated_data` (or the
application content) of a `PrivateMessage`, so it is covered by the
sender's signature. Receivers MUST take `snapshot` and
`plaintextLength` from this reference only. `plaintextLength` is
required in the reference because the snapshot binds segment count,
not byte length: without it the final segment's length could be
misrepresented within its 64 KiB span.

## Why not reuse crypto-stream

`/Users/nick/code/crypto-stream` already does random access: RFC 8188
ECE, independent 64 KiB AES-128-GCM records, nonce = HKDF base XOR
record index, `decryptStreamRange()` for reads, and reproducible
`encryptRecord(seq)` for record-addressable writes. In raae-02's
taxonomy it is a STREAM-family scheme, the same family as Tink
Streaming AEAD and OpenPGP v2 SEIPD. Keying one `Keychain` per
attachment from the MLS exporter would work as a quick demo.

It does not satisfy this design, though:

1. No snapshot authenticator. Nothing binds the set of records, so a
   storage server can drop trailing records (range reads cannot tell)
   and there is no O(1)-verifiable whole-object value to sign into
   the MLS reference.
2. No key commitment and no ciphertext-hash leaves, so no position
   commitment against adversarial key holders -- and in MLS every
   member holds the key. A member could equivocate about content
   without the reference detecting it.
3. No global-AAD binding of an object id; parameters (salt, record
   size) ride in an unauthenticated header.
4. Fixed AES-128-GCM / SHA-256 rather than the group's cipher suite,
   and its reproducible mode (content-digest-derived salt) is exactly
   the deterministic encryption the MLS draft's salt-freshness rule
   exists to prevent under a shared deterministic CEK.

Conclusion: implement SEAL-attachment natively. crypto-stream remains
the right tool for its own use cases (send-style transfers keyed by a
random per-transfer key), and its stream plumbing
(`slice-transformer`, range math) is a good structural reference for
the reader/writer here.

## Security rules (normative for the implementation)

1. Fresh 32-octet CSPRNG salt per object. Never re-encrypt under the
   same (object_id, salt), including crash/retry: with a
   deterministic CEK and derived nonces, reuse is two-time-pad nonce
   reuse. On retry after a partial write, draw a new salt and restart.
2. `object_id` unique within an MLS epoch, never reused across
   epochs, never empty. Receivers cannot detect reuse; this is
   encryptor discipline.
3. Verify commitment before any AEAD call; verify snapshot against
   the reference from authenticated data, never the stored copy.
   Constant-time comparisons. One opaque error to callers.
4. Confidentiality is scoped to the creating epoch's membership and
   is not forward-secret per message. Removing a member does not
   revoke access to old attachments; revocation means re-encrypting
   under a later epoch's CEK with a new object_id.
5. Enforce the per-key write budgets from the drafts; a single object
   never rolls its CEK (a bigger object is a new object).
6. For long-lived attachments, prefer the PQ cipher suites this repo
   already ships: harvest-now-decrypt-later on the group handshake
   recovers the CEK regardless of AEAD strength.
7. Zeroize CEK and derived keys when the writer/reader closes,
   matching the existing `epochSecret.fill(0)` practice.

## Layering and opt-in

Three boundaries, from coarse to fine:

1. The attachment subsystem is opt-in as a whole. Nothing is added
   to `src/index.ts` and the core message path is untouched.
   Consumers reach attachment code only through the `./*` subpath
   export map that `package.json` already defines; a consumer that
   never imports `attachment/*` ships none of it.
2. Random access itself is a property of the ciphertext format, not
   an encrypt-time option. Draft interop fixes the writer's output
   (segmented aligned layout, always); the opt-in point is the read
   side. Consumers that only stream sequentially use the plain
   reader and never import the range module. The format cost paid by
   sequential-only consumers is the per-segment metadata, about 48
   octets per 64 KiB segment (~0.07%).
3. The MLS keying stands alone. `attachment/keys` MUST NOT import
   any SEAL code, so a consumer can export a CEK and feed their own
   scheme (single-shot AEAD, crypto-stream, ...), accepting that the
   result is off-draft. This makes "MLS-keyed attachments without
   the SEAL format" a supported composition rather than an accident.

## Module layout and API sketch

New directory `src/attachment/`, exported via the existing `./*`
subpath map. Pure logic (offsets, framing, KDF inputs) split from
IO so it is Node-testable without streams.

```
src/attachment/
    keys.ts       safeExportSecret + attachment CEK derivation;
                  no imports from the rest of attachment/
    crypto.ts     the SealCrypto bundle: wrap a CiphersuiteImpl's
                  own primitives, or build standalone ones for
                  vector configurations MLS does not offer
    kdf.ts        framed Encode/lp16 KDF wrapper over cs.kdf
    schedule.ts   payload schedule, epoch keys,
                  derived nonces
    snapshot.ts   pure functions: segment leaves, epoch heads, root;
                  multiset authenticator functions
    layout.ts     header/offset math (pure; the range-request map)
    object.ts     whole-object sealObject/openObject byte-level
                  assembly and verification
    writer.ts     seal in memory, emit aligned ciphertext as bytes
                  plus a ReadableStream (see the writer note below;
                  ordered streams cannot patch an already-emitted
                  header)
    reader.ts     sequential verify-then-decrypt of a whole object
    range.ts      random-access byte-range reader (three-read path
                  above); the only module sequential consumers can
                  skip
    reference.ts  AttachmentRef TLS codec + helpers to place it in
                  authenticated_data
```

Import graph rule: `keys.ts` depends only on `key-schedule.ts`,
`crypto/`, and `codec/` (never on other `attachment/` modules
except `error.ts`); `range.ts` depends on `reader.ts` internals but never the
reverse, so the sequential path stays importable without the range
machinery. `reader.ts` and `range.ts` share snapshot verification --
sequential reads verify the same header, so the split saves the
range map and multi-stream stitching, not the crypto.

Public surface, house style:

```ts
interface EncryptedAttachment {
    readable:ReadableStream<Uint8Array>
    reference:AttachmentRef
    bytes:Uint8Array
}

function encryptAttachment (
    cek:Uint8Array,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    crypto:SealCrypto,
):Promise<EncryptedAttachment>

// sequential path (reader.ts): whole-object streaming decrypt,
// no range machinery imported. The ...ForGroup variants take
// Pick<KeySchedule, 'applicationExportSecret'> instead of a raw
// CEK and derive it via keys.ts; the writer variant also takes
// objectId, while the reader variants get it from ref.objectId.
function decryptAttachmentStream (
    cek:Uint8Array,
    ref:AttachmentRef,       // from authenticated_data, verified
    ciphertext:ReadableStream<Uint8Array>,
    crypto:SealCrypto,
):ReadableStream<Uint8Array>

// random-access path (range.ts): opt-in by import; also has a
// ...ForGroup variant
function openAttachmentRange (
    cek:Uint8Array,
    ref:AttachmentRef,       // from authenticated_data, verified
    range:{ offset:number, length:number },
    crypto:SealCrypto,
):Promise<{
    // encrypted byte ranges the caller must fetch (header region,
    // epoch metadata, the header/first-block padding gap, segments),
    // same shape as crypto-stream's decryptStreamRange
    ranges:Array<{ offset:number, length:number }>
    decrypt:(streams:ReadableStream<Uint8Array>[]) =>
        ReadableStream<Uint8Array>
}>
```

Writer note (decided during implementation planning): the header
carries a leaf digest of every segment, so its bytes are unknowable
until every segment is sealed. An ordered output stream therefore
cannot "patch the header at close" -- patching requires a
random-access sink (a file, or an uploader that accepts
out-of-order writes), which is transport-specific. The writer
consequently seals in memory (attachment-scale objects; ciphertext
size tracks plaintext size) and exposes the result both as bytes
and as a ReadableStream. The streaming win this design exists for
is on the READ side, which buffers only the header. A true
streaming writer against an out-of-order sink is a later,
transport-aware extension.

## Implementation phases

<!-- START_PHASE_1 -->
Phase 1. SEAL core, no MLS: framed KDF, payload schedule, derived
   nonces, epoch keys, segment seal/open, against the
   raae/seal-concrete Appendix test vectors. Pure functions over a
   SealCrypto bundle (AEAD, KDF, hash, RNG) wrapping the ciphersuite
   implementation.
   Done when: AC1.1-AC1.4 tests pass in the node test run.
<!-- END_PHASE_1 -->
<!-- START_PHASE_2 -->
Phase 2. Snapshot (epoch digest tree) and aligned layout math, the
   range request map, and verification logic. Property tests:
   drop/reorder/substitute/truncate any segment and the right check
   fails at the right stage.
   Done when: AC2.1-AC2.3 tests pass in the node test run.
<!-- END_PHASE_2 -->
<!-- START_PHASE_3 -->
Phase 3. MLS keying: `safeExportSecret` (labels pinned to
   draft-ietf-mls-extensions), CEK derivation, `AttachmentRef`
   codec and authenticated_data helpers.
   Done when: AC3.1-AC3.3 tests pass in the node test run.
<!-- END_PHASE_3 -->
<!-- START_PHASE_4 -->
Phase 4. Streams: writer and range reader on WHATWG streams;
   browser test via the existing test rig.
   Done when: AC4.1-AC4.3 tests pass in the node test run.
<!-- END_PHASE_4 -->
<!-- START_PHASE_5 -->
Phase 5. Interop, two tiers. Note the peer is swift-raae;
   autonomous-comm-protocol is the identity/mailbox layer and
   contains no SEAL code.
   Tier 1, always-on: swift-raae ships machine-readable JSON
   vectors (`Tests/RAAETests/Vectors/F*.json`, sourced from the
   draft's Appendix F) that include every intermediate --
   payload_info fields, commitment, payload_key, per-segment
   values. Vendor them under `test_vectors/` and assert against
   them in the normal `npm test` run. No Swift toolchain needed.
   Tier 2, live round-trip: swift-raae has no CLI, so add a small
   SPM executable wrapper (JSON config on stdin, ciphertext on
   stdout and the reverse) in a test fixture, and a CI job (macOS
   or Linux runner with Swift 6) that round-trips both directions:
   TS encrypt then Swift decrypt, Swift encrypt then TS decrypt,
   including epoch crossing, final-segment handling, and tamper
   rejection. Range reads are not tested because swift-raae does not
   implement snap_id 0x0003. Skip the job when no `swift` binary is
   present. swift-crypto provides AES-GCM, ChaCha20-Poly1305, and
   AES-GCM-SIV, so both MLS AEAD families are coverable.
   Interop covers the SEAL layer only: swift-raae does not
   implement the MLS keying, and the mls-attachments draft has no
   vectors yet, so the CEK-derivation layer is guarded by our own
   frozen vectors until the draft publishes some.
   Done when: AC5.1 passes in the node test run; AC5.2 passes in
   the gated CI job (verified locally when a Swift toolchain is
   present).
<!-- END_PHASE_5 -->
<!-- START_PHASE_6 -->
Phase 6. Demo: voice-note-style playback of a partial download in
   one of the example apps (feed progressively decrypted segments
   to an `AudioContext`), plus a seek control that plays from an
   arbitrary position via the range reader so the headline
   random-access path is exercised in the demo.
   Done when: AC6.1 verified by a human; demo builds cleanly.
<!-- END_PHASE_6 -->

AC ids above abbreviate the scoped form; each `ACn.m` reads as
`random-access-attachments.ACn.m` per the Acceptance criteria
section.

## Versioning and open questions

* The drafts are pre-adoption and wire-unstable (-00 to -02 already
  broke compatibility; swift-raae says stored bytes are not stable
  across revisions). Version-tag our output (e.g. a library-level
  format byte outside the SEAL header) so stored attachments can be
  migrated when the drafts change.
* Pinned during implementation, from draft text and vectors: the
  SEAL-attachment `protocol_id` string, the `attachment_encryption`
  ComponentID value, and the exact `SafeExportSecret` /
  `ComponentOperationLabel` constructions. The `protocol_id` question
  is settled: swift-raae's vectors use the profile name as
  `protocol_id`, and `PROTOCOL_RO` is `"SEAL-RO-v1"`. See the SEAL
  Profile and snap_id Conformance limitation below for why that
  pairing is the conformant one.
* draft-sullivan-mls-attachments-01 defines no test vectors yet;
  until it does, interop with swift-raae is the ground truth for the
  SEAL layer and our own vectors cover the MLS keying.
* Cross-sender ordering of attachment references within an MLS epoch
  is application policy (the draft provides none); revisit if the
  demo needs "current object" semantics.
* Since this would be the first web implementation, publish our own
  known-answer-test files (FLOE-specification style) so future
  implementations can interop-test against us, not only against
  swift-raae.
* Phoenix R&D (Raphael Robert co-authors mls-attachments; their
  `phnx-im/air` app still encrypts attachments as whole-blob
  AES-GCM per draft-robert-mimi-attachments) is the most likely
  future Rust interop peer -- worth contact once phase 1-2 vectors
  pass.

## Known Limitations

This implementation has four known limitations that the operator should
understand before deploying in production. In the order they appear
below: epoch retention, ComponentID and derivation-version threading,
full-object buffering, and the SEAL profile tuple. The third is a
memory-efficiency tradeoff; the others are design decisions that do
not affect correctness for a single deployment but require explicit
handling in any system spanning multiple implementations or
versions.

### Epoch Retention and CEK Recovery

**Location:** `src/client-state.ts:1284-1295` (`addHistoricalReceiverData`)

This implementation deliberately does not retain `applicationExportSecret`
when advancing epochs, while retaining `senderDataSecret` and
`resumptionPsk`. Therefore, when a receiver advances to a new epoch,
the CEK for every attachment object encrypted in the prior epoch
becomes permanently unrecoverable. This is an asymmetry: other secrets
survive `retainKeysForEpochs` (default 4), but `applicationExportSecret`
survives zero epochs, and raising that config does not help.

**Implication:** If your deployment needs to access old attachments
after epoch advance, this implementation cannot support that today.

### ComponentID Selection and Derivation Version Threading

**Location:** `src/attachment/keys.ts:11-22` (NOTE describing the limitation)
and `src/attachment/keys.ts:123` (per-call ComponentID override)

This implementation assumes a 16-bit ComponentID
(draft-ietf-mls-extensions-09) and derives keys using a fixed 16-level
exporter tree. The code itself flags the limitation (`keys.ts:21`):
"attachmentCek must be extended with version threading to support old
derivations" if either ComponentID width or tree depth changes in a future
draft. The `AttachmentRef` carries a version field that versions the wire
format of the reference itself, but does not version the derivation
parameters. If the draft changes these parameters, all previously derived
CEKs become unrecoverable, and the version field on the reference cannot
detect the mismatch.

**Implication:** If draft-ietf-mls-extensions or draft-sullivan-mls-attachments
update these parameters, this implementation must be re-pinned and the CEK
derivation re-verified against any new vectors. Cross-version interop is
not supported.

### Full-Object Buffering on Read

**Location:** `src/attachment/range.ts` (metadata buffer) and
`src/attachment/reader.ts` (the header read loop in `start()`)

The sequential reader buffers the entire header before emitting
decrypted bytes. The range reader allocates a full-object-sized
metadata buffer but populates only the epoch runs it fetches, so the
allocation cost below is real for both while the fetch cost is not.

For a 128 GiB object (2,097,152
segments at 64 KiB each), even reading 10 bytes allocates about 96 MiB
of metadata on SHA-256 suites and about 160 MiB on SHA-512 suites.
`layout.ts` sets `metaLen = nh + META_TAG_LENGTH` with
`META_TAG_LENGTH = 16`, so a segment costs 48 bytes at nh=32 and 80
bytes at nh=64; 2,097,152 segments times those is 96 MiB and 160 MiB
respectively. The sequential reader allocates the full header before
playback begins. This is a whole-subsystem property: both paths buffer
their entire working set upfront for early verification and early exit
on corruption, prioritizing correctness over memory efficiency on first
access.

**Implication:** Readers on very large objects in memory-constrained
environments must account for this buffering cost. Note that lazy
per-epoch fetch and verify already ships: `rangesFor` in `layout.ts`
emits metadata ranges only for the epochs a read touches, and `range.ts`
extracts and verifies only those runs. What remains is the allocation,
not the fetching -- the metadata buffer is sized for the whole object
even though only the touched epochs are populated.

### SEAL Profile and snap_id Conformance

**Location:** `src/attachment/schedule.ts` (constants `PROTOCOL_RO` and
`SNAP_EPOCH_TREE`)

This implementation encrypts objects under `protocolId="SEAL-RO-v1"` paired with
`snap_id=0x0003` (epoch digest tree). Swift-raae (the only other public raae-02
implementation) rejects this tuple with `ScheduleError.unsupportedSnapID`
(`KeySchedule.swift:135-136`), but this is an upstream implementation gap, not
a verdict on the tuple's conformance.

The conformance evidence is in swift-raae's own vendor bundle:

1. **Draft-02 defines SEAL-attachment with snap_id 0x0003:**
   `Spec/NOTES.md:139-145` records that draft-02 adds a new `SEAL-attachment`
   instantiation (distinct from the renamed `SEAL-simple`) specified as RO-v1,
   aligned layout, epoch-digest-tree authenticator, and snap_id 0x0003.
   `Spec/SOURCE.md:40-46` confirms this is an instantiation (a named binding)
   rather than a protocol_id. That is exactly this implementation's tuple.

2. **snap_id 0x0003 is normative, not implemented by swift-raae:**
   `Spec/NOTES.md:86-89` notes that draft-02 adds snap_id 0x0002 and 0x0003
   but marks them "not implemented; all unsupported values are rejected".
   swift-raae's `KeySchedule.swift:135-136` checks `isKnownSnapID` and rejects
   unknown values, treating our conformant 0x0003 as unsupported.

**Implication:** The protocol_id in every KDF label appears in Extract salt and
all key/nonce derivation (see Section 4.4). The tuple is conformant per
draft-02, and our choice of `SEAL-RO-v1` is the right one for the epoch digest
tree instantiation. Cross-implementation testing with swift-raae is not yet
possible, because swift-raae's support for this instantiation is currently
pending (tracked as a known gap in the interop test design).

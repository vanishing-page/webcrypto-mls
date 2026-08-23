# FDR-003: Sealed Attachments

**Status:** Active
**Last reviewed:** 2026-08-21

## Overview

Sealed random-access attachments keyed from an MLS epoch. Users
encrypt attachments with a commitment ephemeral to that epoch, stream
them to storage, and later decrypt specific byte ranges without
fetching the whole object. An AttachmentRef carries the parameters
needed to verify and decrypt, and is intended to ride inside MLS
authenticated_data.

The audience is someone who wants to send a large file through an MLS
group, verify it has not been tampered with at the segment level, and
decrypt ranges on demand.

## Behavior

The feature provides three operations:

### Sealing

`sealObject` encrypts a whole plaintext under a content encryption
key (CEK) derived from an epoch secret, object id, and component id.
The output is an opaque sealed object: an authenticated header
containing integrity metadata and epoch information, followed by
64 KiB segments (`SEGMENT_MAX`, 65536 bytes; the final one may be
shorter), each carrying an authenticated tag.

The header holds a salt, a key commitment, the snapshot root, one
epoch head per epoch, and a per-segment metadata table of
`lh(ciphertext) || tag` entries. That table is what makes the header
large on big objects. The header does not record the plaintext
length: that arrives from the `AttachmentRef` and is what the reader
uses to compute the layout. The snapshot root is the epoch digest
tree's root, not a separate structure alongside it.

Sealing buffers the entire object in memory before writing, so the
plaintext length must be known upfront and the object cannot exceed
available RAM.

### Sequential reading

`decryptAttachmentStream` (`src/attachment/reader.ts`) opens a
sequential reader over a sealed object stored elsewhere (S3, a file,
etc.). The caller provides an AttachmentRef plus the sealed bytes as
a ReadableStream. The reader verifies the header
and emits plaintext, one chunk at a time, validating each segment's
tag before yielding its bytes.

The reader buffers the full header before emitting anything. For a
128 GiB object that header is about 96 MiB on SHA-256 suites and about
160 MiB on SHA-512, since `layout.ts` sets
`metaLen = nh + META_TAG_LENGTH` with `META_TAG_LENGTH = 16` -- 48
bytes per segment at nh=32, 80 at nh=64, across 2,097,152 segments.
Small ranges and large objects mean large buffers.

### Range reads

`openAttachmentRange` (`src/attachment/range.ts`) opens a range read
at a specific byte offset.
Instead of streaming from the start, it seeks to the first segment
containing the requested bytes, fetches and validates only those
segments, and yields the requested range. The rest of the plaintext
is never read.

Like the sequential reader, it validates the header first, allocating
for all segment metadata up front.

### AttachmentRef

The sealed object has its own id, plaintext length, and snapshot tree
root. An AttachmentRef packages these as a lightweight, authenticatable
pointer. It is signed by the sender (because it rides in authenticated
data) and carries a format version so decoders can recognize future
changes.

AttachmentRef contains no epoch information, so a range read keyed to
the wrong epoch is indistinguishable from tampering. The sender must
convey the epoch separately, or the application must enforce it from
the MLS message itself.

## Design Decisions

### 1. Read paths are separate

**Decision:** Sequential and range reads are two loops over shared
helpers, not one implementation with branching. `range.ts` imports
`parsePrefix`, `verifyRoot`, `verifyEpochRun` and `openBlock` from
`reader.ts`, so header parsing and per-segment verify-and-decrypt are
shared; only the driving loop differs. That dependency runs one way and
is enforced by the layering check in
`scripts/check-attachment-invariants.mjs`.

**Why:** Sequential reads need to emit plaintext as it arrives and
must not buffer more than one segment. Range reads need to seek and
may skip millions of bytes. The two have different memory profiles
and different error handling (an offset out of bounds is a validation
error for ranges, a benign EOF for sequential). Separate implementations
keep each path honest about its own costs.

**Tradeoff:** The duplication that matters is not between sequential
and range reads, which share `openBlock`. It is between the two
whole-object paths, `openObject` and `decryptAttachmentStream`, which
verify independently. That is what `test/attachment/parity.ts` guards,
mutating a sealed object at offsets covering every region of the layout
and asserting both paths return the same verdict. There is no
sequential-versus-range differential test, because there is no
independent segment verification between them to diverge.

### 2. Header buffering is up front

**Decision:** Both readers allocate space for the entire metadata
table (every segment's hash and tag) before emitting any plaintext.

**Why:** The metadata tells you how many segments there are and where
boundaries lie. You cannot validate a segment without it, and you
cannot know if you have reached the end without counting them. Streaming
the metadata gradually would require either re-reading it per segment
or trusting size claims in the data itself, both worse. Allocating at
the start makes the cost visible and deterministic.

**Tradeoff:** For a 128 GiB object, the header alone is about 96 MiB on
SHA-256 suites and about 160 MiB on SHA-512. Range reads pay this cost
even if they need only the first kilobyte.
The cost is load-bearing: removing it would require redesign.

### 3. Keys are per epoch; at the AEAD layer the nonce alone separates segments

**Decision:** One CEK per attachment, derived per (epoch, objectId) by
`attachmentCek`. Beneath it, `segmentKey` derives an AEAD key per
epoch, not per segment: it computes `epochIndex = index >> epochLength`
and keys off that alone, so with `epochLength = 10` one key covers
1024 segments.

**Why:** At the AEAD layer, what separates one segment from another is
not the key and is not the AAD. It is the nonce, derived from
`(index << 1) | isFinal`.
`segmentAad` returns an empty AAD in derived mode when no extra AAD is
supplied, and no caller in this subsystem supplies any, so the shipped
AEAD AAD is the empty string. The index-and-final-bit AAD encoding in
`segmentAad` is the random-nonce branch, which this subsystem does not
use. Per-epoch keying keeps derivations bounded while staying far
inside the AEAD budget -- `layout.ts` notes 1024 invocations per key
against the drafts' 2^32 GCM bound.

**Tradeoff:** A key shared across 1024 segments means compromise of one
epoch key exposes that epoch's segments rather than one.

Be careful about what the empty AAD does and does not imply. At the
AEAD layer the nonce is the only thing separating one segment from
another. It is not the only position binding in the system: the object
layer binds position independently, because `openBlock` recomputes the
leaf and compares it against the one stored at `index * metaLen`,
`epochHead` folds each epoch's leaf run in order, and the root is
recomputed over the epoch heads and checked against the reference
snapshot on every open. Reorder two segments
and that chain rejects it: the reorder case in
`test/attachment/parity.ts` asserts exactly that, and its comment
records that a length check structurally cannot see a swap of two
equal-size segments. A dropped segment is caught earlier still, by the
total-length check in `object.ts`, so the drop case in the same file is
not evidence for the chain.

`openObject` inlines the root recomputation and the leaf comparison
rather than calling `verifyRoot` and `openBlock`, which are the
reader's names for the same work. Replacing the derived
nonce would remove the AEAD-layer separation and leave the digest tree
as the sole position binder.

### 4. The writer is in-memory

**Decision:** `sealObject` buffers the whole plaintext before producing
ciphertext. There is no streaming writer.

**Why:** The snapshot root is computed over ciphertext leaves, one
segment at a time, so a streaming writer would not need to retain the
earlier plaintext -- `sealObject` already seals, writes and hashes each
segment in a single pass.

What forces an output buffer is the layout. The salt and commitment
are known before the first segment is sealed, but the snapshot and the
epoch heads that follow them are not, so the header cannot be emitted
first by an ordered sink, and patching it at close requires a
random-access sink rather than a stream. Buffering the plaintext input
as well is a separate API choice. The alternative is asking the caller to
supply a precomputed root.

Asking the caller to provide a precomputed root means they either
buffer the file themselves or fail with garbage in the tree. In-memory
buffering puts the cost in the library where it is visible.

**Tradeoff:** Attachments cannot exceed available RAM. The feature is
unsuitable for very large files or memory-constrained platforms.

### 5. The reference carries no epoch

**Decision:** AttachmentRef contains version, objectId, plaintextLength,
snapshot, and locator, but not an epoch.

**Why:** The epoch is protocol state, and the reference is data carried
inside the protocol. Encoding the epoch into the ref would tie storage
to message timing: an application that wanted to save and re-send a
reference would have to track which epoch it belongs to separately, or
trust the receiver's epoch and risk decrypting with the wrong key.

Instead, the epoch context comes from the message carrying the ref. If
the message is an application message in epoch N, the ref is for epoch N.

**Tradeoff:** A reference detached from its message (persisted, forwarded
via a second channel, etc.) loses epoch context. Decrypting with a wrong
epoch is indistinguishable from tampering. The application must carry
the message or the epoch alongside the ref, or replay protection is lost.

### 6. The snapshot tree is versioned with snap_id 0x0003

**Decision:** The snapshot root is computed over SEAL using snap_id
0x0003, the epoch digest tree variant from draft-sullivan-cfrg-raae-02.

**Why:** This provides segment-level tampering detection. If any byte in
any segment is flipped, the changed segment's hash changes, cascading
through the tree. The epoch digest tree also protects against dropping
or reordering segments within the same epoch.

Swift-raae does not implement snap_id 0x0003, so this choice is not
exercised by cross-implementation testing. It is the documented
conformant choice per draft-02; the gap is an upstream implementation
limit, not a design question.

**Tradeoff:** No interop coverage of the epoch digest tree, so drop,
reorder, substitute and stored-metadata tampering have no
cross-implementation test. Per-segment tampering is covered:
`scripts/interop-seal.ts` runs a cross-implementation tamper case that
flips a ciphertext byte and fails the run if either side accepts it.
The AEAD tag catches that independently of snap_id.

### 7. The CEK is derived from epoch secret, not from persistent state

**Decision:** The CEK comes from `applicationExportSecret`, a fresh
export from the epoch secret, not from `KeySchedule` state carried
into historical receiver data.

**Why:** `client-state.ts` deliberately does not retain
`applicationExportSecret` in historical receiver data. The comment
there says so and points at the design plan's Known Limitations.

Be precise about the consequence, because it is stronger than it
sounds: after any epoch advance, no member can re-derive a
prior-epoch CEK -- not even one who was in the group when the
attachment was sealed and who could read it at the time. The
restriction is not about when a member joined. Attachments sealed in
an epoch become undecryptable to everyone once that epoch passes,
unless the application retains the CEK itself.

Note also that `applicationExportSecret` is a `KeySchedule` field; the
decision is that it is not carried into historical receiver data, not
that it comes from somewhere other than the key schedule.

**Tradeoff:** An application that wants different semantics (e.g.,
attachments are encrypted to the group, not to one epoch) would need to
manage CEKs outside the library.

## Related

- **ADRs:** ADR-002 (Attachment subsystem architecture)
- **Specs:** RAAE (draft-sullivan-cfrg-raae-02), SEAL
  (draft-sullivan-seal-concrete-00), Attachments
  (draft-sullivan-mls-attachments-01)
- **Design plan:**
  `docs/design-plans/2026-08-19-random-access-attachments.md`

## Open Questions

1. **Reference placement:** The AttachmentRef is designed to travel in
   authenticated_data, but no test demonstrates this end to end. The
   feature works in isolation; integration with a real PrivateMessage
   is untested.

2. **Epoch context:** Attachments are keyed to an MLS epoch, but
   creating an epoch requires a real MLS group. The test harness
   initializes attachments with a random epoch secret, not through the
   MLS key schedule. The phase-3 MLS keying path is not exercised end
   to end.

3. **Cross-implementation coverage:** Swift-raae does not implement
   snap_id 0x0003. The epoch digest tree mechanism, which is the main
   segment-level integrity protection, has no interop test. An
   implementation that does not support 0x0003 cannot decrypt these
   objects.

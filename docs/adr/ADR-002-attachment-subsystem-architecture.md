# ADR-002: Attachment Subsystem Architecture

**Date:** 2026-08-21

## Context

This library implements MLS (RFC 9420) for group messaging. A new
subsystem adds sealed random-access attachments keyed from an MLS
epoch, using a streaming reader and a range reader over an in-memory
writer, and an AttachmentRef intended to ride in
authenticated_data. That placement is a requirement of the design,
not yet demonstrated end to end; see FDR-003's open questions.

The attachment subsystem must choose several wire-visible values that
cannot change without breaking interoperability. It also buffers the
full object, a cost that shapes usage.

## Decision

The attachment subsystem is built on three architectural choices:

### 1. Component ID 0xF001

The exporter tree in draft-ietf-mls-extensions-09 requires a
16-bit component_id to namespace the export. The IANA value in
draft-sullivan-mls-attachments is not yet allocated. Until it is,
this implementation uses 0xF001, a provisional private-use value.

This is wire-breaking: an IANA assignment would change every derived
CEK, so every attachment secret depends on this constant. The value
is held provisionally and must be replaced when IANA assigns one.

### 2. SEAL-RO-v1 + snap_id 0x0003

The object is encrypted under the SEAL authenticated encryption
scheme (draft-sullivan-seal-concrete-00), in read-only mode
(SEAL-RO-v1). The snapshot tree is versioned using snap_id 0x0003,
the epoch digest tree variant from draft-sullivan-cfrg-raae-02.

This pairing is the conformant SEAL-attachment instantiation per
draft-02. Swift-raae does not implement snap_id 0x0003 and therefore
rejects this profile on interop testing; the rejection reflects an
upstream implementation gap rather than a verdict on the tuple itself.

The consequence is that no cross-implementation coverage exists for
the epoch digest tree, which is the mechanism resisting drop, reorder
and substitution. Per-segment byte tampering is caught by the AEAD tag
independently, and the interop harness does cover that.

### 3. In-memory writer and header buffer

`sealObject` buffers the whole object before writing, and
`decryptAttachmentStream` buffers the full header before emitting
bytes. The header includes the entire metadata table for all segments.

For a 128 GiB object at 64 KiB segments (2,097,152 segments), the
header is about 96 MiB on SHA-256 suites and about 160 MiB on
SHA-512. Per-segment metadata is `nh + META_TAG_LENGTH` with
`META_TAG_LENGTH = 16`, so 48 bytes at nh=32 and 80 bytes at nh=64.
This is a deliberate accepted cost.

## Consequences

The component_id is stable. Changing it would require versioning
support in the library (tracked as a NOTE in
`src/attachment/keys.ts:16-22`), which does not currently exist. Until
then, this constant locks every attachment secret to this
implementation.

The SEAL profile tuple is the designed conformant choice. Swift-raae's
inability to test it means the epoch digest tree has no
cross-implementation verification, so drop, reorder, substitute and
stored-metadata tampering are untested across implementations.
Per-segment tampering IS tested there: the interop tamper case flips a
ciphertext byte and fails if either side accepts it, which the AEAD tag
catches independently of snap_id.

The in-memory writer means attachments cannot exceed the host's memory,
and the header buffer means even small reads must allocate for all
segments. Streaming or chunked writes are not supported. The buffering
simplifies the implementation and the verification story at the cost of
memory efficiency.

Every attachment secret depends on both the component_id and the SEAL
profile tuple. Changing either is wire-breaking. The epoch digest tree
gap must be closed in the upstream before cross-implementation
confidence can be claimed.

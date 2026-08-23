# Test Requirements: Random-Access Attachments

Scope: `docs/design-plans/2026-08-19-random-access-attachments.md`,
phases 1-6. Every acceptance criterion in that design's "Acceptance
criteria" section maps below to either an automated test or a
documented human verification. Ids are the scoped form
`random-access-attachments.ACn.m`; the phase files abbreviate them to
`ACn.m` and this document does the same after the first mention in
each section.

Written: 2026-08-19. Rationalized against the implementation
decisions recorded in `phase_01.md` through `phase_06.md`.

## Conventions this document assumes

1. Every automated test is a `@substrate-system/tapzero` file under
   `test/`, registered by a top-level `import './...js'` line in
   `test/unit.ts`. A test file that is not registered there does not
   run; adding the import is part of the task that adds the file.
2. `npm run test:unit` bundles `test/unit.ts` with esbuild and runs
   it under node. It runs no structural gate. `npm run test:node` is
   the full entry and, from phase 4 onward, runs
   `node scripts/check-attachment-invariants.mjs` first, so a layering
   or vector-inventory violation fails that command before any test
   executes. `npm run test:unit` is not that command, so running the
   unit suite alone proves nothing about the gates. In CI the gates
   run as their own `checks` job (`npm run test:checks`), which is
   what makes a violation fail the build on every push; the CI test
   matrix runs `test:unit` and `test:matrix` and does not run them.
3. `npm run test:browser` runs the same bundle in a browser. Phase 4
   is the phase that must run it, because streams are the code most
   sensitive to platform differences.
4. Test types used below:
   - unit: single module, pure or near-pure, no cross-layer wiring.
   - integration: several attachment modules wired together in one
     process (still a tapzero file registered in `test/unit.ts`).
   - e2e: crosses a process boundary into another implementation
     (the Swift CLI), run by a separate npm script.
5. Test vectors are data, not tests. Vendored swift-raae vectors live
   under `test_vectors/seal/core/` and `test_vectors/seal/engine/`
   and are never edited. Vectors we generate ourselves live under
   `test_vectors/seal/own/`, are produced by
   `scripts/generate-seal-own-vectors.ts`, and are byte-identical on
   re-run; changing them is a conscious re-freeze.
6. No test asserts on rendered HTML text (repo rule). Demo coverage
   is structural (routing, nav, pure audio math) plus human
   verification of the audible behavior.

## Automated coverage

### random-access-attachments.AC1: SEAL segment encryption core

Implemented in phase 1. Vector loading helpers live in
`test/attachment/helpers.ts` (`fromHex`, `toHex`,
`paramsFromVector`, `sealCryptoFromVector`); that file is support
code, not a registered test.

**AC1.1** -- payload schedule and segment ciphertexts match the
draft vectors byte for byte.

- Type: unit (vector-driven).
- File: `test/attachment/seal-core.ts`.
- Data: every JSON file under `test_vectors/seal/core/`, imported
  statically (esbuild JSON imports; no directory reads inside the
  bundle).
- Assertions: for each vector, `startSeal` with the vector's CEK,
  `payload_info` and G, then hex-compare `commitment`, `payloadKey`,
  `snapKey`, and `nonceBase` (the last only for derived-mode
  vectors). Then, per segment entry, `sealSegment` and hex-compare
  ciphertext and tag, and `openSegment` back to the vector
  plaintext. Random-mode vectors pass their stored nonce.
- Second file: `test/attachment/snapshot.ts` (phase 2) completes
  AC1.1 for the engine vectors' multiset snapshot fields.
- Third file: `test/attachment/vectors-all.ts` (phase 5) sweeps all
  vendored files including any field the targeted tests skip; see
  AC5.1.
- Note: the commitment framing is pinned by vector F1 during phase 1
  task 4 (a throwaway probe, deleted before commit). The probe is
  not a test; AC1.1's assertion in `seal-core.ts` is what locks the
  chosen framing permanently.

**AC1.2** -- a sealed segment opens only under its own (index,
finality) pair.

- Type: unit.
- File: `test/attachment/seal-core.ts`.
- Assertions: with a locally built derived-mode `SealParams`
  (SEAL-RO-v1, `NONCE_DERIVED`, epoch_length 10, snap_id 0x0003,
  random 32-octet salt), seal at index 3n non-final; assert
  `openSegment` succeeds at (3n, non-final) and rejects at
  (4n, non-final) and at (3n, final). Rejections assert
  `err instanceof AttachmentError`.

**AC1.3** -- wrong CEK or wrong object_id fails at the commitment
check, before any AEAD operation, with one opaque error.

- Type: unit.
- File: `test/attachment/seal-core.ts`.
- Assertions: `startOpen` with one CEK byte flipped rejects;
  `startOpen` with a different G rejects; both throw
  `AttachmentError` and nothing more specific.
- Ordering sub-claim: "before any AEAD operation" is not observable
  from the error alone. Cover it by passing a sentinel
  `SealCrypto` bundle whose `aead.encrypt`/`aead.decrypt` throw a
  distinct non-`AttachmentError` error, and asserting `startOpen`
  still rejects with `AttachmentError`. `SealCrypto` is a plain
  record, so this needs no mocking framework. If that assertion is
  omitted, the sub-claim falls back to code review of
  `deriveSchedule`/`startOpen` (which import no aead path) and must
  be recorded as a review checkpoint rather than silently dropped.

**AC1.4** -- modified ciphertext or tag fails to open.

- Type: unit.
- File: `test/attachment/seal-core.ts`.
- Assertions: flip one ciphertext byte, `openSegment` rejects; flip
  one tag byte, `openSegment` rejects; both `AttachmentError`.

**Supporting (not an AC):** `wipeSealState` leaves `payloadKey`,
`snapKey`, and `nonceBase` all zero. File
`test/attachment/seal-core.ts`. Design security rule 7. The wiring
of that call into the object, reader, and range paths is enforced
mechanically by the phase 4 gate's `grep -q wipeSealState` loop over
`src/attachment/{reader,range,object}.ts`.

### random-access-attachments.AC2: Snapshot and aligned layout

Implemented in phase 2.

**AC2.1** -- an encoded object verifies end to end.

- Type: integration (schedule + snapshot + layout + object).
- File: `test/attachment/object.ts`.
- Fixtures: `sealCryptoFromIds(2, 1)` (AES-256-GCM +
  HKDF-SHA-256), fixed 32-octet salt, fixed CEK, objectId
  `ascii('test-object')`, plaintext of `(2 * 65536) + 17` counter
  bytes (three segments: two full blocks plus a 17-byte final
  block).
- Assertions: `sealObject` then `openObject` with the returned
  snapshot and the correct plaintext length round-trips to the
  identical plaintext; `bytes.length` equals `layout(...).totalSize`.
- Regression lock: a frozen-vector case in the same file compares
  commitment hex, snapshot hex, and the full-object digest against
  `test_vectors/seal/own/epoch-tree.json`. This exists because the
  epoch digest tree (snap_id 0x0003) has no external vectors yet, so
  our own frozen bytes are the only defense against a silent format
  drift. The generator is
  `scripts/generate-seal-own-vectors.ts`; the field documentation
  for external implementers is `test_vectors/seal/own/README.md`.
- Type-adjacent unit coverage: `test/attachment/snapshot.ts` asserts
  the multiset (snap_id 0x0001) contributions, snapshot, and masked
  accumulator against whichever engine vectors carry those fields.
  Conditional decision already made in phase 2 task 4: if no
  vendored vector carries multiset snapshot fields at all, the
  multiset section is deleted from `src/attachment/snapshot.ts` and
  from the test in the same commit. Untestable code does not ship.

**AC2.2** -- drop, reorder, substitute, or alter and verification
fails.

- Type: integration.
- File: `test/attachment/object.ts`.
- Cases, each asserting `AttachmentError`:
  1. drop final block (shortened buffer, original ref) -- rejected
     by the length check;
  2. full length but final block zeroed -- rejected by leaf
     mismatch;
  3. blocks 0 and 1 swapped in place;
  4. cross-object substitution: seal a second object differing only
     in salt, copy its block 1 over block 1 of the first;
  5. one flipped byte in a block;
  6. one flipped byte in a metadata leaf;
  7. one flipped byte in an epoch head;
  8. one flipped byte in the stored snapshot field;
  9. one flipped byte in `ref.snapshot` while the object is intact
     (proves the ref, not the stored copy, is authoritative).

**AC2.3** -- layout math maps in-bounds ranges exactly; empty
objects and out-of-bounds ranges rejected.

- Type: unit (pure math, no crypto).
- File: `test/attachment/layout.ts`.
- Sizes: 1 byte; exactly 65536; 65537 (boundary); a multi-epoch size
  such as `65536 * 1025 + 5` (nSeg 1026, nEp 2). Expectations are
  hand-derived from the header formula, never read back from the
  implementation.
- Cheap multi-epoch cases additionally use synthetic
  `LayoutParams` (segmentMax 64, epochLength 2, nh 32) alongside the
  real 65536/10 constants.
- `rangesFor` assertions: exact equality with hand-computed range
  lists for cross-segment and cross-epoch spans; the returned list
  is sorted, non-overlapping, and coalesced; it always includes the
  fixed prefix plus the complete epoch-heads region as range 0.
- Rejections (`AttachmentError`): `layout` on plaintextLength 0 and
  negative; `rangesFor` on zero length, negative offset, and
  `offset + length` past the end.

### random-access-attachments.AC3: MLS keying and reference

Implemented in phase 3. Note the ordering constraint recorded in
that phase: the frozen vectors (task 4) are generated BEFORE the
tests that import them (task 5), because a missing JSON import is an
esbuild bundle error that fails the entire unit suite, not just the
new file.

**AC3.1** -- CEK derivation is deterministic per (epoch, object_id),
separated across object_ids and epochs, and matches frozen vectors.

- Type: unit.
- File: `test/attachment/keys.ts`.
- Setup: build key schedules directly with
  `initializeKeySchedule(epochSecret.slice(), kdf)`; no group
  construction. Pass a copy, since that function zeroizes its input.
- Assertions:
  - determinism: same (epochSecret, objectId) twice gives identical
    CEK bytes;
  - separation: a different objectId, a different epochSecret
    (standing in for another epoch), and a different componentId
    each give a different CEK;
  - frozen: `test_vectors/seal/own/keys.json` pins
    `application_export_secret`, `component_secret`, and `cek` hex
    for fixed inputs (epochSecret 32 x 0x42, objectId
    `ascii('own-vector')`, componentId 0xF001). This layer has no
    draft vectors: mls-attachments-01 publishes none, and swift-raae
    does not implement the MLS keying, so our own frozen file is the
    only ground truth until the draft ships vectors.
  - old-state guard: a `Pick<KeySchedule, 'applicationExportSecret'>`
    whose field is `undefined` (a persisted state predating phase 3)
    rejects with `AttachmentError` rather than deriving from
    undefined.
- Prerequisite regression: `src/key-schedule.ts` gains
  `applicationExportSecret`. The existing key-schedule vector tests
  (`test/key-schedule.ts`, `test/test-vectors/key-schedule.ts`) must
  still pass unchanged, and `npm run test:fast` must pass, because
  the new sibling derivation must not perturb any existing output.
  That is a regression requirement on existing tests, not a new
  test.
- Provisional constant: `ATTACHMENT_COMPONENT_ID` is 0xF001
  (private use) until IANA allocates. When the allocation lands, the
  constant changes and `test_vectors/seal/own/keys.json` is
  regenerated; the frozen test failing at that moment is the
  intended signal, not a defect.

**AC3.2** -- empty and oversize object_ids are rejected.

- Type: unit.
- File: `test/attachment/keys.ts`.
- Assertions: `attachmentCek` with a 0-octet objectId rejects; with
  a 256-octet objectId rejects; both `AttachmentError`.

**AC3.3** -- AttachmentRef round-trips; truncated or trailing-garbage
encodings are rejected.

- Type: unit.
- File: `test/attachment/reference.ts`.
- Assertions:
  - round-trip: `encodeAttachmentRef` then `decodeAttachmentRef`
    returns field-equal values, with `plaintextLength` preserved as
    a bigint; `refToAuthData` then
    `refFromAuthData` round-trips likewise;
  - truncated: drop the last byte, decode rejects;
  - trailing garbage: append one byte, decode rejects (the decoder
    requires the whole input to be consumed);
  - validation: zero-length objectId rejects, zero
    `plaintextLength` rejects, `version` 0 and `version` 2 reject.
- All rejections are `AttachmentError`; the codec layer's own
  `CodecError` is caught and re-thrown so the single-opaque-error
  rule holds at the attachment boundary.

### random-access-attachments.AC4: Streaming writer and readers

Implemented in phase 4.

**AC4.1** -- writer output is byte-identical to the pure encoding,
and the sequential reader round-trips it.

- Type: integration.
- File: `test/attachment/streams.ts`.
- Fixtures: `sealCryptoFromIds(2, 1)`, fixed CEK and salt, objectId
  `ascii('stream-test')`, plaintext of `2 * 65536 + 333` counter
  bytes, and a `chunked(bytes, size)` helper producing a
  `ReadableStream` of `size`-byte slices. Chunk sizes 1000 and 65537
  are used deliberately so buffering is exercised at sizes that
  align with nothing.
- Assertions:
  - `encryptAttachment` with the fixed salt: drained `readable`
    equals `sealObject`'s bytes for the same inputs, and
    `reference.plaintextLength` and `reference.snapshot` match;
  - `decryptAttachmentStream` over `chunked(bytes, 1000)` drains to
    the original plaintext; repeated with chunk size 65537;
  - progressive delivery: a hand-built `ReadableStream` controller
    emits only through the end of block 0 and then stalls without
    closing; the plaintext reader yields the first `SEGMENT_MAX`
    plaintext bytes while the ciphertext stream is still open. This
    is the automated proxy for the headline property, and it must
    use `await reader.read()` rather than any wall-clock timer.
- Browser confirmation: `npm run test:browser` runs this same file
  in a browser once during phase 4. Streams are the code most
  exposed to platform differences, so a node-only pass is not
  sufficient evidence for goal 5 (browser-first).

**AC4.2** -- a range read returns exactly the requested plaintext,
consuming only the reported ranges.

- Type: integration.
- File: `test/attachment/streams.ts`.
- Ranges under test: (0, 10); (65530, 20), which crosses the
  block 0/1 boundary; and the final partial block. The shipped tests
  read `(2 * 65536, 17)` for that last one, not `(2 * 65536, 333)`,
  because the fixture is 131089 octets rather than the 131405 this
  document specified. See amendment 1 below; the test is at
  `test/attachment/streams.ts:933` and the deviation is annotated at
  `test/attachment/streams.ts:163`.
- Assertions: `openAttachmentRange` returns ranges exactly equal to
  `rangesFor`'s output (sorted, coalesced, in bounds); serving each
  requested range by slicing the sealed bytes into `chunked(...)`
  streams and draining `decrypt(...)` yields exactly the plaintext
  slice. The "consuming only the reported ranges" half is enforced
  by construction: the test supplies one stream per reported range
  and nothing else, and `decrypt` rejects when the stream count or
  any drained length disagrees with the range list.

**AC4.3** -- reader rejects a snapshot mismatch, a missing segment,
and an out-of-bounds range.

- Type: integration.
- File: `test/attachment/streams.ts`.
- Cases, each `AttachmentError`:
  1. flip a byte in `ref.snapshot`, sequential decrypt rejects;
  2. serve one range short by 1 byte, range decrypt rejects;
  3. `openAttachmentRange` with `offset + length` past
     `ref.plaintextLength` rejects;
  4. close the ciphertext stream right after the header, sequential
     decrypt rejects (early end / missing segment).

**Layering invariants (design "Layering and opt-in" rules 1-3 and
the import-graph rule).** Not an AC, but a mechanical gate on every
standard test run.

- Type: build-time script, chained ahead of the tests in
  `test:node`.
- File: `scripts/check-attachment-invariants.mjs`.
- Checks: `src/index.ts` contains no reference to `attachment`;
  bundling `src/attachment/reader.ts` never pulls in `range.ts`;
  bundling `src/attachment/keys.ts` pulls in no SEAL module
  (`crypto`, `kdf`, `schedule`, `snapshot`, `layout`, `object`,
  `reader`, `range`, `writer`). Phase 5 extends the same script with
  the vendored-vector inventory check described under AC5.1.
- Negative control: phase 4 task 5 requires temporarily adding an
  attachment export to `src/index.ts`, confirming the script fails,
  and reverting. A guard nobody has seen fail is not a guard.

### random-access-attachments.AC5: Interoperability

Implemented in phase 5. Interop covers the SEAL layer only:
swift-raae does not implement the MLS keying and mls-attachments-01
publishes no vectors, so the CEK layer stays guarded by our own
frozen vectors (AC3.1).

**AC5.1** -- vendored swift-raae Appendix F vectors pass in the
standard node test run.

- Type: unit (vector sweep), always on, no toolchain required.
- File: `test/attachment/vectors-all.ts`.
- Data: every `.json` under `test_vectors/seal/core/` and
  `test_vectors/seal/engine/`, each imported by an explicit static
  import.
- Assertions: for each vector, every schedule field it carries
  (commitment, payload key, snap key, nonce base); the per-segment
  fields this sweep recomputes, which are `ciphertext_hex` and
  `tag_hex` from an open-then-reseal round trip and `contrib_hex`;
  and every multiset snapshot field it carries (accumulator,
  snapshot tag, mask, wrapped accumulator). Fields a vector does not
  carry are skipped with a `t.comment` so the skipped sections are
  visible in TAP output.
- Narrowed 2026-08-22 (US-030 of the audit remediation). "Every
  per-segment field" overstated this file. `nonce_hex`, `index` and
  `is_final` are inputs to the round trip here rather than assertions,
  and `segment_aad_hex` and `segment_key_hex` are not recomputed at
  all. Those three are asserted in `test/attachment/seal-core.ts`:
  `segment_key_hex` at `:70`, `segment_aad_hex` at `:185` and
  `nonce_hex` at `:198`. Across the two files every per-segment field
  the vendored vectors carry is checked; in this file alone it is the
  three named above.
- Deliberate overlap: this file re-covers ground that
  `seal-core.ts` and `snapshot.ts` already touch. Its distinct job
  is that no vendored file is silently unconsumed.
- Inventory enforcement, outside the bundle: a hardcoded count
  inside the bundle would compare a literal to a literal and verify
  nothing. `scripts/check-attachment-invariants.mjs` instead reads
  the vendored filenames with `node:fs.readdirSync` and fails if any
  filename is absent from an import specifier in
  `test/attachment/vectors-all.ts`, printing the counts on success.
- Negative control: rename one import, confirm the inventory check
  fails, revert.
- Vector provenance is recorded in `test_vectors/seal/README.md`
  (upstream repo, pinned commit, draft revision). Vendored files are
  never edited; a disagreement between our code and a vector is
  resolved in the vector's favor, with a comment naming the file
  that pinned the change.

**AC5.2** -- live cross-implementation round-trip, both directions,
including epoch crossing, final-segment handling, and tamper case.
CONDITIONAL.

- Type: e2e (crosses into a Swift process), gated.
- Command: `npm run test:interop`
  (`scripts/run-interop.mjs` bundles and runs
  `scripts/interop-seal.ts`).
- Peer under test: `interop/seal-cli/`, a SwiftPM executable
  wrapping swift-raae's `RAAE` product behind a fixed JSON
  stdin/stdout contract (`schedule`, `seal_segment`,
  `open_segment`), pinned to the same commit recorded in
  `test_vectors/seal/README.md`.
- Cases the harness must run and report per line:
  1. schedule cross-check: TypeScript `startSeal` against the CLI's
     `schedule` op, all fields compared;
  2. TypeScript -> Swift: TS seals two short segments, one at index
     0 (`is_final = 0`) and one at index 1024 (`is_final = 1`, the
     first index of epoch 1), the CLI opens each, plaintext compared;
     that pair is what covers epoch crossing and final-segment
     handling. Full-size segments are not covered by interop;
  3. Swift -> TypeScript: the CLI seals, TS `openSegment` opens,
     plaintext compared; includes variants for epoch crossing and
     final-segment handling;
  4. tamper: flip one ciphertext byte; the CLI must return an error
     response and TS `openSegment` must throw. The CLI does exit
     nonzero, but the harness does not assert that -- `callSwift`
     accepts status 0 and 1 alike and inspects only the response
     body, so claiming the exit status is verified would overstate
     what runs;
  5. snap_id 0x0003 rejection (negative): assert that sending a
     schedule op with snap_id 0x0003 (which the library emits but
     swift-raae does not implement) fails with
     `unsupportedSnapID`, signaling that when upstream support
     arrives, this gap can be closed by adding real round-trip
     coverage.
- Configurations for cases 1-4: SEAL-RO-v1 with derived nonces
  (snap_id 0x0000, nonce_mode 1) and SEAL-RW-v1 with random nonces
  (snap_id 0x0001, nonce_mode 0), both at AES-256-GCM (aead_id 2) /
  HKDF-SHA-256 (kdf_id 1), segment_max 65536, epoch_length 10,
  random CEK and salt, G = `ascii('interop-object')`.
- Configuration for case 5: SEAL-RO-v1 with derived nonces at
  snap_id 0x0003, same aead_id/kdf_id/segment_max/epoch_length, its
  own random CEK and salt, G = `ascii('interop-0x0003-rejection')`.
  That tuple is the one the library emits and the one swift-raae
  rejects, so it is deliberately not among the tuples cases 1-4 run.

  **Conditionality (explicit).** This criterion requires a Swift
  toolchain. When `swift` is not on PATH the harness prints
  `SKIP: swift toolchain not found` and exits 0, so a developer
  machine without Swift stays green. A SKIP is NOT a pass for
  AC5.2. The authoritative run is the CI job `interop` on a
  `macos-14` runner in `.github/workflows/nodejs.yml`, where the
  toolchain is preinstalled; no other CI job depends on it. If that
  job's log shows the SKIP line, AC5.2 is unverified and the missing
  toolchain is a follow-up item, not a green result. Confirming the
  distinction is human verification item H2 below.

### random-access-attachments.AC6: Demo

Implemented in phase 6.

**AC6.1** -- human-verified. See H1 below. The automated coverage in
this phase is structural only and does not, on its own, discharge
the criterion:

- `test/example/attachment-audio.ts` (unit): `makeTonePcm(2)` has
  exactly `2 * SAMPLE_RATE` samples all within [-1, 1];
  `bytesToPcm` round-trips a known `Float32Array` and throws on a
  6-byte (non-float-aligned) input; `chunkStartSeconds(65536)`
  equals `16384 / SAMPLE_RATE`.
- `test/example/routing.ts` (unit, modified): `isAttachmentsPath`
  cases mirroring the `isPersistencePath` ones (exact match, subpath
  match, non-match, query-string stripping).
- `test/example/nav.ts` (unit, modified): the item count rises from
  3 to 4, and exactly one nav item is active on every route
  including `/attachments`. Assert the active-flag invariant, not
  label text.
- Build check: `npm run build-example` succeeds and
  `grep -o 'window\.state=' public/assets/*.js` finds nothing (the
  AGENTS.md debug-leak check).

## Human verification

### H1: AC6.1, progressive playback in the demo

Criterion: random-access-attachments.AC6.1.

**Why this is not automated.** The criterion is about audible onset
relative to download completion. Verifying it mechanically would
require driving Web Audio in a headless browser and measuring when
sound is produced, which asserts on browser audio scheduling rather
than on our code, and the repo forbids brittle tests over rendered
output. The decryption-level property behind it IS automated (AC4.1
progressive delivery: plaintext for block 0 arrives while the
ciphertext stream is still open), so what remains for a human is
that the demo wires that property through to actual playback.

**Approach.**

1. `npm start`, open http://localhost:1234, click "Attachments".
2. Click Generate. Expect a sealed-attachment status and a segment
   total of 12 (12 seconds of 16 kHz float PCM, about 768 KiB).
3. Click Play (simulated slow network, roughly 250 ms per 64 KiB
   slice). PASS: audio is audible while the progress text still
   shows fewer than 12 segments decrypted. Onset should occur within
   about 1 second; full delivery takes roughly 3 seconds.
4. Click Seek (jump to 0:08 via range read). PASS: audio resumes
   from the 8-second point AND the status line's fetched-ranges
   report shows the leading segments were never fetched. Both halves
   are required; resuming at 0:08 after a full download would not
   demonstrate random access.
5. Click Stop mid-playback: audio stops, and Play works again
   afterward.
6. Browser console shows no errors.
7. Stop the dev server. Always; do not leave it running.

**Evidence to record** in the phase 6 task log: pass or fail per
step, the observed segment count at audible onset, and the fetched
ranges reported by the Seek step.

### H2: AC5.2, confirming the gated job actually ran

Criterion: random-access-attachments.AC5.2 (the conditional half).

**Why this is not automated.** The harness is designed to exit 0
when no Swift toolchain is present, which is what keeps
`npm run test:interop` usable everywhere. That same design means a
green CI job is ambiguous on its own: it could mean five interop
cases passed, or it could mean the runner had no `swift` and the
harness skipped. No assertion inside the harness can distinguish a
legitimately skipped run from a broken runner image, because the
harness is the thing that skipped.

**Approach.** After the first push that includes the `interop` job,
open the job log and confirm it does NOT contain
`SKIP: swift toolchain not found`, and that it contains one summary
line per interop case (schedule, TS -> Swift, Swift -> TS, range
read, tamper), all passing. Record the run URL. If the SKIP line is
present, AC5.2 remains unverified and the toolchain gap is filed as
a follow-up.

A developer with a local Swift toolchain can substitute a local
`npm run test:interop` run for this check, recording the same
evidence; that path is also how phase 5 task 5 expects the phase
gate to be exercised before CI sees it.

### H3: AC1.3, commitment-gate ordering (only if the sentinel test is
not written)

Criterion: random-access-attachments.AC1.3, ordering sub-claim.

**Why this may not be automated.** The error-type half of AC1.3 is
fully automated. The "before any AEAD operation" half is a claim
about control flow. The recommended sentinel-bundle test under AC1.3
makes it automatable at low cost, and that is the preferred route.
This item exists only as the documented fallback if that test is
deliberately skipped, so that the sub-claim is never silently
uncovered.

**Approach (fallback only).** Code review of
`src/attachment/schedule.ts`: confirm `deriveSchedule` and
`startOpen` reach no `crypto.aead` call path, and that `startOpen`
performs the constant-time commitment comparison and throws before
returning a state that any AEAD entry point could use. Record the
reviewed commit hash.

## Traceability summary

| Criterion | Type | Where |
| --- | --- | --- |
| AC1.1 | unit | `test/attachment/seal-core.ts`, `test/attachment/snapshot.ts`, `test/attachment/vectors-all.ts` |
| AC1.2 | unit | `test/attachment/seal-core.ts` |
| AC1.3 | unit (+ H3 fallback) | `test/attachment/seal-core.ts` |
| AC1.4 | unit | `test/attachment/seal-core.ts` |
| AC2.1 | integration | `test/attachment/object.ts`, `test/attachment/snapshot.ts` |
| AC2.2 | integration | `test/attachment/object.ts` |
| AC2.3 | unit | `test/attachment/layout.ts` |
| AC3.1 | unit | `test/attachment/keys.ts` |
| AC3.2 | unit | `test/attachment/keys.ts` |
| AC3.3 | unit | `test/attachment/reference.ts` |
| AC4.1 | integration | `test/attachment/streams.ts` (also under `test:browser`) |
| AC4.2 | integration | `test/attachment/streams.ts` |
| AC4.3 | integration | `test/attachment/streams.ts` |
| AC5.1 | unit | `test/attachment/vectors-all.ts` + `scripts/check-attachment-invariants.mjs` |
| AC5.2 | e2e, CONDITIONAL | `scripts/interop-seal.ts` via `npm run test:interop`; CI `interop` job on macos-14; H2 confirms it ran |
| AC6.1 | human | H1 (demo); structural support in `test/example/attachment-audio.ts`, `test/example/routing.ts`, `test/example/nav.ts` |

Non-AC gates that must also hold, on every standard test run:
`scripts/check-attachment-invariants.mjs` (layering rules 1-3 and
the vendored-vector inventory), the phase 4
`grep -q wipeSealState` check over `src/attachment/reader.ts`,
`range.ts`, and `object.ts` (design security rule 7), and re-run
stability of `scripts/generate-seal-own-vectors.ts`, enforced by
`scripts/check-vector-determinism.mjs`. That check regenerates into a
temporary directory and compares, rather than regenerating over the
committed vectors and diffing afterwards -- a check that mutates what
it is checking will eventually be interrupted partway and leave the
tree in a state nobody ordered.

## Definition of done for test coverage

1. Every file listed above exists and is registered in
   `test/unit.ts`.
2. `npm run lint && npm run build && npm run test:node && npm run
   test:fast` all pass with a clean `git status --porcelain`.
3. `npm run test:browser` has been run at least once after phase 4.
4. `npm run test:interop` either reports all cases passing locally,
   or the CI `interop` job does, with H2 recorded.
5. H1 recorded in the phase 6 task log with per-step outcomes.
6. Both negative controls have been exercised once and reverted: the
   layering check fails when `src/index.ts` imports attachment code,
   and the inventory check fails when a vendored vector import is
   renamed.

---

## Amendments after implementation

Recorded 2026-08-20, after the coverage audit. The document above is the
original contract; these are the places the shipped tests diverge from it.

1. **AC4.1 / AC4.2 fixture size.** `test/attachment/streams.ts` uses a
   131089-byte plaintext rather than the specified `2 * 65536 + 333`
   (131405), so the final-partial-block range read is `(2 * 65536, 17)`
   rather than `(2 * 65536, 333)`. Still a three-segment layout with a
   partial final block, so no code path is lost. Annotated in place at
   `test/attachment/streams.ts:163-167`.

2. **Three test files are not listed above**, all added during review to
   close gaps the original contract did not anticipate:
   `test/attachment/seal-crypto.ts` (the `sealCryptoFromCiphersuite`
   constructor), `test/attachment/seal-validation.ts` (boundary and range
   guards), and `test/attachment/reader-header.ts` (the header
   verification seams). Roughly 26 cases, mostly input validation.

3. **AC5.2's range-read case cannot run at the pinned swift-raae.** The
   harness prints `range read: skip` and says why. swift-raae rejects
   `snap_id 0x0003` as unimplemented and enforces raae-02's profiles
   table, which pins `SEAL-RO-v1` to `snap_id 0x0000`, so it cannot seal
   segments under the SEAL-attachment payload_info at all. The other
   AC5.2 cases do run against real Swift in both nonce modes. See "SEAL
   Profile and snap_id Conformance" in the design plan.

4. **AC1.3's ordering sub-claim now has the sentinel test** the original
   document recommended: `AC1.3: commitment gate precedes any AEAD call`
   in `test/attachment/seal-core.ts` passes a bundle whose aead throws a
   non-AttachmentError, so a reordering that reached the AEAD would leak
   the sentinel instead. Removing the commitment gate fails three
   assertions.

5. **The `wipeSealState` presence gate is now wired in.** It was
   described as running on every test run but existed only as a shell
   snippet in `phase_04.md`. `scripts/check-attachment-invariants.mjs`
   now counts call sites in `reader.ts`, `range.ts` and `object.ts`, and
   fails if any module drops to zero. It is a presence check only; the
   per-terminal-path behaviour is covered by the zeroization cases in
   `test/attachment/streams.ts`.

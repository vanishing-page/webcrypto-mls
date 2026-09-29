# Audit of the `ra` branch (random-access attachments)

Date: 2026-08-21. Scope: every commit on `ra` not on `main` (93 files,
about 25k lines added). Method: direct read of `src/attachment/*`,
`src/key-schedule.ts` and `src/client-state.ts`; a verified code review
pass; a docs-coverage pass; a test-completeness pass backed by 60
single-point source mutations run against the attachment suite.

Test run at audit time: `test:unit` 37626/37626 pass (581 attachment
assertions), both check scripts pass, `tsc --noEmit` clean.

Verdict: the cryptographic core is sound and the zeroization work is
load-bearing. The branch should not merge as-is because of three
correctness defects in the read paths (items 1 to 3), two residual key
leaks (4, 5), the structural gates never running in CI (6), and the
complete absence of consumer documentation (section 3).

## 1. Correctness and security

Ordered by severity. "Verified" means reproduced or confirmed by reading
the exact lines, not inferred.

### Must fix before merge

1. Range path skips the padding check the other two paths enforce.
   `rangesFor` (src/attachment/layout.ts:145) never emits a range over
   `[headerSize, firstBlockOffset)`, so `decryptRangeStream` never
   calls `isZeroRegion`, while `openObject` (object.ts:162) and
   `decryptAttachmentStream` (reader.ts:435, :445) reject a non-zero
   byte there. Flip one byte at `l.headerSize`: two readers throw, the
   range reader returns plaintext. test/attachment/parity.ts's tamper
   sweep includes that offset but never runs the range path, so CI
   cannot see the disagreement. Either fetch and check the gap in the
   range path or document the exemption in the parity doc and the
   parity test. Verified.

2. Reader rejects a valid object when the source emits a zero-length
   chunk. reader.ts:487: `if (!finalResult?.done || finalResult?.value
   || bufferRemainder > 0) throw`. An empty `Uint8Array` is truthy, and
   only one `read()` is attempted, so a legal empty non-final chunk
   (TransformStream and socket adapters emit these) or an empty value
   alongside `done` fails as "attachment integrity failure". Reproduced
   with a 70000-byte object. Loop until `done`, and test
   `value.length`, not truthiness.

3. Locked input stream leaks the owned CEK and breaks the single-error
   rule. reader.ts:359 calls `ciphertext.getReader()` before the `try`
   that ends in `doWipe()`. A locked stream throws a raw `TypeError`
   from `start()`, `opts.ownedCek` is never zeroed, and
   `decryptAttachmentStreamForGroup` has already returned so its catch
   cannot fire. Move `getReader()` inside the try. Verified.

4. Range read leaks the SealState when cancelled during `start()`.
   range.ts:350 `cancel()` wipes `ctx` only if it is set. If cancel
   lands while `start()` is awaiting a drain, `ctx` is null, `start()`
   carries on, derives and assigns the state, decrypts the window, and
   `pull()` never runs. Reproduced by the test pass: 500 ms after
   cancel, `ownedCek` is zero but `payload_key`, `acc_key` and
   `nonce_base` are live. This is exactly the shape reader.ts fixed with
   two latches (reader.ts:320-349); range.ts did not get that fix, and
   test/attachment/streams.ts:1642-1652 rationalizes the gap instead of
   testing it. src/attachment/AGENTS.md:114-150 does not list it.

5. `startOpen` leaks derived keys on commitment mismatch.
   schedule.ts:147-150 derives payloadKey, snapKey and nonceBase from
   the real CEK, then throws without `wipeSealState`. Every tampered
   commitment object hits this. Wipe in the failure branch.

6. The structural gates never run in CI. `.github/workflows/nodejs.yml`
   runs `test:unit` and `test:matrix`; `check-attachment-invariants.mjs`
   and `check-vector-determinism.mjs` are only in `test:node`
   (package.json:36). The getRandomValues ban, the layering checks, the
   vector inventory, the wipe-presence checks and vector determinism
   are enforced locally only. Both test plans say the gate runs on
   "every standard test run"; that is false for CI. Verified.

### Should fix

7. Intermediate exporter-tree secrets are never zeroized.
   keys.ts `safeExportSecret` walks 16 nodes and `attachmentCek` holds
   `componentSecret`; none is wiped. `componentSecret` derives the CEK
   for every objectId in the epoch, so it is worth more than the CEK
   the wrappers wipe so carefully. Wipe each node after its child is
   derived and `componentSecret` in a `finally`.

8. `opts.salt` on the public writer API is a nonce-reuse footgun.
   payloadKey, snapKey and nonceBase come from (cek, salt) only
   (schedule.ts:113); objectId enters the commitment alone. Two
   `encryptAttachment` calls with one raw CEK and the same fixed salt
   produce identical AES-GCM key and nonce for every segment, so
   `ct_A xor ct_B = pt_A xor pt_B`. Only `encryptAttachmentForGroup` is
   safe, because `attachmentCek` binds objectId. src/attachment/AGENTS.md:57
   recommends `opts.salt` for deterministic output; the public signature
   and JSDoc carry no warning. Drop `salt` from the ForGroup wrapper and
   document it as test-only on `encryptAttachment`/`sealObject`.

9. `AttachmentRangeRead.close` is typed optional (`close?:`,
   range.ts:60) while its JSDoc says "Always present -- do NOT use
   `if (read.close)`". The tests themselves write `rangeRead.close?.()`
   (cek-wipe.ts:1188). Make it required.

10. Epoch-less reference is invisible at the API. `AttachmentRef`
    carries no epoch and `applicationExportSecret` is not retained
    (client-state.ts:1289). An attachment opened after any commit fails
    the commitment gate with the same opaque error as tampering.
    Documented in FDR-003 decision 5 and AGENTS.md, but the
    `...ForGroup` JSDocs (writer.ts:64, reader.ts:559, range.ts:382) say
    nothing, and no consumer doc exists (section 3).

11. Abandoned reader keeps the owned CEK live. On the success path
    `decryptAttachmentStreamForGroup` wipes only when the consumer
    reads to the end or cancels. range.ts documents this; reader.ts
    does not.

12. No CEK length validation. `sealObject`, `openObject`,
    `encryptAttachment` accept any `cek.length`; `attachmentCek` always
    yields 32. A short key silently weakens derivation. Check against
    `CEK_LENGTH`.

13. `validateAttachmentRef` never checks `snapshot.length`. Safe today
    only because `constantTimeEqual` (kdf.ts:125) rejects unequal
    lengths, and that check has no test.

### Performance (correctness at scale)

14. reader.ts:426 and :508 re-sum the whole chunk array with
    `buffer.reduce` on every `read()`, making block assembly O(chunks^2)
    per 64 KiB block. Measured: a 1-byte-chunk source did not finish a
    two-segment object in 8 s. Keep a running byte count.

15. `segmentKey` (schedule.ts:160) re-runs HKDF extract and expand per
    segment although the output is identical for all 1024 segments of
    an epoch. A 128 GiB object does about 2M redundant derivations.
    Cache the expanded key per epochIndex on SealState and wipe it in
    `wipeSealState`.

### Example (example/attachments-demo.ts)

16. `scheduleFrom`'s recursive `loop()` (line 224) is not awaited, so
    `await loop()` resolves after the first chunk. `finally
    { cek.fill(0) }` in handlePlay/handleSeek runs while the stream is
    still being pulled, and a mid-stream error leaves `playing` true.
17. Unbatched signal pairs at 243-244, 285-287, 304-305, 376-378
    (house rule: batch sequential signal sets; 126, 187, 218, 396
    already do).
18. The demo calls the low-level API with a random epoch secret and a
    caller-owned CEK instead of the ForGroup wrappers, so it does not
    demonstrate the path a consumer should take.

### Sound, for the record

Commitment gate runs before any AEAD op and compares in constant time.
Each emitted block is authenticated up to the signed `ref.snapshot`
(root, epoch head, leaf, AEAD tag) and the layout is derived only from
the authenticated `plaintextLength`. Truncation and trailing bytes are
rejected. Per-object random salt means an accidental objectId reuse in
one epoch does not reuse nonces. Segment index and nonce are bounded
below 2^63; `MAX_SEGMENTS` keeps offsets in safe-integer range.
`AttachmentRef` decode is strict and version-pinned. `src/index.ts`
stays attachment-free and `getRandomValues` is banned under
`src/attachment` (the ban does fail when violated; verified).

## 2. Tests

Strengths: every claimed killable wipe site is killed by mutation (41 of
60 mutants die), the CEK-index control is genuine, the two-flag reader
regression is real, and no `skip`/`only`/`todo` exists. No tests assert
on HTML text or docs.

### Missing coverage (mutants survived)

1. Nothing positive ever crosses an epoch boundary. All multi-epoch
   tests are early rejections. Mutations that make `verifyEpochRun`
   always slice epoch 0, stop the reader re-verifying after epoch 0,
   start the range read at epoch 0, or compare every head against head
   0 all survive. A bug confined to segments >= 1024 would ship. Add a
   round-trip of >= 1025 segments through object, stream and range, and
   a tamper of an epoch > 0 head and leaf on each path.
2. Range cancel-during-start leak (item 4 above): no test.
3. `startOpen` mismatch leak (item 5): no test; cek-wipe checks only the
   CEK.
4. `MAX_SEGMENTS` (layout.ts:42) is never rejected.
   reader-header.ts:242-244 claims `MAX_SAFE_INTEGER + 1` hits it; it
   hits `isSafeInteger` first.
5. Wrong CEK / wrong objectId at `openObject` and
   `decryptAttachmentStream` level: only tested at `startOpen`.
6. Untested guards: `frame()` long-field branch (kdf.ts:78),
   `sealCryptoFromIds` bad ids (crypto.ts:108), salt length
   (schedule.ts:76), `locator` passthrough (writer.ts:41),
   `parsePrefix`/`verifyHeader` byte-length guards (reader.ts:60, :262),
   `constantTimeEqual` length check (kdf.ts:125).
7. Vendored vector fields never asserted: `F16.negative_snapverify`,
   `rewrite_segment_0` (F16/F17), `stored_object_hex` (F23).
   vectors-all.ts:293-306 only `t.comment`s the last two. The "9 total"
   inventory counts 3 engine files byte-identical to core.
8. No positive round-trip for exactly 65536 or 65537 bytes through the
   stream or range path.
9. example/attachments-demo.ts (472 lines, the real wiring) has no
   tests; test/example/attachment-audio.ts covers a 37-line helper and
   includes a constant-equals-literal assertion (line 9) and an
   unpinned throw (line 84).

### Tests that pass for a different reason than their title

- streams.ts:1355 and :1581 ("range zeroization on cancel") die when the
  pull wipe is removed, not the cancel wipe; they read a chunk first so
  the stream has already closed. The only real range-cancel test is
  cek-wipe.ts:1000.
- seal-validation.ts:93 (tag length) and :213 (huge index) pass with the
  named guard deleted; another guard throws first.
- streams.ts:1503 (`verifyEpochRun`) and :1974 (`openBlock` leaf) each
  pass with the named check deleted; they are redundant with each
  other.
- streams.ts:966 ("missing segment data rejects") passes with
  range.ts:168 and :267 both removed.
- cek-wipe.ts:355, :487, :686, :856, :990, :1132: `catch { t.ok(true) }`
  without pinning `AttachmentError`; a TypeError passes.
- cek-wipe.ts:559 works only because the read-ahead has not run yet;
  fragile against high-water-mark changes.
- scripts/interop-seal.ts:389 `catch (_e) { // Expected }`: any error
  passes the tamper case.

### CI

- Check scripts not run (item 6 above).
- Interop job can go green by skip: interop-seal.ts:486-489 prints
  `SKIP` and exits 0 when swift is absent. Fail when `CI` is set and
  the toolchain is missing.
- Tests are never typechecked in CI (`tsconfig.build.json` excludes
  `test`; no `tsc --noEmit` step).
- `test:browser` is not in CI.

### test-requirements.md claims that do not hold

- fixes AC3.4 cites reader-header.ts:220-247 as asserting `verifyHeader`
  rejects `MAX_SAFE_INTEGER + 1`; those tests call `layout()`.
- "chunked helper at streams.ts:1742": it lives in stream-helpers.ts.
- "zeroization assertion at streams.ts:70": it is at :41-56.
- parent AC4.2 names range (2*65536, 333); the test uses (2*65536, 17)
  (streams.ts:848).
- parent AC5.1 "every per-segment field asserted": three vector fields
  are not (item 7).
- fixes plan header "18 of 18 criteria verified by mutation": the
  epoch > 0 paths, MAX_SEGMENTS, salt length, frame long branch,
  locator, header length guards and the range cancel leak all survive.

## 3. Documentation

### Consumer documentation is absent

The only README change is a two-link "See Also" (README.md:1409-1414).
Everything else is internal (AGENTS.md, FDR-003, ADR-002, glossary,
security audit, interop and vector READMEs). A library user cannot learn
from the published docs:

1. That the feature exists, or how to import it. The API is reachable
   only through the `./*` subpath export
   (`@vanishing.page/webcrypto-mls/attachment/writer` and so on); that
   fact lives in AGENTS.md:56 and src/attachment/AGENTS.md:23-24.
2. Any of the flow: get `state.keySchedule` from a `ClientState`, call
   `encryptAttachmentForGroup`, upload `EncryptedAttachment.bytes` or
   `.readable`, send the ref via `createApplicationMessage(...,
   authenticatedData)` using `refToAuthenticatedData`, receive with
   `refFromAuthenticatedData`, then `decryptAttachmentStreamForGroup`
   or `openAttachmentRangeForGroup` (use `ranges` for HTTP Range
   requests, pass one stream per range to `decrypt`). There is no
   example anywhere; the demo is unlinked and uses the low-level API.
3. That `openObject` takes `plaintextLength:number` while
   `AttachmentRef.plaintextLength` is `bigint`
   (object.ts:139 vs reference.ts:29); the `Number()` conversion is
   mentioned only in src/attachment/AGENTS.md:237-238.
4. objectId rules (1-255 bytes, unique per epoch, never reused): only in
   keys.ts:110-113 JSDoc.
5. That attachments become undecryptable after a commit (FDR-003:249-255
   only).
6. That abandoning a stream without reading to end or cancelling leaks
   the CEK (src/attachment/AGENTS.md:128-134 only).
7. What `opts.salt`, `opts.locator` and `ownedCek` are for.
8. The `close()` contract (range.ts JSDoc is good; nothing surfaces it).

Recommendation: a README section "Encrypted attachments" with the
import path, one end-to-end example against a real group, the epoch
caveat, the objectId rules, and the close/cancel contract; JSDoc on
`sealObject`, `openObject`, `EncryptedAttachment`, `SealCrypto`,
`encodeAttachmentRef`, `validateAttachmentRef`.

### Inaccuracies in the internal docs

- src/attachment/AGENTS.md:55 names a function `sealCrypto`; it is
  `sealCryptoFromCiphersuite` (crypto.ts:55).
- src/attachment/AGENTS.md:118-124 labels the writer wipe "success path
  only"; writer.ts:83-85 wipes in a `finally`, so on throw too.
- docs/security-audit.md:584 cites range.ts:367-376 for the wrapper CEK
  wipe; it is at :386-403 (`fill(0)` at :401). :470 cites
  reader.ts:286-301 for `validateAttachmentRef`; the call is at :295.
- test_vectors/seal/own/README.md:73 and ADR-002:65 cite line ranges in
  keys.ts that have drifted (11-22 vs 11-24).
- range.ts:52 JSDoc vs :60 type on `close` (item 9 above).
- The two test plans claim the check scripts run on every standard run
  (see CI).

Verified accurate: SEGMENT_MAX, epoch length, metaLen, the 128 GiB
header arithmetic, snapshot labels, nonce formula, empty derived-mode
AAD, single opaque error, salt from `rng.randomBytes(32)`, the one-way
range -> reader dependency, all main.swift line references in the
interop README.

### House style

No em dashes or arrow characters anywhere on the branch. Lines over 80
columns: README.md:1413-1414, docs/adr/INDEX.md:8, docs/fdr/INDEX.md:14,
docs/security-audit.md:583-588, src/key-schedule.ts:61,
test/attachment/seal-core.ts:271, example/attachments-demo.ts:215, and
roughly 40 lines across the test-requirements and test-plan documents.

## 4. Suggested order of work

1. Fix items 1 to 5 with a test for each (the range padding test
   belongs in parity.ts; the two leak tests in cek-wipe.ts).
2. Add the check scripts to the CI matrix and make the interop skip
   fatal under `CI`.
3. Add the positive multi-epoch round-trips on all three paths.
4. Wipe intermediate exporter secrets; restrict `opts.salt`; make
   `close` required; validate CEK length.
5. Write the consumer README section and fix the stale cites.
6. Fix the demo's unawaited loop and the batching, then cover it.

## 5. Resolution

Every finding above, with the story that closed it. Findings the audit
numbered are keyed `<section>.<number>`; a subsection that recorded its
findings as bullets or prose instead of a numbered list is keyed
`<section>.<heading>` and resolved as a unit.

`scripts/check-audit-closed.mjs` derives this key list from the body of
this document on every run and fails if a finding has no row or a row
has no finding, so the table cannot drift from what the audit found.
The story ids are `specs/prd.json` ids, which the commit messages carry.

| Item | Resolution | Note |
| --- | --- | --- |
| 1.1 | US-001 | `rangesFor` emits the padding gap and the range path checks it with `isZeroRegion`; parity.ts sweeps all three paths over the same offsets. |
| 1.2 | US-002 | End-of-stream loops until `done` and tests `value.length`. Trailing bytes and truncation still throw. |
| 1.3 | US-003 | `getReader()` moved inside the guarded region, so a locked stream wipes and throws `AttachmentError`. |
| 1.4 | US-004 | `range.ts` uses `reader.ts`'s two-latch shape; a cancel at any point in `start()` leaves the state zero. Until audit 2026-09 M5 this did not cover a cancel during epoch-key derivation, which cached a live key into the wiped state; `segmentKey` now checks `SealState.wiped` (`test/attachment/cancel-epoch-key.ts`). |
| 1.5 | US-005 | The commitment-mismatch branch calls `wipeSealState` before throwing. The error is unchanged. |
| 1.6 | US-006 | Both gate scripts run in a `checks` CI job via `npm run test:checks`. |
| 1.7 | US-013 | `safeExportSecret` wipes each node after its child is derived; `attachmentCek` wipes `componentSecret` in a `finally`. |
| 1.8 | US-014 | `salt` dropped from `encryptAttachmentForGroup`; on `encryptAttachment` and `sealObject` it is documented as test and vector use only. Breaking change, in CHANGELOG.md. |
| 1.9 | US-015 | `close` is required. Breaking change, in CHANGELOG.md. |
| 1.10 | US-018, US-035 | The lifetime caveat is on all three `...ForGroup` JSDocs and in the README's "A reference dies at the next commit". |
| 1.11 | US-018, US-035 | `decryptAttachmentStream` and its wrapper document consumer-driven wiping; the README says "Finish the stream or cancel it". |
| 1.12 | US-016 | `sealObject`, `openObject` and `encryptAttachment` check `cek.length` against `CEK_LENGTH`. `decryptAttachmentStream` and `openAttachmentRange` did not, and failed only at the commitment gate, until the 2026-09 audit fix added the same check to both. |
| 1.13 | US-017 | `validateAttachmentRef` checks `snapshot.length` explicitly, and `constantTimeEqual`'s length check has its own test. |
| 1.14 | US-019 | Running byte count replaces the per-`read()` `buffer.reduce`; block assembly is linear in chunk count. |
| 1.15 | US-020 | The expanded epoch key is cached on `SealState` and wiped by `wipeSealState`. Proved by counting derivations, not by timing. Until audit 2026-09 M5 this did not cover a cancel during epoch-key derivation, which cached a live key into the wiped state; `segmentKey` now checks `SealState.wiped` (`test/attachment/cancel-epoch-key.ts`). |
| 1.16 | US-030 | The demo awaits its stream loop, so the CEK wipe runs after the last chunk and a mid-stream error clears `playing`. |
| 1.17 | US-031 | Sequential signal writes are batched, enforced by `scripts/check-signal-batching.mjs`. |
| 1.18 | US-032 | The demo uses `encryptAttachmentForGroup` and the other `...ForGroup` wrappers against a real group. |
| 1.Sound, for the record | NO ACTION: the section records properties that hold, not defects. They are covered by the existing suite and unchanged by this branch. | |
| 2.1 | US-010, US-011, US-012 | A cached 1025-segment fixture round-trips through object, stream and range, and a tampered epoch head and leaf past epoch 0 are rejected on each path. |
| 2.2 | US-004 | Covered in `test/attachment/cek-wipe.ts` by gating a `kdf.expand` so the cancel lands inside `start()`. Until audit 2026-09 M5 this did not cover a cancel during epoch-key derivation, which cached a live key into the wiped state; `segmentKey` now checks `SealState.wiped` (`test/attachment/cancel-epoch-key.ts`). |
| 2.3 | US-005 | `cek-wipe.ts` asserts `payloadKey`, `snapKey` and `nonceBase` are zero after a commitment mismatch, not just the CEK. |
| 2.4 | US-021 | `MAX_SEGMENTS` is rejected by a value that reaches it rather than tripping `isSafeInteger` first. |
| 2.5 | US-022 | Wrong CEK and wrong objectId are covered at `openObject`, `decryptAttachmentStream` and the range entry point. |
| 2.6 | US-023, US-024 | Each guard is pinned at the layer where it is the only thing that throws; guards that are depth rather than sole defense are commented as such in `src/attachment/AGENTS.md`. |
| 2.7 | US-025 | `F16.negative_snapverify`, `rewrite_segment_0` and `stored_object_hex` are asserted, and the inventory count is honest about the engine files. |
| 2.8 | US-026 | Exactly 65536 and 65537 bytes round-trip through object, stream and range. |
| 2.9 | US-033 | The demo's wiring is testable through `example/playback-loop.ts`; the constant-equals-literal assertion and the unpinned throw are gone. |
| 2.Tests that pass for a different reason than their title | US-027, US-028, US-029 | Every `catch { t.ok(true) }` pins `AttachmentError`; the range cancel tests assert in the cancel's own turn; guard-shadowed tests are re-scoped to the layer that actually throws. |
| 2.CI | US-006, US-007, US-008, US-009 | `checks`, a fatal interop skip under `CI`, `tsc --noEmit` over src, test, scripts and example, and a headless `test:browser` job. |
| 2.test-requirements.md claims that do not hold | US-038 | Every cite reopened at its line; the claims that did not hold were corrected rather than deleted. |
| 3.1 | US-035 | The README's "Encrypted attachments" section names the subpath export. |
| 3.2 | US-034, US-035 | `example/attachment-end-to-end.ts` compiles, runs in the suite, and is the source of every code block in the README section. `scripts/check-readme-attachments.mjs` keeps them verbatim. |
| 3.3 | US-035, US-036 | "Two `plaintextLength` types" in the README; `openObject`'s JSDoc says the conversion is the caller's. |
| 3.4 | US-035, US-036 | "The objectId is yours to keep unique" in the README, and on `attachmentCek`. |
| 3.5 | US-018, US-035 | Same as 1.10. |
| 3.6 | US-018, US-035 | Same as 1.11. |
| 3.7 | US-014, US-036 | `salt`, `locator` and `ownedCek` each carry JSDoc saying what they are for and what they cost. |
| 3.8 | US-015, US-035 | `close` is required in the type and the README says it is not optional and is final. |
| 3.Inaccuracies in the internal docs | US-037 | Every cite reopened with `sed -n` before it was written down; the paths are written from the repo root. |
| 3.House style | US-039 | `scripts/check-house-style.mjs` enforces 80 columns and the character rules against a base ref. It is a local script, not part of `test:checks`, because CI checks out shallow. |

# Random-Access Attachment Fixes Implementation Plan

**Goal:** Make the header-to-first-segment padding gap non-malleable by
rejecting any object whose gap contains a non-zero byte.

**Architecture:** The gap exists because `layout.ts:48-49` rounds the
first segment offset up to a 64 KiB boundary. Both read paths currently
walk past it without looking: `reader.ts:399-429` discards
`firstBlockOffset - headerSize` bytes, and `object.ts:155` checks only
`bytes.length !== l.totalSize`. The writer already leaves the gap zero,
because `sealObject` allocates `new Uint8Array(l.totalSize)` at
`object.ts:66-67` and never writes to that region, so the bytes are
zero-initialised by the engine. Enforcing zero on read is therefore a
pure read-side change: the wire format, the frozen vectors under
`test_vectors/seal/own/`, and the Swift side are all unaffected. A pure
predicate added to `layout.ts` serves both call sites, because that is
the module which defines the gap and both consumers already import from
it. Each caller raises its own `AttachmentError`, per the subsystem
rule that every failure throws that one type with no detail.

**Tech Stack:** TypeScript, `@substrate-system/tapzero`, esbuild test
bundle run under node.

**Scope:** Phase 1 of 6. Independent of every other phase.

**Codebase verified:** 2026-08-20 by codebase-investigator and by
direct reading during plan review.

---

## Citations in this plan

Every `file:line` below was verified on 2026-08-20 against branch `ra`.
Line numbers drift as you edit. Re-locate by content, and if a citation
does not match what you find, trust the code and say so in the commit
message. This plan exists because documents drifted from code; do not
let it become another instance.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments-fixes.AC1: Padding gap authentication

- **random-access-attachments-fixes.AC1.1 Failure:** An object whose
  padding gap contains any non-zero byte is rejected by
  `decryptAttachmentStream` with an `AttachmentError`, before any
  plaintext is emitted.
- **random-access-attachments-fixes.AC1.2 Failure:** The same object is
  rejected by `openObject` with an `AttachmentError`.
- **random-access-attachments-fixes.AC1.3 Success:** An unmodified
  object produced by `sealObject` and by the streaming writer still
  verifies and returns byte-identical plaintext under both read paths.
  The wire format is unchanged.
- **random-access-attachments-fixes.AC1.4 Failure:** Rejection holds
  across a sweep of plaintext sizes that vary the gap length, at both a
  single-segment object and a multi-epoch object. The empty-gap
  boundary is verified at the predicate level rather than end to end;
  see "The empty-gap case" below for why, and treat that as part of the
  criterion rather than a shortfall against it.

Abbreviated below to `AC1.1` and so on.

---

## Scope limit recorded deliberately

`range.ts` never traverses the gap. `rangesFor()` returns coalesced
byte ranges that omit it, so a range read never fetches those bytes and
structurally cannot check them. This is correct and is not a defect:
range reads authenticate the segments they do fetch against the
snapshot and the epoch heads. The consequence is that AC1 applies to
the two whole-object read paths only. Task 5 records this in the
subsystem's own documentation so a later reader does not mistake the
omission for an oversight. Do not attempt to make `range.ts` fetch the
gap in order to check it; that would add a network round trip to every
range read in exchange for no integrity gain.

## The empty-gap case

The gap is empty only when `headerSize` is an exact multiple of
`segmentMax`. With `headerSize = 32 + 2*nh + nEp*nh + nSeg*(nh+16)`
(`layout.ts:45-47`) the first solutions are:

| nh | first nSeg with an empty gap | plaintext required |
|----|------------------------------|--------------------|
| 32 | 1362                         | ~85.1 MiB          |
| 64 | 6546                         | ~409.1 MiB         |

This was computed by brute force over `layout()`'s own formula and
confirmed at nSeg=1362, where `headerSize` is exactly 65536.

The objection is memory, not wall-clock. AC1.4 already requires a
multi-epoch object, which is nSeg >= 1025 and about 64 MiB, so the
crypto cost of reaching 1362 segments is only about a third more
(measured at roughly 117 ms versus 155 ms of AEAD and hash work). What
rules it out is peak allocation: this file is registered ahead of the
marker at `test/unit.ts:30` precisely so it runs under
`npm run test:browser`, and a sealed 85 MiB object plus its plaintext
plus the tampered copy is a multi-hundred-megabyte peak in a browser
tab. On a SHA-512 suite the first empty-gap case is 409 MiB, which is
not viable anywhere.

Note also that the multi-epoch requirement is itself a large jump: the
biggest object anywhere in `test/attachment/` today is 131,089 bytes,
three segments. If the multi-epoch case proves too heavy for the
browser run, reduce it and say so in the test file, rather than
silently dropping to a size that no longer spans epochs.

So the empty-gap boundary is covered where it actually lives, in the
predicate, by task 1's `from >= to` tests. Task 4 records the
arithmetic in a comment rather than pretending the case was exercised
end to end.

Do not write a comment saying no reachable size produces an empty gap.
Reachable sizes exist; they are merely too large to seal in this test
suite, which is a different statement and the one that is true.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Zero-region predicate in layout.ts

**Verifies:** The empty-gap half of AC1.4. The remaining AC1 cases are
verified by tasks 2-4, which consume this predicate.

**Files:**
- Modify: `src/attachment/layout.ts` (append an exported function; do
  not alter any existing export)
- Test: `test/attachment/padding.ts` (unit, new file)

**Implementation:**

Add one exported pure function:

```ts
/**
 * True when every byte in `bytes` from `from` (inclusive) to `to`
 * (exclusive) is zero. Used to check the alignment padding between the
 * header and the first segment, which the writer leaves zero and which
 * no authenticator covers.
 *
 * Not constant time, and does not need to be: the padding is a public
 * constant, not a secret, so an early exit reveals nothing.
 */
export function isZeroRegion (
    bytes:Uint8Array,
    from:number,
    to:number,
):boolean
```

Behaviour:
- Return `true` when `from >= to` (an empty region is trivially zero).
- Otherwise scan `bytes[from]` through `bytes[to - 1]` and return
  `false` on the first non-zero byte.
- Clamp nothing and throw nothing. Callers pass in-bounds offsets they
  computed from a validated layout; out-of-range indices read
  `undefined`, which is not `0`, so a malformed call fails closed
  rather than silently passing.

Type annotation style is no space after the colon (`bytes:Uint8Array`),
per `eslint.config.js`. Keep every line at or under 80 columns.

**Testing:**

Create `test/attachment/padding.ts` and register it in `test/unit.ts`
with an `import './attachment/padding.js'` line placed inside the
existing attachment block, which runs from line 18
(`import './attachment/seal-core.js'`) to line 28
(`import './attachment/vectors-all.js'`), **before** the
`// Example app tests` marker at line 30. The comment above that block
explains why the ordering is load-bearing: `test:browser` aborts
partway through the example suite on a pre-existing fake-IndexedDB
conflict, so anything imported after the marker loses browser
coverage.

Tests for this task:
- All-zero buffer over a sub-range returns `true`.
- A buffer with a single non-zero byte inside the range returns
  `false`.
- A non-zero byte immediately outside the range on either side does not
  affect the result.
- `from === to` returns `true`. This is the empty-gap boundary; label
  the test so its purpose is findable.
- `from > to` returns `true`.

Use the project's tapzero style: `import { test } from
'@substrate-system/tapzero'`, one `test(...)` per behaviour.

**Verification:**

Run: `npm run test:unit`
Expected: all assertions pass, including the new ones.

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output.

Run: `npm run lint`
Expected: no output.

**Commit:** `feat: add isZeroRegion predicate for padding checks`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Enforce zero padding in openObject

**Verifies:** AC1.2, and the `openObject` half of AC1.3.

**Files:**
- Modify: `src/attachment/object.ts` (the length check at line 155,
  inside `openObject`, which spans lines 136-264)
- Test: `test/attachment/padding.ts` (unit)

**Implementation:**

`openObject` already has the whole object in memory and already
computes the layout `l`. Immediately after the existing
`bytes.length !== l.totalSize` check, and **before** any AEAD operation
or any call into `startOpen`, add the padding check:

```ts
if (!isZeroRegion(bytes, l.headerSize, l.firstBlockOffset)) {
    throw new AttachmentError()
}
```

Import `isZeroRegion` from `./layout.js` by extending the existing
layout import rather than adding a second one. Use the established
error idiom exactly: `throw new AttachmentError()` with no arguments
and no context, matching every other throw site in the subsystem.

Placing the check next to the length check, rather than deeper in
verification, means a malleated object is rejected on structural
grounds before any key material is derived.

**Testing:**

Tests must verify:
- AC1.2: seal an object with `sealObject`, flip one byte inside the
  gap (any index in `[l.headerSize, l.firstBlockOffset)`), and confirm
  `openObject` throws. Assert with the project's error idiom:

  ```ts
  try {
      await openObject(...)
      t.ok(false, 'should throw AttachmentError')
  } catch (err) {
      t.ok(err instanceof AttachmentError, 'rejects non-zero padding')
  }
  ```

- AC1.3: the same object, unmodified, still opens and returns plaintext
  byte-identical to the input. This is the regression guard proving the
  check did not break the happy path.

Compute the gap offsets in the test by calling `layout()` with the same
parameters the seal used, rather than hard-coding 64 KiB, so the test
survives a parameter change.

**Verification:**

Run: `npm run test:node`
Expected: invariants script passes, then all assertions pass. Use
`test:node` rather than `test:unit` here because only `test:node` runs
`scripts/check-attachment-invariants.mjs` first.

**Commit:** `fix: reject non-zero alignment padding in openObject`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Enforce zero padding in the streaming reader

**Verifies:** AC1.1, and the streaming half of AC1.3.

**Files:**
- Modify: `src/attachment/reader.ts:398-429` (the gap-skipping loop)
- Test: `test/attachment/padding.ts` (integration)

**Implementation:**

Read `reader.ts:398-429` in full before editing. The loop does **not**
discard the gap incrementally, despite what its name suggests. It sets
`let toSkip = l.firstBlockOffset - l.headerSize` at 399-400, then loops
accumulating chunks into `buffer` until `bufSize >= toSkip` (401-402),
and only then trims. The whole gap is resident in `buffer` before any
of it is dropped. The `else` branch at 419-428 just reads more bytes;
it does not decrement `toSkip`, which is set to 0 wholesale at 418
after the trim completes.

That makes the check simpler than an incremental one would be. In the
`bufSize >= toSkip` branch, the bytes about to be trimmed are exactly
the gap, so check them as they are removed:

- As each chunk or partial chunk is consumed by the existing trim loop
  at 404-417, call `isZeroRegion` over the span being removed.
- If any span is non-zero, throw `new AttachmentError()`.
- Leave the trim arithmetic itself untouched. It is fiddly (`removed`,
  `leftover`, the partial-chunk `slice`) and the check does not need to
  change it, only to inspect the same spans it already computes.

Do not restructure the loop into an incremental discard in order to
make the check "streaming". The memory profile here is a pre-existing
property of this code, this phase is not the place to change it, and
attempting to would risk the trim arithmetic for no integrity gain.

The throw must happen before the reader emits any plaintext. The gap
precedes the first segment, so the existing loop position already
guarantees this; confirm it rather than assuming, because AC1.1 asserts
on the ordering.

Extend the existing `layout.js` import for `isZeroRegion`.

**Testing:**

Tests must verify:
- AC1.1: build a sealed object, flip one gap byte, feed it to
  `decryptAttachmentStream` as a `ReadableStream`, and confirm the
  stream errors with an `AttachmentError` and that **zero plaintext
  bytes** were emitted before the error. Collect emitted chunks in an
  array and assert the array is empty in the catch.
- Chunk-boundary robustness: run the same tamper test with the
  ciphertext fed in small chunks (for example 1024 bytes) so the gap
  spans many chunks and the flipped byte lands away from a chunk start.
  Parameterise over at least two chunk sizes and at least two flip
  positions, one near the start of the gap and one near the end. The
  existing suite has a `chunked(bytes, size)` helper used at
  `test/attachment/streams.ts:1742`; reuse it rather than writing
  another.
- AC1.3: the unmodified object still decrypts to byte-identical
  plaintext through the streaming path.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

Browser coverage is confirmed structurally rather than by exit code.
`npm run test:browser` currently exits 1 on a pre-existing
fake-IndexedDB conflict in the example suite, so its exit status
carries no signal for this phase. What matters is that the new file is
registered inside the attachment block ahead of the marker at
`test/unit.ts:30`, which task 1 already requires. Confirm that by
reading `test/unit.ts`, not by running the browser suite.

**Commit:** `fix: reject non-zero alignment padding while streaming`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Gap-size sweep

**Verifies:** AC1.4.

**Files:**
- Test: `test/attachment/padding.ts` (integration)

**Implementation:**

No source change. This task closes the case that the gap length varies
with header size, which varies with segment count, which varies with
plaintext length. A fix that works at one size can fail at another.

**Testing:**

Sweep plaintext sizes chosen so the gap length differs materially. For
each size, compute the layout, flip a byte in the gap, and assert both
`openObject` and `decryptAttachmentStream` reject.

Pick sizes to include:
- A sub-segment object, smaller than `segmentMax`.
- An object of exactly `segmentMax`, so the final-segment boundary is
  exercised.
- A few-segment object, comparable to the 131,089-byte fixtures the
  existing suite already uses.
- An object large enough for several epochs, so `nEp` grows,
  `headerSize` grows, and the gap length changes. See the note above
  about its cost under `test:browser`.

Derive every offset from `layout()`. Do not hard-code any of the sizes
that the sweep is meant to vary over.

Add a comment recording the empty-gap arithmetic from the section above
and stating that the boundary is covered by task 1's predicate tests,
naming nSeg=1362 for nh=32 as the smallest end-to-end case and ~85 MiB
as the reason it is not sealed here. Write the true statement, not the
convenient one.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

**Commit:** `test: sweep padding rejection across gap sizes`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Record the padding contract

**Verifies:** None (documentation of the invariant this phase
establishes).

**Files:**
- Modify: `src/attachment/AGENTS.md`

**Implementation:**

Add a short subsection stating:

1. The alignment padding between the header and the first segment must
   be all zero. The writer leaves it zero implicitly, by never writing
   to that region of a zero-initialised allocation.
2. Both whole-object read paths reject a non-zero gap.
3. `range.ts` does not and should not check it, because a range read
   never fetches those bytes. Say why this is safe: the segments a
   range read does fetch are authenticated against the snapshot and the
   epoch heads.
4. Why the check exists at all: without it, two byte-different stored
   objects verify as the same attachment, which breaks any
   content-addressed locator.

House style for this file: no em dashes, use `--`; no arrow
characters, use `->`. Keep prose lines at or under 80 columns.

**Verification:**

Run: `npm run test:node`
Expected: unchanged, still passing. Documentation only.

**Commit:** `docs: record the zero-padding invariant`
<!-- END_TASK_5 -->

---

## Phase complete when

- `npm run test:node` passes with the new assertions included.
- `npx tsc -p tsconfig.json --noEmit` is clean.
- `npm run lint` is clean.
- `git diff --exit-code test_vectors/seal/own/` is empty. This phase
  must not change any vector; if it does, the change was not read-side
  only and the approach needs revisiting before proceeding.

# Random-Access Attachments Implementation Plan -- Phase 4: Streams

**Goal:** WHATWG-stream APIs over the phase 2 byte-level functions:
a writer that emits a sealed attachment as a stream plus its
`AttachmentRef`, a sequential reader that decrypts a ciphertext
stream progressively (the partial-download property), and a
range reader that decrypts arbitrary byte ranges from fetched
encrypted ranges.

**Architecture:** `writer.ts` seals in memory and streams the
result -- an ordered output stream cannot patch a header it already
emitted, so single-pass streaming writing requires a random-access
sink; the design doc's "Writer note" records this decision and
defers transport-aware streaming writers. (The design was amended
to this during planning; the earlier `AttachmentWriter
writable/readable` sketch is gone.)
`reader.ts` buffers ONLY the header region, verifies commitment +
ref snapshot + epoch heads up front, then verifies and decrypts
each block as it arrives -- true streaming. `range.ts` implements
the `{ ranges, decrypt }` contract over `rangesFor` from
`layout.ts`. Dependency rule: `range.ts` imports from `reader.ts`,
never the reverse. Convenience wrappers take
`Pick<KeySchedule, 'applicationExportSecret'>` + objectId and
derive the CEK via `keys.ts`.

**Tech Stack:** WHATWG streams (global in Node 22 and browsers; no
imports needed), everything else as prior phases.

**Scope:** Phase 4 of 6 from
`docs/design-plans/2026-08-19-random-access-attachments.md`.

**Codebase verified:** 2026-08-19

**Style rules:** same as Phase 1.

---

## Acceptance Criteria Coverage

This phase implements and tests:

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

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Header verification context (shared reader core)

**Verifies:** random-access-attachments.AC4.1, AC4.3
(implementation prerequisite).

**Files:**
- Create: `src/attachment/reader.ts` (first part)

**Step 1: Implement the decomposed reader core in
`src/attachment/reader.ts`**

The decomposition is fixed here (not left to taste) because
`range.ts` consumes exactly these seams:

```ts
export interface HeaderPrefix {
    salt:Uint8Array
    storedCommitment:Uint8Array
    storedSnapshot:Uint8Array
    epochHeads:Uint8Array     // the aux region, nEp * nh, complete
    layoutParams:LayoutParams
    l:Layout
}

/**
 * Pure slicing of the fixed prefix + epoch heads. `bytes` must
 * cover at least [0, epochHeadsOffset + nEp * nh). No crypto.
 */
export function parsePrefix (
    bytes:Uint8Array,
    plaintextLength:number,
    nh:number,
):HeaderPrefix

/**
 * Commitment gate + root check: startOpen with the parsed salt and
 * stored commitment, recompute epochTreeRoot over the complete
 * epoch heads, constant-time compare against ref.snapshot AND
 * require the stored snapshot field to match. Returns the SealState.
 */
export async function verifyRoot (
    cek:Uint8Array,
    objectId:Uint8Array,
    prefix:HeaderPrefix,
    refSnapshot:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState>

export interface HeaderContext {
    state:SealState
    prefix:HeaderPrefix
    metadata:Uint8Array       // n_seg * metaLen leaves (or a buffer
                              // holding only verified runs at their
                              // correct offsets, for range reads)
}

export async function verifyEpochRun (
    ctx:HeaderContext,
    epoch:number,
):Promise<void>               // AttachmentError on mismatch

export async function openBlock (
    ctx:HeaderContext,
    index:number,
    block:Uint8Array,         // ciphertext, no tag
):Promise<Uint8Array>

/**
 * Full-header convenience: parsePrefix + verifyRoot + take the
 * complete metadata region from `header` (which must be exactly
 * l.headerSize octets).
 */
export async function verifyHeader (
    cek:Uint8Array,
    objectId:Uint8Array,
    header:Uint8Array,
    ref:{ snapshot:Uint8Array, plaintextLength:number },
    crypto:SealCrypto,
):Promise<HeaderContext>
```

`verifyEpochRun` slices that epoch's leaf run from `ctx.metadata`,
recomputes `epochHead(state, run)`, and compares against the stored
head slice for that epoch. `openBlock` computes `segmentLeaf` from
the block and the metadata tag, compares against the stored leaf
for `index` (constant time), then `openSegment` with
`isFinal = (index === nSeg - 1)` and the metadata tag. Metadata
leaves are NOT verified in `verifyHeader`; they are verified per
epoch on the decrypt paths so range reads only pay for epochs they
touch. All failures throw `AttachmentError`.

**Step 2: Verify compile, commit**

```bash
npm run build && npm run lint
git add src/attachment/reader.ts
git commit -m "attachment: header verification context"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Writer and sequential reader streams

**Verifies:** random-access-attachments.AC4.1 (implementation).

**Files:**
- Create: `src/attachment/writer.ts`
- Modify: `src/attachment/reader.ts` (add the stream API)

**Step 1: `src/attachment/writer.ts`**

```ts
export interface EncryptedAttachment {
    readable:ReadableStream<Uint8Array>
    reference:AttachmentRef
    bytes:Uint8Array
}

export async function encryptAttachment (
    cek:Uint8Array,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    crypto:SealCrypto,
    opts?:{ salt?:Uint8Array, locator?:Uint8Array },
):Promise<EncryptedAttachment>

export async function encryptAttachmentForGroup (
    keySchedule:Pick<KeySchedule, 'applicationExportSecret'>,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    cs:CiphersuiteImpl,
    opts?:{ salt?:Uint8Array, locator?:Uint8Array },
):Promise<EncryptedAttachment>
```

`encryptAttachment` calls `sealObject`, builds the
`AttachmentRef` (`objectId`, `plaintextLength:
BigInt(plaintext.length)`, `snapshot`, `locator` defaulting to
empty), and wraps the bytes in a `ReadableStream` that enqueues
`SEGMENT_MAX`-sized chunks. `encryptAttachmentForGroup` derives the
CEK via `attachmentCek` and the crypto bundle via
`sealCryptoFromCiphersuite`, then delegates. Accepting a
`ReadableStream<Uint8Array>` or `Blob` source is a convenience
overload: drain it to bytes first (`new Response(source)` /
`Blob.arrayBuffer` patterns are fine).

**Step 2: Sequential reader stream in `src/attachment/reader.ts`**

```ts
export function decryptAttachmentStream (
    cek:Uint8Array,
    ref:AttachmentRef,
    ciphertext:ReadableStream<Uint8Array>,
    crypto:SealCrypto,
):ReadableStream<Uint8Array>
```

Behavior (implement as a `ReadableStream` pulling from the
ciphertext reader, or a `TransformStream` piped internally --
either is fine, keep buffering explicit):
1. `validateAttachmentRef(ref)`; reject `plaintextLength` above
   `Number.MAX_SAFE_INTEGER` with `AttachmentError`; use
   `Number(ref.plaintextLength)` beyond that point.
2. Buffer incoming chunks until `l.headerSize` octets are
   available; `verifyHeader`.
3. Skip the zero padding up to `l.firstBlockOffset` (consume and
   discard; no verification of the pad bytes).
4. For each block index in order: buffer until the block's length
   (`segmentLength`) is available; on the first segment of each
   epoch, `verifyEpochRun` for that epoch (slice the run from
   `ctx.metadata`); `openBlock`; enqueue the plaintext.
5. Reject with `AttachmentError` when the stream ends early
   (missing segment) or carries extra bytes past `totalSize`.
6. Zeroization (design security rule 7): `wipeSealState(ctx.state)`
   when the plaintext stream closes, errors, or is cancelled (a
   single `finally`-style path in the pull loop plus the `cancel`
   callback).
7. A wrapper `decryptAttachmentStreamForGroup(keySchedule, ref,
   ciphertext, cs)` derives the CEK as in the writer.

**Step 3: Verify, commit**

```bash
npm run build && npm run lint
git add src/attachment/writer.ts src/attachment/reader.ts
git commit -m "attachment: writer and sequential reader streams"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Range reader

**Verifies:** random-access-attachments.AC4.2, AC4.3
(implementation).

**Files:**
- Create: `src/attachment/range.ts`

**Step 1: Create `src/attachment/range.ts`**

```ts
export interface AttachmentRangeRead {
    ranges:ByteRange[]
    decrypt:(streams:ReadableStream<Uint8Array>[]) =>
        ReadableStream<Uint8Array>
}

export async function openAttachmentRange (
    cek:Uint8Array,
    ref:AttachmentRef,
    range:{ offset:number, length:number },
    crypto:SealCrypto,
):Promise<AttachmentRangeRead>
```

Behavior:
1. Validate the ref, including the same length guard the
   sequential reader spells out: reject `ref.plaintextLength`
   above `Number.MAX_SAFE_INTEGER` with `AttachmentError`, then
   use `Number(ref.plaintextLength)` for `layoutParams`. Compute
   `rangesFor(layoutParams, offset, length)` -- it throws on
   out-of-bounds (AC4.3).
2. Return its coalesced `ranges` (the contract: the caller fetches
   exactly these encrypted byte ranges, e.g. via HTTP Range, and
   passes one stream per range in order).
3. `decrypt(streams)`: drain each stream to bytes; reject when
   `streams.length !== ranges.length` or any drained length differs
   from its range's length (missing data, AC4.3). Reassemble a
   sparse view keyed by offset. Then use the reader seams directly
   (no duplicated logic): `parsePrefix` over `ranges[0]`'s bytes
   (which always cover salt + commitment + snapshot + the complete
   epoch-heads region), `verifyRoot` against `ref.snapshot`, build
   a `HeaderContext` whose `metadata` buffer is zero-filled with
   only the fetched epoch runs written at their correct leaf
   offsets (safe because every leaf `openBlock` reads belongs to a
   fetched, `verifyEpochRun`-verified epoch; state that invariant
   in a comment), then `verifyEpochRun` for each fetched epoch and
   `openBlock` for each fetched block.
4. Trim the first and last decrypted segments to the requested
   plaintext window and enqueue the result in order as one
   `ReadableStream`.
5. `wipeSealState(ctx.state)` in a `finally` once decryption
   completes or fails (design security rule 7).
6. Group wrapper `openAttachmentRangeForGroup(keySchedule, ref,
   range, cs)` as before.

**Step 2: Verify, commit**

```bash
npm run build && npm run lint
git add src/attachment/range.ts
git commit -m "attachment: range reader"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Stream tests

**Verifies:** random-access-attachments.AC4.1, AC4.2, AC4.3.

**Files:**
- Create: `test/attachment/streams.ts` (unit)
- Modify: `test/unit.ts`

Common fixtures: `sealCryptoFromIds(2, 1)`, fixed CEK and salt,
objectId `ascii('stream-test')`, plaintext of `2 * 65536 + 333`
counter bytes. Helper `chunked(bytes, size)` returning a
`ReadableStream` that enqueues `size`-byte slices (use awkward
sizes like 1000 and 65537 to exercise buffering).

Tests:
- AC4.1 writer: `encryptAttachment` with the fixed salt; drain
  `readable`; assert byte-equality with `sealObject` output for the
  same inputs, and that `reference.plaintextLength` and
  `reference.snapshot` match.
- AC4.1 round-trip: `decryptAttachmentStream` over `chunked(bytes,
  1000)` drains to the original plaintext. Repeat with chunk size
  65537.
- AC4.1 progressive: wrap the ciphertext stream so it emits only up
  to the end of block 0 and then stalls (never closes); read the
  plaintext stream's first chunk(s) and assert the first
  `SEGMENT_MAX` plaintext bytes arrive without the stream having
  ended. Use a manual `ReadableStream` controller; poll with
  `await reader.read()` -- no timers dependent on wall-clock
  ordering.
- AC4.2: for ranges (0, 10), (65530, 20) [crosses block 0/1],
  (2 * 65536, 333) [final partial block], call
  `openAttachmentRange`, serve each requested range by slicing the
  sealed bytes into `chunked(...)` streams, and assert the drained
  output equals the plaintext slice. Assert the requested ranges
  are exactly `rangesFor`'s output (sorted, coalesced, within
  bounds).
- AC4.3 snapshot mismatch: flip a byte in `ref.snapshot`; decrypt
  rejects.
- AC4.3 missing segment: serve one range short by 1 byte; rejects.
- AC4.3 out of bounds: `openAttachmentRange` with offset+length
  past `plaintextLength` rejects (throws `AttachmentError`).
- Sequential reader early-end: close the ciphertext stream after
  the header; reading rejects.

Register `import './attachment/streams.js'` in `test/unit.ts`.

**Run and commit:**

```bash
npm run test:unit && npm run lint
git add test/attachment test/unit.ts
git commit -m "attachment: stream tests"
```

Also run the browser bundle smoke test once in this phase (streams
are the code most sensitive to platform differences):

```bash
npm run test:browser
```

Expected: passes (same entry as node; polyfilled Buffer only).
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Layering invariants check

**Verifies:** the design's opt-in layering rules (Layering and
opt-in, rules 1-3, and the import-graph rule) -- mechanically, on
every test run.

**Files:**
- Create: `scripts/check-attachment-invariants.mjs`
- Modify: `package.json` (chain it into `test:node`)

**Step 1: Write `scripts/check-attachment-invariants.mjs`**

```js
// Verifies the attachment subsystem's layering invariants:
// 1. src/index.ts stays attachment-free (opt-in via subpaths only)
// 2. reader.ts never pulls in range.ts
// 3. keys.ts pulls in no SEAL code (usable with foreign schemes)
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

let failed = false
function fail (msg) {
    console.error('FAIL: ' + msg)
    failed = true
}

const index = readFileSync('src/index.ts', 'utf8')
if (index.includes('attachment')) {
    fail('src/index.ts references attachment/')
}

async function inputsOf (entry) {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'neutral',
        format: 'esm',
        metafile: true,
        logLevel: 'silent',
    })
    return Object.keys(result.metafile.inputs)
}

const readerInputs = await inputsOf('src/attachment/reader.ts')
if (readerInputs.some(p => p.endsWith('attachment/range.ts'))) {
    fail('reader.ts pulls in range.ts')
}

const keysInputs = await inputsOf('src/attachment/keys.ts')
const sealModules = [
    'crypto.ts', 'kdf.ts', 'schedule.ts', 'snapshot.ts',
    'layout.ts', 'object.ts', 'reader.ts', 'range.ts', 'writer.ts',
]
for (const m of sealModules) {
    if (keysInputs.some(p => p.endsWith('attachment/' + m))) {
        fail('keys.ts pulls in attachment/' + m)
    }
}

if (failed) process.exit(1)
console.log('attachment layering invariants ok')
```

**Step 2: Chain into the test script**

In `package.json`, change:

```json
"test:node": "node scripts/run-tests.mjs all"
```

to:

```json
"test:node": "node scripts/check-attachment-invariants.mjs && node scripts/run-tests.mjs all"
```

**Step 3: Verify it both passes and can fail**

```bash
npm run test:node
```

Expected: the invariants line prints, then tests run. Then
temporarily add `export * from './attachment/error.js'` to
`src/index.ts`, re-run, confirm the script fails, and revert the
temporary line.

**Step 4: Commit**

```bash
git add scripts/check-attachment-invariants.mjs package.json
git commit -m "attachment: enforce layering invariants in test run"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Phase verification

**Verifies:** phase gate for AC4.1-AC4.3.

```bash
for f in src/attachment/reader.ts src/attachment/range.ts \
  src/attachment/object.ts; do \
  grep -q wipeSealState "$f" || { echo "missing wipe: $f"; exit 1; }; \
done && echo "zeroization wired"
npm run lint && npm run build && npm run test:unit && \
  npm run test:fast
git status --porcelain
```

Expected: "zeroization wired" prints (the loop exits nonzero if ANY
file lacks the call); everything green; empty status.
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->

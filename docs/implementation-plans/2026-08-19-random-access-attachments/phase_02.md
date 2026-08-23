# Random-Access Attachments Implementation Plan -- Phase 2: Snapshots and layout

**Goal:** Whole-object integrity (snapshot authenticators) and the
aligned storage layout with pure offset math, culminating in
`sealObject`/`openObject` byte-level functions that build and verify
complete SEAL-attachment objects.

**Architecture:** Three new pure modules over Phase 1's core:
`snapshot.ts` (masked multiset hash 0x0001, needed to consume
swift-raae's engine vectors, plus the epoch digest tree 0x0003 that
SEAL-attachment mandates), `layout.ts` (offset math only, no
crypto), and `object.ts` (assemble/verify whole objects). The epoch
digest tree has no external vectors yet, so this phase freezes our
own generated vectors to lock the bytes against regression.

**Tech Stack:** as Phase 1.

**Scope:** Phase 2 of 6 from
`docs/design-plans/2026-08-19-random-access-attachments.md`.

**Codebase verified:** 2026-08-19

**Normative pins (from seal-concrete-00 sections 4.2, 4.7.6 and
mls-attachments-01 section 5.1):**
- Segment blocks store ciphertext only; the AEAD tag lives in the
  header metadata table. AES-GCM/ChaCha keep ciphertext length ==
  plaintext length, so every block except the last is exactly
  `segment_max` octets.
- `leaf(i) = LH(ct_i) || tag_i`, LH over the ciphertext WITHOUT the
  tag. meta_len for SEAL-attachment = Nh + 16. LH here is the
  framed-KDF helper `lh()` from `kdf.ts` (Extract with salt
  "raAE-LP-v1"), NOT `crypto.hash.digest` -- the design doc's older
  "suite hash" phrasing was corrected to this pinned form.
- Epoch heads: `d_e = KDF(pid, "snap_epoch", [snap_key],
  [LH(epoch_run(e))], Nh)` where epoch_run(e) concatenates the
  leaves of epoch e (2^epoch_length leaves, fewer in the last).
- Root: `snapshot = KDF(pid, "snap_epoch_root", [snap_key],
  [commitment, uint64(n_seg), LH(d_0 || ... || d_last)], Nh)`.
- Multiset (0x0001): `contrib(i) = KDF(pid, "acc_contrib",
  [snap_key], [uint64(i), tag_i], Nh)`; acc = XOR of contribs;
  `snapshot = KDF(pid, "snap_acc", [snap_key], [uint64(n_seg),
  acc], Nh)`; stored accumulator is masked: `wrapped_acc = acc XOR
  KDF(pid, "acc_mask", [snap_key], [uint64(n_seg), snapshot], Nh)`.
  The engine vectors pin these labels; if a vector disagrees, the
  vector wins (adjust the label constants and note the change).
- Aligned header: `salt(32) | commitment(Nh) | snapshot(Nh) |
  epoch_heads(n_ep * Nh) | metadata(n_seg * (Nh + 16))`, so
  header_size = 32 + 2*Nh + n_ep*Nh + n_seg*(Nh+16).
- Object layout (mls-attachments-01): header at offset 0,
  zero-padded to the next `segment_max` boundary; block i starts at
  `firstBoundary + i * segment_max`.
- n_seg = ceil(plaintextLength / segment_max); n_ep =
  ceil(n_seg / 2^epoch_length). Empty objects are rejected.

**Style rules:** same as Phase 1 (80 cols, no-space colons, named
exports, no em dashes or arrows in comments).

---

## Acceptance Criteria Coverage

This phase implements and tests:

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

Also completes the vector-consumption side of
**random-access-attachments.AC1.1** for the engine vectors
(snapshot fields of F16/F17/F23).

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Snapshot authenticators

**Verifies:** random-access-attachments.AC2.1 (implementation; and
AC1.1's engine-vector snapshot fields via Task 4 tests).

**Files:**
- Create: `src/attachment/snapshot.ts`

**Step 1: Create `src/attachment/snapshot.ts`**

```ts
import type { SealState } from './schedule.js'
import { concatAll, lh, sealKdf, uint64be } from './kdf.js'
import { AttachmentError } from './error.js'

export function xorInto (acc:Uint8Array, x:Uint8Array):void {
    if (acc.length !== x.length) throw new AttachmentError()
    for (let i = 0; i < acc.length; i++) acc[i] ^= x[i]
}

// ---- masked multiset hash (snap_id 0x0001) ----

export async function multisetContrib (
    state:SealState,
    index:bigint,
    tag:Uint8Array,
):Promise<Uint8Array> {
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'acc_contrib',
        [state.snapKey], [uint64be(index), tag],
        state.crypto.kdf.size,
    )
}

export async function multisetSnapshot (
    state:SealState,
    nSeg:bigint,
    acc:Uint8Array,
):Promise<Uint8Array> {
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'snap_acc',
        [state.snapKey], [uint64be(nSeg), acc],
        state.crypto.kdf.size,
    )
}

export async function multisetMask (
    state:SealState,
    nSeg:bigint,
    snapshot:Uint8Array,
):Promise<Uint8Array> {
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'acc_mask',
        [state.snapKey], [uint64be(nSeg), snapshot],
        state.crypto.kdf.size,
    )
}

// ---- epoch digest tree (snap_id 0x0003) ----

export async function segmentLeaf (
    state:SealState,
    ciphertext:Uint8Array,
    tag:Uint8Array,
):Promise<Uint8Array> {
    const digest = await lh(ciphertext, state.crypto.kdf)
    return concatAll([digest, tag])
}

export async function epochHead (
    state:SealState,
    epochRun:Uint8Array,
):Promise<Uint8Array> {
    const digest = await lh(epochRun, state.crypto.kdf)
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'snap_epoch',
        [state.snapKey], [digest], state.crypto.kdf.size,
    )
}

export async function epochTreeRoot (
    state:SealState,
    nSeg:bigint,
    heads:Uint8Array,
):Promise<Uint8Array> {
    const digest = await lh(heads, state.crypto.kdf)
    return sealKdf(
        state.crypto.kdf, state.params.protocolId, 'snap_epoch_root',
        [state.snapKey],
        [state.commitment, uint64be(nSeg), digest],
        state.crypto.kdf.size,
    )
}
```

**Step 2: Verify and commit**

```bash
npm run build && npm run lint
git add src/attachment/snapshot.ts
git commit -m "attachment: multiset and epoch digest tree snapshots"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Layout math

**Verifies:** random-access-attachments.AC2.3 (implementation).

**Files:**
- Create: `src/attachment/layout.ts`

**Step 1: Create `src/attachment/layout.ts`**

Pure functions, no crypto imports except the error type. All sizes
are plain numbers (object sizes stay far below 2^53; segment
indices exposed as `number` here, converted to bigint at the
schedule boundary).

```ts
import { AttachmentError } from './error.js'

export const META_TAG_LENGTH = 16

export interface LayoutParams {
    plaintextLength:number
    segmentMax:number
    epochLength:number
    nh:number
}

export interface Layout {
    nSeg:number
    nEp:number
    headerSize:number
    firstBlockOffset:number
    totalSize:number
    saltOffset:number
    commitmentOffset:number
    snapshotOffset:number
    epochHeadsOffset:number
    metaOffset:number
    metaLen:number
}

/**
 * Object-size ceiling. Per-key AEAD budgets are already satisfied
 * by construction (one epoch key covers 2^epoch_length = 1024
 * invocations, far under the drafts' 2^32 GCM bound); this cap
 * keeps every offset in safe-integer range and bounds a single
 * CEK's object far beyond the design's 128 GiB target. A larger
 * object is a new object with a new object_id.
 */
export const MAX_SEGMENTS = 2 ** 31

export function layout (p:LayoutParams):Layout {
    if (!Number.isSafeInteger(p.plaintextLength) ||
        p.plaintextLength <= 0) {
        throw new AttachmentError()
    }
    const nSeg = Math.ceil(p.plaintextLength / p.segmentMax)
    if (nSeg > MAX_SEGMENTS) throw new AttachmentError()
    const perEpoch = 2 ** p.epochLength
    const nEp = Math.ceil(nSeg / perEpoch)
    const metaLen = p.nh + META_TAG_LENGTH
    const headerSize = 32 + (2 * p.nh) + (nEp * p.nh) +
        (nSeg * metaLen)
    const firstBlockOffset =
        Math.ceil(headerSize / p.segmentMax) * p.segmentMax
    const lastLen = p.plaintextLength - ((nSeg - 1) * p.segmentMax)
    const totalSize = firstBlockOffset +
        ((nSeg - 1) * p.segmentMax) + lastLen
    return {
        nSeg,
        nEp,
        headerSize,
        firstBlockOffset,
        totalSize,
        saltOffset: 0,
        commitmentOffset: 32,
        snapshotOffset: 32 + p.nh,
        epochHeadsOffset: 32 + (2 * p.nh),
        metaOffset: 32 + (2 * p.nh) + (nEp * p.nh),
        metaLen,
    }
}

export function segmentLength (l:Layout, p:LayoutParams, i:number):number {
    if (i < 0 || i >= l.nSeg) throw new AttachmentError()
    if (i < l.nSeg - 1) return p.segmentMax
    return p.plaintextLength - (i * p.segmentMax)
}

export function blockRange (
    l:Layout,
    p:LayoutParams,
    i:number,
):{ offset:number, length:number } {
    return {
        offset: l.firstBlockOffset + (i * p.segmentMax),
        length: segmentLength(l, p, i),
    }
}

export function metaRange (
    l:Layout,
    i:number,
):{ offset:number, length:number } {
    return { offset: l.metaOffset + (i * l.metaLen), length: l.metaLen }
}

export function epochOf (p:LayoutParams, i:number):number {
    return Math.floor(i / (2 ** p.epochLength))
}

export interface ByteRange { offset:number, length:number }

/**
 * The encrypted byte ranges needed to read and verify plaintext
 * [offset, offset+length): the fixed prefix (salt, commitment,
 * snapshot), the epoch-heads region, the metadata runs of every
 * touched epoch, and the touched segment blocks. Adjacent ranges
 * are coalesced.
 */
export function rangesFor (
    p:LayoutParams,
    offset:number,
    length:number,
):{ segFirst:number, segLast:number, ranges:ByteRange[] } {
    if (length <= 0 || offset < 0 ||
        offset + length > p.plaintextLength) {
        throw new AttachmentError()
    }
    const l = layout(p)
    const segFirst = Math.floor(offset / p.segmentMax)
    const segLast = Math.floor((offset + length - 1) / p.segmentMax)
    const perEpoch = 2 ** p.epochLength
    const epFirst = epochOf(p, segFirst)
    const epLast = epochOf(p, segLast)
    const ranges:ByteRange[] = [{
        offset: 0,
        length: l.epochHeadsOffset + (l.nEp * p.nh),
    }]
    for (let e = epFirst; e <= epLast; e++) {
        const first = e * perEpoch
        const count = Math.min(perEpoch, l.nSeg - first)
        ranges.push({
            offset: l.metaOffset + (first * l.metaLen),
            length: count * l.metaLen,
        })
    }
    for (let i = segFirst; i <= segLast; i++) {
        ranges.push(blockRange(l, p, i))
    }
    return { segFirst, segLast, ranges: coalesce(ranges) }
}

function coalesce (ranges:ByteRange[]):ByteRange[] {
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset)
    const out:ByteRange[] = []
    for (const r of sorted) {
        const last = out[out.length - 1]
        if (last && r.offset <= last.offset + last.length) {
            const end = Math.max(
                last.offset + last.length, r.offset + r.length,
            )
            last.length = end - last.offset
        } else {
            out.push({ ...r })
        }
    }
    return out
}
```

**Step 2: Verify and commit**

```bash
npm run build && npm run lint
git add src/attachment/layout.ts
git commit -m "attachment: aligned layout offset math"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-6) -->
<!-- START_TASK_3 -->
### Task 3: Whole-object seal and open

**Verifies:** random-access-attachments.AC2.1, AC2.2
(implementation).

**Files:**
- Create: `src/attachment/object.ts`

**Step 1: Create `src/attachment/object.ts`**

Implements the SEAL-attachment named instantiation (write-once,
derived nonces, epoch_length 10, snap_id 0x0003, aligned layout).

Exports:

```ts
export interface SealedObject {
    bytes:Uint8Array
    snapshot:Uint8Array
    salt:Uint8Array
}

export async function sealObject (
    cek:Uint8Array,
    objectId:Uint8Array,
    plaintext:Uint8Array,
    crypto:SealCrypto,
    opts?:{ salt?:Uint8Array },
):Promise<SealedObject>

export async function openObject (
    cek:Uint8Array,
    objectId:Uint8Array,
    bytes:Uint8Array,
    ref:{ snapshot:Uint8Array, plaintextLength:number },
    crypto:SealCrypto,
):Promise<Uint8Array>
```

`sealObject` behavior (write in this order):
1. Reject empty plaintext and empty or oversize (> 255) objectId
   with `AttachmentError`.
2. salt = `opts?.salt` (32 octets, tests only) or 32 fresh octets
   from `globalThis.crypto.getRandomValues`.
3. Build `SealParams` from the SEAL-attachment constants in
   `schedule.ts` (`PROTOCOL_RO`, crypto.aeadId, crypto.kdfId,
   `SEGMENT_MAX`, `SNAP_EPOCH_TREE`, `NONCE_DERIVED`,
   `ATTACHMENT_EPOCH_LENGTH`, salt); `startSeal(cek, params,
   objectId, crypto)` (G is the objectId).
4. Compute the layout via `layout()` with `nh = crypto.kdf.size`.
5. For each segment i: slice plaintext, `sealSegment` with
   `isFinal = (i === nSeg - 1)`, write the ciphertext into its
   block position, build `segmentLeaf`, write `leaf` into its
   metadata slot (`LH(ct) || tag`).
6. Group leaves into epoch runs, compute each `epochHead`, write
   into the epoch-heads region; compute `epochTreeRoot` over the
   concatenated heads; write salt, commitment, snapshot into the
   fixed prefix. The zero padding between header and first block is
   already zero from the `Uint8Array` allocation.
7. `wipeSealState(state)` (from `schedule.ts`) before returning;
   the CEK itself belongs to the caller.
8. Return bytes, snapshot, salt.

`openObject` behavior:
1. Recompute the layout from `ref.plaintextLength`; reject when
   `bytes.length !== totalSize`.
2. Parse salt from the header; rebuild params;
   `startOpen(cek, params, objectId, storedCommitment, crypto)`
   (AC1.3's gate).
3. Recompute every leaf from the stored blocks and metadata tags,
   every epoch head, and the root; compare the root against
   `ref.snapshot` (constant time) -- never against the stored copy.
   Also compare each stored metadata leaf and each stored epoch
   head against the recomputed values, and the recomputed root
   against the stored snapshot field only as a consistency check
   AFTER the ref comparison has passed (a mismatch there is also
   `AttachmentError`).
4. `openSegment` each block (passing the metadata tag), concatenate
   plaintext, return it.
5. Every failure path throws `AttachmentError` only.
6. `wipeSealState(state)` in a `finally` around steps 3-4.

Implementation note: derive per-epoch segment keys once per epoch
run rather than per segment if simple to do; otherwise per-segment
derivation is acceptable in this phase (performance work is out of
scope).

**Step 2: Verify and commit**

```bash
npm run build && npm run lint
git add src/attachment/object.ts
git commit -m "attachment: whole-object seal and open"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Snapshot, layout, and object tests

**Verifies:** random-access-attachments.AC2.1, AC2.2, AC2.3, and
the engine-vector snapshot fields of AC1.1.

**Files:**
- Create: `test/attachment/snapshot.ts` (unit)
- Create: `test/attachment/layout.ts` (unit)
- Create: `test/attachment/object.ts` (unit)
- Modify: `test/unit.ts` (register all three)

**Step 1: `test/attachment/snapshot.ts`**

Consume the vendored engine vectors (`test_vectors/seal/engine/`):
for each vector that carries multiset values (accumulator,
snapshot, wrapped/masked accumulator -- use the field names as they
actually appear; read the files first), recompute via
`multisetContrib`/`multisetSnapshot`/`multisetMask` from the
vector's tags and compare hex. If an engine vector's fields do not
match, treat the vector as authoritative: adjust the label
constants in `snapshot.ts`, comment which vector pins them, and
re-run. Do NOT skip the assertion. Fallback (decided now, not at
execution time): if NO vendored vector carries multiset snapshot
fields at all, delete the multiset section from `snapshot.ts` and
its tests in the same commit, stating so in the commit message --
untestable code does not ship in an opt-in subsystem.

**Step 2: `test/attachment/layout.ts`** (AC2.3)

Pure math tests, no crypto:
- Sizes: single-segment (1 byte; 65536 exactly), boundary
  (65537), multi-epoch (a `plaintextLength` of
  `65536 * 1025 + 5` gives nSeg 1026, nEp 2 -- construct the
  expectation from the header formula, not from the code).
- `layout` throws on 0 and negative lengths.
- `rangesFor`: for each size above and several (offset, length)
  pairs including cross-segment and cross-epoch spans, assert the
  returned ranges exactly equal hand-computed expectations
  (prefix+heads range, correct epoch meta runs, correct blocks),
  are sorted, non-overlapping, and coalesced.
- `rangesFor` throws on offset+length past the end, zero length,
  negative offset.

Use small synthetic `LayoutParams` (e.g. segmentMax 64,
epochLength 2, nh 32) alongside the real 65536/10 constants so
multi-epoch cases stay cheap.

**Step 3: `test/attachment/object.ts`** (AC2.1, AC2.2)

Use `sealCryptoFromIds(2, 1)` (AES-256-GCM + HKDF-SHA-256), a
fixed 32-octet salt, a fixed CEK, objectId `ascii('test-object')`,
and a deterministic plaintext of `(2 * 65536) + 17` counter bytes:
three segments (two full blocks plus a 17-byte final block),
~128 KiB in memory.
- AC2.1: `sealObject` then `openObject` with the returned snapshot
  and correct length round-trips to the identical plaintext.
  Assert `bytes.length` equals `layout(...).totalSize`.
- AC2.2 drop-final: truncate `bytes` to remove the last block and
  pass a correspondingly shortened buffer with the ORIGINAL ref;
  `openObject` rejects (length check). Also: keep full length but
  zero the final block; rejects (leaf mismatch).
- AC2.2 reorder: swap block 0 and block 1 in place; rejects.
- AC2.2 cross-object substitution: seal a second object with the
  same CEK-derivation inputs except a different salt; copy its
  block 1 over the first object's block 1; rejects.
- AC2.2 bit flips: flip one byte in a block; flip one byte in a
  metadata leaf; flip one byte in an epoch head; flip one byte in
  the stored snapshot field; each rejects.
- Wrong ref snapshot (flip a byte in `ref.snapshot`): rejects even
  though the object itself is intact.
- All rejections assert `err instanceof AttachmentError`.

**Step 4: Register and run**

Add to `test/unit.ts`:

```ts
import './attachment/snapshot.js'
import './attachment/layout.js'
import './attachment/object.js'
```

```bash
npm run test:unit
```

Expected: all pass.

**Step 5: Commit**

```bash
git add test/attachment test/unit.ts
git commit -m "attachment: snapshot, layout, and object tests"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Freeze our own epoch-tree vectors

**Verifies:** random-access-attachments.AC2.1 (regression lock; the
epoch digest tree has no external vectors yet).

**Files:**
- Create: `scripts/generate-seal-own-vectors.ts`
- Create: `test_vectors/seal/own/epoch-tree.json` (generated)
- Modify: `test/attachment/object.ts` (add the frozen-vector test)

**Step 1: Write the generator**

`scripts/generate-seal-own-vectors.ts`: with fixed CEK (32 bytes of
0xAA), fixed salt (32 bytes of 0x04), objectId `ascii('own-vector')`,
and plaintext = 65536 + 100 bytes of an incrementing counter,
call `sealObject` (AES-256-GCM + HKDF-SHA-256) and build JSON with
hex of: cek, salt, object_id, plaintext_length, commitment,
snapshot, the first 64 bytes of the object, and SHA-256 of the full
object bytes (via the crypto bundle's hash).

Output mechanism (fixed now; phase 3 extends this same script): the
script writes its output files ITSELF via `node:fs` --
`mkdirSync('test_vectors/seal/own', { recursive: true })` then
`writeFileSync('test_vectors/seal/own/epoch-tree.json', ...)` with
two-space-indented `JSON.stringify` and a trailing newline. Each
output file is written unconditionally on every run; determinism of
the inputs makes re-runs byte-identical (phase 3 adds a second
output file to the same script without touching this one). Run it
with the single-file esbuild pattern:

```bash
npx esbuild scripts/generate-seal-own-vectors.ts --bundle \
  --platform=node --format=cjs --loader:.json=json --keep-names \
  --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
```

Also write `test_vectors/seal/own/README.md` (by hand, not
generated): a short format description for external implementers --
what each field is, the fixed inputs, the SEAL-attachment
configuration (SEAL-RO-v1, AES-256-GCM, HKDF-SHA-256, derived
nonces, epoch_length 10, snap_id 0x0003), and which draft revisions
the bytes track. This is the design's "publish our own KAT files"
requirement.

Note on type checking: `scripts/*.ts` sit outside
`tsconfig.json`'s include, so `npm run build` does not type-check
them; eslint does lint them. Keep the generator a thin driver over
the library functions (which ARE type-checked and tested).

**Step 2: Add the frozen test**

In `test/attachment/object.ts`: import the JSON, re-run the same
seal, assert snapshot hex, commitment hex, and full-object digest
match. A future change that alters our bytes fails this test and
forces a conscious re-freeze.

**Step 3: Run, verify, commit**

```bash
npm run test:unit && npm run lint
git add scripts/generate-seal-own-vectors.ts test_vectors/seal/own \
  test/attachment/object.ts
git commit -m "attachment: freeze epoch-tree object vectors"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Phase verification

**Verifies:** phase gate for AC2.1-AC2.3.

```bash
npm run lint && npm run build && npm run test:unit && \
  npm run test:fast
git status --porcelain
```

Expected: all green; empty status (no stray bundles or temp files).
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->

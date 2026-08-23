# src/attachment

Last verified: 2026-08-22

Random-access encrypted attachments: draft-sullivan-cfrg-raae-02 (the
RA-AE / SEAL construction) under `schedule.ts`, `snapshot.ts`,
`layout.ts`, `object.ts`, `kdf.ts`, `crypto.ts`, and
draft-sullivan-mls-attachments-01 (CEK derivation and the wire
reference) under `keys.ts`, `reference.ts`. `writer.ts`, `reader.ts`
and `range.ts` are the three entry points a caller uses: seal a whole
object, stream it back sequentially, read a byte range out of the
middle.

The drafts are drafts. `ATTACHMENT_COMPONENT_ID` is a private-use
placeholder for an unallocated IANA value and `ATTACHMENT_REF_VERSION`
is ours, so nothing here is a stable wire format yet.

## Nothing reaches this directory from src/index.ts

The subsystem is opt-in, and that is enforced rather than intended:
`scripts/check-attachment-invariants.mjs` runs ahead of every
`npm run test:node` and fails the run if `src/index.ts` so much as
contains the string `attachment`. Consumers reach it through the
package's `./*` subpath export instead. Re-exporting from `index.ts`
would put the whole SEAL implementation into the bundle of every
application that imports the library for MLS alone.

## Two more invariants the same script enforces

`reader.ts` must not pull in `range.ts`. The dependency runs one way --
`range.ts` imports `parsePrefix`, `verifyRoot`, `verifyEpochRun` and
`openBlock` from `reader.ts` -- and it has to stay that way, because
reversing it would create a cycle. That is the reason for this ban --
not a metadata cost, which is what an earlier version of this file
claimed. The `keys.ts` ban below has a different reason; do not merge
the two.

`keys.ts` must pull in no SEAL module at all. CEK derivation is
separable from the encryption scheme, so a caller can key a foreign
scheme from an MLS group; a convenience import of `crypto.ts` or
`schedule.ts` for one constant is what quietly ends that.

The script checks imports by bundling with esbuild and reading the
metafile, so a type-only import does not trip it but a value import
anywhere in the transitive graph does.

## Randomness arrives on the bundle

No file under this directory calls `getRandomValues`, and the invariant
script scans every one of them for the bare identifier to keep it that
way. The single value that needs entropy is the 32-byte object salt,
which `sealObject` takes from `crypto.rng.randomBytes(32)`.

`rng` is a required field on `SealCrypto`, not an optional one:
`sealCryptoFromCiphersuite` carries the ciphersuite's, and
`sealCryptoFromIds` takes one as an optional trailing argument
defaulting to `defaultRng`. A caller assembling a `SealCrypto` by hand
has to supply it.

`opts.salt` on `sealObject` and `encryptAttachment` is the seam the
vector generator uses, and it is for tests and vectors only. An
earlier version of this file recommended it for deterministic output
generally; that recommendation no longer holds. `payloadKey`,
`snapKey` and `nonceBase` derive from `(cek, salt)` and nothing else
-- the objectId enters the commitment alone -- so two seals under one
CEK and one pinned salt reuse the segment key and nonce, and the two
ciphertexts XOR to the two plaintexts. Pinning the salt is safe only
when the CEK is also fresh per object, which is why the generator gets
away with it. `encryptAttachmentForGroup` does not accept a salt at
all: its CEK comes from `attachmentCek`, which binds the objectId, but
the pair still has to vary and there is no caller-visible reason to
pin one half of it.

## A caller-supplied CEK is checked for length, once

`assertCekLength` lives in `keys.ts` next to `CEK_LENGTH`, and
`sealObject` and `openObject` call it before anything else.
`encryptAttachment` inherits the check through `sealObject` and has no
guard of its own -- a second copy would be dead code no mutation test
could reach.

The check matters more on the open path than it looks. HKDF takes
keying material of any length, so a short CEK *seals* happily and just
uses less entropy than the design assumes; that half is caught by the
absence of a throw. On open, a wrong-length CEK would be rejected
anyway, by the commitment, several derivations later -- so a test that
only asserts `AttachmentError` there passes with the guard deleted.
`test/attachment/cek-length.ts` wraps the KDF in a call counter and
asserts zero derivations, which is what actually pins the guard.

## The one dependency outside this directory

`attachmentCek` reads `KeySchedule.applicationExportSecret`, derived in
`src/key-schedule.ts` from the epoch secret with label
`application_export`. That field is new, and it sits alongside the RFC
9420 Table 4 secrets, so every `KeySchedule` consumer now sees it.

It is deliberately *not* carried into `EpochReceiverData` by
`addHistoricalReceiverData` (`src/client-state.ts`). A receiver that
has advanced an epoch therefore cannot derive the CEK for an attachment
sealed in the previous one. That is an open decision, not a settled
design -- see "Known Limitations" in
`docs/design-plans/2026-08-19-random-access-attachments.md` before
building anything that assumes attachments survive a commit.

## One error type, on purpose

Every failure here throws `AttachmentError`, which carries no detail
and always the same message. A commitment mismatch, an AEAD reject, a
snapshot mismatch and a malformed reference must be indistinguishable
to the caller. Do not attach a `cause`, a code, or a subclass, and do
not reach for the library's `ValidationError` / `InternalError` split
described in the root `AGENTS.md`: that split is informative by design
and this one is not.

One exception, and it is on the write side: the seal path does not
wrap. `encryptAttachment` and `encryptAttachmentForGroup` throw
`AttachmentError` from their own guards, but an error raised by the
supplied ciphersuite -- an `hpke.encryptAead` that rejects, say --
propagates out untouched. That is deliberate. The opacity rule exists
so a reader cannot tell one integrity failure from another; a writer's
own crypto blowing up is not an integrity signal about anyone's data
and hiding its cause only makes it harder to debug. A test that
injects a write-side failure should pin the throw by identity, not
assert `instanceof AttachmentError`.

## Which layer a guard can be pinned at

One opaque error type means a guard standing behind another guard
cannot be told apart from it: delete the inner one and the outer one
throws the identical `AttachmentError`. Several checks here are depth
rather than sole defense, and a test that names one of them has to be
written at the layer where it is the only thing that can throw.

The ones known to be shadowed, and where their tests live:

- `segmentKey`'s index guard sits in front of an identical one in
  `segmentAad`, so `sealSegment` and `openSegment` cannot pin it. It is
  pinned by calling `segmentKey` directly in
  `test/attachment/seal-validation.ts`. Its `index < 0n` half is
  shadowed further by `uint64be` and is not pinnable at all.
- `openSegment`'s tag-length guard is shadowed by the AEAD, which also
  rejects a short tag. Its test wraps `aead.decrypt` in a counter and
  asserts the count is zero, so the guard is pinned by the AEAD never
  running rather than by the error.
- `openBlock`'s leaf comparison cannot be reached first through the
  stream or range API -- a tampered metadata leaf changes its epoch
  head, so `verifyEpochRun` rejects first, and tampering ciphertext or
  tag is the AEAD's job. It is pinned in
  `test/attachment/reader-header.ts` by calling `openBlock` on a
  `HeaderContext` whose leaf digest half was corrupted after
  `verifyHeader` returned. The stream-level test is a reachability
  smoke test and says so.
- `range.ts`'s `!blockData` guard is unreachable while the per-stream
  length comparison above it stands, because the sparse view is keyed
  by the same ranges the decrypt loop walks. It stays as depth and is
  commented as such; the length comparison is pinned by an over-long
  range stream, the case where nothing else objects.

When adding a guard, work out which of these it is and say so in a
comment next to it. A test titled after a guard that another guard
shadows is worse than no test: it reports coverage that is not there.

## The zero-padding invariant

`layout()` rounds the first segment offset up to the next `segmentMax`
boundary (currently 64 KiB). This leaves a gap between the header and
the first segment whose size depends only on plaintext length and
cipher suite. The segment-aligned offset is computable from those two
values alone, which makes HTTP Range requests possible without a
manifest. The writer leaves the gap zero implicitly: `sealObject`
allocates a zero-initialised buffer and never writes to that region.

All three read paths reject a non-zero gap with `AttachmentError`:

- `openObject` calls `isZeroRegion` to check the gap immediately after
  its length check.
- `decryptAttachmentStream` checks each span as the gap-skipping loop
  in `start()` trims it, rejecting the first non-zero byte encountered.
- `range.ts` checks it in `decryptRangeStream`'s `start()`, after the
  per-range length checks and before `parsePrefix`, so nothing is
  decrypted and no plaintext is emitted on a bad gap.

The range path can only do that because `rangesFor()` fetches the gap.
It emits `[headerSize, firstBlockOffset)` as its own range whenever
that interval is non-empty, purely so this check is possible -- no
byte in it is otherwise needed. Coalescing usually merges it with the
metadata runs on one side and the first fetched block on the other, so
it often does not appear as a distinct entry in `ranges`. An earlier
version of this file said the range path structurally could not check
the gap; that was true of the ranges as they were then and is not true
now. Do not restore the omission.

The cost is real and was accepted deliberately: the gap is up to
`segmentMax - 1` bytes (just under 64 KiB), so a one-byte range read
fetches that much extra. Parity across the three paths was judged
worth it.

The gap is empty only when `headerSize` lands exactly on a `segmentMax`
boundary. `rangesFor` emits no zero-length range in that case, and
`decryptRangeStream` skips the check under the same
`firstBlockOffset > headerSize` guard. The first real object sizes
where that happens are around 85 MiB at nh=32, too large to seal in
the test suite, so the empty-gap branch is pinned by the synthetic
`rangesFor` test in `test/attachment/layout.ts` rather than by a
round-trip.

Why the check exists: without it, two byte-different stored objects
verify as the same attachment, which breaks any content-addressed
locator.

## CEK zeroization: residual gaps

The three wrapper functions derive a fresh CEK and pass it into the
encryption or decryption machinery. The CEK is the wrapper's to wipe,
and phase 2 wipes it on five exit paths per function:

- Successful operation (writer only). `encryptAttachmentForGroup`
  wipes in a `finally`, so its throw path is covered by the same
  line; the two stream wrappers have no success path to wipe on,
  because the CEK outlives the call.
- Stream construction throw (reader and range only)
- Stream operations throw or error
- Stream or read is cancelled
- Close is called on a range read (shape-3 seek-then-abandon only)

`SealState` zeroization follows the same list, and both
`reader.ts` and `range.ts` use the same two-latch `doWipe`: one latch
for the state, one for the CEK. A cancel that lands while `start()` is
parked on an await finds `ctx` still null, so the state latch must not
be set by that call -- otherwise the later `doWipe`, once `ctx`
exists, is swallowed and `payloadKey`, `snapKey` and `nonceBase` stay
live.

### The epoch key cache

`segmentKey` derives from the payload key and the epoch index alone, so
all 2^`epochLength` segments of an epoch share one key. `SealState`
carries an `epochKeys` map keyed by epoch index and `segmentKey` fills
it on the first segment of each epoch; later segments are a map lookup.
Earlier revisions of this file described a per-segment derivation with
the caller wiping the key in a `finally`; that no longer holds.

Two consequences worth keeping in mind:

- **The returned key is the state's, not the caller's.** `segmentKey`
  hands back the cached array rather than a copy. Zeroing it would
  poison every remaining segment of the epoch, which is why
  `sealSegment` and `openSegment` no longer wipe it. Treat it as
  read-only.
- **`wipeSealState` owns the cache.** It zeroes each buffer and then
  clears the map. Clearing alone would hand live epoch keys to the
  garbage collector, so both halves matter; both are pinned by
  `test/attachment/epoch-key-cache.ts`.

Nothing in `src/` serializes a `SealState` -- there is no
`JSON.stringify`, `structuredClone` or `postMessage` of one anywhere --
so a `Map` field costs nothing at a wire boundary. Anything that adds
serialization later must exclude `epochKeys`, which is recoverable
from `payloadKey` and cheaper to re-derive than to transport.

`range.ts` needs one thing beyond the latches. Its `start()` drains
the caller's range streams and then does the whole decryption, and
nothing about a cancel stops those awaits from resuming. It therefore
sets a `cancelled` flag in `cancel()` and re-checks it after every
await in `start()` -- after each drain, after `verifyRoot`, after each
`verifyEpochRun`, and before each `openBlock`. Throwing there routes
the wipe through `start()`'s catch, which by then has a `ctx`, and
stops the read from decrypting a window nobody will consume. Erroring
an already-cancelled stream is a spec no-op, so the throw does not
surface. Both halves are pinned by the 'range null-ctx cancel' test in
`test/attachment/cek-wipe.ts`.

`startOpen` wipes too. It has to derive the whole schedule before it
can recompute the commitment, so by the time the gate rejects an
object, `payloadKey`, `snapKey` and `nonceBase` already exist. It
calls `wipeSealState` on that state before throwing. The thrown error
is deliberately unchanged -- a bare `AttachmentError`, saying nothing
about why the open failed. Callers that hold the returned state are
unaffected, because a throwing `startOpen` never returns one.

The commitment gate is shadowed on every public read path. Delete the
compare in `startOpen` and `openObject`, `decryptAttachmentStream` and
`openAttachmentRange` all still reject a wrong CEK and a wrong
objectId, because the snapshot root check also derives from the CEK and
fires first. So the gate is pinned only where it is the sole thing that
throws: `test/attachment/seal-core.ts` calls `startOpen` directly and
asserts it rejects before touching the AEAD.
`test/attachment/commitment-gate.ts` is the separate reachability half
-- it proves the entry points reach a rejection at all and that all of
them raise the identical opaque error, and it is deliberately not
mutation-sensitive to the gate.

The reader's `start()` takes `ciphertext.getReader()` inside its own
`try`, not before it. An already-locked input stream makes that call
throw a raw `TypeError`, and outside the guarded region that TypeError
escaped as-is with the owned CEK still live. Anything that can fail in
`start()` belongs inside the try; the catch is what converts a failure
into `AttachmentError` and wipes.

Two gaps remain:

1. **Reader stream constructed, never read, never cancelled:** A
   `decryptAttachmentStream` whose stream is never touched leaks its
   CEK, its `SealState`, **and one buffered segment of decrypted
   plaintext** (the auto-pull at `highWaterMark: 1`). There is no
   disposal hook on a bare `ReadableStream` to close this gap without a
   breaking API change to make it return a closeable object. This is
   recorded as a known limitation in the design plan.

2. **Range read constructed, never read, never closed:** a range read
   whose `decrypt` is never called leaks its CEK. `.close()` wipes it,
   but only when this layer owns the key, which means only when the
   read was opened with `opts.ownedCek`. `close` is a REQUIRED member
   of `AttachmentRangeRead`, so `if (read.close)` is not a test for
   whether a key gets wiped -- it always passes. What varies is what
   `close()` does, not whether it exists.

   `openAttachmentRangeForGroup` passes it, so a read opened that way
   is single-use: after any stream ends or `close()` is called, a
   later `decrypt` errors when it verifies the commitment against
   zeros. Calling `openAttachmentRange` directly with your own cek and
   no `opts` gives you a `close()` that wipes nothing, deliberately --
   the key is the caller's and wiping it underneath them would be
   wrong -- and such a read is NOT single-use. Wipe your own key.

   Verified rather than assumed: `wipeCek` is
   `opts?.ownedCek?.fill(0)`, so with no `ownedCek` it sets its latch
   and returns having zeroed nothing.

## Exporter-tree zeroization

`safeExportSecret` walks 16 levels from `applicationExportSecret` to
the component secret. Every node it derives is wiped as soon as its
child exists, and the node in hand is wiped on the throw path too.
The root is the exception: it belongs to the caller's `KeySchedule`,
which outlives the derivation, so the walk compares each node against
it by identity and never wipes it.

`attachmentCek` then wipes the component secret in a `finally`. That
secret derives the CEK for every objectId in the epoch, so it is
worth more than any one CEK; the `finally` covers the throw path,
where nothing else holds a reference to clear it.

`safeExportSecret` is exported and its return value is NOT wiped --
that is the caller's buffer once it returns. `attachmentCek` is the
only caller in `src/` and it does own that buffer.

Covered by `test/attachment/exporter-tree-wipe.ts`, which records
`kdf.expand` outputs and can make a chosen expand throw.

## What the vectors do and do not prove

`test_vectors/seal/core/` and `engine/` are vendored byte-for-byte from
swift-raae at a pinned commit and must not be edited. The invariant
script also checks that every JSON file in those directories is
imported by `test/attachment/vectors-all.ts`, so vendoring a vector
without wiring it up fails the run rather than passing silently. It
also pins the counts stated in `test_vectors/seal/README.md` -- 6 core,
3 engine -- and checks that each engine file is byte-identical to the
core file of the same name, which it currently is. The 9 files are
therefore 6 vectors' worth of data.

Every field in those files is asserted; there is no commented-out
remainder. Two are worth knowing about before adding more. `F23` is
SEAL-simple: its `stored_object_hex` is header-plus-one-segment with no
epoch heads and no snapshot, so it is *not* the layout `sealObject`
writes and must not be handed to `openObject`; the sweep composes it
from the derived commitment and a re-sealed segment instead. And
`F17`'s AEAD is AES-256-GCM-SIV (id 31), which this library does not
implement, so anything in that vector guarded by `SUPPORTED_AEAD_IDS`
-- including the `rewrite_segment_0` ciphertext -- is checked on the
KDF side only.

`test_vectors/seal/own/` is self-generated by
`scripts/generate-seal-own-vectors.ts` from fixed inputs. It detects
unintended change and nothing more. The epoch digest tree
(`snap_id 0x0003`) and the attachment CEK derivation have no external
implementation to disagree with, so those two are locked only by our
own output.

`scripts/check-vector-determinism.mjs` is what turns that into a gate.
`npm run test:node` runs it after the invariant script: it regenerates
the directory into a temp dir and compares the two sets both ways, so a
committed vector the generator no longer produces fails as loudly as an
altered one. There is no TypeScript runner in devDependencies, so
the generator is not invoked directly:
`scripts/check-vector-determinism.mjs` bundles it with esbuild and
runs the bundle with the target directory as its one argument.

## Interop needs a Swift toolchain, in debug

`npm run test:interop` builds `interop/seal-cli`, a SwiftPM executable
over swift-raae, and round-trips schedules and segments through it. It
must be a **debug** build: the CLI uses `@testable import RAAE` to reach derived
schedule values and the package-scoped `Segment.encryptRandom`, which
swift-raae's public API does not expose, and `@testable` requires
`-enable-testing`. A release build will not compile. CI runs this on
macos-14 only, so a Linux-only contributor never sees it fail.

A machine without the toolchain skips the run and exits 0. On CI it
fails instead: `scripts/interop-toolchain.ts` reads `CI` and returns
`fail` when it is set to anything non-empty, so a runner that lost its
Swift toolchain cannot hand back a green interop job that compared
nothing. The decision is a pure function in its own module precisely
so it can be tested (`test/interop-toolchain.ts`) -- importing
`interop-seal.ts` compiles the Swift CLI as a side effect. Keep that
module free of `node:` imports: `tsconfig.json` narrows `types` to
vite's, so the test that imports it would otherwise fail the
typecheck.

It covers the SEAL core -- framed KDF, payload schedule, derived
nonces, epoch keys, per-segment seal and open. It does not cover
`snap_id 0x0003`, which swift-raae does not implement. swift-raae also
rejects `snap_id 0x0003` as `ScheduleError.unsupportedSnapID` at
`KeySchedule.swift`, and that check runs BEFORE the profile-tuple
guard, so swift-raae never evaluates our pairing and expresses no
opinion on it. The pairing is the conformant one: draft-02 defines
`SEAL-attachment` as a named instantiation over `SEAL-RO-v1` with
exactly that snap_id (`Spec/NOTES.md`). The gap is an upstream
implementation gap, not a verdict on this implementation. Pinned by a
live assertion in the interop harness, which will fail the day
upstream implements it.

## Verification parity: openObject and decryptAttachmentStream

`openObject` and the streaming reader `decryptAttachmentStream` verify
the same sealed object independently and intentionally. Both run the
same core algorithm: recompute each leaf as `segmentLeaf(ciphertext,
tag)`, fold leaves into an epoch head via `epochHead`, fold heads into
a root via `epochTreeRoot`, and compare the root against the reference
snapshot.

The two paths do not share verification logic because their structural
differences make sharing impractical. `openObject` has the whole object
buffered and verifies it synchronously before decryption. The streaming
reader splits the work across `parsePrefix`, `verifyRoot`,
`verifyEpochRun` and `openBlock` so that `range.ts` can call just the
pieces a seek operation needs. Merging them would force `openObject` to
adopt streaming state machinery and lazy verification it has no use for,
without removing the risk that two paths might diverge.

The safeguard against silent divergence is the differential test in
`test/attachment/parity.ts`. It mutates a sealed object at a
deterministic list of offsets, one or two per region of the layout --
salt, commitment, stored snapshot, epoch head, both halves of a
metadata leaf, the padding gap, and segment ciphertext -- and asserts
that all THREE paths, including the range path, return the same
verdict at each. The range path runs a one-byte window at plaintext
offset 0, whose fetched ranges cover every offset in the sweep; the
one header region it does not fetch is the second epoch's metadata
run, and no offset lands there. It is a probe of every
region, not a sweep of every byte; weigh it accordingly before
concluding a refactor is safe.

### Deliberate asymmetries

Four asymmetries remain between the paths after verification is
complete. They are not defects. They stem from the different input
types and the different shapes of the operations, and they are
documented here so a reader considering unification does not mistake
them for bugs to fix.

#### Ref version checking

`openObject` takes a structural object `{ snapshot:Uint8Array,
plaintextLength:number }`, not an `AttachmentRef`. It has no version
field to check. The streaming reader via `decryptAttachmentStream`
receives a real `AttachmentRef` and calls `validateAttachmentRef` to
enforce the `version` field per `reference.ts`. Task 1 aligned the two
paths on `objectId` and `plaintextLength` validation, so that
asymmetry is narrower than it was, but the `version` check has no
counterpart in `openObject` and cannot be added without changing its
signature. That signature change is not in scope.

`validateAttachmentRef` also checks the snapshot length, and it takes
an optional `kdfSize`. A ref carries no ciphersuite, so a caller with
no crypto in hand can only check membership in `SNAPSHOT_LENGTHS`
(32, 48, 64 -- the KDF output sizes of the supported suites);
`decryptAttachmentStream` and `openAttachmentRange` have a
`SealCrypto`, so they pass `crypto.kdf.size` and pin the one length
that can be right. `openObject` has no ref and therefore no such
check, but it is not exposed: `constantTimeEqual` returns false for
unequal lengths before comparing anything, so a wrong-length snapshot
fails the root gate there. Both layers have their own test
(`test/attachment/ref-snapshot-length.ts` and
`test/util/constant-time-compare.ts`); neither may be removed on the
grounds that the other covers it.

#### Lazy leaf-run verification

`openObject` verifies every leaf and every epoch head before decrypting
anything. The loop at `object.ts` inside `openObject` recomputes all
leaves and stores all heads before the call to `openSegment`.

The streaming reader verifies the root against the stored heads upfront
in `verifyRoot`, then verifies each epoch's leaf run lazily via
`verifyEpochRun` as the stream reaches that epoch. A consumer who
cancels partway through never verifies the leaf runs of epochs it never
read.

This is correct, and the reasoning is important to record because it
looks alarming.

Both paths bind the stored epoch heads before any plaintext is
released, but by different means -- see "Which heads the root is
computed from" below. In the streaming reader, `verifyRoot` folds the
stored heads into the root, so a tampered stored head fails the root
check upfront. Lazy verification therefore defers only the
leaf-run-to-head binding, and only for data the consumer never
receives. A partial read that returns no bytes from epoch 5 owes no
guarantee about epoch 5's leaf run, because the head covering epoch 5
was already checked and no epoch-5 plaintext was handed over.

Do not extend that argument to `openObject`. Its root is computed from
recomputed heads, so the root check there cannot detect a tampered
stored head; the explicit head comparison is what does. Deleting that
comparison as redundant would open a real hole, and the differential
test's epoch-head offsets are what catch it.

#### Emission before detection

For a mutation inside segment N, the streaming reader legitimately
emits segments 0 through N-1 before erroring when it detects the
mutation. `openObject` emits nothing; it detects all mutations before
decryption and rejects the entire object. Both reject the object; they
differ in what the consumer saw first.

This is correct on both paths. The streaming path is correct because it
validates the root and all headers before emitting any plaintext,
catching header mutations before emission. A plaintext emission means
the header has already passed the root and commitment checks. The
mutation is inside a segment, which affects only that segment's leaf;
the epoch head is unaffected. The stream emits segments that have
already been validated as part of a validated epoch, so partial
emission is safe.

Tests that assert "no plaintext emitted" must be restricted to
mutations detectable from the header. Mutations inside a segment should
not carry that assertion for the streaming path, since partial emission
is legitimate behavior.

#### Which heads the root is computed from

Found during phase 4 execution rather than anticipated by its plan, and
recorded here because it is the reason the lazy-verification argument
above has to be scoped to one path.

`openObject` folds the RECOMPUTED epoch heads into the root. The
streaming reader's `verifyRoot` folds the STORED heads. Both paths bind
the stored heads before releasing plaintext, but at different points in
the chain: `openObject` does it with an explicit constant-time
comparison of each recomputed head against its stored counterpart, and
the reader does it transitively, because a tampered stored head changes
the root it computes.

They are security-equivalent today, and the differential test agrees at
every epoch-head offset it probes. The practical consequence is about
where the load is carried. In the reader, the stored-head binding is
enforced twice over. In `openObject` it rests entirely on the head
comparison, so that comparison is not defence in depth and must not be
removed as redundant. Disabling it makes `openObject` accept a tampered
stored head that the streaming path still rejects, which is a
divergence rather than a shared weakening.

## Zero-length chunks are legal input

`decryptAttachmentStream` takes whatever `ReadableStream` the caller
has, and a `TransformStream`, a socket adapter or a `fetch` body can
enqueue a zero-length `Uint8Array` at any point, including on the read
immediately before `done`. Every loop in `reader.ts` that consumes the
source must therefore decide "is there data here" by `value.length`,
never by the truthiness of `value` -- an empty `Uint8Array` is truthy.

The end-of-stream check in `pull` is the one place this is easy to get
wrong, because it is the only loop that wants to see nothing. It reads
until `done` and accumulates lengths, breaking early once it has seen a
single byte so a large trailing garbage stream is not drained. Reading
exactly once and testing `result.value` reports a legal trailing empty
chunk as trailing ciphertext, which surfaces to the consumer as an
`AttachmentError` -- an integrity failure on a perfectly good object.
`test/attachment/streams.ts` pins this with `chunkedWithEmpties` from
`test/attachment/stream-helpers.ts`, alongside the trailing-bytes and
truncation cases that must still reject.

## The reader's chunk queue must stay O(1) per byte

A source may emit one byte per chunk, so the number of chunks the
reader buffers is bounded only by the block size -- 65536 for a full
segment. Anything the reader does per `read()` that touches every
buffered chunk is therefore quadratic in the chunk count.

Two such things were there and are gone: summing the buffer with
`reduce` to decide whether a block had arrived, and `Array.shift` to
consume it (shift moves every remaining element). `reader.ts` now keeps
`bufferedBytes` as a running total updated by `pushChunk` and
`consumeFront`, and a `bufferHead` index instead of shifting. Any new
code that reads the buffer must go through those helpers, or the totals
and the queue drift apart. On a 132096-byte object from a 1-byte-chunk
source this is the difference between 44s and 104ms;
`test/attachment/small-chunks.ts` pins it with a wall-clock budget.

## Reaching a second epoch costs a 64 MiB object

`ATTACHMENT_EPOCH_LENGTH` is 10, so segment 1024 is the first whose key
comes from epoch 1, and `SEGMENT_MAX` is 65536, so the smallest object
that has a whole segment past the first epoch is 1025 * 65536 =
67,174,400 octets of plaintext. There is no cheaper route: `reader.ts`
and `range.ts` read both constants from `schedule.js` rather than from
a parameter, so a synthetic `LayoutParams` with a tiny `segmentMax`
pins `layout.ts` arithmetic but cannot reach either read path.

`test/attachment/multi-epoch-fixture.ts` therefore seals that object
once per run behind a cached promise and hands the same
`MultiEpochFixture` to every caller. A test that needs a second epoch
awaits `multiEpochFixture()` and treats what it gets as read-only;
sealing a second one adds another half second to the suite for nothing.

## The entry-point JSDoc is part of the contract

`sealObject`, `openObject`, `encryptAttachment`,
`decryptAttachmentStream`, `openAttachmentRange`, `EncryptedAttachment`,
`SealCrypto`, `encodeAttachmentRef` and `validateAttachmentRef` each
carry JSDoc that states three things beyond the parameter list: what
the function throws, what memory it owns and wipes, and what it
deliberately does not own. That is the only place a consumer can learn
any of it, because `AttachmentError` is bare and ownership is invisible
in the types.

So when a change moves a guard, adds a throw, or changes who wipes a
key, update the JSDoc in the same commit. A wrong ownership sentence is
worse than none: a caller who believes an entry point wipes their CEK
will not wipe it themselves.

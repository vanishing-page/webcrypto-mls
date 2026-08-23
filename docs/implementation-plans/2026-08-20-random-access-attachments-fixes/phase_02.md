# Random-Access Attachment Fixes Implementation Plan

**Goal:** Make the three `...ForGroup` wrappers zeroize the CEK they
derive on every exit path the existing machinery can reach, and record
precisely the two paths it cannot.

**Architecture:** Each wrapper derives a fresh CEK via `attachmentCek`
and hands it downstream. The caller never sees the buffer, so the
caller cannot wipe it either; the wrapper is the owner and therefore
the only party that can.

There are **four** distinct exit shapes. Getting this wrong is easy and
this plan has done it twice: one revision handled only shape 2 and
claimed "every exit path", and the next enumerated three and certified
the list complete. Treat the list below as the current best
understanding, not as proven exhaustive.

1. **Construction throws.** `decryptAttachmentStream` throws
   synchronously at `reader.ts:295` (`validateAttachmentRef`) and
   `298-301` (`plaintextLength` bounds), before any `ReadableStream`
   exists. `openAttachmentRange` throws at `range.ts:41`, `44-47`,
   `50-53`, and inside `rangesFor` at 66. On these paths no stream is
   ever built, so nothing downstream can wipe. Only a `try/catch` in
   the wrapper can.
2. **Stream lifetime.** Once a stream exists, the CEK must survive
   until the stream ends, so a `try/finally` in the wrapper would wipe
   the key while it is still in use. These paths thread the buffer into
   the wipe machinery that already exists: `doWipe` at
   `reader.ts:319-324`, called from 433, 457, 510 and `cancel()` at
   520; and `range.ts`'s four wipe sites at 253, 275, 282 and 294.
3. **Range read constructed but never used.** `openAttachmentRange`
   resolves to `{ ranges, decrypt }` (`range.ts:22-27`). A caller that
   inspects `ranges`, decides not to fetch, and drops the object never
   calls `decrypt`, so no stream is ever created. This is the seek-
   then-abandon pattern, and it is realistic rather than hypothetical.
   Task 3 adds a `close()` to the returned object to give it a wipe
   path.

4. **Reader stream constructed, never read, never cancelled.** This
   shape applies to `reader.ts` only. Understand why before touching
   either file, because the asymmetry is not obvious and an earlier
   revision of this plan got it backwards in the expensive direction.

   `new ReadableStream(src)` defaults to `highWaterMark: 1`, so once
   `start()` fulfills the stream pulls **once on its own**, with no
   reader attached. Verified empirically: a source whose `start` awaits
   a timer and whose `pull` enqueues and closes logs
   `start, start-done, pull` with nothing ever reading it.

   That auto-pull is why `range.ts` is **exempt**. Its `pull` runs
   unconditionally to `wipeSealState(ctx.state); ctx = null` at
   274-277 and then closes, so an abandoned range stream already wipes
   its `SealState` today and will wipe the CEK too once `wipeCek()`
   sits at that site. Do not add machinery to `range.ts` for this
   shape; there is nothing left for it to do.

   `reader.ts` is not exempt, and the difference is one line deep.
   `range.ts`'s `pull` reaches its wipe on the **first** pull.
   `reader.ts`'s `doWipe` at 457 sits behind `blockIndex >= l.nSeg` at
   448, which a single auto-pull never satisfies even for a
   one-segment object: that pull decrypts block 0, enqueues it, takes
   `desiredSize` to 0, and stops. The early return at 442-445 is not
   the mechanism and does not fire here, because `start()` sets
   `headerDone = true` at 431 before its promise fulfills.

   So an abandoned reader stream leaks the CEK, the `SealState`, **and
   one segment of decrypted plaintext**.

   Note that `range.ts` leaks the enqueued plaintext window too, for
   the same reason: the chunk sits in an unread, unlocked stream. The
   CEK and the `SealState` are wiped there, which is this phase's
   scope, so the exemption above stands. The plaintext residue is out
   of scope for AC2 and is called out here so it is a recorded
   decision rather than an oversight.

   There is no mechanism to fix it here: `decryptAttachmentStream`
   returns a bare `ReadableStream` with nowhere to hang a disposal
   hook, and adding one is a public API change beyond this phase.
   Record it as a residual gap per AC2.5, including the buffered
   plaintext, which is the part a reader of that note will care about
   most.

The writer wrapper (`writer.ts:69-79`) has only shape 1 and a plain
success path, so a `try/finally` covers it completely.

Wiping at `doWipe` time is safe: `startOpen` copies what it needs and
the resulting `SealState` holds no reference back to the CEK
(`schedule.ts:98-105`). `attachmentCek` returns a fresh unaliased
buffer, so the wrappers own it outright and the root `AGENTS.md` rule
that you only `fill(0)` what you allocated is respected.

**Tech Stack:** TypeScript, `@substrate-system/tapzero`, Web Streams.

**Scope:** Phase 2 of 6. Independent of every other phase. Task 4 edits
`scripts/check-attachment-invariants.mjs`, which phase 3 tasks 3 and 4
also edit; see the note in task 4 about check placement.

**Codebase verified:** 2026-08-20 by codebase-investigator and by two
rounds of direct reading during plan review.

---

## Citations in this plan

Every `file:line` below was verified on 2026-08-20 against branch `ra`.
Line numbers drift as you edit. Re-locate by content, and if a citation
does not match what you find, trust the code and say so in the commit
message.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments-fixes.AC2: Derived-key zeroization

- **random-access-attachments-fixes.AC2.1 Success:**
  `encryptAttachmentForGroup` zeroizes the CEK it derived before
  returning, on the success path and on the throw path.
- **random-access-attachments-fixes.AC2.2 Success:** The reader wrapper
  zeroizes its derived CEK when the stream closes, errors, or is
  cancelled; when the stream fails before a `SealState` exists; and
  when `decryptAttachmentStream` throws during construction so no
  stream is created at all. A stream that is constructed and then
  abandoned without being read or cancelled is a documented residual
  gap, not a covered case.
- **random-access-attachments-fixes.AC2.3 Success:** The range wrapper
  zeroizes its derived CEK on close, error and cancel; when
  `openAttachmentRange` throws during construction; and when the caller
  calls `close()` on a read whose `decrypt` was never invoked.
- **random-access-attachments-fixes.AC2.4 Failure:** A test that
  removes any one of the wipes fails. The assertion is on the CEK
  buffer contents, not on the call sequence of `wipeSealState`, and the
  test proves it is asserting against the right buffer rather than
  assuming an index.
- **random-access-attachments-fixes.AC2.5 Success:** The residual gaps
  and the new single-use contract are stated where a caller will see
  them: on the `AttachmentRangeRead` interface, and in
  `src/attachment/AGENTS.md`. Specifically, a range read abandoned
  without `close()` still leaks; a reader stream abandoned without
  being read or cancelled still leaks its CEK, its `SealState` and one
  buffered segment of plaintext; and a range read is single-use once
  any stream has ended.

Abbreviated below to `AC2.1` and so on.

---

## Why the existing tests could not have caught this

Read this before writing any test in this phase. The zeroization
assertion at `test/attachment/streams.ts:70` names exactly
`['payloadKey', 'snapKey', 'nonceBase']`, which is the definition of
`wipeSealState`. The CEK is not in that list, and never could be,
because `wipeSealState`'s own doc comment at `schedule.ts:335-336` says
the CEK is the caller's to wipe. The tests were shaped around the
implementation instead of around security rule 7, so no assertion in
them could ever fail on a leaked CEK.

## Identifying the CEK in an instrumented KDF: read this first

The obvious test approach is to wrap `kdf.expand`, collect outputs, and
assert the CEK is zeroed. The trap is knowing **which** collected
buffer is the CEK.

It is not the first. `attachmentCek` (`keys.ts:114-138`) calls
`safeExportSecret`, which walks 16 tree levels in a
`for (let bit = 15; bit >= 0; bit--)` loop (`keys.ts:92-101`), each
iteration performing one `expandWithLabel` and therefore one
`kdf.expand`. The CEK is the **17th** expand, produced by the
`expandWithLabelBytes` call at the end of `attachmentCek`.

Nor can you guard the assumption by length. Tree nodes are `kdf.size`
and the CEK is `CEK_LENGTH`; both are 32 on SHA-256 suites, so a length
assertion passes against the wrong buffer. An earlier revision of this
plan prescribed exactly that guard, and it was worthless.

Instrument the **ciphersuite**, not a `SealCrypto` bundle. The
`...ForGroup` wrappers take a `CiphersuiteImpl`, and
`sealCryptoFromCiphersuite` passes `kdf: cs.kdf` straight through
(`crypto.ts:65`), so instrumenting `cs.kdf.expand` covers both the CEK
derivation and everything downstream. The sketch at
`test/attachment/streams.ts:473-489` wraps a `SealCrypto`; adapt its
shape, not its target.

Pin the index with a control run rather than asserting it:

```ts
// Control: derivation is deterministic, so this pins which recorded
// buffer is the CEK. If keys.ts ever changes its call count, this
// assertion fails loudly instead of the wipe assertions passing
// against a tree node.
const expected = await attachmentCek(keySchedule, objectId, instrCs)
t.ok(recorded.length >= 17, 'expected 17 expands for a CEK')
t.deepEqual(recorded[16], expected, 'recorded[16] is the CEK')
```

Then reset `recorded.length = 0`, run the wrapper, and assert
`recorded[16]` is all zeros. Put the control in a shared helper so all
three tasks use one definition and one index.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Wipe the CEK in the writer wrapper

**Verifies:** AC2.1.

**Files:**
- Modify: `src/attachment/writer.ts:69-79`
  (`encryptAttachmentForGroup`)
- Test: `test/attachment/cek-wipe.ts` (integration, new file)

**Implementation:**

The current body is:

```ts
const cek = await attachmentCek(keySchedule, objectId, cs)
const crypto = sealCryptoFromCiphersuite(cs)
return encryptAttachment(cek, objectId, plaintext, crypto, opts)
```

The `return` hands back a promise, so the function's own frame is gone
before `encryptAttachment` settles. Await it first, then wipe in a
`finally`:

```ts
const cek = await attachmentCek(keySchedule, objectId, cs)
try {
    const crypto = sealCryptoFromCiphersuite(cs)
    return await encryptAttachment(
        cek, objectId, plaintext, crypto, opts,
    )
} finally {
    cek.fill(0)
}
```

The `await` before `encryptAttachment` is required, not stylistic.
Without it the `finally` runs while the encryption is still in flight
and wipes the key out from under it.

This matches the idiom already used by hand in
`example/attachments-demo.ts` at lines 133, 282 and 373.

**Testing:**

Create `test/attachment/cek-wipe.ts` and register it in `test/unit.ts`
inside the existing attachment block, which runs from line 18 to line
28, **before** the `// Example app tests` marker at line 30.

Build the instrumentation and the CEK-index control described above,
as a shared helper in this file.

Tests must verify:
- The control: `recorded[16]` deep-equals an independently derived
  CEK. Without this the remaining assertions are unmoored.
- AC2.1 success path: after `encryptAttachmentForGroup` resolves, every
  byte of the recorded CEK is zero.
- AC2.1 throw path: force `encryptAttachment` to reject and assert the
  CEK is still zeroed. Note that `encryptAttachmentForGroup` builds its
  own bundle from `cs` at `writer.ts:77`, so you cannot hand it a
  pre-instrumented `SealCrypto`. Instrument `cs.hpke.encryptAead`,
  which `crypto.ts:59-64` wraps into the bundle. Use the project's
  error idiom with `try` / `t.ok(false, ...)` / `catch`.

  If phase 3 has already landed, `SealCrypto` requires `rng`; build the
  ciphersuite accordingly rather than assuming this plan's ordering.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

**Commit:** `fix: zeroize the derived CEK in encryptAttachmentForGroup`
<!-- END_TASK_1 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Cover the reader wrapper's three exit shapes

**Verifies:** AC2.2.

**Files:**
- Modify: `src/attachment/reader.ts` (signature at 288-293, `doWipe` at
  319-324, wrapper at 530-539)
- Modify: `src/attachment/schedule.ts:335-336` (doc comment)
- Test: `test/attachment/cek-wipe.ts` (integration)

**Implementation:**

Step 1. Widen `decryptAttachmentStream` with a trailing optional
parameter. The current signature is **synchronous** and must stay that
way:

```ts
export function decryptAttachmentStream (
    cek:Uint8Array,
    ref:AttachmentRef,
    ciphertext:ReadableStream<Uint8Array>,
    crypto:SealCrypto,
    opts?:{ ownedCek?:Uint8Array },
):ReadableStream<Uint8Array> {
```

Do not add `async` and do not wrap the return in a `Promise`. The
function performs `validateAttachmentRef(ref)` and the
`plaintextLength` checks synchronously at 295-301, and callers at
`example/attachments-demo.ts:261` and `test/attachment/streams.ts:502`
depend on those surfacing as synchronous throws.

`ownedCek` means "this buffer belongs to the stream; zero it when the
stream ends". It is deliberately separate from the `cek` parameter: a
caller passing its own long-lived key must not have it wiped
underneath.

Step 2. Extend `doWipe` using a **second, independent** flag. The
current code is:

```ts
const doWipe = () => {
    if (!wiped && ctx) {
        wiped = true
        wipeSealState(ctx.state)
    }
}
```

Note carefully what that does: when `ctx` is null it does **not** set
`wiped`, so a later call still wipes the state once `ctx` exists. That
behaviour is load-bearing and must be preserved. `cancel()` at 519-522
can fire while `start` is awaiting `verifyHeader`, latching with
`ctx === null`; `verifyHeader` then assigns `ctx` at 378, the gap loop
hits `done` at 422-423, and the catch at 432-433 calls `doWipe` again.
A single latch shared between the two wipes would swallow that second
call and leave `payloadKey`, `snapKey` and `nonceBase` live. An earlier
revision of this plan did exactly that.

Use two flags:

```ts
let stateWiped = false
let cekWiped = false

const doWipe = () => {
    if (!stateWiped && ctx) {
        stateWiped = true
        wipeSealState(ctx.state)
    }
    if (!cekWiped) {
        cekWiped = true
        opts?.ownedCek?.fill(0)
    }
}
```

The state wipe keeps its exact current semantics. The CEK wipe latches
independently, because unlike the state it has no precondition.

**Accept and document one consequence.** Because the CEK wipe has no
precondition, a `cancel()` during header verification can zero the CEK
while `deriveSchedule` is still reading it. `deriveSchedule` reads
`cek` at four separate await points in `schedule.ts:129-141`:
`'commit'`, `'payload_key'`, `'acc_key'` and `'nonce_base'`. A cancel
landing between the first and second leaves a `SealState` whose
commitment was computed from the real key but whose `payloadKey`,
`snapKey` and `nonceBase` derive from zeros.

This is benign: the stream is being cancelled, and keys derived from
zeros are unusable, so the read errors instead of returning wrong
plaintext. Do not add a guard for it. Do write the reasoning into a
comment at the wipe site, because the next reader will notice the
window and should not have to re-derive why it is safe.

It does affect the test in step 2's regression case below, which must
land the cancel deterministically rather than racing these four
awaits.

Step 3. Wrap the construction call in the wrapper at 530-539 so the
synchronous throws at 295-301 do not leak:

```ts
const cek = await attachmentCek(keySchedule, ref.objectId, cs)
try {
    const crypto = sealCryptoFromCiphersuite(cs)
    return decryptAttachmentStream(
        cek, ref, ciphertext, crypto, { ownedCek: cek },
    )
} catch (err) {
    cek.fill(0)
    throw err
}
```

Keep `sealCryptoFromCiphersuite` **inside** the `try`, as task 1 does.
It can throw: `getCiphersuiteFromName` returns `undefined` for an
unrecognised name (`ciphersuite.ts:79-81`) and `suite.hpke` at
`crypto.ts:56` then raises a `TypeError`. Vanishingly unlikely with a
typed `CiphersuiteImpl`, but the CEK was derived one line earlier and
costs nothing to protect.

`try/catch`, not `try/finally`. On the success path the stream owns the
key and `doWipe` handles it; a `finally` would wipe it immediately.

Step 4. Confirm `doWipe` is reached on the pre-header failure paths
inside the stream. Read the error handling around 343 and 424, and if a
path throws without calling `doWipe`, route it through. State in the
commit message which paths you checked.

Step 5. Update the `wipeSealState` doc comment at `schedule.ts:335-336`.
It says "The CEK is the caller's to wipe", which is still true of
`wipeSealState` itself but now reads as license for the wrappers to
skip it. Name the wrappers as the owners, and point at `ownedCek`.

**Testing:**

Tests must verify AC2.2 on five endings, each as its own test:

- Normal close: read to completion, assert the CEK is zeroed.
- Error: feed a tampered object so the stream errors mid-read.
- Cancel: `cancel()` the reader partway through.
- Pre-header failure: truncate below `headerSize`, so the stream errors
  before `ctx` exists.
- Construction throw: pass a ref with a bad `version`, assert the
  wrapper rejects, and assert the CEK is zeroed even though no stream
  was built. This is the case step 3 exists for.

  Use the `version` field specifically. An out-of-range `objectId` will
  not work: `attachmentCek` enforces the same `1..255` bounds at
  `keys.ts:120-122` that `validateAttachmentRef` does at
  `reference.ts:66`, and the wrapper calls `attachmentCek` first
  (`reader.ts:536`), so the throw happens before a CEK exists. There
  would be nothing to assert against.

Add one regression test for step 2's two-flag requirement: cancel the
stream while the header is still being verified, then drive the stream
to its error path, and assert both that the CEK is zeroed and that the
`SealState` was wiped. A single-latch implementation fails this.

Make the cancel deterministic. Racing it against the four `sealKdf`
awaits gives a flaky test. Use the instrumented `kdf.expand` to gate
it: have the wrapper hand back control at a chosen expand call, cancel
there, then release. A test that only sometimes exercises the window
it exists for is worse than no test, because it reports green most of
the time.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output. The signature gained one optional trailing
parameter and stayed synchronous.

**Commit:** `fix: zeroize the reader wrapper's CEK on every exit`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Cover the range wrapper, including seek-then-abandon

**Verifies:** AC2.3.

**Files:**
- Modify: `src/attachment/range.ts` (the `AttachmentRangeRead` interface
  at 22-27, the `openAttachmentRange` signature at 34-39,
  `decryptRangeStream`'s parameter list at 86-96, the wipe sites at
  253, 275, 282 and 294, and the wrapper at 327-338)
- Modify: `src/attachment/AGENTS.md` (the residual gaps, per AC2.5)
- Test: `test/attachment/cek-wipe.ts` (integration)

**Implementation:**

Step 1. Add `opts?:{ ownedCek?:Uint8Array }` to `openAttachmentRange`.
It is `async` with four required parameters and no trailing optional,
so this is a plain widening. Confirm against 34-39 before editing.

Step 2. Decide where the flag lives before writing any code, because
the wipe sites and `close()` are in **different scopes**.

The four wipe sites at 253, 275, 282 and 294 are inside
`decryptRangeStream`, a module-level function (`range.ts:86-96`) taking
nine parameters, which is re-invoked on every `decrypt()` call.
`close()` must live on the object `openAttachmentRange` returns. A flag
declared inside `decryptRangeStream` is therefore not in scope for
`close()`, and vice versa.

Put a single `cekWiped` boolean and a small `wipeCek()` closure in
`openAttachmentRange`'s body. Pass `wipeCek` into `decryptRangeStream`
as an additional parameter and call it at the four sites. `close()`
calls the same closure. One flag, one owner, both consumers reaching it
by closure. `decrypt` at `range.ts:74-79` is a method on the object
literal `openAttachmentRange` returns, so a closure declared in that
body is in scope for it.

You do not need to pass `ownedCek` as well. The closure already
captures the buffer; a second parameter carrying it is redundant.

**Put `wipeCek()` outside the `if (ctx)` guards.** All four wipe sites
sit inside `if (ctx) {` blocks: 252-254 (catch in `start`), 274-277
(in `pull`), 281-283 (catch in `pull`), and 293-294 (`cancel`). The
CEK wipe has no `ctx` precondition, for exactly the reasons task 2
step 2 sets out at length. An executor who pattern-matches "put
`wipeCek()` next to `wipeSealState()`" leaks the CEK on every
pre-`ctx` failure: the stream-count mismatch at 118, the length
mismatch at 124, a `parsePrefix` throw, a `verifyRoot` throw, and
`cancel()` before `start()` completes.

Note that in `cancel()` the `if (ctx) {` is line 293 and the wipe call
is 294.

`range.ts` has **no** latch on the state wipe today. It sets
`ctx = null` at line 276 instead. Do not add one: introducing a shared
latch would open the same window task 2 step 2 describes. `cekWiped`
governs the CEK only, and the existing `ctx = null` pattern stays
untouched.

Step 3. Wrap the construction call in the wrapper at 327-338, covering
the four throws at 41, 44-47, 50-53 and inside `rangesFor` at 66.

**This differs from task 2 step 3, and the difference matters.**
`decryptAttachmentStream` is synchronous, so a bare `return f(...)`
inside a `try` throws inside the block and the `catch` fires.
`openAttachmentRange` is `async`, so a bare
`return openAttachmentRange(...)` returns a promise and the rejection
propagates *outside* the `try`, where the `catch` never sees it. Write:

```ts
try {
    return await openAttachmentRange(
        cek, ref, range, crypto, { ownedCek: cek },
    )
} catch (err) {
    cek.fill(0)
    throw err
}
```

The `await` is load-bearing, exactly as it is in task 1's `finally`.

Step 4. Close the abandonment hole, shape 3 only.

Add an optional `close?:() => void` to `AttachmentRangeRead`. Adding an
optional property is not a breaking change. It is `wipeCek` itself, so
it is idempotent through `cekWiped` and a `close()` followed by a
stream ending does not double-wipe or throw.

Populate it in `openAttachmentRange`, which returns
`{ ranges, decrypt, close: wipeCek }`. Do **not** populate it in the
`...ForGroup` wrapper: the wrapper at 327-338 returns
`openAttachmentRange`'s object directly and has no access to
`cekWiped`, so a `close` attached there would be a second, unlatched
wipe.

`close()` handles the CEK and nothing else. It does not need to wipe
the `SealState`, because in the shape-3 case `decrypt` was never
called, so no stream, no `ctx` and no `SealState` ever existed. And in
the shape-4 case the auto-pull at 274-277 already wiped the state, per
the Architecture note above. `ctx` lives inside `decryptRangeStream`
(`range.ts:100`) and is deliberately not reachable from here; do not
build plumbing to reach it.

**Decide and document the single-use consequence.** One `cekWiped` per
`openAttachmentRange` call means the first stream to finish, error, or
be closed zeroes the CEK, so a second `decrypt()` builds a stream whose
`start()` runs `verifyRoot` against zeros; `startOpen`'s
`constantTimeEqual` on the commitment fails and the stream errors. That
is a real behaviour change: a caller retrying a decrypt after a
truncated fetch is now broken.

Accept it, because a range read is an open-fetch-decrypt-once shape and
a per-`decrypt` latch would leave the CEK live after the last stream
ends. But make it explicit rather than accidental: state on
`AttachmentRangeRead` that the read is single-use once any stream has
ended or `close()` has been called, and add a test asserting a second
`decrypt()` rejects. An undocumented single-use contract discovered in
production is worse than the leak this phase is fixing.

Document on the interface, plainly, that a caller who abandons a range
read without calling `close()` still leaks, and that nothing at this
layer can prevent it.

The reader-side shape-4 gap has no `close()` to offer. Record it in
`src/attachment/AGENTS.md` per AC2.5, including the buffered segment
of plaintext.

**Testing:**

Tests must verify AC2.3 on five shapes, each as its own test: normal
close, error, cancel, construction throw, and seek-then-abandon
followed by `close()`.

Do **not** add a `decrypt()`-then-abandon test. That is shape 4, from
which `range.ts` is exempt: the auto-pull wipes before any assertion
could observe the CEK live, so the "live before `close()`" half cannot
hold, and a test written to beat the auto-pull would be racing a timer.
The Architecture section explains why.

For the seek-then-abandon case, where no stream is ever constructed and
so no auto-pull occurs, assert both halves: that the CEK is live before
`close()` and zeroed after. Asserting only the second half would pass
against an implementation that wiped too early.

Add one test for the single-use contract from step 4: after a stream
has ended, **reading** the stream returned by a second `decrypt()`
errors with an `AttachmentError`.

Word it that way and write it that way. `decrypt` returns a
`ReadableStream` synchronously (`range.ts:74-79`); the failure happens
inside `start()`, is caught at 251 and rethrown, which errors the
stream. It never rejects a promise, so
`await t.rejects(read.decrypt(streams))` awaits a non-thenable and
passes without testing anything.

The test also needs fresh range streams for the second call, since
`drainStream` consumed the first set.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output.

**Commit:** `fix: zeroize the range wrapper's CEK on every exit`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_4 -->
### Task 4: Structural guard in the invariants script

**Verifies:** AC2.4, jointly with the tests in tasks 1-3.

**Files:**
- Modify: `scripts/check-attachment-invariants.mjs`

**Implementation:**

The script's existing rule-7 gate counts `wipeSealState(` call sites in
`reader.ts`, `range.ts` and `object.ts`. Its own comment concedes it is
a presence check only, and it says nothing about the CEK.

Add a sibling check asserting that `writer.ts` contains a `.fill(0)`
and that `reader.ts` and `range.ts` each contain `ownedCek`.

Placement matters. Line 49's `if (failed) process.exit(1)` short-
circuits before the inventory and wipe checks, so a check added after
it will not run when an earlier check has already failed. Read the
script's control flow before choosing where to insert, and put the new
check where it actually executes.

Phase 3 tasks 3 and 4 also edit this file. If phase 3 has already run,
re-read it rather than working from this plan's description of it.

Keep the check honest. Add a comment saying it is a presence check that
cannot prove the wipe is reachable, and that the behavioural proof
lives in `test/attachment/cek-wipe.ts`.

**Verification:**

Run: `node scripts/check-attachment-invariants.mjs`
Expected: exits 0.

Then deliberately break it: remove the `ownedCek` argument from the
`reader.ts` wrapper, re-run, confirm non-zero exit, restore. An
invariant nobody has seen fail is an invariant nobody knows works.

Run: `npm run test:node`
Expected: script passes first, then all tests pass.

**Commit:** `chore: gate CEK ownership in the invariants script`
<!-- END_TASK_4 -->

---

## Phase complete when

- `npm run test:node` passes, including the fifteen new tests: the
  CEK-index control, two in task 1, six in task 2 (five endings plus
  the two-flag regression), and six in task 3 (five shapes plus the
  single-use contract).
- `npx tsc -p tsconfig.json --noEmit` is clean.
- `npm run lint` is clean.
- The CEK-index control assertion passes, so the wipe assertions are
  known to target the right buffer.
- Deleting any one wipe causes at least one test to fail. Verify by
  hand, once per wipe, **with one exemption**: the CEK wipe at
  `range.ts:281-283`, in `pull`'s catch. That catch is defensive only;
  its own comment at 265-267 records that `pull()` cannot observe a
  null `decrypted` because `start()` either assigns it or errors the
  stream. Its only other throw sources are `controller.enqueue` at 270
  and `controller.close` at 279, neither of which throws on a live
  unlocked controller. A wipe there is unreachable by construction, so
  no test can kill it. Keep it for symmetry with the
  surrounding `wipeSealState` call, and do not manufacture a test that
  appears to cover it.
- The residual gaps and the single-use contract are documented: the
  range gap and the single-use note on the `AttachmentRangeRead`
  interface, and the reader-side shape-4 gap in
  `src/attachment/AGENTS.md`.

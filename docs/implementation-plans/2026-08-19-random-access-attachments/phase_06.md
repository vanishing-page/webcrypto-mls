# Random-Access Attachments Implementation Plan -- Phase 6: Demo

**Goal:** A voice-note-style demo page in `example/` that plays an
encrypted audio attachment progressively: playback starts while
segments are still arriving through a throttled stream, which is
the property the whole feature exists for.

**Architecture:** New route "Attachments" in the existing demo
suite (predicate in `routing.ts`, item in `nav.ts`, branch in
`index.ts`). The page synthesizes PCM audio, encrypts it with the
attachment API (CEK derived from a locally created key schedule via
`attachmentCek`, same call a real group member makes), then
decrypts through `decryptAttachmentStream` fed by an artificially
throttled ciphertext stream, scheduling each decrypted segment into
an `AudioContext` as it lands. Pure audio math lives in
`example/attachment-audio.ts` so it is Node-testable.

**Tech Stack:** htm/preact + @preact/signals (existing demo stack),
Web Audio API.

**Scope:** Phase 6 of 6 from
`docs/design-plans/2026-08-19-random-access-attachments.md`.

**Codebase verified:** 2026-08-19

**Repo rules that bind this phase:** component-local state uses
`useSignal` (never useState); wrap sequential signal writes in
`batch()`; no assertions on rendered HTML text in tests; CSS uses
the existing `:root` variables in `example/style.css` with nested
selectors, no font sizes below 1rem; `window.state`/debug exposure
only inside `if (import.meta.env.DEV)`.

---

## Acceptance Criteria Coverage

This phase implements and human-verifies:

### random-access-attachments.AC6: Demo

- **random-access-attachments.AC6.1 Success (human verification):**
  In the demo app, an attachment fetched progressively begins
  playback before the full ciphertext has downloaded.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Pure audio helpers

**Verifies:** None directly (supports AC6.1; unit-tested because it
is pure logic).

**Files:**
- Create: `example/attachment-audio.ts`
- Create: `test/example/attachment-audio.ts` (unit)
- Modify: `test/unit.ts`

**Step 1: Create `example/attachment-audio.ts`**

```ts
export const SAMPLE_RATE = 16000

/**
 * A synthesized "voice note": a slow sine sweep with a gentle
 * tremolo so progress is audible. Length in seconds.
 */
export function makeTonePcm (seconds:number):Float32Array {
    const n = Math.floor(seconds * SAMPLE_RATE)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE
        const freq = 220 + (110 * Math.sin(t * 0.5))
        const tremolo = 0.75 + (0.25 * Math.sin(t * 3))
        out[i] = 0.25 * tremolo * Math.sin(2 * Math.PI * freq * t)
    }
    return out
}

/** Reinterpret decrypted plaintext bytes as PCM samples. */
export function bytesToPcm (bytes:Uint8Array):Float32Array {
    if (bytes.byteLength % 4 !== 0) {
        throw new Error('pcm chunk not float aligned')
    }
    const copy = bytes.slice()
    return new Float32Array(
        copy.buffer, copy.byteOffset, copy.byteLength / 4,
    )
}

/** Start time in seconds for the chunk beginning at byteOffset. */
export function chunkStartSeconds (byteOffset:number):number {
    return (byteOffset / 4) / SAMPLE_RATE
}
```

(`SEGMENT_MAX` is a multiple of 4, so segment-sized chunks are
always float-aligned.)

**Step 2: `test/example/attachment-audio.ts`**

- `makeTonePcm(2)` has exactly `2 * SAMPLE_RATE` samples, all
  within [-1, 1].
- `bytesToPcm` round-trips: bytes of a known Float32Array come back
  equal; a 6-byte input throws.
- `chunkStartSeconds(65536)` equals `16384 / SAMPLE_RATE`.

Register `import './example/attachment-audio.js'` in `test/unit.ts`
(with the other example tests).

**Step 3: Run, commit**

```bash
npm run test:unit
git add example/attachment-audio.ts test/example test/unit.ts
git commit -m "example: attachment demo audio helpers"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: The demo page

**Verifies:** random-access-attachments.AC6.1 (human).

**Files:**
- Create: `example/attachments-demo.ts`
- Modify: `example/routing.ts` (new predicate)
- Modify: `example/nav.ts` (new item in `navItems`; fix Main
  demo's active flag)
- Modify: `example/index.ts` (route branch, around lines 680-696)
- Modify: `example/style.css` (one nested block)
- Modify: `package.json` (`build-example` copy step)
- Modify: `test/example/nav.ts` (nav count and active-flag cases)
- Modify: `test/example/routing.ts` (isAttachmentsPath cases)

**Step 1: Routing and nav**

In `example/routing.ts`, add `isAttachmentsPath(href, basePath)`
mirroring `isPersistencePath` (lines 6-13) with section
`attachments`. In `example/nav.ts`: add
`{ label: 'Attachments', href: base + '/attachments', active:
isAttachments }` to the `navItems` return array following the
existing entries, AND update the Main demo item's flag
(`example/nav.ts:25`, currently
`active: !isPersistence && !isMultiDevice`) to
`!isPersistence && !isMultiDevice && !isAttachments` so exactly one
item is active on `/attachments`. In `example/index.ts`, add a
`useComputed` show-flag next to `showPersistence` /
`showMultiDevice` (lines 681-687) and extend the render ternary
(lines 689-693) with the new `AttachmentsDemo` component.

Update the existing tests in the same change (they fail
otherwise): `test/example/nav.ts:6` asserts `items.length === 3` --
raise to 4 and add the `/attachments` route to its cases, asserting
exactly one item is active on every route including the new one.
`test/example/routing.ts` gets `isAttachmentsPath` cases mirroring
the `isPersistencePath` ones (match, subpath match, non-match,
query-string stripping).

**Step 2: `example/attachments-demo.ts`**

`export const AttachmentsDemo:FunctionComponent`, modeled on
`PersistenceDemo` (`example/persistence-demo.ts`, note its
initialization at lines 51-62). Page-local signals via `useSignal`:
`status:string`, `segmentsTotal:number`, `segmentsDone:number`,
`playing:boolean`, plus non-signal refs for the sealed bytes,
`AttachmentRef`, `AudioContext`, and stream reader.

Setup (once, on first render effect):
- Obtain a `CiphersuiteImpl` the way persistence-demo does.
- Create a demo key schedule:
  `initializeKeySchedule(randomEpochSecret.slice(), cs.kdf)` with
  32 random bytes (`initializeKeySchedule` zeroizes its input, so
  pass a copy). Comment in code: a real app uses
  `state.keySchedule` from its MLS group; the derivation call is
  identical.

Generate button:
- `pcm = makeTonePcm(12)`; plaintext =
  `new Uint8Array(pcm.buffer.slice(0))` (~768 KiB, 12 segments).
- objectId = 16 random bytes; `cek = await attachmentCek(
  keySchedule, objectId, cs)`;
  `crypto = sealCryptoFromCiphersuite(cs)` (synchronous);
  `enc = await encryptAttachment(cek, objectId, plaintext,
  crypto)`.
- Keep `enc.bytes` + `enc.reference` in refs; `batch()` the status
  and counter signal updates
  (`segmentsTotal = layout(...).nSeg` or simply
  `Math.ceil(plaintext.length / SEGMENT_MAX)`).

Play button ("play with simulated slow network"):
- Build a throttled `ReadableStream<Uint8Array>` over `enc.bytes`:
  enqueue 65536-byte slices, awaiting ~250 ms between slices
  (`setTimeout` promise); respect a cancelled flag.
- `plainStream = decryptAttachmentStream(cek, ref, throttled,
  crypto)`; read chunks in a loop. Maintain a running byte offset;
  for each chunk: `bytesToPcm`, create an `AudioBuffer` (1 channel,
  chunk length, `SAMPLE_RATE`), `copyToChannel`, schedule an
  `AudioBufferSourceNode` at
  `baseTime + chunkStartSeconds(offset)` where `baseTime` is
  captured from `audioCtx.currentTime + 0.3` before the first
  chunk. Update `segmentsDone` (and status) inside `batch()`.
- The audible result: sound starts after the header + first
  segment (~0.5 s) while the counter still shows e.g. 2/12.

Seek button ("jump to 0:08 via range read" -- the headline
random-access path, per the design's phase 6): stop any current
playback, compute the plaintext byte offset for 8 seconds
(`8 * SAMPLE_RATE * 4`), call `openAttachmentRange(cek, ref,
{ offset, length: plaintextLength - offset }, crypto)`, serve each
requested range by slicing `enc.bytes` through the same throttled
stream helper, and schedule the decrypted chunks into the
AudioContext with the range start SUBTRACTED from the running byte
offset: `baseTime + chunkStartSeconds(offset - rangeStart)`, where
`rangeStart = 8 * SAMPLE_RATE * 4`. (Scheduling at
`chunkStartSeconds(offset)` unadjusted would delay the first sound
by 8 wall-clock seconds.) Status shows which byte ranges were
fetched (from the returned `ranges`), making visible that the
prefix was skipped.

Stop button: set the cancelled flag, `reader.cancel()`, close the
AudioContext, reset signals in `batch()`. Also run this cleanup in
the effect teardown so navigation away stops audio.

Render: a `.card` section matching the other demos: title, four
buttons (Generate, Play, Seek, Stop; Play and Seek disabled until
generated, Stop until playing), a status line, and a progress text
`decrypted N / M segments`. No new colors; reuse existing `:root`
variables. Any new font size at least 1rem.

**Step 3: `example/style.css`**

One nested block (e.g. `.route.attachments { ... }` or a class
scoped like the other demos use; follow the nesting patterns
already present), only layout/spacing rules plus existing color
variables.

**Step 4: `package.json` build-example**

The `build-example` script copies `index.html` into
`public/persistence/` and `public/multi-device/` for client-side
routing. Extend it with `public/attachments/` following the exact
existing pattern in that script string.

**Step 5: Automated verification (structure only, no HTML text
assertions)**

```bash
npm run test:unit && npm run lint && npm run build-example
grep -o 'window\.state=' public/assets/*.js || echo "clean"
```

Expected: tests pass; the grep prints `clean` (AGENTS.md leak
check).

**Step 6: Commit**

```bash
git add example package.json
git commit -m "example: attachments demo with progressive playback"
```
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (task 3) -->
<!-- START_TASK_3 -->
### Task 3: Human verification of AC6.1

**Verifies:** random-access-attachments.AC6.1 (human).

**Step 1: Start the dev server**

```bash
npm start
```

**Step 2: Verify in the browser** (document the outcome in the
task log; this is the phase gate):

1. Open http://localhost:1234, click "Attachments" in the nav.
2. Click Generate; status shows the attachment is sealed and the
   segment total (12).
3. Click Play. PASS criteria: audio is audible while the progress
   text still shows fewer than 12 segments decrypted (the throttle
   makes full delivery take ~3 s; audible onset happens within
   ~1 s).
4. Click Seek. PASS criteria: audio resumes from the 8-second
   point, and the fetched-ranges status shows the leading segments
   were not fetched (random access, not a fast-forwarded full
   download).
5. Click Stop mid-playback; audio stops; Play works again.
6. Browser console shows no errors.

**Step 3: Stop the dev server** (always; do not leave it running).

**Step 4: Final phase verification**

```bash
npm run lint && npm run build && npm run test:unit && \
  npm run test:fast
git status --porcelain
```

Expected: all green, clean tree.
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_B -->

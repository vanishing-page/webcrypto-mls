# Random-Access Attachment Fixes Implementation Plan

**Goal:** Route the object salt through the pluggable RNG so a
caller-supplied `CryptoProvider` is honoured, and clear three small
defects that reviewers found alongside it.

**Architecture:** `object.ts:37` calls
`globalThis.crypto.getRandomValues(new Uint8Array(32))` directly,
bypassing `cs.rng`. That matters more than a normal abstraction leak,
because the value it produces is the object salt, and the design's
security rule 1 rests on that salt being unique: reuse is nonce reuse,
which is a two-time pad. A consumer who supplies a custom provider,
whether for a hardware RNG or for deterministic tests, is silently
ignored for the one value where it counts most.

The fix needs a signature change. `sealObject` takes
`crypto:SealCrypto` (`object.ts:22-28`), and `SealCrypto` is a bundle
that does not carry `rng`. Adding `rng:Rng` to the bundle is better
than adding a parameter: the bundle is already the mechanism for
handing capabilities into the SEAL layer, and the sole production
caller, `encryptAttachment` at `writer.ts:31`, needs no change.

There are three construction sites, and only one has a
`CiphersuiteImpl` to borrow from. `sealCryptoFromCiphersuite` does.
`sealCryptoFromIds` (`crypto.ts:97`) does not, and exists precisely to
build bundles for vector configurations MLS does not offer; it is called
by `scripts/interop-seal.ts`, `scripts/generate-seal-own-vectors.ts`,
and `test/attachment/reader-header.ts`. `sealCryptoKdfOnly`
(`test/attachment/helpers.ts:146`) does not either. Task 1 resolves
where those two get an `Rng` rather than leaving it to the executor.

**Tech Stack:** TypeScript, `@substrate-system/tapzero`, node esbuild
bundle.

**Scope:** Phase 3 of 6. Independent of phases 1, 2 and 4. Tasks 3 and
4 edit `scripts/check-attachment-invariants.mjs`, which phase 2 task 4
also edits. Note that line 49's `if (failed) process.exit(1)`
short-circuits before the later checks, so placement matters: read the
script's control flow and put new checks where they actually execute.
If phase 2 has already run, re-read the file rather than working from
this plan's description of it.

**Codebase verified:** 2026-08-20 by codebase-investigator and by
direct reading during plan review.

---

## Citations in this plan

Every `file:line` below was verified on 2026-08-20 against branch `ra`.
Line numbers drift as you edit. Re-locate by content, and if a citation
does not match what you find, trust the code and say so in the commit
message.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments-fixes.AC3: Pluggable RNG and corrections

- **random-access-attachments-fixes.AC3.1 Success:** `sealObject` draws
  its salt from the supplied bundle's `rng`, so a caller-supplied
  `CryptoProvider` is honoured. A test supplying a deterministic RNG
  observes that RNG being used.
- **random-access-attachments-fixes.AC3.2 Success:** No file under
  `src/attachment/` calls `getRandomValues`, enforced by
  `scripts/check-attachment-invariants.mjs`.
- **random-access-attachments-fixes.AC3.3 Success:** The invariants
  script's `keys.ts` forbidden-import list includes `reference.ts`, and
  a deliberate violation trips it.
- **random-access-attachments-fixes.AC3.4 Success:** The unreachable
  safe-integer branch in `reader.ts` is removed with no behaviour
  change.

Abbreviated below to `AC3.1` and so on.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Carry the RNG on the SealCrypto bundle

**Verifies:** None directly (enabling change; AC3.1 is verified by
task 2).

**Files:**
- Modify: `src/attachment/crypto.ts` (the `SealCrypto` type,
  `sealCryptoFromCiphersuite`, and `sealCryptoFromIds` at line 97)
- Modify: `test/attachment/helpers.ts:146` (`sealCryptoKdfOnly`)

**Implementation:**

Step 1. Confirm the construction sites before changing the type. Run:

```sh
grep -rn "SealCrypto\|sealCryptoFromIds\|sealCryptoKdfOnly" \
    src/ test/ example/ scripts/
```

Expect three literal construction sites: `sealCryptoFromCiphersuite`
and `sealCryptoFromIds` in `src/attachment/crypto.ts`, and
`sealCryptoKdfOnly` in `test/attachment/helpers.ts`. Sites that spread
an existing bundle (`{ ...base, kdf: {...} }`, as the instrumented test
crypto does) inherit `rng` and need no change.

Step 2. Add `rng:Rng` to the `SealCrypto` type, importing `Rng` from
`../crypto/rng.js`:

```ts
export interface Rng {
    randomBytes(n:number):Uint8Array
}
```

Make the field **required**. An optional `rng` would let a construction
site silently fall back to the global, which is the exact failure this
phase exists to remove.

Step 3. Populate it in `sealCryptoFromCiphersuite` from `cs.rng`.

Step 4. `sealCryptoFromIds` has no ciphersuite. Give it an optional
trailing `rng:Rng` parameter defaulting to `defaultRng`, exported from
`src/crypto/implementation/default/rng.ts`:

```ts
import { defaultRng } from '../crypto/implementation/default/rng.js'
```

Every existing caller then keeps working unchanged, and a caller that
wants a specific RNG can pass one. This keeps the `SealCrypto` field
required while not forcing a ciphersuite on a function whose whole
purpose is to work without one.

Step 5. `sealCryptoKdfOnly` is a test helper that declares
`Promise<SealCrypto>` at `test/attachment/helpers.ts:150`, so it does
need the field. Give it `defaultRng` the same way. Its import specifier
differs from the one above, because the file sits in `test/attachment/`
rather than `src/attachment/`; write the path that resolves from there
rather than copying the specifier from step 4.

Note that `defaultRng` itself calls `crypto.getRandomValues`. That is
correct and is the one place it belongs. Task 3's check is scoped to
`src/attachment/`, so it does not reach `src/crypto/`.

**Verification:**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output. Any error here is a construction site step 1
should have found; fix the site rather than making the field optional.

Run: `npm run test:node`
Expected: all assertions pass, unchanged from before this task.

**Commit:** `refactor: carry the RNG on the SealCrypto bundle`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Draw the object salt from the pluggable RNG

**Verifies:** AC3.1.

**Files:**
- Modify: `src/attachment/object.ts:37` (inside `sealObject`)
- Test: `test/attachment/object.ts` (unit, existing file)

**Implementation:**

Replace the direct global call at `object.ts:36-37`. It reads
approximately:

```ts
const salt = opts?.salt ??
    globalThis.crypto.getRandomValues(new Uint8Array(32))
```

The exact line wrapping in the source may differ from the sketch above,
so locate it by content rather than by an exact-match edit on this
snippet. Replace it with a draw from the bundle:

```ts
const salt = opts?.salt ?? crypto.rng.randomBytes(32)
```

Match the call style used elsewhere in `src/`, for example
`cs.rng.randomBytes(cs.kdf.size)` at `client-state.ts:1165`,
`resumption.ts:104` and `update-path.ts:103`. Keep the 32-byte length:
the design pins `salt(32)`
at line 296 of the design plan, and this task is not the place to
revisit it.

Leave the `opts?.salt` override exactly as it is. It is what makes the
frozen vectors reproducible.

**Testing:**

Add to the existing `test/attachment/object.ts`.

Tests must verify:
- AC3.1: build a bundle whose `rng.randomBytes` is a counting stub
  returning a known pattern, seal an object with no `opts.salt`, and
  assert the salt in the produced header is the stub's output. Assert
  the stub was actually called, so the test cannot pass by coincidence.
- The `opts.salt` override still wins over the RNG, and the stub is not
  called when a salt is supplied.

Do not assert that `globalThis.crypto.getRandomValues` was not called.
That is testing wiring rather than behaviour, and task 3 enforces it
structurally instead.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass.

Run: `git diff --exit-code test_vectors/seal/own/`
Expected: empty. The vectors pass an explicit salt, so this change must
not move them. A non-empty diff means the override path broke.

**Commit:** `fix: draw the object salt from the pluggable RNG`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Forbid getRandomValues under src/attachment

**Verifies:** AC3.2.

**Files:**
- Modify: `scripts/check-attachment-invariants.mjs`

**Implementation:**

Add a check that no file under `src/attachment/` calls
`getRandomValues`.

Scope the pattern to `getRandomValues` specifically. Do **not** match
on `globalThis.crypto` alone: `src/attachment/crypto.ts:106` contains
`makeHashImpl(globalThis.crypto.subtle, k.hash)`, which is a legitimate
use of the Web Crypto subtle interface and has nothing to do with
randomness. A check that fails on it would be wrong on its first run.

Match both `globalThis.crypto.getRandomValues` and a bare
`crypto.getRandomValues`, since either spelling reintroduces the
problem.

Report the offending file and line when it trips, matching the style of
the script's existing checks.

**Verification:**

Run: `node scripts/check-attachment-invariants.mjs`
Expected: exits 0. If it fails on `crypto.ts:106`, the pattern is too
broad; narrow it.

Then break it deliberately: add a `getRandomValues` call in
`src/attachment/object.ts`, re-run, confirm non-zero exit, and remove
it.

**Commit:** `chore: forbid getRandomValues under src/attachment`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Close the keys.ts layering hole

**Verifies:** AC3.3.

**Files:**
- Modify: `scripts/check-attachment-invariants.mjs:39-42` (the
  forbidden-import list)

**Implementation:**

The list currently names `crypto.ts`, `kdf.ts`, `schedule.ts`,
`snapshot.ts`, `layout.ts`, `object.ts`, `reader.ts`, `range.ts` and
`writer.ts`. It omits `reference.ts`, so `keys.ts` could import it
without tripping layering rule 3.

Add `reference.ts` to the list.

Do not add `error.ts`. Check what `keys.ts` actually imports before
editing; if it throws `AttachmentError`, forbidding `error.ts` would
break a real and intended dependency. Record what you found in the
commit message.

**Verification:**

Run: `node scripts/check-attachment-invariants.mjs`
Expected: exits 0, since `keys.ts` does not currently import
`reference.ts`.

Then break it deliberately: add an import of `reference.ts` to
`keys.ts` **plus a use of it**, re-run, confirm non-zero exit, and
revert. The check bundles `keys.ts` and inspects `metafile.inputs`, so
an unused import may be tree-shaken away; that is why the violation
needs a use, not just an import.

**Commit:** `chore: add reference.ts to the keys.ts forbidden list`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Remove the unreachable safe-integer branch

**Verifies:** AC3.4.

**Files:**
- Modify: `src/attachment/reader.ts:250-255`

**Implementation:**

The current guard is:

```ts
if (!Number.isSafeInteger(ref.plaintextLength) ||
    ref.plaintextLength <= 0 ||
    BigInt(ref.plaintextLength) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AttachmentError()
}
```

`Number.isSafeInteger` already guarantees the value is at most
2^53 - 1, so the third clause can never be true when the first two are
false. Remove it:

```ts
if (!Number.isSafeInteger(ref.plaintextLength) ||
    ref.plaintextLength <= 0) {
    throw new AttachmentError()
}
```

This is dead-code removal with no behaviour change. Do not extend the
guard while you are here; if you believe a case is missing, that is a
separate finding and belongs in its own change.

Note that this is a different site from the `bigint` bounds check
inside `decryptAttachmentStream` at lines 298-301, which operates on
`ref.plaintextLength` typed as `bigint` and is **not** redundant. Do
not remove that one. Confirm which site you are editing by reading the
declared type of `ref` at each.

**Testing:**

No new test. The existing rejection tests for a non-positive or
non-integer `plaintextLength` cover both surviving clauses. Confirm
those tests exist before deleting the clause; if there is no test for
`plaintextLength <= 0`, add one, because removing sibling code from an
untested guard is how untested guards become wrong.

**Verification:**

Run: `npm run test:node`
Expected: all assertions pass, unchanged.

**Commit:** `refactor: drop an unreachable plaintextLength check`
<!-- END_TASK_5 -->

---

## Phase complete when

- `npm run test:node` passes.
- `npx tsc -p tsconfig.json --noEmit` is clean.
- `npm run lint` is clean.
- `git diff --exit-code test_vectors/seal/own/` is empty.
- Each of the two new invariant checks has been observed failing once,
  deliberately, and then restored.

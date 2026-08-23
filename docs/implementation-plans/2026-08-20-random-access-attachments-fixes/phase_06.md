# Random-Access Attachment Fixes Implementation Plan

**Goal:** Make every document about the attachment subsystem true, and
give the subsystem the architectural records it never got.

**Architecture:** Two reviewers audited the subsystem's documentation
against its code and found roughly two dozen false or stale claims,
concentrated in the design plan's Known Limitations section. The errors
are not typos. Several describe shipped behaviour as future work, one
understates a memory figure by 32x while the number next to it is
correct and only reachable from the right figure, and one names the
wrong upstream error in a way that led the design to doubt a parameter
choice that is in fact conformant. A reader following these documents
would make worse decisions than a reader with no documents.

Separately, the largest feature in the repository has no ADR and no FDR,
its vocabulary is absent from the glossary, and `docs/security-audit.md`
is dated 2026-08-09 with scope `src/`, predating the subsystem entirely
and containing zero mentions of it. Two of that audit's existing
findings, L1 and L2, are the same class of defect that phase 2 of this
plan fixes, which makes its silence on the subsystem actively
misleading.

**Tech Stack:** Markdown. No code changes in this phase.

**Scope:** Phase 6 of 6. Run last: several corrections describe
behaviour that phases 1 through 5 change, so writing them earlier means
writing them twice.

**Codebase verified:** 2026-08-20 by codebase-investigator.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments-fixes.AC6: Documentation accuracy

- **random-access-attachments-fixes.AC6.1 Success:** Every numeric
  claim in the design plan's Known Limitations is arithmetically
  consistent with `layout.ts`, including the segment count for a 128
  GiB object and the per-segment metadata size.
- **random-access-attachments-fixes.AC6.2 Success:** No document names
  `invalidProfileTuple` as the swift-raae rejection error for snap_id
  0x0003.
- **random-access-attachments-fixes.AC6.3 Success:** The design plan's
  payload-schedule description matches the seven-field framing in
  `schedule.ts`, and the dead `encodePayloadInfo` path is either
  documented as test-only or removed.
- **random-access-attachments-fixes.AC6.4 Success:** No document
  describes the implementation as not yet existing, and no document
  describes shipped behaviour as future work.
- **random-access-attachments-fixes.AC6.5 Success:**
  `src/attachment/AGENTS.md`'s stated rationale for the reader/range
  import ban is replaced with the true one.
- **random-access-attachments-fixes.AC6.6 Success:**
  `interop/seal-cli/README.md` documents the three ops, the request and
  response fields, the error shape, and both caller traps.
- **random-access-attachments-fixes.AC6.7 Success:**
  `test_vectors/seal/core/SOURCE-README.md` is either removed or marked
  as a vendored upstream copy with its repo-inapplicable claims
  corrected.
- **random-access-attachments-fixes.AC6.8 Success:**
  `docs/security-audit.md` covers `src/attachment/`.

Abbreviated below to `AC6.1` and so on.

---

## How to verify a documentation phase

There is no test runner for prose. Every task below names the source
file and line that settles the claim. Open it and read it. Do not
correct a document from this plan's summary of the code, because this
plan is itself a document and inherits the same failure mode it exists
to fix. Plan review already found several wrong citations in this file
and fixed them; assume it did not find all of them.

Line numbers were verified on 2026-08-20 against branch `ra` and drift
as you edit. Re-locate by content.

**Prerequisite for tasks 2 and 7.** Both read vendored Swift sources
under `interop/seal-cli/.build/checkouts/swift-raae/`. That directory
is gitignored and absent from a fresh clone, because it is a build
artifact rather than a committed source. Restore it first:

```sh
cd interop/seal-cli && swift build -c debug
```

Debug is required: the CLI uses `@testable import RAAE`, which needs
`-enable-testing`. Its line numbers are pinned by `Package.resolved`
and move when the pin moves.

House style throughout, from the user's global instructions: no em
dashes, use `--`. No arrow characters, use `->`. No emoji in file names
or code comments. Prose lines at or under 80 columns.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Design plan, status and body

**Verifies:** AC6.3, and the body half of AC6.4.

**Files:**
- Modify: `docs/design-plans/2026-08-19-random-access-attachments.md`

**Implementation:**

Correct each of the following. Line numbers are from 2026-08-20 and
will drift as you edit; work top-down and re-locate by content.

1. **Line 3** reads "Status: draft design, 2026-08-19. No
   implementation exists yet." The subsystem shipped across six phases.
   Update the status and date.

2. **Lines 64-79**, the "Current state (audit result)" section,
   describes a pre-implementation audit. It is now history. Either mark
   it explicitly as the state at design time, or remove it. Do not
   leave it reading as present tense.

3. **Lines 236-244**, the payload schedule, is wrong in a way that
   matters. The doc derives from a single concatenated `[payload_info]`
   blob. The code uses seven separately framed raw fields
   (`schedule.ts:117-141`), carrying the comment "Framing pinned by
   test_vectors/seal/core/F1.json". Because `sealKdf` lp16-frames each
   element, these are different KDF inputs, not two spellings of one.
   Rewrite the section to match the code.

4. **Line 240** writes the commitment length as literal `32`. The code
   uses `nh`, which is 64 on SHA-512 suites, and the doc's own layout
   at line 296 says `commitment(Nh)`. Fix line 240 to agree with line
   296 and with the code.

5. **`encodePayloadInfo`** (`schedule.ts:85`) produces exactly the
   44-byte blob the old description described, and is referenced only
   by a test. Its doc comment at `schedule.ts:79-84` already says "This
   is NOT the KDF input", so the misleading half is absent; what is
   missing is that it is test-only. Decide and record: either delete
   it, or add the test-only note. Deleting is preferable if nothing
   else needs it; check with a grep before choosing, and say which you
   did in the commit message.

6. **Lines 454 and 547** promise an "incremental builder" in
   `snapshot.ts`. No such thing exists; `snapshot.ts` is three pure
   functions over whole runs, plus multiset functions the design never
   mentions. Remove the promise and describe what is there.

7. **Line 542** says phase 1 uses "pure functions plus `cs.hpke.*Aead`".
   The code built a `SealCrypto` bundle over `crypto/aead.js`. Correct
   it. Note that phase 3 of this plan adds `rng` to that bundle, so
   describe the bundle as it stands after this plan lands.

**Verification:**

For each item, open the cited source file and confirm the corrected
text matches it. For item 3 in particular, read `schedule.ts:117-141`
in full; a paraphrase of a paraphrase is what produced the original
error.

**Commit:** `docs: correct the attachment design plan body`

8. **Line 582** says the interop CI job round-trips "including range
   reads and tamper cases". The harness performs the tamper case but
   not the range read; that leg is skipped, because swift-raae does not
   implement snap_id 0x0003. Phase 5 corrected the AC that made the
   same claim (`random-access-attachments.AC5.2`) but left this line,
   so the design plan now contradicts itself: the AC says no range
   read, line 582 says the CI job does one. Line 582 is where the
   claim originated.

   Added during phase 5 execution rather than during planning. Phase
   5's reviewer identified it, confirmed no phase owned it, and
   recommended recording it here rather than editing design-plan
   history from a phase that did not own the file.

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Design plan, Known Limitations

**Verifies:** AC6.1, AC6.2, and the limitations half of AC6.4.

**Files:**
- Modify: `docs/design-plans/2026-08-19-random-access-attachments.md`
  (the Known Limitations section, from roughly line 632)

**Implementation:**

This section carries the highest density of errors in the repository.
Correct each:

1. **Line 634** says "two open design decisions". Four subsections
   follow. Fix the count, and fix every downstream reference that
   numbers them, including "the second open decision" in
   `src/attachment/AGENTS.md` (task 4).

2. **Lines 647-649** say the design "never addresses whether this is
   intentional". `client-state.ts:1289` uses the word "deliberately".
   Correct the claim.

   The substance of that subsection is right and should stay:
   `applicationExportSecret` is not retained, so prior-epoch CEKs are
   permanently unrecoverable. Add the asymmetry the section currently
   omits, because it is the part an operator needs: other secrets
   survive `retainKeysForEpochs`, default 4, while
   `applicationExportSecret` survives zero epochs, and raising that
   config does not help.

3. **The heading "Fixed ComponentID"** contradicts the per-call
   override at `keys.ts:123`. Reword it.

4. **"Derivation Version Threading"** (lines 654, 662-664). Do not
   delete this one. An earlier revision of this plan said the concept
   has no presence in the code under any spelling; that is wrong.
   `keys.ts:21` carries a NOTE reading that `attachmentCek` "must be
   extended with version threading to support old derivations". The
   limitation is real and the code itself flags it. Rewrite the section
   to point at that NOTE rather than removing it.

   Lines 663-664's "no marker to detect the mismatch" does need
   softening, but carefully: `reference.ts:62-65` versions the
   `AttachmentRef` **wire format**, not the derivation parameters, so
   it is not the marker the sentence is reaching for. Say what it does
   and does not cover rather than swapping one overstatement for
   another.

5. **Lines 673-687** propose lazy per-epoch fetch and verify as future
   work. It already ships: `layout.ts:128-135` fetches only
   `epFirst..epLast`, `range.ts:163-190` copies only those runs, and
   `range.ts:196-198` verifies only those. Replace the section with the
   real limitation, which is the dense zero-filled `Uint8Array`
   allocation at `range.ts:154-156`.

6. **Line 679** says a 128 GiB object has 2^16 segments. At 64 KiB
   segments it has 2^21, that is 2,097,152. Confirm by running
   `layout()` rather than by arithmetic on paper. The adjacent ~96 MiB
   figure at lines 680-681 is correct and is only reachable from 2^21;
   from 2^16 the answer would be 3 MiB. The two numbers currently
   contradict each other and the correct fix is to the segment count.

7. **Lines 680-681** say "one leaf hash per segment". Per-segment
   metadata is `nh + META_TAG_LENGTH`, that is 48 bytes
   (`layout.ts:3,45`), a hash plus a 16-byte tag. A bare hash would
   give 64 MiB, not the 96 MiB stated one clause earlier.

8. **The whole subsection is scoped to `range.ts`.** It is a
   whole-subsystem property: `reader.ts:341` buffers the full
   `headerSize` before emitting a byte. Widen the scope.

9. **Lines 689-696** name `invalidProfileTuple` as the swift-raae
   rejection. It is `ScheduleError.unsupportedSnapID`, thrown at
   `KeySchedule.swift:135-137`, and the `invalidProfileTuple` guard at
   `:152-158` is never reached. Correct it here, and note that the same
   misattribution recurs in `src/attachment/AGENTS.md` (task 4) and in
   the range-read skip comment in `scripts/interop-seal.ts` around line
   396, which phase 5 task 1 corrects. That comment does not contain
   the string `invalidProfileTuple`; it misattributes by citing
   `KeySchedule.swift:152-158`. Do not go looking for a string that is
   not there.

10. **Lines 716 and 723-725** treat `SEAL-attachment` as a profile name
    and conclude `PROTOCOL_RO='SEAL-RO-v1'` is "probably incorrect".
    The repository's own vendored evidence says the opposite.
    `swift-raae/Spec/NOTES.md:139-145` records that draft-02 adds
    `SEAL-attachment` as a named instantiation that is `RO-v1`,
    aligned, epoch-digest-tree, snap_id 0x0003, and
    `Spec/SOURCE.md:40-46` in the same checkout confirms it is an
    instantiation rather than a `protocol_id`. That is exactly this
    implementation's tuple. Rewrite the passage to say the pairing is
    the conformant one, and that swift-raae's rejection is an upstream
    implementation gap rather than a verdict on the tuple.

    This is the single most consequential correction in the phase.
    Acting on the original text would have emitted an undefined
    protocol id and broken conformance, and `protocol_id` feeds every
    Extract salt, so every derived value would have changed.


**Verification:**

Open every cited file and line. For item 6, actually run `layout()`
with a 128 GiB plaintext length and read `nSeg` off the result;
recompute `nEp` and `headerSize` from the same run. For item 10, read
`Spec/NOTES.md:139-145` in the vendored checkout at
`interop/seal-cli/.build/checkouts/swift-raae/`.

**Commit:** `docs: correct the attachment Known Limitations`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Test plan criterion count

**Verifies:** None (small correction, grouped here for one commit).

**Files:**
- Modify: `docs/test-plans/2026-08-19-random-access-attachments.md:10`

**Implementation:**

Line 10 says the coverage audit "returned 15 of 15 criteria covered".
The matrix it refers to is **not** in this file. This file is roughly
65 lines of H1 and H2 step tables; the traceability matrix lives in
`docs/implementation-plans/2026-08-19-random-access-attachments/test-requirements.md`
and has 16 rows, AC1.1 through AC6.1. Fifteen is the machine-coverable
subset; AC6.1 is the human item, which is what the rest of the test
plan exists to describe.

Reword line 10 so the count is unambiguous: 15 of 16 criteria are
automated, and the sixteenth is the human verification this document
covers. Count the rows in `test-requirements.md` yourself before
writing the number.

One other line in this file goes stale as a result of this plan. Line 4
cites a specific unit-assertion total (37,460 at the time of writing).
Phases 1 through 5 add test files, so that number will be wrong by the
time this phase runs. Re-run `npm run test:unit`, read the actual
total, and update it. Do not leave a precise-looking number that is
merely old.

Beyond those two lines, leave this document alone. Both reviewers
checked its numbers against the running demo and found every one exact,
including the 137 Hz seek value and the fetched byte range. It is the
most accurate document in the repository.

**Verification:**

Count the rows in `test-requirements.md`'s traceability matrix
yourself, and take the assertion total from a real
`npm run test:unit` run rather than from this plan.

**Commit:** `docs: fix the covered-criteria count in the test plan`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-6) -->

<!-- START_TASK_4 -->
### Task 4: AGENTS.md corrections

**Verifies:** AC6.5, and part of AC6.2.

**Files:**
- Modify: `src/attachment/AGENTS.md`
- Modify: `AGENTS.md` (root, lines 47-51: the draft count at 47 and the
  invariants description at 48-51)

**Implementation:**

In `src/attachment/AGENTS.md`:

1. **Lines 32-35** give a false rationale for the reader/range import
   ban. They say a sequential read "must not inherit" the full-object
   metadata cost. The sequential reader already pays it:
   `reader.ts:341-375` buffers `l.headerSize`, which by `layout.ts:46`
   includes the entire metadata table, and `verifyHeader` then slices a
   second full copy. The ban is real and enforced by
   `check-attachment-invariants.mjs`; only the reason is wrong. Replace
   it with the true one, which is the dependency direction: `range.ts`
   depends on `reader.ts` and reversing that would make the cycle.

2. **Lines 96-101** repeat the `invalidProfileTuple` error name and
   call the profile question "the second open decision" when it is the
   fourth. Fix both, consistently with task 2.

3. **Line 89** says the harness "round-trips objects". It round-trips
   schedules and segments; it never produces a `sealObject` output.
   Correct it.

4. The "two Internet-Drafts" claim is in the **root** `AGENTS.md`
   around line 47, not in this file, and the count is low. Establish
   the real figure by reading the citations yourself: `schedule.ts`
   cites seal-concrete-00 at line 9 and cfrg-raae-02 at line 11, and
   `keys.ts` cites mls-attachments at line 13 and mls-extensions across
   lines 16-17, where 16 opens the sentence and
   `draft-ietf-mls-extensions-09` sits on 17. Note that the citations
   differ in whether they carry a revision
   suffix; report the drafts as they are actually written rather than
   inventing version numbers. Correct the root `AGENTS.md` to the
   figure you verified.

Preserve this file's honesty. It is the one document that already
discloses the interop gap, the self-generated vectors, and the
epoch-retention decision instead of papering over them. The corrections
above should make it more accurate, not more cautious.

In the root `AGENTS.md`, **lines 48-51** describe
`check-attachment-invariants.mjs` as checking `src/index.ts` plus two
import boundaries. It enforces five checks today, and this plan adds
more: the vendored-vector inventory, the `wipeSealState` presence
check, plus the CEK-ownership and global-RNG checks from phases 2 and
3. As written it would misdiagnose most possible failures. Update it to
list what the script actually does after this plan lands.

**Verification:**

Read `reader.ts:341-375` and `layout.ts:46` before writing item 1. Run
`node scripts/check-attachment-invariants.mjs` and enumerate its checks
from its output before writing the root change.

**Commit:** `docs: correct the attachment AGENTS.md files`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Document the interop CLI contract

**Verifies:** AC6.6.

**Files:**
- Modify: `interop/seal-cli/README.md`

**Implementation:**

Nothing in this README is untrue, and there is no flag mismatch because
there are no flags. The problem is the reverse: the entire request and
response contract is undocumented. A caller cannot use this CLI from
the README alone.

Add:

1. The three ops: `schedule`, `seal_segment`, `open_segment`. For each,
   every request field and every response field, with types. Read them
   off `interop/seal-cli/Sources/seal-cli/main.swift`; the handlers are
   at roughly lines 180-244, 247-349 and 352-440.

2. The error shape, described accurately. `sendError` at
   `main.swift:147-149` is only `sendResponse(["error": message])`. It
   adds no prefix and does not exit; the `error: ` prefix and the
   `exit(1)` come from individual call sites. So a caller sees
   `{"error": "error: <swift description>"}` from `main()`'s catch, and
   plain messages such as `{"error":"invalid payload_info"}` from guard
   failures. Document both shapes, not just the first.

3. Both traps a caller cannot guess:
   - `is_final` is an **int**, compared `== 1`. Any other value reads
     as false.
   - `nonce_hex` is **unconditionally required** by `open_segment`,
     even in derived mode where it is ignored. The harness satisfies
     this by sending an empty string.

4. An example invocation, showing a JSON `op` on stdin.

5. Its only caller: `npm run test:interop`, by way of
   `scripts/run-interop.mjs` and `scripts/interop-seal.ts`.

6. `Segment.encryptDerivedUnmetered` in the list of reasons `@testable`
   is required. The current list omits it.

Also note, in the Implementation Notes section, that `main.swift:84-125`
declares three `Decodable` request structs that are dead: every handler
parses untyped dictionaries. Either delete them as part of this task or
record why they are kept. Deleting is preferable; they are a trap for
the next reader, who will reasonably assume they define the contract.

**Verification:**

For every field you document, find it in `main.swift` and confirm the
name and type. Then run `npm run test:interop` and confirm the request
shapes in `scripts/interop-seal.ts` match what you wrote.

**Commit:** `docs: document the seal-cli JSON contract`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Test-vector README corrections

**Verifies:** AC6.7.

**Files:**
- Modify: `test_vectors/seal/README.md`
- Modify or delete: `test_vectors/seal/core/SOURCE-README.md`
- Modify: `test_vectors/seal/own/README.md`

**Implementation:**

The provenance here is excellent and was independently verified: all
six `core/` and all three `engine/` files are byte-identical to the
swift-raae checkout, `own/` regenerates byte-for-byte, and the pinned
commit matches `Package.resolved`. The corrections are narrow.

1. **`core/SOURCE-README.md`** is a verbatim upstream copy, not
   disclosed as such, and three of its statements are false in this
   repository: it points at a `Spec/SOURCE.md` that does not exist
   here, it calls the directory a "placeholder", and it claims the
   files exist so `Package.swift`'s `.copy("Vectors")` resolves, when
   this repository's only `Package.swift` has no `resources:` block and
   the files are consumed as TypeScript JSON imports. Its "Populated
   starting in Stage 1" uses swift-raae's staging vocabulary, which
   does not exist here.

   Prefer deleting it. If it is kept, it must open by stating it is a
   verbatim copy of an upstream file, retained for provenance, and that
   its claims describe swift-raae rather than this repository.

   It also contains an em dash at line 5, against house style. Deleting
   the file resolves that too.

2. **`test_vectors/seal/README.md:27`** says "Do not edit these files."
   That instruction sits one level above `own/`, where regeneration is
   exactly the right action. Scope the instruction to `core/` and
   `engine/`. The same README's inventory covers all 9 vendored JSON
   vectors but omits `core/SOURCE-README.md` and the whole `own/`
   tree. The full count under `test_vectors/seal/` is 14: 6 core JSON,
   `core/SOURCE-README.md`, 3 engine JSON, 2 own JSON,
   `own/README.md`, and `seal/README.md` itself. Complete the
   inventory, and count the files yourself rather than trusting this
   sentence, which has already been wrong twice.

3. **`engine/` is labelled "SEAL engine end-to-end"** but its three
   files are byte-identical to their `core/` twins and add no KAT data.
   The README partly self-corrects at lines 23-25. Make the label
   match, or explain why the duplication exists.

4. **`own/README.md`** omits that `component_id 0xF001` is a
   provisional private-use value pending IANA, which `keys.ts:11-22`
   states. Add it. It also cites raae-02 as normative without noting
   the snap_id 0x0003 conformance question that `schedule.ts:10-12`
   warns about; cross-reference the design plan's corrected passage
   from task 2.

5. **`own/README.md:70-73`** tells the reader to regenerate by naming a
   `.ts` file with no npm script and no runner in `devDependencies`.
   Phase 5 gives the generator a directory argument and adds
   `scripts/check-vector-determinism.mjs`. Document the actual
   invocation, and mention that determinism is now enforced by
   `npm run test:node`.

**Verification:**

Run `npm run test:node` and confirm the determinism check described in
item 5 behaves as documented. For item 1, confirm the absence of
`Spec/SOURCE.md` and of a `resources:` block before deleting or
rewriting.

**Commit:** `docs: correct the test-vector READMEs`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 7-10) -->

<!-- START_TASK_7 -->
### Task 7: ADR for the attachment subsystem

**Verifies:** None (net-new record).

**Files:**
- Create: `docs/adr/ADR-002-<slug>.md`, following the numbering and
  format of `docs/adr/ADR-001-webcrypto-as-default-backend.md`
- Modify: `docs/adr/INDEX.md`

**Implementation:**

Read `ADR-001` first and match its structure exactly. Do not invent a
format.

Three decisions belong in the record. They may be one ADR or three;
decide based on how ADR-001 is scoped and say why in the commit
message.

1. **`component_id 0xF001`**, a provisional private-use value pending
   IANA assignment (`keys.ts:11-22`). Record the consequence: an IANA
   assignment would change every derived key, so this is a
   wire-breaking value held provisionally.

2. **`SEAL-RO-v1 + snap_id 0x0003`**, the draft-02 SEAL-attachment
   tuple. Record that it is conformant per
   `swift-raae/Spec/NOTES.md:139-145`, that swift-raae does not
   implement the authenticator, and that the consequence is no
   cross-implementation coverage for the epoch digest tree. Reference
   the negative interop case from phase 5.

3. **The in-memory writer.** `sealObject` buffers the whole object, and
   `reader.ts:341` buffers the full header before emitting. Record the
   memory profile as a deliberate accepted cost with the figures from
   task 2's corrected Known Limitations.

Write these as decisions with context and consequences, not as
descriptions. If a decision's rationale is not recoverable from the
code and the design plan, say so in the ADR rather than inventing one.

**Verification:**

Confirm the new file matches ADR-001's section structure heading for
heading, and that `INDEX.md` lists it in the established style.

**Commit:** `docs: record attachment architecture decisions`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: FDR for the attachment feature

**Verifies:** None (net-new record).

**Files:**
- Create: `docs/fdr/FDR-003-<slug>.md`, following
  `docs/fdr/FDR-001-multi-device-demo.md` and
  `docs/fdr/FDR-002-realistic-demo.md`
- Modify: `docs/fdr/INDEX.md`

**Implementation:**

Read both existing FDRs first and match their structure. FDR-003 is the
next number.

Cover the behaviour the feature provides: sealed random-access
attachments keyed from an MLS epoch, a streaming writer and reader, a
range reader supporting seek, and an `AttachmentRef` that rides in
`authenticated_data`.

Record honestly, because both reviewers flagged these:

- The reference's intended placement in `authenticated_data` has no
  executable demonstration anywhere in `test/` or `example/`. Nothing
  rides a ref through a real `PrivateMessage`.
- The demo never creates an MLS group; it feeds `initializeKeySchedule`
  a random epoch secret, so the phase-3 MLS keying path is not
  exercised end to end.
- `AttachmentRef` carries no MLS epoch, so a wrong-epoch read is
  indistinguishable from tampering.

State these as known gaps in the feature record. They are the sort of
thing that becomes invisible once the branch merges, and the FDR is the
right place for them to stay visible.

**Verification:**

Confirm the claims above by grepping `test/` and `example/` for
`createApplicationMessage` and `authenticated_data` usage alongside
attachment refs before writing them down. If the situation has changed
since the audit, write what you find instead.

**Commit:** `docs: add the attachment feature decision record`
<!-- END_TASK_8 -->

<!-- START_TASK_9 -->
### Task 9: Glossary entries

**Verifies:** None (net-new record).

**Files:**
- Modify: `docs/GLOSSARY.md`

**Implementation:**

The glossary has no SEAL or attachment entries. It is organised into
four sections ordered by conceptual dependency: Protocol, Crypto,
Library API, Demo. Its entry format is:

```
**Term** -- one-line definition.
(links)
```

Links point at the spec section, the defining source file, and the
README's long-form explanation, where each exists.

Add entries in the correct sections. Attachment vocabulary is mostly
Library API, since it is invented by this package rather than RFC 9420
vocabulary. Candidates: SEAL, segment, epoch digest tree, epoch head,
snapshot, commitment, CEK, `AttachmentRef`, object id, aligned layout,
range read, `snap_id`, `protocol_id`.

Match the existing entries' brevity. One line each. Link to the
defining file in `src/attachment/`. Note that the README documents
attachments only as two spec links, so for most of these there is no
long-form target and the link list will be shorter than for protocol
terms; that is fine and should not be padded.

**Verification:**

Read a dozen existing entries first. Confirm your additions are
indistinguishable in style, and that every file link resolves.

**Commit:** `docs: add attachment vocabulary to the glossary`
<!-- END_TASK_9 -->

<!-- START_TASK_10 -->
### Task 10: Extend the security audit

**Verifies:** AC6.8.

**Files:**
- Modify: `docs/security-audit.md`

**Implementation:**

The audit is dated 2026-08-09, states its scope as `src/`,
`example-realistic-demo/`, `example-shared/`, `example/` and repo
hygiene, and contains zero mentions of attachment, SEAL, or segment. It
predates the subsystem. It is organised as Critical, High, Medium and
Low findings, and closes with a resolution table mapping each finding
to the commit that fixed it.

Extend it rather than replacing it. Add a scope note recording that
`src/attachment/` was audited separately on 2026-08-20, and add the
findings from that review in the existing severity structure with the
existing id scheme continued.

The findings to record, with their resolutions from this plan:

- Unauthenticated alignment padding, permitting a malleable stored
  object. Resolved by phase 1.
- Derived CEK not zeroized in the three `...ForGroup` wrappers,
  contradicting design security rule 7. Resolved by phase 2. Note
  explicitly that this is the same class as the audit's existing L1 and
  L2, both of which concern un-zeroized key material on normal and
  error paths, and cross-reference them.
- Object salt drawn from the global RNG, bypassing a
  caller-supplied `CryptoProvider`. Resolved by phase 3.
- `openObject` performed no input validation, while the streaming path
  called `validateAttachmentRef`. Resolved by phase 4 for `objectId`
  and `plaintextLength`. Record the residual asymmetry: `openObject`
  takes a structural ref with no `version` field, so the version check
  has no counterpart there. That is a documented deliberate difference,
  not an open finding, and phase 4 records it in
  `src/attachment/AGENTS.md`.
- Duplicated verification logic across two read paths with no
  differential coverage. Mitigated by phase 4's differential test.
  Note that the test mutates bytes only and so does not cover
  ref-shaped divergence.
- No cross-implementation coverage of the epoch digest tree. Open, with
  the reason and the signal recorded by phase 5.

Add rows to the resolution table for each, in its established format.

Where a finding remains open, say so plainly rather than marking it
resolved because a test now describes it.

**Verification:**

Read the existing findings L1 and L2 before writing the CEK entry, so
the cross-reference is accurate. Confirm the resolution table's column
format and follow it.

**Commit:** `docs: extend the security audit to src/attachment`
<!-- END_TASK_10 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase complete when

- Every cited line number in tasks 1 through 6 has been opened and the
  correction checked against the code, not against this plan.
- `npm run test:node` and `npm run test:interop` both pass, confirming
  no documentation edit accidentally touched a source or vector file.
- `docs/adr/INDEX.md` and `docs/fdr/INDEX.md` list the new records.
- No shipped document still names `invalidProfileTuple` as the snap_id
  0x0003 rejection. Verify with:

  ```sh
  grep -rn "invalidProfileTuple" \
      src/ docs/design-plans/ docs/test-plans/ AGENTS.md \
      interop/seal-cli/README.md test_vectors/ scripts/
  ```

  Expected: no matches. Note the exclusions and why. The vendored
  checkout under `interop/seal-cli/.build/` legitimately defines the
  error and must not be edited. This plan's own phase files under
  `docs/implementation-plans/` quote the wrong name deliberately, in
  order to say it is wrong, so a repository-wide grep would match them
  and never go green.
- No document still says the implementation does not exist. Verify by
  reading the design plan's status line.

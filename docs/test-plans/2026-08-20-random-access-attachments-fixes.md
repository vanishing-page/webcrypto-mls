# Human test plan: random-access attachment fixes

Covers `random-access-attachments-fixes.AC1` through `AC6`.

All 18 automated criteria have tests. The original wording here said
those 18 were "verified by mutation rather than by reading"; that was
not true, and `AUDIT-ra.md` said so. Restated 2026-08-22 (US-030 of the
audit remediation), the position is:

- Four of the 18 cannot be mutation-verified at all, so the original
  count was wrong on its face. AC3.2, AC3.3 and AC5.2 are build-time
  gates (`scripts/check-attachment-invariants.mjs` and
  `scripts/check-vector-determinism.mjs`), as is the gate half of AC2.4.
  Each has a negative control instead, which breaks the input the gate
  reads: that is evidence the gate can fail, not evidence a source guard
  is pinned.
- AC3.4 is not mutation-verified by design. It removes dead code and
  adds no test. The surviving guard is redundant across three layers and
  is pinnable only at `layout()`; the AC3.4 section of the fixes plan's
  `test-requirements.md` says which layer and why.
- AC5.1 is conditional: it runs only where a Swift toolchain is present.
  H3 below exists to confirm it ran rather than skipped.
- For the remaining 12 -- AC1.1 through AC1.4, AC2.1 through AC2.3, and
  AC4.1 through AC4.4 -- the phase logs record negative controls and
  reasoning, not a per-criterion mutation run. Read the claim as "each
  has a test whose failure mode was argued", and treat H1 as the place
  the mutation evidence for AC2.4 is actually produced.

`AUDIT-ra.md` also listed guards that survived mutation despite the
original claim: the epoch > 0 read paths, the `MAX_SEGMENTS` ceiling,
the salt length check, `frame()`'s long-field branch, the `locator`
passthrough, the `parsePrefix` and `verifyHeader` byte-length guards,
and the range cancel CEK leak. Each was closed by its own story on this
branch -- PRD US-010 and US-011 for the epoch paths, US-020 for the
ceiling, US-022 for the five guards, and US-004 with US-026 for the
range cancel wipe. `progress.log` records the mutation run behind each.

What remains for a human is the work a test runner cannot do --
confirming that deleting a security check actually breaks a test, that a
disclosure is where a caller will meet it, and that the interop suite ran
rather than skipped.

For the progressive-playback demo, see
`docs/test-plans/2026-08-19-random-access-attachments.md` section H1.
That plan owns the demo verification and its numbers still match the
code. Do not duplicate it here.

## Prerequisites

- `npm run test:node` green. It runs two gates ahead of the suite:
  `check-attachment-invariants.mjs` and `check-vector-determinism.mjs`.
- `npx tsc -p tsconfig.json --noEmit` and `npm run lint` clean.
- For H3 only, a Swift toolchain. Restore the vendored checkout first:
  `cd interop/seal-cli && swift build -c debug`. Debug specifically --
  the CLI uses `@testable import RAAE`, which needs `-enable-testing`,
  and a release build will not compile.

Record the file and line you consulted for each item. That record is
the deliverable, not a pass/fail tick.

## H1: AC2.4, deleting any wipe fails a test

Nine wipe sites, eight of them killable. For each: delete the wipe, run
`npm run test:node`, confirm at least one test in
`test/attachment/cek-wipe.ts` fails, restore, re-run to green.

| # | Site | Expected failure |
|---|---|---|
| 1 | `writer.ts`, `cek.fill(0)` in the finally | writer success/throw |
| 2 | `reader.ts`, `ownedCek.fill(0)` in doWipe | several reader endings |
| 3 | `reader.ts`, `cek.fill(0)` in wrapper catch | construction throw |
| 4 | `range.ts`, `wipeCek()` in start's catch | range error |
| 5 | `range.ts`, `wipeCek()` on pull success | normal close, single-use |
| 6 | `range.ts`, `wipeCek()` in cancel | range cancel |
| 7 | `range.ts`, `close: wipeCek` | range seek-then-abandon |
| 8 | `range.ts`, `cek.fill(0)` in wrapper catch | construction throw |
| 9 | `range.ts`, `wipeCek()` in pull's catch | EXEMPT -- see below |

Site 9 is exempt by construction and the plan says not to manufacture a
test for it. `controller.enqueue` runs before `ctx = null`, so it is not
true that nothing above it can throw first; the exemption holds because
enqueue on a readable, unlocked controller does not throw, and because
`wipeCek` latches on `cekWiped`, so the call there is already a no-op.
Restate that in your log rather than restating the older, wrong reason.

If any of sites 1-8 stays green, that is an unguarded wipe and a real
finding.

## H2: AC2.5, disclosures are where a caller sees them

The criterion is about a reader encountering these, so read them.

1. `AttachmentRangeRead`'s doc comment in `src/attachment/range.ts`:
   abandoning a read without `close()` leaks, and nothing at this layer
   prevents it.
2. The same comment states single-use in its QUALIFIED form -- it holds
   only when the read owns the CEK, which means only via
   `openAttachmentRangeForGroup`.
3. Cross-check 2 against `wipeCek` and the `close` assignment. `wipeCek`
   is `opts?.ownedCek?.fill(0)`, so a direct `openAttachmentRange`
   caller gets a `close()` that zeroes nothing. Confirm the comment says
   that and does not promise a wipe.
4. `close` is ALWAYS present, so `if (read.close)` is not an ownership
   test. Confirm the comment warns against exactly that.
5. `src/attachment/AGENTS.md`, the reader-stream residual gap: it must
   name the CEK, the SealState, AND one buffered segment of decrypted
   plaintext.
6. The `doWipe` comment in `reader.ts`: why the CEK wipe is not
   conditioned on `ctx`, and why a cancel mid-schedule is benign.

## H3: AC5.1, confirm interop ran rather than skipped

1. `cd interop/seal-cli && swift build -c debug`.
2. `npm run test:interop` from the repo root.
3. The output must NOT contain `SKIP: swift toolchain not found`.
4. The snap_id 0x0003 case is present and passing.
5. The last line is `All interop tests passed!`.

A SKIP line means AC5.1 is unverified. Say so; do not record exit 0 as a
pass. The phase is explicit that a skip does not count.

## H4: AC5.3, the reworded criterion matches the harness

Read the per-case lines from H3, then `random-access-attachments.AC5.2`
in the design plan and in the parent `test-requirements.md`. Confirm
item by item that every case named is a case printed, that no range read
is promised, and that the configurations name snap_id 0x0000 and 0x0001
rather than 0x0003. 0x0003 is what the library emits and what swift-raae
rejects, so naming it as a harness configuration would be backwards.

## H5: AC6.1 through AC6.8, documentation accuracy

Open the settling artifact for each, per the traceability table in
`test-requirements.md`. Do not verify a correction against the phase's
own summary of the code -- that is the failure mode the phase exists to
fix, and it recurred repeatedly during execution.

For AC6.1 specifically, run `layout()` at a 128 GiB plaintext length and
read `nSeg`, `nEp` and `headerSize` off the result rather than
recomputing by hand. The expected figures are 2,097,152 segments, and a
header of about 96 MiB at nh=32 and about 160 MiB at nh=64.

## Negative controls

Each exercised once and reverted. These are the definition-of-done item
that says an invariant nobody has seen fail is an invariant nobody knows
works.

- The `getRandomValues` ban: add a call under `src/attachment/`, confirm
  non-zero exit, remove it.
- The `keys.ts` forbidden-import check: add an import of `reference.ts`
  PLUS A USE. An unused import is tree-shaken and the control would
  prove nothing.
- CEK ownership: remove the `{ ownedCek: cek }` argument from the
  `reader.ts` wrapper, confirm non-zero exit.
- Vector determinism: edit one byte of a committed vector, confirm the
  message names that file, restore with `git checkout`, and confirm the
  tree is clean afterwards -- including that no bundle was left behind.
- The AC4.1 differential test: falsify it by weakening one of
  `openObject`'s constant-time comparisons. Do NOT use the
  `bytes.length !== l.totalSize` guard: the sweep flips bytes at fixed
  offsets and never changes length, so removing that guard changes no
  verdict and the test stays green.
- The AC5.1 substring: change the expected rejection reason to something
  swift-raae would not emit, confirm the harness fails, change it back.

## Traceability

| Criterion | Automated | Manual |
|---|---|---|
| AC1.1-AC1.4 | `test/attachment/padding.ts` | none |
| AC2.1-AC2.3 | `test/attachment/cek-wipe.ts` | none |
| AC2.4 | invariants gate, presence only | H1 |
| AC2.5 | none by design | H2 |
| AC3.1 | `object.ts`, `seal-crypto.ts` | none |
| AC3.2, AC3.3 | invariants gate | negative controls |
| AC3.4 | `reader-header.ts`, layout cases | none |
| AC4.1-AC4.4 | `test/attachment/parity.ts` | H5 for the doc half |
| AC5.1 | `scripts/interop-seal.ts` | H3 |
| AC5.2 | `scripts/check-vector-determinism.mjs` | negative control |
| AC5.3 | none by design | H4 |
| AC6.1-AC6.8 | none by design | H5 |
| parent AC6.1, demo | none by design | see the 2026-08-19 plan |

## Known non-coverage, deliberate and documented

None of these is a gap. Each is recorded where a reader will find it.

- AC1.4's empty-gap boundary is verified at the predicate level rather
  than end to end. Reaching an empty gap needs nSeg=1362 at nh=32, about
  85 MiB, which is not viable under `test:browser`. Recorded in
  `test/attachment/padding.ts`, which states the true thing: reachable
  sizes exist and are too large to seal here.
- `range.ts` does not check the padding gap, because a range read never
  fetches those bytes.
- The CEK wipe in `range.ts`'s pull catch is unreachable, per H1 site 9.
- An abandoned range read without `close()`, and an abandoned reader
  stream, both still leak.
- The epoch digest tree has no cross-implementation coverage, because
  swift-raae does not implement snap_id 0x0003. Pinned instead by a
  negative assertion on the rejection reason, which will fail the day
  upstream implements it.
- A range read opened by calling `openAttachmentRange` directly gets a
  `close()` that wipes nothing and is not single-use. Correct behaviour;
  the automated single-use test covers the wrapper path only.

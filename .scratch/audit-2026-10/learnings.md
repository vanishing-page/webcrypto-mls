<!-- nightralph:entry ticket=audit-2026-10:1 attempt=1 outcome=done -->
## 2026-10-11 19:54 -- audit-2026-10/01 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.60. Checked items: "`npm run lint` exits 0.", "The CEK-wipe suite still passes, including the two-latch regression, so the rewritten helper still finds and still misses the same byte runs it did before.", "No eslint configuration file or inline `eslint-disable` comment is added or changed.".

### Agent notes
# Ticket 01: lint passes without labels

Implemented: rewrote `containsBytes` in `test/attachment/cek-wipe.ts`
so the inner loop is `needle.every((byte, j) => hay[i + j] === byte)`
instead of a labeled `continue outer`. Behavior is identical, including
an empty needle (matches at i = 0, as before).

TDD: the failing check was `npm run lint` itself (2 `no-labels`
errors); no separate test was written, as the ticket says it needs
none. Verified: lint exits 0, the bundled cek-wipe suite passes 93/93,
`npm run typecheck` reports no errors. No eslint config or disable
comments touched.

AGENTS.md: no reusable learning beyond what is already documented, so
not changed.

Commit: c2a70b6. Full `npm test` run as the final gate (see below).

Final gate: npm test passed, 47480/47480, exit 0.

---
<!-- nightralph:entry ticket=audit-2026-10:6 attempt=1 outcome=done -->
## 2026-10-11 19:55 -- audit-2026-10/06 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.30. Checked items: "`isClientMessage` accepts an `mls` frame with a `ref` within the bound and one without a `ref`.", "`isClientMessage` rejects an `mls` frame whose `ref` is over the bound or is not a string.", "`isRoomMessage` accepts an `error` frame with and without a bounded `ref`, and rejects an over-long or non-string one.", "A log entry built from an accepted `mls` write that carried a `ref` does not contain the `ref` (asserted at whatever pure function builds the entry, if one exists; otherwise by code inspection noted in the ticket comments).", "`npm run typecheck` and `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` are clean.".

### Agent notes
# Ticket 06: `mls` writes carry an optional `ref`

## Implemented
- protocol.ts: `MAX_REF_LENGTH = 64` (exported, documented in the bounds
  comment); `ref?:string` on the `mls` ClientMessage and the `error`
  RoomMessage; `isOptionalRef` used by both narrowing switches.
- index.ts (Worker): `onMls` takes `msg.ref` and every refusal it sends
  carries it: the no-attachment `bad-message`, `requireMember`
  (`not-member`), `requireKind` (`commit-not-creator`) and
  `requireLogRoom` (rate-limited / log-full / log-too-large). Each of
  those helpers gained an optional `ref` param (all are only called from
  onMls). `requireRoom` answers `no-room`, not an `error`, so it carries
  no ref. A `ref` of undefined is dropped by JSON.stringify, so untagged
  writes get byte-identical frames to before.
- Tests: test/example-realistic-demo/protocol.ts (accept within bound,
  at bound, absent; reject over bound, number, null, object; same for
  `error`). test/example-realistic-demo/room-logic.ts: entryFromMls
  yields exactly {seq,sender,kind,payload} and no trace of a tagged
  write's ref.
- example-realistic-demo/AGENTS.md: paragraph under "Log writes are
  volume-limited too".

## Checklist reading
- "Log entry ... does not contain the ref": entryFromMls in room-logic.ts
  is the pure builder. Its signature (seq, sender, kind, payload) cannot
  receive ref; onMls passes msg fields individually (code inspection,
  index.ts onMls). Added a test pinning the entry's key set.

## Not changed / not run
- probe.mjs: unchanged. It sends no ref and only reads `.reason` off
  errors, so its copied rules need nothing. Not run (needs a live
  Worker via wrangler dev).
- The MLS_WRITE_INTERVAL_MS stale-justification paragraph in
  AGENTS.md and room-logic.ts is ticket 07+'s job.

## Gates
- npm run typecheck: exit 0. Worker tsc: exit 0. npm test: exit 0.
- npm run lint: fails only on pre-existing no-labels errors in
  test/attachment/cek-wipe.ts (another ticket in this audit spec).
- check:style: 11 pre-existing "WHOLE_FILE not changed" entries only.

---
<!-- nightralph:entry ticket=audit-2026-10:5 attempt=1 outcome=done -->
## 2026-10-11 19:56 -- audit-2026-10/05 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.55. Checked items: "`npm run typecheck` and `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` are clean.".

### Agent notes
# 05: demo commits are PrivateMessages

## Item 1 -- commitRemove private, creator name absent
- Test: `test/example-realistic-demo/mls-actions.ts`, new
  "commitRemove does not put the creator's name on the wire"; `pair()`
  takes an optional creator name. The existing "commitRemove produces a
  commit the room can carry" asserted `mls_public_message`; updated to
  `mls_private_message`, since that expectation is what the ticket
  reverses.
- Red: wireformat was public and the name bytes were found in the
  payload (confirms F3). Green: `wireAsPublicMessage: false`.
- "Decoded only from base64 and the MLS envelope": the name search runs
  over the raw bytes after base64, which covers the whole envelope.

## Item 2 -- commitAdd private
- New test "commitAdd does not put the creator's name on the wire";
  existing "commitAdd returns a commit and a Welcome the room can carry"
  flipped to expect `mls_private_message`. Red was the wireformat only:
  the name check passed already (an Add has no UpdatePath), as the audit
  said. Green: `wireAsPublicMessage: false`.
- Also corrected the `identityOf` doc comment, which said the joiner's
  name crosses "again in the public Add".

## Items 3 and 4 -- receivers handle the private framing
- No production change: items 1 and 2 already switched the framing, and
  `processEntry` / `framingOf` read epoch and group id off
  `privateMessage` as well as `publicMessage`. So these tests did not go
  red first; the red for this behavior was the item 1/2 wireformat
  assertions.
- Item 3: the existing "processEntry tells a member they were removed"
  test now asserts the Remove it opens is `mls_private_message`, so it
  cannot silently pass against a public Remove.
- Item 4: new test "a member who stays processes a private Remove of
  somebody else" (three members, remove carol, bob processes it, lands at
  the committer's epoch, same member list). The existing Add-receiver
  test gets the same wireformat guard.
- Committed 3 and 4 together: both are test-only edits in one file.
- apply-entry, chat, approvals, commit-verdict, delivery-client and
  connection suites all pass unchanged.

## Item 5 -- typechecks
- `npm run typecheck` exit 0, no `error TS`; Worker
  `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` exit 0.
  Config-only item, no test.
- `npm run lint` fails on two `no-labels` errors in
  `test/attachment/cek-wipe.ts`. Pre-existing and owned by the spec's
  attachments ticket, so left alone. The two files this ticket touches
  lint clean.
- `npm run check:style` reports 11 violations, all "listed in
  WHOLE_FILE but not changed against main". Pre-existing and unrelated
  to this ticket; no length or character violation in this branch's
  lines.
- Full `npm test`: exit 0, 47491 pass.
- Added a paragraph to `example-realistic-demo/AGENTS.md`: every demo
  commit is private, and a new commit path needs the name-bytes test.
- Explainer copy left unchanged, per the ticket.

---
<!-- nightralph:entry ticket=audit-2026-10:4 attempt=1 outcome=done -->
## 2026-10-11 19:57 -- audit-2026-10/04 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.43. Checked items: "The existing ReInit scenario still passes, and `npm run typecheck` is clean.".

### Agent notes
# Ticket 04: suspended member refuses old-group traffic

## Implemented
- `throwIfSuspendedPendingReinit(state, epoch, contentType)` in
  src/process-messages.ts, called in processPrivateMessage (after the
  groupId check, before any epoch branch / decrypt) and
  processPublicMessage (before the epoch-too-old check and before
  unprotectPublicMessage). Refuses commit/proposal at any epoch and
  application at the current epoch.
- Test: test/scenario/reinit-suspended-receive.ts (sampleCiphersuites),
  imported from test/matrix.ts after reinit.js.

## Progress
- [x] item 1: commit refused (private and public wireformat), bob stays
  suspended with same ReInit params. Red before guard, green after.

## Gotchas
- /tmp is shared with other sessions; a helper script there got
  overwritten. Use unique outfile names in the worktree.
- [x] items 2-3: private and public proposals and a current-epoch
  application message refused. Verified red by short-circuiting the guard.
- [x] items 4-6: historical (pre-ReInit epoch) message delivered after
  all refusals on the same bob state decrypts to the plaintext; send API
  still refuses; joinGroupFromReinit succeeds. Item 4/5 verified red
  against a blanket guard (historical delivery throws).
  Reading of item 5: "input state usable" is shown by doing the
  historical decrypt on the very state every refusal was given.
- [x] item 7: existing ReInit scenario passes (133 asserts), typecheck
  exit 0, full npm test 47532/47532 pass.

## Not fixed (out of ticket)
- `npm run lint` fails on two pre-existing no-labels errors in
  test/attachment/cek-wipe.ts; the spec assigns that to the attachments
  ticket. No lint errors in files this ticket touched.
- AGENTS.md (root) gained a paragraph on the two receive-side guards.

---
<!-- nightralph:entry ticket=audit-2026-10:2 attempt=1 outcome=done -->
## 2026-10-11 19:57 -- audit-2026-10/02 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $2.13. Checked items: "A KDF that rejects at the snapshot epoch root during a range read's root check makes the range read reject, and every buffer of the schedule the KDF returned is all zeros afterwards.", "A successful seal, sequential read and range read over the existing fixtures still return the correct plaintext.".

### Agent notes
# Ticket 02: failed derivation leaves no partial schedule

## Done
- Items 1+2: `deriveSchedule` (src/attachment/schedule.ts) collects each
  derived buffer and zeroes them all in a catch, then rethrows the
  original error. The CEK is never in the list. Commit 7a5ed72.
- Test helper: `test/attachment/kdf-recorder.ts` `recordingSuite(cs)`
  records every `kdf.expand` output by label and can `rejectAt(label,
  err)`. Ticket 03 can add a pause gate beside `rejectAt`.
- Tests: `test/attachment/failed-derivation-wipe.ts`, imported from
  test/unit.ts.

## Readings
- Item 2 ("original KDF error ... same class"): the read paths are
  opaque by design (every failure is AttachmentError, see
  src/attachment/AGENTS.md), so the original error is only observable
  on the seal path, `encryptAttachment`, which propagates crypto errors
  untouched. Pinned there by identity; a mutation substituting
  AttachmentError in the catch makes it fail.
- Item 3: `verifyRoot` (src/attachment/reader.ts) wraps `checkRoot` in
  try/catch, wipes and rethrows. `checkRoot` no longer wipes on a
  mismatch (folded into verifyRoot); the sequential reader already
  stores `state` before `checkRoot`, so its `doWipe` covers it. Pinned
  by the sequential-read mismatch test. Commit 3fd89f0.
- Items 4+5: honest-mismatch tests on both read paths, CEK unchanged
  asserted after every failure. Commit 3693654.
- Item 6: round trip via the recording suite; `npm run test:unit` green.
- Item 7: `npm run test:checks` passes.
- Mutation checks done: substituting AttachmentError for the rethrow
  fails item 2; removing verifyRoot's wipe fails item 3/4 range tests.

## Readings
- Item 3 "every buffer of the schedule": asserted for payload_key,
  acc_key, nonce_base. `commitment` is not asserted there:
  `wipeSealState` deliberately keeps it (it is public, equal to the
  stored commitment in the header), and changing that is out of scope.
  On the schedule-construction failure path (item 1) the commitment
  IS zeroed, since the ticket says "every buffer the KDF returned".

## Not mine / pre-existing
- `npm run lint` fails with two `no-labels` errors in
  test/attachment/cek-wipe.ts. That is ticket 01 of this audit; not
  touched here.
- `npm run check:style` reports 11 violations, all "listed in
  WHOLE_FILE but not changed against main" -- stale list, none from
  this branch's lines.

---
<!-- nightralph:entry ticket=audit-2026-10:10 attempt=1 outcome=done -->
## 2026-10-11 20:03 -- audit-2026-10/10 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.13. Checked items: "CI's `build` job runs the check after the build.", "`npm run build`, `npm run typecheck` and `npm run test:checks` are clean.".

### Agent notes
# Ticket 10 notes

## Done
- scripts/check-package-consumer.mjs (npm run check:package): structural
  rule (no .cjs/.min.cjs requires relative .js), CJS + ESM consumers in a
  scratch dir `.package-consumer-*` inside the checkout (gitignored), the
  package symlinked into its node_modules under its real name. Identity
  check: fail-closed auth service error instanceof UsageError from every
  entry exporting it; every export name shared by two entries must be ===.
- scripts/cjs-specifiers.mjs: post-esbuild rewrite of relative
  require("./x.js") -> .cjs / .min.cjs. Chained into build-cjs and
  build-cjs:min.
- Test decision: the check script is itself the test at the agreed seam
  (built package by name). Red demonstrated first.

## Red against old build-cjs (acceptance item)
Ran `npm run build` with the original build-cjs, then
`npm run check:package`: exit 1. Reported dozens of
"dist/... requires ESM file ./x.js" lines (both .cjs and .min.cjs) and
from the CommonJS consumer:
  error is not instanceof UsageError from .../mls-error
  UsageError from .../mls-error is a different object than from root
  ciphersuites / getCiphersuiteFromName from crypto/ciphersuite differ
ESM consumer passed. No `.package-consumer-*` left behind after the
failing run, nor after the passing one.

## Node versions
Passes on Node 22.22.2 and 26.11.1. On Node 22.5.0 the CommonJS consumer
fails with ERR_REQUIRE_ESM inside @noble/hashes v2 (ESM-only dependency,
needs require(esm), unflagged from 22.12). Not this ticket; CI's 22.x
resolves to the latest 22.

## Gates (final)
build, check:package, typecheck (0 errors), test:checks, npm test
(47480/47480) all clean. `npm run lint` fails only on the pre-existing
two no-labels errors in test/attachment/cek-wipe.ts, which the spec
assigns to the attachments ticket; left alone per "work only on this
ticket". `check:style` reports 11 pre-existing stale WHOLE_FILE entries,
none from this ticket's files.
- CI: new step in `build` job after typecheck. AGENTS.md gates paragraph
  updated. Ticket 11 (TS consumers) should extend check-package-consumer.mjs.

---
<!-- nightralph:entry ticket=audit-2026-10:12 attempt=1 outcome=done -->
## 2026-10-11 20:04 -- audit-2026-10/12 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.85. Checked items: "`npm audit --omit=dev` reports 0 vulnerabilities.", "Every finding plain `npm audit` reports is named in `AGENTS.md` with the reason it stays, and nothing listed there is absent from the report.", "No `@hpke/*` or `@noble/*` version changes in `package-lock.json`.", "`npm ci` from the committed lockfile succeeds.", "`npm run build`, `npm run typecheck`, `npx tsc -p example-realistic-demo/tsconfig.json --noEmit`, `npm run lint` (once ticket 01 has landed) and `npm test` pass.".

### Agent notes
# Ticket 12: npm audit baseline matches AGENTS.md

Pure dependency/docs ticket: no test-first (a test of npm audit output
or of AGENTS.md would be a docs test). Verification is the gate
commands instead.

## What happened
- Baseline: 15 entries. `npm audit fix` (no --force) went to 8, but by
  downgrading remarkable 1.7.4 -> 1.7.3, which pulls argparse 0.1.16 ->
  underscore 1.7.0 (critical) + underscore.string 2.4.0. Rejected.
- Instead: restored lockfile, `npm update brace-expansion concurrently
  handlebars miniflare sharp shell-quote source-map-js undici wrangler`
  (exactly the fixable set). Same upgrades as audit fix minus the
  remarkable downgrade. Result: 6 entries, all under markdown-toc
  (toml, gray-matter, js-yaml, argparse, sprintf-js, remarkable).
- package.json unchanged: existing ranges already admit the new
  versions (concurrently ^10.0.4, wrangler ^4.114.0). Only the lockfile
  changed.
- No @hpke/* or @noble/* change (lockfile diffed by package path).
- AGENTS.md Dependencies section lists the six with reasons and warns
  about the remarkable downgrade trap.

## Gates
- npm ci ok, npm audit --omit=dev 0, build ok, typecheck ok, worker
  typecheck ok.
- npm run lint fails only on the 2 no-labels errors in
  test/attachment/cek-wipe.ts (ticket 01, pre-existing).
- npm test: 47480/47480 pass, exit 0.
- Lint checklist item left to ticket 01 (the checklist itself says
  "once ticket 01 has landed").

---
<!-- nightralph:entry ticket=audit-2026-10:11 attempt=1 outcome=done -->
## 2026-10-11 20:14 -- audit-2026-10/11 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.97. Checked items: "A CommonJS TypeScript consumer importing `attachment/reader`, a nested crypto subpath, `mls-error` and the root compiles under `--module NodeNext --strict` with exit 0.", "An ESM TypeScript consumer of the same subpaths compiles the same way.", "The CommonJS consumer fails to compile against a build with the old `cts.mjs` (the `TS7016` case), demonstrated once and noted in the ticket comments.", "Every `.d.cts` in `dist/` reaches only other `.d.cts` files through its relative references (checked by the CommonJS consumer resolving cleanly, not by comparing file contents).", "`npm run build` and the full package consumer check pass on Node 22.".

### Agent notes
# Ticket 11 notes

## Done
- scripts/cts.mjs: walks dist/ recursively, writes .d.cts (+ .d.cts.map)
  beside every .d.ts, rewrites relative `from './x.js'` and
  `import('./x.js')` specifiers to `.cjs`.
- scripts/check-package-consumer.mjs: TypeScript consumers. consumer.cts
  (`import mN = require(...)`) and consumer.mts (`import * as`) of the
  same ENTRIES (root, mls-error, attachment/reader, attachment/error,
  crypto/ciphersuite), each compiled as its own program under
  module/moduleResolution NodeNext, strict, types [], skipLibCheck off
  (nothing needed it). Uses a value and a type from every entry.
- CommonJS program run with --listFiles; any dist/**/*.d.ts in it fails.
- AGENTS.md: sentence on cts.mjs and the listFiles gotcha.
- Test decision: the check script is the test at the agreed seam.

## Red demonstrations (acceptance item 3)
1. Old cts.mjs (top-level only) + new check: exit 1 with
   TS7016 "Could not find a declaration file for module
   '@vanishing.page/webcrypto-mls/attachment/reader'" (also
   attachment/error and crypto/ciphersuite) in consumer.cts.
2. Recursive cts.mjs WITHOUT the specifier rewrite: tsc 5.9 exits 0
   (NodeNext permits a CJS declaration importing ESM, no TS1479), so a
   clean exit does not prove the closed graph. Added the --listFiles
   check; it then reported 75 "CommonJS types resolved ESM declaration
   dist/...d.ts" lines. With the rewrite restored: passes.

## Item 4 reading
"checked by the CommonJS consumer resolving cleanly": implemented as the
CJS program's resolved file list containing no ESM .d.ts from dist --
a resolution observation, not a file-content comparison.

## Node
build + check:package pass on 22.22.2 and 26.11.1. lint clean,
typecheck 0 errors.

---
<!-- nightralph:entry ticket=audit-2026-10:3 attempt=1 outcome=tests -->
## 2026-10-11 20:16 -- audit-2026-10/03 attempt 1 -- failed (tests)

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $2.16. Checked items: "Regression: a fully buffered object, the KDF paused on the last derivation of the commitment gate, the output stream cancelled, the KDF released, and the operation allowed to settle -- every buffer the KDF returned is all zeros, and the CEK is wiped.", "After that cancel, the stream emits no plaintext chunk.", "The same regression, with the same assertions, for each other entry point found to share the shape.", "A cancel that lands at each other derivation label of the schedule (payload key, `acc_key`, nonce base) leaves every returned buffer zeroed as well.", "An uncancelled read over the same fixture still returns the correct plaintext and the existing CEK-wipe and cancel-epoch-key suites still pass.", "Every test is timing-independent: pause gates only, no sleeps or timers.", "`npm run test:checks` passes.".

Test gate failed.
Last 40 lines of `03-cancel-mid-derivation-wipes-the-schedule.test.log`:
```
ok 47681 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519
ok 47682 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519
ok 47683 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519
ok 47684 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519
ok 47685 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519
ok 47686 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_XWING_AES256GCM_SHA512_Ed25519
ok 47687 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_XWING_AES256GCM_SHA512_Ed25519
ok 47688 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519
ok 47689 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519
ok 47690 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87
ok 47691 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87
ok 47692 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87
ok 47693 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87
ok 47694 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_XWING_AES256GCM_SHA512_MLDSA87
ok 47695 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_XWING_AES256GCM_SHA512_MLDSA87
ok 47696 removing the sole leaf of a group throws ValidationError
# joinGroup rejects a version mismatch MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87
ok 47697 joinGroup throws ValidationError when the KeyPackage version does not match the GroupContext version
# removing the sole leaf of a group is rejected MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87
ok 47698 removing the sole leaf of a group throws ValidationError

1..47698
# tests 47698
# pass  47695
# fail  3
```

### Agent notes
# Ticket 03: cancel mid-derivation wipes the schedule

## Done
- Fix: `src/attachment/reader.ts` -- `cancelled` flag set only in
  cancel(); start() checks it right after `openCommitment` returns,
  calls doWipe() and returns. Two-latch doWipe unchanged; comment
  extended beside it.
- Recorder (`test/attachment/kdf-recorder.ts`): `pauseAt(label)`
  (parks after the output is recorded), `whenRecorded(label)`,
  `decrypts()` (AEAD counter via hpke.decryptAead wrapper).
- Tests: `test/attachment/cancel-mid-derivation.ts`, imported from
  test/unit.ts. Pause at commit/payload_key/acc_key/nonce_base, each
  with owned CEK and caller's CEK; group wrapper; range; round trip.
  21 assertions red before the fix, all green after.

## Entry points checked
- `decryptAttachmentStream`: had the shape. Fixed.
- `decryptAttachmentStreamForGroup`: awaits only `attachmentCek`, before
  the stream exists, so no cancel can land there; it delegates to
  decryptAttachmentStream and inherits the fix. Regression test added
  anyway (it was red before the fix, green after).
- `decryptRangeStream` start(): does NOT share the shape -- it sets
  `ctx` and calls `throwIfCancelled()` right after `verifyRoot`, so the
  catch wipes. Regression test added; passed before and after.

## Readings
- "every buffer the KDF returned is all zeros": asserted for
  payload_key, acc_key, nonce_base (each derived exactly once). Not the
  commitment: public, `wipeSealState` keeps it on purpose -- same
  reading as ticket 02.
- "no plaintext chunk": the pending read resolves done with no value,
  and the AEAD counter is 0.
- Timing: no sleeps. Settle = `whenRecorded('nonce_base')` (the last
  schedule derivation) then one setTimeout(0) queue flush, the same
  flush prior art cancel-epoch-key.ts uses. After nonce_base returns,
  the fixed path to the wipe is promise continuations only.

## Gotcha hit
- Object ids containing a label name (e.g. "...-payload_key") show up
  in the commit derivation's info, so outputs(label) double-counts.
  Fixtures use numeric suffixes. Recorded in src/attachment/AGENTS.md.

## Checks
- lint clean, typecheck 0 errors, test:checks pass.

---
<!-- nightralph:entry ticket=audit-2026-10:7 attempt=1 outcome=done -->
## 2026-10-11 20:18 -- audit-2026-10/07 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $2.99. Checked items: "Every test is timing-independent: the controllable clock and deferred promises only, no sleeps.", "`npm run typecheck`, `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` and `npm run test:checks` (the signal-batching gate) are clean.".

### Agent notes
# Ticket 07 notes

## Pure module
- example-realistic-demo/client/pending-commit.ts: `outcomeOf` (the
  matching rule) and `createPendingCommits` (submit/observe, one pending
  at a time, ref `commit-N`, `closed` outcome when send returns false).
- test/example-realistic-demo/pending-commit.ts, imported from unit.ts.

## Approvals
- approvals.ts: `ApprovalDeps.submitCommit` (wired to
  `pendingCommits.submit`) and optional `wait` (timer by default; the
  test advances the simulated room's clock). `commitAndConfirm` retries
  `rate-limited` up to `MAX_COMMIT_ATTEMPTS` (4), rebuilding only if
  `state.group` moved; `log-full`/`log-too-large` throw at once.
- If the commit is accepted but the Welcome/approve send then fails, the
  creator DOES adopt newState (the commit is in the log; apply-entry
  skips own commits so it could never catch up otherwise). Request stays
  pending in the room. Ticket 09 territory beyond that.
- connection.ts: `ConnectionDeps.observeCommit` fed every live entry,
  every replayed entry in a `log` page, and every `error`, at dispatch
  time (not via the queue -- the queue is blocked behind the group lock
  the waiting approval holds).
- Removal (ticket 08) still uses the old send-and-adopt path.
- Test gotcha: a failing tapzero `t.equal` on a ClientState crashes the
  run (BigInt JSON). New tests use `t.ok(a === b)`.
- Mutation-checked: accept-on-refusal, no retry, no wait, retry
  everything each fail the new tests.
- Status assertions use "changed from a sentinel", never text.

## Gates (final)
- npm run typecheck 0; worker tsc 0; npm run test:checks 0; npm run
  lint 0; npm test 0 (47646 pass).
- check:style: only pre-existing entries (root AGENTS.md:146, .scratch,
  WHOLE_FILE list, connection.ts:612 from 2026-08).
- Timing item: new tests use the simulated room clock and microtasks
  only. The pre-existing lock test still uses longEnoughToHaveFinished
  (a 200ms timer); untouched, it predates this ticket.
- Docs: room-logic.ts MLS_WRITE_INTERVAL_MS comment; AGENTS.md section
  "A commit counts once the room echoes it" and the interval paragraph.
- Not done: probe.mjs not run (needs a live worker); nothing on the
  Worker side changed in this ticket.

---
<!-- nightralph:entry ticket=audit-2026-10:3 attempt=2 outcome=done -->
## 2026-10-11 20:29 -- audit-2026-10/03 attempt 2 -- done

Effort: high. Agent exit: 0. Subagents: 0. Cost: $2.87. Checked items: "Regression: a fully buffered object, the KDF paused on the last derivation of the commitment gate, the output stream cancelled, the KDF released, and the operation allowed to settle -- every buffer the KDF returned is all zeros, and the CEK is wiped.", "After that cancel, the stream emits no plaintext chunk.", "The same regression, with the same assertions, for each other entry point found to share the shape.", "A cancel that lands at each other derivation label of the schedule (payload key, `acc_key`, nonce base) leaves every returned buffer zeroed as well.", "An uncancelled read over the same fixture still returns the correct plaintext and the existing CEK-wipe and cancel-epoch-key suites still pass.", "Every test is timing-independent: pause gates only, no sleeps or timers.", "`npm run test:checks` passes.".

### Agent notes
# Ticket 03: a cancel during the final derivation wipes the schedule

## Done
- Fix: `decryptAttachmentStream` (src/attachment/reader.ts) has a
  `cancelled` latch set only in `cancel()`, declared beside the two
  wipe latches. `start()` checks it right after `openCommitment`
  returns; if set it calls `doWipe()` and returns. That is the only
  await in the sequential `start()` that hands back a SealState.
  The doWipe CEK comment was updated (it described the old
  "checkRoot fails into the catch" route).
- Test helper (test/attachment/kdf-recorder.ts): `pauseAt(label)`
  beside `rejectAt`, parking the expand after its output is recorded;
  `pureKdfSuite(cs)` swaps kdf.extract/expand for noble HKDF-SHA-256
  (same outputs, no WebCrypto I/O); `settle()` is one macrotask turn.
- Tests: test/attachment/cancel-schedule-wipe.ts, imported from
  test/unit.ts. Sequential, group and range entry points, each at
  payload_key, acc_key, nonce_base; plus an uncancelled round trip on
  all three over the same fixture.
- Ticket comments record the three entry points checked.
- AGENTS.md (src/attachment) paragraph after the two-latch one.

## Readings
- "Every buffer the KDF returned is all zeros": the public KDF
  outputs are excluded -- `commit` (equals the stored commitment,
  wipeSealState keeps it on purpose, same reading as ticket 02),
  `snap_epoch` heads (stored in the header) and `snap_epoch_root`
  (the ref's snapshot). Everything else, including the group path's
  CEK and exporter-tree nodes, is asserted zero.
- "No sleeps or timers": the gate makes the race deterministic. The
  only timer is `settle()`, a zero-delay macrotask turn, and it is a
  queue flush rather than a wait: with `pureKdfSuite` and the whole
  object in one chunk, everything after the release is microtasks.
  I see no observable event for "start() has returned" after a
  cancel, so some flush is needed; this is the same pattern as the
  prior-art `flush()` in cancel-epoch-key.ts, made sound by removing
  WebCrypto from the KDF.
- "No plaintext chunk": the read pending at cancel resolves done, and
  an hpke.decryptAead counter stays at 0.
- "The CEK is wiped": the sequential test passes the CEK as
  `ownedCek` and asserts it zero; the group tests see the CEK as a
  recorded KDF output.

## Findings
- Red before the fix: sequential and group at acc_key and nonce_base.
  payload_key was already green (later keys derive from the wiped
  CEK, the root check fails, the catch wipes). Range was green at all
  three: it already does `ctx = ...; throwIfCancelled()` after
  verifyRoot.
- Gotcha: an objectId containing a label (I first used
  `f4-seq-payload_key`) makes `pauseAt` fire on the commit
  derivation, because commit frames the objectId into its info.
  Fixture ids use an index now; noted in AGENTS.md.

## Gates
- npm run typecheck: exit 0. npm run lint: exit 0.
  npm run test:checks: exit 0.
- npm test: exit 0, 47696 tests, 47696 pass, 0 fail (final gate,
  run after the last code commit).

---
<!-- nightralph:entry ticket=audit-2026-10:8 attempt=1 outcome=done -->
## 2026-10-11 20:42 -- audit-2026-10/08 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.24. Checked items: "An accepted Remove sends `removed` after the commit's echo, the creator moves to the new epoch, and a remaining member processes a creator application message at that epoch.", "A `log-full` refusal of a Remove sends no `removed` frame and leaves the creator's epoch unchanged; the member being removed still processes a creator application message.", "A `rate-limited` refusal of a Remove followed by the interval completes the removal, and the removed member reaches the removed state.", "An approval and a removal inside one interval leave every remaining member at the creator's epoch.", "`npm run typecheck`, `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` and `npm run test:checks` are clean.".

### Agent notes
# Ticket 08 notes

## Implemented
- approvals.ts: `commitAndConfirm` is now generic over a builder
  `(from:ClientState) => Promise<{commit}>`; Add passes `commitAdd`,
  Remove passes a builder that re-resolves the leaf index when the
  group moved between retries. `removeMember` sends `removed` and
  writes `state.group` only after acceptance. If the commit is accepted
  but `removed` cannot be sent, the creator adopts newState (same rule
  07 used for Add: the commit is in the log).
- Removed unused imports (`CiphersuiteImpl`, `KeyPackage`) and the
  `AddCommitted` type alias.

## Tests (test/example-realistic-demo/approvals.ts)
- Harness extended (not duplicated): `room.removals` records each
  `removed` frame with whether the last commit's own echo had already
  been delivered (`afterEcho`).
- Four new tests, one per checklist item; red against the old send-and-
  adopt path (15 failures), green after.
- Existing "remove sends the commit before telling the room" now
  advances `room.now` by the interval first: the remove otherwise lands
  in the Add's interval and the sent list gains a refused first `mls`.
  The order assertion itself is unchanged.

## Gates
- npm run typecheck 0; worker tsc 0 errors; npm run test:checks 0;
  npm run lint 0; npm test 0 (47755 pass).
- check:style: only pre-existing entries (.scratch, root AGENTS.md,
  WHOLE_FILE list); nothing in files this ticket touched.
- Docs: example-realistic-demo/AGENTS.md "A commit counts once the room
  echoes it" now covers Remove and the interval gotcha in tests.

---
<!-- nightralph:entry ticket=audit-2026-10:9 attempt=1 outcome=done -->
## 2026-10-11 20:53 -- audit-2026-10/09 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $2.13. Checked items: "Add: a drop after the commit, with the commit in the replay, finishes the approval; the joiner processes a creator application message.", "Add: a drop after the commit, with the commit absent from the replay, sends no Welcome and no `approve` and leaves the creator's epoch unchanged.", "Remove: the same two cases hold for `removed` and the creator's epoch.", "A replay that spans several pages settles only on the last page (`more` false), not on an earlier page that lacks the echo.", "The pure module: settlement at the end of a replay with no own echo yields lost; an echo on any page before the end yields accepted.", "`npm run typecheck`, `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` and `npm run test:checks` are clean.".

### Agent notes
# Ticket 09 notes

## Implemented
- pending-commit.ts: two new CommitSignal variants, `reconnected` and
  `replay-end`; a `lost` refusal reason; `awaitsReplay()`. A
  `replay-end` settles the pending commit as lost only if a
  `reconnected` came after its submit (`interrupted` flag, reset on
  submit). On a live socket, a paged replay that was already running
  when the commit went out ends without it, so it must not count.
- connection.ts: `onOpen` feeds `reconnected` (every open, not only
  isReconnect -- a manual connect() also orphans the old socket's
  answer); a `log` page with `more` false feeds `replay-end` after its
  entries; `room-state` sends `replay` from `state.cursor` when
  `deps.commitAwaitsReplay()` is true. Reason: the room skips the
  page after `hello` when it is empty (sendReplayPage evenIfEmpty
  false), so without the explicit replay a lost commit with nothing
  newer in the log would never settle. Sending `replay` right after
  `hello` would race onHello's async requireProof and get bad-message;
  room-state is sent from hello after attach, so it is the safe moment.
- ConnectionDeps gains required `commitAwaitsReplay`; wired in
  client/index.ts.
- approvals.ts: doc comment only; `lost` flows through the existing
  refusal path (reported, not retried).
- No Worker change.

## Tests
- pending-commit.ts: lost at replay end, accepted by echo on an
  earlier page, replay-end on a live socket settles nothing,
  reconnect with nothing pending.
- connection.ts: only the last page ends a replay; the replay request
  after room-state when a commit waits on one (and none otherwise);
  the existing signals test now expects `reconnected`/`replay-end`.
- approvals.ts harness: `room.dropOnCommit` ('logged'|'unlogged'),
  `reconnect()`, `replayPages(pageSize)`. Five tests: Add logged,
  Add unlogged, Remove logged, Remove unlogged, paged replay. Against
  the old module the unlogged case hangs (never settles) -- the red.

## Gates
typecheck 0, worker tsc 0 errors, test:checks 0, lint 0, npm test 0
(47788 pass). check:style: only pre-existing root AGENTS.md:152.

---

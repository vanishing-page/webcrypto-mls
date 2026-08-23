# Random-Access Attachments Implementation Plan -- Phase 5: Interop

**Goal:** Two-tier interoperability against swift-raae, the only
other implementation of the drafts: an always-on sweep of every
vendored vector in `npm test`, and a gated live round-trip harness
that cross-checks TypeScript and Swift in both directions.

**Architecture:** Tier 1 is a normal unit test file. Tier 2 adds a
tiny SwiftPM executable (`interop/seal-cli/`) wrapping swift-raae's
`RAAE` core product behind a strict JSON stdin/stdout contract, plus
a Node harness script that builds and drives it. The harness skips
cleanly when no `swift` toolchain is present; a CI job on a macOS
runner (Swift preinstalled) runs it on every push. Cross-impl
round-trips run at the SEAL-core level (schedule and segments),
which is what swift-raae exposes byte-exactly; the range-read case
assembles a full aligned object in TypeScript from Swift-sealed
segments and range-reads it.

**Tech Stack:** SwiftPM (swift-tools 6), swift-raae pinned to the
vendored commit, Node harness via the repo's esbuild single-file
pattern, GitHub Actions macos runner.

**Scope:** Phase 5 of 6 from
`docs/design-plans/2026-08-19-random-access-attachments.md`.

**Codebase verified:** 2026-08-19

**Style rules:** same as Phase 1. Swift code: match swift-raae's
own formatting (tabs, per its repo).

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments.AC5: Interoperability

- **random-access-attachments.AC5.1 Success:** Vendored swift-raae
  Appendix F vectors pass in the standard node test run.
- **random-access-attachments.AC5.2 Success:** When a Swift
  toolchain is available, the interop harness round-trips both
  directions (TypeScript encrypt then Swift decrypt, and the
  reverse) including a range read and a tamper rejection.

---

<!-- START_SUBCOMPONENT_A (task 1) -->
<!-- START_TASK_1 -->
### Task 1: Vendored-vector sweep

**Verifies:** random-access-attachments.AC5.1.

**Files:**
- Create: `test/attachment/vectors-all.ts` (unit)
- Modify: `test/unit.ts`

**Step 1: Write the sweep test**

Import EVERY JSON file under `test_vectors/seal/core/` and
`test_vectors/seal/engine/` explicitly (esbuild JSON imports; no
dynamic directory reads in the bundle). For each vector:

- Build `SealParams` + `SealCrypto` from its `payload_info` (the
  Task 1 / phase 1 helpers).
- Assert every schedule field the vector carries (commitment,
  payload key, snap key, nonce base).
- Assert every per-segment field it carries (seal and open).
- Assert every multiset snapshot field it carries (contrib,
  accumulator, snapshot, masked accumulator) via the phase 2
  functions.
- For fields the vector does not carry, assert nothing, but
  `t.comment` which sections were skipped so coverage is visible in
  TAP output.

This intentionally overlaps phase 1/2's targeted tests; its job is
that NO vendored file is silently unconsumed.

**Step 2: Enforce the inventory OUTSIDE the bundle**

A hardcoded in-bundle count would compare a literal to a literal
and verify nothing. Instead extend
`scripts/check-attachment-invariants.mjs` (created in phase 4,
already chained into `test:node`) with an inventory check: read
every `.json` filename under `test_vectors/seal/core/` and
`test_vectors/seal/engine/` (`node:fs.readdirSync`), read
`test/attachment/vectors-all.ts` as text, and fail if any vendored
filename does not appear in an import specifier in that file.
Print the counts on success.

**Step 3: Register, run, commit**

```ts
import './attachment/vectors-all.js'
```

```bash
npm run test:node
```

Expected: the invariants script now also prints the vector
inventory counts; all tests pass. Then temporarily rename one
import in `vectors-all.ts`, re-run to confirm the inventory check
fails, and revert.

```bash
git add test/attachment/vectors-all.ts test/unit.ts \
  scripts/check-attachment-invariants.mjs
git commit -m "attachment: sweep all vendored SEAL vectors"
```
<!-- END_TASK_1 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-5) -->
<!-- START_TASK_2 -->
### Task 2: Swift CLI wrapper

**Verifies:** random-access-attachments.AC5.2 (infrastructure).

**Files:**
- Create: `interop/seal-cli/Package.swift`
- Create: `interop/seal-cli/Sources/seal-cli/main.swift`
- Create: `interop/seal-cli/README.md`

**Step 1: `Package.swift`**

```swift
// swift-tools-version:6.0
import PackageDescription

let package = Package(
	name: "seal-cli",
	platforms: [.macOS(.v14)],
	dependencies: [
		.package(
			url: "https://github.com/germ-network/swift-raae",
			revision: "REPLACE_WITH_VENDORED_COMMIT"
		),
	],
	targets: [
		.executableTarget(
			name: "seal-cli",
			dependencies: [
				.product(name: "RAAE", package: "swift-raae"),
			]
		),
	]
)
```

Use the commit hash recorded in `test_vectors/seal/README.md`.

**Step 2: The stdin/stdout contract (fixed; the Node harness
depends on it exactly)**

One JSON request on stdin, one JSON response on stdout, exit 0 on
success and 1 on any failure with `{"error":"..."}` on stdout.
Request shapes:

```json
{"op":"schedule","protocol_id":"...","cek_hex":"...",
 "g_hex":"...","payload_info":{"aead_id":2,"segment_max":65536,
 "kdf_id":1,"snap_id":3,"nonce_mode":1,"epoch_length":10,
 "salt_hex":"..."}}
```
Response: `{"commitment_hex":"...","payload_key_hex":"...",
"acc_key_hex":"...","nonce_base_hex":"..."}` (omit nonce_base for
random mode).

```json
{"op":"seal_segment", ...schedule fields..., "index":0,
 "is_final":true, "plaintext_hex":"...", "nonce_hex":"..."}
```
Response: `{"ct_hex":"...","tag_hex":"...","nonce_hex":"..."}`
(`nonce_hex` in the request only for random mode; always in the
response).

```json
{"op":"open_segment", ...schedule fields..., "index":0,
 "is_final":true, "ct_hex":"...", "tag_hex":"...",
 "nonce_hex":"..."}
```
Response: `{"plaintext_hex":"..."}`; auth failure exits 1.

**Step 3: `main.swift`**

Write it against swift-raae's `RAAE` product (KeySchedule /
Segment / PayloadInfo types). The exact type and method names must
be taken from the vendored clone -- read
`Tests/RAAETests/*.swift` for canonical usage before writing; the
vendored files under `/tmp/swift-raae-vendor` from phase 1 (or
re-clone) are the reference. Keep the JSON contract from Step 2
byte-exact regardless of internal API shape. Decode hex with a
small local helper; use `JSONSerialization` or `Codable` structs;
no third-party dependencies.

**Step 4: Verify (only when `swift` is installed locally)**

```bash
command -v swift && (cd interop/seal-cli && swift build) || \
  echo "swift not installed; CI covers the build"
```

**Step 5: `interop/seal-cli/README.md`**: one paragraph stating
purpose, the contract, and the pin. Commit:

```bash
git add interop
git commit -m "interop: Swift CLI wrapper over swift-raae"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Node interop harness

**Verifies:** random-access-attachments.AC5.2.

**Files:**
- Create: `scripts/interop-seal.ts`
- Create: `scripts/run-interop.mjs`
- Modify: `package.json` (add script)

**Step 1: Write `scripts/interop-seal.ts`**

Flow (uses `node:child_process.spawnSync` to call the CLI binary,
built once at start with
`swift build -c release --package-path interop/seal-cli`; binary
path from `swift build --show-bin-path`):

1. If `swift` is not on PATH: print
   `SKIP: swift toolchain not found` and exit 0.
2. Config under test: SEAL-RO-v1, AES-256-GCM (aead_id 2),
   HKDF-SHA-256 (kdf_id 1), derived nonces, epoch_length 10,
   snap_id 3, segment_max 65536, random salt and CEK from
   `globalThis.crypto.getRandomValues`, G = ascii `interop-object`.
   Also run a second config with random nonces (nonce_mode 0) to
   cover the stored-nonce path.
3. Schedule cross-check: TS `startSeal` vs CLI `schedule`; compare
   all fields. Mismatch = fail.
4. TS -> Swift: TS seals 3 segments (two full, one final short);
   CLI `open_segment` each; compare plaintext.
5. Swift -> TS: CLI `seal_segment` each; TS `openSegment`; compare.
6. Range read: assemble a full aligned object in TS from the
   Swift-sealed ct/tags (`segmentLeaf`/`epochHead`/`epochTreeRoot`
   + layout writes, mirroring `sealObject`'s assembly but with the
   Swift ciphertexts); then `openAttachmentRange` for a window
   crossing segments 0 and 1, serving ranges from the assembled
   bytes; compare with the plaintext slice.
7. Tamper: flip one ct byte, CLI `open_segment` must exit nonzero;
   TS `openSegment` must throw.
8. Print a summary line per case; exit 1 on any failure.

**Step 2: The runner and the package.json script**

Create `scripts/run-interop.mjs`:

```js
// Bundles and runs the interop harness. Mirrors the esbuild
// settings of scripts/run-tests.mjs.
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const outfile = '.interop-bundle.cjs'
buildSync({
    entryPoints: ['scripts/interop-seal.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    keepNames: true,
    loader: { '.json': 'json' },
    outfile,
})
const result = spawnSync(process.execPath, [outfile], {
    stdio: 'inherit',
})
rmSync(outfile, { force: true })
process.exit(result.status ?? 1)
```

(Before writing, compare with `scripts/run-tests.mjs` and copy any
additional esbuild options it sets -- e.g. externals -- so the two
runners stay consistent.)

Add to `package.json` `scripts`:

```json
"test:interop": "node scripts/run-interop.mjs"
```

**Step 3: Run locally**

```bash
npm run test:interop
```

Expected on a machine with Swift: all cases pass. Without Swift:
the SKIP line, exit 0.

**Step 4: Commit**

```bash
git add scripts package.json
git commit -m "interop: TS to Swift round-trip harness"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: CI job

**Verifies:** random-access-attachments.AC5.2 (automation).

**Files:**
- Modify: `.github/workflows/nodejs.yml`

**Step 1: Add the job**

Append a job alongside the existing `build` and `test` jobs,
following the file's existing conventions (checkout + Node 22
setup + `npm ci` come from the existing jobs -- copy their steps):

```yaml
  interop:
    runs-on: macos-14
    timeout-minutes: 20
    steps:
      # same checkout/node/npm ci steps as the test job
      - run: npm run test:interop
```

macOS runners ship a Swift toolchain; no extra setup step. Do not
make other jobs depend on it.

**Step 2: Verify YAML parses**

```bash
npx --yes js-yaml .github/workflows/nodejs.yml > /dev/null
```

(`js-yaml`'s CLI exits nonzero on a parse error; do not suppress
stderr.)

**Step 3: Commit**

```bash
git add .github/workflows/nodejs.yml
git commit -m "ci: SEAL interop job on macos"
```

Note for the operator: the job's first real verification happens on
push; if the runner image lacks `swift` for some reason the harness
prints SKIP and exits 0, which is visible in the job log and should
be treated as a follow-up, not a green result for AC5.2.
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Phase verification

**Verifies:** phase gate for AC5.1-AC5.2.

```bash
npm run lint && npm run build && npm run test:node && \
  npm run test:fast
npm run test:interop
git status --porcelain
```

Expected: all green (interop passes with Swift installed, or
prints the SKIP line without it -- record which in the task log);
empty status.
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

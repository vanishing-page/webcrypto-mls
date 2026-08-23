# SEAL / raAE test vectors

Vendored from https://github.com/germ-network/swift-raae
(MIT license), commit `f2ce71641b933e5dd02b1a4f5dabeb85cbd77c2e`,
which implements draft-sullivan-cfrg-raae-02. The JSON files
transcribe the draft's Appendix F vectors, including intermediate
schedule values.

`core/` comes from Tests/RAAETests/Vectors (byte-exact core),
`engine/` from Tests/SEALTests/Vectors (SEAL engine end-to-end).

**Complete file inventory under test_vectors/seal/:**

Vendored files (do not edit; re-vendor at a newer commit to update):
9 JSON files in total, of which 6 hold distinct known-answer data:
- `core/F1.json`, `core/F5.json`, `core/F9.json`, `core/F16.json`,
  `core/F17.json`, `core/F23.json` (6 core vectors from swift-raae)
- `engine/F16.json`, `engine/F17.json`, `engine/F23.json` (3 engine vectors,
  each byte-identical to the core file of the same name; included for SEAL
  engine end-to-end verification even though they add no new KAT data, so
  the 9 total is 6 vectors' worth of data read twice over)

`scripts/check-attachment-invariants.mjs` pins those two counts and the
byte-identity claim, so this list and the directory cannot drift apart.

Self-generated; see `own/README.md` for how they are produced. There is
no TypeScript runner in devDependencies, so the generator is not run
directly. Determinism is enforced by `npm run test:node`, which regenerates into
a temporary directory and compares the vectors. The files:
- `own/epoch-tree.json`, `own/keys.json` (2 regression vectors)
- `own/README.md` (documentation)

This directory:
- `README.md` (this file)

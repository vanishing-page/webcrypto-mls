# seal-cli

Swift CLI wrapper over swift-raae for interop testing. Implements a JSON
stdin/stdout contract for cross-implementation round-trip verification of
SEAL-core encryption and decryption.

Pinned to swift-raae commit `f2ce71641b933e5dd02b1a4f5dabeb85cbd77c2e`
(draft-sullivan-cfrg-raae-02).

## Implementation Notes

### @testable import requirement

This CLI uses `@testable import RAAE` to access internal key material and
package-scoped functions:
- `Segment.encryptRandom` is package-scoped in swift-raae's public API
- Derived keys (`payloadKey`, `snapKey`, `nonceBase`) are internal only

These are necessary for the interop contract to verify schedule
cross-checks and test random-mode encryption. The public API alone is
insufficient.

As a result, **this CLI must be built in debug mode** (`swift build -c debug`),
not release. The `@testable` attribute is only available for debug builds
because the library must be compiled with `-enable-testing`. Release builds
will fail.

### snap_id scope limitation

The test configuration uses `snap_id 0x0000` (SEAL-RO-v1, no snapshot) for
derived mode and `snap_id 0x0001` (SEAL-RW-v1, masked multiset) for random
mode. These are the only snapshot authenticators swift-raae implements.

The cross-implementation check therefore covers the SEAL core (framed KDF,
payload schedule, derived nonces, epoch keys, per-segment seal and open) and
**does NOT cover `snap_id 0x0003`'s epoch digest tree**, because no other
implementation provides it yet. The epoch tree design and attachment CEK
derivation remain locked only by our own frozen vectors.

Also note `Segment.encryptDerivedUnmetered` in the `@testable` list -- the
CLI uses this to seal segments without rate-limit checks, which the public
API does not expose.

## JSON Contract

The CLI reads one JSON object on stdin and writes one to stdout. Every
request and response is a single-line JSON object (no pretty-printing).

### Three operations

The `op` field selects one of three operations:

#### `schedule`

Builds the payload schedule from CEK, protocol ID, and payload info.

**Request fields:**
- `op` (string): `"schedule"`
- `protocol_id` (string): Protocol ID bytes as a UTF-8 string (e.g.,
  `"SEAL-RO-v1"`)
- `cek_hex` (string): Hex-encoded CEK (32 bytes for AES-256)
- `g_hex` (string): Hex-encoded global associated data
- `payload_info` (object): Payload schedule parameters:
  - `aead_id` (int): AEAD cipher suite ID
  - `kdf_id` (int): KDF suite ID
  - `segment_max` (int): Maximum segment size in bytes
  - `snap_id` (int): Snapshot authenticator ID
  - `nonce_mode` (int): Nonce mode (0 = random, 1 = derived)
  - `epoch_length` (int): Epoch boundary bits (e.g., 10 for 1024 segments)
  - `salt_hex` (string): Hex-encoded salt (32 bytes)

**Response fields (on success):**
- `commitment_hex` (string): Hex-encoded commitment (Nh bytes, where Nh is
  the hash output length for the KDF)
- `payload_key_hex` (string): Hex-encoded payload key
- `acc_key_hex` (string): Hex-encoded accumulator key (snapshot key)
- `nonce_base_hex` (string): Hex-encoded nonce base, **only in derived
  nonce mode** (omitted in random mode)

#### `seal_segment`

Encrypts one segment under the schedule.

**Request fields:**
- `op` (string): `"seal_segment"`
- `protocol_id` (string): Protocol ID bytes as UTF-8
- `cek_hex` (string): Hex-encoded CEK
- `g_hex` (string): Hex-encoded global associated data
- `payload_info` (object): Payload info (same structure as `schedule`)
- `index` (int): Segment index (0-based)
- `is_final` (int): Final flag: **1 for true, 0 or any other value for
  false** (compared as `== 1`)
- `plaintext_hex` (string): Hex-encoded plaintext to seal
- `nonce_hex` (string): Hex-encoded nonce, **required in random nonce
  mode only**. `handleSealSegment` reads it inside the
  `nonceMode == .random` branch and the derived branch never touches
  it, so in derived mode it may be omitted. The harness passes an empty
  string there, which is accepted because it is never read.

**Response fields (on success):**
- `ct_hex` (string): Hex-encoded ciphertext (without tag)
- `tag_hex` (string): Hex-encoded authentication tag
- `nonce_hex` (string): Hex-encoded nonce actually used

#### `open_segment`

Decrypts one segment under the schedule.

**Request fields:**
- `op` (string): `"open_segment"`
- `protocol_id` (string): Protocol ID bytes as UTF-8
- `cek_hex` (string): Hex-encoded CEK
- `g_hex` (string): Hex-encoded global associated data
- `payload_info` (object): Payload info (same structure as `schedule`)
- `index` (int): Segment index
- `is_final` (int): Final flag (1 = true, 0 or other = false)
- `ct_hex` (string): Hex-encoded ciphertext (without tag)
- `tag_hex` (string): Hex-encoded authentication tag
- `nonce_hex` (string): Hex-encoded nonce, **unconditionally
  required**, including in derived mode where the nonce is recomputed
  rather than taken from the request. It is in `handleOpenSegment`'s
  top-level guard alongside `ct_hex` and `tag_hex`, so omitting it
  fails with "missing open_segment fields". The harness always sends a
  real nonce here; the empty-string case belongs to `seal_segment`.

**Response fields (on success):**
- `plaintext_hex` (string): Hex-encoded decrypted plaintext

### Error responses

On error, the response is `{"error":"<message>"}`. The error handling
splits across sender and call site:

- `sendError` at `main.swift:147-149` sends only `{"error": message}`
  with no prefix and does not exit.
- Exactly one call site prepends `"error: "` -- `main()`'s catch. The
  other call sites send plain messages. Every call site calls `exit(1)`
  itself, because `sendError` does not.

So a caller sees:
- `{"error": "error: <swift error description>"}` from the `main()`
  function's catch handler (lines 174-177)
- `{"error":"<plain message>"}` from guard failures in request parsing
  (e.g., `{"error":"invalid payload_info"}` at line 200)

There is a third shape you will not normally see: if `sendResponse`
cannot encode the response, its fallback writes a JSON **array**,
`[{"error":"failed to encode response"}]`, rather than an object.

The harness (`scripts/interop-seal.ts`) treats exit status 0 and 1
interchangeably and inspects only the `error` field in the JSON
response.

### Example invocation

The hex values below are elided as `0123...` for readability. Pasting
them verbatim fails in `Hex.decode`; substitute real hex.

```sh
echo '{"op":"schedule",
  "protocol_id":"SEAL-RO-v1",
  "cek_hex":"0123...",
  "g_hex":"0123...",
  "payload_info":{"aead_id":2,
                  "segment_max":65536,
                  "kdf_id":1,
                  "snap_id":0,
                  "nonce_mode":1,
                  "epoch_length":10,
                  "salt_hex":"0123..."}}' | swift run seal-cli
```

### Caller: npm run test:interop

`scripts/run-interop.mjs` and `scripts/interop-seal.ts` are the only
callers of this CLI. `npm run test:interop` builds and invokes them.

## Implementation notes continued

The dead request structs (`ScheduleRequest`, `SealSegmentRequest`,
`OpenSegmentRequest` at `main.swift:83-125`) define the contract but are
never used; every handler parses dictionaries manually instead. They exist
for clarity but trap the next reader who will reasonably assume they define
the contract. Recommendation: delete them or add a comment explaining why
they are kept.

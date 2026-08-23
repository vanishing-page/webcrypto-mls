# Random-Access Attachments Implementation Plan -- Phase 1: SEAL core

**Goal:** Implement the SEAL segment-encryption core (framed KDF,
payload schedule, derived nonces, epoch keys, per-segment seal/open)
as pure functions, verified byte-for-byte against swift-raae's
vendored draft Appendix F vectors.

**Architecture:** New `src/attachment/` modules with no MLS
dependencies. The core takes a small `SealCrypto` bundle (raw Aead +
Kdf + Hash) rather than a full `CiphersuiteImpl`, because the draft
vectors pair AES-256-GCM with HKDF-SHA-256, a combination no MLS
ciphersuite provides. Library callers later build the bundle from
their ciphersuite; tests build it from the standalone constructors
in `src/crypto/implementation/default/`.

**Tech Stack:** TypeScript (strict, ES2022), WebCrypto via existing
`makeAead`/`makeKdfImpl`/`makeHashImpl`, @substrate-system/tapzero
tests bundled by esbuild.

**Scope:** Phase 1 of 6 from
`docs/design-plans/2026-08-19-random-access-attachments.md`.

**Codebase verified:** 2026-08-19

**Normative sources (pinned):** draft-sullivan-cfrg-raae-02
(wire-compatible with -03), draft-sullivan-seal-concrete-00.
swift-raae v0.2.0 (pins raae-02) supplies the vectors. Key pins:
payload_info is 44 octets / 7 fields (no segment_commitment byte);
`commitment_length` defaults to Nh; aad_label is `"SEAL-DATA"`;
derived nonce XORs `uint64((i << 1) | is_final)` into the last 8
nonce octets; epoch keys are mandatory at every epoch_length.

**Repo style rules (apply to every task):** 80-column lines, no
space around `:` in type annotations, named exports only, no em
dashes or arrow glyphs in comments, `function` declarations for
top-level functions. Comments state constraints only.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments.AC1: SEAL segment encryption core

- **random-access-attachments.AC1.1 Success:** Given draft
  test-vector inputs (CEK, salt, payload_info), the payload schedule
  (commitment, payload_key, snap_key, nonce_base) and each segment
  ciphertext match the vector bytes exactly.
- **random-access-attachments.AC1.2 Success:** A sealed segment
  opens only with the same index and finality flag it was sealed
  with; any other (index, finality) pair fails.
- **random-access-attachments.AC1.3 Failure:** Opening with a wrong
  CEK or wrong object_id (global associated data) fails at the
  commitment check before any AEAD operation, surfacing a single
  opaque error type.
- **random-access-attachments.AC1.4 Failure:** A modified ciphertext
  byte or tag fails to open.

---

<!-- START_SUBCOMPONENT_A (task 1) -->
<!-- START_TASK_1 -->
### Task 1: Vendor swift-raae test vectors

Infrastructure task. **Verifies: None** (enables AC1.1 and AC5.1).

**Files:**
- Create: `test_vectors/seal/core/F1.json` (and siblings, copied)
- Create: `test_vectors/seal/engine/F16.json` (and siblings, copied)
- Create: `test_vectors/seal/README.md`

Context: `test_vectors/` already exists at the repo root holding
the RFC 9420 vectors (crypto-basics.json etc.); this task adds a
`seal/` subdirectory beside them. The existing consumption pattern
to follow later is a direct ES JSON import, see
`test/test-vectors/key-schedule.ts:14`.

**Step 1: Clone the source at a pinned commit**

```bash
git clone --depth 1 https://github.com/germ-network/swift-raae \
  /tmp/swift-raae-vendor
git -C /tmp/swift-raae-vendor rev-parse HEAD
```

Record the printed commit hash; it goes in the README.

**Step 2: Verify the source directories, then copy**

Both directories were verified to exist at swift-raae v0.2.0
(2026-08-19): `Tests/RAAETests/Vectors/` holds F1, F5, F9, F16,
F17, F23 plus a README; `Tests/SEALTests/Vectors/` holds F16, F17,
F23. Gate on their presence anyway (a newer pin may reorganize):

```bash
ls /tmp/swift-raae-vendor/Tests/RAAETests/Vectors/*.json
ls /tmp/swift-raae-vendor/Tests/SEALTests/Vectors/*.json
```

If either listing fails, STOP and locate where the vectors moved in
the upstream tree before continuing; do not proceed with a partial
vendoring.

```bash
mkdir -p test_vectors/seal/core test_vectors/seal/engine
cp /tmp/swift-raae-vendor/Tests/RAAETests/Vectors/*.json \
  test_vectors/seal/core/
cp /tmp/swift-raae-vendor/Tests/SEALTests/Vectors/*.json \
  test_vectors/seal/engine/
cp /tmp/swift-raae-vendor/Tests/RAAETests/Vectors/README.md \
  test_vectors/seal/core/SOURCE-README.md 2>/dev/null || true
```

List the actual copied set in the README.

**Step 3: Write `test_vectors/seal/README.md`**

Content (fill in the recorded hash and actual file list):

```markdown
# SEAL / raAE test vectors

Vendored from https://github.com/germ-network/swift-raae
(MIT license), commit `<hash>`, which implements
draft-sullivan-cfrg-raae-02. The JSON files transcribe the draft's
Appendix F vectors, including intermediate schedule values.

`core/` comes from Tests/RAAETests/Vectors (byte-exact core),
`engine/` from Tests/SEALTests/Vectors (SEAL engine end-to-end).

Do not edit these files. To update, re-vendor at a newer commit and
note the draft revision it pins.
```

**Step 4: Verify the JSON parses**

```bash
for f in test_vectors/seal/core/*.json test_vectors/seal/engine/*.json; \
  do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
  || echo "BAD $f"; done
```

Expected: no `BAD` lines.

**Step 5: Read one vector and record its shape**

Read `test_vectors/seal/core/F1.json` in full. Known fields at
swift-raae v0.2.0: `name`, `source`, `protocol_id`, `cek_hex`,
`payload_info` (object with `aead_id`, `segment_max`, `kdf_id`,
`snap_id`, `nonce_mode`, `epoch_length`, `salt_hex`), `schedule`
(object with `commitment_hex`, `payload_key_hex`, and more). Note
the exact names of the per-segment fields (index, nonce, plaintext,
ciphertext, tag, finality) and of the snap-key/nonce-base schedule
fields; Task 5's loader must use the names as they actually appear.
Also note whether a global-associated-data (`g` or similar) field
exists; if none exists, G is the empty byte string for these
vectors.

**Step 6: Commit**

```bash
git add test_vectors/seal
git commit -m "test vectors: vendor swift-raae SEAL vectors"
```
<!-- END_TASK_1 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-6) -->
<!-- START_TASK_2 -->
### Task 2: Framed KDF and error type

**Verifies:** random-access-attachments.AC1.1 (partially; asserted
in Task 5), AC1.3's single-error requirement (type created here).

**Files:**
- Create: `src/attachment/error.ts`
- Create: `src/attachment/kdf.ts`

**Step 1: Create `src/attachment/error.ts`**

```ts
/**
 * Single opaque error for every attachment integrity failure.
 * Callers must not be able to distinguish a commitment mismatch
 * from an AEAD or snapshot failure, so no detail is attached.
 */
export class AttachmentError extends Error {
    constructor () {
        super('attachment integrity failure')
        this.name = 'AttachmentError'
    }
}
```

**Step 2: Create `src/attachment/kdf.ts`**

```ts
import type { Kdf } from '../crypto/kdf.js'

const encoder = new TextEncoder()

// Salt for LH(), the large-field hash used by frame() and by
// snapshot leaves. draft-sullivan-cfrg-raae-02 section 4.3:
// LH(x) = Extract("raAE-LP-v1", x).
const LP_SALT = encoder.encode('raAE-LP-v1')

export function ascii (s:string):Uint8Array {
    return encoder.encode(s)
}

export function uint16be (n:number):Uint8Array {
    const out = new Uint8Array(2)
    new DataView(out.buffer).setUint16(0, n)
    return out
}

export function uint32be (n:number):Uint8Array {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, n)
    return out
}

export function uint64be (n:bigint):Uint8Array {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigUint64(0, n)
    return out
}

export function concatAll (parts:Uint8Array[]):Uint8Array {
    const len = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(len)
    let offset = 0
    for (const p of parts) {
        out.set(p, offset)
        offset += p.length
    }
    return out
}

export async function lh (x:Uint8Array, kdf:Kdf):Promise<Uint8Array> {
    return kdf.extract(LP_SALT, x)
}

/**
 * frame(x): length-prefixed field. Fields longer than 0xFFFE are
 * replaced by 0xFFFF || LH(x). raae-02 section 4.3.
 */
export async function frame (
    x:Uint8Array,
    kdf:Kdf,
):Promise<Uint8Array> {
    if (x.length <= 0xFFFE) {
        return concatAll([uint16be(x.length), x])
    }
    return concatAll([uint16be(0xFFFF), await lh(x, kdf)])
}

/**
 * encode(x1, ..., xn) = frame(x1) || ... || frame(xn).
 * Strings are framed as their ASCII bytes.
 */
export async function encode (
    kdf:Kdf,
    ...parts:(Uint8Array|string)[]
):Promise<Uint8Array> {
    const framed:Uint8Array[] = []
    for (const p of parts) {
        const bytes = typeof p === 'string' ? ascii(p) : p
        framed.push(await frame(bytes, kdf))
    }
    return concatAll(framed)
}

/**
 * The SEAL KDF. raae-02 section 4.3 (two-step HKDF form):
 *   extract_input = encode(protocol_id, label, ...ikm)
 *   prk = Extract(salt = protocol_id, ikm = extract_input)
 *   expand_info = encode(protocol_id, label, ...info, uint16(L))
 *   out = Expand(prk, expand_info, L)
 */
export async function sealKdf (
    kdf:Kdf,
    protocolId:string,
    label:string,
    ikm:Uint8Array[],
    info:Uint8Array[],
    length:number,
):Promise<Uint8Array> {
    const extractInput = await encode(kdf, protocolId, label, ...ikm)
    const prk = await kdf.extract(ascii(protocolId), extractInput)
    const expandInfo = await encode(
        kdf, protocolId, label, ...info, uint16be(length),
    )
    return kdf.expand(prk, expandInfo, length)
}

export function constantTimeEqual (
    a:Uint8Array,
    b:Uint8Array,
):boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
}
```

**Step 3: Verify it compiles and lints**

```bash
npm run build && npm run lint
```

Expected: both succeed with no new errors.

**Step 4: Commit**

```bash
git add src/attachment/error.ts src/attachment/kdf.ts
git commit -m "attachment: framed KDF and opaque error type"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Payload schedule and segment seal/open

**Verifies:** random-access-attachments.AC1.1, AC1.2, AC1.3, AC1.4
(implementation; tests land in Task 5).

**Files:**
- Create: `src/attachment/schedule.ts`
- Create: `src/attachment/crypto.ts`

**Step 1: Create `src/attachment/crypto.ts`** (the SealCrypto
bundle and its constructors)

Two constructors with different provider semantics:
`sealCryptoFromCiphersuite` MUST reuse the caller's
`CiphersuiteImpl` primitives (`cs.kdf`, `cs.hash`,
`cs.hpke.encryptAead`/`decryptAead`) so a consumer on the noble
provider never silently gets default-provider WebCrypto; the code
points come from the authoritative suite table via
`getCiphersuiteFromName(cs.name)` (`src/crypto/ciphersuite.ts:79`)
-- NEVER from parsing `cs.name` or from `cs.kdf.size` (the ML-KEM
suites 0xF001+ deliberately use a kdf that differs from their
name). `sealCryptoFromIds` builds standalone primitives for the
vector combinations MLS does not offer (AES-256-GCM +
HKDF-SHA-256) and is test-facing.

```ts
import type { Aead, AeadAlgorithm } from '../crypto/aead.js'
import type { Kdf, KdfAlgorithm } from '../crypto/kdf.js'
import type { Hash, HashAlgorithm } from '../crypto/hash.js'
import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'
import { getCiphersuiteFromName } from '../crypto/ciphersuite.js'
import { makeAead } from '../crypto/implementation/default/make-aead.js'
import {
    makeKdf,
    makeKdfImpl,
} from '../crypto/implementation/default/make-kdf-impl.js'
import {
    makeHashImpl,
} from '../crypto/implementation/default/make-hash-impl.js'
import { AttachmentError } from './error.js'

export const TAG_LENGTH = 16

// RFC 5116 AEAD registry and RFC 9180 KDF registry code points.
export const AEAD_IDS:Record<AeadAlgorithm, number> = {
    AES128GCM: 0x0001,
    AES256GCM: 0x0002,
    CHACHA20POLY1305: 0x001D,
}

export const KDF_IDS:Record<KdfAlgorithm, number> = {
    'HKDF-SHA256': 0x0001,
    'HKDF-SHA384': 0x0002,
    'HKDF-SHA512': 0x0003,
}

export const AEAD_KEY_LENGTHS:Record<AeadAlgorithm, number> = {
    AES128GCM: 16,
    AES256GCM: 32,
    CHACHA20POLY1305: 32,
}

export interface SealCrypto {
    aead:Aead
    kdf:Kdf
    hash:Hash
    aeadId:number
    kdfId:number
    keyLength:number
    nonceLength:number
}

/**
 * Wrap a caller-provided CiphersuiteImpl. Reuses the caller's own
 * primitives (whatever CryptoProvider built them); only the
 * registry code points come from the suite table.
 */
export function sealCryptoFromCiphersuite (
    cs:CiphersuiteImpl,
):SealCrypto {
    const suite = getCiphersuiteFromName(cs.name)
    const aeadAlg = suite.hpke.aead
    const kdfAlg = suite.hpke.kdf
    return {
        aead: {
            encrypt: (key, nonce, aad, pt) =>
                cs.hpke.encryptAead(key, nonce, aad, pt),
            decrypt: (key, nonce, aad, ct) =>
                cs.hpke.decryptAead(key, nonce, aad, ct),
        },
        kdf: cs.kdf,
        hash: cs.hash,
        aeadId: AEAD_IDS[aeadAlg],
        kdfId: KDF_IDS[kdfAlg],
        keyLength: cs.hpke.keyLength,
        nonceLength: cs.hpke.nonceLength,
    }
}

const AEAD_BY_ID:Record<number, AeadAlgorithm> = {
    0x0001: 'AES128GCM',
    0x0002: 'AES256GCM',
    0x001D: 'CHACHA20POLY1305',
}

const KDF_BY_ID:Record<number, {
    alg:KdfAlgorithm
    hash:HashAlgorithm
}> = {
    0x0001: { alg: 'HKDF-SHA256', hash: 'SHA-256' },
    0x0002: { alg: 'HKDF-SHA384', hash: 'SHA-384' },
    0x0003: { alg: 'HKDF-SHA512', hash: 'SHA-512' },
}

/**
 * Standalone constructor for arbitrary (aead_id, kdf_id) pairs;
 * used by vector tests, which need combinations no MLS ciphersuite
 * offers. Uses the default provider's primitives.
 */
export async function sealCryptoFromIds (
    aeadId:number,
    kdfId:number,
):Promise<SealCrypto> {
    const aeadAlg = AEAD_BY_ID[aeadId]
    const k = KDF_BY_ID[kdfId]
    if (!aeadAlg || !k) throw new AttachmentError()
    const [aead] = await makeAead(aeadAlg)
    const kdf = makeKdfImpl(makeKdf(k.alg))
    const hash = makeHashImpl(globalThis.crypto.subtle, k.hash)
    return {
        aead,
        kdf,
        hash,
        aeadId,
        kdfId,
        keyLength: AEAD_KEY_LENGTHS[aeadAlg],
        nonceLength: 12,
    }
}
```

Check `HashAlgorithm`'s actual literal values in
`src/crypto/hash.ts` ('SHA-256' style WebCrypto names were
verified) and that `Ciphersuite.hpke.aead`/`kdf` carry the
`AeadAlgorithm`/`KdfAlgorithm` literals (see
`src/crypto/hpke.ts:11-15`).

Registry note: `AEAD_IDS` uses the RFC 5116 AEAD registry (ChaCha
is 0x001D there), while `KDF_IDS` uses RFC 9180 -- that mix is what
draft-sullivan-mls-attachments specifies. The vendored vectors are
the tiebreaker: if a vector's `payload_info.aead_id` encodes ChaCha
differently (e.g. HPKE's 0x0003), the vector wins -- adjust
`AEAD_BY_ID`/`AEAD_IDS` with a comment naming the vector.

**Step 2: Create `src/attachment/schedule.ts`**

```ts
import {
    concatAll, constantTimeEqual, encode, sealKdf,
    uint16be, uint32be, uint64be,
} from './kdf.js'
import type { SealCrypto } from './crypto.js'
import { TAG_LENGTH } from './crypto.js'
import { AttachmentError } from './error.js'

// Profile constants. protocol_id doubles as the profile name in
// draft-sullivan-seal-concrete-00.
export const PROTOCOL_RO = 'SEAL-RO-v1'
export const PROTOCOL_RW = 'SEAL-RW-v1'
export const AAD_LABEL = 'SEAL-DATA'
export const NONCE_RANDOM = 0x00
export const NONCE_DERIVED = 0x01
export const SNAP_NONE = 0x0000
export const SNAP_MULTISET = 0x0001
export const SNAP_EPOCH_TREE = 0x0003
export const SEGMENT_MAX = 65536
export const ATTACHMENT_EPOCH_LENGTH = 10
export const SALT_LENGTH = 32

export interface SealParams {
    protocolId:string
    aeadId:number
    kdfId:number
    segmentMax:number
    snapId:number
    nonceMode:number
    epochLength:number
    salt:Uint8Array
}

/**
 * 44-octet payload_info. raae-02 section 4.4.1: aead_id u16 ||
 * segment_max u32 || kdf_id u16 || snap_id u16 || nonce_mode u8 ||
 * epoch_length u8 || salt(32). Big endian. No segment_commitment
 * byte; that flag is a profile property, not wire data.
 */
export function encodePayloadInfo (p:SealParams):Uint8Array {
    if (p.salt.length !== SALT_LENGTH) throw new AttachmentError()
    return concatAll([
        uint16be(p.aeadId),
        uint32be(p.segmentMax),
        uint16be(p.kdfId),
        uint16be(p.snapId),
        Uint8Array.of(p.nonceMode),
        Uint8Array.of(p.epochLength),
        p.salt,
    ])
}

export interface SealState {
    params:SealParams
    commitment:Uint8Array
    payloadKey:Uint8Array
    snapKey:Uint8Array
    nonceBase:Uint8Array|null
    crypto:SealCrypto
}

async function deriveSchedule (
    cek:Uint8Array,
    params:SealParams,
    g:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    const { kdf } = crypto
    const pid = params.protocolId
    const info = [encodePayloadInfo(params)]
    const nh = kdf.size
    const commitment = await sealKdf(
        kdf, pid, 'commit', [cek], [...info, g], nh,
    )
    const payloadKey = await sealKdf(
        kdf, pid, 'payload_key', [cek], info, crypto.keyLength,
    )
    const snapKey = await sealKdf(
        kdf, pid, 'acc_key', [cek], info, nh,
    )
    const nonceBase = params.nonceMode === NONCE_DERIVED ?
        await sealKdf(
            kdf, pid, 'nonce_base', [cek], info, crypto.nonceLength,
        ) :
        null
    return { params, commitment, payloadKey, snapKey, nonceBase, crypto }
}

export async function startSeal (
    cek:Uint8Array,
    params:SealParams,
    g:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    return deriveSchedule(cek, params, g, crypto)
}

/**
 * Key-commitment gate: recompute the commitment and compare in
 * constant time BEFORE any AEAD operation. raae-02 section 4.5.1.
 */
export async function startOpen (
    cek:Uint8Array,
    params:SealParams,
    g:Uint8Array,
    storedCommitment:Uint8Array,
    crypto:SealCrypto,
):Promise<SealState> {
    const state = await deriveSchedule(cek, params, g, crypto)
    if (!constantTimeEqual(state.commitment, storedCommitment)) {
        throw new AttachmentError()
    }
    return state
}

export async function segmentKey (
    state:SealState,
    index:bigint,
):Promise<Uint8Array> {
    const epochIndex = index >> BigInt(state.params.epochLength)
    return sealKdf(
        state.crypto.kdf,
        state.params.protocolId,
        'epoch_key',
        [state.payloadKey],
        [uint64be(epochIndex)],
        state.crypto.keyLength,
    )
}

/**
 * Derived nonce. raae-02 section 4.5.3.2:
 * nonce_base[0:Nn-8] || (nonce_base[Nn-8:] XOR uint64((i<<1)|f)).
 */
export function derivedNonce (
    nonceBase:Uint8Array,
    index:bigint,
    isFinal:boolean,
):Uint8Array {
    const nonce = nonceBase.slice()
    const mixed = (index << 1n) | (isFinal ? 1n : 0n)
    const tail = uint64be(mixed)
    const start = nonce.length - 8
    for (let i = 0; i < 8; i++) nonce[start + i] ^= tail[i]
    return nonce
}

/**
 * Per-segment AAD. raae-02 section 4.4.2. In derived mode index
 * and finality live in the nonce, so empty extra AAD means an
 * empty AAD pass.
 */
export async function segmentAad (
    state:SealState,
    index:bigint,
    isFinal:boolean,
    extra:Uint8Array,
):Promise<Uint8Array> {
    const { kdf } = state.crypto
    if (state.params.nonceMode === NONCE_DERIVED) {
        if (extra.length === 0) return new Uint8Array()
        return encode(kdf, AAD_LABEL, extra)
    }
    const finalByte = Uint8Array.of(isFinal ? 1 : 0)
    if (extra.length === 0) {
        return encode(kdf, AAD_LABEL, uint64be(index), finalByte)
    }
    return encode(kdf, AAD_LABEL, uint64be(index), finalByte, extra)
}

export interface SealedSegment {
    ciphertext:Uint8Array
    tag:Uint8Array
    nonce:Uint8Array
}

export async function sealSegment (
    state:SealState,
    opts:{
        index:bigint
        isFinal:boolean
        plaintext:Uint8Array
        nonce?:Uint8Array
        aad?:Uint8Array
    },
):Promise<SealedSegment> {
    const { index, isFinal, plaintext } = opts
    const extra = opts.aad ?? new Uint8Array()
    const nonce = state.params.nonceMode === NONCE_DERIVED ?
        derivedNonce(state.nonceBase!, index, isFinal) :
        opts.nonce!
    if (!nonce) throw new AttachmentError()
    const key = await segmentKey(state, index)
    const aad = await segmentAad(state, index, isFinal, extra)
    const sealed = await state.crypto.aead.encrypt(
        key, nonce, aad, plaintext,
    )
    const split = sealed.length - TAG_LENGTH
    return {
        ciphertext: sealed.slice(0, split),
        tag: sealed.slice(split),
        nonce,
    }
}

export async function openSegment (
    state:SealState,
    opts:{
        index:bigint
        isFinal:boolean
        ciphertext:Uint8Array
        tag:Uint8Array
        nonce?:Uint8Array
        aad?:Uint8Array
    },
):Promise<Uint8Array> {
    const { index, isFinal } = opts
    const extra = opts.aad ?? new Uint8Array()
    const nonce = state.params.nonceMode === NONCE_DERIVED ?
        derivedNonce(state.nonceBase!, index, isFinal) :
        opts.nonce!
    if (!nonce) throw new AttachmentError()
    const key = await segmentKey(state, index)
    const aad = await segmentAad(state, index, isFinal, extra)
    const joined = concatAll([opts.ciphertext, opts.tag])
    try {
        return await state.crypto.aead.decrypt(key, nonce, aad, joined)
    } catch (_err) {
        throw new AttachmentError()
    }
}
```

Append one more export (zeroization, design security rule 7; the
phase 4 readers and writer call it on close):

```ts
/**
 * Best-effort zeroization of derived key material. The CEK is the
 * caller's to wipe; the commitment is not secret and survives for
 * error reporting.
 */
export function wipeSealState (state:SealState):void {
    state.payloadKey.fill(0)
    state.snapKey.fill(0)
    state.nonceBase?.fill(0)
}
```

Unused-import check: remove any import the final file does not
reference; the linter enforces this.

**Step 3: Verify compile and lint**

```bash
npm run build && npm run lint
```

**Step 4: Commit**

```bash
git add src/attachment/crypto.ts src/attachment/schedule.ts
git commit -m "attachment: SEAL payload schedule and segment ops"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Resolve the commitment framing against vector F1

**Verifies:** random-access-attachments.AC1.1 (the framing choice
this task locks is what makes AC1.1 pass).

The draft writes `commitment = KDF(pid, "commit", [CEK],
[...payload_info, G], Nh)`. Two readings exist: (A) payload_info as
one framed 44-octet field, or (B) the seven fields framed
individually. When G is empty it may be framed as a zero-length
field or omitted. The vector decides; do not guess.

**Files:**
- Create then delete: `.probe-framing.ts` (repo root, temporary)
- Possibly modify: `src/attachment/schedule.ts` (deriveSchedule)

**Step 1: Write the probe**

`.probe-framing.ts`: import `sealKdf`, `encodePayloadInfo`,
`sealCryptoFromIds`; load `test_vectors/seal/core/F1.json`; build
`SealParams` from its `payload_info` (hex-decode `salt_hex`); then
compute the commitment four ways and print which matches
`schedule.commitment_hex`:

1. info = `[payloadInfoBytes, emptyG]`
2. info = `[payloadInfoBytes]` (G omitted when empty)
3. info = seven raw field byte-strings then `emptyG`
4. info = seven raw field byte-strings only

If F1.json carries a non-empty global associated data field, use it
instead of `emptyG` in variants 1 and 3.

**Step 2: Run the probe** (single-file pattern from AGENTS.md)

```bash
npx esbuild .probe-framing.ts --bundle --platform=node --format=cjs \
  --loader:.json=json --keep-names --outfile=.tmp.cjs && \
  node .tmp.cjs; rm .tmp.cjs
```

Expected: exactly one variant prints MATCH. If none matches, also
try the same four variants with `payload_key_hex` (label
`payload_key`, no G) to isolate whether the mismatch is in the
framing or in the base KDF; report findings and stop for operator
input if still unresolved -- do not proceed with a guessed framing.

**Step 3: Lock the winning variant**

If the winner is not variant 1 (the implemented default), edit
`deriveSchedule` in `src/attachment/schedule.ts` to match, with a
comment naming the vector that pins it:

```ts
// Framing pinned by test_vectors/seal/core/F1.json
```

**Step 4: Delete the probe, verify, commit**

```bash
rm -f .probe-framing.ts
npm run build && npm run lint
git add src/attachment/schedule.ts
git commit -m "attachment: pin schedule framing to F1 vector"
```

(Skip the commit if variant 1 already matched and no edit was
needed; note that in the task log instead.)
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: SEAL core tests

**Verifies:** random-access-attachments.AC1.1, AC1.2, AC1.3, AC1.4.

**Files:**
- Create: `test/attachment/helpers.ts`
- Create: `test/attachment/seal-core.ts` (unit)
- Modify: `test/unit.ts` (register the new file)

**Step 1: Write `test/attachment/helpers.ts`**

Helpers shared by all attachment tests:

```ts
export function fromHex (hex:string):Uint8Array {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return out
}

export function toHex (bytes:Uint8Array):string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}
```

Plus `paramsFromVector(json)` mapping a vendored vector's
`payload_info` object to `SealParams` (use the exact field names
recorded in Task 1 step 5, including `protocol_id` from the top
level), and `sealCryptoFromVector(json)` calling
`sealCryptoFromIds(payload_info.aead_id, payload_info.kdf_id)`.

**Step 2: Write `test/attachment/seal-core.ts`**

Import `test` from `@substrate-system/tapzero`, the vendored core
vectors as JSON imports, and the schedule module. Tests to write
(behavior, not implementation details):

- AC1.1 schedule: for each core vector file, `startSeal` with the
  vector's CEK/params/G and `t.equal(toHex(...), ..._hex)` for
  commitment, payload key, snap key, and (when the vector is
  derived-mode) nonce base. Skip fields a vector does not carry.
- AC1.1 segments: for each per-segment entry in each vector,
  `sealSegment` with the vector's index/finality/plaintext (passing
  the stored nonce for random-mode vectors) and compare ciphertext
  and tag hex; then `openSegment` and compare the plaintext.
- AC1.2: seal a segment at index 3n non-final with a derived-mode
  params object (build one: protocol SEAL-RO-v1, derived nonces,
  epoch_length 10, snap_id 0x0003, fresh random salt via
  `globalThis.crypto.getRandomValues`); assert `openSegment` at
  index 4n rejects, at index 3n final rejects, and at index 3n
  non-final succeeds. Assert rejection with try/catch and
  `t.ok(err instanceof AttachmentError)`.
- AC1.3: `startOpen` with a flipped CEK byte rejects; `startOpen`
  with a different G rejects; both throw `AttachmentError`, and no
  AEAD call is involved (structural: `startOpen` never touches the
  aead -- assert only the error type).
- AC1.4: flip one ciphertext byte, `openSegment` rejects; flip one
  tag byte, rejects.
- Zeroization: `wipeSealState(state)` leaves `payloadKey`,
  `snapKey`, and `nonceBase` all-zero (design security rule 7; the
  stream and object layers call it on close, wiring is checked in
  their phase gates).

**Step 3: Register in `test/unit.ts`**

Add to the top-level import block, matching the existing style:

```ts
import './attachment/seal-core.js'
```

**Step 4: Run the tests**

```bash
npm run test:unit
```

Expected: all new tests pass, no existing test breaks.

**Step 5: Commit**

```bash
git add test/attachment test/unit.ts
git commit -m "attachment: SEAL core vector and negative tests"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Phase verification

**Verifies:** phase gate for AC1.1-AC1.4.

**Step 1: Full verification**

```bash
npm run lint && npm run build && npm run test:unit
```

Expected: all pass. Run `npm run test:fast` as well to confirm no
matrix regression (attachment code touches nothing in the matrix
path, so this is a smoke check).

**Step 2: Confirm no stray files**

```bash
git status --porcelain
```

Expected: empty (probe and bundles cleaned up).
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->

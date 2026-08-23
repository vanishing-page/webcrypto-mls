# Random-Access Attachments Implementation Plan -- Phase 3: MLS keying and refs

**Goal:** Derive per-attachment CEKs from the MLS group via the Safe
Extensions exporter tree, and define the `AttachmentRef` type that
rides in a signed MLS message's authenticated data.

**Architecture:** One small core change (derive
`application_export_secret` in the key schedule, per
draft-ietf-mls-extensions-09) plus two new modules:
`src/attachment/keys.ts` (exporter tree walk + CEK derivation;
imports NOTHING from the rest of `src/attachment/` except the error
type, so consumers can use MLS keying with their own encryption
scheme) and `src/attachment/reference.ts` (TLS codec for the
reference). CEK derivation is locked with frozen vectors because no
draft vectors exist for this layer.

**Tech Stack:** as Phase 1; codec combinators from `src/codec/`.

**Scope:** Phase 3 of 6 from
`docs/design-plans/2026-08-19-random-access-attachments.md`.

**Codebase verified:** 2026-08-19

**Normative pins:**
- mls-attachments-01 section 4.1:
  `component_secret = SafeExportSecret(ComponentID)`;
  `CEK = ExpandWithLabel(component_secret,
  ComponentOperationLabel(ComponentID, "attachment"), object_id,
  32)`.
- mls-extensions-09: the exporter tree root is the
  `application_export_secret`, derived from the epoch secret like
  the other Table 4 secrets with label `"application_export"`; the
  tree has the same structure as RFC 9420's secret tree (children
  via `ExpandWithLabel(parent, "tree", "left" | "right", Nh)`);
  `SafeExportSecret(ComponentID)` is the leaf secret at the leaf
  indexed by the 16-bit ComponentID (walk 16 levels from the root,
  taking the child selected by each ComponentID bit, most
  significant bit first).
- `ComponentOperationLabel` is the TLS serialization of
  `struct { opaque base_label<V> = "MLS Component"; uint16
  component_id; opaque label<V> }`, used as the Label of
  ExpandWithLabel (so the KDFLabel label field is `"MLS 1.0 "`
  followed by those bytes).
- The `attachment_encryption` ComponentID has NO IANA value yet.
  Decision: default to the provisional private-use value `0xF001`,
  exported as a constant and overridable per call, so the constant
  can change to the IANA allocation without an API break. Old
  persisted states predating this phase lack
  `applicationExportSecret`; they cannot derive attachment CEKs
  until their next epoch change, which is acceptable for a new
  feature.
- mls-attachments-01 section 6: the reference MUST carry object_id,
  plaintext length, and snapshot; receivers MUST NOT trust the
  snapshot stored in the object (enforced in phase 2's
  `openObject`, which takes the ref value).
- object_id: 1..255 octets, unique per epoch (encryptor
  discipline).

**Style rules:** same as Phase 1.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### random-access-attachments.AC3: MLS keying and reference

- **random-access-attachments.AC3.1 Success:** CEK derivation from a
  ClientState is deterministic for (epoch, object_id), differs
  across object_ids and across epochs, and matches vectors frozen
  with the implementation.
- **random-access-attachments.AC3.2 Failure:** An empty object_id
  and an object_id longer than 255 octets are rejected.
- **random-access-attachments.AC3.3 Success:** AttachmentRef
  encodes and decodes round-trip; truncated or trailing-garbage
  encodings are rejected.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: application_export_secret in the key schedule

**Verifies:** random-access-attachments.AC3.1 (prerequisite).

**Files:**
- Modify: `src/key-schedule.ts` (interface at lines 8-18, derivation
  in `initializeKeySchedule` at lines 50-78)

**Step 1: Extend the interface**

Add to `KeySchedule` (after `exporterSecret`):

```ts
    applicationExportSecret:Uint8Array
```

**Step 2: Derive it in `initializeKeySchedule`**

Alongside the sibling `deriveSecret` calls (before
`epochSecret.fill(0)` at line 63):

```ts
    // draft-ietf-mls-extensions: root of the safe-extension
    // exporter tree, sibling of the RFC 9420 Table 4 secrets
    const applicationExportSecret =
        await deriveSecret(epochSecret, 'application_export', kdf)
```

Add `applicationExportSecret` to the returned object.

**Step 3: Fix resulting type errors**

```bash
npm run build
```

If any code constructs a `KeySchedule` literal elsewhere (search:
`grep -rn "senderDataSecret:" src/ test/`), add the field there
too. Persisted demo states are structured clones; older snapshots
simply lack the field, and only the new attachment code reads it.

**Step 4: Run tests and commit**

```bash
npm run test:unit && npm run test:fast
git add src/key-schedule.ts
git commit -m "key schedule: derive application_export_secret"
```

Expected: existing key-schedule vector tests still pass (the new
sibling derivation does not alter any existing output).
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Exporter tree and CEK derivation

**Verifies:** random-access-attachments.AC3.1, AC3.2
(implementation).

**Files:**
- Create: `src/attachment/keys.ts`

**Step 1: Create `src/attachment/keys.ts`**

Import rule: this module imports from `../crypto/kdf.js`,
`../crypto/ciphersuite.js`, `../codec/*`, `../key-schedule.js`
(types only), and `./error.js` -- nothing else from
`src/attachment/`.

```ts
import type { CiphersuiteImpl } from '../crypto/ciphersuite.js'
import type { Kdf } from '../crypto/kdf.js'
import { expandWithLabel } from '../crypto/kdf.js'
import type { KeySchedule } from '../key-schedule.js'
import { encodeVarLenData } from '../codec/variable-length.js'
import { encodeUint16 } from '../codec/number.js'
import { AttachmentError } from './error.js'

const encoder = new TextEncoder()

/**
 * Provisional private-use ComponentID for attachment_encryption.
 * The IANA value in draft-sullivan-mls-attachments is not yet
 * allocated; replace this constant when it is.
 */
export const ATTACHMENT_COMPONENT_ID = 0xF001

export const CEK_LENGTH = 32

export function componentOperationLabel (
    componentId:number,
    label:string,
):Uint8Array {
    const base = encodeVarLenData(encoder.encode('MLS Component'))
    const id = encodeUint16(componentId)
    const op = encodeVarLenData(encoder.encode(label))
    const out = new Uint8Array(
        base.length + id.length + op.length,
    )
    out.set(base, 0)
    out.set(id, base.length)
    out.set(op, base.length + id.length)
    return out
}

/**
 * ExpandWithLabel with a byte-string Label: KDFLabel.label is
 * "MLS 1.0 " followed by the raw label bytes (RFC 9420 section 8
 * with the Label supplied as bytes).
 */
async function expandWithLabelBytes (
    secret:Uint8Array,
    labelBytes:Uint8Array,
    context:Uint8Array,
    length:number,
    kdf:Kdf,
):Promise<Uint8Array> {
    const prefix = encoder.encode('MLS 1.0 ')
    const label = new Uint8Array(prefix.length + labelBytes.length)
    label.set(prefix, 0)
    label.set(labelBytes, prefix.length)
    return kdf.expand(
        secret,
        new Uint8Array([
            ...encodeUint16(length),
            ...encodeVarLenData(label),
            ...encodeVarLenData(context),
        ]),
        length,
    )
}

/**
 * Walk the safe-extension exporter tree from its root
 * (application_export_secret) to the leaf for componentId: 16
 * levels, child chosen by each ComponentID bit, MSB first.
 * Children per RFC 9420 secret tree:
 * ExpandWithLabel(parent, "tree", "left" | "right", Nh).
 */
export async function safeExportSecret (
    applicationExportSecret:Uint8Array,
    componentId:number,
    kdf:Kdf,
):Promise<Uint8Array> {
    if (componentId < 0 || componentId > 0xFFFF) {
        throw new AttachmentError()
    }
    let node = applicationExportSecret
    for (let bit = 15; bit >= 0; bit--) {
        const right = (componentId >> bit) & 1
        node = await expandWithLabel(
            node,
            'tree',
            encoder.encode(right ? 'right' : 'left'),
            kdf.size,
            kdf,
        )
    }
    return node
}

export interface AttachmentCekOptions {
    componentId?:number
}

/**
 * mls-attachments section 4.1. The CEK is deterministic for
 * (epoch, objectId); the caller owns objectId uniqueness within
 * the epoch (1..255 octets, never reused across epochs).
 */
export async function attachmentCek (
    keySchedule:Pick<KeySchedule, 'applicationExportSecret'>,
    objectId:Uint8Array,
    cs:CiphersuiteImpl,
    opts?:AttachmentCekOptions,
):Promise<Uint8Array> {
    if (objectId.length < 1 || objectId.length > 255) {
        throw new AttachmentError()
    }
    const componentId = opts?.componentId ?? ATTACHMENT_COMPONENT_ID
    if (!keySchedule.applicationExportSecret) {
        throw new AttachmentError()
    }
    const componentSecret = await safeExportSecret(
        keySchedule.applicationExportSecret, componentId, cs.kdf,
    )
    return expandWithLabelBytes(
        componentSecret,
        componentOperationLabel(componentId, 'attachment'),
        objectId,
        CEK_LENGTH,
        cs.kdf,
    )
}
```

Note: `expandWithLabel`'s third parameter is the context bytes;
confirm against `src/crypto/kdf.ts:12-28` (verified 2026-08-19:
`expandWithLabel(secret, label, context, length, kdf)`).

**Step 2: Verify and commit**

```bash
npm run build && npm run lint
git add src/attachment/keys.ts
git commit -m "attachment: exporter tree and CEK derivation"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: AttachmentRef codec

**Verifies:** random-access-attachments.AC3.3 (implementation).

**Files:**
- Create: `src/attachment/reference.ts`

**Step 1: Create `src/attachment/reference.ts`**

```ts
import type { Encoder } from '../codec/tls-encoder.js'
import { contramapEncoders } from '../codec/tls-encoder.js'
import type { Decoder } from '../codec/tls-decoder.js'
import { mapDecoders } from '../codec/tls-decoder.js'
import {
    decodeVarLenData, encodeVarLenData,
} from '../codec/variable-length.js'
import {
    decodeUint8, decodeUint64, encodeUint8, encodeUint64,
} from '../codec/number.js'
import { AttachmentError } from './error.js'

/**
 * Library-level format version (the design's Versioning
 * requirement). Bump when the drafts change our stored bytes;
 * decoders reject versions they do not know.
 */
export const ATTACHMENT_REF_VERSION = 1

/**
 * The authenticated reference to an encrypted attachment. Must
 * travel inside a signed MLS message (authenticated_data or
 * application content); receivers use ONLY these values, never the
 * copies stored in the object.
 */
export interface AttachmentRef {
    version:number
    objectId:Uint8Array
    plaintextLength:bigint
    snapshot:Uint8Array
    locator:Uint8Array
}

export const encodeAttachmentRef:Encoder<AttachmentRef> =
    contramapEncoders(
        [
            encodeUint8,
            encodeVarLenData,
            encodeUint64,
            encodeVarLenData,
            encodeVarLenData,
        ],
        (r:AttachmentRef) => [
            r.version, r.objectId, r.plaintextLength, r.snapshot,
            r.locator,
        ] as const,
    )

const decodeRefBody:Decoder<AttachmentRef> = mapDecoders(
    [
        decodeUint8, decodeVarLenData, decodeUint64,
        decodeVarLenData, decodeVarLenData,
    ],
    (version, objectId, plaintextLength, snapshot, locator) => ({
        version, objectId, plaintextLength, snapshot, locator,
    }),
)

export function validateAttachmentRef (r:AttachmentRef):void {
    if (r.version !== ATTACHMENT_REF_VERSION) {
        throw new AttachmentError()
    }
    if (r.objectId.length < 1 || r.objectId.length > 255) {
        throw new AttachmentError()
    }
    if (r.plaintextLength <= 0n) throw new AttachmentError()
}

/**
 * Strict decode: the whole input must be consumed. Truncated input
 * makes decodeVarLenData THROW CodecError (it does not return
 * undefined, see src/codec/variable-length.ts:63-72), so the body
 * decode is wrapped to keep the single-opaque-error rule.
 */
export function decodeAttachmentRef (bytes:Uint8Array):AttachmentRef {
    let result
    try {
        result = decodeRefBody(bytes, 0)
    } catch (_err) {
        throw new AttachmentError()
    }
    if (!result || result[1] !== bytes.length) {
        throw new AttachmentError()
    }
    validateAttachmentRef(result[0])
    return result[0]
}

/**
 * Helpers for the signed transport. The reference MUST be covered
 * by the sender's signature; pass the encoded bytes as the
 * authenticatedData argument of createApplicationMessage or
 * createProposal (src/create-message.ts:73 and :16), or embed them
 * in signed application content. Receivers recover the ref with
 * refFromAuthenticatedData and MUST ignore any snapshot or length
 * stored inside the object itself.
 */
export function refToAuthenticatedData (r:AttachmentRef):Uint8Array {
    validateAttachmentRef(r)
    return encodeAttachmentRef(r)
}

export function refFromAuthenticatedData (
    bytes:Uint8Array,
):AttachmentRef {
    return decodeAttachmentRef(bytes)
}
```

(`Encoder<T>` is directly callable -- `(t:T) => Uint8Array`, see
`src/codec/tls-encoder.ts:1` -- so `encodeAttachmentRef(r)` above
is the correct invocation.)

Adapt the exact `Encoder`/`Decoder` composition to the real
combinator signatures if they differ; `src/group-info.ts:27-30` is
the reference example of `contramapEncoders`, and
`src/codec/tls-decoder.ts:27` of `mapDecoders` (decoders return
`[value, consumedLength] | undefined`). Verify `decodeVarLenData`
and `decodeUint64` are exported from those codec modules
(`src/codec/variable-length.ts:62`, `src/codec/number.ts:69`).

**Step 2: Verify and commit**

```bash
npm run build && npm run lint
git add src/attachment/reference.ts
git commit -m "attachment: AttachmentRef codec"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-6) -->
<!-- START_TASK_4 -->
### Task 4: Freeze CEK vectors (before the tests that assert them)

**Verifies:** random-access-attachments.AC3.1 (regression lock).
Ordered BEFORE the test task: the test file JSON-imports the frozen
file, and a missing JSON import is an esbuild bundle error that
would fail the whole unit suite.

**Files:**
- Modify: `scripts/generate-seal-own-vectors.ts`
- Create: `test_vectors/seal/own/keys.json` (generated)

**Step 1: Extend the generator**

Add a second output to the same script (phase 2 fixed the
mechanism: the script writes its files itself and re-runs are
byte-identical). With epochSecret = 32 bytes of 0x42, kdf
HKDF-SHA256 (`makeKdfImpl(makeKdf('HKDF-SHA256'))`), objectId
`ascii('own-vector')`, componentId 0xF001: derive
`applicationExportSecret` via
`initializeKeySchedule(epochSecret.slice(), kdf)`, then the
component secret via `safeExportSecret`, then the CEK via
`attachmentCek`. `writeFileSync('test_vectors/seal/own/keys.json',
...)` with hex of: epoch_secret, application_export_secret,
component_id, object_id, component_secret, cek.

**Step 2: Generate both files**

```bash
npx esbuild scripts/generate-seal-own-vectors.ts --bundle \
  --platform=node --format=cjs --loader:.json=json --keep-names \
  --outfile=.tmp.cjs && node .tmp.cjs; rm .tmp.cjs
git diff --stat test_vectors/seal/own/epoch-tree.json
```

Expected: `keys.json` exists; the diff on `epoch-tree.json` is
empty (re-run stability). Also document the new file's fields in
`test_vectors/seal/own/README.md`.

**Step 3: Commit**

```bash
git add scripts/generate-seal-own-vectors.ts test_vectors/seal/own
git commit -m "attachment: freeze CEK derivation vectors"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Keying and reference tests

**Verifies:** random-access-attachments.AC3.1, AC3.2, AC3.3.

**Files:**
- Create: `test/attachment/keys.ts` (unit)
- Create: `test/attachment/reference.ts` (unit)
- Modify: `test/unit.ts`

**Step 1: `test/attachment/keys.ts`**

Build key schedules directly (no group construction needed):
`initializeKeySchedule(epochSecret, kdf)` from
`src/key-schedule.ts` with a fixed 32-byte epochSecret and the kdf
from `getCiphersuiteImpl` for
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (or build the kdf
via `makeKdfImpl(makeKdf('HKDF-SHA256'))` and a minimal
`Pick<KeySchedule, 'applicationExportSecret'>`). Note
`initializeKeySchedule` zeroizes its input, so pass a copy when the
test reuses the secret.

Tests:
- AC3.1 determinism: same (epochSecret, objectId) twice gives the
  same CEK bytes.
- AC3.1 separation: different objectId gives a different CEK;
  different epochSecret (simulating another epoch) gives a
  different CEK; different componentId gives a different CEK.
- AC3.1 frozen: JSON-import `test_vectors/seal/own/keys.json`
  (generated by Task 4, which ran before this task) and assert the
  CEK, component secret, and application_export_secret hex for the
  vector's fixed inputs.
- Version: a ref with `version: 2` rejects at
  `validateAttachmentRef` (covered again in the reference tests
  below; asserting here from keys.json context is not needed).
- AC3.2: objectId of length 0 rejects; length 256 rejects; both
  throw `AttachmentError`.
- Missing `applicationExportSecret` (old persisted state
  simulation: `{ applicationExportSecret: undefined }` cast through
  `Partial`) rejects with `AttachmentError` rather than deriving
  from undefined.

**Step 2: `test/attachment/reference.ts`**

- AC3.3 round-trip: encode then `decodeAttachmentRef` returns an
  equal ref (deepEqual on fields; bigint length preserved);
  `refToAuthenticatedData` then `refFromAuthenticatedData` also
  round-trips.
- AC3.3 truncated: drop the last byte, decode rejects.
- AC3.3 trailing garbage: append one byte, decode rejects.
- Validation: zero-length objectId rejects at decode
  (`validateAttachmentRef`), zero plaintextLength rejects, and an
  unknown `version` (0 and 2) rejects.

**Step 3: Register and run**

```ts
import './attachment/keys.js'
import './attachment/reference.js'
```

```bash
npm run test:unit
```

**Step 4: Commit**

```bash
git add test/attachment test/unit.ts
git commit -m "attachment: keying and reference tests"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Phase verification

**Verifies:** phase gate for AC3.1-AC3.3.

```bash
npm run lint && npm run build && npm run test:unit && \
  npm run test:fast
git status --porcelain
```

Expected: all green; empty status. `test:fast` matters here: this
phase touched `src/key-schedule.ts`, so the ciphersuite matrix
must confirm no regression in group flows.
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->

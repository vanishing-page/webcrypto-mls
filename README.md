# Webcrypto MLS
[![tests](https://img.shields.io/github/actions/workflow/status/vanishing-page/webcrypto-mls/nodejs.yml?style=flat-square)](https://github.com/vanishing-page/webcrypto-mls/actions/workflows/nodejs.yml)
[![types](https://img.shields.io/npm/types/@vanishing.page/webcrypto-mls?style=flat-square)](README.md)
[![module](https://img.shields.io/badge/module-ESM%2FCJS-blue?style=flat-square)](README.md)
[![semantic versioning](https://img.shields.io/badge/semver-2.0.0-blue?logo=semver&style=flat-square)](https://semver.org/)
[![Common Changelog](https://nichoth.github.io/badge/common-changelog.svg)](./CHANGELOG.md)
[![install size](https://flat.badgen.net/packagephobia/install/@vanishing.page/webcrypto-mls)](https://packagephobia.com/result?p=@vanishing.page/webcrypto-mls)
[![GZip size](https://flat.badgen.net/bundlephobia/minzip/@vanishing.page/webcrypto-mls)](https://bundlephobia.com/package/@vanishing.page/webcrypto-mls)
[![license](https://img.shields.io/badge/license-Big_Time-blue?style=flat-square)](LICENSE)


MLS [(RFC 9420)](https://www.rfc-editor.org/rfc/rfc9420) for the browser.

MLS is a protocol for end-to-end encrypted group messaging.
It keeps a shared secret in sync across a group of participants as members join
and leave, and does not cause an `O(n)` blowup in the number of
messages or keys.

This implementation uses the
[webcyrpto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API),
which means it is usable in the browser.

[See a live demo](https://vanishing-page.github.io/webcrypto-mls/)

<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Install](#install)
- [Fork](#fork)
- [Example](#example)
  * [Joining the Group](#joining-the-group)
  * [Use with pre-existing keypairs](#use-with-pre-existing-keypairs)
- [Some Terms](#some-terms)
  * [Proposal](#proposal)
  * [Commit](#commit)
  * [Key package](#key-package)
  * [Ratchet tree](#ratchet-tree)
  * [Commits and proposals](#commits-and-proposals)
  * [Welcome messages](#welcome-messages)
- [Forward secrecy and post-compromise security](#forward-secrecy-and-post-compromise-security)
- [Develop](#develop)
- [Modules](#modules)
  * [ESM](#esm)
  * [Common JS](#common-js)
- [Use](#use)
  * [JS](#js)
  * [pre-built JS](#pre-built-js)

<!-- tocstop -->

</details>

## Install

```sh
npm i -S @vanishing.page/webcrypto-mls
```

## Fork

This is a fork of [LukaJCB/ts-mls](https://github.com/LukaJCB/ts-mls).

-----------------

## Example

See [./example](./example/index.ts), or
[the deployed page](https://vanishing-page.github.io/webcrypto-mls/). It is a
webpage with controls for all the mechanics of MLS.

The core flow:

1. `generateKeyPackage` for each client. 
   This runs locally on each client's own device, before they know what
   group they'll join.
2. `createGroup` to start a group, or `joinGroup` to join via a
   [welcome message](#welcome-messages).
3. `createCommit` to add or remove members or rotate keys.
   See [commit messages](#commit).
4. `createApplicationMessage` and `processPublicMessage` to send and
   receive encrypted group messages.

An _application message_ is the spec's term for arbitrary user data sent
through the group (as opposed to a [`proposal`](#proposal) or [`commit`](#commit),
which carry protocol control data).

In MLS [(RFC 9420)](https://www.rfc-editor.org/rfc/rfc9420),
group membership and keying material never change
unilaterally. Every change to the group goes through a two-phase
propose-then-commit cycle. This codebase's
[`proposal.ts`](./src/proposal.ts) and [`commit.ts`](./src/commit.ts)
are the wire types for those two phases.


### Joining the Group

Before joining a group, the new group member must generate a `KeyPackage`
locally. The key package contains 3 keypairs:

1. the signature keypair - this signs their future group messages/proposals.
2. HPKE initial keypair - used only once, to decrypt the group secrets in
   the welcome message.
3. HPKE leaf-node keypair - used consistently as their position in the group's
   ratchet tree

The pending new group member must share the public half of all three keypairs
(the `KeyPackage` object). The key package object is signed by their signature
key. The public `KeyPackage` is wrapped in an `Add` proposal, which brings them
into the group.


```ts
import {
    generateKeyPackage,
    defaultCapabilities,
    defaultLifetime,
    getCipherSuite,
    createGroup,
    createCommit,
    joinGroup,
    createApplicationMessage,
    processMessage,
    makePskIndex,
    acceptAll
} from '@vanishing.page/webcrypto-mls'

//  use the default ciphersuite given no arguments
const cipherSuite = await getCipherSuite(
    // DEFAULT_CIPHERSUITE -- 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    // defaultCryptoProvider -- 'src/crypto/implementation/default/provider.js'
)

// 1. generateKeyPackage for each client
const alice = await generateKeyPackage(
    {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    },
    defaultCapabilities(),
    defaultLifetime,
    [],
    cipherSuite
)

const bob = await generateKeyPackage(
    { credentialType: 'basic', identity: new TextEncoder().encode('bob') },
    defaultCapabilities(),
    defaultLifetime,
    [],
    cipherSuite
)

// 2. createGroup to start a group
const groupId = cipherSuite.rng.randomBytes(32)
let aliceState = await createGroup(
    groupId,
    alice.publicPackage,
    alice.privatePackage,
    [],
    cipherSuite
)

// 3. createCommit to add a member
const { newState, welcome } = await createCommit(
    { state: aliceState, cipherSuite },
    {
        extraProposals: [{
            proposalType: 'add',
            add: { keyPackage: bob.publicPackage }
        }],
        wireAsPublicMessage: true,
        ratchetTreeExtension: true
    }
)
aliceState = newState

// bob joins from the welcome message
let bobState = await joinGroup(
    welcome!,
    bob.publicPackage,
    bob.privatePackage,
    makePskIndex(undefined, {}),
    cipherSuite
)

// 4. createApplicationMessage and processPublicMessage to send
//    and receive encrypted group messages
const { newState: aliceAfterSend, privateMessage } =
    await createApplicationMessage(
        aliceState,
        new TextEncoder().encode('hello, bob'),
        cipherSuite,
        new Uint8Array(0)
    )
aliceState = aliceAfterSend

const result = await processMessage(
    { wireformat: 'mls_private_message', privateMessage },
    bobState,
    makePskIndex(bobState, {}),
    acceptAll,
    cipherSuite
)

if (result.kind === 'applicationMessage') {
    bobState = result.newState
    console.log(new TextDecoder().decode(result.message))  // "hello, bob"
}
```

### Use with pre-existing keypairs

If you need to use a signature key that you've already generated (for example,
to maintain a persistent identity across sessions), you can pass a pre-existing
Ed25519 `CryptoKeyPair` to `generateKeyPackage` via the `signatureKeyPair`
option.

The private key **can be non-extractable**, meaning it stays locked
in the Web Crypto substrate and is never readable.

>
> [!TIP]
> Use the
> [persist method](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
> to tell the browser not to delete a keypair from `indexedDB`.
>

```ts
// Generate a non-extractable Ed25519 keypair
// (pass `true` instead of `false` to make it extractable if you need to
// persist the private key)
const sigKeyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false,  // <-- not extractable
    ['sign', 'verify']
)

// Pass it to generateKeyPackage via the signatureKeyPair option
const alice = await generateKeyPackage(
    {
        credentialType: 'basic',
        identity: new TextEncoder().encode('alice')
    },
    defaultCapabilities(),
    defaultLifetime,
    [],
    cipherSuite,
    { signatureKeyPair: sigKeyPair }
)

// The private package now holds your CryptoKey, not raw bytes
alice.privatePackage.signaturePrivateKey  // CryptoKey

// The leaf node's public key is the raw export of the public half
alice.publicPackage.leafNode.signaturePublicKey  // Uint8Array
```

## Defaults

With the default ciphersuite
(`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`), every primitive runs on the
[Webcrypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API).

| Primitive                | Default                            | Backend                       |
| ------------------------ | ---------------------------------- | ----------------------------- |
| Signature (Ed25519)      | `makeWebCryptoSignatureImpl`       | WebCrypto (subtle)            |
| Hash / HMAC (SHA-256)    | `makeHashImpl`                     | WebCrypto (subtle)            |
| AEAD (AES-128-GCM)       | `makeAead`                         | WebCrypto (subtle)            |
| KDF (HKDF-SHA256)        | `@hpke/core` HkdfSha256            | WebCrypto (HKDF via subtle)   |
| HPKE KEM (DHKEM-X25519)  | `@hpke/core` DhkemX25519HkdfSha256 | WebCrypto (subtle)            |


This includes the `X25519` key agreement in the `HPKE KEM`. `@hpke/core`
performs X25519 (and Ed25519) through `crypto.subtle` per the WICG Secure
Curves spec, with no `@noble/curves` fallback. The default path
_requires_ a runtime whose WebCrypto implements `X25519` and `Ed25519`
(Node 19+, recent Chrome, Safari, Firefox, Deno, Bun, and Cloudflare Workers).
On an older engine `@hpke/core` throws rather than falling back to a pure-JS
implementation.

Note that changing the signature algorithm away from `Ed25519` switches
signing to `@noble/curves` (see `make-signature-impl.ts`), so the
all-WebCrypto guarantee applies specifically to the defaults.


## Some Terms

### Proposal

A proposal is a single, standalone request to change the group state.
It doesn't take effect on its own; it just gets broadcast and buffered
(`addUnappliedProposal` in [`create-message.ts:54`](./src/create-message.ts#L51))
until someone commits it. [`src/proposal.ts:20-90`](./src/proposal.ts#L20)
shows the variants, each corresponding to one kind of change:

* Add -- bring a new member in, carrying their `KeyPackage`
* Update -- a member rotates their own leaf key material (`LeafNodeUpdate`)
* Remove -- evict a member by leaf index
* PSK -- inject an external pre-shared key into the key schedule
* Reinit -- restart the group under new parameters (version/ciphersuite/extensions)
* ExternalInit -- how an external joiner enters via an external commit
* GroupContextExtensions -- change the group's extension set

### Commit

The commit is the message that actually applies a batch of proposals atomically
and advances the epoch. `src/commit.ts:12-14` is deliberately small:

```ts
export interface Commit {
    proposals:ProposalOrRef[]
    path:UpdatePath | undefined
}
```

The proposals field lists the changes this commit is applying. Each entry is
one of two shapes (see `ProposalOrRef` in
[`src/proposal-or-ref-type.ts:29-33`](./src/proposal-or-ref-type.ts#L29)):

- `{ proposalOrRefType: 'proposal', proposal }` -- the full proposal inlined
  directly into the commit
- `{ proposalOrRefType: 'reference', reference }` -- just a hash pointing at a
  proposal that was already broadcast earlier and is sitting in the
  recipients' buffer of unapplied proposals

This lets a commit either introduce a brand-new proposal on the spot, or
bundle up several previously-sent proposals by reference, without having to
repeat their full contents.

The path field is separate from all of that -- it's not about which proposals
are being applied, it's about giving the group fresh secrets. Every member sits
at a leaf of a tree (the "ratchet tree"), and each leaf has a path of ancestor
nodes up to the root. When you commit, you can generate a new secret for every
node on your path from your leaf to the root, encrypt each one so only the
members "below" that node can decrypt it, and attach the whole bundle as path
(type UpdatePath). Once applied, everyone recomputes shared secrets from these
new values. This is what gives MLS post-compromise security: even if someone's
old key leaked, once they commit an update path, the leaked key no longer helps
an attacker compute the new secrets.

`path` is optional because a commit doesn't strictly have to refresh keys
(e.g. a commit that's only removing a member already forces new secrets via
other means in some cases), but in practice committers usually include one.

Applying all of this -- processing the proposals and the path, then deriving
the next epoch's keys -- is what src/create-commit.ts does; that's the code
that actually advances keySchedule and secretTree to the next epoch.

So the split mirrors two-phase commit: proposals declare what should change,
and a commit is the one message that says apply these now and re-derives the
group's secrets.


### Key package

Before joining a group, a client publishes a key package: a signed bundle
containing its identity (credential), a public HPKE key, and its supported
capabilities. Other members fetch a user's key package from a server and use
it to add that user to a group without needing them online at the time.

### Ratchet tree

A group's shared state is a tree of members (leaves) and intermediate nodes,
each holding an HPKE key pair -- the ratchet tree. To encrypt a message to
the whole group, a member doesn't need one key per recipient. It walks the
tree and re-encrypts along the path to the root, giving O(log n) cost to
update the group's shared secret instead of O(n).

### Commits and proposals

Membership and group changes (add a member, remove a member, rotate a key)
are expressed as proposals, applied via a commit. A commit produces a new
group epoch: a new shared secret derived from the old one plus the changes
in the commit. **Anyone who processes the commit message computes the same new**
**epoch secret**, so the group stays in sync without a server mediating the
cryptography.


### Welcome messages

This is the message that must be sent to a new member joining the group.

When a commit adds a new member, the committer sends that member a welcome
message containing an encrypted copy of the group's current state
(ratchet tree, group context, epoch secret) so they can decrypt future messages
without replaying history.

The welcom message contains two things -- an **HPKE encrypted ciphertext**, and
an AEAD-encrypted `GroupInfo` blob.

The ciphertext contains `GroupSecrets`. `GroupSecrets` is a `joinerSecret`,
a `pathSecret`, and an AEAD-encrypted `GroupInfo` blob. The `GroupInfo` blob
is a ratchet tree, group context, and epoch state.

#### The New Group Member

The new group member must

1. Decrypt their `EncryptedGroupSecrets` using their private, single-use
   initial key
2. Derive keys from `joinerSecret` to decrypt `GroupInfo`
3. Validate the tree/signatures/confirmation tag
4. Use their private leaf-node HPKE key plus the `pathSecret` to derive the same
   path secrets as an existing member would post-commit.


New members need a `KeyPackage`, which is a signature key, init key,
and leaf HPKE key.


------------------------

## Forward secrecy and post-compromise security

Each epoch's secrets derive from the previous epoch, then get discarded.
If a member's key is compromised, the next commit rotates that member's
tree path and heals the group going forward. Old messages stay unreadable
even after a current key leaks.


-----------------------------------------------------


## Develop

Start the example locally:

```sh
npm start
```

## Modules

This exposes ESM and common JS via
[package.json `exports` field](https://nodejs.org/api/packages.html#exports).

### ESM
```js
import * as MLS from '@vanishing.page/webcrypto-mls'
```

### Common JS
```js
const MLS = require('@vanishing.page/webcrypto-mls')
```

## Use

### JS
```js
import * as MLS from '@vanishing.page/webcrypto-mls'
```

### pre-built JS
This package exposes minified JS files too. Copy them to a location that is
accessible to your web server, then link to them in HTML.

#### copy
```sh
cp ./node_modules/@vanishing.page/webcrypto-mls/dist/index.min.js ./public/mls.min.js
```

#### HTML
```html
<script type="module" src="/mls.min.js"></script>
```

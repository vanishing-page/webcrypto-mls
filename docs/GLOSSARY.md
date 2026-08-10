# Glossary

The vocabulary of this repository, for people working on it.

Four sections, ordered by conceptual dependency rather than alphabetically:

1. [Protocol](#protocol) -- nouns that come from
   [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420). These mean what the
   spec says they mean; if the code disagrees, the code is wrong.
2. [Crypto](#crypto) -- the primitives underneath the protocol, and the
   provider layer that supplies them.
3. [Library API](#library-api) -- types and functions this package invents
   or re-shapes. Not spec vocabulary.
4. [Demo](#demo) -- terms that exist only in `example/`.

Entry format:

```
**Term** -- one-line definition.
(links)
```

Links point at the RFC section, the defining source file, and the README's
long-form explanation, where each exists. The README is the only prose
documentation source; there is no generated API site.

This glossary leads naming. When an identifier in the codebase contradicts
an entry here, rename the identifier.

## Protocol

RFC 9420 vocabulary. Section numbers refer to that document.

### Group and epoch

**MLS** -- Messaging Layer Security, the group key agreement protocol this
package implements. Keeps one shared secret in sync across a group as
members join and leave, at `O(log n)` cost per change rather than `O(n)`.
([RFC 1](https://www.rfc-editor.org/rfc/rfc9420#section-1))

**Group** -- The set of members sharing one evolving secret, identified by
an opaque `groupId`. There is no server-side authority over the group's
cryptography; every member derives the same state from the same messages.
([RFC 3](https://www.rfc-editor.org/rfc/rfc9420#section-3))

**Member** -- One client occupying one leaf of the ratchet tree. A single
human with three devices is three members.
([RFC 5.3.3](https://www.rfc-editor.org/rfc/rfc9420#section-5.3.3))

**Epoch** -- A numbered version of the group's cryptographic state. Every
commit advances it by exactly one. Held as a `bigint` on `GroupContext`,
because the spec's epoch counter is a `uint64`.
([RFC 3.1](https://www.rfc-editor.org/rfc/rfc9420#section-3.1),
[`src/group-context.ts`](../src/group-context.ts))

**Group Context** -- The public, agreed-on description of the group at one
epoch: protocol version, ciphersuite, group id, epoch, tree hash, confirmed
transcript hash, extensions. Mixed into nearly every derivation and
signature, so two members who disagree about it cannot talk.
([RFC 8.1](https://www.rfc-editor.org/rfc/rfc9420#section-8.1),
[`src/group-context.ts`](../src/group-context.ts))

**Handshake message** -- A proposal or commit: protocol control data, as
opposed to an application message. Encrypted with the handshake ratchet of
the secret tree.
([RFC 6](https://www.rfc-editor.org/rfc/rfc9420#section-6))

**Application message** -- Arbitrary user payload sent through the group.
Always a `PrivateMessage`; never carries handshake content.
([RFC 15](https://www.rfc-editor.org/rfc/rfc9420#section-15),
[README](../README.md#example))

### Ratchet tree

**Ratchet tree** -- The left-balanced binary tree that is the group's shared
state. Leaves are members, parents represent the subtree beneath them, and
each populated node holds an HPKE key pair.
([RFC 4](https://www.rfc-editor.org/rfc/rfc9420#section-4),
[`src/ratchet-tree.ts`](../src/ratchet-tree.ts),
[README](../README.md#ratchet-tree))

**Leaf node** -- A member's entry in the tree: signature key, HPKE public
key, credential, capabilities, and a `leafNodeSource` recording whether it
arrived via key package, update, or commit.
([RFC 7.2](https://www.rfc-editor.org/rfc/rfc9420#section-7.2),
[`src/leaf-node.ts`](../src/leaf-node.ts))

**Parent node** -- An interior node: an HPKE public key, a parent hash, and
a list of unmerged leaves.
([RFC 7.1](https://www.rfc-editor.org/rfc/rfc9420#section-7.1),
[`src/parent-node.ts`](../src/parent-node.ts))

**Blank node** -- An empty tree position, represented as `undefined` in the
flat array. Left behind by removals and by leaves not yet merged into a
parent.
([RFC 4.1.1](https://www.rfc-editor.org/rfc/rfc9420#section-4.1.1),
[`src/ratchet-tree.ts`](../src/ratchet-tree.ts))

**Node index / leaf index** -- Two distinct coordinate systems over the same
array-based tree: node index counts every array slot, leaf index counts only
leaves. Branded number types, so mixing them is a type error rather than a
silent off-by-two.
([RFC Appendix C](https://www.rfc-editor.org/rfc/rfc9420#appendix-C),
[`src/treemath.ts`](../src/treemath.ts),
[`src/util/brand.ts`](../src/util/brand.ts))

**Direct path** -- The nodes from a leaf up to the root, exclusive of the
leaf. A member knows the private key of every node on their own direct path.
([RFC 4.1.2](https://www.rfc-editor.org/rfc/rfc9420#section-4.1.2),
[`src/treemath.ts`](../src/treemath.ts))

**Copath** -- The siblings of the nodes on a direct path. Update paths
encrypt to the copath, which is what makes a rekey `O(log n)`.
([RFC 4.1.2](https://www.rfc-editor.org/rfc/rfc9420#section-4.1.2),
[README](../README.md#2-key-distribution))

**Resolution** -- The ordered set of non-blank nodes that covers a subtree,
substituting a blank node's children when the node itself is empty. Determines
how many HPKE ciphertexts an update path must contain.
([RFC 4.1.1](https://www.rfc-editor.org/rfc/rfc9420#section-4.1.1),
[`src/ratchet-tree.ts`](../src/ratchet-tree.ts))

**Unmerged leaves** -- Leaves added under a parent whose key material they do
not yet know. Tracked on the parent so encryptions skip them until a commit
merges them in.
([RFC 7.4](https://www.rfc-editor.org/rfc/rfc9420#section-7.4),
[`src/parent-node.ts`](../src/parent-node.ts))

**Tree hash** -- A hash over the whole tree structure and contents, committed
into `GroupContext` so members detect divergent views.
([RFC 7.8](https://www.rfc-editor.org/rfc/rfc9420#section-7.8),
[`src/tree-hash.ts`](../src/tree-hash.ts))

**Parent hash** -- A chain binding each node to the leaf that last set its
key, proving the tree was built by legitimate update paths rather than
fabricated.
([RFC 7.9](https://www.rfc-editor.org/rfc/rfc9420#section-7.9),
[`src/parent-hash.ts`](../src/parent-hash.ts))

**TreeKEM** -- The scheme that rekeys the tree: generate fresh secrets along
your direct path, HPKE-encrypt each to the corresponding copath node, and let
every other member derive the rest.
([RFC 7.4](https://www.rfc-editor.org/rfc/rfc9420#section-7.4),
[README](../README.md#treekem-key-rotation))

**Update path** -- The wire form of a TreeKEM rekey: a new leaf node plus one
`UpdatePathNode` per direct-path step, each carrying HPKE ciphertexts for that
level's copath resolution.
([RFC 7.6](https://www.rfc-editor.org/rfc/rfc9420#section-7.6),
[`src/update-path.ts`](../src/update-path.ts))

**Path secret** -- The per-node secret an update path distributes. Each one
derives the next one up the path, ending at the commit secret.
([RFC 7.4](https://www.rfc-editor.org/rfc/rfc9420#section-7.4),
[`src/path-secrets.ts`](../src/path-secrets.ts))

### Identity and joining

**Key package** -- A signed, single-use bundle a client publishes before it
joins anything: protocol version, ciphersuite, init key, leaf node, and
extensions. Lets someone add you to a group while you are offline.
([RFC 10](https://www.rfc-editor.org/rfc/rfc9420#section-10),
[`src/key-package.ts`](../src/key-package.ts),
[README](../README.md#key-package))

**Init key** -- The single-use HPKE public key in a key package, used only to
encrypt that member's `GroupSecrets` in a welcome. Distinct from the leaf HPKE
key, and zeroized once consumed.
([RFC 10](https://www.rfc-editor.org/rfc/rfc9420#section-10),
[`src/key-package.ts`](../src/key-package.ts))

**Credential** -- The identity claim bound to a leaf's signature key. Basic
credentials carry opaque identity bytes; x509 credentials carry a certificate
chain; custom types are possible.
([RFC 5.3](https://www.rfc-editor.org/rfc/rfc9420#section-5.3),
[`src/credential.ts`](../src/credential.ts))

**Capabilities** -- What a member declares it understands: protocol versions,
ciphersuites, extension types, proposal types, credential types. Members must
not be added if the group requires something they do not list.
([RFC 7.2](https://www.rfc-editor.org/rfc/rfc9420#section-7.2),
[`src/capabilities.ts`](../src/capabilities.ts))

**Required capabilities** -- A group extension naming the extension, proposal,
and credential types every member must support.
([RFC 11.1](https://www.rfc-editor.org/rfc/rfc9420#section-11.1),
[`src/required-capabilities.ts`](../src/required-capabilities.ts))

**Lifetime** -- A `not_before` / `not_after` validity window on a key package's
leaf node, checked when the key package is used.
([RFC 7.2](https://www.rfc-editor.org/rfc/rfc9420#section-7.2),
[`src/lifetime.ts`](../src/lifetime.ts))

**Welcome** -- The message handed to a newly added member: HPKE-encrypted
`GroupSecrets` per new member, plus an AEAD-encrypted `GroupInfo`. Lets them
start at the current epoch without replaying history.
([RFC 12.4.3](https://www.rfc-editor.org/rfc/rfc9420#section-12.4.3),
[`src/welcome.ts`](../src/welcome.ts),
[README](../README.md#welcome-messages))

**GroupInfo** -- A signed snapshot of the group context, extensions, and
confirmation tag, sealed inside a welcome or published for external joins.
([RFC 12.4.3](https://www.rfc-editor.org/rfc/rfc9420#section-12.4.3),
[`src/group-info.ts`](../src/group-info.ts))

**GroupSecrets** -- The per-joiner payload inside a welcome: the joiner
secret, an optional path secret, and any PSK ids.
([RFC 12.4.3](https://www.rfc-editor.org/rfc/rfc9420#section-12.4.3),
[`src/group-secrets.ts`](../src/group-secrets.ts))

**External join / external commit** -- Joining without a welcome, by fetching
a `GroupInfo` carrying an external public key and sending a commit containing
an `ExternalInit` proposal.
([RFC 3.3](https://www.rfc-editor.org/rfc/rfc9420#section-3.3),
[`src/create-commit.ts`](../src/create-commit.ts))

**External sender** -- A non-member authorized by a group extension to send
certain proposals, such as a server proposing to add or remove a client.
([RFC 12.1.8](https://www.rfc-editor.org/rfc/rfc9420#section-12.1.8),
[`src/external-sender.ts`](../src/external-sender.ts))

### Group evolution

**Proposal** -- A standalone request to change the group. Does nothing on its
own; it is buffered until a commit applies it. Variants are Add, Update,
Remove, PreSharedKey, ReInit, ExternalInit, and GroupContextExtensions.
([RFC 12.1](https://www.rfc-editor.org/rfc/rfc9420#section-12.1),
[`src/proposal.ts`](../src/proposal.ts),
[README](../README.md#proposal))

**ProposalOrRef** -- A commit entry that either inlines a full proposal or
references a previously broadcast one by hash.
([RFC 12.4](https://www.rfc-editor.org/rfc/rfc9420#section-12.4),
[`src/proposal-or-ref-type.ts`](../src/proposal-or-ref-type.ts))

**Proposal reference** -- The `RefHash` of an `AuthenticatedContent` proposal,
used to name a buffered proposal from inside a commit. Also the key type of
`UnappliedProposals`.
([RFC 5.2](https://www.rfc-editor.org/rfc/rfc9420#section-5.2),
[`src/authenticated-content.ts`](../src/authenticated-content.ts))

**Commit** -- The message that applies a batch of proposals atomically,
optionally carries an update path, and advances the epoch. Everyone who
processes it derives the same new secrets.
([RFC 12.4](https://www.rfc-editor.org/rfc/rfc9420#section-12.4),
[`src/commit.ts`](../src/commit.ts),
[README](../README.md#commit))

**Confirmation tag** -- A MAC over the confirmed transcript hash under the
epoch's confirmation key, proving the sender actually derived the new epoch.
([RFC 6.1](https://www.rfc-editor.org/rfc/rfc9420#section-6.1),
[`src/framed-content.ts`](../src/framed-content.ts))

**Transcript hash** -- The running hash chain over every commit the group has
processed. Exists in two forms: the *confirmed* hash covers the commit content,
and the *interim* hash extends it with that commit's confirmation tag.
([RFC 8.2](https://www.rfc-editor.org/rfc/rfc9420#section-8.2),
[`src/transcript-hash.ts`](../src/transcript-hash.ts))

**Reinitialization (ReInit)** -- Ending a group and starting a successor under
new parameters, with the old group's resumption PSK carried across.
([RFC 11.2](https://www.rfc-editor.org/rfc/rfc9420#section-11.2),
[`src/resumption.ts`](../src/resumption.ts))

**Branching** -- Creating a subgroup from a subset of the current members,
again linked by resumption PSK.
([RFC 11.3](https://www.rfc-editor.org/rfc/rfc9420#section-11.3),
[`src/resumption.ts`](../src/resumption.ts))

### Key schedule and secrets

**Key schedule** -- The per-epoch derivation that turns one epoch secret into
the named secrets the group needs, and chains each epoch to the next.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/key-schedule.ts`](../src/key-schedule.ts),
[README](../README.md#key-schedule))

**Commit secret** -- The root path secret produced by a commit's update path;
the fresh entropy each epoch mixes in.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Init secret** -- The output of one epoch that feeds the derivation of the
next, making the epochs a hash chain.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Joiner secret** -- Derived from the previous init secret and the commit
secret; what a welcome hands a new member so they can reach the epoch secret.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/group-context.ts`](../src/group-context.ts))

**Epoch secret** -- The single root secret of an epoch, extracted from the
joiner secret and any PSK secret, from which the whole key schedule derives.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/group-context.ts`](../src/group-context.ts))

**Epoch authenticator** -- A public per-epoch value every member computes
identically; usable as a safety-number style out-of-band comparison.
([RFC 8.7](https://www.rfc-editor.org/rfc/rfc9420#section-8.7),
[`src/key-schedule.ts`](../src/key-schedule.ts),
[README](../README.md#epoch-authenticator))

**Confirmation key** -- Keys the confirmation tag.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Membership key** -- Authenticates a `PublicMessage` as coming from a current
member.
([RFC 6.1](https://www.rfc-editor.org/rfc/rfc9420#section-6.1),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Encryption secret** -- Seeds the secret tree for this epoch.
([RFC 9](https://www.rfc-editor.org/rfc/rfc9420#section-9),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Sender data secret** -- Encrypts the sender-data header of a
`PrivateMessage`, which is what hides who sent it.
([RFC 6.3.2](https://www.rfc-editor.org/rfc/rfc9420#section-6.3.2),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Exporter secret** -- Lets the application derive its own labeled secrets
from the group, via `mlsExporter`.
([RFC 8.5](https://www.rfc-editor.org/rfc/rfc9420#section-8.5),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**External secret** -- Derives the external key pair that makes external
commits possible.
([RFC 8.3](https://www.rfc-editor.org/rfc/rfc9420#section-8.3),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Resumption PSK** -- The per-epoch secret that links a group to its
reinitialized or branched successor.
([RFC 8.6](https://www.rfc-editor.org/rfc/rfc9420#section-8.6),
[`src/key-schedule.ts`](../src/key-schedule.ts))

**Pre-shared key (PSK)** -- Extra keying material injected into the key
schedule, either external (application-supplied) or resumption. Identified by
a `PreSharedKeyID` carrying a nonce sized to the KDF.
([RFC 8.4](https://www.rfc-editor.org/rfc/rfc9420#section-8.4),
[`src/presharedkey.ts`](../src/presharedkey.ts))

**Secret tree** -- A second tree, derived from the encryption secret, that
hands each member two message-key ratchets: one for handshake messages, one
for application messages.
([RFC 9](https://www.rfc-editor.org/rfc/rfc9420#section-9),
[`src/secret-tree.ts`](../src/secret-tree.ts),
[README](../README.md#1-the-message-level-ratchet-forward-secrecy))

**Generation** -- The counter identifying how far a sender's ratchet has
advanced. Each message consumes one, and used keys are deleted.
([RFC 9.1](https://www.rfc-editor.org/rfc/rfc9420#section-9.1),
[`src/secret-tree.ts`](../src/secret-tree.ts))

**Reuse guard** -- Four random bytes XORed into the message nonce, so a key
accidentally reused twice does not repeat a nonce.
([RFC 6.3.1](https://www.rfc-editor.org/rfc/rfc9420#section-6.3.1),
[`src/secret-tree.ts`](../src/secret-tree.ts))

**Forward secrecy** -- Compromising current keys does not reveal past
messages, because each epoch's and each generation's inputs are discarded
after use.
([RFC 16.6](https://www.rfc-editor.org/rfc/rfc9420#section-16.6),
[README](../README.md#forward-secrecy-and-post-compromise-security))

**Post-compromise security (PCS)** -- Compromising current keys does not
reveal future messages, once the compromised member commits a fresh update
path.
([RFC 16.6](https://www.rfc-editor.org/rfc/rfc9420#section-16.6),
[README](../README.md#forward-secrecy-and-post-compromise-security))

### Framing

**FramedContent** -- The unauthenticated body of any MLS message: group id,
epoch, sender, authenticated data, and either application data, a proposal,
or a commit.
([RFC 6](https://www.rfc-editor.org/rfc/rfc9420#section-6),
[`src/framed-content.ts`](../src/framed-content.ts))

**AuthenticatedContent** -- `FramedContent` plus its signature and, for
commits, its confirmation tag. What proposal references hash over.
([RFC 6.1](https://www.rfc-editor.org/rfc/rfc9420#section-6.1),
[`src/authenticated-content.ts`](../src/authenticated-content.ts))

**PublicMessage** -- A signed but unencrypted message, authenticated to the
group with the membership key. Usable for handshake messages when metadata
privacy is not needed.
([RFC 6.2](https://www.rfc-editor.org/rfc/rfc9420#section-6.2),
[`src/public-message.ts`](../src/public-message.ts))

**PrivateMessage** -- An encrypted message: content sealed under a secret-tree
key, with the sender data separately encrypted. Mandatory for application
messages.
([RFC 6.3](https://www.rfc-editor.org/rfc/rfc9420#section-6.3),
[`src/private-message.ts`](../src/private-message.ts))

**Wire format** -- The outer tag on an `MLSMessage` saying which of the five
things it is: public message, private message, welcome, group info, or key
package.
([RFC 6](https://www.rfc-editor.org/rfc/rfc9420#section-6),
[`src/wireformat.ts`](../src/wireformat.ts))

**Sender** -- Who produced a message: a member at a leaf index, an external
sender, a new member proposing, or a new member committing.
([RFC 6](https://www.rfc-editor.org/rfc/rfc9420#section-6),
[`src/sender.ts`](../src/sender.ts))

**Padding** -- Trailing zero bytes added to a `PrivateMessage` before
encryption so that ciphertext length leaks less about content length.
([RFC 15.1](https://www.rfc-editor.org/rfc/rfc9420#section-15.1),
[`src/padding-config.ts`](../src/padding-config.ts))

### Extensibility

**Extension** -- A typed, opaque blob attachable to a group context, leaf
node, key package, or group info. The `ratchet_tree` extension is the common
one, shipping the whole tree inside a welcome.
([RFC 13.4](https://www.rfc-editor.org/rfc/rfc9420#section-13.4),
[`src/extension.ts`](../src/extension.ts))

**GREASE** -- Deliberately sending reserved, meaningless values in
capability lists so that peers stay tolerant of unknown values and the
protocol does not ossify.
([RFC 13.5](https://www.rfc-editor.org/rfc/rfc9420#section-13.5),
[`src/grease.ts`](../src/grease.ts))

**Custom proposal type** -- An application-defined proposal outside the seven
standard ones. RFC 12.1 requires rejecting a commit that references a proposal
type you do not understand, so this package gates them behind
`ClientConfig.supportedCustomProposalTypes`.
([RFC 13.2](https://www.rfc-editor.org/rfc/rfc9420#section-13.2),
[`src/client-config.ts`](../src/client-config.ts))

**Delivery Service (DS)** -- The untrusted transport that orders and fans out
messages. Not implemented here; supplying one is the application's job.
([RFC 16.9](https://www.rfc-editor.org/rfc/rfc9420#section-16.9))

**Authentication Service (AS)** -- Whatever binds a credential to a real
identity. Also not implemented here -- see `AuthenticationService` below.
([RFC 16.10](https://www.rfc-editor.org/rfc/rfc9420#section-16.10))

## Crypto

**Ciphersuite** -- The named combination of KEM, KDF, AEAD, hash, and
signature algorithm a group uses. `Ciphersuite` is the algorithm description;
`CiphersuiteName` is the string key; `CiphersuiteId` is the wire number.
([RFC 5.1](https://www.rfc-editor.org/rfc/rfc9420#section-5.1),
[`src/crypto/ciphersuite.ts`](../src/crypto/ciphersuite.ts))

**CiphersuiteImpl** -- The resolved, callable form: actual `hash`, `hpke`,
`signature`, `kdf`, and `rng` objects. Threaded through nearly every function
in the library as `cs`.
([`src/crypto/ciphersuite.ts`](../src/crypto/ciphersuite.ts))

**`DEFAULT_CIPHERSUITE`** -- Suite `0x0001`
(X25519 / AES-128-GCM / SHA-256 / Ed25519), RFC 9420's mandatory-to-implement
baseline and the best bet for interop.
([`src/crypto/get-ciphersuite-impl.ts`](../src/crypto/get-ciphersuite-impl.ts))

**Private-use ciphersuite** -- The experimental post-quantum suites this
package adds in the `0xF000`-`0xFFFF` range. Not IANA-registered, so they can
never collide with a future standard allocation, and not interoperable with
other MLS implementations.
([`src/crypto/ciphersuite.ts`](../src/crypto/ciphersuite.ts),
[README](../README.md#defaults))

**HPKE** -- Hybrid Public Key Encryption (RFC 9180), the public-key
encryption used for every tree secret and for `GroupSecrets`.
([RFC 5.1.3](https://www.rfc-editor.org/rfc/rfc9420#section-5.1.3),
[`src/crypto/hpke.ts`](../src/crypto/hpke.ts))

**KEM** -- The key encapsulation half of HPKE. DHKEM variants are
Diffie-Hellman based (X25519, X448, P-256/384/521); ML-KEM and X-Wing are the
post-quantum options.
([`src/crypto/kem.ts`](../src/crypto/kem.ts))

**KDF** -- HKDF, plus MLS's labeled wrappers `expandWithLabel` and
`deriveSecret`, which domain-separate every derivation by a string label.
([RFC 8](https://www.rfc-editor.org/rfc/rfc9420#section-8),
[`src/crypto/kdf.ts`](../src/crypto/kdf.ts))

**AEAD** -- The symmetric cipher for message content: AES-GCM or
ChaCha20-Poly1305, depending on suite.
([`src/crypto/aead.ts`](../src/crypto/aead.ts))

**Signature** -- The per-member signing algorithm, always used through
`signWithLabel` / `verifyWithLabel` so a signature over one structure can
never be replayed as a signature over another.
([RFC 5.1.2](https://www.rfc-editor.org/rfc/rfc9420#section-5.1.2),
[`src/crypto/signature.ts`](../src/crypto/signature.ts))

**RefHash** -- The labeled hash construction behind key package references and
proposal references.
([RFC 5.2](https://www.rfc-editor.org/rfc/rfc9420#section-5.2),
[`src/crypto/hash.ts`](../src/crypto/hash.ts))

**CryptoProvider** -- The single-method interface
(`getCipherSuite(cs) -> CiphersuiteImpl`) that decides which implementations
back a suite. The seam that makes this fork browser-first.
([`src/crypto/provider.ts`](../src/crypto/provider.ts))

**`defaultCryptoProvider`** -- The default: `globalThis.crypto.subtle` for
hashing, Web Crypto for Ed25519 signing, `@noble` for everything else Web
Crypto cannot do.
([`src/crypto/implementation/default/provider.ts`](../src/crypto/implementation/default/provider.ts))

**`nobleCryptoProvider`** -- The all-`@noble` provider, no Web Crypto anywhere.
Useful for environments without `SubtleCrypto` and for the mixed-provider
interop test.
([`src/crypto/implementation/noble/provider.ts`](../src/crypto/implementation/noble/provider.ts),
[`test/scenario/mixed-provider-interop.ts`](../test/scenario/mixed-provider-interop.ts))

**Non-extractable key** -- A `CryptoKey` whose raw bytes JavaScript can never
read. Signature keys can be generated this way and still survive persistence,
because structured clone stores a `CryptoKey` without exporting it.
([README](../README.md#use-with-pre-existing-keypairs),
[`test/scenario/non-extractable-identity.ts`](../test/scenario/non-extractable-identity.ts))

**Zeroization** -- Overwriting a secret `Uint8Array` with zeros once it is
superseded, so old key material does not linger in memory. Applied when
private key paths merge and when blanked nodes are pruned.
([RFC 9.2](https://www.rfc-editor.org/rfc/rfc9420#section-9.2),
[`src/private-key-path.ts`](../src/private-key-path.ts))

## Library API

Types and functions this package defines. Spec concepts they wrap are in
[Protocol](#protocol).

### State

**`ClientState`** -- One member's complete view of one group: group context,
key schedule, secret tree, ratchet tree, private key path, signature private
key, buffered proposals, confirmation tag, historical receiver data, active
state, and config. Persisting this *is* persisting membership.
([`src/client-state.ts`](../src/client-state.ts),
[README](../README.md#persistence))

**`PrivateKeyPath`** -- The private half of a member's tree position: a leaf
index plus HPKE private keys keyed by node index.
([`src/private-key-path.ts`](../src/private-key-path.ts))

**`PrivateKeyPackage`** -- The secrets that pair with a published
`KeyPackage`: init private key, leaf HPKE private key, signature private key.
Never leaves the device.
([`src/key-package.ts`](../src/key-package.ts))

**`UnappliedProposals`** -- The buffer of proposals seen but not yet
committed, keyed by base64 proposal reference. A non-empty buffer blocks
sending application messages.
([`src/unapplied-proposals.ts`](../src/unapplied-proposals.ts))

**`GroupActiveState`** -- Whether this member is `active`,
`suspendedPendingReinit`, or `removedFromGroup`. The last two block sending.
([`src/client-state.ts`](../src/client-state.ts))

**`EpochReceiverData`** -- Everything needed to decrypt messages from an
earlier epoch: that epoch's secret tree, ratchet tree, sender data secret,
resumption PSK, and group context. Retained per `KeyRetentionConfig`.
([`src/client-state.ts`](../src/client-state.ts))

**`PskIndex`** -- The lookup an application supplies so the library can
resolve a `PreSharedKeyID` to actual key bytes. `emptyPskIndex` finds nothing;
`makePskIndex` builds one from a state plus external PSKs.
([`src/psk-index.ts`](../src/psk-index.ts))

### Configuration

**`ClientConfig`** -- The five policy objects below plus
`supportedCustomProposalTypes`, carried on every `ClientState`. Holds function
values, so it is not structured-clone friendly and must be re-attached after
restoring from storage.
([`src/client-config.ts`](../src/client-config.ts))

**`AuthenticationService`** -- The `validateCredential` hook. There is no
usable default: `defaultClientConfig` carries
`failClosedAuthenticationService`, which throws a `UsageError` the first
time a credential decision is needed, so every application has to supply
a real one. `unsafeAcceptAllAuthenticationService` accepts everything and
is for local testing only. The hook's third argument is the credential
currently at the leaf being replaced, which is what an application needs
to enforce identity continuity across an Update.
([`src/authentication-service.ts`](../src/authentication-service.ts))

**`KeyRetentionConfig`** -- How long to keep old message keys around for
out-of-order delivery: generations per ratchet, epochs of history, and a cap
on how far forward a ratchet may be advanced in one step. Defaults are 10, 4,
and 200. A retention count of `0` means retain nothing, not retain everything.
([`src/key-retention-config.ts`](../src/key-retention-config.ts))

**`LifetimeConfig`** -- A cap on how long a key package lifetime window may
span (`maximumTotalLifetime`, default one month), and whether to enforce that
window on leaf nodes received from peers as well as ones generated locally
(`validateLifetimeOnReceive`, default `true`; set it to `false` only to opt
out, e.g. when the local clock cannot be trusted).
([`src/lifetime-config.ts`](../src/lifetime-config.ts))

**`PaddingConfig`** -- Either `padUntilLength` (pad short messages up to a
floor, default 256 bytes, hiding length only below that floor) or
`alwaysPad` (add a fixed number of bytes to every message, which hides no
length at all, since an observer subtracts the constant).
([`src/padding-config.ts`](../src/padding-config.ts))

**`KeyPackageEqualityConfig`** -- How to decide two key packages, or a key
package and a leaf node, represent the same client. The default compares
signature public keys in constant time; this is what makes a duplicate Add
detectable.
([`src/key-package-equality-config.ts`](../src/key-package-equality-config.ts))

**`IncomingMessageAction`** -- The accept-or-reject verdict an application
returns from an `IncomingMessageCallback` when a commit arrives. `acceptAll`
is the permissive default.
([`src/incoming-message-action.ts`](../src/incoming-message-action.ts))

### Operations

**`generateKeyPackage`** -- Create a key package and its private half. Runs
locally before the client knows what group it will join.
([`src/key-package.ts`](../src/key-package.ts))

**`createGroup` / `joinGroup`** -- Start a new group, or enter an existing one
from a `Welcome`. Both return a `ClientState`.
([`src/client-state.ts`](../src/client-state.ts))

**`createProposal` / `createApplicationMessage`** -- Build a standalone
proposal, or encrypt user payload for the group.
([`src/create-message.ts`](../src/create-message.ts))

**`createCommit`** -- Apply buffered and inline proposals, optionally rekey,
and advance the epoch. Returns `CreateCommitResult`: the new state, the commit
message, and a welcome if members were added.
([`src/create-commit.ts`](../src/create-commit.ts),
[README](../README.md#createcommit))

**`processMessage`** -- Apply an incoming message to a state. Returns
`ProcessMessageResult`, discriminated on `kind`: `'newState'` for a commit or
proposal, `'applicationMessage'` for decrypted payload. Both carry the
advanced state.
([`src/process-messages.ts`](../src/process-messages.ts),
[README](../README.md#catching-up))

**`encodeMlsMessage` / `decodeMlsMessage`** -- The wire boundary. Everything
sent between clients crosses it as bytes.
([`src/message.ts`](../src/message.ts))

**Catching up** -- Replaying buffered messages through `processMessage` in
group order after restoring persisted state, until you reach the current
epoch. Out-of-order commits throw rather than corrupt state.
([README](../README.md#catching-up))

### Internals

**`MlsError`** -- The base error class. Subclasses distinguish cause:
`ValidationError` (peer sent something invalid), `CodecError` (malformed
bytes), `UsageError` (caller misused the API), `CryptoVerificationError` (a
signature or tag failed), `CryptoError`, `DependencyError` (missing optional
package), `InternalError` (a bug here). Only `UsageError` is re-exported from
the package root.
([`src/mls-error.ts`](../src/mls-error.ts))

**`Encoder` / `Decoder`** -- The TLS presentation-language codec pair every
wire type is built from, composed with `contramapEncoders` and `mapDecoders`.
([RFC 2.1](https://www.rfc-editor.org/rfc/rfc9420#section-2.1),
[`src/codec/`](../src/codec))

**`Brand`** -- The phantom-type helper behind `LeafIndex` and `NodeIndex`.
([`src/util/brand.ts`](../src/util/brand.ts))

**Test vectors** -- The RFC 9420 interop fixtures under `test_vectors/`, one
JSON file per spec area (`treekem.json`, `key-schedule.json`, and so on),
driven by `test/test-vectors/`.
([`test_vectors/`](../test_vectors))

**Scenario test** -- An end-to-end test under `test/scenario/` that drives
real group lifecycles (external joins, reinit, out-of-order epochs) rather
than a single function. Where regressions usually surface first.
([`test/scenario/`](../test/scenario))

**Upstream** -- [LukaJCB/ts-mls](https://github.com/LukaJCB/ts-mls), which
this package forks. The main divergence is the crypto provider layer and its
Web Crypto default.
([README](../README.md#fork))

## Demo

Terms local to `example/`. Nothing here ships in the published package.

**Main demo** -- The page at `/`, driving a group through its whole lifecycle
with visible controls for every mechanic.
([`example/index.ts`](../example/index.ts))

**Persistence demo** -- The page at `/persistence`, which saves each member's
`ClientState` to `indexedDB` and restores it on reload.
([`example/persistence-demo.ts`](../example/persistence-demo.ts))

**`DemoState`** -- The signal-backed state shared by both demo pages: users,
messages, ciphersuite, group id, status, decrypted messages, and per-user
message queues. Excludes routing, which belongs to the page.
([`example/demo-state.ts`](../example/demo-state.ts))

**`DemoUser`** -- One simulated participant: a name, and once they have joined,
their `ClientState`, `KeyPackage`, and `PrivateKeyPackage`. Every user in the
demo runs in the same tab, which real deployments never do.
([`example/demo-state.ts`](../example/demo-state.ts))

**Message queue** -- Per-user buffer of ciphertexts a member has not yet
processed, standing in for the offline-delivery a real Delivery Service would
handle.
([`example/demo-state.ts`](../example/demo-state.ts))

**Participant** -- A demo user who has actually joined the group, meaning
`state` is set. Users without state exist but are not members.
([`example/participants.ts`](../example/participants.ts))

**Tree view model** -- The pure transformation from a `RatchetTree` into
nested `TreeViewNode`s, then into a `TreeViewLayout` of positioned nodes and
edges. Kept free of rendering so it can be unit tested in Node.
([`example/tree-view.ts`](../example/tree-view.ts))

**Peek vs pin** -- The two states of the tree diagram's detail area. Peeking
is hover, showing the direct-path node count; pinning is click, showing one
node's kind, base64 HPKE public key, and full JSON. Modelled as
`TreeDiagramDetail`.
([`example/tree-diagram.ts`](../example/tree-diagram.ts))

**`PersistedMember`** -- One `indexedDB` record: a name plus a
`ClientState` with `clientConfig` stripped, because that config holds
functions the structured clone algorithm cannot copy. It is re-derived on
restore.
([`example/persistence-storage.ts`](../example/persistence-storage.ts))

**`StorageStatus`** -- Whether the browser granted `persistent` storage,
fell back to `best-effort`, or does not support the Storage API at all.
([`example/storage-persistence.ts`](../example/storage-persistence.ts))

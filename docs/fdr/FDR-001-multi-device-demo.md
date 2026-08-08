# FDR-001: Multi-device Demo

**Status:** Planned
**Last reviewed:** 2026-07-26

## Overview

A third example page, at `/multi-device`, showing how MLS behaves when
one person carries several devices. MLS has no concept of a person: the
ratchet tree holds one leaf per client. Someone with a phone, a laptop,
and a desktop is three members of the group, not one.

The other two demos both assume one client per person, so neither can
show this. This page gives each of the seven example people three
devices and lets a visitor watch the consequences, most sharply in the
fact that a message sent from Alice's phone must be decrypted separately
on Alice's laptop, exactly as it must on Bob's laptop.

The audience is someone evaluating MLS who has asked the obvious
question: what happens to my other devices?

## Behavior

Each of the seven example people has three devices, shown throughout the
page with an emoji icon and a text label: phone, laptop, and desktop.

Setup happens per user. Creating a person's devices generates three
key packages at once. Adding a person to the group adds every device of
theirs that is not already in it, in a single commit, so their leaves
appear together and the epoch advances once. Removing a person works
the same way in reverse. A full group is 21 members across 7 people, and
the ratchet tree shows 21 leaves.

Leaves in this tree are unlabelled until pointed at. Hovering or
focusing a leaf reveals whose device it is; moving away hides it again.
The other two demos label every leaf, as before.

Selecting a person in User Management shows their three devices in the
Status panel, above the tree-node detail. Each row names the device and
says whether it has joined the group yet. Selecting a person also
highlights all of their leaves and the paths from those leaves to the
root, which is the clearest way to see that one person's devices are
scattered across the tree rather than adjacent in it.

Selecting one of those devices replaces the ratchet tree diagram with a
Device Info panel, and the card heading changes from "Ratchet Tree" to
"Device Info". The panel describes that one client: its owner, its leaf
and node index, its epoch, and its public key material. From there the
device's keys can be rotated on their own, the device can be removed
from the group on its own, and the device's state can be saved to
browser storage on its own.

Removing a single device is the lost-phone case. The removed device's
leaf goes blank, the person's other devices carry on at the new epoch,
and the removed device stays listed among that person's devices, marked
as no longer in the group. It can be added back later, as a fresh
client.

The Clear button in that card's header clears the most specific
selection: the device if one is selected, otherwise the selected tree
node. Escape does the same. Clearing a device brings the tree back with
any previously selected node still selected.

Sending a message is two steps. Choosing "Send as Alice" reveals a
second row of buttons asking which device to send with. The message is
sent from that one client, and the message history records which device
sent it.

Reading a message is also two steps. Message history has one column per
person. A message box starts collapsed, showing the ciphertext and a
single decrypt control. Expanding it reveals one section per device,
each with its own decrypt control. The device that sent the message
already has the plaintext, because that client composed it. Every other
device, including the sender's own laptop and desktop, has to decrypt
for itself.

Devices can be persisted individually to browser storage and are
restored on reload, at whatever epoch the group has reached. The page's
Reset control clears only this page's stored data. As on the persistence
demo, the page reports whether the browser has granted persistent
storage for the origin and offers to request it.

## Design Decisions

### 1. A device is a real MLS client, not a label

**Decision:** Each device gets its own key package, its own leaf in the
ratchet tree, and its own client state. Three devices means three
leaves.

**Why:** The alternative was to keep one leaf per person and attach
device names to it as decoration. That would have put invented
properties next to real key material in a panel whose whole purpose is
showing real key material, and it would have taught the reader something
false about how MLS handles multiple devices. The genuine answer to
"how does MLS handle my phone and my laptop" is "they are two members",
and this page exists to say that.

**Tradeoff:** The tree grows from 7 leaves to 21, which needs its own
layout treatment, and setup involves more group operations than the
other demos.

### 2. The person-to-device grouping lives only in the demo

**Decision:** The library is never told which leaves belong to the same
person. The grouping is application code in the example, and the
protocol layer is untouched.

**Why:** This mirrors reality. MLS deliberately has no notion of a user
identity spanning clients, and applications that want one build it
above the protocol. Putting the grouping in the demo rather than the
library keeps that boundary visible, and it means the page demonstrates
the real integration shape rather than a convenience the library does
not offer.

**Tradeoff:** Anything the page wants to say about a person, such as
"how many of Alice's devices are in the group", it has to derive itself.

### 3. Clients are keyed by a composed client id

**Decision:** The demo's client map is keyed by strings of the form
`person/device`, and the person-to-device grouping is recovered by
parsing that key.

**Why:** The shared demo actions already key everything by an opaque
name string, so composing the id this way lets the multi-device page
reuse user creation, group joins, sends, decrypts, and key rotation
without modifying any of them. It also means persisted records need no
extra grouping data: the grouping is recoverable from the record's own
name.

**Tradeoff:** The composed key is a parsing contract, so a person's name
can never contain the separator, and malformed ids have to be rejected
explicitly rather than guessed at.

### 4. A user joins in one commit

**Decision:** Adding a person adds every device of theirs that is not
already in the group, in a single commit, advancing the epoch once.
Removing a person works the same way in reverse.

**Why:** Adding devices one at a time would triple the clicks and
triple the epoch churn for no additional insight, while pre-seeding the
whole group would remove the moment where the tree visibly changes. One
commit per user keeps setup close to the other demos' click count
while making the point that the unit of growth here is a user, not a
single device.

**Tradeoff:** The user is the default unit of change, so the
common path never shows a person partly in the group. Reaching that
state, which is the normal one for a real application, takes the
per-device removal in decision 7.

### 5. Selection lives on the person, not on the leaf

**Decision:** Devices are reached by selecting a person in the user
list, not by clicking one of their leaves in the tree.

**Why:** Clicking a leaf answers "who owns this leaf", which is the
narrower question. Starting from a person answers "where is this person
in the tree", which is what someone comes to a multi-device page to
find out, and it works before a person has joined the group at all,
when they have no leaf to click.

**Tradeoff:** The page carries three coexisting selections (person,
device, tree node) rather than one, so the rule for what Clear affects
has to be stated rather than being obvious.

### 6. Leaf labels are revealed on hover, not always shown

**Decision:** On this page a leaf is unlabelled until hovered or
focused, and the revealed label is the full description: person, device,
and icon.

**Why:** Twenty-one labels cannot all be shown at once without
colliding, and the alternatives were worse. Abbreviating every label
makes all of them harder to read to solve a problem only some of them
have. Labelling once per user leaves most leaves anonymous
permanently rather than temporarily. Hiding until hover keeps the
diagram clean at rest, and because only one label is ever on screen it
can afford to be complete rather than cramped. Selecting a person
already highlights their leaves, so finding someone does not depend on
reading labels.

**Tradeoff:** The tree no longer answers "who is where" at a glance;
it has to be explored. Hover is also not available to every input
method, so keyboard focus reveals the label as well and each leaf
carries the same information in its accessible name.

### 7. A single device can be removed, and is regenerated when it is

**Decision:** Device Info can remove one device from the group. Another
in-group client commits the removal, preferring another device
belonging to the same person, and the removed device's key package and
signature keypair are regenerated as part of the action.

**Why:** Losing a phone is the question a multi-device reader actually
has, and it is the only interaction that shows the group surviving the
loss of one of a person's clients. Two constraints shape how it works.
MLS does not let a member commit their own removal, so some other
client has to do it, and having the person's own laptop revoke their
own phone tells the right story. Separately, removal clears a client's
group state but leaves its already-consumed key package behind, and MLS
forbids reusing a key package, so without regeneration the device could
never rejoin. Regenerating matches what key rotation already does for
an out-of-group client, and it matches reality, where a replacement
device publishes fresh keys.

**Tradeoff:** A re-added device is a new client that happens to share a
label with the old one. Nothing carries over, and the page does not
pretend otherwise.

### 8. Device Info replaces the tree rather than sitting beside it

**Decision:** Selecting a device swaps the tree diagram out of its card
and retitles the card.

**Why:** The page is already dense, and the tree and a device's detail
compete for the same wide column. Swapping keeps one focus at a time
and makes the relationship explicit: this panel is about the client at
one of the leaves you were just looking at.

**Tradeoff:** A leaf cannot be inspected in the tree and in Device Info
at the same time.

### 9. Messaging is retained, in a per-device form

**Decision:** The page keeps sending and message history, but sending
picks a device and history offers a decrypt per device inside each
person's column.

**Why:** This is where the multi-device point lands hardest. Watching
Alice's laptop decrypt Alice's own message, with the same effort Bob's
laptop needs, demonstrates that MLS extends no trust between a person's
own devices. A page without messaging could describe that; only a page
with messaging makes the reader do it.

**Tradeoff:** The message history interaction gains a second level of
nesting, and every state-advancing action now has more persisted
records to keep current.

### 10. Each persisting demo owns its own database

**Decision:** The multi-device page persists to a database separate from
the persistence demo's, and the storage module was reshaped so a caller
must name the database it is opening.

**Why:** The storage layer loads every record in its store and treats
records belonging to another group as stale, deleting them. Two demos
sharing a store would silently destroy each other's data on load, and
either page's Reset would clear both. Naming the database at the call
site makes that interference structurally impossible rather than
dependent on a filtering convention staying correct.

**Tradeoff:** The persistence demo's storage call sites changed for a
reason that has nothing to do with that demo. Separate databases also
do not mean separate eviction: persistence is granted per origin, so
both pages report the same storage status and a grant obtained on
either one covers both.

### 11. Devices use non-extractable signature keys

**Decision:** Each device's signature keypair is generated
non-extractable via the Web Crypto API, the same approach the
persistence demo uses.

**Why:** This page persists client state, and a real device's stored
identity is one whose private bytes are never readable. The persistence
demo has already shown that such keys survive a save and restore round
trip, so reusing the approach costs nothing and keeps the two persisting
pages honest about what a stored identity looks like. Downstream of
ADR-001.

**Tradeoff:** None material for this page. It does mean the two
persisting demos share an assumption that a future non-Web-Crypto
backend would have to revisit.

## Related

- **ADRs:** ADR-001 (Web Crypto as the default cryptographic backend)
- **PRD:** `tasks/prd-multi-device-demo.md`

## Open Questions

None outstanding.

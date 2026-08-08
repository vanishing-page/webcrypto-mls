# PRD: Multi-device Demo

## Introduction

A third example page that shows what happens to an MLS group when each
person carries more than one device. MLS has no concept of a "user" --
the ratchet tree holds one leaf per *client*. Someone with a phone, a
laptop, and a desktop is therefore three separate members of the group,
with three key packages, three leaves, and three independent copies of
the group state.

The existing two demos both assume one client per person, so neither can
show this. This page gives each of the seven example people three
devices, groups them in the UI, and lets you watch the consequences: a
message sent from Alice's phone has to be decrypted separately by Alice's
laptop, exactly as it does by Bob's laptop.

The user-to-device grouping is purely application-level. The library
never learns about it.

## Goals

- Show that one person maps to N leaves in the ratchet tree, not one.
- Make the "no notion of same user" property concrete by requiring a
  per-device decrypt of a message the person themselves sent.
- Let a device be inspected on its own: its leaf, its key material, its
  epoch, and the effect of rotating just that device's keys.
- Ship without changing `src/`, and without changing the behavior of the
  main demo or the persistence demo.
- Keep this page's persisted data structurally isolated from the
  persistence demo's.

## User Stories

### US-001: Device model module

**Description:** As a developer, I need a pure module describing the
three devices and the client-id encoding, so every other story can build
on one definition and it can be unit tested in Node without a browser.

**Acceptance Criteria:**
- [ ] New `example/devices.ts` exports `DEVICES`, an ordered list of
      three devices: phone (icon 📱), laptop (icon 💻), desktop
      (icon 🖥️), each with `id`, `label`, and `icon`
- [ ] Exports `clientId(user, deviceId)` producing `"Alice/phone"`
- [ ] Exports `parseClientId(id)` returning `{ user, deviceId }`, or
      `null` for a string that is not a valid client id (unknown device
      id, missing separator, empty user)
- [ ] Exports `userClientIds(user)` returning that user's three ids in
      `DEVICES` order
- [ ] Module imports nothing from `preact`, `@preact/signals`, or the
      DOM
- [ ] New `test/example/devices.ts` covers the round trip
      `parseClientId(clientId(u, d))`, and rejection of malformed ids
- [ ] Test file is registered in `test/index.ts`
- [ ] Typecheck and lint pass

### US-002: Route and nav entry

**Description:** As a visitor, I want a "Multi-device" link in the site
nav that takes me to `/multi-device`, so the third demo is reachable the
same way the other two are.

**Acceptance Criteria:**
- [ ] `example/routing.ts` exports `isMultiDevicePath(href, basePath)`,
      matching the shape of `isPersistencePath` (exact match and
      sub-path match, query string ignored)
- [ ] `navItems()` returns a third item, label "Multi-device", href
      `<base>/multi-device`
- [ ] Exactly one nav item is `active` on each of the three routes: the
      main demo link is no longer active while on `/multi-device`
- [ ] `example/index.ts` renders `MultiDeviceDemo` for that route
- [ ] `build-example` in `package.json` copies `public/index.html` to
      `public/multi-device/index.html`, as it already does for
      `persistence`
- [ ] `test/example/routing.ts` covers `isMultiDevicePath`
- [ ] `test/example/nav.ts` covers three-way active selection
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-003: Per-demo storage isolation

**Description:** As a developer, I need each persisting demo to own its
own indexedDB database, so that the two pages cannot read, overwrite, or
delete each other's records.

**Context:** `persistence-storage.ts` currently hardcodes
`DB_NAME = 'mls-persistence-demo'`, and `loadAllMembers()` returns the
entire store. Two demos sharing that store would each load the other's
records, classify them as stale (different `groupId`), and delete them.

**Acceptance Criteria:**
- [ ] `persistence-storage.ts` exports
      `createMemberStore({ dbName })` returning `saveMember`,
      `deleteMember`, `loadAllMembers`, and `deleteDatabase` bound to
      that database
- [ ] The pure exports (`memberKey`, `restoredUsersFromRecords`,
      `partitionPersistedNames`, `partitionRestorableRecords`,
      `PersistedMember`) remain top-level exports with unchanged
      signatures, so their existing tests are untouched
- [ ] `persistence-demo.ts` builds its store with
      `dbName: 'mls-persistence-demo'`, so existing saved data still
      loads and the page behaves identically
- [ ] The old module-level `saveMember` / `deleteMember` /
      `loadAllMembers` / `deleteDatabase` exports are removed, so no
      call site can accidentally use the unbound versions
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill: existing persistence
      demo data survives the refactor

### US-004: Page skeleton with household creation

**Description:** As a visitor, I want to create each person's three
devices and add a whole household to the group in one click, so I can
populate a 21-member tree without 21 interactions.

**Acceptance Criteria:**
- [ ] New `example/multi-device-demo.ts` exporting `MultiDeviceDemo`,
      built on `createDemoState()`
- [ ] The demo state's `users` map is keyed by client id, so
      `createUser`, `addUserToGroup`, and `rotateKeys` in
      `demo-actions.ts` are used unchanged
- [ ] User Management lists the seven `EXAMPLE_USERS`
- [ ] "Create Alice's devices" generates three key packages, one per
      device, each with its own non-extractable Ed25519 signature
      keypair (same approach as `createPersistentUser`)
- [ ] Group Operations offers "Start group as <user>", which creates
      the group from that user's phone and then adds their laptop and
      desktop
- [ ] Group Operations offers "<adder> adds <user>'s devices", issuing
      a **single** commit carrying one add proposal per device of that
      person not already in the group, so the epoch advances once and
      the leaves appear together
- [ ] Group Operations offers "<remover> removes <user>'s devices",
      issuing a single commit carrying one remove proposal per
      in-group device of that person
- [ ] The committing client for any household action is that user's
      first in-group device in `DEVICES` order
- [ ] Status panel shows members in group as a client count with the
      household count alongside, e.g. "Members in group: 21 (7 people
      x 3 devices)"
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-005: Tree diagram at 21 leaves

**Description:** As a visitor, I want the ratchet tree to stay legible
once it holds 21 leaves, so the diagram is still the main explanatory
element on this page.

**Context:** 21 members round up to 32 leaf slots. At the default
`nodeSpacing` of 60 that is 1860px wide and five levels deep, which the
current `max-width: 100%` / `max-height: 320px` rules would shrink into
illegibility. Twenty-one always-visible labels would collide with each
other regardless of spacing, so on this page a leaf shows its label
only while hovered or focused.

**Acceptance Criteria:**
- [ ] This page calls `selectTreeLayout` with tighter layout options so
      the diagram is readable at 21 leaves
- [ ] The SVG sits in a horizontally scrollable container on this page
      and renders at natural size rather than being scaled to fit
- [ ] The main demo and persistence demo diagrams are visually
      unchanged
- [ ] Leaf labels are hidden by default on this page. Hovering a leaf
      reveals its label; moving away hides it again.
- [ ] Keyboard focus reveals the label too, so the diagram is not
      mouse-only
- [ ] Because only one label is visible at a time, the label is the
      full description: the person's name, the device label, and the
      device icon
- [ ] A revealed label stays legible where it overlaps neighboring
      nodes and edges
- [ ] Label visibility is a `TreeDiagram` option, defaulting to the
      current always-visible behavior, so the main demo and persistence
      demo keep their labels
- [ ] Each leaf's `aria-label` names the person and device, so a screen
      reader gets what a hover reveals
- [ ] Blank leaf positions still render as blanks
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill at a full 21-leaf tree

### US-006: Selecting a person shows their devices

**Description:** As a visitor, I want to click a person in User
Management and see their three devices in the Status panel, so I can see
which devices exist and jump into any one of them.

**Acceptance Criteria:**
- [ ] Each person's name in User Management is an activatable control
      (mouse and keyboard), and the selected one is visually marked
- [ ] Selecting a person renders a "Devices" section in the Status
      panel, positioned **above** the tree-node detail block, so it
      appears above "All properties" whenever both are shown
- [ ] The section lists three rows, each with the device icon and its
      text label
- [ ] Each row indicates whether that device is in the group yet
- [ ] Selecting a person highlights all of their in-group leaves and
      each leaf's direct path in the tree, reusing the existing
      `on-path` styling
- [ ] Selecting a different person replaces the selection
- [ ] A person with no devices created yet still shows three rows, all
      marked as not in the group
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-007: Device Info replaces the tree

**Description:** As a visitor, I want to click one of those devices and
see that device's own MLS state in place of the tree diagram, so I can
inspect a single client.

**Acceptance Criteria:**
- [ ] Each device row in the Devices section is clickable (mouse and
      keyboard)
- [ ] While a device is selected, the right-hand card's heading reads
      "Device Info" instead of "Ratchet Tree" and its body shows that
      device's information in place of the SVG
- [ ] Device Info shows: the device icon and label, the owner's name,
      the client id, whether it is in the group, and for an in-group
      device its leaf index, node index, epoch, and HPKE public key
- [ ] A device with no group state shows a short explanation instead of
      key material rather than erroring
- [ ] The "Clear" button remains in the header while a device is
      selected
- [ ] Clear deselects the topmost selection: the device if one is
      selected, otherwise the tree node. Escape does the same.
- [ ] Clearing a device selection restores the tree diagram with any
      previously selected tree node still selected
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-008: Rotate one device's keys

**Description:** As a visitor, I want to rotate the keys of a single
device, so I can see that a rotation touches only that device's direct
path and not the person's other devices.

**Acceptance Criteria:**
- [ ] Device Info has a "Rotate keys" button for an in-group device
- [ ] The button calls the existing `rotateKeys` action with that
      device's client id
- [ ] After rotating, the epoch advances once and the status line names
      the device that rotated, e.g. "Alice's phone rotated keys"
- [ ] The other two devices belonging to that person are unchanged
      apart from the shared epoch advance
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-009: Remove one device from the group

**Description:** As a visitor, I want to remove a single device from the
group, so I can play out the lost-phone case: revoke one client and see
the person's other devices carry on.

**Acceptance Criteria:**
- [ ] Device Info has a "Remove from group" button for an in-group
      device
- [ ] The action calls the existing `removeUserFromGroup` with the
      target device's client id
- [ ] MLS does not let a member commit their own removal, so the
      committing client is another in-group client, chosen as: another
      device belonging to the same person if one is in the group,
      otherwise any other in-group client
- [ ] The status line names both clients, e.g. "Alice's laptop removed
      Alice's phone"
- [ ] The button is unavailable when no other client is in the group to
      commit the removal, with a short explanation rather than a
      failing click
- [ ] After removal the tree shows a blank at that leaf, and the
      person's remaining devices stay in the group at the new epoch
- [ ] Removing the currently selected device clears the device
      selection, so Device Info does not linger on a client that is no
      longer in the group
- [ ] The removed device remains listed in the person's Devices
      section, marked as not in the group
- [ ] Removal regenerates that device's key package and signature
      keypair, since `removeUserFromGroup` clears the client's state
      but leaves its consumed key package in place, and MLS forbids
      reusing a key package. This mirrors what `rotateKeys` already
      does for an out-of-group user.
- [ ] After removal, adding that person's devices again re-adds the
      removed device using its fresh key package, and leaves the
      devices already in the group alone
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-010: Per-device persistence

**Description:** As a visitor, I want to persist individual devices to
indexedDB and have them restored on reload, so the page shows that each
device stores its own client state independently.

**Acceptance Criteria:**
- [ ] The page uses `createMemberStore({ dbName:
      'mls-multi-device-demo' })`
- [ ] Device Info has a "Persist" button for an in-group device, which
      saves that device's client state
- [ ] Each row in the Devices section shows whether that device is
      persisted
- [ ] Every action that advances group state (add, remove household,
      remove device, rotate, send, decrypt) re-saves each
      already-persisted device, and drops the record of a device no
      longer in the group, reusing `partitionPersistedNames`
- [ ] On load, persisted devices are restored and the user-to-device
      grouping is rebuilt by parsing each record's client id
- [ ] A restored record whose name is not a valid client id is treated
      as stale and deleted rather than restored
- [ ] Stale-record handling otherwise reuses
      `partitionRestorableRecords`, as the persistence demo does
- [ ] A restore failure is caught and reported into the status line,
      never allowed to escape module evaluation
- [ ] The page has a Reset button that deletes only
      `mls-multi-device-demo`
- [ ] The page shows the current storage-persistence status and a
      "Request persistent storage" button, reusing
      `storage-persistence.ts` and the persistence demo's
      granted/denied result messaging
- [ ] Using this page leaves persistence demo records untouched, and
      vice versa
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill, including a reload

### US-011: Two-step send

**Description:** As a visitor, I want to choose the person and then the
device I am sending from, so it is explicit that a message originates
from one client and not from a person.

**Acceptance Criteria:**
- [ ] Send Message keeps the message input and the row of "Send as
      <person>" buttons, disabled while the input is empty, as today
- [ ] Clicking "Send as Alice" reveals a second row reading "Send with:"
      followed by one button per device, showing icon and label
- [ ] Only Alice's in-group devices are enabled in that row
- [ ] Clicking a device button sends the message from that client and
      clears both the input and the pending sender, hiding the second
      row
- [ ] Clicking a different "Send as <person>" while a row is open
      switches the pending sender rather than opening a second row
- [ ] The message's history header identifies the sending device, not
      just the person
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-012: Two-step decrypt

**Description:** As a visitor, I want to decrypt a message separately on
each of a person's devices, so I can see that MLS gives no device a free
pass because it belongs to the same person as the sender.

**Acceptance Criteria:**
- [ ] Message History has one column per person, as today, not one per
      device
- [ ] A person's column shows a message box if any of their devices has
      that message queued or decrypted
- [ ] A box starts collapsed, showing the CIPHERTEXT section and a
      single "Decrypt" button, matching the current layout
- [ ] Clicking that button replaces the button with a "DECRYPT WITH:"
      label followed by three sections, one per device
- [ ] Each device section has an all-caps heading styled like the
      existing CIPHERTEXT and DECRYPTED headings, and contains a
      "Decrypt" button
- [ ] Clicking a device's "Decrypt" replaces that section's button with
      a "DECRYPTED:" heading and the plaintext, styled like the current
      decrypted block
- [ ] The sending device's section shows as already decrypted, since
      that client composed the plaintext
- [ ] The sender's other two devices show Decrypt buttons and must be
      decrypted individually
- [ ] A device not in the group shows no Decrypt button
- [ ] Expansion state is tracked per person per message, so expanding
      one box does not expand others
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-013: Page explainer

**Description:** As a visitor, I want the page to tell me what it is
demonstrating, so the 21-leaf tree reads as a lesson rather than as
clutter.

**Acceptance Criteria:**
- [ ] The page has an intro paragraph stating that MLS has one leaf per
      client, that the person-to-device grouping exists only in this
      demo's application code, and that the library is never told about
      it
- [ ] A "How to use" card lists the setup order: create devices, start
      a group, add households, select a person, select a device
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: Each person has exactly three devices: phone, laptop, desktop,
  each shown with an emoji icon and a text label.
- FR-2: Each device is a distinct MLS client with its own key package,
  its own leaf, and its own `ClientState`.
- FR-3: The person-to-device relationship exists only in demo
  application code. No change is made to `src/`.
- FR-4: Demo state keys clients by `"<person>/<deviceId>"`, so the
  existing actions in `demo-actions.ts` are reused without modification.
- FR-5: The page is served at `/multi-device` and linked from the nav
  as "Multi-device".
- FR-6: Adding a household issues one commit carrying an add proposal
  per device of that person not yet in the group; removing a household
  issues one commit carrying a remove proposal per in-group device of
  that person.
- FR-7: Selecting a person in User Management renders a Devices section
  in the Status panel above the tree-node detail block.
- FR-8: Selecting a person highlights each of their in-group leaves and
  direct paths in the tree.
- FR-8a: On this page, a leaf shows its label only while hovered or
  focused. Elsewhere leaf labels stay always visible.
- FR-9: Selecting a device replaces the tree diagram with a Device Info
  panel and changes the card heading from "Ratchet Tree" to "Device
  Info".
- FR-10: The Clear button clears the device selection when one exists,
  otherwise the tree-node selection. Escape behaves identically.
- FR-11: Device Info offers "Rotate keys", "Remove from group", and
  "Persist" for an in-group device.
- FR-11a: A single-device removal is committed by another in-group
  client, preferring another device belonging to the same person,
  because MLS does not let a member commit their own removal.
- FR-11b: Removing a device regenerates that device's key package and
  signature keypair, so the household add flow can re-add it without
  reusing a consumed key package.
- FR-12: The page persists to its own indexedDB database,
  `mls-multi-device-demo`, and its Reset deletes only that database.
- FR-12a: The page surfaces the origin's storage-persistence status and
  a "Request persistent storage" button, as the persistence demo does.
- FR-13: Sending is two-step: choose the person, then choose the device
  from a "Send with:" row.
- FR-14: Decrypting is two-step: expand a person's message box, then
  decrypt per device, with the sending device already decrypted.
- FR-15: Message History has one column per person, not per device.

## Non-Goals

- No device pairing or device-linking protocol. Devices are created by
  the demo, not linked to each other by any real mechanism.
- No device metadata beyond icon and label. No "last seen", no OS
  strings, no fabricated properties sitting next to real key material.
- No configurable device count. Three per person, fixed.
- No device pairing on re-add. A re-added device is a fresh client with
  a fresh key package, not the same client resuming.
- No changes to the main demo's or persistence demo's behavior. The
  storage refactor in US-003 is a pure refactor from their side.
- No changes to `src/`.
- No new ciphersuite, credential, or key-package options. Devices use
  the same non-extractable Ed25519 approach the persistence demo
  already uses.

## Design Considerations

Reuse, not reinvention:

- `createDemoState()` and `demo-actions.ts` are used as-is. Keying the
  users map by client id is what makes that possible.
- `TreeDiagram` and `TreeNodeDetailPanel` are reused. `TreeDiagram`'s
  card header (title plus Clear button) becomes a small shared shell so
  Device Info can present the same header with a different title.
- `selectTreeLayout` already accepts layout options, so the tighter
  21-leaf spacing needs no change to `tree-view.ts`.
- `storage-persistence.ts` (the `navigator.storage.persist()` wrapper)
  is origin-level and is reused unchanged. Both persisting pages show
  the same status, because persistence is granted per origin rather
  than per database.

Selection model. Three independent selections coexist: the selected
person, the selected device, and the selected tree node. Only the device
selection changes what the right-hand card renders. Clear and Escape
operate on the topmost one, so there is a single predictable rule.

CSS. Follow the existing nested-selector style in `style.css` and use
the variables already defined there. Do not restyle the two existing
demos.

## Technical Considerations

- The client-id separator `/` must not appear in a person's name. The
  current `EXAMPLE_USERS` contain none; `parseClientId` rejects
  malformed ids rather than guessing.
- `selectParticipants` returns client ids on this page, so any count
  derived from it is a client count. The Status panel must say so
  rather than implying seven members.
- 21 members occupy 32 leaf slots, leaving 11 blank positions in the
  tree. That is correct MLS behavior and should not be hidden.
- `createCommit`'s `extraProposals` already accepts an array, so a
  three-add commit needs no library change. One `Welcome` covers all
  three new members, and each joins from it with its own key package
  and private keys.
- Restoring from storage rebuilds the person-to-device grouping by
  parsing client ids, so no separate mapping is written to indexedDB.
- Non-extractable `CryptoKey` values are structured-cloneable, which is
  what makes the persistence demo's approach usable here.
- Every new pure module goes in its own file with a matching test under
  `test/example/`, registered in `test/index.ts`, following the
  existing `routing.ts` / `nav.ts` split between pure logic and
  components.

## Success Metrics

- A full tree shows 21 leaves for 7 people, and clicking any person
  highlights exactly 3 of them.
- A message sent from Alice's phone requires two further decrypt
  actions inside Alice's own column before all her devices can read it.
- Rotating Alice's phone advances the epoch once and changes only that
  leaf's direct path.
- Removing Alice's phone leaves a blank at its leaf while her laptop
  and desktop keep sending and reading messages.
- Reloading the page restores every persisted device at the current
  epoch.
- Using the multi-device page and then the persistence page leaves both
  sets of persisted records intact.

## Open Questions

None outstanding.

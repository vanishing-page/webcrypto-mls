# Attachments demo composition

Status: approved design, not implemented.

## Summary

The `/attachments` route currently replaces the main browser demo with a
standalone audio card. That hides the ratchet tree, user controls, membership
operations, messaging, and epoch details. The audio card also creates a hidden
one-member MLS group, so its attachment does not belong to the group shown by
the rest of the demo.

The route will instead render the normal demo with the audio card directly
below the page heading. Both parts will use the same `DemoState`. The audio
card will encrypt against the key schedule of the visible group. A group or
epoch change will clear the attachment and stop any active playback.

This document covers the demo application only. It does not change the
attachment library or either of the other demo applications.

## Goals

1. Keep the ratchet tree and every normal demo control on `/attachments`.
2. Put the audio card at the top of the normal demo content.
3. Encrypt attachments with the visible group's current key schedule.
4. Clear generated attachment state whenever that group or epoch changes.
5. Preserve the main route's current content and behavior.

## Non-goals

* Do not retain attachments across MLS epochs.
* Do not add attachment delivery to the message history.
* Do not add storage, upload, or download transport.
* Do not change the persistence or multi-device demos.
* Do not change attachment encryption, range reads, or playback scheduling.

## Route composition

`App` will continue to give the persistence and multi-device routes their own
page components. The attachments route will no longer select
`AttachmentsDemo` as a replacement page. It will select the main `Example`
component and tell it to include the attachment panel.

`Example` will accept a boolean prop that controls whether it renders the
panel. The default main route will omit the prop, so it will render exactly as
it does now. On `/attachments`, `Example` will render this order:

1. The existing page heading.
2. The attachment audio card.
3. The existing explanatory copy.
4. The existing status, ratchet tree, user, membership, messaging, and
   instruction cards.

The navigation stays unchanged. `Attachments` remains the active item on the
attachments route, while `Main demo` remains active only on the base route.

`example/routing.ts` will export a pure `selectDemoPage` function. It will
return a discriminated union for the main, persistence, and multi-device page
variants. The main variant will carry `showAttachments`. `App` will render from
that result, which gives route-composition tests a hook-free contract.

## Shared group state

`AttachmentsDemo` will become a panel rather than a complete page. It will
receive the existing `DemoState` instead of creating a ciphersuite and group
inside a mount effect.

The panel will select the same representative group member that the tree and
epoch views use through `selectGroupUser`. Every active member has the same
group context and key schedule for the current epoch, so the selected member's
`ClientState` is sufficient.

The panel will use:

* `state.users` to select the current group member;
* `state.groupId` to distinguish group replacement or removal;
* the selected member's `groupContext.epoch` to detect key changes;
* `state.ciphersuite` for attachment encryption and decryption; and
* the selected member's `keySchedule` for the attachment wrappers.

The production demo will no longer need `createDemoGroup`.
`example/attachment-group.ts` will be removed. Its constructor will move to
`test/helpers/attachment-group.ts`, where tests can still create a compact real
group without shipping that hidden path in the demo bundle.

## Group and epoch identity

The attachment panel needs one stable description of the cryptographic scope
that owns its current attachment. That scope consists of the MLS group ID and
the MLS epoch.

Pure logic in `example/attachment-plan.ts` will compare two scopes by bytewise
group ID equality and bigint epoch equality. It will not use `ClientState`
object identity. Normal state updates can replace a `ClientState` without
changing the attachment key scope.

A self-update changes the epoch even when membership does not change. It must
reset the panel for the same reason as an add or remove. Sending an application
message does not change the epoch and must not reset it.

## Attachment lifecycle

The empty panel has no encrypted bytes, reference, group snapshot, reader, or
audio context. Its progress is zero. Its status tells the user to create a
group when none exists and reads `Ready` when a group is available.

The panel will have an explicit phase:

* `idle`, with or without a current generated attachment;
* `generating`;
* `playing`; or
* `seeking`.

Only one action may own the panel at a time. Starting Generate clears any
previous generated attachment before entering `generating`. Play and Seek can
start only from `idle`, and each enters its matching phase before its first
await. Generate cannot run twice, and playback cannot start while generation
is in progress.

`AttachmentsDemo` will create its component-local signals with `useSignal`.
The functions that mutate those signals will be attached to an
`AttachmentState` object in `example/attachment-state.ts`. The component will
delegate Generate, Play, Seek, Stop, scope reset, and unmount cleanup to that
object. This follows the demo's State-object convention and leaves the
lifecycle testable without rendering a component.

`Generate` will read the representative group and ciphersuite at the start of
the action. It will encrypt with that group's key schedule and record the
current group and epoch scope beside the result. It will publish the encrypted
bytes and reference only if that scope is still current after encryption
finishes.

`Play` and `Seek` will require all of the following:

* generated bytes and an attachment reference exist;
* the generated scope still matches the visible group and epoch;
* the ciphersuite is available; and
* no conflicting playback action is running.

The component will reset when the visible scope changes or disappears. Reset
will:

1. Mark the current operation as cancelled.
2. Cancel the stream reader so its decrypt wrapper can wipe the CEK it owns.
3. Close the audio context.
4. Clear the generated bytes, reference, and recorded scope.
5. Set total and completed segments to zero.
6. Set status from the new group availability.

The reset writes related signals inside `batch()`. It will share the existing
resource-release path with Stop and unmount cleanup.

## Asynchronous changes

Group actions and attachment work are asynchronous. A group can advance while
generation, range setup, or playback is awaiting another operation. The panel
will assign a generation token to each action. Reset and Stop will invalidate
the active token before releasing resources. A Stop during range setup must
prevent that setup from later creating a reader or starting audio.

Every asynchronous action will check that token and the recorded group scope
after every await and before it publishes results. A stale action must clean up
every resource it owns, and it must not restore old bytes, progress, phase, or
status after Stop or reset.

Readers, range reads, and audio contexts belong to the operation that created
them. An operation will keep each new resource local until it confirms that
its token and scope are current. It may then transfer the resource to a shared
playback slot tagged with that token so Stop can release it. Cleanup for one
token must never cancel or close resources tagged with a later token.

Every exit path must release resources that have not been transferred. A stale
or failed sequential read must cancel its reader. A stale or failed range read
must call `close()`, even if it never called `decrypt()`. These steps are
mandatory because the attachment wrappers wipe their derived CEKs only when a
stream ends or is cancelled, or when a range read closes.

Stop applies only to playback in the current scope. It clears playback
resources and progress but keeps the generated attachment available for
another Play or Seek. It returns the phase to `idle` after cleanup. An epoch
reset clears both playback and the generated attachment.

## Controls and status

`Generate` will be enabled only in `idle` when both a visible group and
ciphersuite exist. `Play` and `Seek` will be enabled only in `idle` when a
current attachment exists. `Stop` will be enabled in `playing` and `seeking`,
including while either action is still setting up its reader or audio context.

The card will retain its two live regions for operation status and decrypted
segment progress. Reset status will distinguish these states:

* no group: create a group to generate an attachment;
* group available, no attachment: `Ready`; and
* attachment cleared by an epoch change: the same `Ready` state.

The UI will not claim that an attachment survived a membership or key change.

## Layout and styles

The attachment panel will use the existing `.card` and button styles. Its own
CSS will cover only the flexible button row and the two status lines. The
standalone `.container.attachments` page wrapper will no longer be needed.

No new colors are needed. Any attachment-specific CSS will use the existing
global color variables. The current attachment button override includes a
border radius and will be removed rather than carried into the combined page.
The button row will wrap at narrow widths without changing the ratchet tree's
existing responsive behavior.

## Errors and cleanup

The existing `errorStatus` mapping remains the user-facing error path for
generation, decryption, range, and playback failures. A failed action must
release its operation-local resources, return the phase to `idle`, and leave
the controls in a retryable state. Its status write is allowed only while its
token and scope are still current.

Reset, Stop, and unmount may race a reader or audio context that has already
closed. The existing `releasePlayback` behavior tolerates both cases. Cleanup
must run before dropping the references because cancelling the reader triggers
the decrypt wrapper's CEK cleanup.

No group secret or `ClientState` will be added to global scope. The existing
`import.meta.env.DEV` gate for `window.state` remains unchanged.

## Tests

Plain tests for `example/attachment-plan.ts` will cover:

* equal group IDs and epochs represent the same attachment scope;
* different group IDs do not match;
* different epochs do not match;
* replacing a `ClientState` inside the same scope does not force a reset; and
* a missing group has no usable attachment scope.

Plain tests for `example/attachment-state.ts` will use deferred promises and
fake readers, range reads, and audio contexts. They will cover:

* Generate cannot overlap another Generate, Play, or Seek;
* Play and Seek cannot overlap each other;
* reset during encryption prevents stale bytes and status from publishing;
* Stop during stream or range setup prevents playback from starting;
* stale progress and completion callbacks cannot update the panel;
* a stale sequential reader is cancelled exactly once;
* a stale range read is closed exactly once, even before `decrypt()`; and
* an old operation cannot release resources owned by a newer token.

Tests for `selectDemoPage` will verify that `/attachments` selects the main
demo with the panel enabled, while `/` selects the main demo without it. They
will also pin the existing persistence and multi-device selections. The tests
will not assert on rendered HTML text.

Existing tests continue to cover encryption with a real group key schedule,
range reads, playback scheduling, status formatting, and teardown order. If
`createDemoGroup` moves out of production code, those tests will import a
test-only constructor.

Implementation verification will run:

```sh
npm run test:checks
npm run test:unit
npm run test:browser
npm run typecheck
npx tsc -p example-realistic-demo/tsconfig.json --noEmit
npm run check:style
npm run build-example
grep -o 'window\.state=' public/assets/*.js
npm run build:realistic
grep -o 'window\.state=' example-realistic-demo/public/assets/*.js
```

Both grep commands must print nothing. Browser verification will check the
main and attachments routes at desktop and narrow widths. It will also create
a group, generate audio, advance the epoch, and confirm that the audio panel
returns to its empty state while the tree and membership controls remain.

## Acceptance criteria

### attachments-demo-composition.AC1: Combined page

* `/attachments` shows the attachment audio card directly below the main demo
  heading.
* The same page retains the ratchet tree and all user, membership, messaging,
  status, and instruction controls.
* `/` does not show the attachment card.

### attachments-demo-composition.AC2: Shared group

* Generate is unavailable until the user creates a visible MLS group.
* Generated audio uses that group's current key schedule.
* The panel creates no hidden MLS group.

### attachments-demo-composition.AC3: Epoch reset

* An add, remove, self-update, group replacement, or group removal stops active
  playback and clears generated attachment state.
* A normal application message does not clear the attachment.
* An asynchronous action from an old scope cannot repopulate cleared state.
* Stop during playback setup prevents that operation from later starting.
* Every stale or failed read releases the CEK-owning resource it created.

### attachments-demo-composition.AC4: UI quality

* Attachment status and progress remain available to assistive technology.
* The button row wraps at narrow widths.
* New or changed attachment CSS uses global color variables and no border
  radius.

## Files expected to change during implementation

* `example/index.ts`
* `example/attachments-demo.ts`
* `example/attachment-plan.ts`
* `example/attachment-state.ts`, new
* `example/style.css`
* `example/attachment-group.ts`, removed
* `example/routing.ts`
* `test/example/attachment-plan.ts`
* `test/example/attachment-state.ts`, new
* `test/example/attachment-group.ts`
* `test/example/routing.ts`
* `test/helpers/attachment-group.ts`

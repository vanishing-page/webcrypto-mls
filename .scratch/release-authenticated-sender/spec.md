# Release the authenticated sender, and move vanishing.page onto it

**Status:** ready-for-agent

**Origin:** vanishing.page `.scratch/staging-audit-fixes/` issue 09
(`09-webcrypto-mls-sender-leaf-index.md`), which blocks issue 10, the
Room sender binding (that spec's finding 1).

## Problem Statement

vanishing.page cannot tell which Room member actually sent a chat
message. The only sender it has is the machine name written inside the
encrypted payload and the one the relay attaches, and a member can put
any name in either. MLS has already authenticated the real sender by
the time the message decrypts, but the published library,
`@vanishing.page/webcrypto-mls` 0.0.11, does not report who that was.
vanishing.page asked for the authenticated sender's leaf index on the
`applicationMessage` result of `processMessage`, so its Room can refuse
a message whose claimed sender is someone else.

The library change has already been made. `processMessage` reports a
`sender` (an `AuthenticatedSender`: sender type plus leaf index) on
every `applicationMessage` result, and a `committer` on every accepted
commit. The existing result fields keep their shape, and a scenario
test covers both. None of this has been released. 0.0.11 predates it,
and vanishing.page's dependency range of `^0.0.11` admits only 0.0.11.

Releasing it is not just a version number:

- The unreleased changes include a long list of breaking changes from
  two security audits. One of them changes the shape of the
  `ClientState` secret tree with no migration path, and vanishing.page
  persists `ClientState` in IndexedDB. After the bump, every Room
  session saved under 0.0.11 fails to load.
- The release procedure would destroy the release notes. The npm
  `version` lifecycle regenerates the changelog from commit subjects,
  replacing the hand-written Unreleased section that documents the
  breaking changes, including the authenticated-sender entry.
- vanishing.page pins 0.0.11 in two places: its release check's
  minimum version and that check's test.

## Solution

Cut a new release of `@vanishing.page/webcrypto-mls` containing the
authenticated sender. Its changelog keeps the hand-written release notes
under the new version heading. Then move vanishing.page onto it:

- Bump the dependency and lockfile.
- Extend vanishing.page's release check so it proves, against the
  packed package, that an application message reports its sender's leaf
  index.
- Teach its chat storage to treat MLS state saved in the old shape as
  absent, so a member rejoins the Room instead of hitting an error.

## User Stories

1. As the vanishing.page Room, I want an `applicationMessage` result to
   name the leaf MLS authenticated as its sender, so that I can refuse a
   chat message whose payload claims a different member.
2. As a library consumer, I want the existing `processMessage` result
   fields to keep their names and types, so that code written against
   0.0.11 keeps compiling and behaving the same where the changelog does
   not say otherwise.
3. As a library consumer, I want the published changelog to list every
   breaking change in the release, so that I can find what my
   application has to change before I upgrade.
4. As the vanishing.page maintainer, I want the release check to fail if
   the installed package does not report the authenticated sender, so
   that the Room sender binding can never ship on a version without it.
5. As a Room member returning after the upgrade, I want my old saved
   session to be dropped and the Room to take me back through the normal
   rejoin path, so that I am not stuck on an error page.
6. As the vanishing.page maintainer, I want the existing chat suites to
   pass on the new version, so that I know the upgrade breaks nothing I
   rely on.

## Implementation Decisions

### In webcrypto-mls

- **No library code change.** `ProcessMessageResult`, `AuthenticatedSender`
  and the `sender` and `committer` fields are already on `main` and
  exported from the package root. For a `member` sender, `leafIndex` is
  the signing leaf. For a `new_member_commit`, it is the leaf the joiner
  was placed in. It is absent for sender types that have no leaf.
- **Release contents.** Release from `main` once staging has been
  merged, so the release includes the suspended-ReInit receive guard
  that is on staging today. The changelog describes that branch as it
  is at release time. The version is the next patch, 0.0.12, to stay
  on the existing 0.0.x line. A 0.0.x caret range never resolves across
  patch versions, so no existing consumer upgrades without an explicit
  edit.
- **Changelog preservation.** The Unreleased section is moved under the
  new version heading, with the date, and survives the `version`
  lifecycle step. The release must not end up with the auto-generated
  commit list in place of the hand-written notes. How that is achieved
  (adjusting the `version` script, or running the release steps by
  hand) is the implementer's choice. The check is that after tagging,
  the changelog section for the new version still has its Added,
  Breaking and Fixed subsections.
- **Publishing is the maintainer's step.** `npm publish` (run by the
  `postversion` script) needs the maintainer's npm credentials. An
  agent prepares everything up to the point of publishing, and the
  maintainer runs the publish.

### In vanishing.page

- **Dependency.** The dependency range is changed to the new version in
  `package.json`. The lockfile is regenerated with `npm install`, not
  edited by hand.
- **Release check.** `verifyMlsRelease` already packs the installed
  package and checks its exports, its import graph and a browser build,
  and it creates a group. Its minimum version moves to the new release.
  It gains one end-to-end step: two members in a real group, one sends
  an application message, and the other's `processMessage` result
  reports the sender's leaf index. The result object it returns gains a
  field carrying that reported sender, so the test asserts on data
  rather than on text.
- **Old persisted state.** The chat storage config version is bumped.
  A stored MLS state record, or a stored parent/staged operation pair,
  whose config version is not the current one is treated as absent:
  it is deleted and the load returns nothing, as it would for a Room
  with no saved state. The existing "Unsupported chat MLS state
  version" throw is replaced by this. Old records are discarded, never
  migrated: the library has no serialization format, and the old
  secret-tree shape cannot be converted into the new one (a chain
  secret cannot be recovered from key/nonce pairs, and recovering it is
  exactly what the audit fix prevents). This mirrors what the
  library's own demos did with their shared store.
- **Breaking changes vanishing.page does not hit.** These were checked
  and need no change. vanishing.page passes its own `ClientConfig` with
  a real `AuthenticationService` everywhere. Its one `processMessage`
  call passes `acceptAll`. It uses no proposal callbacks, branch joins,
  external joins or attachment APIs, and does not catch library errors
  by class. Its reconnect path sorts errors by substrings of the
  message. Re-check that classification against the new error messages
  for leaf and KeyPackage signature failures, which become
  `ValidationError`s. They must still sort as skippable rather than as
  an epoch fault.
- **Using `sender` in the Room is out of scope here.** Binding the payload's
  claimed sender to the authenticated leaf is vanishing.page issue 10,
  which this unblocks.

## Testing Decisions

A good test here drives a real MLS group through the public API and
asserts on the returned data: which leaf the result names, and whether
a load returns state. It does not assert on log text, error message
wording, or internal secret-tree fields.

- **Library seam: `processMessage`.** Already covered and green on
  `main` by the existing process-message-sender scenario test, which
  has charlie (leaf 2) send an application message and asserts alice's
  result reports `{ senderType: 'member', leafIndex: 2 }` alongside the
  unchanged `authenticatedData`. It also covers a member committer and
  a `new_member_commit` committer. Nothing new is needed. The release
  is gated on the full suite: `npm test`, `npm run test:browser`,
  `npm run test:checks`, `npm run typecheck`, the Worker typecheck,
  `npm run build`, then `npm run check:package`, which consumes the
  built `dist/` by package name and so catches a declaration that
  exists in `src/` but not in what ships.
- **Consumer seam: vanishing.page's release check.** This is the
  highest seam, because it exercises the packed artifact as installed,
  not the source. Its existing test (prior art: the
  mls-package-release test) gains an assertion that the reported
  sender is the sending member's leaf, and its version assertion moves
  to the new release. Before publishing, this can be run against a
  locally packed tarball to catch problems before anything ships.
- **Consumer seam: chat storage.** The existing chat-storage suite
  gains cases for the old-state rule. A record written with the
  previous config version loads as absent, and is gone afterwards. The
  same holds for a parent/staged operation pair. A record written with
  the current version still round-trips.
- **Regression gate in vanishing.page:** `npm run typecheck`, and the
  chat suites in both vitest projects (`npx vitest --run --project
  client test/chat-*.ts` and the same with `--project server`). The
  server project includes the real-MLS end-to-end suites (chat-e2e,
  chat-recovery-e2e, chat-persistence-e2e) and the release check.

## Out of Scope

- Binding a chat message's claimed sender to the authenticated leaf in
  the Room (vanishing.page issue 10).
- Any new library API. In particular, there is no serialization or
  migration format for `ClientState`.
- Reading `authenticatedData` or `committer` in vanishing.page.
- The `.claude/worktrees/` checkouts in vanishing.page, which import
  the library too and move with their own branches.
- Moving the library to a 0.1 or 1.0 version line.

## Further Notes

- The vanishing.page ticket's first two acceptance criteria are already
  met on `main`: the sender test exists, and the change is additive.
  The remaining work is the release and the consumer upgrade.
- The ticket says "the library already decrypts the sender data and
  drops it". That was true of 0.0.11 and is no longer true of `main`.
- Discarding saved sessions logs out every returning Room member once.
  That cannot be avoided without keeping the very secrets the audit
  removed. If the Room has a notice for a lost session, it should be
  shown here too.
- The status is `ready-for-agent` for everything up to `npm publish`.
  The publish itself, and the vanishing.page dependency bump that waits
  on it, need the maintainer.

## Comments

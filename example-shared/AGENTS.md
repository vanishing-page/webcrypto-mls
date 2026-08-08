# example-shared

Modules imported by both `example/` and `example-realistic-demo/client/`.
Nothing here is published; `tsconfig.build.json` excludes the directory.

## Two consumers, so every edit is two edits

The rule that makes this directory worth having is also its hazard: a
change made for one demo lands in the other with no call site to warn
you. Before editing, `grep -rn` the export across both `example/` and
`example-realistic-demo/client/` and decide for both. If the two want
different behaviour, the difference belongs in a prop or an argument,
not in a branch on which page is asking.

A default that suits the first caller is the version of this that gets
missed. `HowToUse` defaults `steps` to the multi-device page's order, so
a page with a different order shows another page's instructions unless
it passes its own. A test can say the prop is honoured when it is
passed; nothing can say a page should have passed it, because copy is
never asserted on. Give a shared component a default only where every
caller wants it.

A shared component that renders a custom element puts a requirement on
both consumers' entry files. `StoragePanel`'s button is a
`substrate-button`, so `example/index.ts` imports
`@substrate-system/button` for registration exactly as the realistic
demo's entry does. An unregistered custom element does not render, so
the missing import costs the control itself, not its appearance.

Styling it is the asymmetric half. The realistic demo imports the
package stylesheets; `example/style.css` deliberately does not and must
not gain them. Its bare `button` rule already reaches the inner
`<button>`, which is what keeps those two pages looking as they did, and
the package sheet would restyle pages that asked for no change.

## The two stores are one database schema

`createMemberStore` and `createSessionStore` are separate stores in the
same IndexedDB schema, created by one `onupgradeneeded` at version 1, so
a page gets whichever it asks for without an upgrade. Do not bump the
version to add a store: the existing demo databases are already at
version 1 and would be forced through an upgrade to gain something they
never read.

Each store is bound to a named database and every page owns its own
name. `loadAllMembers` returns every record and the caller deletes what
it cannot classify, so two pages sharing a name read each other's
members as stale and delete them.

The session store keeps its one connection open; the member store does
not. That asymmetry is deliberate and is explained where it lives -- an
IndexedDB delete blocks rather than fails while a connection is open.

## What a persisted record deliberately omits

`ClientState.clientConfig` holds function values that structured clone
cannot copy, so it is stripped on the way out and re-derived from the
library defaults on the way back in. A demo that starts using a
non-default config cannot persist it through these helpers, and would
need the config named in the record rather than rebuilt.

The pure halves -- `sessionRecord`, `isRestorableSession`,
`partitionRestorableRecords`, `restoredUsersFromRecords` -- take and
return plain data and are unit tested in Node, from `test/example/` and
`test/example-realistic-demo/`. Keep new logic on that side of the line;
the store wrappers are the part no Node fake can check, since none of
them model a blocked delete.

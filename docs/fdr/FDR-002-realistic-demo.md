# FDR-002: Realistic Demo

**Status:** Active
**Last reviewed:** 2026-08-05

**Amended 2026-07-27:** Decision 2 originally kept the example site on
GitHub Pages and deployed the delivery service as a separate Worker. The
deployment is now entirely on Cloudflare, with one Worker serving both
the page and the delivery service. Decision 2 is rewritten below, and the
Overview and Behavior sections are corrected where they named a route
that no longer exists.

## Overview

A fourth example, standalone rather than a route on the existing site,
where the browser is one real client rather than a simulation of many. A
visitor creates one user, creates a room, and sends the room's URL to
someone else. The second person opens that URL in a different browser
profile, creates their own user, and asks to join. Everything between the
two of them travels over a WebSocket to a Cloudflare Durable Object
acting as an MLS delivery service.

The other three demos all run every participant inside a single page.
Alice, Bob and Carl share one JavaScript heap, one set of timers, and
one indexedDB. That is the right shape for showing the ratchet tree and
the epoch mechanics, but it cannot show what an application built on
this library actually has to do: move key packages, welcomes, commits
and ciphertext between machines that know nothing about each other, and
cope with the fact that the other side is frequently not there.

The audience is someone who has understood the protocol from the other
demos and now wants to know what integrating it costs.

## Behavior

Setup is two steps. The page opens with a name field and a Create User
button, which generates one key package and one signature keypair for
that name. Once a user exists, a Create Room button appears. Creating a
room mints a short random room id, creates the MLS group with the local
user as its only member, and moves the page to `/<id>` on its own
hostname, where the full room URL is displayed for copying.

A Persist control sits in the page's status area throughout, not in the
setup flow. It can be turned on before a user exists, after a room is
created, or at any point in between, and it governs whether the account
and group state are written to browser storage. As on the other
persisting demos, the page reports whether the browser has granted
persistent storage for the origin and offers to request it.

Someone arriving at a room URL without a user sees the same name field
and Create User button. Creating a user there publishes their key
package to the room and shows them a waiting state. They may close the
tab; the request survives.

The room's creator sees pending requests as they arrive, or on their
next visit if they were away. Approving one commits an Add and the
resulting Welcome is delivered to that person, again whether or not
they happen to be connected at the time. Denying one discards the
request.

Members see the user list familiar from the other demos: who is in the
group, and the current epoch. Only the creator's client renders a Remove
control next to other members. The page states in plain text that this
is a rule the demo enforces in its own interface and that MLS itself
grants no such authority.

Members whose WebSocket has dropped are marked in the list as
disconnected. Their leaf is still in the tree and the group still
carries them, which is exactly what MLS does and what an application
has to decide about. The creator can remove them.

A removed member who asks to join again appears in the creator's pending
list marked as someone the creator previously removed, rather than as a
stranger. A request from someone the creator has already approved and
not removed is committed without prompting.

Every room states that it is deleted three days after it was created,
along with everything sent in it. Opening a room URL after that shows
that the room has expired and offers to create a new one.

The room has a chat pane. Messages are encrypted to the group and sent
through the delivery service, and are replayed when a member returns.
Messages sent before a member joined appear in that member's timeline as
placeholders saying how many there were and that they cannot be
decrypted.

Reset clears only this page's stored data.

## Design Decisions

### 1. One browser is one client

**Decision:** The page holds exactly one key package, one signature
keypair and one client state. A second participant means a second
browser profile.

**Why:** Every claim the other demos make about MLS is true, but they
make it inside a single process where the hard parts are free. Two
clients in one heap never disagree about what the current epoch is,
never receive a commit out of order, and never have to answer what to do
when the other side is absent. Those are the questions someone gets
stuck on when they try to build with this, and the only way to show them
is to have two machines that genuinely cannot see each other's memory.

**Tradeoff:** The demo cannot be exercised by one person in one window.
Trying it requires a second browser profile, and testing it requires two
isolated browser contexts, which is more apparatus than any other page
here needs.

### 2. One Cloudflare Worker serves the page and the delivery service

**Decision:** A Durable Object per room, hosted by the same Cloudflare
Worker that serves the page's static assets and handles the WebSocket
upgrade. The page is standalone at the root of that Worker's hostname
rather than a route on the existing site, and the WebSocket is
same-origin. The three existing demos stay on GitHub Pages, untouched.
Code both applications need moves to a shared directory.

**Why:** MLS specifies nothing about transport; it assumes a delivery
service exists and says almost nothing about what it must do beyond
ordering. Something has to play that role, and a Durable Object is a
close fit because MLS ordering guarantees are per-group and a Durable
Object is a single-threaded actor per name.

Putting the page in the same Worker was not the original intent, but two
Workers cannot share a hostname -- not on `workers.dev`, and not on a
custom domain, where a Custom Domain binds every path to a single Worker.
So separating the delivery service into its own deploy and having a
same-origin WebSocket are mutually exclusive. Same origin is worth more:
it removes a configured endpoint, a build-time variable, a CORS surface,
and an entire class of misconfiguration, none of which teach a reader
anything about MLS. Serving the page from a Worker also gives real
wildcard routing, so a room URL returns 200 rather than rendering
correctly under a 404.

The boundary the original decision wanted to make visible is preserved
differently: by directory rather than by deploy. Everything belonging to
the delivery service lives in one place, and the Durable Object still
knows nothing about MLS.

**Tradeoff:** The delivery service is no longer a separate deployable
thing, so the claim that it has a different lifecycle from the frontend
is now a claim about code organisation rather than about infrastructure.
There are still two deploy targets overall, GitHub Pages and Cloudflare,
but they serve different applications rather than one application and its
backend. Shared code has to be extracted for two applications to use it,
which touches the existing demos for a reason unrelated to their
behavior. Workers Builds configuration also cannot be committed, so the
root directory and the build and deploy commands have to be set in the
Cloudflare dashboard and written down elsewhere.

### 3. The room keeps an append-only log, not a relay

**Decision:** The Durable Object stores every handshake and application
message in order, and clients replay from the last position they saw.

**Why:** A pure fan-out relay is less code and would carry a live
conversation fine, but it makes persistence pointless. A client that
persisted its state, closed the tab, and came back would hold a valid
key schedule for an epoch the group had left, with no way to catch up
and no way to tell that it had fallen behind. The persistence control is
only worth offering if returning actually works, and returning only
works if the messages missed are still there. This is also what real
delivery services do, and storing ciphertext costs the server nothing it
can read.

**Tradeoff:** The room accumulates state, and because nothing is ever
pruned from the middle of the log its size is bounded only by the room
lifetime in decision 12. Catching up is all or nothing: a returning
client either replays from wherever it stopped, or finds the room gone.

### 4. Joining is creator-approved, by Welcome

**Decision:** A newcomer publishes a key package; the creator commits an
Add and the newcomer joins from the resulting Welcome. The library's
external commit support is not used here.

**Why:** Welcome is the path that almost every real application takes,
and it is the one that carries the interesting content: the newcomer
learns the group's whole state from a message they can decrypt with
keys they generated before they knew the group existed. External commit
solves a narrower problem, and letting anyone who has the URL insert
themselves would contradict the point of having an approval step at all.

**Tradeoff:** Joining now depends on another person acting, which is
slower to demonstrate and introduces the failure mode in decision 5.

### 5. Joining is asynchronous in both directions

**Decision:** Pending key packages are held in the room until the
creator acts on them, and a Welcome produced by an approval is held for
its recipient until they reconnect. Neither party has to be present when
the other one is.

**Why:** With a creator-approved join and only live delivery, the demo
deadlocks in the most ordinary situation there is: two people in
different time zones, one of whom closes a laptop. Anyone trying this
with a friend rather than with two windows on one desk would hit it
immediately and conclude the thing is broken. Holding both halves is
also the truthful version of what an application has to build, since a
delivery service that only works when everyone is watching is not a
delivery service.

**Tradeoff:** The room carries two queues and the states between them,
which is the largest single piece of logic in the Durable Object. It
also means a key package can sit unclaimed for as long as the room
lives, so its lifetime has to outlast the room's.

### 6. Creator-only removal is stated as a demo rule, not enforced

**Decision:** Only the creator's client renders Remove controls, and the
page says outright that this is an interface convention with nothing
cryptographic behind it. The delivery service does not inspect messages
to enforce it.

**Why:** RFC 9420 has no administrator. Any member can commit a Remove,
and a member who wanted to could do so here by other means. Two
alternatives were available and both are worse. Letting the Durable
Object parse commits and reject unauthorised removals would put MLS
wire-format knowledge into a component whose entire value is that it
does not need any, and it would still be a policy invented by this demo.
Silently hiding the button and saying nothing would leave a reader
believing MLS provides a permission model it does not. Saying where the
protocol stops and the application starts is more useful than either.

**Tradeoff:** The demo shows a moderation model it cannot back up. Any
application that wants real administrative authority has to build it,
and this page does not show how.

### 7. Persistence is a standing control, not a setup step

**Decision:** The Persist toggle is present in the page's status area
from the first render and stays there, rather than appearing as a stage
between creating a user and creating a room.

**Why:** Persistence is not something a session passes through once. It
is a property of the session that a visitor should be able to turn on
after they have already seen the room work, or turn off before handing
the machine to someone else. Modelling it as a setup step would suggest
the decision is made once at the beginning, which is the opposite of the
point.

**Tradeoff:** Turning it on midway has to write whatever state already
exists, and turning it off has to clear it, so both directions are real
operations rather than a flag consulted later.

### 8. Disconnected members are marked, not evicted

**Decision:** The room tracks socket liveness and the user list marks
members whose connection has dropped. Nothing is removed automatically.

**Why:** A member who did not persist and closed their tab is gone in
every sense that matters, but their leaf is still in the ratchet tree
and the group still encrypts to it. That gap between what the protocol
knows and what is true is a genuine property of MLS, not a defect to
paper over, and it is the clearest justification the Remove control has.
Evicting automatically would hide it and would also make a brief network
interruption look like a departure.

**Tradeoff:** A room left alone accumulates disconnected members until
someone prunes them, and liveness is a delivery-service observation
being displayed next to protocol state, which risks reading as though
MLS knew about it.

### 9. Undecryptable history is shown

**Decision:** Messages sent before a member joined appear in that
member's timeline as counted placeholders rather than being omitted.

**Why:** This is forward secrecy, which is one of the main reasons to
choose MLS, and it is invisible unless something points at it. A
timeline that simply starts at the joining epoch looks like a timeline
with a short history. A timeline that says three messages exist here
that you cannot read makes the guarantee concrete, and it is free,
because the log already contains those messages.

**Tradeoff:** The chat pane has a second message shape to render, and a
reader who misses the explanation could read the placeholders as an
error.

### 10. The room id is a routing address, not the group id

**Decision:** The URL carries a short random id that names the Durable
Object. The MLS group id is separate and is not derived from it.

**Why:** These identify different things. The room id addresses a place
where messages can be exchanged and needs to be short enough to paste
into a message; the group id is protocol state that appears in every
group context and is compared byte for byte during validation. Deriving
one from the other would tie a transport-layer name to a cryptographic
one for no benefit and would make it awkward for a room to ever host a
different group.

**Tradeoff:** Two identifiers to keep straight, and a room whose group
has ended is a valid address pointing at nothing.

### 11. Shared storage layer, separate database

**Decision:** The page reuses the existing storage module rather than
introducing its own, and names its own database when opening it, as the
multi-device demo does.

**Why:** The epoch-based staleness rules in that module were worked out
against exactly the problem this page has, and reimplementing them
alongside would mean two sets of subtly different logic for deciding
whether stored state is still usable. The separate database is required
for the reason recorded in FDR-001: the module deletes records it
regards as belonging elsewhere, so two pages sharing a store would
destroy each other's data on load.

**Tradeoff:** This page's needs now bear on a module three demos depend
on, so changes it wants have to be made without disturbing them.
Separate databases also do not mean separate eviction, since persistence
is granted per origin.

### 12. Rooms expire three days after creation, and say so

**Decision:** The whole room, group and log together, is deleted three
days after it was created, measured from creation rather than from last
use. Nothing is pruned before then. Every room displays the rule.

**Why:** Something has to bound a store of other people's ciphertext,
and the two obvious rules trade against each other. Expiring after a
period of inactivity keeps a live conversation alive, but it means the
log has to be pruned from the front while the room runs, so a returning
member can arrive holding a cursor into messages that no longer exist
and cannot be caught up. Deleting on a fixed schedule instead makes that
state unreachable: as long as the room is there the log is complete from
epoch zero, and when it is not there, there is nothing to be confused
about. That collapses what would otherwise be a catch-up-or-reset
decision into a single fact a returning client can check. Saying the
rule in the interface matters because the alternative is a URL that
silently stops working.

**Tradeoff:** A conversation still going on the fourth day is cut off,
which is the wrong behavior for a product and an acceptable one for a
demo whose purpose is a session or two with a second browser profile.
Members who persisted keep local state for a group whose delivery
service no longer exists, so the expired-room page has to explain that
rather than reading as an error.

### 13. The room remembers who it has approved and who it has removed

**Decision:** The room keeps the signature identities it has admitted
and the ones it has removed. A request from an admitted identity is
committed without prompting the creator; a request from a removed one is
surfaced to the creator marked as a previous removal.

**Why:** The value here is mostly in the second half. Without any
memory, someone the creator deliberately removed comes back looking
exactly like a new arrival, and the creator can re-admit them without
ever being told what they are doing, which quietly empties the Remove
control of meaning. Recognising returning identities is the cheaper half
of the same bookkeeping and saves a click for people who were already
trusted.

**Tradeoff:** Skipping the prompt is a smaller convenience than it
sounds. The delivery service holds no group state and no key material,
so it cannot admit anyone itself; the creator's client still has to
commit the Add, and still has to be present or come back. Against that,
the room now carries an identity ledger, which is application state
sitting next to a protocol that deliberately has no such concept.

### 14. Every view is two columns, split by what the reader is doing

**Decision:** The page owns the split, not the view. Where there is width
for it, every view puts its controls and its own state in a left rail and
its explanatory prose in a right column, and the two standing sections
join the same two tracks: the persistence control below the rail, the
trust disclosure and the how-to below the prose. The room's existing
division -- what the room is, beside what has been said in it -- becomes
one instance of this rather than a layout of its own. Below the
breakpoint everything stacks in the order it already stacked in.

**Why:** The room had already made this split and it was the right one.
Every other view has the same shape and was not using it: a short form or
a short statement, followed by several screens of prose that has to be
read before the form means anything. In one column that prose is below
the fold, so the first thing a visitor meets is a name field with no
reason attached, and the trust disclosure -- which is the argument for
the whole page, per decision 6 and the standing placement in decision 7
-- is something they scroll past after they have already decided. Two
columns put the decision and the reason for it on screen together.

Making it a property of the page rather than of each view is what keeps
the vertical rule in the same place from one view to the next, so
creating a room does not rearrange the page around the reader. It is also
what stops the persistence control and the explainer being a full-width
footer under everything. Those two carry exactly the distinction the
columns already draw -- one is a control, the other is reading -- so they
belong in the tracks that say so.

**Tradeoff:** The room needs more width than the other views, because its
right column is a message log that reads badly below the measure, so the
two do not split at the same width. Between those two widths the page
changes width when a room is created. Every view now has to be legible in
a rail narrower than anything on this page was written for, and the
layout depends on the two standing sections being the last things in the
page, which is a coupling the one-column stack did not have.

## Related

- **ADRs:** ADR-001 (Web Crypto as the default cryptographic backend)
- **FDRs:** FDR-001 (Multi-device demo)
- **PRD:** `tasks/prd-realistic-demo.md`
- **Design plan:** `docs/design-plans/2026-07-27-realistic-demo.md`

## Open Questions

What happens when a creator stops coming back. Pending requests
accumulate with no one able to approve them, and there is no path to a
new administrator, because decision 6 means there is no administrator to
transfer. Decision 12 bounds the damage rather than fixing it: the room
is unjoinable until it expires, then cleans itself up. An application
would need a real answer.

Whether a room approaching expiry should warn its members, and whether
the expired-room page can tell a former member that the room they
persisted state for is the one that expired, given that the room id is
all that survives on the server side and nothing survives at all once it
is deleted.

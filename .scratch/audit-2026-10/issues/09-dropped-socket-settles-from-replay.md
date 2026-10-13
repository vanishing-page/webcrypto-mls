# 09: A dropped socket settles a pending commit from the replay

**What to build:** audit finding F1 (the dropped-socket case), spec
story 4. A socket that drops after the commit is sent ends the same
way as a refusal today: the creator has already moved on, whether or
not the room got the commit.

A dropped socket leaves the pending commit in place. After reconnect
the replay is the authority. An own echo of the pending payload in the
replay settles it as accepted, and the Welcome/`approve` or `removed`
follow-ons are sent then. Reaching the end of the replay -- the last
page, `more` false -- without that echo settles it as lost, which is
treated as a refusal: reported in `state.status`, nothing else sent,
creator's group unchanged. The echo rule is the one 07 already uses;
the new piece is settlement at the end of the replay, which belongs in
the pure pending-commit module and is fed by `connection.ts`.

**Blocked by:** 08

**Touches:** the pending-commit module from 07,
`example-realistic-demo/client/connection.ts` (end-of-replay signal),
`example-realistic-demo/client/approvals.ts` (only if the settle
dependency needs a lost outcome),
`test/example-realistic-demo/approvals.ts`, the pure module's Node
test file

**Status:** done

- [x] Add: a drop after the commit, with the commit in the replay,
      finishes the approval; the joiner processes a creator
      application message.
- [x] Add: a drop after the commit, with the commit absent from the
      replay, sends no Welcome and no `approve` and leaves the
      creator's epoch unchanged.
- [x] Remove: the same two cases hold for `removed` and the creator's
      epoch.
- [x] A replay that spans several pages settles only on the last page
      (`more` false), not on an earlier page that lacks the echo.
- [x] The pure module: settlement at the end of a replay with no own
      echo yields lost; an echo on any page before the end yields
      accepted.
- [x] `npm run typecheck`,
      `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` and
      `npm run test:checks` are clean.

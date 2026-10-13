# 08: A removal waits for the room to accept its commit

**What to build:** audit finding F1 (the Remove half), spec story 6.
Removal has the same flaw as approval: the creator sends its commit,
then the `removed` frame, and adopts the new epoch without waiting for
the room. A refused Remove leaves the creator ahead of the room and
the roster out of step with the log.

Apply the pending-commit machinery from ticket 07 to the `remove`
path. The commit is sent with a `ref` and held as the pending commit,
and only on acceptance does the creator send `removed` and write
`state.group` (inside `batch`). Refusal is handled by reason as in 07:
`rate-limited` retried after the interval up to the bound, `log-full`
and `log-too-large` reported and not retried. Nothing else is sent on
refusal, and the creator's group does not change.

Extend the simulated-room harness from 07; do not build a second one.

**Blocked by:** 07

**Touches:** `example-realistic-demo/client/approvals.ts`
(`removeMember`, `remove`), the pending-commit module from 07 (only if
it needs a Remove-specific follow-on),
`test/example-realistic-demo/approvals.ts`

**Status:** done

- [x] An accepted Remove sends `removed` after the commit's echo, the
      creator moves to the new epoch, and a remaining member processes
      a creator application message at that epoch.
- [x] A `log-full` refusal of a Remove sends no `removed` frame and
      leaves the creator's epoch unchanged; the member being removed
      still processes a creator application message.
- [x] A `rate-limited` refusal of a Remove followed by the interval
      completes the removal, and the removed member reaches the
      removed state.
- [x] An approval and a removal inside one interval leave every
      remaining member at the creator's epoch.
- [x] `npm run typecheck`,
      `npx tsc -p example-realistic-demo/tsconfig.json --noEmit` and
      `npm run test:checks` are clean.

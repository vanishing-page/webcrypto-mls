# Human test plan: random-access attachments

Two items in this feature cannot be closed by a machine. Everything else
is covered by 37,614 unit assertions, a ciphersuite matrix sweep, a
cross-implementation harness against swift-raae, and a layering gate that
runs on every `npm test`.

Automated coverage was audited against the test-requirements matrix: 15 of
16 acceptance criteria have automated test coverage, and the sixteenth
(AC6.1, progressive playback) is the human verification this document
covers.

## H1: AC6.1, progressive playback (about 4 minutes)

Use headphones or a quiet room. The tone is low and easy to miss on
laptop speakers.

Setup: `npm start`, open http://localhost:1234, click Attachments in the
nav, and leave the browser console visible.

| # | Action | Pass | Fail |
|---|--------|------|------|
| 1 | Click Generate | Status shows a sealed attachment; segment total reads 12 | Any other total, or an error |
| 2 | Click Play, watch the counter | Sound starts while the counter reads fewer than 12, typically at 1 of 12. Counter advances about one segment per 250 ms, reaching 12 in roughly 3 s while audio continues to about 12 s | Silence until the counter reaches 12, or no sound at all |
| 3 | Listen | A steady low hum near 220 Hz, pitch drifting slowly up and back over 12 s, with a gentle wobble every 2 s or so. It must be genuinely audible | No sound, static, or distortion |
| 4 | Listen at the seams | Segments are 65536 bytes, so a seam passes about once per second. The tone should be continuous | A click, gap or stutter about once per second, or a doubled, phasey or echoing quality |
| 5 | Let it finish | Status reaches "Playback complete"; audio ends cleanly at about 12 s | Audio ends early, or runs past the end |
| 6 | Click Seek | Status reports fetched ranges that exclude the leading blocks: expect the header plus roughly 512-814 KB, not 0-768 KB | Ranges start at 0 or cover the whole object, which is a full download rather than random access |
| 7 | Listen after Seek | Audio resumes mid-note at a noticeably lower pitch than step 3, near 137 Hz against 220 Hz at the start. Both halves matter: the pitch and the truncated range report | Pitch matches the beginning, meaning it restarted from 0:00 |
| 8 | Check the seams again | Same continuity standard as step 4 | Same failure signs as step 4 |
| 9 | Click Stop mid-playback, then Play | Audio stops at once, status reads "Stopped", and Play produces audio again | Audio continues after Stop, or Play is dead afterwards |
| 10 | Check the console | No errors or unhandled rejections at any point | Any error |
| 11 | Stop the dev server | | |

Record the segment count at audible onset (step 2), the exact
fetched-ranges string (step 6), and an explicit yes or no on audibility
(step 3) and seam continuity (steps 4 and 8). Those last two are the
entire reason this item is human-verified.

What has already been confirmed by driving Chrome: status reaches
"Playing..." with 1 of 12 segments decrypted, the counter advances one
segment per 251 ms matching the 250 ms throttle, Seek fetches only the
header and 512-814 KB of a 768 KB object, Stop halts and recovers, and a
full Generate, Play and Seek cycle produces no console errors. What
remains is whether sound actually comes out, and whether it is
continuous rather than doubled or gapped.

## H2: AC5.2, interop in CI

Open the `interop` job log from the first push that contains it.

Pass requires that the log does NOT contain
`SKIP: swift toolchain not found`, and that it contains, for both nonce
modes, the lines: schedule, TS seal to Swift open, Swift seal to TS
open, epoch crossing, is_final, tamper detection, ending in
`All interop tests passed!`.

The line `range read: skip` is expected. swift-raae does not implement
`snap_id 0x0003` and its profiles table pins `SEAL-RO-v1` to
`snap_id 0x0000`, so it cannot seal segments under the SEAL-attachment
payload_info. See "SEAL Profile and snap_id Conformance" in the design
plan.

Record the run URL. A local `npm run test:interop` on a machine with a
Swift toolchain substitutes; that has already been run and passes.

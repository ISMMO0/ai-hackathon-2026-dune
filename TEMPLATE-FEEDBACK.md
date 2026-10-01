# Template feedback

This file is what a tool built from this template sends back to the template. A tool never fixes the
template from inside its own repository. It writes an entry here, and the entry is carried back to the
template's repository.

Write an entry when one of these happens:

- Something was missing. The tool needed a slot, a test, a script or a doc that the template does not have.
- The tool had to change a file inside a chassis package (`packages/chassis-*`). Those folders are copies, so
  each such change is a chassis change that is owed at the source.
- The placeholder did not show something. The tool had to work out a step that `items` does not go through.

## Format of an entry

Add entries at the end of the file, oldest first. The heading carries the date, the tool and a short title.
The body has three fields.

```markdown
## YYYY-MM-DD, <tool>, <short title>

- **What happened:** the facts, with the paths and the commands.
- **What it cost:** the time lost, the workaround, what is still wrong.
- **Proposed change:** what the template or the chassis should do instead, and where.
```

Keep one problem per entry.

## Taken from Slideless

Slideless keeps a file of the same name for what it owes the template. Its entries below were taken into
the template, #29 on 22 September 2026 by the billing rail's re-copy, #30 to #32 on 29 September 2026 by the
wave that brought the chassis to Slideless 0.13.0; they are listed here so nobody carries them twice.

| Slideless entry                                                                     | Taken by                                                                        | Where it landed                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #29, the billing rail's phase 1 is chassis code to re-copy (PRDCT-2626)             | PRDCT-2648, the re-copy at slideless@12ef2f8                                    | `packages/chassis-contract/src/entitlements.ts`, `packages/chassis-server/src/entitlements/`, `packages/chassis-server/src/middleware/body-refusal.ts`; the `entitlements` slot in `apps/server/src/tool.ts` with `files.upload` on the chassis's upload route |
| #30, the hub–tool wire check is chassis code to re-copy (PRDCT-2677)                | PRDCT-2862, the re-copy at slideless@7714374                                    | `packages/chassis-contract/src/wire.ts`, the `wire:check` script and the `hub-wire` job of `.github/workflows/ci.yml`                                                                                                                                          |
| #31, count limits and conditional features are chassis code to re-copy (PRDCT-2702) | PRDCT-2862, the same re-copy; PRDCT-2863 for the placeholder's own declarations | `packages/chassis-contract/src/entitlements.ts`, `packages/chassis-server/src/entitlements/gate.ts`; the `items` declarations in `apps/server/src/tool.ts`                                                                                                     |
| #32, an optional external worker (PRDCT-2725)                                       | PRDCT-2865, as a pattern not yet lifted                                         | `LESSONS.md`, "An optional external worker, the pattern not yet lifted", carrying Romain's ruling                                                                                                                                                              |

## Entries

## 2026-09-29, the template itself (lane A of the 0.13.0 wave), a guest at an empty balance meets the credit check before the handler's guest refusal

- **What happened:** the chassis's billing gate (`packages/chassis-server/src/entitlements/gate.ts`) is
  registered in `create-api.ts` before the tool's routes, so on `POST /items` it runs before the item
  tree's `requireNonGuest`. The tool's count hook answers null for a guest, which skips the PLAN check
  only: the gate then runs the CREDIT check on the guest's principal, whose `accountRef` is the host
  workspace's central account. With the host's balance below the price, a guest reads 402
  `entitlement_denied` with `{ credits, balance, topUpUrl }`, the host tenant's figures, where the
  handler answers 403 `guest_forbidden`. A member naming a project they cannot link into meets the same
  check before the handler's 404. Found by the lane's verifier on 29 September 2026 by reading the
  gate; not reproduced in a suite, since a test would pin the leak.
- **What it cost:** nothing on the template's own suites (every case runs with a balance that covers
  1 credit); the invariant in CLAUDE.md had to say "the plan gate judges nothing" instead of "the
  handler answers", and a tool with a guest door on a metered route shows a guest the host's balance.
- **Proposed change:** in the chassis gate, a limit hook's null should end the gate's judgement of
  that request altogether (no credit check, no event), or the gate should run after the tool's own
  route guards; either way a caller the handler refuses must never reach the hub's check. A chassis
  change at `antasphere/slideless`, then a re-copy.
- **Taken:** 29 September 2026, by PRDCT-2908, the re-copy of the chassis at slideless@326d5ff. Slideless
  PRDCT-2900 (e3eb1b9) took the first proposal: a count hook's null ends the gate's judgement of the
  request, before the plan is read, so neither the plan nor the credit check runs and nothing is
  metered. `apps/server/test/integration/items-metering.test.ts` ("the check goes live") pins it on
  `items` at an empty balance: a guest reads 403 `guest_forbidden` and a member naming a project they are
  not on 404 `project_not_found` with the handler's own details only, the hub not asked.

## 2026-09-29, the template itself (the re-copy at slideless@326d5ff), a count hook that throws now lets the priced action through unmetered

- **What happened:** since Slideless e3eb1b9 (PRDCT-2900) the billing gate
  (`packages/chassis-server/src/entitlements/gate.ts`) ends its judgement when a count hook answers
  null, and `observedOf` turns a hook that THROWS into the same null. So a throw now skips the credit
  check and the usage event too, where before it skipped the plan only: the handler answers 201 and the
  action is neither checked against the balance nor metered. Found by the re-copy lane's verifier on 29
  September 2026 by making the `items.perWorkspace` hook throw for an allowed caller: at an empty balance
  the create landed (201 instead of 402) and no usage event was posted.
- **What it cost:** nothing on the template's suites, where the hook throws only in that mutation. A
  transient database error in the hook's count, or a buggy hook in a tool built from the template, fails
  open on billing without a trace beyond the warn log.
- **Proposed change:** in the chassis gate, keep the deliberate null (the handler will refuse: judge
  nothing) apart from a hook failure (judge the plan as unknown, but still run the credit check and emit
  the event after a 2xx). A chassis change at `antasphere/slideless`, then a re-copy.

## 2026-09-29, starter (the hackathon starter), the Content-Security-Policy has no media-src slot

- **What happened:** the starter's Try it page played the wav Gradium returned through an `<audio>` element on
  a `blob:` URL. The chassis CSP (`packages/chassis-server/src/middleware/security-headers.ts`, `buildCsp`)
  sets `default-src 'self'` and no `media-src`, and its options carry `frameSrc` and `imgSrc` only, so the
  browser blocked the load ("Loading media from 'blob:…' violates … default-src 'self'") and Speak played
  nothing. Found on the lane's own stack in a real browser on 29 September 2026; the e2e suite runs with no
  provider key, so it never reaches the player.
- **What it cost:** the page now decodes the bytes and plays them through the Web Audio API
  (`AudioContext.decodeAudioData`), which is not a media load; there is no native player with its seek bar.
- **Proposed change:** a `mediaSrc` option in `buildCsp`, threaded through the `app` slots as `cspFrameSrc`
  is, so a tool that plays audio or video it produced can allow `blob:` for media. A chassis change at
  `antasphere/slideless`, then a re-copy.

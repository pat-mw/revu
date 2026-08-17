# M8 board — local-only reviews

**Start here.** This file is the only one that claims to describe *right now*. It wins over any `State` row
in a ticket file; the two change in the same edit.

Workstream: [`MILESTONE.md`](./MILESTONE.md) · Handover: [`HANDOVER.md`](./HANDOVER.md) · Work log:
[`LOG.md`](./LOG.md) · Plan: [`ROADMAP.md`](./ROADMAP.md) · How sessions run:
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) · Design:
[`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md)

## In flight right now

**The daemon track is dispatched as three concurrent lanes.** M8.2, M8.3 and M8.4 are `In Progress`. Each
lane has its own branch and its own serial unit chain; the lanes never share a file, so three workers run
against each other while integration and gating stay serial in the main tree.

| lane | branch | chain (execution order, not numbering) | status |
| --- | --- | --- | --- |
| **A — M8.2** store v4 | `m8.2/store-v4` (base `m8.7`) | `.7 → .1 → .2 → .3 → .4 → .5 → .6` — **fully serial**: .1–.6 all write `direct/store.ts`, and .7 shares `store.test.ts` | **`.7` landed** (1617 pass); `.1` dispatched |
| **B — M8.3** git builder | `m8.3/local-snapshot-builder` | `.8 → .1 → .2 → [.3 → .4 → .5 → .6] ∥ [.7] → .9` — the bracketed chain is serial on `local-sync.ts`+its test; `.7` is parallel to it (`local-git.ts` only) | `.8` dispatched |
| **C — M8.4** write sink | `m8.4/local-write-sink` | `.6 → .1 → .8 → .2 → [.3 → .4 → .5] → .7 → .9` — `.7` and `.9` write **only** `local-writes.test.ts`, so they are serial, never two-wide | `.6` dispatched |

**All three lane branches are at `ef6b851`** — that is the STEP ZERO fast-forward target for the next dispatch
in every lane, and it advances as each lane's units land. A worker whose worktree is still at the repo base
commit has neither the lane's landed modules nor `node_modules`, and any result it produces before
fast-forwarding is void.

**Two guard rails land first in their lanes and are deliberately RED at their landing commit** — the protocol
requires a guard rail to land before the code it constrains, and both assert their target modules *exist*:

- **M8.3.8** (`local-no-github.test.ts`) is red until M8.3.1 and M8.3.2 create `local-git.ts` / `local-sync.ts`.
- **M8.4.6** (`local-write-isolation.test.ts`) is red until all four scanned files exist — green at M8.4.2.
- **M8.2.7** is the exception: it arms tripwires on *today's* store, so it lands **green** and armed.

Every other commit on every lane is gated green in the main tree. A red gate on one of the two files above,
at one of those commits, is the intended state and is recorded per commit in the ticket Log — it is not a
broken gate.

**The wave widths came from `HANDOVER.md`'s top entry, not from `ROADMAP.md`'s S3 table**, which plans
`3 → 4 → 6 → 6 → 4 → 2 → 1 → 1` on the assumption that the orchestrator can merge two workers' versions of
one file. It cannot — integration is by copying whole files out of isolated worktrees — so the honest widths
are `3 → 4 → 3 → 4 → 2 → 1 → 1 → 1` and the four collisions are named there. Do not re-derive them.

**The stack, bottom-up — four PRs open, none merged.** `main` → `m8/local-reviews-design`
([#69](https://github.com/pat-mw/revu/pull/69)) → `m8.1` ([#70](https://github.com/pat-mw/revu/pull/70)) →
`m8.6` ([#71](https://github.com/pat-mw/revu/pull/71)) → `m8.7` ([#72](https://github.com/pat-mw/revu/pull/72)).
#69 has no ticket row below because it is the design/board PR, not a ticket — but it gates the merge order.
The three new lanes extend it: `m8.2` on `m8.7`, then `m8.3` on `m8.2`, `m8.4` on `m8.3`. All three branches
**start** at `d0cc1d0` because they run concurrently; each is rebased onto its true base before its PR opens,
per `SESSION_PROTOCOL.md` §6 ("parallel results get rebased into the chain before their PRs open").

✅ **Every ref is pushed.** `m8.6/app-creation-flow` was one commit ahead of its remote (`0c17be9`, board
docs); it is pushed, so that commit now sits in #71's range instead of riding in #72's.

| ticket | state | where |
| --- | --- | --- |
| M8.1 | `In Review` — 9 units | PR [#70](https://github.com/pat-mw/revu/pull/70), base `m8/local-reviews-design` |
| M8.6 | `In Review` — 7 units, Verify green incl. the browser walk | PR [#71](https://github.com/pat-mw/revu/pull/71), base `m8.1` |
| **M8.7** | `In Review` — 13 units, `Verify` green, fable review run | PR [#72](https://github.com/pat-mw/revu/pull/72), base `m8.6` |

**M8.7's PR opened mid-session, in the order the protocol requires: `Verify` green (`3e7bfa6`) → the
fable-tier adversarial review of the full diff → its fixes (`de30223`) → PR #72, one minute later.** Review
before the PR opens is §8 of the protocol; the PR is not batched to session end. `main` is still untouched at
`177068a`; nothing has merged.

### M8.7 — exactly what has landed, and what has not

| unit | commit | gate at that commit |
| --- | --- | --- |
| M8.7.10 — the static-render harness | `f2ba173` | 1365 pass · 1 skip · 0 fail · 77 files |
| M8.7.1 — mode derivation + single-call-site guard | `ad0bd54` | 1373 pass · 1 skip · 0 fail · 78 files |
| M8.7.2 — tab set: omit Checks and Description | `efd260d` | 1391 pass · 1 skip · 0 fail · 79 files |
| M8.7.9 — the two optimistic-path bugs | `38b9bd3` | 1405 pass · 1 skip · 0 fail · 80 files |
| M8.7.4 — Conversation: threads only | `548f8e5` | 1411 pass · 1 skip · 0 fail · 81 files |
| M8.7.3 — header identity, state chip, 404, banner stack | `4a9cd44` | 1440 pass · 1 skip · 0 fail · 81 files |
| M8.7.5 — review-bar: no lock, no API claim, no broker | `27453da` | 1472 pass · 1 skip · 0 fail · 81 files |
| M8.7.6 — residual sweep, rate chip, org-member title | `71c71e0` | 1534 pass · 1 skip · 0 fail · 82 files |
| M8.7.8 — the dirty-worktree banner | `6dc373b` | 1551 pass · 1 skip · 0 fail · 83 files |
| M8.7.12 — the header draws the branch pair once | `c50787b` | 1558 pass · 1 skip · 0 fail · 83 files |
| M8.7.11 — the optimistic reply's author | `dd1931c` | 1570 pass · 1 skip · 0 fail · 83 files |
| M8.7.7 — the closing proof: GitHub path unchanged | `82c9d55` | 1589 pass · 1 skip · 0 fail · 83 files |
| M8.7 `Verify` — unit set, control ledger, mock walk | `3e7bfa6` | 232 pass · 0 fail in the unit-check set |
| M8.7.13 + review fixes — palette, and 7 guards made real | `de30223` | **1611 pass · 1 skip · 0 fail · 83 files** |

**All thirteen units are landed and M8.7 is complete.** The unit count grew by one when the pre-merge review
found the command palette still framing a local review as a pull request — appended as **M8.7.13** rather than
absorbed, the same handling M8.7.11 and M8.7.12 got.

### M8.6 and M8.1 — landed and pushed

| unit | commit | branch |
| --- | --- | --- |
| M8.1.9 refuse submit before first sync · review fixes | `4fbc5fb` · `8b73a77` | `m8.1` → [#70](https://github.com/pat-mw/revu/pull/70) |
| M8.6.7 harness · M8.6.1 · M8.6.2 · M8.6.3 | `440aa74` `8385bdf` `113aee8` `eb20f17` | `m8.6` → [#71](https://github.com/pat-mw/revu/pull/71) |
| M8.6.4 · M8.6.5 · M8.6.6 · review fixes · Verify | `be9442a` `836b841` `59e3e75` `a637522` `de14043` | `m8.6` → #71 |

**Every gate above was re-run by the orchestrator in the main tree**, never trusted from a worker's isolated
one. `main` is untouched at **`177068a`**; nothing merged.

## Tickets

**95 units across 12 tickets.** Dependencies below are the **post-review** graph — two adversarial passes over
the ticket set corrected several of them, so this table is authoritative over any earlier sketch. The unit
count grew from 74 when a test-first audit added thirteen units carrying test work that had no owner, then
from 87 when the owner's rulings appended M8.1.9 and the M8.12 ticket (2026-08-14).

| ID | Ticket | State | Units | Surface | Depends | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [M8.1](./tickets/M8.1-contract-and-mock.md) | Contract additions + the mock as the spec | In Review | 9 | shared, app, revud | — | `m8.1/contract-and-mock` | [#70](https://github.com/pat-mw/revu/pull/70) |
| [M8.2](./tickets/M8.2-store-v4.md) | Store v4: `local_*` tables | **In Progress** | 7 | revud | M8.1 | `m8.2/store-v4` | — |
| [M8.3](./tickets/M8.3-local-snapshot-builder.md) | Local snapshot builder (git-only) | **In Progress** | 9 | revud | M8.1 | `m8.3/local-snapshot-builder` | — |
| [M8.4](./tickets/M8.4-local-write-sink.md) | Local write sink | **In Progress** | 9 | revud | M8.1 | `m8.4/local-write-sink` | — |
| [M8.5](./tickets/M8.5-daemon-wiring.md) | Daemon wiring: dispatch, routes, `listPulls`, boot relaxation | Todo | 8 | revud | M8.1, M8.2, M8.3, M8.4 | `m8.5/daemon-wiring` | — |
| [M8.6](./tickets/M8.6-app-creation-flow.md) | App: creation flow + inbox surface | In Review | 7 | app | M8.1 | `m8.6/app-creation-flow` | [#71](https://github.com/pat-mw/revu/pull/71) |
| [M8.7](./tickets/M8.7-app-local-chrome.md) | App: local-mode chrome + copy correctness | In Review | 13 | app | M8.1, M8.6 | `m8.7/app-local-chrome` | [#72](https://github.com/pat-mw/revu/pull/72) |
| [M8.8](./tickets/M8.8-resync-and-pinning.md) | Re-sync, rebase safety, and object pinning | Todo | 8 | revud | M8.2, M8.3, M8.5 | `m8.8/resync-and-pinning` | — |
| [M8.9](./tickets/M8.9-archive-on-pr.md) | Archive when a PR appears | Todo | 7 | revud, app | M8.4, M8.5, M8.6, M8.7 | `m8.9/archive-on-pr` | — |
| [M8.10](./tickets/M8.10-retention-and-gc.md) | Retention and GC | Todo | 7 | revud | M8.2, M8.5 | `m8.10/retention-and-gc` | — |
| [M8.11](./tickets/M8.11-conformance-e2e-docs.md) | Conformance leg, e2e, and docs | Todo | 8 | all | M8.5, M8.6, M8.7, M8.8, M8.9, M8.10 | `m8.11/conformance-e2e-docs` | — |
| [M8.12](./tickets/M8.12-delete-confirm.md) | Delete confirmation for a review holding a draft | Todo | 3 | app | M8.6, M8.10 | `m8.12/delete-confirm` | — |

## Dependency graph

Four layers. Everything in a layer is mutually independent.

```
L0    M8.1   contract + mock ── the spec; gates everything (D6)
        │
        ├────────────┬────────────┬────────────┐
        ▼            ▼            ▼            ▼
L1    M8.2         M8.3         M8.4         M8.6
      store v4     git builder  write sink   app: create + inbox
        │            │            │            │
        └─────┬──────┴─────┬──────┘            ▼
              ▼            │                 M8.7  app: chrome + copy
L2          M8.5  daemon wiring                │
              │  (needs 8.1,8.2,8.3,8.4)       │
        ┌─────┼─────────────┐                  │
        ▼     ▼             ▼                  │
L3   M8.8   M8.10         M8.9 ◄───────────────┘
     rebase  GC           archive-on-PR
     safety               (needs 8.4,8.5,8.6,8.7)
        └─────┴─────────────┴──────┐
                                   ▼
L4                              M8.11  conformance · e2e · docs
```

**Where the real parallelism is.** M8.1 gates everything — it *is* the spec. After it lands, two tracks run
concurrently on genuinely disjoint packages and never wait on each other:

- **daemon** (`packages/revud`) — M8.2, M8.3, M8.4 mutually independent → M8.5 → M8.8 / M8.10.
- **app** (`packages/app`) — M8.6 → M8.7, needing only the mock, never revud.

They rejoin at M8.9, which needs both. M8.11 closes the milestone and needs everything.

Ticket-level dependencies are a coarse approximation of the real unit-level ones — [M8.8](./tickets/M8.8-resync-and-pinning.md)'s
units 1–3, for instance, are startable after M8.2 + M8.3 alone, ahead of M8.5. The session plan in
[`ROADMAP.md`](./ROADMAP.md) exploits that; it is the authority on execution order, and this graph is the
constraint it must satisfy.

## Exit criteria coverage

Which ticket's `Verify` proves each milestone exit criterion. An exit criterion with no proving ticket is a
gap in the plan, not a gap in the work.

| exit criterion | proved by |
| --- | --- |
| Full loop works with no remote, no token, no network | M8.5, M8.11 |
| Re-sync / amend / rebase keep drafts alive; no mass-`lost` from missing objects | M8.8 |
| Nothing ever reaches GitHub — structurally enforced + asserted | M8.4, M8.11 |
| No synthetic id in `snapshots.pr_number` / `audit_log.pr` / `pr_author.pr` | M8.2 |
| Conformance leg green in every transport; `check` + e2e green | M8.11 |
| No GitHub-flavored affordance on a local review | M8.7 |

## Conventions

- States: `Backlog` · `Todo` · `In Progress` · `In Review` · `Done` (+ `Canceled`).
- A ticket goes `In Review` when its PR is open. `Done` needs **both** its `Verify` run green **and** its PR
  merged — Verify alone is not sufficient, or a ticket would be `Done` while its code is still only on a
  branch. M8.6 and M8.7 both have green Verifies and stay `In Review` for exactly that reason.
- Units are `M8.x.n` inside each ticket file, numbered in default execution order. Append-only — never
  renumber; new units continue the sequence.
- Branch names carry the M-ID. A unit gets its own branch only if it ships as its own PR in a stack.
- The full protocol is [`../README.md`](../README.md).

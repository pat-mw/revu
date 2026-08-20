# M8 board — local-only reviews

**Start here.** This file is the only one that claims to describe *right now*. It wins over any `State` row
in a ticket file; the two change in the same edit.

Workstream: [`MILESTONE.md`](./MILESTONE.md) · Handover: [`HANDOVER.md`](./HANDOVER.md) · Work log:
[`LOG.md`](./LOG.md) · Plan: [`ROADMAP.md`](./ROADMAP.md) · How sessions run:
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) · Design:
[`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md)

## In flight right now

**M8.8 — re-sync, rebase safety, and object pinning — is In Review at 6/8** on
`m8.8/resync-and-pinning`, PR [#78](https://github.com/pat-mw/revu/pull/78), base `prefs/lost-update`. The two remaining units land on the
same branch and update the PR. Nothing is running. The four questions that blocked this
session's dispatch were put to the owner and **all four are answered** — recorded below and written into the
tickets they bind.

| unit | what landed | commit |
| --- | --- | --- |
| **M8.8.1** the pin seam | `local-pins.ts`, one atomic `update-ref --stdin` batch | `9522087` |
| **M8.8.2** pin before the first read | `syncLocalReview` carries the outcome; `syncPull` unchanged on the wire | `4d73d69` |
| **M8.8.3** rewrite detection | the author-date fallback reported **zero** on a rebase; mock moved first | `7ed601d` |
| **M8.8.4** missing objects | the `line-deleted` lie closed, **and the re-sync advice made to actually work** | `048ea90` |
| **M8.8.5** deleted/renamed branch | survival walk + runtime deletion tripwire; **no production change needed** | `b52f181` |
| **M8.8.8** prune survival | the pinned/unpinned pair — the control fails when the pin is removed | `cb2c5a0` |

**Gate at the tip: 2702 pass · 1 skip · 0 fail · 98 files**, under `TZ=UTC`, re-run by the orchestrator in the
main tree after every unit.

**Remaining: M8.8.6 and M8.8.7 — both app-side, and they share `reconcile-dialog.tsx`, so they run in
sequence, 6 then 7.** M8.8.6's staleness half wants M8.5.3's `listPulls` merge (a soft dependency — until then
`useStaleness` returns `null` and the banner degrades rather than blocking). **The PR is open at 6/8 on purpose.** Stacked PRs are the repo's protocol, opened every session — and a
branch without one gets no CI, because `ci.yml` triggers only on `pull_request` and pushes to `main`. §8
orders the adversarial review *before the PR*; it is not a rule that the ticket must be complete first.
The full-diff adversarial pass is still owed before this is considered done.

### The owner's rulings — 2026-08-19

Each is recorded in full at the Open question it closes; the ticket file is authoritative, this is the index.

| # | question | ruling | closes |
| --- | --- | --- | --- |
| 1 | Deleting a local review that holds an unsubmitted draft | **The server refuses** while a draft exists; the client discards explicitly, then deletes. **No contract change** — a `force` parameter on the frozen route was put as the §5.2 stop it is, and declined. | M8.10 OQ3 · M8.12 OQ1 |
| 2 | What triggers archive detection in direct mode | **On each sync of that review.** No new timer, no GitHub work on an inbox poll. | M8.9 OQ2 |
| 3 | Is the blob prune on by default | **Off, behind an explicit policy flag.** The immutable prune runs live; the blob walk ships dark. | M8.10 OQ1 |
| 4 | What bounds the pin set before retention lands | **Keep every pin.** Unbounded but correct — on the condition that **M8.10 lands in the same session as M8.8**. | M8.8 OQ4 |

**Two of these bind work beyond the ticket they were asked about, and neither is optional:**

- **Ruling 4 couples M8.8 and M8.10.** The pin set is allowed to be unbounded *only* because the garbage
  collector arrives right behind it. M8.8 shipping alone would leave a growth path with no eviction, which is
  not what was sanctioned. M8.10 is therefore in this session's scope, not the next one's.
- **Ruling 2 accepts a real gap and moves it to copy.** A branch nobody re-syncs stays un-archived
  indefinitely, so a user can keep writing local comments while a PR is already open — the confusion D1 exists
  to prevent, now bounded to the window before the next sync rather than eliminated. That is M8.9.6's banner
  problem, and it is **not** a licence to add a background tick.

**Still open and deliberately not asked** (the handover's second tier — each belongs to the session that needs
it): M8.9 OQ1 (what GitHub call feeds detection) and OQ8 (a PR against a different base); M8.8 OQ5 (throw or
report on missing objects); M8.9 OQ9. **M8.10 OQ2 — when the prune runs — is narrowed by ruling 3 but not
answered by it**, and must be settled before M8.10.6 wires a call site.

### The stack was re-linearized before M8.8 branched

#77 had drifted: it forked at `0b32368` and never picked up `048638c`, so the chain was a fork, not a line.
Rebased onto the `m8.5` tip, **re-gated under `TZ=UTC` (2646 pass · 1 skip · 0 fail · 95 files)** rather than
trusting the clean rebase, and force-pushed. `m8.8` branches from it, so the chain is one line up from `main`.

**The stack, bottom-up — nine PRs, none merged:** `main` → #69 → #70 → #71 → #72 → #73 → #74 → #75 → #76
(M8.5) → #77 (a store fix, not M8) → [#78](https://github.com/pat-mw/revu/pull/78) (M8.8, 6/8). `main` is untouched at `177068a`.

### What M8.5 delivered (in review on #76)

`revud --direct --local-only` starts in a repository with **no remotes at all**, lists its branches, creates a
review on the reserved id band, syncs it from local git, and serves the snapshot — while every GitHub-bound
route answers a typed refusal naming the missing repository. That is the milestone's headline exit criterion,
proven durably by an HTTP suite under a network tripwire **and** observed by hand. All ten units landed, two
full adversarial reviews plus a focused third pass on the riskiest change, every blocker fixed before the PR
opened. CI is green on all nine PRs.

## Tickets

**97 units across 12 tickets.** Dependencies below are the **post-review** graph — two adversarial passes over
the ticket set corrected several of them, so this table is authoritative over any earlier sketch. The unit
count grew from 74 when a test-first audit added thirteen units carrying test work that had no owner, then
from 87 when the owner's rulings appended M8.1.9 and the M8.12 ticket (2026-08-14), and from 95 as three more
units were appended rather than absorbed during implementation (M8.5.9, M8.5.10, M8.7.13, M8.8.8 — against
M8.5's and M8.8's original counts). **The table below is the authority; this sentence has drifted twice and
is derived from it, never the other way round.**

| ID | Ticket | State | Units | Surface | Depends | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [M8.1](./tickets/M8.1-contract-and-mock.md) | Contract additions + the mock as the spec | In Review | 9 | shared, app, revud | — | `m8.1/contract-and-mock` | [#70](https://github.com/pat-mw/revu/pull/70) |
| [M8.2](./tickets/M8.2-store-v4.md) | Store v4: `local_*` tables | **In Review** | 7 | revud | M8.1 | `m8.2/store-v4` | [#73](https://github.com/pat-mw/revu/pull/73) |
| [M8.3](./tickets/M8.3-local-snapshot-builder.md) | Local snapshot builder (git-only) | **In Review** | 9 | revud | M8.1 | `m8.3/local-snapshot-builder` | [#74](https://github.com/pat-mw/revu/pull/74) |
| [M8.4](./tickets/M8.4-local-write-sink.md) | Local write sink | **In Review** | 9 | revud | M8.1 | `m8.4/local-write-sink` | [#75](https://github.com/pat-mw/revu/pull/75) |
| [M8.5](./tickets/M8.5-daemon-wiring.md) | Daemon wiring: dispatch, routes, `listPulls`, boot relaxation | **In Review** | 10 | revud | M8.1, M8.2, M8.3, M8.4 | `m8.5/daemon-wiring` | [#76](https://github.com/pat-mw/revu/pull/76) |
| [M8.6](./tickets/M8.6-app-creation-flow.md) | App: creation flow + inbox surface | In Review | 7 | app | M8.1 | `m8.6/app-creation-flow` | [#71](https://github.com/pat-mw/revu/pull/71) |
| [M8.7](./tickets/M8.7-app-local-chrome.md) | App: local-mode chrome + copy correctness | In Review | 13 | app | M8.1, M8.6 | `m8.7/app-local-chrome` | [#72](https://github.com/pat-mw/revu/pull/72) |
| [M8.8](./tickets/M8.8-resync-and-pinning.md) | Re-sync, rebase safety, and object pinning | **In Review** (6/8) | 8 | revud | M8.2, M8.3, M8.5 | `m8.8/resync-and-pinning` | [#78](https://github.com/pat-mw/revu/pull/78) |
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

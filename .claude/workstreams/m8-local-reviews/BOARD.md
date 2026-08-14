# M8 board — local-only reviews

**Start here.** This file is the only one that claims to describe *right now*. It wins over any `State` row
in a ticket file; the two change in the same edit.

Workstream: [`MILESTONE.md`](./MILESTONE.md) · Handover: [`HANDOVER.md`](./HANDOVER.md) · Work log:
[`LOG.md`](./LOG.md) · Plan: [`ROADMAP.md`](./ROADMAP.md) · How sessions run:
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) · Design:
[`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md)

## In flight right now

| ticket · unit | branch | tier | isolation | what it is |
| --- | --- | --- | --- | --- |
| **M8.6.3** — the create dialog | `m8.6/app-creation-flow` | opus | worktree | W3; new files only |
| **M8.6.4** — inbox section + local row variant | `m8.6/app-creation-flow` | opus | worktree | W3; `inbox.tsx` + two new lib/page tests |
| **M8.1.9 review fixes** — the three findings from the adversarial pass | `m8.1/contract-and-mock` | fable | worktree | widens a frozen **docstring**; pins the guard's key; corrects a false sentence |

⚠️ **The review-fix agent works off `4fbc5fb` (the `m8.1` tip), not the `m8.6` tip.** When it lands, `m8.1`
gains a commit and **`m8.6` must be rebased onto the new `m8.1` tip** before its PR opens. The rebase is
mechanical — `m8.6`'s commits touch none of `types.ts`, `mock/local.ts` or `mock/local.test.ts`. A cold session
picking this up mid-flight must do that rebase before anything else.

**Landed this session, in chain order:**

| unit | commit | branch | gate at that commit |
| --- | --- | --- | --- |
| M8.1.9 — refuse submit before first sync | `4fbc5fb` | `m8.1` (pushed, on [#70](https://github.com/pat-mw/revu/pull/70)) | 1246 pass · 1 skip · 0 fail · 68 files |
| board — the owner's rulings + M8.12 + `.gitignore` | `fd525f8` | `m8.6` | — (no code) |
| M8.6.7 — the headless-render seam | `e9f2303` | `m8.6` | 1251 pass · 1 skip · 0 fail · 69 files |
| board — harness landing + wave deviations | `c494265` | `m8.6` | — (no code) |
| M8.6.1 — pure view-model | `0829a6e` | `m8.6` | 1263 pass · 1 skip · 0 fail · 70 files |
| M8.6.2 — query layer | `85e0ae4` | `m8.6` | 1269 pass · 1 skip · 0 fail · 71 files |

**Every gate above was re-run by the orchestrator in the main tree**, never trusted from a worker's isolated
one. **Worktree hazard, now in the memories and in every dispatch brief:** an isolated agent worktree is created
at the repo's **base** commit, not the branch tip, and carries no `node_modules` — two agents lost real time to
it before the brief was fixed. Any worker result produced before a fast-forward + `bun install` is void.

**Two deviations from the roadmap's S2 wave plan, both recorded with reasons.**
1. **W1 was M8.6.7 ∥ M8.7.10; it ran as M8.6.7 alone.** M8.7.10's files belong to `m8.7`, which branches off
   `m8.6` and does not exist yet — running it now means holding an uncommitted diff across all seven M8.6
   units, which is exactly the unlanded work §7 says to discard rather than archaeologize. M8.7.10 runs first
   on `m8.7` instead; it is compact and the wall-clock cost is small against the resumability risk.
2. **W2 runs with worktree isolation, which the roadmap marks "none".** Two agents sharing one tree cannot each
   run `bun run check` — the gate ends in `vite build`, and concurrent builds race on the same `dist`. The
   roadmap's "none" assumed the wave was sequenced; per-unit gating is the harder requirement, so the units are
   isolated instead. M8.6.1 additionally needs nothing from M8.6.7's shim, so it started before it landed.

**Session 2 (the app) is running.** The owner interview completed first and **decision package #1 is ruled** —
16 standing rulings in [`HANDOVER.md`](./HANDOVER.md)'s top entry. **Session 3 is therefore unblocked** and may
start concurrently on another machine.

M8.1 is still `In Review` with PR [#70](https://github.com/pat-mw/revu/pull/70) open; **its unit count is
8 → 9**. Ruling 6 (submit-before-first-sync is refused) changes the mock, and the mock is the specification, so
the change belongs inside M8.1's own Goal — appended as M8.1.9, existing units not renumbered, same precedent
as M8.1.8. #70 is unmerged, so this is an added commit rather than rewritten history, and it gets its own
fable-tier review.

_When work starts, list here exactly what is actually running — ticket, unit, branch, agent — and remove each
line the moment it lands. This section is the first thing an interrupted session re-checks._

### Session 1 record (2026-08-13)

Branch `m8.1/contract-and-mock`, based on `m8/local-reviews-design`
(PR [#69](https://github.com/pat-mw/revu/pull/69)) rather than `main`, because the board and
`docs/agent/LOCAL_REVIEWS.md` exist only on that branch; #69 carries zero files under `packages/`, so the code
diff is identical to a `main` base.

> **Merge protocol for the rest of M8 (owner, 2026-08-13): nothing merges until the whole workstream lands.**
> Every session keeps stacking — branch off the previous ticket's branch, base the PR on it, never merge,
> never retarget to `main`. `main` stays at `177068a` for the milestone, #70 stays based on #69, and
> `SESSION_PROTOCOL.md` §6's rebase-after-merge step never fires. The chain order in `ROADMAP.md` is therefore
> load-bearing for the whole milestone.

| unit | tier | commit |
| --- | --- | --- |
| M8.1.1 — id bands + disjointness proof | opus | `164b1d7` |
| M8.1.7 — route-table guard rails (landed **before** the widening) | opus | `0d2c1b0` |
| M8.1.2 — wire types, validators, ref-name validator | fable | `d0d1ce8` |
| M8.1.3 — mock local-review engine (the oracle, D6) | fable | `e60f9da` |
| M8.1.4 — the contract extension (one atomic commit) | opus | `5bb5e82` |
| M8.1.8 — local-id dispatch in the mock adapter (**appended unit**) | opus | `0aeb75a` |
| M8.1.6 — scenario walk + the three frozen semantics on a local id | opus | `992a220` |
| M8.1.5 — fixture local review reachable under `?mock=1` | opus | `bf13759` |
| review fixes — vacuous guard closed; migration clamp; two edges pinned | opus ×2 | `fea7a15`, `c41ddba` |
| Spike B — throwaway `tsc` probe of `DirectContext.github` typed-absent | sonnet (worktree) | not committed by design; finding in HANDOVER |

**Unit count 7 → 8.** M8.1.4 found the engine unreachable through the contract — `requireRemote()` throws
`not_found` for a local id at five call sites, so M8.1.6's walk was unsatisfiable as written. M8.1.8 was
appended (never renumbering existing units) and ran **before** M8.1.5 and M8.1.6. It sits inside this ticket's
own Goal, so it is an appended unit rather than §5.8 scope growth.

**Two deliberate deviations from the roadmap's Session 1 plan, both recorded with reasons.**
1. **W4 was M8.1.5 ∥ M8.1.6; it became W4 = M8.1.8 alone, then W5 = M8.1.5 ∥ M8.1.6.** M8.1.5 and M8.1.8 have
   disjoint *files* but a real **semantic** overlap — both decide how a local review reaches `listPulls`
   (D-a) — and running them concurrently is how the same review ends up listed by two mechanisms, the "two
   truths" hazard D-c names. Sequencing them is what surfaced the conflict: M8.1.8's single-path ruling
   **superseded M8.1.5's ticket text**, which said the fixture is registered in `fixtureDB.pulls`.
2. **M8.1.5's tier raised sonnet → opus.** The roadmap scoped it as mechanical fixture wiring; M8.1.8's ruling
   turned it into a design-constrained unit that also had to move two hardcoded pins without loosening them.

**Gate green after every unit**, never batched: 1181 → 1193 → 1201 → 1219 → 1230 → 1240 → **1245 pass · 1 skip
· 0 fail · 68 files**, `bun run check` exit 0 each time. Verify: `conformance:matrix` exit 0 (`[A]`+`[B]`
required legs PASS), `suite.ts` diff **0 lines**, both invariant tests **0 lines**. Additionally
`bun run test:e2e` exit 0 in real Chrome. **Frozen contract additive: `client.ts` +39/-0, `types.ts` +93/-1,
`http.ts` +27/-1 — both deletions are docstring lines that were factually wrong.**

**The §8 adversarial review found a real defect**: the anti-neuter guard on the pinned route table was
vacuous, so the four newest routes were deletable with every guard green — and a ruling recorded in the ticket
Log was false. Fixed in `fea7a15` with deletion controls as its acceptance. Full triage of all eight findings
is in the ticket `## Log` and `HANDOVER.md`.

_When work starts, list here exactly what is actually running — ticket, unit, branch, agent — and remove each
line the moment it lands. This section is the first thing an interrupted session re-checks._

## Tickets

**91 units across 12 tickets.** Dependencies below are the **post-review** graph — two adversarial passes over
the ticket set corrected several of them, so this table is authoritative over any earlier sketch. The unit
count grew from 74 when a test-first audit added thirteen units carrying test work that had no owner, then
from 87 when the owner's rulings appended M8.1.9 and the M8.12 ticket (2026-08-14).

| ID | Ticket | State | Units | Surface | Depends | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [M8.1](./tickets/M8.1-contract-and-mock.md) | Contract additions + the mock as the spec | In Review | 9 | shared, app, revud | — | `m8.1/contract-and-mock` | [#70](https://github.com/pat-mw/revu/pull/70) |
| [M8.2](./tickets/M8.2-store-v4.md) | Store v4: `local_*` tables | Todo | 7 | revud | M8.1 | `m8.2/store-v4` | — |
| [M8.3](./tickets/M8.3-local-snapshot-builder.md) | Local snapshot builder (git-only) | Todo | 9 | revud | M8.1 | `m8.3/local-snapshot-builder` | — |
| [M8.4](./tickets/M8.4-local-write-sink.md) | Local write sink | Todo | 9 | revud | M8.1 | `m8.4/local-write-sink` | — |
| [M8.5](./tickets/M8.5-daemon-wiring.md) | Daemon wiring: dispatch, routes, `listPulls`, boot relaxation | Todo | 8 | revud | M8.1, M8.2, M8.3, M8.4 | `m8.5/daemon-wiring` | — |
| [M8.6](./tickets/M8.6-app-creation-flow.md) | App: creation flow + inbox surface | In Progress | 7 | app | M8.1 | `m8.6/app-creation-flow` | — |
| [M8.7](./tickets/M8.7-app-local-chrome.md) | App: local-mode chrome + copy correctness | Todo | 10 | app | M8.1, M8.6 | `m8.7/app-local-chrome` | — |
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
- A ticket goes `In Review` when its PR is open, `Done` only when **its `Verify` has actually run green**.
- Units are `M8.x.n` inside each ticket file, numbered in default execution order. Append-only — never
  renumber; new units continue the sequence.
- Branch names carry the M-ID. A unit gets its own branch only if it ships as its own PR in a stack.
- The full protocol is [`../README.md`](../README.md).

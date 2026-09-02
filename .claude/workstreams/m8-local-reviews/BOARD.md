# M8 board — local-only reviews

**Start here.** This file is the only one that claims to describe *right now*. It wins over any `State` row
in a ticket file; the two change in the same edit.

Workstream: [`MILESTONE.md`](./MILESTONE.md) · Handover: [`HANDOVER.md`](./HANDOVER.md) · Work log:
[`LOG.md`](./LOG.md) · Plan: [`ROADMAP.md`](./ROADMAP.md) · How sessions run:
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) · Design:
[`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md)

## In flight right now

**Nothing is running.** Five tickets are In Review, all gated, reviewed and pushed. **No Todo ticket remains in
M8**; the milestone closes when the chain merges.

| ticket | state | branch / PR | gate |
| --- | --- | --- | --- |
| **M8.8** re-sync, rebase safety, object pinning | In Review, 8/8, **`Verify` green**, adversarial pass done | `m8.8/resync-and-pinning` · [#78](https://github.com/pat-mw/revu/pull/78) | 2741 · 1 · 0 · 100, **CI green** |
| **M8.10** retention and GC | In Review, **8/8, `Verify` green** | `m8.10/retention-and-gc` · [#79](https://github.com/pat-mw/revu/pull/79) | 2919 · 1 · 0 · 103, **CI green** |
| **M8.11** conformance leg, e2e, docs | In Review, **8/8, `Verify` green**, adversarial pass done | `m8.11/conformance-e2e-docs` · [#80](https://github.com/pat-mw/revu/pull/80) | 2998 · 1 · 0 · 111, **CI green** (check · conformance-matrix · e2e · docs-build) |
| **M8.9** archive when a PR appears | In Review, **8/8, `Verify` run**, adversarial pass done (five findings landed) | `m8.9/archive-on-pr` · [#82](https://github.com/pat-mw/revu/pull/82) | 3276 · 1 · 0 · 116, matrix A/B/E/F/G PASS, e2e ×2 PASSED, **CI green** (check · conformance-matrix · e2e · docs-build) |
| **M8.12** delete confirmation | In Review, **3/3, `Verify` green**, adversarial pass done (one blocker + six findings landed) | `m8.12/delete-confirm` · [#83](https://github.com/pat-mw/revu/pull/83) | 3348 · 1 · 0 · 117, **CI pending at hand-off** |

**M8.12 lands the delete affordance** (in review on #83): the app had no way to delete a local review at all,
so the ticket built the action, the mutation and the confirmation from nothing under the no-force ruling —
confirm discards the reader's own draft through the draft store's own path, then repeats the same delete. Its
adversarial review found a blocker the tests had not: a *failed* discard still dropped the cached draft, which
is the editing surface, so an outage erased an edit whose save had failed in the same outage. Fixed with a
result that reports whether a discard happened and a cache rule that drops the draft only after one that
succeeded; six honesty holes (whose draft is in the way, a discard followed by a failed delete, the synthetic
id inside the refusal sentence in both producers, a race with a pending save, "nothing was deleted" after
something was) landed with it.

**M8.9 lands D1** (in review on #82): a local review is archived on the sync that finds an open pull request
on its branch pair — read-only through the write sink's own port, frozen at its last successful sync, linked
from a banner, badged in the inbox, and never copied anywhere. The predicate is **shared** so the mock (the
spec) and the daemon run one code path; a **three-transport conformance block** (M8.9.8, appended) pins the
archived semantics on E/F/G. The `?mock=1` walk found the one defect the unit tests could not — the sync
mutation refreshed nothing the archive changes, so the page stayed live until a reload — fixed with a
mode-gated refresh, and the adversarial review found five more (a malformed pull number 500-ing a sync, a
review left half-archived when git failed after the mark, a case-sensitive repo compare, the bar rerouting an
archived draft's verdict, a one-column pin that only saw `updated_at`), all landed before the PR opened.
Decisions recorded at the ticket's open questions: targeted `state=open` query, `pull.state` stays `closed`
and the inbox learns it, a derived link, no archive on a different base, freeze. Two pre-existing contract
facts surfaced by the block and pinned, not changed: `createLocalReview` answers `headSha: null` everywhere,
and `RevuApi.listPulls` / `DirectApi.listPulls` take different shapes (the router bridges them).

**M8.11 closes the milestone's proof** (in review on #80): the local-review conformance suite, written once,
runs as three **required** matrix legs (E mock in-process · F revud-mock over HTTP · G the direct engine over a
remote-less seeded repo under a `fetch` tripwire); a browser e2e creates and submits a local review against a
direct daemon with a preload that records and refuses every non-loopback `fetch`, its netlog opening with the
guard's own marker; the docs describe the flow, the switch and the audit boundary, with two guards putting those
surfaces in the gate. **Every one of the six exit criteria now has a green run on the stack tip** (the walk is
at the ticket's Verify 7); the boxes in `MILESTONE.md` tick when the chain merges. Two things worth reading
before building on it: leg G was the first runner to execute the suite's `'changes'` branch and **found the
suite wrong** (binary blobs are stored collapsed, as the mock's own fixtures store them — the suite was fixed,
not the engine); and the adversarial review found four holes (a duplicate reply id accepted, a reaction rollup
never re-read, a mock restart over the same memory, a guide describing an archive detector that does not
exist), each fixed with its own control. **Follow-ups, recorded here rather than as tickets:** `scripts/` is
still outside `tsc -b` (the smoke rot found this session is the measured cost — `parseCommentIdentity` had
grown a required parameter and two identity checks were asserting against the bot); `Bun.fetch` is a distinct
reference the netlog guard does not wrap (inert today).

**M8.10 is now genuinely done**, not merely at full unit count. `M8.10.8` closed the gap that 7/7 had
hidden: the owner's ruling 1 was unimplemented in **both** transports, and the mock and direct disagreed
about whether a delete destroys unsubmitted text and about a repeated delete. **All three had survived the
gate because `deleteLocalReview` had no conformance coverage at all.** It now has a three-transport parity
leg — in-process mock, mock over real HTTP, and the direct engine on a real repository — which is what
stops the class recurring rather than this instance.

**The lesson, now twice-proven on this milestone: a unit percentage is not a done ticket.** Before calling
one complete, check that every ruling recorded at an Open question has a unit that implements it, and that
every contract method it touches has a conformance leg.

### One recorded deviation in M8.10's `Verify`

`Verify` says no file under `packages/shared/src/api/` may be modified. One was: `client.ts`'s
`deleteLocalReview` docstring said drafts are "deliberately left behind — user-written text is never
destroyed", which the owner's ruling made false in both transports. The prose was corrected; **no type,
shape, field or signature moved.** The full reasoning is at the ticket's `Verify` section. Splitting it into
its own contract commit is one command if the owner prefers.

### The owner's rulings — 2026-08-19

Each is recorded in full at the Open question it closes; the ticket file is authoritative, this is the index.

| # | question | ruling | closes |
| --- | --- | --- | --- |
| 1 | Deleting a local review that holds an unsubmitted draft | **The server refuses** while a draft exists; the client discards explicitly, then deletes. **No contract change** — a `force` parameter on the frozen route was put as the §5.2 stop it is, and declined. | M8.10 OQ3 · M8.12 OQ1 |
| 2 | What triggers archive detection in direct mode | **On each sync of that review.** No new timer, no GitHub work on an inbox poll. | M8.9 OQ2 |
| 3 | Is the blob prune on by default | **Off, behind an explicit policy flag.** The immutable prune runs live; the blob walk ships dark. | M8.10 OQ1 |
| 4 | What bounds the pin set before retention lands | **Keep every pin.** Unbounded but correct — on the condition that **M8.10 lands in the same session as M8.8**. | M8.8 OQ4 |
| 5 | When the retention prune runs (2026-08-20) | **After every successful local sync** — the tightest growth bound, pruning where the churn is created. M8.10.7's gate spends the in-flight-sync objection. **M8.10.6's Check must drive it at a real sync**, not by calling the prune directly. | M8.10 OQ2 |

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
report on missing objects); M8.9 OQ9.

**M8.10 is now unblocked on both of its holds.** OQ2 is ruling 5 above. **OQ4 — id reuse vs a high-water
mark, which held the whole ticket — resolved from the repo, not the owner:** M8.2 shipped the high-water
mark (`store.ts:1621`, `local_review_id_high_water`, whose own doc at `:1605-1619` spells out that it is
"not `MAX(id) + 1`" precisely because that would re-issue a deleted review's id). The id-reuse class is
unreachable, so M8.10 may start.

### The stack was re-linearized before M8.8 branched

#77 had drifted: it forked at `0b32368` and never picked up `048638c`, so the chain was a fork, not a line.
Rebased onto the `m8.5` tip, **re-gated under `TZ=UTC` (2646 pass · 1 skip · 0 fail · 95 files)** rather than
trusting the clean rebase, and force-pushed. `m8.8` branches from it, so the chain is one line up from `main`.

**The stack, bottom-up — fourteen PRs, none merged** (#82 M8.9 and #83 M8.12 now sit above #80): `main` → #69 → #70 → #71 → #72 → #73 → #74 → #75 → #76
(M8.5) → #77 (a store fix, not M8) → [#78](https://github.com/pat-mw/revu/pull/78) (M8.8, 8/8) →
[#79](https://github.com/pat-mw/revu/pull/79) (M8.10, 8/8) → [#80](https://github.com/pat-mw/revu/pull/80)
(M8.11, 8/8). `main` is untouched at `177068a`.

### What M8.5 delivered (in review on #76)

`revud --direct --local-only` starts in a repository with **no remotes at all**, lists its branches, creates a
review on the reserved id band, syncs it from local git, and serves the snapshot — while every GitHub-bound
route answers a typed refusal naming the missing repository. That is the milestone's headline exit criterion,
proven durably by an HTTP suite under a network tripwire **and** observed by hand. All ten units landed, two
full adversarial reviews plus a focused third pass on the riskiest change, every blocker fixed before the PR
opened. CI is green on all nine PRs.

## Tickets

**99 units across 12 tickets** (M8.10.8 was appended at integration when a recorded owner ruling turned out to have no unit; M8.9.8 was appended for the same reason in reverse — archive changes what four contract methods mean, and a method without a parity leg is how a ruling goes unimplemented). Dependencies below are the **post-review** graph — two adversarial passes over
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
| [M8.8](./tickets/M8.8-resync-and-pinning.md) | Re-sync, rebase safety, and object pinning | **In Review** (8/8, `Verify` green) | 8 | revud, app | M8.2, M8.3, M8.5 | `m8.8/resync-and-pinning` | [#78](https://github.com/pat-mw/revu/pull/78) |
| [M8.9](./tickets/M8.9-archive-on-pr.md) | Archive when a PR appears | **In Review** (8/8, `Verify` run) | 8 | revud, app, shared | M8.4, M8.5, M8.6, M8.7 | `m8.9/archive-on-pr` | [#82](https://github.com/pat-mw/revu/pull/82) |
| [M8.10](./tickets/M8.10-retention-and-gc.md) | Retention and GC | **In Review** (4/7) | 7 | revud | M8.2, M8.5 | `m8.10/retention-and-gc` | [#79](https://github.com/pat-mw/revu/pull/79) |
| [M8.11](./tickets/M8.11-conformance-e2e-docs.md) | Conformance leg, e2e, and docs | **In Review** (8/8, `Verify` green) | 8 | all | M8.5, M8.6, M8.7, M8.8, M8.9, M8.10 | `m8.11/conformance-e2e-docs` | [#80](https://github.com/pat-mw/revu/pull/80) |
| [M8.12](./tickets/M8.12-delete-confirm.md) | Delete confirmation for a review holding a draft | **In Review** (3/3, `Verify` green) | 3 | app | M8.6, M8.10 | `m8.12/delete-confirm` | [#83](https://github.com/pat-mw/revu/pull/83) |

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
gap in the plan, not a gap in the work. **As of 2026-09-02 every row below has a green run on the stack tip
(#80)** — the walk is recorded at M8.11's Verify 7; the milestone closes when the chain merges.

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

# M8 — handover

Cross-session handover. **Newest at the top** — the first entry is the live one. Written so a cold agent can
act from it alone.

---

## 2026-08-12 — planned; ready to start Session 1

**State: clean.** `main` unchanged at `177068a`. Branch `m8/local-reviews-design`, PR
[#69](https://github.com/pat-mw/revu/pull/69) — docs + board only, gate green, awaiting human merge. Nothing
in flight, no implementation started.

**The workstream is fully planned.** [`ROADMAP.md`](./ROADMAP.md) is the execution plan;
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) is how sessions behave. Both were produced adversarially — the
roadmap by a three-way judge panel (max-parallelism vs stack-linear vs risk-first; stack-linear won
unanimously) then verified unit-by-unit against the real tickets: **every unit placed exactly once, zero invented ids,
every wave's file-disjointness checked against the tickets' own Files lines.**

**Five sessions, one linear chain:** `main → m8.1 → m8.6 → m8.7 → m8.2 → m8.3 → m8.4 → m8.5 → m8.8 → m8.10 →
m8.9 → m8.11`. S1 the spec · S2 the app · S3 the daemon core · S4 the join + hardening · S5 archive + the
proof. **S2 and S3 are genuinely concurrent** (zero shared files — `packages/app` vs `packages/revud`), so on
two machines serial depth is 4. A ticket's PR opens the moment its Verify goes green, mid-session, never
batched — that is what keeps a dead session's handover small.

**Test-first, verified.** A later audit pass took the ticket set from 74 to **87 units**: 67 Checks were
strengthened from one-time observations into durable assertions, 13 units were added for test work that had no
owner, and every ticket now carries a `## Testing exceptions` section naming what genuinely cannot be asserted.
The doctrine is `SESSION_PROTOCOL.md` §4 — test first and observed RED, guards before the code they guard,
negative controls for any assertion of absence. Two residuals worth knowing: wiring pins prove a call site is
present but not that it executes, and break-observe-revert controls are enforced by the Log requirement rather
than by CI — **a green Check with no logged red is unproven.**

**Start here: Session 1 — the spec** ([M8.1](./tickets/M8.1-contract-and-mock.md), 7 units + a spike). It is the fork point for S2 and S3, and the frozen-contract extension must be proven before 60+
units conform to it (D6). Its exit condition and wave plan are in `ROADMAP.md` → Session 1; a ready-to-paste
session prompt is in [`PROMPTS.md`](./PROMPTS.md).

**What S1 owes the human on completion:** decision package #1 — M8.5 OQ1 (how local-only is switched on),
M8.8 OQ2 (whether the commit-delta rewrite lands on the shipped GitHub PR path), M8.10 OQ1–OQ3 (blob-prune
defaults), and M8.2 OQ1's behavioral half. S3 ends blocked on those rulings, so S1's handover must state them
with a recommendation each.

**Decisions, hazards, and board hygiene:** unchanged from the entry below — read it too.

---

## 2026-08-12 — designed and seeded; no implementation started

**State: clean.** `main` is unchanged at `177068a`. One PR open: [#69](https://github.com/pat-mw/revu/pull/69)
— docs only, `bun run check` green, awaiting human merge. Working branch `m8/local-reviews-design`. Nothing
uncommitted, nothing in flight.

### What exists

| artifact | where |
| --- | --- |
| The design — surface map, 8 decisions, 26 edge cases | `docs/agent/LOCAL_REVIEWS.md` |
| Ticket seed text M8.1–M8.11 | `docs/agent/MILESTONES.md` → `## Milestone M8` |
| The board (**tracking source of truth**) | `.claude/workstreams/m8-local-reviews/` |
| Linear | milestone only — **its tickets could not be created** |

### ⚠️ Tracking is local now, not Linear

The Uzo Linear workspace is at its **free issue cap**: `save_issue` returns `You've exceeded the free issue
limit for this workspace`. Milestones, comments and status updates still write; **issues and sub-issues do
not.** So this workstream runs on the file board in `.claude/workstreams/`. Read
[`BOARD.md`](./BOARD.md) first — it is the only file that claims to describe right now. The protocol is
[`../README.md`](../README.md).

Do not attempt to seed M8 into Linear without first confirming the cap has been raised; a session already
burned eleven failed `save_issue` calls discovering this.

### The design in one paragraph

Very little of revu is actually about GitHub, which is what makes this cheap. `anchor.ts` is pure — its whole
input surface is a pending comment, a file list, a blob index, and a `resolveBlobLines(sha)` callback, all
derivable from `git diff --raw` / `git cat-file`. `reconcile.ts` never sees a client, a repo ref, or a token.
`blobs.ts` is already local-git-first. The two-half `compareKey` cache is provenance-blind. **Only 6 of 21
`RevuApi` methods touch GitHub.** So M8 is **one new snapshot producer + one new write sink**, not a parallel
application — and "re-sync after new commits" falls out of the existing cache for free, needing no new route.
The git side is not a downgrade either: `git diff --raw -M` yields both sides' blob SHAs, statuses and renames
in one command, with no 3000-file cap and no truncatable tree.

### Decisions not to relitigate

D1–D8, in [`MILESTONE.md`](./MILESTONE.md), full rationale in the design doc. The two most load-bearing:

- **D2/D4 — the identity is split across layers on purpose.** The reserved band (`>= 1e9`) identifies a local
  review at the **contract** level, which is what keeps `RevuApi`, all 21 routes, both routers' `n > 0` gates,
  the validators, `/pr/:n`, the two `/^\/pr\/(\d+)/` path regexes, and every React Query key unchanged. It must
  **never** be written to `snapshots.pr_number`, `audit_log.pr`, or `pr_author.pr` — the host collector and
  poll loop read those as real PR numbers. The store gets its own `local_*` tables.
- **D7 — the local write path has no GitHub client in scope.** Structural, not conditional, asserted by a test
  that fails if one is introduced. This is what makes "local comments never reach the client repo" a property
  of the code's shape rather than of a branch someone could mis-take.

### Hazards the next session must not walk into

1. **Rebase + `git gc`** — a rebase makes every SHA in a draft unreachable at once; `store.getBlob → null`
   degrades to `lost/line-deleted`, so **a rebase that changed nothing in a file can mass-classify every
   comment on it as lost, purely from missing objects.** New-commit detection then falls to the author-date
   heuristic, which **under-reports silently** (a rebase rewrites committer date, preserves author date).
   Owned by M8.8: pin objects under `refs/revu/reviews/<id>/<compareKey>`.
2. **Zero eviction exists in the store today** — the only `DELETE` is `deleteDraft`, no TTL anywhere. A
   rebased local branch orphans an immutable half on every sync. Owned by M8.10, which would be the first
   `DELETE` this store ever grows.

Two pre-existing bugs to inherit knowingly rather than reproduce: the optimistic reply path stamps
unconditionally (rendering `**Name** (role)` as literal body text when `botLogin === ''`), and a
reconcile-apply ending in `conflict` never updates `draft.headSha`, so the *next* reconcile counts new commits
from a stale head.

### Board hygiene — needs a human call

Two Linear issues sit **In Progress** but do not look in flight: **UZO-617** (M6.3 — Coder template wiring),
whose work appears shipped (image v23 rolled to all three workspaces), and **UZO-575** (M3.1 — Scratch App +
org), which the doc marks *deferred*. Left untouched rather than guessed at — a ticket only moves to Done when
its Verify has actually run green.

### Next

1. Human merges [#69](https://github.com/pat-mw/revu/pull/69) and the board PR.
2. Start **M8.1** — it is the spec (D6) and gates every other ticket. Read its ticket file; it carries its
   units, its Verify, and verified code anchors.
3. Then fan out: daemon core (M8.2 / M8.3 / M8.4, mutually independent → M8.5), app (M8.6 / M8.7, which need
   only the mock and never wait on revud), hardening (M8.8 after M8.3, M8.10 after M8.2). M8.11 closes.

Still open from before this workstream and unrelated to it: `pr_author` has no writer in production
(UZO-968), so every PR reports `authorHumanId: null` live; and `docs/security-review.md` is out of date, its
threat model predating the hostile-PR-commenter work. M8.11 adds a third item to that doc's backlog.

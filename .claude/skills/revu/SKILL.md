---
name: revu
description: Project session harness for revu — a self-hosted, shared-identity PR review client for contractors in disposable cloud workspaces (plus a local-first direct mode). THE harness — START EVERY revu session here. Use when asked to work on, continue, resume, kick off, plan, build, or pick up revu. Tracking (workstreams, tickets, updates, cross-session handovers) lives in the LOCAL BOARD at .claude/workstreams/ — Linear is capped and cannot hold new tickets. Reference docs + memories stay in the repo. It orients from the board + the repo and records progress back to the board in a self-learning loop.
---

# revu — session harness

Operating manual for **any** agent working on **revu** (a self-hosted, shared-identity PR review client for contractors in disposable cloud workspaces, plus a local-first direct mode), in **any** harness. Read it at the **start of every session** and follow the loop. **The local board (`.claude/workstreams/`) is the source of truth for *tracking*** — workstreams, tickets, progress, handovers; the **repo is the source of truth for *code and reference docs***.

> **Tracking moved out of Linear.** The Uzo workspace hit its **free issue cap**: `save_issue` fails with `You've exceeded the free issue limit for this workspace`, so tickets and sub-issues **cannot be created**. Milestones, comments and status updates still write. Everything from **M8** onward is tracked in files; **MT–M7 remain in Linear** as the historical record and are still worth reading. Do not try to seed a new workstream into Linear without first confirming the cap has been raised — a session already burned eleven failed calls discovering this. Full protocol: **[`.claude/workstreams/README.md`](../../workstreams/README.md)**.

- **App / entry point:** index.html — Vite React 18 SPA, mock-driven design prototype (M0.1 restructures to Bun workspaces: packages/app · packages/revud · packages/shared)
- **Code source of truth:** the repo (https://github.com/pat-mw/revu).
- **Reference docs (read to answer questions):** `docs/` — stay in the repo, versioned with code. The integration plan is `docs/agent/INTEGRATION_GUIDE.md`; the milestone/ticket source is `docs/agent/MILESTONES.md`; design system + agent conventions are root `DESIGN.md` + `AGENTS.md`.
- **Memories (durable recurring knowledge):** `.claude/skills/revu/memories/` — **read all of them every session.**
- **Tracking source of truth:** the **local board** → `.claude/workstreams/` (protocol: [`README.md`](../../workstreams/README.md); active workstream: `m8-local-reviews/`).
- **Historical tracking (read-only):** the Linear **revu** project → https://linear.app/uzo/project/revu-553eaefcab18 (team **Uzo**, prefix `UZO-`) — MT–M7 live there; it can still be *read*, commented on, and given status updates, but **no new issue can be created**.

## The mapping
| concept | where it lives | notes |
| --- | --- | --- |
| The repo (revu) | the repo | one repo = the whole project |
| A **workstream** (a milestone from docs/agent/MILESTONES.md — MT, M0–M8 — a phase with its own exit criteria) | `workstreams/<id>-<slug>/MILESTONE.md` | the kickoff: goal, exit criteria, decisions, depends, status |
| The **live view** — what exists, what is in flight | `workstreams/<id>-<slug>/BOARD.md` | **start every session here**; it is the only file claiming to describe *now* |
| A **ticket** (one per MILESTONES.md issue ID, e.g. `M8.3`, ideally one PR each) | `…/tickets/<ID>-<slug>.md` | header table carries state · surface · kind · depends · blocks · branch · PR |
| A **unit** (one resumable chunk: ~one commit / one focused block) | a `### <ID>.n` section in its ticket file | each with **Do / Files / Check** — the resume points |
| Per-ticket progress | the ticket's `## Log` + its `State` row | Backlog · Todo · In Progress · In Review · Done |
| Workstream log entry | `…/LOG.md` | append oldest-first, **newest last** |
| Cross-session **handover** | `…/HANDOVER.md` | **newest at the top** — the first entry is what you read first |
| Reference docs / memories | repo files (`docs/`, `memories/`) | unchanged |

**Labels** (the `Surface` / `Kind` rows): revu:app · revu:revud · revu:broker · revu:shared + Feature · Improvement · Bug · Chore · Infra · Docs · Research · Security. **States:** Backlog · Todo · In Progress · In Review · Done (+ Canceled). Same vocabulary as the Linear labels and states, so migrating back if the cap is raised is mechanical.

Reading MT–M7 history still needs the Linear MCP, whose tools are **deferred** — load schemas with `ToolSearch select:…` before calling, and see **[LINEAR_PROTOCOL.md](./LINEAR_PROTOCOL.md)** for the recipes. Its *write* recipes for issues no longer work.

## The session loop
1. **Orient** — read repo **memories** → **`BOARD.md`** for the active workstream (what exists, what is in flight) → the top entry of **`HANDOVER.md`** → **`MILESTONE.md`** → the **ticket files** you are about to touch → the relevant repo **docs**.
2. **Work** — do the task, grounded in what you read. **Decompose before you build** (next section), **parallelize independent units aggressively**, and keep the board honest as you go — In Progress mirrors exactly what is actually in flight, so the board must *always* let a cold session resume without you. Under ultracode, the main thread orchestrates rather than implements — see "Orchestration & delegation".
3. **Record** — to the **board**: move ticket/unit states, append to the ticket's `## Log`, append a `LOG.md` entry, and **prepend** a `HANDOVER.md` entry. To the **repo**: update affected docs in `docs/` and write a **memory** for durable learnings.

### Orient (the exact reads)
- `.claude/workstreams/<active>/BOARD.md` — the ticket table, the **In flight right now** section, the dependency graph. First read, always.
- `.claude/workstreams/<active>/HANDOVER.md` — **the top entry is your handover; act from it.**
- `.claude/workstreams/<active>/MILESTONE.md` — goal, exit criteria, the decision table.
- The ticket files for whatever you are picking up — each carries its units, its `Verify`, and verified `path/file.ts:line` seams.
- `git status` + `gh pr list` — the board claims a state; the repo proves it. Reconcile any disagreement before working.

### Record (the exact writes)
- **Ticket:** update the `State` row, append `**YYYY-MM-DD** — what changed, files, gate result` to its `## Log`, fill in the `PR` row when one opens.
- **Board:** update the same ticket's row and the **In flight right now** section in `BOARD.md`, in the *same* edit. `BOARD.md` wins on conflict.
- **Workstream:** append a `LOG.md` entry (Done / Decisions / Blockers / Next).
- **Handover:** **prepend** a `HANDOVER.md` entry — state, what exists, decisions not to relitigate, hazards, next. **Always end a session with this**; it is the single most important record.
- Board edits ride the work PR that caused them. A session ending with no work PR opens a small `board/<topic>` PR — committing directly to `main` stays forbidden.

## Decomposing a ticket (resumability — the core discipline)

The board is the resume point: at **any** interruption, the next session must be able to continue from board state alone. Every ticket file is already decomposed into numbered units (`Mx.y.n`), each one resumable — one coherent change with a concrete **Check**, roughly one commit or one focused working block.

**On picking up a ticket:**
1. Set the ticket's `Assignee` and `State: In Progress` in its header table, and mirror it in `BOARD.md`'s ticket row and **In flight right now** section.
2. Read its units. **Decompose further where appropriate**: if a unit turns out to span more than one resumable chunk — or the work reveals steps the plan didn't — split it or append new numbered units *before* writing code. Genuinely atomic tickets need no further decomposition; don't decompose ceremonially.
3. Work the units respecting their dependencies — the numbering is the *default execution order*, not a serialization mandate: independent units can (and under ultracode should) run in parallel via delegated agents. A unit goes in flight when dispatched; when its **Check** passes, append the outcome (what changed, files, gate result) to the ticket's `## Log` and tick it. **In flight = actually running — nothing more, nothing less.** That set is the first thing an interrupted session re-checks on resume.
4. The ticket moves `In Review` when the PR is up, `Done` only when **all units are done and the ticket's `Verify` has actually run green**.

**Numbering:** new units continue the ticket's sequence (`M8.3.5`, `M8.3.6`, …) in execution order; never renumber existing ones (their ids are referenced in logs, branches, and commits). If new work changes the plan's shape, say so in the ticket's `## Log` — the numbers carry order, the log carries why.

## Orchestration & delegation (ultracode sessions)

Sessions here usually run under **ultracode** conventions. When that's true, the main thread is an **orchestrator, not an implementer**: its job is to orient, decompose, dispatch, integrate, verify, and record — preserving its own context for a long-running session. Subagents and workflows do the heavy lifting; the main thread writes code inline only for trivial one-file touches.

**How to dispatch**
- **One milestone is active at a time; within it, parallelize everything possible.** Before dispatching, sketch the dependency graph across the open tickets' units, then fan out every independent unit — and independent tickets, e.g. the whole M1 punch list — as a wave. Serialize only where a real dependency forces it: shared files, a contract one unit produces for another, a stacked branch. Waves of delegated work are what make implementation fast; when in doubt, err toward more parallelism — the orchestrator's judgement decides, but the default is fan out.
- The `Mx.y.n` unit numbering doubles as the dispatch plan: one unit = one delegable task with its own Verify. The numbers carry the *default* order; the dependency graph decides what actually runs concurrently. Use a **Workflow** for fan-outs (several units at once, review panels, migrations, sweeps) and a single **Agent** for one-off delegations. Parallel agents that mutate files need disjoint file sets or worktree isolation; stacked PRs (see "Git practices") let parallel tracks keep landing without waiting on merges.
- Every delegation brief carries: the unit's what/why + its **Verify**; the relevant `docs/agent/INTEGRATION_GUIDE.md` sections; whichever hard constraints from `memories/hard-constraints.md` touch the unit; and the `AGENTS.md` rules — including *comments/docstrings never reference tickets, phases, agents, or tracking artifacts*.
- Workers return conclusions and diffs, not file dumps — the orchestrator never pulls large file contents into its own context. The **orchestrator owns all board writes** (the board has one writer, or two agents race on `BOARD.md`); workers own code but **never commit** — see "Git practices".
- Integrate + run the gate after each unit lands, not just at PR time.

**Model tiers — pick the cheapest tier that can do the unit well.** This is what gets through the work fast without burning credits; delegating everything to the top tier is as wrong as doing everything inline:
- **`sonnet` — trivial/mechanical:** doc updates, renames, config/plumbing, boilerplate tests from a written spec, fixture wiring, pattern-following refactors, board verification sweeps.
- **`opus` — hard:** substantive implementation units, multi-file refactors, nontrivial debugging, integration work — most of the sync engine, stores, and adapter code.
- **`fable` (the default/inherit tier) — reserved:** complex cross-cutting design work, anything **security-critical** (token custody, stamping, audit log, identity, workspace→broker auth), and **adversarial reviews / verification panels**.
- **Escalate on failure:** if a tier fails its unit's Verify, retry once at the next tier up rather than looping at the same tier; if the top tier fails, stop and surface to the human.
- Security-critical or contract-touching changes get an adversarial `fable`-tier review before merge, regardless of who wrote them.

When a session is *not* running ultracode, the loop is unchanged — inline implementation is fine, and the tiers still apply to whatever you do delegate.

## Git practices

- **Only the orchestrator commits.** Workers return diffs and changed files; the orchestrator reviews, integrates, runs the gate, and commits. One committer means coherent history and no racing writers.
- **Committing directly to `main` is forbidden.** Every change lands on a branch and reaches `main` only through a PR. The **human merges** — never merge to `main` yourself.
- **Git state never blocks implementation.** Branching is the standard; never sit idle waiting for a review or merge. When ticket B depends on unmerged ticket A, **stack the PRs**: branch B off A's branch and open B's PR with A's branch as its base. The human merges down from the base up at their convenience; when a base merges, rebase the rest of the stack onto the new base and retarget its PR.
- **Branch naming carries the M-ID:** `m2.3/rest-reads` for a ticket; a unit gets its own branch (`m2.3.4/…`) only when it ships as its own PR in a stack. One ticket ↔ one PR stays the norm; when a ticket ships as a stack of unit PRs, record each PR in the ticket file's `PR` row and its `## Log` as it opens.
- **The handover records the stack:** which PRs are open, their base order, and what is waiting on which merge — so the next session (and the human) can see the whole train at a glance.

## Verification (TDD — no supervision, no deployment)

revu is built test-first: an agent must be able to verify its own code locally, with no human supervision and no external deployment. Milestone **MT** establishes the gate; from then on:
- **Every code change lands with its tests** (unit for pure logic, integration for adapters/HTTP, e2e for flows once MT.4 exists).
- **The local gate must be green before any PR**: `bun run check` (once MT.2 lands; until then: `bun run lint` · `bun run build` · `bun test`).
- **CI (GitHub Actions, free on the public repo) runs the same gate** on every push/PR — a red check blocks merge. Never merge red; never skip the gate to "save time".
- Every ticket's **Verify** section is its acceptance test — run it (or write it, then run it) before moving the ticket to Done. `Verify` is what is *additional* to the gate, which is assumed on every ticket.

## Starting a new workstream

A **workstream** (a MILESTONES.md milestone — a phase with its own exit criteria) is a coherent stream of work with its own goal and scope spanning several tickets/sessions. A single unit of work toward an *existing* goal is a **ticket** in the active workstream (or a **unit** of one), not a new workstream. MT and M0–M8 already exist — a *new* workstream only appears if scope genuinely grows beyond the doc, and **`docs/agent/MILESTONES.md` must be updated in the same PR** (doc and board never drift). Don't proliferate workstreams.

To kick one off:
1. `mkdir .claude/workstreams/<id>-<slug>/tickets` and write **`MILESTONE.md`** — the kickoff: Goal · Exit criteria (checklist, each naming the ticket that proves it) · Depends · Decisions · **Status: ACTIVE**.
2. **Seed its tickets** — one file per deliverable under `tickets/`, each decomposed into `Mx.y.n` units with **Do / Files / Check**, plus `Verify`, verified `path/file.ts:line` seams, binding constraints, landmines, and open questions.
3. Write **`BOARD.md`** (ticket table · **In flight right now** · dependency graph · exit-criteria coverage), an empty **`LOG.md`**, and a first **`HANDOVER.md`** entry.
4. **Mirror it into `docs/agent/MILESTONES.md`** in the same PR — that doc is the format the board is built from, and the two must never drift.
5. Capture any direction-setting decision as a repo memory / docs entry.

(Shape and rules: [`.claude/workstreams/README.md`](../../workstreams/README.md).)

## Templates
**`MILESTONE.md` (= kickoff):** Goal · Exit criteria (checklist) · Depends · Decisions · Status.
**`LOG.md` entry (= work-log update):** `**update — YYYY-MM-DD**` then Done / Decisions / Blockers / Next.
**`HANDOVER.md` entry (= handover):** state (branch, PRs open, anything uncommitted) · what exists and where · **which ticket/unit is in flight and what's next** · decisions not to relitigate · hazards · blockers — written so a cold agent can act from it alone. Newest at the top.

## Conventions & gotchas
- **Use the stable M-IDs** (`M8.3`, and unit ids `M8.3.4`) in branch names and commit messages — that is how cross-session context survives.
- **`BOARD.md` wins.** A ticket's `State` row and `BOARD.md` must agree and change in the same edit; if they disagree, `BOARD.md` is right.
- **The board claims a state; the repo proves it.** Reconcile `BOARD.md` against `git status` and `gh pr list` at orient time, before working.
- **Reading MT–M7 history needs the Linear MCP:** load schemas first (deferred tools); status reads use `orderBy:"createdAt"` (the default `updatedAt` mis-sorts an edited handover); milestone comments need the milestone UUID (`list_milestones` first); `list_issues` has no milestone filter; real newlines in bodies, never `\n`. **`save_issue` is dead** — the free issue cap.
- **Secrets never go in the board.** It is more exposed than Linear, not less. **Code/reference docs stay in `docs/`** — the board is admin tracking, not documentation, and `.claude/` is stripped for open-source release.
- **Don't close a workstream with unchecked exit criteria** — they're in `MILESTONE.md`, copied from `docs/agent/MILESTONES.md`.

## Running it (reference)
- **Run:** `bun install && bun run dev`
- **Verify (the gate):** `bun run check` once MT.2 lands; until then `bun run build` (tsc -b + vite build) · `bun run lint` (oxlint) · `bun run scripts/smoke.ts` (headless fixture smoke, becomes `bun test` in MT.1)

## Current status
The live status lives on the board, not here. Read **`.claude/workstreams/<active>/BOARD.md`**, then the top entry of that workstream's **`HANDOVER.md`** — together they are the authoritative, always-current picture. The workstream's full history is its `LOG.md`.

The active workstream is **`m8-local-reviews`** (local-only pre-PR branch review). MT–M7 history lives in the Linear project (read-only).

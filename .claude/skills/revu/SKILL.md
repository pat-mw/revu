---
name: revu
description: Linear-first project session harness for revu — a self-hosted, shared-identity PR review client for contractors in disposable cloud workspaces (plus a local-first direct mode). THE harness — START EVERY revu session here. Use when asked to work on, continue, resume, kick off, plan, build, or pick up revu. Tracking (workstreams, tickets, updates, cross-session handovers) lives in the Linear "revu" project — milestones = workstreams, issues = tickets, project status updates = handover. Reference docs + memories stay in the repo (hybrid). It orients from Linear + the repo and records progress back to Linear in a self-learning loop.
---

# revu — Linear-first session harness

Operating manual for **any** agent working on **revu** (a self-hosted, shared-identity PR review client for contractors in disposable cloud workspaces, plus a local-first direct mode), in **any** harness. Read it at the **start of every session** and follow the loop. **Linear is the source of truth for *tracking*** (workstreams, tickets, progress, handovers) so a human sees legible progress at a glance; the **repo is the source of truth for *code and reference docs***.

- **App / entry point:** index.html — Vite React 18 SPA, mock-driven design prototype (M0.1 restructures to Bun workspaces: packages/app · packages/revud · packages/shared)
- **Code source of truth:** the repo (https://github.com/pat-mw/revu).
- **Reference docs (read to answer questions):** `docs/` — stay in the repo, versioned with code. The integration plan is `docs/agent/INTEGRATION_GUIDE.md`; the milestone/ticket source is `docs/agent/MILESTONES.md`; design system + agent conventions are root `DESIGN.md` + `AGENTS.md`.
- **Memories (durable recurring knowledge):** `.claude/skills/revu/memories/` — **read all of them every session.**
- **Tracking source of truth:** the Linear **revu** project → https://linear.app/uzo/project/revu-553eaefcab18 (team **Uzo**, issue prefix `UZO-`).

## The mapping
| concept | Linear primitive | notes |
| --- | --- | --- |
| The repo (revu) | **Project** `revu` | one project = the whole repo |
| A **workstream** (a milestone from docs/agent/MILESTONES.md — MT, M0–M6 — a phase with its own exit criteria) | **Milestone** | description = kickoff; comments = the work log |
| A **ticket** (one issue per MILESTONES.md issue ID, e.g. `M2.3`, ideally one PR each) | **Issue** in that milestone | link the PR |
| A **unit** (one resumable chunk of a ticket: ~one commit / one focused block) | **Sub-issue** `Mx.y.n — …`, numbered in execution order | the resume points |
| Per-ticket progress | issue **comments** + **state** | Backlog · Todo · In Progress · In Review · Done |
| Workstream log entry | **comment on the milestone** | post oldest-first |
| Cross-session **handover** | **project status update** (health) | the *latest* one is what you read first |
| Reference docs / memories | **repo files** (+ key ones mirrored as Project Documents) | hybrid |

**Labels:** revu:app · revu:revud · revu:broker · revu:shared (surface) + Feature · Improvement · Bug · Chore · Infra · Docs · Research · Security (team kinds). **States:** Backlog · Todo · In Progress · In Review · Done (+ Duplicate · Canceled).

The Linear MCP tools are **deferred** — load schemas with `ToolSearch select:…` before calling. Exact recipes for every operation are in **[LINEAR_PROTOCOL.md](./LINEAR_PROTOCOL.md)** — open it whenever you read from or write to Linear.

## The session loop
1. **Orient** — read repo **memories** → read the relevant repo **docs** → pull the **active workstream from Linear** (its milestone, open issues, recent comments) → read the **latest project status update** (the handover).
2. **Work** — do the task, grounded in what you read. **Decompose before you build** (next section), **parallelize independent units aggressively**, and keep the board honest as you go — In Progress mirrors exactly what is actually in flight, so the board must *always* let a cold session resume without you. Under ultracode, the main thread orchestrates rather than implements — see "Orchestration & delegation".
3. **Record** — to **Linear**: move issue states, comment ticket progress, append a **milestone comment** (the work-log entry), and post a **project status update** as the handover. To the **repo**: update affected docs in `docs/` and write a **memory** for durable learnings.

### Orient (the exact reads)
- `get_project("revu", includeMilestones:true)` + `list_milestones("revu")` — workstreams + completion %.
- Active workstream: read its description (kickoff) + `list_comments(milestoneId:…)` (the log).
- `list_issues(project:"revu", state:"In Progress")` (and `Todo`/`In Review`) — what's in flight. (No milestone filter exists; list by project and group.)
- `get_status_updates(type:"project", project:"revu", orderBy:"createdAt")` — **the top update is your handover; start there.**

### Record (the exact writes)
See LINEAR_PROTOCOL.md. The essentials: `save_issue(id, state)` + `save_comment(issueId)` per ticket; `save_comment(milestoneId)` for the work-log entry (resolve the milestone UUID via `list_milestones` first); and **always** end a session with `save_status_update(type:"project", project:"revu", health, body)` — that handover is the single most important record.

## Decomposing a ticket (resumability — the core discipline)

The board is the resume point: at **any** interruption, the next session must be able to continue from Linear state alone. The seed board is already decomposed to numbered sub-issues (`Mx.y.n`), each one resumable unit of work — one coherent change with a concrete completion check, roughly one commit or one focused working block.

**On picking up a ticket:**
1. Assign yourself (`assignee:"me"`), move the parent to In Progress.
2. Read its sub-issues. **Decompose further where appropriate**: if a sub-issue turns out to span more than one resumable unit — or the work reveals steps the plan didn't — split it or append new numbered subs *before* writing code. Genuinely atomic tickets need no subs; don't decompose ceremonially.
3. Work the units respecting their dependencies — the numbering is the *default execution order*, not a serialization mandate: independent units can (and under ultracode should) run in parallel via delegated agents. A unit goes In Progress when dispatched; when its check passes, comment the outcome (what changed, files, gate result) and mark it Done. **In Progress = actually in flight — nothing more, nothing less.** That set is the first thing an interrupted session re-checks on resume.
4. The parent moves In Review when the PR is up, Done only when **all subs are Done and the parent's Verify has actually run green**.

**Numbering:** new subs continue the parent's sequence (`M2.3.5`, `M2.3.6`, …) in execution order; never renumber existing ones (their IDs are referenced in comments/commits). If new work changes the plan's shape, say so in an issue comment — the numbers carry order, the comments carry why.

## Orchestration & delegation (ultracode sessions)

Sessions here usually run under **ultracode** conventions. When that's true, the main thread is an **orchestrator, not an implementer**: its job is to orient, decompose, dispatch, integrate, verify, and record — preserving its own context for a long-running session. Subagents and workflows do the heavy lifting; the main thread writes code inline only for trivial one-file touches.

**How to dispatch**
- **One milestone is active at a time; within it, parallelize everything possible.** Before dispatching, sketch the dependency graph across the open tickets' units, then fan out every independent unit — and independent tickets, e.g. the whole M1 punch list — as a wave. Serialize only where a real dependency forces it: shared files, a contract one unit produces for another, a stacked branch. Waves of delegated work are what make implementation fast; when in doubt, err toward more parallelism — the orchestrator's judgement decides, but the default is fan out.
- The `Mx.y.n` unit numbering doubles as the dispatch plan: one unit = one delegable task with its own Verify. The numbers carry the *default* order; the dependency graph decides what actually runs concurrently. Use a **Workflow** for fan-outs (several units at once, review panels, migrations, sweeps) and a single **Agent** for one-off delegations. Parallel agents that mutate files need disjoint file sets or worktree isolation; stacked PRs (see "Git practices") let parallel tracks keep landing without waiting on merges.
- Every delegation brief carries: the unit's what/why + its **Verify**; the relevant `docs/agent/INTEGRATION_GUIDE.md` sections; whichever hard constraints from `memories/hard-constraints.md` touch the unit; and the `AGENTS.md` rules — including *comments/docstrings never reference tickets, phases, agents, or tracking artifacts*.
- Workers return conclusions and diffs, not file dumps — the orchestrator never pulls large file contents into its own context. The **orchestrator owns all Linear writes** (the board has one writer); workers own code but **never commit** — see "Git practices".
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
- **Branch naming carries the M-ID:** `m2.3/rest-reads` for a ticket; a unit gets its own branch (`m2.3.4/…`) only when it ships as its own PR in a stack. One ticket ↔ one PR stays the norm; when a ticket ships as a stack of unit PRs, link each PR on the Linear issue as it opens.
- **The handover records the stack:** which PRs are open, their base order, and what is waiting on which merge — so the next session (and the human) can see the whole train at a glance.

## Verification (TDD — no supervision, no deployment)

revu is built test-first: an agent must be able to verify its own code locally, with no human supervision and no external deployment. Milestone **MT** establishes the gate; from then on:
- **Every code change lands with its tests** (unit for pure logic, integration for adapters/HTTP, e2e for flows once MT.4 exists).
- **The local gate must be green before any PR**: `bun run check` (once MT.2 lands; until then: `bun run lint` · `bun run build` · `bun test`).
- **CI (GitHub Actions, free on the public repo) runs the same gate** on every push/PR — a red check blocks merge. Never merge red; never skip the gate to "save time".
- Every issue's **Verify** section is its acceptance test — run it (or write it, then run it) before moving the issue to Done.

## Starting a new workstream

A **workstream** (a MILESTONES.md milestone — a phase with its own exit criteria) is a coherent stream of work with its own goal and scope spanning several tickets/sessions — it becomes a **Milestone**. A single unit of work toward an *existing* goal is a **ticket** in the active milestone (or a **sub-issue** of one), not a new workstream. MT and M0–M6 are already seeded from the doc — a *new* workstream only appears if scope genuinely grows beyond the doc, and **`docs/agent/MILESTONES.md` must be updated in the same PR** (doc and board never drift). Don't proliferate milestones.

To kick one off:
1. `save_milestone(project:"revu", name, description, targetDate)` — name **≤ 80 chars**; `description` = the kickoff (Goal / Exit criteria / Depends / **Status: ACTIVE**).
2. **Seed its tickets** — `save_issue(… milestone:<name>, state:"Todo")` per deliverable, decomposed into `Mx.y.n` sub-issues.
3. **Make it the focus** — post a `save_status_update` noting the new workstream + health.
4. Capture any direction-setting decision as a repo memory / docs entry.

(Recipe in LINEAR_PROTOCOL.md → "New workstream".)

## Templates
**Milestone description (= kickoff):** Goal · Exit criteria (checklist) · Depends · Status.
**Milestone comment (= work-log update):** `**update — YYYY-MM-DD**` then Done / Decisions / Blockers / Next.
**Project status update (= handover):** health + what shipped (PRs, if any) · current branch/state · **which unit (`Mx.y.n`) is in flight and what's next** · blockers — written so a cold agent can act from it alone.

## Conventions & gotchas
- **Use the stable M-IDs** (`M2.3`, and unit IDs `M2.3.4`) in branch names and commit messages — that is how cross-session context survives in Linear.
- **Load schemas first** (deferred MCP tools). **Milestone names ≤ 80 chars.** **Milestone comments need the milestone UUID** (`list_milestones` first). **Status reads use `orderBy:"createdAt"`** (the default `updatedAt` mis-sorts an edited handover). **Real newlines** in Markdown bodies, never `\n`. **`createdAt` = now** — historical dates go in the text.
- **No Initiatives via MCP** (UI-only even when paid) → `Project = repo`; "convert milestone → project" is the escape hatch if a workstream outgrows a milestone.
- **Secrets never go into Linear.** **Code/reference docs stay in the repo** — don't migrate `docs/` or memories into Linear; they're versioned, greppable, and cheap to load each session.
- **Don't close a milestone with unchecked exit criteria** — they're in the milestone description, copied from `docs/agent/MILESTONES.md`.

## Running it (reference)
- **Run:** `bun install && bun run dev`
- **Verify (the gate):** `bun run check` once MT.2 lands; until then `bun run build` (tsc -b + vite build) · `bun run lint` (oxlint) · `bun run scripts/smoke.ts` (headless fixture smoke, becomes `bun test` in MT.1)

## Current status
The live status lives in Linear, not here. Read the **latest project status update** on revu (https://linear.app/uzo/project/revu-553eaefcab18) — it is the authoritative, always-current handover. Full history is in the project's milestones.

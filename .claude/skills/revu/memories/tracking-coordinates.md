# Tracking coordinates & structure decisions

**Tracking lives in the repo now, not Linear.** The Uzo workspace hit its **free issue cap** — `save_issue`
fails with `You've exceeded the free issue limit for this workspace`, so **no issue or sub-issue can be
created**. `save_milestone`, `save_comment` and `save_status_update` still work. Discovered 2026-08-12 while
seeding M8, after eleven failed calls; don't rediscover it.

- **The board:** `.claude/workstreams/` — protocol in its `README.md`; one folder per workstream
  (`<id>-<slug>/`) holding `MILESTONE.md` (kickoff), `BOARD.md` (**the live view — read first**),
  `HANDOVER.md` (newest at top), `LOG.md` (newest last), and `tickets/<ID>-<slug>.md`.
- **Active workstream:** `m8-local-reviews` — local-only pre-PR branch review. Design:
  `docs/agent/LOCAL_REVIEWS.md`. Seed text: `docs/agent/MILESTONES.md` → `## Milestone M8`.
- **Mapping:** workstream = `MILESTONE.md` · ticket = a file under `tickets/` (one PR each) · unit = a
  `### Mx.y.n` section inside a ticket, with **Do / Files / Check** · per-ticket progress = the ticket's
  `## Log` + its `State` row · workstream log = `LOG.md` · cross-session handover = `HANDOVER.md`.
- **States:** Backlog · Todo · In Progress · In Review · Done (+ Canceled). **Labels** (header-table rows):
  `revu:app` · `revu:revud` · `revu:broker` · `revu:shared` (surface) + Feature · Improvement · Bug · Chore ·
  Infra · Docs · Research · Security (kind). Deliberately the same vocabulary as the Linear labels and states,
  so migrating back if the cap is raised is mechanical.
- **`BOARD.md` wins.** A ticket's `State` row and `BOARD.md` must agree and change in the *same* edit. The
  board claims a state; `git status` + `gh pr list` prove it — reconcile at orient time before working.
- **Board edits ride a PR**, like everything else; committing directly to `main` stays forbidden. They travel
  on the work PR that caused them; a session ending with no work PR opens a small `board/<topic>` PR.
- **Orchestrator owns all board writes** — one writer, or two agents race on `BOARD.md`.
- **Resumability discipline:** *In flight* mirrors exactly what is actually running — parallel dispatch marks
  several units at once, never more than is truly running. One workstream active at a time; within it,
  independent units/tickets are parallelized aggressively. Log each unit's outcome as it closes; new units
  continue the numbering, never renumber. The board must always let a cold session resume alone.
- **The doc and the board must not drift:** `docs/agent/MILESTONES.md` is the format the board is built from —
  if scope changes, update the doc and the board in the same PR/session.
- **The board is admin tracking, not documentation.** It is stripped for open-source release with the rest of
  `.claude/` (M7.7). Durable technical content belongs in `docs/`. Secrets never go in it — it is more exposed
  than Linear, not less.

## Linear — historical record, read-only

- **Team:** Uzo (prefix `UZO-`), shared with other projects (e.g. SkillHub) — never rename team-level
  labels/states. **Project:** `revu` → https://linear.app/uzo/project/revu-553eaefcab18 (lead: Patrick MW).
- **MT–M7 live there** and are still worth reading: milestone descriptions carry Goal / Exit criteria /
  Depends; issue descriptions carry the doc's **Verify** and a `Source:` line; project status updates carry
  the handover history through 2026-08-12. Board seeded 2026-07-17 from `docs/agent/MILESTONES.md`.
- **M8's milestone exists in Linear but its tickets do not** — the cap. It carries an index and the dependency
  graph as a comment, pointing here.
- MCP gotchas that still apply to reads: tools are deferred (load schemas first); status reads need
  `orderBy:"createdAt"` (the default `updatedAt` mis-sorts an edited handover); milestone comments need the
  milestone **UUID** (`list_milestones` first); `list_issues` has no milestone filter; real newlines in
  bodies, never `\n`; milestone names ≤ 80 chars. **No Initiatives via MCP** (UI-only even when paid).
- **Session harness:** `.claude/skills/revu/` (skill name `revu`); memories in `.claude/skills/revu/memories/`.

# LINEAR_PROTOCOL.md — operating the revu project via the Linear MCP

Exact tool recipes for the `revu` harness. Read the section for whatever you're about to do. All tools are **deferred** — load schemas with `ToolSearch` (`select:<name>,<name>`) before the first call in a session. The illustrative arg names below are not authoritative — the loaded schema is; if an example arg is rejected, use the schema's field name.

## Coordinates
- **Team:** `Uzo` (issue prefix `UZO-`).
- **Project:** `revu` — https://linear.app/uzo/project/revu-553eaefcab18 . Refer to it by the name `"revu"` in every call.
- **Milestones:** `MT — TDD foundation (local + CI test gate)` and `M0 — Transport seam` (active, issues Todo) · M1–M6 (queued, issues Backlog).
- **Labels:** revu:app · revu:revud · revu:broker · revu:shared (surface) + Feature · Improvement · Bug · Chore · Infra · Docs · Research · Security (kind). **States:** Backlog · Todo · In Progress · In Review · Done (+ Duplicate · Canceled).
- **Change requests:** PR (ref sigil `#`), base https://github.com/pat-mw/revu/pull/ .
- **The repo (revu) = the Project. A workstream = a Milestone. A ticket = an Issue. A resumable unit = a numbered Sub-issue (`Mx.y.n`). A handover = a Project status update.**

## Load the schemas
```
# orient (read)
ToolSearch select:mcp__linear-server__get_project,mcp__linear-server__list_milestones,mcp__linear-server__list_issues,mcp__linear-server__list_comments,mcp__linear-server__get_status_updates,mcp__linear-server__get_issue
# record (write)
ToolSearch select:mcp__linear-server__save_issue,mcp__linear-server__save_comment,mcp__linear-server__save_milestone,mcp__linear-server__save_status_update,mcp__linear-server__save_document
```

## ORIENT — read the live state
1. `get_project(query:"revu", includeMilestones:true, includeResources:true)` → description, milestone list + completion %, Project Documents.
2. `list_milestones(project:"revu")` → milestone names **and UUIDs** (you need a UUID to comment on one).
3. Active workstream log: `list_comments(milestoneId:"<uuid>")` (oldest→newest).
4. In-flight: `list_issues(project:"revu", state:"In Progress")` (repeat for `Todo`/`In Review`). **There is no milestone filter on `list_issues`** — list by project and group, or open the milestone in the UI. Single issue: `get_issue("UZO-123")`; children: `list_issues(parentId:"UZO-123")`.
5. Handover: `get_status_updates(type:"project", project:"revu", orderBy:"createdAt")` → **newest first; read the top one before doing anything.** (Pass `orderBy:"createdAt"` — the default `updatedAt` floats an edited old update to the top.)

## RECORD — write progress

### New workstream (milestone)
**When:** a new coherent stream of work with its own goal/scope spanning several tickets — *not* a single task (that's an issue in the active milestone). MT + M0–M6 are already seeded from `docs/agent/MILESTONES.md`; a new one means scope grew beyond the doc — update the doc in the same PR. After creating it, seed its issues and post a status update so it becomes the focus. See SKILL.md → "Starting a new workstream".
```
save_milestone(project:"revu", name:"<Workstream Title — ≤ 80 chars>",
  description:"<kickoff — Goal / Exit criteria / Depends / Status>", targetDate:"YYYY-MM-DD")
```

### New ticket (issue)
```
save_issue(team:"Uzo", project:"revu", milestone:"<Workstream Title>",
  title:"<Mx.y — imperative, concise>", description:"<what/why; a **Verify:** section; source line>",
  state:"Todo", labels:[...], assignee:"me",
  links:[{ url:"https://github.com/pat-mw/revu/pull/<N>", title:"PR #<N>" }])   # links once a PR exists
```
Returns the identifier (e.g. `UZO-42`). Use it for all later updates.

### Decompose a ticket into units (on pickup, where appropriate)
Sub-issues are the resume points: one resumable unit each (~one commit / one focused block, with a concrete completion check), titled `Mx.y.n — <imperative>` and numbered in **execution order**. The seed board is already decomposed — deepen it when a sub spans more than one unit or work reveals unplanned steps, *before* writing code. New subs continue the sequence (`M2.3.5`, `M2.3.6`, …); **never renumber existing ones**.
```
list_issues(parentId:"UZO-587")                       # see existing units + numbering first
save_issue(team:"Uzo", project:"revu", milestone:"<same as parent>", parentId:"UZO-587",
  title:"M2.3.5 — <unit>", state:"<parent's pre-work state>", labels:<parent's labels>,
  description:"<what/why; **Verify:** line; Source: docs/agent/MILESTONES.md → Issue M2.3>")
```
Genuinely atomic tickets stay undecomposed — don't add ceremony.

### Progress a ticket (In Progress = actually in flight)
```
save_issue(id:"UZO-587", state:"In Progress", assignee:"me")   # pick up the parent
save_issue(id:"UZO-641", state:"In Progress")                  # dispatch unit M2.3.1 — mark EVERY unit actually in flight
                                                               # (parallel dispatch = several In Progress at once; never more than is truly running)
save_comment(issueId:"UZO-641", body:"<what changed; files; gate result>")
save_issue(id:"UZO-641", state:"Done")                         # unit's check passed
# … next unit / next wave …
save_issue(id:"UZO-587", state:"In Review")                    # PR up
save_issue(id:"UZO-587", state:"Done")                         # merged — all units Done AND the parent's Verify ran green
```

### Work-log entry (milestone comment)
`save_comment` needs the milestone **UUID**, not its name:
```
list_milestones(project:"revu")   # find the milestone by name → take .id
save_comment(milestoneId:"<uuid>",
  body:"**update — YYYY-MM-DD**\n\n- **Done:** …\n- **Decisions:** …\n- **Blockers:** …\n- **Next:** …")
```
(Shown with `\n` for brevity — **use literal newlines in the real call.**)

### Handover (project status update)
```
save_status_update(type:"project", project:"revu", health:"onTrack",
  body:"<what shipped (PRs, if any) · current branch/state · which unit (Mx.y.n) is in flight · the next concrete step · blockers>")
```
The first thing the next session reads. `health`: `onTrack` / `atRisk` / `offTrack`.

### Close a workstream
Every exit criterion in the milestone description checked → set its issues `Done` → final milestone comment summarising the outcome → a project status update. The milestone hits 100% automatically.

### Mirror a durable doc (optional, human-requested)
```
save_document(project:"revu", title:"<e.g. Decisions (mirror)>", content:"<markdown or a link to the repo doc>")
```
Keep these to **stable, durable** references only; the repo docs in `docs/` remain authoritative.

## Gotchas
- **Deferred tools:** `ToolSearch select:…` before use (an empty result = MCP not connected).
- **Milestone names ≤ 80 chars** — longer makes `save_milestone` fail.
- **Milestone comments → UUID only** (`list_milestones` first).
- **Status reads use `orderBy:"createdAt"`** — default `updatedAt` mis-sorts an edited handover.
- **`list_issues` has no milestone filter** — list by project and group; it *does* filter by `parentId`.
- **Real newlines** in Markdown bodies; never `\n`.
- **Timestamps are "now"** — historical dates live in the text; use milestone `targetDate` for the timeline.
- **No Initiatives via MCP** (UI-only even when paid) → `Project = repo`; escape hatch = "convert milestone → project".
- **`save_issue`:** omit `id` to create, pass `id` to update; `assignee` (not `assigneeId`) takes a name/email/`me`; sub-issues = `parentId` (one level deep only — no sub-sub-issues).
- **Labels/states by name** resolve server-side — use revu's actual sets (above).
- **Idempotency:** `list_*` before bulk-creating — no upsert.
- **Secrets never enter Linear.**

# The local board — tracking revu workstreams in the repo

**This is the tracking source of truth while Linear is unavailable.** The Uzo Linear workspace is at its free
issue cap: `save_issue` fails with `You've exceeded the free issue limit for this workspace`, so tickets and
sub-issues **cannot be created**. Rather than run a workstream with no board, tracking lives here, in files,
versioned with the code.

The trade is deliberate: Linear gave a human a glanceable board; files give a cold agent something greppable
that can never drift from the commit that changed it. The primitives are unchanged — only the storage moved,
so nothing about the session loop has to be relearned.

## Mapping

| Linear primitive | here | notes |
| --- | --- | --- |
| Project | the repo | unchanged |
| Milestone (a workstream) | `<id>-<slug>/MILESTONE.md` | the kickoff: goal, exit criteria, decisions, depends, status |
| Issue (a ticket) | `<id>-<slug>/tickets/<ID>-<slug>.md` | one file per ticket, one PR each |
| Sub-issue (a unit) | a `### <ID>.n` section inside its ticket file | the resume points |
| Issue state | the `State` row of the ticket's header table | mirrored in `BOARD.md` |
| Issue comments | the ticket file's `## Log` | append-only, newest last |
| Milestone comments (the work log) | `<id>-<slug>/LOG.md` | append-only, newest last |
| Project status update (the handover) | `<id>-<slug>/HANDOVER.md` | **newest at the top** |
| Labels | the `Surface` / `Kind` rows of the header table | same vocabulary as the Linear labels |
| The board view | `<id>-<slug>/BOARD.md` | the ticket index + what is in flight |

**States:** `Backlog` · `Todo` · `In Progress` · `In Review` · `Done` (+ `Canceled`) — the same five, so a
later migration back to Linear is mechanical.

## Layout

```
.claude/workstreams/
  README.md                    # this file — the protocol
  m8-local-reviews/
    MILESTONE.md               # the kickoff
    BOARD.md                   # the index + what is in flight  ← START HERE
    HANDOVER.md                # cross-session handover, newest at top
    LOG.md                     # the workstream work log, newest last
    tickets/
      M8.1-contract-and-mock.md
      …
```

## The session loop, restated for the local board

**Orient** — read, in this order: `BOARD.md` (what exists, what is in flight) → `HANDOVER.md` (the top entry
is the live handover) → `MILESTONE.md` (goal + exit criteria) → the ticket files you are about to touch. Then
the repo memories and the design doc the milestone names. `BOARD.md` first is not a style preference: it is
the only file that claims to describe *right now*.

**Work** — one ticket at a time per agent; independent tickets and units fan out in parallel. A unit moves to
`In Progress` **when it is actually dispatched**, and the ticket's `## Log` gets its outcome when its Check
passes. `In Progress` means in flight — nothing more, nothing less.

**Record** — update the ticket's `State` and `## Log`, update `BOARD.md` in the same edit, append a `LOG.md`
entry for the workstream, and **prepend** a `HANDOVER.md` entry. The handover is the single most important
record: write it so a cold agent can act from it alone.

## Rules

1. **`BOARD.md` wins.** A ticket's header `State` and `BOARD.md` must agree, and they change in the same edit.
   If they ever disagree, `BOARD.md` is right and the ticket header is stale.
2. **`In Progress` is the truth about right now.** Never mark a ticket or unit in flight speculatively; never
   leave one marked in flight after it lands. That set is the first thing an interrupted session re-checks.
3. **Board changes ride a PR, like everything else.** Committing directly to `main` stays forbidden. Board
   edits travel on the work PR that caused them; a session that ends with no work PR to carry them opens a
   small `board/<topic>` PR of its own.
4. **Numbering is append-only.** New units continue their ticket's sequence (`M8.3.5`, `M8.3.6`, …) in
   execution order. Never renumber — the ids are referenced in commits, branches, and logs. If the plan's
   shape changes, say so in the ticket's `## Log`; the numbers carry order, the log carries why.
5. **A ticket is `Done` only when its `## Verify` has actually been run green** — not when its units look
   finished. The gate (`bun run check`) is assumed on every ticket; `Verify` is what is *additional* to it.
6. **Don't close a workstream with unchecked exit criteria.** They live in `MILESTONE.md`.
7. **Secrets never go in here.** Same rule as Linear; this tree is more exposed, not less.
8. **This tree is admin tracking, not documentation.** It is stripped for open-source release along with the
   rest of `.claude/`. Durable technical content belongs in `docs/`, not here.

## Ticket file shape

Header table (`State` · `Surface` · `Kind` · `Depends` · `Blocks` · `Branch` · `PR` · `Assignee`), then:
`Goal` · `Units` (each with **Do** / **Files** / **Check**) · `Verify` · `Context — verified seams` ·
`Constraints that bind this ticket` · `Landmines` · `Open questions` · `Log`.

`Context — verified seams` is the section that makes a cold pickup possible: real `path/file.ts:line` anchors,
each verified by opening the file. A wrong anchor is worse than no anchor — it sends the next agent to the
wrong place with false confidence.

## Going back to Linear

If the issue cap is raised, the mapping table above is the migration: one issue per ticket file, one sub-issue
per `### <ID>.n`, the ticket `## Log` as issue comments, `LOG.md` as milestone comments, `HANDOVER.md`'s top
entry as a project status update. Migrate or don't — but do not run both, and record which one is live in
`memories/linear-coordinates.md`.

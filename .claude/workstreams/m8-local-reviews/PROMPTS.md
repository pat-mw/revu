# Session prompts

Ready-to-paste kickoff prompts for M8 sessions. Each is deliberately short on *content* and heavy on
*pointers*: the session's first job is to read the board, and a prompt that restates the plan competes with
the plan. [`ROADMAP.md`](./ROADMAP.md) is the authority on what a session does;
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) on how it behaves.

**Before pasting any of these:** check `BOARD.md`'s **In flight right now** section is empty and the previous
session's PRs are merged (or are the base of this one's chain). If a previous session stopped early, read the
top of `HANDOVER.md` first — it may have changed what the next session should do.

---

## Session 1 — The spec (M8.1)

```
ultracode /revu

Run Session 1 of the M8 workstream, unsupervised. I'm away — do not wait for me.

Orient first, in this order, and do not skip any of it:
  .claude/workstreams/m8-local-reviews/BOARD.md          (live state — In flight must be empty)
  .claude/workstreams/m8-local-reviews/HANDOVER.md       (top entry)
  .claude/workstreams/m8-local-reviews/ROADMAP.md        → "Session 1 — The spec"
  .claude/workstreams/m8-local-reviews/SESSION_PROTOCOL.md  (how you operate; it is settled)
  .claude/workstreams/m8-local-reviews/tickets/M8.1-contract-and-mock.md  (all of it)
  .claude/skills/revu/memories/                          (all of them)
Tracking is the local board, NOT Linear — Linear's issue cap is why. Don't try to write issues there.

Scope: M8.1 only, plus Spike B. Four waves, exact units and tiers in ROADMAP.md → Session 1 → Waves.
Do not start M8.2/M8.3/M8.4/M8.6/M8.7 — they are later sessions and they fork off this one.

M8.1 is the SPEC (decision D6): the mock's semantics ARE the contract, and 60+ later units conform to
whatever lands here. Treat every judgement call in it as load-bearing rather than local.

You orchestrate; you do not implement. Delegate every unit, cheapest tier that can do it well, one retry at
the next tier up on failure and then stop. Run the gate after every unit, not at PR time. Fable-tier
adversarial review of the full diff before the PR opens.

Finish by: opening the m8.1 PR off main (never merge, never commit to main); updating the ticket's State and
Log and BOARD.md in the same edit; appending a LOG.md entry; and prepending a HANDOVER.md entry that carries
Spike B's finding and decision package #1 — M8.5 OQ1, M8.8 OQ2, M8.10 OQ1-OQ3, and M8.2 OQ1's behavioral
half — each with your recommendation, because Session 3 ends blocked on my rulings.

Stop and hand over rather than deciding if you hit any SESSION_PROTOCOL §5 condition. Stopping cleanly with a
precise handover is a success; guessing is not. Write the handover before the work looks finished.
```

---

## Sessions 2 and 3 — concurrent

S2 (`packages/app`) and S3 (`packages/revud`) share zero files and can run **at the same time on two
machines**. Whichever finishes second splices both lanes into the chain before opening its PRs. On one
machine, run S2 first — it is the shorter lane and it settles the app surface that S4/S5 later append to.

Use the Session 1 prompt with these substitutions: the session number and name, the ticket files to read, and
the closing paragraph's handover requirements (each session's are in `ROADMAP.md` under that session's
**Integration** and **Exit condition**). Keep every other line — the orient order, the orchestrate-don't-
implement rule, the gate cadence, the review requirement, and the stop-and-hand-over instruction are constant.

**S3 additionally must end with decision package #2 requested** — it stops on the rulings S1 raised, so its
handover has to state what it could not proceed past and what it recommends.

---

## Session 2b — finish M8.7 (the app's chrome)

Session 2 paused at a unit boundary for context, not on a stop condition. M8.6 is complete and in review;
M8.7 is **6 of 12 units** in, on a pushed branch with no PR.

```
ultracode /revu

Finish M8.7 — Session 2 paused at a unit boundary and this session closes it out. I'm away; do not wait for me.

Orient first, in this order, and do not skip any of it:
  .claude/workstreams/m8-local-reviews/BOARD.md          (live state — In flight must be empty)
  .claude/workstreams/m8-local-reviews/HANDOVER.md       (top entry — read ALL of it; it opens with "Start here")
  .claude/workstreams/m8-local-reviews/SESSION_PROTOCOL.md
  .claude/workstreams/m8-local-reviews/tickets/M8.7-app-local-chrome.md   (all of it — Rulings, Wave plan,
                                                                           Context, Landmines, Log)
  .claude/skills/revu/memories/                          (all of them)

Start on branch `m8.7/app-local-chrome` (pushed). Run `bun run check` before dispatching anything — expect
1440 pass · 1 skip · 0 fail · 81 files. The 1 skip is pre-existing.

DO the remaining units in this order, one at a time: M8.7.5 → M8.7.6 → M8.7.8 → M8.7.7, plus the two appended
units M8.7.11 and M8.7.12. Then M8.7's Verify, a fable-tier adversarial review of the FULL diff, and the PR on
base `m8.6`.

They are serial by FILE CONTENTION, not by dependency — `lib/mode-copy.ts` has five writers, `lib/review-mode.ts`
four, `pr-layout.tsx` three. The reasoning is in the ticket's "## Wave plan as actually run". Do not re-derive
it and do not restore the roadmap's parallel table: it assumes the orchestrator can merge two workers' versions
of one file, and integration here is by copying whole files out of isolated worktrees.

FOUR THINGS THAT WILL COST YOU IF YOU DON'T CARRY THEM:

1. R14/R15 bind every remaining unit. All four assert copy mostly by what it must NOT contain, and this
   workstream has now proved TWICE that such an assertion passes against a function ignoring its `mode`
   argument, because today's GitHub literal already satisfies the ban. Pair every absence with a positive
   `toBe` on BOTH modes' exact literals, copied from the tree, never paraphrased. And run the mode-blind
   control to see which banned patterns actually fire — R14's own list contained one that never does.
2. One absence per test body. Two `not.toContain` in one test means the runner aborts at the first, so the
   second is never independently falsifiable and its control only looks like it bit.
3. Two live defects M8.7 still owns, both reproduced in a real browser rather than predicted:
   `title="org member · reviews on github.com"` on a local row — it is an ATTRIBUTE, so a sweep over rendered
   text misses it entirely; and the rate chip, which is workspace-scoped by owner ruling, so the real work is
   distinguishing loading from unavailable and OMITTING rather than skeletoning forever.
4. Every worktree dispatch brief opens with a mandatory STEP ZERO — `git log` → `git merge --ff-only <tip>` →
   `bun install` — because an isolated worktree is created at the repo's BASE commit with no node_modules, and
   any result produced before that is void.

MERGE PROTOCOL: nothing merges until the whole workstream lands. `m8.7` is based on `m8.6` (PR #71), which is
based on `m8.1` (#70), which is based on #69. Never merge, never commit to main, never retarget. main stays at
177068a.

You orchestrate; you do not implement. Delegate every unit to an isolated worktree, cheapest tier that can do
it well, one retry at the next tier up on a failed Check — a harness stall is not a failed Check, re-dispatch
at the same tier. Run the gate after every unit IN THE MAIN TREE, never trusted from a worker's worktree.

The `?mock=1` walk must be driven from your tree, never a worker's — the preview server serves the parent
checkout, so a worker's screenshot is evidence of different source. Synthetic key injection does not reach the
app's global handlers, so keyboard legs cannot be driven: record them as NOT RUN rather than claiming them.

Open M8.7's PR the moment its Verify goes green, mid-session, never batched. Update the ticket State and Log
and BOARD.md in the same edit; append a LOG.md entry; prepend a HANDOVER.md entry. Write the handover before
the work looks finished.

Stop and hand over rather than deciding if you hit any SESSION_PROTOCOL §5 condition.
```

**Note on concurrency:** decision package #1 is ruled, so **Session 3 (the daemon core) is unblocked** and may
already be running on another machine. It owns the splice — if S3 finishes second it rebases its lane onto the
`m8.7` tip before opening PRs. This session does not wait for it and does not splice.

---

## Template for any later session

```
ultracode /revu

Run Session <N> of the M8 workstream, unsupervised. I'm away — do not wait for me.

Orient first, in this order, and do not skip any of it:
  .claude/workstreams/m8-local-reviews/BOARD.md          (live state — In flight must be empty)
  .claude/workstreams/m8-local-reviews/HANDOVER.md       (top entry — including any rulings I left)
  .claude/workstreams/m8-local-reviews/ROADMAP.md        → "Session <N>"
  .claude/workstreams/m8-local-reviews/SESSION_PROTOCOL.md
  the ticket files for <tickets>
  .claude/skills/revu/memories/
Tracking is the local board, NOT Linear.

Scope: <tickets> only. Waves, tiers and isolation are in ROADMAP.md → Session <N>.
Check the roadmap's Preconditions for this session are actually met before dispatching anything; if they are
not, say so and stop rather than working around them.

You orchestrate; you do not implement. Cheapest tier that can do the unit well, one retry at the next tier up,
then stop. Gate after every unit. Fable-tier adversarial review of each ticket's full diff before its PR opens.
Each PR is based on the previous link in the chain — the chain order is fixed in ROADMAP.md, do not relitigate it.

Finish by meeting the session's exit condition exactly as written, updating ticket States + Logs + BOARD.md
together, appending to LOG.md, and prepending a HANDOVER.md entry a cold agent can act from alone.

Stop and hand over rather than deciding if you hit any SESSION_PROTOCOL §5 condition.
```

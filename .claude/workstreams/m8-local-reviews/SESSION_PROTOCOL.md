# Session protocol — running M8 unsupervised

How an ultracode session on this workstream operates when nobody is watching. [`ROADMAP.md`](./ROADMAP.md)
says *what* each session does; this says *how* every session behaves. Read both before dispatching anything.

The governing asymmetry: an unsupervised session can produce a great deal of work, and it can also produce a
great deal of confidently wrong work. Everything below exists to make the second outcome **loud and cheap**
rather than quiet and expensive.

---

## 1. The main thread orchestrates; it does not implement

The orchestrator's job is orient → decompose → dispatch → integrate → verify → record. It writes code inline
only for a trivial one-file touch. Its context is the scarcest resource in a long session, and it is the only
thing that cannot be rebuilt by a retry — so it never pulls large file contents in. Workers return
**conclusions and diffs**, never file dumps.

Two things only the orchestrator does:

- **Commits.** Workers return changed files; the orchestrator reviews, integrates, runs the gate, commits.
  One committer means coherent history and no racing writers.
- **Board writes.** One writer, or two agents race on `BOARD.md`.

## 2. Model tiers — cheapest tier that can do the unit well

Delegating everything to the top tier is as wrong as doing everything inline.

| tier | use for | in this workstream |
| --- | --- | --- |
| **sonnet** | mechanical, pattern-following, spec-in-hand | fixture wiring, copy sweeps with an enumerated list, doc updates, board verification passes, boilerplate tests from a written spec |
| **opus** | substantive implementation, multi-file refactors, real debugging | most units — the store, the git builder, the write sink, the daemon wiring, the app work |
| **fable** | cross-cutting design, security-critical, adversarial review | the contract shape in M8.1, the anchoring/rebase logic in M8.8, and **every pre-merge review** |

**Escalate on failure, don't loop.** A unit that fails its Check retries **once at the next tier up**. If the
top tier fails, stop and write it into the handover — do not try a third time, and do not reduce the Check to
make it pass.

## 3. Blast radius — parallel workers must not collide

Before dispatching a wave, confirm every concurrent worker has a **disjoint file set**. Where they don't, use
`isolation: 'worktree'` — but only where they don't, because a worktree costs real setup time and disk per
agent.

Known collision points in this workstream, from the ticket dependency analysis:

- `packages/revud/src/direct/store.ts` — M8.2, M8.8 and M8.10 all touch it. Serialize, or isolate.
- `packages/shared/src/api/types.ts` and `http.ts` — M8.1 owns them. Nothing else edits them concurrently.
- `packages/revud/src/direct-router.ts` — M8.5 owns it; M8.9 extends it afterwards.
- `packages/app/**` vs `packages/revud/**` — genuinely disjoint. The app pair and the daemon core can run
  concurrently all day.

The general rule: **package-level disjointness is safe; file-level overlap is not.** A trivial expected
conflict (one shared interface append) is fine to plan for and resolve at integration; two workers editing the
same function is not.

## 4. Test-first, and the gate after every unit

revu is built test-first — milestone MT established it and it is a hard constraint, not a preference: an agent
must be able to verify its own work locally, unsupervised, with no external deployment. M8 does not get an
exemption. Concretely, for **every** unit:

1. **Write the test first and observe it fail.** A test that has never been red proves nothing — it may be
   asserting a tautology, or not running at all. "Observed red" is part of the unit's Check, not a nicety.
2. **Then make it green**, and run `bun run check` before the unit is called done.
3. **The test must be durable.** A unit's Check is satisfied by an assertion that will run again, on every
   future gate, and fail if someone regresses the behavior. A one-time manual observation is not a Check — at
   most it is corroboration alongside one.

**Guard rails land before the code they guard.** Where a unit exists to make something impossible — the D7
"no GitHub client in the local write path" guard, the D4 "no synthetic id in a PR-keyed column" containment
test, the mode-select tripwire — that test lands *first*, red, in an earlier wave than the code it constrains.
A guard written afterwards tends to encode what the code does rather than what it must never do.

**Negative controls for anything asserting an absence.** A test that passes because nothing happened is
indistinguishable from a test that passes because it is broken. Where a Check asserts an absence — zero
`/api/*` requests, an empty netlog, no comment lost to a pruned object — prove the assertion can fail:
temporarily break the thing it guards, observe the test go red, revert. Record both observations in the
ticket's Log.

**The UI is not exempt.** `packages/app` has no `.test.tsx` by convention and no RTL/jsdom — but
`renderToStaticMarkup` needs neither a DOM nor a new dependency, so a plain `.ts` test can render a real
component and assert on its HTML. Where behavior genuinely cannot be asserted that way, extract the decision
into a pure predicate, test the predicate, and keep the untested part to wiring thin enough to be read at a
glance. A `?mock=1` walk is a demo, not a test; it corroborates, it never substitutes.

**Where a unit truly cannot carry an automated test, say so in the ticket** — name the unit, the reason, and
what compensating assertion exists. An acknowledged exception is fine; a silent one is how a suite rots.

`bun run check` runs after each unit lands, not once at the end. A red gate discovered at PR time means
bisecting a wave of parallel work; a red gate discovered after one unit names its own cause.

Three harness landmines that will otherwise cost a session an hour each:

- The gate runs `bun test` **before** the app build, so `packages/app/dist` does not exist during tests. Any
  test that starts revud must point at a stub dist via `REVU_DIST_DIR` with a temp `REVU_DATA_DIR`.
- The e2e driver is a plain `bun run` script, **never** a `*.test.ts` — for exactly that reason.
- Any test driving the mock must call `mockDev.reset()` in `beforeAll`; the `localStorage` shim is one
  process-wide `Map` shared across files, so one file's mutations leak into another's. Green locally, red on a
  slower CI runner.

## 5. Stop conditions — halt and hand over

An unsupervised session **stops and writes a handover** rather than deciding, when it hits any of these:

1. **A D-decision would have to change.** D1–D8 in [`MILESTONE.md`](./MILESTONE.md) are settled, three of them
   by the owner. If the work implies one is wrong, that is a finding to report, not a call to make.
2. **The frozen contract would move beyond what M8.1 sanctioned.** `RevuApi` and the wire types are frozen;
   M8.1 defines the exact permitted extension. Anything further stops.
3. **The top tier failed a Check** after the one permitted escalation.
4. **The gate is red and the cause is not understood** after one focused debugging pass. Never disable a test,
   loosen an assertion, or narrow a Check to get green.
5. **A merge conflict that is not mechanical.** Rebasing the stack is routine; resolving a genuine semantic
   conflict between two parallel tracks is a decision.
6. **Anything touching token custody, the audit journal, identity, or the out-of-band-write detector.** M8
   should never need to — if a unit seems to, that is a design problem surfacing, not a task.
7. **A local review would gain any path that writes to GitHub.** D7 is structural. Stop.
8. **Scope growth** — the work reveals a ticket the plan doesn't have. Append it to the board and stop rather
   than absorbing it silently into an unrelated ticket.

Stopping is a successful outcome. A session that lands three tickets and stops cleanly on the fourth with a
precise handover is worth more than one that lands five and leaves the reason for the sixth undiscoverable.

## 6. Never blocked on a human

Git state never blocks implementation. The human merges; the session never waits for a merge.

- **Stack the PRs.** Ticket B depending on unmerged ticket A branches off A and opens its PR with A's branch
  as base. When a base merges, rebase the rest of the stack and retarget.
- **One linear chain up from `main`**, not parallel branches off `main` — even when the work itself ran in
  parallel. Parallel results get rebased into the chain before their PRs open.
- **Never merge to `main`. Never commit to `main`.** Both are the human's.
- The handover records the stack: which PRs are open, their base order, what waits on which merge.

## 7. The resume contract

At **any** interruption — a crash, a context limit, a human stopping it — the next session must continue from
the board alone. That is only true if these hold continuously, not at session end:

- `BOARD.md`'s **In flight right now** section names exactly what is running. Updated at dispatch, cleared at
  land. Never speculative, never stale.
- A unit's outcome goes in its ticket's `## Log` **when its Check passes**, not in a batch later.
- A ticket is `Done` only when its `Verify` has actually run green — not when its units look finished.
- `HANDOVER.md` is prepended before any long pause and at session end, always.

**Write the handover before the work looks finished, not after.** A session that dies at 95% with no handover
is worth less than one that dies at 60% with a good one.

## 8. Review before merge

Every ticket gets an adversarial **fable-tier** review of its full diff before its PR opens — not a summary of
the diff, the diff. Security-critical or contract-touching changes get one regardless of who wrote them.

The reviewer's brief is to **refute**, not to approve: assume the code is wrong and find where. For this
workstream the standing questions are the ones the design says are easy to get wrong — does anything reach
GitHub from the local path; can a synthetic id reach a PR-keyed column; does a returned value carry every
field the app's optimistic path copies back; does anything change what the mock's semantics mean.

## 9. What every session produces

Even a session that stops early:

1. Green gate on everything committed.
2. Board honest — states, logs, In flight cleared.
3. A `LOG.md` entry: Done / Decisions / Blockers / Next.
4. A prepended `HANDOVER.md` entry a cold agent can act from alone.
5. Any durable learning written as a memory in `.claude/skills/revu/memories/` — a constraint discovered, a
   landmine hit, a decision's *why*. That is the loop that makes the next session cheaper than this one.

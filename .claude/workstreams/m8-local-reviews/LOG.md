# M8 — work log

The workstream's running record: what landed, what was decided, what blocked. Append-only, **newest last**.
Per-ticket detail lives in each ticket's own `## Log`; this file is for the workstream as a whole.

---

**update — 2026-08-12 · workstream designed and seeded**

**Done**
- Mapped every surface a local-only review touches, in five parallel read-only passes: the frozen contract and
  wire types; the direct-mode sync engine; the write path, threads and anchoring; revud's routing, modes and
  store; and the React app's routes, chrome and state.
- Wrote the design: [`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md) — surface map, eight
  decisions with rationale, 26 enumerated edge cases.
- Added the `## Milestone M8` section (issues M8.1–M8.11) to
  [`docs/agent/MILESTONES.md`](../../../docs/agent/MILESTONES.md), so the doc and the board stay in step.
- Landed both on [PR #69](https://github.com/pat-mw/revu/pull/69) — docs only, `bun run check` green.

**Decisions** — D1–D8, recorded in [`MILESTONE.md`](./MILESTONE.md), full rationale in the design doc. Three
were owner calls (D1 archive-on-PR, D2 reserved-number identity, D3 committed-content-only).

One was adjusted rather than taken literally. The owner chose a reserved high-number band for local review
identity. Carried into the store that would have been wrong: `snapshots.pr_number`, `audit_log.pr` and
`pr_author.pr` are read by the host collector and the broker poll loop as **real GitHub PR numbers**, and
`audit_log.pr` is `INTEGER NOT NULL`. So the band became a **contract-level** identity only (**D4**) — it buys
an untouched `RevuApi`, all 21 routes, both routers' `n > 0` gates, the validators, `/pr/:n` and every React
Query key — while the store gets its own `local_*` tables.

**Blockers**
- **Linear cannot hold this workstream.** `save_issue` fails with `You've exceeded the free issue limit for
  this workspace`. The M8 milestone was created; its 11 tickets could not be. Milestones, comments and status
  updates still write.

**Next** — build the local board.

---

**update — 2026-08-12 · tracking moved to a local board**

**Done**
- Stood up `.claude/workstreams/` as the tracking source of truth while the Linear cap stands:
  [`README.md`](../README.md) (the protocol and the Linear→files mapping), and for this workstream
  [`MILESTONE.md`](./MILESTONE.md), [`BOARD.md`](./BOARD.md), [`HANDOVER.md`](./HANDOVER.md), this log, and
  eleven ticket files under [`tickets/`](./tickets/).
- Each ticket carries what a Linear issue would have carried and more: a header table (state, surface, kind,
  depends, blocks, branch, PR), numbered `M8.x.n` units with **Do / Files / Check**, a `Verify` acceptance
  test, **verified `path/file.ts:line` seams**, the constraints that bind that specific ticket, its landmines,
  and its open questions.
- Reworked the harness (`.claude/skills/revu/SKILL.md`) and the memories so a cold session orients from the
  local board instead of Linear.

**Decisions**
- The board lives under `.claude/`, not `docs/`. It is admin tracking, not documentation — and `.claude/` is
  already stripped for open-source release, so tracking artifacts never reach the public tree.
- The five Linear states are kept verbatim, so migrating back if the cap is raised is mechanical.
- Board edits ride the work PR that caused them; a session ending with no work PR opens a small `board/…` PR.
  Committing directly to `main` stays forbidden.

**Blockers** — none.

**Next** — implementation. **M8.1 gates everything** (it is the spec — D6). After it lands, three tracks run
concurrently: daemon core (M8.2/M8.3/M8.4 → M8.5), app (M8.6/M8.7, which need only the mock), and hardening
(M8.8 after M8.3, M8.10 after M8.2). M8.11 closes the milestone.

---

**update — 2026-08-12 · tickets deepened, workstream planned**

**Done**
- Authored all eleven ticket files (~370 KB), then ran two adversarial critics and a patch pass over the set.
  **24 findings applied, 0 rejected.** Four units were added for work no ticket owned: daemon-side
  `listBranches` (a `git for-each-ref` read, not a store read as M8.5 assumed — M8.3.7), the D3
  uncommitted-changes banner (M8.7.8), the two latent optimistic-path bugs in `state/threads.ts` (M8.7.9), and
  edge case 18, the conflict-terminated reconcile that leaves `draft.headSha` stale (M8.8.7).
- Wrote [`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) — how a session behaves when nobody is watching: tiers
  and single-retry escalation, blast-radius rules, eight stop-and-hand-over conditions, the stacked-PR rule
  that keeps a session from ever waiting on a merge, and the continuous resume contract.
- Wrote [`ROADMAP.md`](./ROADMAP.md) via a three-way judge panel — max-parallelism vs stack-linear vs
  risk-first, scored by three judges on unsupervised safety, throughput, resumability, stack coherence and
  verification integrity. **Stack-linear won unanimously**; the synthesis grafted dual-lane concurrency and
  unit-frontier starts from the losing plans. Verified unit-by-unit against the real tickets afterwards.

**Decisions**
- **Three open questions became recorded decisions in M8.1**, where the spec belongs — the mock's `listPulls`
  includes local reviews (D-a); a submitted local `ReviewSummary` never enters `snapshot.mutable.reviews`
  (D-b); `dirty`/`archivedPr` ride a new `LocalReviewSummary` rather than the frozen `BrokerPullMeta` (D-c).
  Six tickets that were re-asking those now point at the answers.
- **The chain order is derived from verified file ownership, not from the dependency graph alone.** The app
  surface settles before M8.8's and M8.9's app-side units append to it; the store settles before retention
  deletes from it; `direct-api.ts`/`direct-router.ts` are touched in one strict order. Every rebase in the
  stack is then mechanical by construction.
- **The dependency graph was wrong and is now acyclic and mutually inverse.** M8.7 sits behind M8.6, M8.9
  behind M8.6+M8.7, M8.8/M8.10 behind M8.5. Two pre-existing inconsistencies fell out (M8.1 blocked M8.5
  without M8.5 depending on it; likewise M8.4→M8.9). `BOARD.md` carries the corrected four-layer graph.

**Blockers** — none. Session 1 is ready to start.

**Next** — **Session 1: the spec** (M8.1). Prompt in [`PROMPTS.md`](./PROMPTS.md), plan in `ROADMAP.md` →
Session 1. It is the fork point: S2 (app) and S3 (daemon) both hang off it and can then run concurrently.

---

**update — 2026-08-12 · test-first audit over the whole ticket set**

**Done**
- Made the TDD doctrine explicit in [`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) §4: test first and observed
  RED; a Check must be a **durable** assertion that runs on every future gate; guard rails land before the code
  they guard; anything asserting an absence needs a negative control; the UI is not exempt (no jsdom, but
  `renderToStaticMarkup` needs none — extract a pure predicate where a component resists assertion); and an
  exception must be **named** with its compensating assertion.
- Audited all 11 tickets against it, one agent per ticket reading the real code and its neighbouring tests.
  **67 Checks strengthened. 13 new units added** for test work that had no owner — among them M8.2.7 (the
  PR-keyed tripwire harness, armed, landing *first*), M8.4.8 (the in-memory local harness, ahead of its
  number), M8.8.8 (the prune-survival suite and the control that gives it teeth), M8.10.7 (the in-flight-sync
  gate, before the unit that wires a caller). **74 → 87 units.**
- Every ticket gained a `## Testing exceptions` section naming what genuinely cannot be asserted and what
  compensates for it.
- `ROADMAP.md` gained a `## Test-first discipline` section and re-sequenced waves so guards land red first.

**Decisions**
- **A one-time observation is not a Check.** Several units rested on `tsc` clean, a `grep`, or a manual
  `?mock=1` walk; those are corroboration and are now labelled as such, with a durable assertion beside them.
- **Break-observe-revert controls are procedural, not gated.** Where a control cannot live in the suite, the
  rule is that *a green Check with no logged red is unproven* — enforced by the Log requirement and the
  recovery rule, not by CI. Stated rather than pretended otherwise.

**Blockers** — none.

**Next** — unchanged: **Session 1** (M8.1, now 7 units). Note M8.1.7 lands the dispatch sweep and M8.1.4's
exhaustiveness guard is red-first.

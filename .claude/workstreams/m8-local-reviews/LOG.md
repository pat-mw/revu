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

---

**update — 2026-08-13 · Session 1: the spec (M8.1) landed**

**Done**
- **M8.1 is `In Review`** — all 8 units landed on `m8.1/contract-and-mock`, PR
  [#70](https://github.com/pat-mw/revu/pull/70) open on base `m8/local-reviews-design` (#69). Nothing was
  committed to `main`; nothing was merged. **#69 merges first**, then GitHub retargets #70 to `main` — the
  board and the design doc exist only on #69, and it carries zero files under `packages/`, so #70's code diff
  is identical to a `main`-based one.
- **Gate green after every unit, never batched**: 1181 → 1193 → 1201 → 1219 → 1230 → 1240 → **1245 pass ·
  1 skip · 0 fail · 68 files**. Verify: `conformance:matrix` exit 0 with both required legs PASS,
  `suite.ts` diff **0 lines**, both invariant tests **0 lines**; additionally `bun run test:e2e` exit 0 in
  real Chrome with the local fixture seeded, and a recorded `?mock=1` walk showing **zero** `/api/*` requests.
- **The frozen contract moved additively**: `client.ts` +39/-0, `types.ts` +93/-1, `http.ts` +27/-1 — and both
  deletions across all three files are docstring lines that were *factually wrong* (`:n` described as a pull
  request number; every thread id described as a GraphQL node id). No signature, type or route was edited.
- **Eight open questions froze** with reasoning, in the ticket `## Log`: wire shapes · route spellings ·
  branch-list shape · minting · delete boundary · rate limit (confirmed unchanged) · the error code ·
  thread-id shape. Reversing one is now a contract change, not a preference.
- **Spike B** ran and is captured in HANDOVER: typed-absent `DirectContext.github` breaks exactly **2** lines,
  classified 0 mechanical / 2 needs-a-local-branch / 0 dangerous, with the identity guard **absent from the
  break set** — the §5.6 signal is green.

**Decisions**
- **A unit was appended mid-ticket, 7 → 8.** M8.1.4 found the mock engine unreachable through the contract
  (`requireRemote()` throws `not_found` for a local id at five sites), which made M8.1.6's walk unsatisfiable
  as written. M8.1.8 was appended and numbered rather than absorbed into another unit or escalated as scope
  growth — it sits inside M8.1's own Goal. Existing units were not renumbered.
- **Two deliberate deviations from the roadmap's wave plan**, both recorded on the board: W4/W5 were resplit
  so M8.1.8 runs alone before M8.1.5 ∥ M8.1.6 (M8.1.5 and M8.1.8 have disjoint files but a real *semantic*
  overlap — both decide how a local review reaches `listPulls`), and M8.1.5's tier was raised sonnet → opus
  once that ruling turned it into design-constrained work. The sequencing is what caught the conflict:
  M8.1.8's single-path ruling **superseded M8.1.5's ticket text**.
- **The mock's semantics are now the spec in concrete detail** — high-water minting (never a max-scan, which
  recycles a deleted review's id), full-record deletion with drafts *orphaned rather than destroyed*, thread
  ids spelled `local:<reviewId>:<rootCommentId>`, the local branch taken **above** the remote lookup, and the
  record as the one truth with the snapshot rebuilt from it.

**Blockers**
- **Decision package #1 is seeded in HANDOVER and needs the owner's rulings**: M8.5 OQ1 (how local-only is
  switched on — recommend explicit), M8.8 OQ2 (the commit-delta rewrite on the shipped PR path — recommend
  yes; "no" is a §5.1 finding), M8.10 OQ1–OQ3 (blob-prune defaults), and M8.2 OQ1's behavioral half
  (successor-mint vs one-way door — recommend the door, because successor-mint would require changing the
  *mock*, which is the specification). **Session 3 ends blocked on these; Session 4 needs three of them.**
- Two further rulings surfaced by the adversarial review, both carried in HANDOVER: whether the local reaction
  rollup should stay shared-per-review, and whether submitting before the first sync should be **refused**
  rather than succeeding invisibly. Both are pinned as-is so nothing can diverge silently while they wait.

**Next**
- **Sessions 2 and 3 both fork off `m8.1` and are genuinely concurrent** (zero shared files — `packages/app`
  vs `packages/revud`); on two machines that is the plan's single largest schedulable win. **S2 needs none of
  the rulings and can start immediately**; S3 needs three of them. S3 owns the splice.

**addendum — 2026-08-13 (owner, after the session closed)**
- **Nothing merges until the whole M8 workstream lands.** Every session keeps stacking; `main` stays at
  `177068a` for the milestone and #70 stays based on #69. `SESSION_PROTOCOL.md` §6's rebase-after-a-base-merge
  step never fires, which makes `ROADMAP.md`'s chain order load-bearing for the whole milestone rather than
  only until the first merge. Supersedes this entry's "**#69 merges first**" bullet above.
- **The owner will be interviewed on the open questions rather than having recommendations applied.** The next
  session opens by putting decision package #1 — plus the two rulings the adversarial review surfaced — to the
  owner interactively, and records each answer as a standing ruling.

---

**update — 2026-08-14 (Session 2 — the app)**

**Done**
- **The owner interview ran first, before anything was dispatched, and decision package #1 is now closed.**
  14 questions, one decision at a time, each with its tradeoff and its downstream cost. Every answer is a
  standing ruling in `HANDOVER.md`'s top entry; **Session 3 is unblocked.** The roadmap's pre-flight defaults
  for M8.6/M8.7 were deliberately **not** applied — each of those questions was put to the owner too.
- **M8.1.9 landed** (`4fbc5fb`, unit count 8 → 9) — submitting before the first sync is now refused with
  `unprocessable`. This reopened a ticket already in review because the mock is the specification and the
  ruling changed it; PR #70 is unmerged, so it is an added commit, not rewritten history. Genuine observed red
  (`Received: null` — the old success was reachable), two positive controls replaying the identical input
  after a sync, gate exit 0 at 1246 pass · 1 skip · 0 fail · 68 files.
- Board brought into line with the rulings: `M8.6`/`M8.7` each carry a new `## Rulings` section stating what
  each ruling **overrides** in the units below, rather than the units' careful prose being rewritten in place.
- `.claude/worktrees/` gitignored — the hazard Session 1 flagged and appended. Sessions 3 and 4 use worktree
  isolation in five waves; without this an agent worktree can be staged into a PR.

**Decisions**
- Sixteen standing rulings, listed in full in `HANDOVER.md`. The four that shape other sessions: local-only is
  switched on by an **explicit** flag; the commit-delta rewrite **does** land on the shipped GitHub PR path;
  blob prune is **off by default, delete-only, with a confirm**; an archived triple is a **one-way door**.
- Two rulings changed work that was already planned. Refusing submit-before-sync forced **M8.1.9** into a
  ticket in review. Workspace-scoped rate-chip suppression **amends the roadmap's S2 exit condition** — under
  `?mock=1` the workspace genuinely has GitHub, so the chip legitimately renders and asserting its absence
  would be asserting a falsehood.
- Deviation from the roadmap's S2 wave plan, recorded with its reason: **W1 was M8.6.7 ∥ M8.7.10; it runs as
  M8.6.7 alone.** M8.7.10's files belong to `m8.7`, which branches off `m8.6` and does not exist yet, so
  running it now means holding an uncommitted diff across all seven M8.6 units — exactly the unlanded work
  §7 says to discard rather than archaeologize. M8.7.10 runs first thing on `m8.7` instead; it is a compact
  unit and the wall-clock cost is small against the resumability risk.

**Blockers**
- **M8.12 open question 1 is a real one and it is not this session's to answer:** the frozen route set has
  `DELETE /api/local-reviews/:n` with no body and no query parameter, so a **server-authoritative** delete
  force has nowhere to live. Either the confirmation is purely client-side (weaker), or it is a frozen-contract
  change — a §5.2 stop. **Must be settled with M8.10 before either ticket dispatches.**

**Next**
- Finish M8.6's waves, open its PR the moment its Verify is green, then `m8.7` off it starting with M8.7.10.

---

**update — 2026-08-14 (Session 2 — the app) — paused at a unit boundary**

**Done**
- **The owner interview ran first and decision package #1 is closed** — 14 decisions, each with its tradeoff
  and downstream cost, all recorded as standing rulings. **Session 3 is unblocked.** The roadmap's pre-flight
  defaults for M8.6/M8.7 were deliberately not applied; each of those questions went to the owner too.
- **M8.6 complete, PR [#71](https://github.com/pat-mw/revu/pull/71) open** on base `m8.1` — 7 units, Verify
  green including a recorded browser walk.
- **M8.1 reopened to 9 units** (`4fbc5fb`, `8b73a77`) — a ruling changed the mock, and the mock is the spec.
- **M8.7 at 6 of 12 units**, branch pushed, **no PR** — its Verify has not run.
- Gate green after every unit, never batched: **1246 → 1440 pass · 1 skip · 0 fail · 81 files**, each re-run
  in the main tree rather than trusted from a worker's isolated one.

**Decisions**
- Sixteen owner rulings plus R11–R15 from the work itself. Three rulings were later **corrected by the units
  that consumed them** — R11 missed a file inside its own scope, R6 was not expressible in the signature it
  prescribed, and **R14's banned-regex list contained a member that never fires**.
- Five recorded deviations from the roadmap's S2 plan, each with its reason (see HANDOVER).

**Blockers**
- **M8.12 OQ1** — the frozen route set gives `DELETE /api/local-reviews/:n` no body and no query parameter, so
  a server-authoritative delete force has nowhere to live. Client-side-only (weaker) or a frozen-contract
  change and a §5.2 stop. **Settle with M8.10 before either dispatches.**

**Next**
- Finish M8.7: **M8.7.5 → .6 → .8 → .7**, plus appended **M8.7.11** and **M8.7.12**. Then Verify, a fable
  review of the full diff, and the PR on base `m8.6`. R14/R15 bind every one of those units.

---

**update — 2026-08-17**

**Done**
- **M8.7 is COMPLETE and `In Review` on PR #72** (base `m8.6`). Seven units landed this session in one serial
  chain — **M8.7.5 → .6 → .8 → .12 → .11 → .7**, then the review fixes and the appended **M8.7.13** — each
  dispatched to an isolated worktree, integrated by copying whole files back, and **gated in the main tree**
  rather than trusted from the worker's.
- **Gate green after every single unit, never batched: 1440 → 1611 pass · 1 skip · 0 fail · 83 files** (+171
  tests, +2 files).
- **M8.7's `Verify` ran green**: the unit-check set at 232 pass · 0 fail across 8 files, the six-control ledger
  complete, and the `?mock=1` walk driven from the orchestrator's tree — tab set, header identity, redirects,
  verdict picker, submit toast, the inbox rows, the whole pull-request path, and all four seal states.
- **A fable-tier adversarial review of the full diff found NO blockers** and verified all fifteen rulings as
  implemented rather than taking them on trust. Its four `should-fix` findings are closed.
- **The two live defects M8.7 owned are dead and controlled**: the local rows now carry zero `title`
  attributes while a genuine org member still carries `org member · reviews on github.com`; and the rate chip
  omits on an unavailable workspace instead of shimmering forever.

**Decisions**
- **Execution order was decided once and recorded rather than re-derived**: serial by file contention, with
  M8.7.12 before M8.7.7 because the closing proof must run after the last `pr-layout.tsx` writer, and M8.7.11
  placed second-to-last purely to keep M8.7.7 last (it is genuinely disjoint from everything).
- **M8.7.13 was appended, not absorbed** — the palette's "This PR" heading is a live false claim in no copy
  inventory, and folding it into an existing unit is how a ticket's scope stops meaning anything.
- **The palette placeholder takes no mode**, deliberately: the palette opens with no review at all, so there is
  no mode to scope it and inventing one would state a fact the surface does not have.

**Blockers**
- **M8.12 OQ1 is unchanged and still live** — the frozen route set gives `DELETE /api/local-reviews/:n` no body
  and no query parameter, so a server-authoritative delete force has nowhere to live. **Settle with M8.10
  before either ticket dispatches.**
- **Two findings handed to M8.1 (the mock is the spec), neither absorbed:** the mock emits a session shape the
  daemon never produces (`viewerLogin` omitted while `brokerLogin` is set); and **`dirty: true` is
  unrepresentable** — no fixture or dev control sets it, so the container half of the dirty banner has never
  executed against a `true` anywhere, and M8.7's own Verify text asks for a leg that is not runnable.

**Next**
- The app track is finished through M8.7. The daemon track is untouched and unblocked: **M8.2, M8.3, M8.4 are
  mutually independent** and all three need only M8.1. M8.5 needs all four.
- Nothing merges until the whole workstream lands; `main` stays at `177068a`.

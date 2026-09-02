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

**update — 2026-08-17 (session 4, the daemon — dispatch)**

**Done**
- **Board re-verified against the repo before any work**, per the board's own opening line. Every present-tense
  claim held this time: In flight empty, tree clean at `d0cc1d0`, one worktree, four PRs with the stated bases,
  `main` at `177068a`, `m8.6` ahead of its remote by one. Baseline gate re-run in the main tree:
  **1611 pass · 1 skip · 0 fail · 83 files**.
- **`m8.6/app-creation-flow` pushed** (`0c17be9`), moving that board-docs commit out of #72's range and into
  #71's, where it belongs. Every ref is now pushed.
- **Three lane branches created at `96b63de`** and the daemon track dispatched as three concurrent lanes —
  the first genuinely parallel wave in this workstream. `m8.2/store-v4` is pushed and is the chain's base.
- **The three guard rails dispatched first, one per lane**: M8.2.7 (nine PR-keyed tripwires, armed and green
  on today's store), M8.3.8 (the D7 source scan plus the seeded real-git fixture harness), M8.4.6 (the
  no-GitHub-client structural scan). M8.3.8 and M8.4.6 land **red by design** — both assert their target
  modules exist, which is what stops them passing vacuously.

**Decisions**
- **The roadmap's S3 wave table was not dispatched.** It assumes the orchestrator can merge two workers'
  versions of one file; integration is by copying whole files out of isolated worktrees, so two workers on one
  file means one is silently discarded. The lanes run at the corrected widths.
- **Integration and gating stay serial even though the work is parallel** — one main tree, and the gate ends in
  a repo-wide `vite build`, so gates cannot overlap. Worker time is what parallelises.
- **Within a lane, each unit is integrated before the next is dispatched**, because the units share files.
- **All three branches start at the same commit and are rebased into the linear chain before their PRs open**
  (§6), with the gate re-run after each rebase — a mechanical rebase is not a proof.

**Blockers**
- None new. **M8.12 OQ1** and **M8.10 OQ4** remain unruled and both bite at M8.10, not here. The two findings
  handed to M8.1 by the app track are still unabsorbed and still ownerless.

**Next**
- Integrate and gate each lane's first unit, then walk each lane's chain. PRs open per ticket the moment that
  ticket's `Verify` is green — after a fable-tier adversarial review of its full diff, never batched to session
  end. Nothing merges; `main` stays at `177068a`.

**update — 2026-08-17 (session 4, the daemon — complete)**

**Done**
- **All three daemon tickets complete and in review**: M8.2 (7 units, #73), M8.3 (9 units, #74), M8.4 (9 units,
  #75). Each: units → `Verify` green → fable-tier review of the full diff → fixes → PR, never batched. Gate
  re-run in the main tree after **every** unit and after **every** rebase; final tip **2445 pass · 1 skip ·
  0 fail · 91 files**.
- **Three lanes ran concurrently all session** — the first real parallel wave in this workstream. The width lost
  was entirely *inside* each ticket, where units are serial on one or two shared files.
- **Each pre-merge review found a blocker that had passed a green gate**: a corrupt id high-water mark minting a
  value inside the forge's pull-request range; a typechange making any containing review unbuildable; and a
  structural guard evadable by a file extension, demonstrated end to end with a real client loading at runtime.

**Decisions**
- **Integration is serial though the work is parallel** — one tree, and the gate ends in a repo-wide build.
- **The board lived on the chain base while the lanes ran, and moved to the tip when they converged.**
- **Guard rails land red**, and both were verified *able* to go green before being left red.
- **Fix a guard by extending its allowlist, never by loosening its comparison.**

**Blockers**
- None new. **M8.12 OQ1** and **M8.10 OQ4** remain unruled; both bite at M8.10.

**Next**
- **M8.5 (daemon wiring)** is unblocked and needs all four of M8.1–M8.4. **Read the five findings addressed to it
  in the handover before dispatching** — three are traps.

**update — 2026-08-19**

**Done.** M8.5 (daemon wiring) complete and in review on [#76](https://github.com/pat-mw/revu/pull/76) — ten
units, gate **2635 pass · 1 skip · 0 fail · 95 files** under `TZ=UTC`, `Verify` green, the frozen contract and
the four GitHub-path suites byte-unchanged from the branch point. The milestone's headline exit criterion is
reachable and was observed directly: `revud --direct --local-only` starts in a repository with no remotes,
creates a review on the reserved band, syncs from local git, and serves the snapshot, while GitHub-bound routes
answer a typed refusal. **CI green on all eight PRs.**

Two units were **appended rather than absorbed**: M8.5.9 (the two-daemon mint, a finding handed to this ticket)
and M8.5.10 (the local surface factory, which had **no owner** — the boot unit assembles the surface but all
four of its checks test boot seams).

**Decisions.** OQ5 settled as a single `LocalReviewSurface` assembled from store + runner + discovered toplevel
+ repo identity + session. OQ1 settled as an **explicit** `--local-only` / `REVU_LOCAL_ONLY` switch, never
automatic — a transient credential failure inside a real clone would otherwise boot a daemon showing an empty
inbox, which reads as data loss. OQ3: rate-limit degrades to the router's existing raw-501 convention, since
`not_implemented` is not an `ApiErrorCode` and adding it would be a frozen-contract change. OQ4: the merged
ETag hashes both halves. OQ6: `bin/revu` gains no local path; the criterion is proven against `revud` directly.

**Blockers found and fixed.** Two adversarial reviews of the full diff plus a focused third pass. **Four
blockers, every one reproduced before being treated as real**, and three of them contradicted by docstrings the
same diff introduced: a local-only boot in a GitHub *clone* served GitHub routes with no viewer identity and
**posted duplicate reviews to a real pull request**; a local review id was actionable from **any** repository
sharing the data directory, landing a durable thread anchored to a file in another repo; the snapshot persist
was a deferred read-then-write the busy handler cannot rescue; and the list ETag hashed compare keys alone, so
a submit or resolve left the inbox 304ing on a stale count. The first fix then **over-corrected** — local-only
began requiring the network and a valid token — and that repair is included, with the required path proven
byte-for-byte unchanged by mutation.

**CI was red on #74 and #75** before this session touched them. One test, whose control asserted git prints a
numeric offset for UTC; it prints `Z`. The fixture pinned commit identity because a runner has none, but never
pinned the timezone. Fixed at the root on `m8.3` so the stack inherits it by rebase, then `m8.4` and `m8.5`
rebased and **re-gated under `TZ=UTC`**.

**Blockers.** None for the daemon track. **M8.9, M8.10 and M8.12 carry open questions that block the next
session** and need the owner — see the handover's interview list.

**Next.** M8.8, M8.9 and M8.10 are mutually independent and all unblocked by M8.5; M8.11 closes the milestone.

**update — 2026-08-19**

**Done.** The owner was interviewed on the four questions the previous handover flagged as blocking dispatch,
and **all four are answered**. Each ruling is written into the Open question it closes — the ticket file is
authoritative — and indexed on `BOARD.md`. Ruling 3 was re-asked with the schema in front of it after the
owner said the first framing was unclear; the second framing named `blobs` as `(sha, data)` keyed by git blob
SHA and shared between GitHub and local snapshots, which is the fact the question actually turns on.

The stack was **re-linearized** before `m8.8` branched. #77 had forked at `0b32368` and never picked up
`048638c`, so what the last handover called a chain was a fork. Rebased onto the `m8.5` tip, **re-gated under
`TZ=UTC`** (2646 · 1 · 0 · 95) rather than trusting the clean rebase, force-pushed. `m8.8/resync-and-pinning`
branches from it. Baseline on the `m8.5` tip re-confirmed first at **2645 · 1 · 0 · 95**, exactly as the
handover predicted.

**Decisions.**
1. **Delete + draft: the server refuses.** Server-authoritative, no contract change. A `force` parameter on
   the frozen `DELETE /api/local-reviews/:n` was put to the owner as the §5.2 stop condition it is, and
   declined. M8.10.1's delete keeps a precondition, never a partial delete; M8.12 renders the two-step
   discard-then-delete against that refusal instead of guessing.
2. **Archive detection fires on each sync of that review.** No direct-mode timer, no GitHub work on an inbox
   poll. The accepted cost — a branch nobody re-syncs stays un-archived, so the user can keep commenting while
   a PR is open — is recorded as M8.9.6 copy, not hidden.
3. **The blob prune is off by default, behind an explicit policy flag.** The immutable prune bounds the churn
   and runs live; the blob walk ships dark. The decisive argument was recovery asymmetry, not size: a PR's
   blob is re-fetchable, a local review's blob can be the only copy once its branch is rewritten and its pins
   dropped. M8.10.5's on/off assertion pair is now load-bearing — it is what stops "off by default" decaying
   into "never worked".
4. **Every pin is kept** — unbounded but correct, explicitly conditional on **M8.10 landing in the same
   session as M8.8**. That coupling is a scope fact for this session, not a preference.

**Blockers.** None. **M8.10 OQ2 (when the prune runs) is narrowed by ruling 3 but not answered by it** and
must be settled before M8.10.6 wires a call site — it was deliberately not raised in this interview, which was
scoped to the four questions that blocked dispatch.

**Next.** M8.8 is In Progress. M8.10 is in scope for the same session by ruling 4. M8.9 is independent.

**update — 2026-08-19 (later the same session)**

**Done.** **M8.8 is 6/8** on `m8.8/resync-and-pinning`, pushed, no PR. M8.8.1 (`9522087`), M8.8.2 (`4d73d69`),
M8.8.3 (`7ed601d`), M8.8.4 (`048ea90`), M8.8.5 (`b52f181`), M8.8.8 (`cb2c5a0`). Gate at the tip
**2702 pass · 1 skip · 0 fail · 98 files** under `TZ=UTC`, re-run in the main tree after every unit. Only the
two app-side units remain, and they share `reconcile-dialog.tsx` so they run 6 then 7.

**Six git facts were verified against real git 2.50.1 before the pin seam was written**, not taken on trust:
the literal `<id>/<compareKey>` ref form is rejected; the substituted form is accepted; `update-ref --stdin`
is atomic (one bad entry ⇒ zero refs); two separate invocations leave a **half-write**; a ref at
`refs/revu/reviews/<id>` cannot exist while children do; `for-each-ref` accepts `--end-of-options`. The
atomicity asymmetry is now a permanent test in both directions.

**Decisions.**
1. **`syncPull` stays contract-shaped.** The pin outcome cannot ride `Snapshot` (frozen, shared with the
   hosted path), so `syncLocalReview` carries `{ snapshot, pin }` and `syncPull` delegates. Asserted: the
   object `syncPull` returns has no `pin` key. M8.8 OQ3 should read from there when answered.
2. **The pin outcome is not `partial`.** Held apart by comparing a pinned and a pin-blind run — same
   `partial`, same `immutable`, different `pin.ok` — rather than by prose.
3. **`CommandRunner` gained an optional `stdin`.** Additive; nothing broke. It is a security improvement:
   **no object name occupies an argv slot**, asserted.
4. **Validation is `isLocalReviewId`**, not "a positive integer" — a pull request number is one too.
5. **The rewrite fix changes the hosted PR path as well**, deliberately: `reconcile.ts` is shared, and a
   force-push on a pull request carries the identical defect.

**Two findings.** (a) The author-date fallback did not under-report, it reported **zero** on a faithful
rebase — author dates are preserved by a rebase, so every rewritten commit filters out. (b) M8.8.4's "re-sync
to rebuild" message **could not be acted on**: the sync read the whole snapshot to carry the authorship map
forward, which is the read that throws in that state. Caught only by an assertion the ticket did not ask for.
Recorded as a durable memory.

**Blockers.** None. **⚠️ This branch has never seen CI** — `ci.yml` triggers on `pull_request` and pushes to
`main` only, so a PR-less branch gets no runner. Local `TZ=UTC` runs are the only evidence.

**Next.** M8.8.6 → M8.8.7 → Verify → adversarial pass → PR. **M8.10 belongs to the same session as M8.8**
(ruling 4); its OQ2 needs the owner first. M8.9 is independent and unblocked.

**update — 2026-08-20**

**Done.** M8.8 completed at 8/8 and had its owed full-diff adversarial pass; M8.10 opened at 3/7.

- **M8.8.6** (`bc847ad`) — the rewrite the UI must not miscount, plus D8 base advance. **The unit's Check
  was wrong twice**, and either error would have shipped a green test that proves nothing: `isRewritten`
  asked of `newCommits` reports *every* fast-forward as a rewrite (that list is the slice **after** the
  draft head, so the head is never in it), and "commit on the base branch only" does **not** move
  `compareKey` at all — the base tip is explicitly not part of the key, which moves only when the base
  absorbs a commit the head already carries.
- **M8.8.7** (`407911a`) — a refused submit now leaves the draft describing its own head. `headSha` and
  `compareKey` move as one argument; no signature in the app takes one without the other.
- **The adversarial pass** (`bbc4bc6`) — 16 raw findings → 5 survived independent refutation → 4 fixed,
  1 recorded as M8.8 OQ8. Verdict on the pre-fix tree was **not safe to push**.
- **M8.10.1 / .2 / .3** (`3423324`) — the store's second `DELETE`, the only ref-deletion path in the
  milestone, and the fail-closed live-`compareKey` read.

**Decisions.**
- **Ruling 5 (owner):** the retention prune runs **after every successful local sync** — the tightest
  growth bound, pruning where the churn is created. M8.10.7's gate spends the in-flight-sync objection.
  Binds M8.10.6 to drive the prune **at a real sync**, not by calling it directly.
- **M8.10 OQ4 resolved from the repo, not the owner** — M8.2 shipped the high-water mark, so the id-reuse
  class is unreachable and the hold on the whole ticket is lifted.
- **Blobs are deliberately left untranslated** by `rebuildable`: provisioning skips SHAs the store claims
  to hold, so a present-but-corrupt blob survives every sync and "re-sync" would be a second false remedy.

**Blockers.** None. M8.10 OQ2 and OQ4 are both closed.

**Next.** M8.10.4 → M8.10.7 → M8.10.5 → M8.10.6, in that order (the gate must exist before any caller is
wired). Then **M8.9**, independent and unblocked. **M8.11 remains the real critical path** — it gates 3 of
the 6 exit criteria and has not started; unit percentage does not close the milestone, the criteria do.

**update — 2026-08-20 (later)**

**Done.** M8.10 reached 7/7 units on #79: the immutable sweep (`974513a`), the in-flight gate (`4a73b36`),
the blob walk shipping dark (`566539e`), and the wiring plus the operator policy (`16c3c87`). Gate at the
tip **2888 pass · 1 skip · 0 fail · 101 files**.

**Decisions.**
- **The gate default moved into the scripts, not `bunfig.toml`.** Bun ignores a `timeout` key there
  (verified against 1.3.11), so `test` and `check` now pass `--timeout=20000`. CI went red on a
  pre-existing allocator case that runs **437ms locally and 9372ms on a runner** — a factor of twenty-one —
  so a limit tuned to local timings is a coin flip on someone else's hardware. Roughly half the
  sync-driving tests in one file carry no explicit budget, so per-test patching would not have converged.
- **Prune failures are logged, not raised**, so one corrupt row belonging to an unrelated review cannot
  turn a sync whose snapshot is already on disk into a permanent 500.
- **`syncGate` stays optional**: both the wrapper and every prune read one binding inside
  `createDirectApi`, so the pairing cannot come apart by omission; requiring it would touch 40 construction
  sites for no safety gain.

**Blockers.** **M8.10 is not done at 7/7.** Owner ruling 1 was recorded at an Open question and never
became a unit, so the delete has no draft precondition in either transport; the mock and direct also
disagree on whether a delete destroys unsubmitted text and on a repeated delete. All three passed the gate
because `deleteLocalReview` has **no conformance coverage**. Appended as **M8.10.8**.

**Next.** M8.10.8 (mock first), then M8.10's `Verify` and M8.8's. Then **M8.9**, independent and unblocked.
**M8.11 remains the real critical path** — 3 of the 6 exit criteria, not started.

**update — 2026-08-20 (close)**

**Done.** **M8.10 is complete at 8/8 with its `Verify` green**, and **M8.8's `Verify` is green** with its
owed adversarial pass discharged. Both PRs are pushed and **CI is green on both**.

- **M8.10.8** (`faa1ad6`) — the owner's ruling 1 implemented in both transports: a delete **refuses** with
  `unprocessable` while any human holds a draft carrying text, as a precondition that leaves every row in
  place. `draftHoldsText` is **one shared predicate** both transports import, because two definitions of
  "has the reviewer written anything" is how the divergence started. The mock moved first.
- **A three-transport conformance leg for `deleteLocalReview`** — in-process mock, mock over real HTTP, and
  the direct engine on a real repository witnessed through a raw handle over all six local tables. Its
  absence is what let three wire-level divergences ship green.

**Decisions.**
- **`unprocessable`, not `conflict` or `not_found`** — its own docstring in the frozen contract describes
  this exact case: the target exists, its state cannot honour the request, and the caller can put it in one
  that can and retry unchanged.
- **The mock moved to delete drafts; direct was right.** "Drafts survive everything" is preserved by the
  refusal, not by orphaning — only an editor-created empty draft can now be removed, which destroys nothing.
- **An unknown id answers `not_found` alike** whether never created, already deleted, or belonging to
  another repository sharing the data directory — a distinguishable answer would confirm an id exists
  elsewhere. **Cost taken:** a "not found" call now has no side effects, so it no longer opportunistically
  tidies refs left by a drop that failed part-way; that belongs to an explicit operator action.

**Deviation, recorded not buried.** M8.10's `Verify` says no file under `packages/shared/src/api/` may be
modified; `client.ts`'s `deleteLocalReview` docstring was corrected, because the ruling made its claim that
drafts are "deliberately left behind" false in both transports. Comment-only — no type, shape, field or
signature moved. Splitting it into its own contract commit is one command if the owner prefers.

**Blockers.** None.

**Next.** **M8.9** — independent and unblocked. Then **M8.11, the real critical path**: it gates **3 of the
6 exit criteria** and has not started.

**update — 2026-09-02**

**Done.** **M8.11 — 8/8, `Verify` green, adversarial pass done, PR [#80](https://github.com/pat-mw/revu/pull/80)**
(base `m8.10/retention-and-gc`; ten commits, one per unit plus two review fix-ups). Gate under `env -u GH_TOKEN
-u GITHUB_TOKEN TZ=UTC`: 2998 pass · 1 skip · 0 fail · 111 files.
- **M8.11.8** (`dc9ede6`) `tsconfig.tools.json` brings `e2e/` + `test/` into `tsc -b`; the control redded in both.
- **M8.11.5** (`61dd0c8`) `resolveHarnessOptions()` pure and tested first; happy path unchanged by a byte.
- **M8.11.7** (`d103c9f`, `2fa60db`) the guide, run-modes, compare-key and security-review pages; `docs-nav` and
  `security-review-claims` guards, both seen red first.
- **M8.11.1** (`75c0025`) the shared local-review suite + leg E; helpers shared with the delete block moved to
  `local-common.ts`; two reds on the mock.
- **M8.11.6** (`d3c1342`) the netlog preload + the local-review e2e; a planted `fetch` failed the run naming the URL.
- **M8.11.2** (`f283358`) leg F over HTTP through the extracted daemon helper; the smoke script gated and its
  four pre-existing rotten checks reconciled by pinning identity.
- **M8.11.3** (`2242f59`) leg G over the real engine, zero remotes, on-disk restart, `fetch` tripwire — **and it
  found the suite wrong on binary blobs**; the suite was corrected.
- **M8.11.4** (`b7bb0b9`) E/F/G required in the matrix; seen to exit 1 naming them.
- **Review fixes** (`025a8a0`) duplicate reply id, reaction re-read, `store.reload()` for both mock restarts,
  token scrub, teardown guard.

**Decisions.**
- **Started M8.11 before M8.9** on the handover's instruction (it gates three criteria; M8.9 gates none). The
  docs describe archiving as designed-not-yet-wired; M8.9 flips two paragraphs to present tense.
- **The runner declares its compare shape** (`'empty' | 'changes'`): the mock's local sync is deliberately the
  empty compare and the mock is the spec, so "non-empty files" cannot be a shared assertion. Real assertions
  in both branches.
- **No adapter for the direct leg**: the suite's mapped api type accepts synchronous answers (the delete
  block's shape); `tsc -b` is the bridge.
- **A binary blob is stored collapsed** (`binary: true`, true `size`, `content: ''`) — now pinned by the suite.
- **The mock store has `reload()`** so a mock restart proves persistence rather than a second handle.

**Blockers.** None.

**Next.** **M8.9** (archive on PR appearance — independent, ruling 2 settled the trigger, OQ1/OQ8/OQ9 open),
then **M8.12**. Follow-ups on the board: `scripts/` into `tsc -b`; `Bun.fetch` unwrapped by the netlog guard.

# M8 — implementation roadmap

Five sessions, one linear PR chain up from `main`, and one idea driving the shape: **the chain order is
derived from verified file ownership, and everything else is width inside it.** The app surface settles
before [M8.8](./tickets/M8.8-resync-and-pinning.md)'s and [M8.9](./tickets/M8.9-archive-on-pr.md)'s app-side
units append to it; the store settles before retention deletes from it; `direct-api.ts`/`direct-router.ts`
are touched in one strict order — so every rebase in the stack is mechanical by construction, and the human's
only job between sessions is merging and ruling. Boundaries are drawn only where a ruling must land or a
proof must be inspected; parallelism lives in waves and, for the one genuinely package-disjoint pair of
sessions, in running them concurrently on two machines.

[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) governs how every session behaves — this file never restates
it. [`MILESTONE.md`](./MILESTONE.md) defines done. [`BOARD.md`](./BOARD.md) is live state and wins over
everything, including this file's assumptions about what has landed.

## The plan at a glance

| session | name | tickets | boundary reason (why it *ends*) | exit condition (compressed) |
| --- | --- | --- | --- | --- |
| S1 | The spec | [M8.1](./tickets/M8.1-contract-and-mock.md) (+ Spike B) | **Verification gate** — the frozen-contract extension proven before 60+ units conform to it (D6); also the fork point for two parallel sessions and the human's cheapest contract-ratification moment | `m8.1` PR open, conformance matrix green with zero diff to `suite.ts`, M8.1.7's route↔adapter bijection + pinned 19-pair table green, invariant tests unamended, the three absence controls Logged, recorded `?mock=1` walk with zero `/api/*` requests, decision package #1 seeded in HANDOVER.md |
| S2 | The app, whole | [M8.6](./tickets/M8.6-app-creation-flow.md), [M8.7](./tickets/M8.7-app-local-chrome.md) | **Verification gate** — the entire feature visible and proven under `?mock=1` before any daemon exists; the chrome sweep observed RED before it is trusted | `m8.6`+`m8.7` PRs stacked, both harnesses (M8.6.7 shim, M8.7.10 static-render) landed first with self-tests green, chrome-sweep test seen red-then-green, the negative-control ledger Logged, four KEEP files proven untouched by M8.7, recorded walk: no `#1000000001`, tab strip Conversation·Files·Commits (the rate-chip and author-banner legs were amended out 2026-08-14 — see the S2 exit condition) |
| S3 | The daemon core | [M8.2](./tickets/M8.2-store-v4.md), [M8.3](./tickets/M8.3-local-snapshot-builder.md), [M8.4](./tickets/M8.4-local-write-sink.md), + M8.8.1/M8.8.2 | **Human decision** — decision package #1 (M8.5 OQ1, M8.8 OQ2, M8.10 OQ1–OQ3, M8.2 OQ1's behavioral half) must be ruled before the join session shapes options around it | three PRs stacked, v3→v4 migration byte-identical proof, M8.2.7's containment tripwires armed as a permanent assertion, injection gate with empty arg sink, both D7 guards (M8.3.8, M8.4.6) observed red-then-green, full local write loop + draft-survival matrix green, pin-ref legality proven against real git |
| S4 | The join + hardening | [M8.5](./tickets/M8.5-daemon-wiring.md), [M8.8](./tickets/M8.8-resync-and-pinning.md) (rest), [M8.10](./tickets/M8.10-retention-and-gc.md), + M8.11.1/.5/.7/.8 | **Human decision + verification** — M8.9's rulings (OQ1/OQ2/OQ4/OQ8) needed next; the headline offline proof, the pinning control, and the retention sweep must be inspected before the milestone-proof session builds gates on them | `local-reviews-serve` green offline, `mode-select` zero-diff + the fourth-mode tripwire proven by its control, prune-survival green **with M8.8.8's swallowed-`update-ref` control asserting its named red as a permanent test**, M8.10.7's in-flight gate green before retention wires a caller, retention sweep zero throws, three more PRs |
| S5 | Archive + the proof | [M8.9](./tickets/M8.9-archive-on-pr.md), [M8.11](./tickets/M8.11-conformance-e2e-docs.md) (rest) | **Milestone exit** — every criterion in MILESTONE.md ticked against the run that proves it | matrix exit 0 with `[E][F][G] PASS` required, e2e netlog empty **with the guard's installed-marker present**, all five negative controls observed red and reverted, archived re-sync behavior pinned (M8.9.7), `env -u GH_TOKEN -u GITHUB_TOKEN bun test` green, eleven PRs in one chain |

```
one machine   S1 ──► S2 ──► S3 ──► S4 ──► S5          (serial depth 5)

two machines  S1 ──┬─► S2 (packages/app only)  ──┐
                   └─► S3 (packages/revud only) ─┴─► S4 ──► S5    (serial depth 4)

S2 ∥ S3 is real: zero shared files (§3 — "can run concurrently all day"); whichever finishes
second splices both lanes into the chain before opening PRs (§6). S4 and S5 strictly cannot
overlap anything: each consumes rulings its predecessor's handover requests, and S5's matrix
legs run against the assembled chain head.
```

**The chain, fixed here so no session relitigates it:**
`main` → `m8.1` → `m8.6` → `m8.7` → `m8.2` → `m8.3` → `m8.4` → `m8.5` → `m8.8` → `m8.10` → `m8.9` → `m8.11`
— each PR based on the previous, one ticket per PR, merged base-up by the human. A ticket's PR opens **the
moment its Verify runs green**, mid-session, never batched at session end — that is what keeps a dead
session's handover small.

## Why this slicing

Three framings were argued and judged; all three judges picked the stack-linear plan, and this roadmap is
its spine with the panel's mandatory grafts applied.

**From stack-linear (the winner): the chain order and the boundary discipline.** The order is not a
preference — it is derived from Files lines: M8.8.6/M8.8.7 edit `pr-layout.tsx`, `reconcile-dialog.tsx` and
`state/drafts.ts`, and M8.9.6 edits `inbox.tsx`, `pr-layout.tsx` and `review-bar.tsx`, all files
[M8.6](./tickets/M8.6-app-creation-flow.md)/[M8.7](./tickets/M8.7-app-local-chrome.md) substantially rewrite
— so the app settles low in the chain and every later app edit is an append. Likewise `store.ts` settles at
M8.2 before M8.10's deletes and M8.9.2's archive column, and `direct-api.ts`/`direct-router.ts` are touched
in the strict order M8.5 (M8.5.8's router band-handling included) → M8.8.4 → M8.10.7 → M8.10.6 → M8.9.5,
with M8.9.7 pinning archived-sync behavior behind the last writer. Also kept: the human-decision boundary in front of
M8.9 (its OQ4 — archived `pull.state` vs. the inbox's open-only filters — is a genuine design contradiction
no unsupervised session may resolve), per-session verification gates, and max two-way file contention.

**From max-parallelism: the width, at unit level.** Its serialization critique was correct: package-disjoint
work must not queue. So the app pair and the daemon trio run as *concurrent sessions* (S2 ∥ S3), and unit
frontiers are exploited inside sessions — M8.3.6 starts beside M8.3.1; M8.3.3/.4/.5 run three-wide against
fixture SHAs; M8.8.1/M8.8.2 run at their real frontier (after M8.2+M8.3, ahead of M8.5, exactly as M8.8's
"Why the Depends row" note records) inside S3; M8.11.1/.5/.7/.8 run as a side lane in S4 so the closing
session keeps only four M8.11 units. Also kept verbatim: its observed-RED exit-condition style — every guard
rail (M8.1.7's pinned route table, M8.4.6, M8.7.6, M8.8.8's swallowed-`update-ref` control, M8.11's five
negative controls) appears in an exit condition as *seen red, reverted, failure text in the Log* — or, where
the audit converted a one-time revert into a permanent paired control, as that control resident in the gate —
never merely "green". The full per-session ledger is in *Test-first discipline* below. Dropped: its 41-unit
six-ticket first session (all three judges called it the soft centre — a mid-flight death there costs more
than the cold starts it saves), its five-way `local-sync.ts` fan-out (M8.3 sanctions three), running M8.4.6
concurrently with the verbs it must precede, and its absorption of ~8 owner calls as merged implementer
decisions.

**From risk-first: the audit and the coupling.** Its collision-map corrections are encoded into the wave
design: M8.8.3 and M8.8.4 both write `reconcile.ts` (sequenced, despite the ticket calling units 3–7
disjoint); M8.7.3/.4/.5/.6/.8 all write `lib/mode-copy.ts` (the orchestrator owns that file — workers return
copy functions, one writer integrates); M8.2.2–.5 share `store.test.ts` as well as the `DirectStore` append
(worktrees + own describe blocks). This roadmap adds a fourth the panel missed: **M8.9.1 and M8.9.3 both
list `local-archive.ts` in their Files lines** despite M8.9's "disjoint files" claim — they are sequenced,
not parallel. Also kept: M8.8+M8.10 in one warm head (M8.8.1's directory-position namespace is the recorded
answer to M8.10 OQ5, ref deletion is wholly M8.10.2's, and M8.8 OQ4 is only decidable with M8.10 in scope —
a cold start between them is how the same ref deletion gets built twice), guard-rails-before-guarded-code as
a standing rule, explicit fable-tier assignments, and Spike B (the throwaway `tsc` probe of M8.5.4's
boot-relaxation ripple). Dropped: Spike A (M8.8's Context table already records the git facts, hand-verified
at 2.50.1 — all three judges), and its app-last sequencing (which put M8.8's app-side units below M8.7's
rewrite of the same files — the exact semantic rebase the chain order exists to kill).

**Where the judges disagreed, the calls made here:**

- *The M8.5 boundary.* Judge 3 wanted a cold-start gate between M8.5 and the hardening; Judge 2 called that
  "a wave boundary dressed as a session boundary". Sided with Judge 2: M8.5.7's offline proof is a **hard
  in-session gate** inside S4 (no hardening unit that builds on the serving path dispatches before it runs
  green) — prove-before-build needs an ordering, not a cold start, and the PR opens mid-session so the human
  still inspects the proof.
- *Session count and the first session's size.* Judges 1–2 grafted the dual lane into one session; all three
  scored the resulting 41-unit monolith down. Resolved by making the lanes two **concurrent sessions**: full
  concurrency on two machines, small blast radius and lane-level failure isolation always (a §5 stop in the
  daemon lane no longer strands fifteen app units behind one dead orchestrator).
- *M8.8's frontier.* Judge 1 wanted units 1–3 ahead of M8.5; M8.8 OQ2 gates unit 3. Split the difference:
  .1/.2 run in S3 at their true frontier; .3 waits for the ruling and runs first thing in S4.
- *M8.11's early units.* "The session before the final proof" — that is S4, and they run there as a side lane.

**Owner calls are harvested, not absorbed.** HANDOVER.md carries a standing **Rulings** section: S1 seeds
decision package #1 (everything statable from the tickets today), S3's exit confirms it complete with
candidates and costs, S4's exit finalizes package #2. Each session's preconditions name the rulings it
consumes; a session entered without them treats the affected units per §5 rather than deciding. A small
pre-flight list (defaults applied and Logged if unruled) covers the copy-level calls that cannot wait:
M8.7 OQ1 → redirect omitted-tab routes to `files`; M8.7 OQ4 → drop the author row, `base ← head` carries it;
M8.7 OQ5 → suppress the banner (the `?queue=1` and palette walk-threads paths survive; flagged for owner);
M8.7 OQ8 → "N comments recorded on this local review"; M8.6 OQ2 → omit the empty section, keep header +
zero-state entry points; M8.3 OQ2 → `-uno` (tracked modifications only); M8.3 OQ4 → the builder lives in
`direct/` (D7's protection is M8.4.6's import-graph test, not a directory name).

Two directives this roadmap issues as author, fixing hazards the tickets leave open and a judge flagged:
**(1)** M8.2 adopts the `meta` high-water mark for local-review ids (M8.2 OQ3's own recommendation — one row
in a table M8.2.1 already touches) — this dissolves M8.10 OQ4's "do not start until settled" precondition
and the entire id-recycling bug class. **(2)** M8.2.1's DDL carries a generation discriminator in the unique
key (`UNIQUE(repo, base_ref, head_ref, generation)`, generation `0`, mint returns the existing
**non-archived** row) — the schema can then express *either* answer to the §4.2-vs-§8-case-22 contradiction
(successor-mint or one-way door) without a migration, and the behavioral half is ruled by the owner in the
decision package, not baked into DDL by an unsupervised wave.

## Test-first discipline

[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) §4 governs and is not restated here; this section says what
it does to *this plan's* shape. Three consequences are structural:

**Harnesses are waves, not chores.** A test that cannot import its subject can never be red for the right
reason, so the audit's harness units open their sessions: S2's W1 is M8.6.7 (the guarded `location` shim
that makes the query layer and the pages importable under `bun test` at all) beside M8.7.10 (the
static-render harness whose self-test proves portal content is *invisible* — the difference between an empty
string that means "hidden" and one that means "broken", which every later `not.toContain` depends on
knowing); S3's W1 is M8.2.7 (the PR-keyed tripwire harness, armed against *today's* store), M8.3.8 (the
seeded real-git fixture harness plus the D7 structural guard) and M8.4.1's key-set test written before its
module; M8.4.8 lands ahead of its number as the harness the write verbs are written against; M8.11.8 brings
`e2e/` and `test/` into `tsc -b` before any unit writes files there.

**Guard rails are predecessors, not integration steps.** Wherever the audit ordered a test before the code
it guards, the wave plan encodes it as a dependency, not a reminder: M8.1.7 completes before M8.1.4 widens
anything — its pinned 19-pair table is the red M8.1.4 observes mid-widening; M8.4.6 still precedes every
write verb; M8.10.7's in-flight-sync gate lands before M8.10.6 wires a caller; M8.5.8's broker-gate case is
red before its router edit; M8.8.8 carries the prune-survival control as a permanent second test rather than
a one-time break-and-revert.

**Negative controls are exit conditions.** Every assertion of an absence now names either a permanent paired
control in the same file or a break-observe-revert recorded in the ticket Log — and a unit whose required
red or control observation is missing from the Log is not done, whatever color its Check is. Where each
session's observed-RED moments live:

- **S1** — M8.1.3's `migrateStoreDocument` test written against a v:2 document before the seam exists;
  M8.1.7's pinned table red mid-M8.1.4; the three absence controls (the `**Name** (role)` stamp, the
  no-network walk, the shadow sweep) broken, observed, reverted, Logged.
- **S2** — the chrome sweep red on the re-added literal; M8.7's eight break-observe-revert pairs (its
  Verify's negative-control ledger); M8.6's in-file positive controls beside every absence assertion.
- **S3** — M8.2.7's three armed throws, permanent; M8.3.8's structural guard red on the pre-M8.3.1 tree;
  M8.4.6 red with the `github-client` import added; M8.3.6's matched pair proving tier 3 *is* reachable
  before trusting that it is skipped; M8.4's four named breaks (.1, .2(b), .6, .9).
- **S4** — M8.5.1's suite red before the dispatch exists; M8.5.5's fourth-mode tripwire proven by its
  control; M8.5.8's broker-gate case red before the router edit; M8.10.7's rejected-sync case (a leaked
  counter looks exactly like a working prune from outside); M8.8.8's control asserting a *named* red
  (`git cat-file -t <headSha>` non-zero with `update-ref` swallowed); M8.11.8's build-graph control.
- **S5** — M8.9's three red-first assertions, and M8.9.4's mandatory negative control (its
  banned-specifier addition lands green, so only the control proves the guard bites); M8.9.7's post-sync
  re-assertion of the four write refusals; M8.11's five negative controls, including the broken suite
  assertion naming its leg and the injected `fetch` naming its URL.

## Session 1 — The spec

**Goal** Land [M8.1](./tickets/M8.1-contract-and-mock.md) — the frozen-contract extension, the mock oracle
(D6), the fixture, and the scenario walk. Everything downstream conforms to what lands here; eight open
questions freeze on merge. Run Spike B in parallel scratch. · **Tickets** M8.1 · **Boundary reason**
verification gate (+ the fork point: S2 and S3 both hang off this) · **Estimated agents** ~10 (7 units,
1 spike, 1 fable pre-merge review, escalation margin).

**Preconditions** — PR #69 (design docs) merged or mergeable; the pre-flight defaults above acknowledged or
overridden by the owner; nothing else.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.1.1 ∥ M8.1.2 ∥ M8.1.7 ∥ Spike B | opus / **fable** / opus / sonnet | none — orchestrator owns the one shared `packages/shared/src/index.ts` barrel line | .1 and .2 are declared independent (no shared symbol); M8.1.2 is fable because it settles the `ApiErrorCode` question — the single place §5.2 can fire. **M8.1.7 is the guard rail, landed first (before M8.1.4, per its own ordering note)**: the ROUTES↔adapter bijection over both `RevuApi` implementations, the pinned literal table of the 19 existing method+path pairs, and the mock-mode dispatch sweep driving `handleApi` directly with a recording MockBundle — a mock-driving file, so `mockDev.reset()` in `beforeAll`; it needs nothing new, pins today's surface, and becomes the red M8.1.4 observes. Spike B: throwaway `tsc` probe of `DirectContext.github` going typed-absent; deliverable is the break count with a three-way classification, written to HANDOVER.md, never committed |
| W2 | M8.1.3 | **fable** | none | the oracle — its semantics *are* the contract (D6); thread-id shape (OQ8) and D-b freeze here; the exported pure `migrateStoreDocument()` seam is written test-first against a v:2 document — observed red before the seam exists, so the red is real |
| W3 | M8.1.4 | opus | none | the atomic widening — deliberately one commit, red at four sites mid-unit; M8.1.7's bijection and pinned table are the red it works against, and the table is updated in the same commit as the widening |
| W4 | M8.1.5 ∥ M8.1.6 | sonnet / opus | none — disjoint files | both depend on .4, independent of each other; both drive the shared mock store — `mockDev.reset()` in `beforeAll`, non-negotiable |

**Integration** — run M8.1's full Verify (matrix with zero `suite.ts` diff; insertions-only diff on
`client.ts`/`http.ts`; `draft-isolation` + `token-custody` green with zero edits; the recorded `?mock=1`
walk with the network tab empty; `http-contract` round-trips; the three absence controls each carrying
their in-file positive control or a break-and-revert recorded in the Log). Fable pre-merge review (§8). Open the `m8.1`
PR off `main`. Prepend HANDOVER.md: Spike B finding + decision package #1 seeded — **M8.5 OQ1** (how the
local-only capability is switched on; candidates: explicit flag/env vs automatic-on-resolution-failure;
recommend explicit — automatic turns a transient `gh` failure into a silently local-only daemon),
**M8.8 OQ2** (does the commit-delta rewrite land on the shipped GitHub PR path, rewriting
`reconcile.test.ts:428`; recommend yes — the shared-reconcile hard constraint forbids a local-only fork, so
"no" is a §5.1 finding, not an option), **M8.10 OQ1/OQ2/OQ3** (blob prune default **off**; prune runs only
inside `deleteLocalReview`; delete-with-unsubmitted-draft refuses without an explicit force — the confirm
dialog is new scope, appended to the board), **M8.2 OQ1 behavioral half** (successor-mint vs one-way door on
an archived triple — schema hedge already directed, needed before S5).

**Exit condition** — `m8.1` PR open, `bun run check` green; `bun run conformance:matrix` exits 0 **and**
`git diff main -- packages/shared/conformance/suite.ts` is empty; M8.1.7's bijection, pinned method+path
table and mock-dispatch sweep green at the tip, with the table's mid-M8.1.4 red recorded in the Log; the
shared `http.test.ts` pinning the three copies of the `ApiErrorCode` union green; both invariant tests
green unamended; the three absence controls observed and Logged; the `?mock=1` walk (create → sync →
comment → submit → reply → resolve on the fixture) recorded in the Log with zero `/api/*` requests;
HANDOVER.md carries Spike B + package #1.

**Stop risks** — §5.2 at M8.1.2: `same_ref`/`unrelated_histories`/`shallow_clone` fit into `conflict` or
**exactly one** new code (+ `validateHttpErrorBody`'s `vLiteral` list + the status map at `http.ts:162` —
the audit's corrected anchors; `vApiErrorCode` does not exist); a second code stops. §5.4 at
M8.1.3/.5/.6/.7: the process-wide `localStorage` Map — order-dependent red on CI reads as a flake; never loosen
`scenarios.test.ts:61`. §5.1 at M8.1.5: D-a moves the two count assertions deliberately — a handover must
say they moved by design, not by accident. §5.8 at OQ3: a `default` marker on `BranchRef` growing into
per-human state → `HumanPreferences` → a bigger contract change; stop and append.

## Session 2 — The app, whole (∥-eligible with S3)

**Goal** The entire app surface against the mock alone: creation flow + inbox
([M8.6](./tickets/M8.6-app-creation-flow.md)), then mode chrome + copy correctness
([M8.7](./tickets/M8.7-app-local-chrome.md)). The whole feature is clickable and provable under `?mock=1`
with no daemon, no git, no token, no network — the owner sees pixels four sessions before the daemon serves
them. · **Tickets** M8.6, M8.7 · **Boundary reason** verification gate (chrome sweep observed RED; the
`?mock=1` walk corroborates it) · **Estimated agents** ~21.

**Preconditions** — `m8.1` PR open with Verify green (merge not required — stack off it). Pre-flight
defaults for M8.6 OQ2 / M8.7 OQ1/OQ4/OQ5/OQ8 in hand. On two machines this session runs concurrently with
S3; it works off `m8.1` and its PRs open in chain position (`m8.6` on `m8.1`, `m8.7` on `m8.6`) —
no splice needed, the app pair sits directly above M8.1 in the chain.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.6.7 ∥ M8.7.10 | opus | none — `test/preload.ts`+new `api/select.test.ts` / new `lib/render-test.ts`+self-test | **the two harnesses, first — nothing render- or query-shaped is assertable without them.** M8.6.7's guarded `location` shim is what makes `@/api`, the query layer and the pages importable under `bun test` at all (the existing 60-file suite must stay green, verified); M8.7.10's static-render harness self-tests against components that exist today, including the executable proof that portal content is invisible — the hidden-vs-broken distinction every later `not.toContain` depends on |
| W2 | M8.6.1 ∥ M8.6.2 | opus | none | declared independent; .1 claims the app's **single** `isLocalReviewId` call site — the sentence M8.7.4's scan later enforces; .2's await-before-navigate landmine (`invalidateQueries` refetches nothing without a mounted observer) now has a test distinguishing the two verbs |
| W3 | M8.6.3 ∥ M8.6.4 | opus | none — new dialog file vs `inbox.tsx` | the two biggest commits, mutually independent; .3 splits the portal-free `CreateLocalReviewForm` out of the dialog (a Radix `DialogContent` static-renders to `''`); .4 extracts `lib/inbox-sections.ts` and `rowIdentity()` so double-listing and the identity slot are properties of pure functions, and asserts the two frozen seams (zero-total checks rollup, `branchPair`) against the M8.1.5 fixture |
| W4 | M8.6.5 ∥ M8.6.6 | opus | **worktree** — both edit `inbox.tsx` (different regions; trivial merge expected) | .5 needs .3's dialog (keyboard gating now assertable through the extracted sections); .6 needs only .1 |
| W5 | M8.7.1 | opus | none | gates every other M8.7 unit; consolidates `matchPrNumber`; its durable source-scan guard lands with this first unit, before its eight consumers exist (the token-custody.test.ts precedent); touches `palette.tsx` after M8.6.5 settled it |
| W6 | M8.7.2 ∥ M8.7.4 ∥ M8.7.9 | opus | none — `pr-layout.tsx`+`palette.tsx`+`App.tsx` / `conversation.tsx` / `threads.ts`; orchestrator owns `lib/mode-copy.ts` | the `pr-layout` chain starts (.2 first per ticket order — its tab assertion is now a real render through M8.7.10's harness with a negative control, not a `grep -c`) while the two independent units run beside it |
| W7 | M8.7.3 ∥ M8.7.5 | opus | none — `pr-layout.tsx` (after .2) / `review-bar.tsx`+`reconcile-dialog.tsx`; copy functions returned to the orchestrator | mode-copy contention (the tickets' own blind spot) is dissolved by single-writer integration, not worktrees |
| W8 | M8.7.6 | opus | none | the residual sweep + the sweep test — after .3/.4/.5 centralized the strings; per-file `existsSync` guards so a rename cannot rot it into a green run over nothing; touches `pr-layout.tsx:154-157`, so it cannot ride beside .8 |
| W9 | M8.7.8 | opus | none | dirty banner in the author-banner slot — last `pr-layout.tsx` writer |
| W10 | M8.7.7 | sonnet | none | the closing proof: github-mode literals pinned `toBe`, rendered assertions on all four seal staleness branches, and the required-literal scan for the tooltip sentences that provably cannot be rendered — the durable replacement for the old `git diff --stat` eyeball (see the exit condition) |

**Integration** — after M8.6's Verify (its single command over all seven M8.6 test files; observed-red and
control observations in the Log): fable review, open `m8.6`. After M8.7's Verify (led by its
negative-control ledger — eight break-observe-revert pairs, each Logged; a unit whose control was not
observed is not done): sweep test observed RED (re-add `logs live on github.com`, run, revert — failure
text in the Log), fable review, open `m8.7`. Record the full `?mock=1` walk (M8.7 Verify 3–5) in the Log —
corroboration beside the rendered assertions, never their substitute.

**Exit condition** — both PRs open and stacked; `bun run check` green at the `m8.7` tip; both harness
self-tests green (M8.6.7's `api/select.test.ts` with the pre-existing 60-file suite untouched; M8.7.10's
portal-invisibility assertion); `bun test packages/app/src/lib/chrome-sweep.test.ts` green **and observed
red once**; M8.7.7's rendered assertions on all four seal staleness branches and its required-literal scan
green — the audit replaced its `git diff --stat main` Check with these, so the diff survives only as
corroboration and only against the `m8.6` tip, **not** `main`: M8.6.2's key-factory append and M8.6.5's
chord catalog entry legitimately touch two of the four KEEP files
(`packages/app/src/state/queries.ts`, `lib/shortcuts.ts`, `components/review/head-moved-dialog.tsx`,
`components/review/error-copy.ts`), so the `main`-based form is unsatisfiable on the chain — what is proven
is that **M8.7** changed nothing there; `failure-drills.test.ts` green unamended; all eight
break-observe-revert pairs in the Log; recorded walk shows tab strip
Conversation · Files · Commits, `base ← head` + local chip, `document.body.innerText` containing no
synthetic id; duplicate creation navigates to the same id with one inbox row.

**Amended 2026-08-14 by the owner's rulings** (see [`HANDOVER.md`](./HANDOVER.md)'s top entry and M8.7's
`## Rulings` section — the rulings win over this file):

- **"no rate chip" leaves the recorded walk.** Suppression is workspace-scoped, not route-scoped, and under
  `?mock=1` the workspace genuinely has GitHub — so the chip legitimately renders on the fixture local review
  and asserting its absence there would be asserting a falsehood. Replaced by the in-gate predicate assertion
  on `showRateChip({ rateAvailable })` in both states, plus the loading-vs-unavailable distinction that makes
  the chip omit rather than skeleton forever.
- **"no author banner" leaves the recorded walk.** The author row renders the local human plainly, and the
  Walk-threads action survives under local copy — only the "You authored this PR" framing is suppressed. The
  walk instead confirms the banner slot renders its stack in order (superseded → dirty → walk threads) with
  no PR framing in any of them.

**Stop risks** — §5.1 across M8.7's owner calls: any resolution implying §4.1's field table is wrong is a
finding. §5.8 at M8.6.2/OQ7: "remember my last base branch" → `HumanPreferences` → frozen-contract change;
append and continue without it. §5.3 at M8.7.6: the sweep must scan source without tripping on docstrings —
`audit-integrity.test.ts:116-125` is the only proven shape. §5.4: mock-store leakage (three new mock-driving
files this session), and `bun test` has no `window.location` — M8.6.7's shim must stay guarded; if the
pre-existing suite moves, that is a finding, not a fix-up. Handover if it dies: which `pr-layout.tsx` writer
was in flight (the W6–W9 chain is the only sequenced thing here) and which mode-copy functions the
orchestrator holds unintegrated.

## Session 3 — The daemon core (∥-eligible with S2)

**Goal** The three mutually independent daemon pieces, each proven alone: the `local_*` store
([M8.2](./tickets/M8.2-store-v4.md)), the git-only builder ([M8.3](./tickets/M8.3-local-snapshot-builder.md)),
the write sink ([M8.4](./tickets/M8.4-local-write-sink.md)) — plus
[M8.8](./tickets/M8.8-resync-and-pinning.md).1/.2 at their true unit frontier. Harnesses and armed guards
land in wave one, hazard-bearing seams in wave two, and every guard rail is red-then-green **before** the
code it guards. · **Tickets** M8.2, M8.3, M8.4
(+ M8.8.1, M8.8.2) · **Boundary reason** human decision — package #1 must be ruled before S4 shapes
M8.5.4's option and rewrites `reconcile.test.ts:428` · **Estimated agents** ~32.

**Preconditions** — `m8.1` open with Verify green. Directives in hand: high-water-mark minting; generation
discriminator in the unique key; builder lives in `direct/`; dirty = `-uno`. On two machines this session
runs concurrently with S2 **working off `m8.1`**, and owns the splice: before opening PRs it rebases `m8.2`
onto the `m8.7` tip (mechanical — zero shared files); if S2 has not produced `m8.7` yet, the three PRs wait
in the handover as ready-to-open, bases named.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.2.7 ∥ M8.3.8 ∥ M8.4.1 | opus | none — `store.test.ts` (the tripwire helper lives inside it) / new `local-fixture-repo.ts` + the D7 structural guard / the D7 port | **guards and harnesses before anything they guard exists.** M8.2.7 arms the PR-keyed `RAISE(ABORT)` tripwires against *today's* store, before a single `local_*` table exists — the containment negative control becomes a permanent assertion, not a one-time revert; M8.3.8 lands the seeded real-git fixture harness (self-tested — a fixture that silently fails to seed a case turns every downstream assertion green forever; gitlink via `update-index --cacheinfo`, since `submodule add` on a file path fails) plus the D7 structural guard **observed red on the pre-M8.3.1 tree**; M8.4.1's exact `LocalWriteDeps` key-set assertion is written before the module it describes. The harness spawns git only as test-side fixture seeding — production code still shells out through nothing until M8.3.1 lands |
| W2 | M8.2.1 ∥ M8.3.1 ∥ M8.3.6 ∥ M8.4.6 | opus / **fable** / opus / opus | none — four disjoint file sets | the seams, one per hazard: the v4 DDL (both directives applied; the in-place ladder step re-seeding the high-water row is now asserted, not assumed — otherwise every migrated workspace hits the allocator with no row), the injection defense (fable — every later *production* unit shells out through it), the optional-`github` blob change with its matched D7 pair (tier 3 skipped **and** provably reachable via a throwing `github`), and **M8.4.6 red-then-green here, before a single write verb exists** — the guard-first rule, applied |
| W3 | M8.2.2–M8.2.5 ∥ M8.3.2 ∥ M8.4.8 | opus ×4 / opus / opus | **worktree** on the M8.2 four (shared `DirectStore` append **and** `store.test.ts` — the tickets' undercounted collision) | the store fan-out is the ticket-sanctioned width, every unit's previously-uncovered Do-work now owned by a named assertion; M8.3.2 resolves refs through the now-landed seam against M8.3.8's fixtures; **M8.4.8 lands ahead of its number** — the in-memory local harness the verb units are written against, whose own Check (`getLocalSnapshot` returns a clone) guards the persistence assertions from passing by aliasing |
| W4 | M8.2.6 ∥ M8.3.3 ∥ M8.3.4 ∥ M8.3.5 ∥ M8.3.7 ∥ M8.4.2 | opus ×6 | **worktree** on the M8.3 trio (the sanctioned `local-sync.ts` width, against fixture SHAs) | the full D4 containment sweep on top of W1's armed tripwires (needs .2–.5); the three-wide builder fan-out (M8.3.4 split into its revud-side structural guard + the app-side `diff.test.ts` half — revud structurally cannot import `parsePatch`); `listBranches` (needs only M8.3.1); the allocator with its behavioral statelessness assertion (a fresh fake must restart at its own base) |
| W5 | M8.4.3 ∥ M8.4.4 ∥ M8.4.5 ∥ M8.3.9 | opus ×4 | **worktree** on the M8.4 trio (`local-writes.ts` — the sanctioned width) | the write verbs, written against M8.4.8's harness; M8.3.9 closes M8.3's lane with the offline half of its Verify §5, driving the GitHub producer through the exported `syncPull` (`fetchImmutable` is module-private) |
| W6 | M8.4.7 ∥ M8.4.9 | opus | none | the optimistic-convergence pinning (needs .3–.5); M8.4.9 — the full submit→reply→resolve→react loop and the draft-survival matrix across every non-success outcome — the two Verify items that previously had no owner |
| W7 | M8.8.1 | **fable** | none | the pin seam at its real frontier — needs M8.3 only; fable because the ref-namespace shape is the recorded answer to M8.10 OQ5 and the `..`-rejection subtlety is where a cosmetic-looking substitution is load-bearing |
| W8 | M8.8.2 | opus | none | pin **before** the first object read — edits `local-sync.ts` after M8.3 fully settled it; ordering asserted with a recording runner, not a was-it-called check |

**Integration** — per-ticket Verify as each completes, PR opened immediately: the real v3→v4 in-place
migration on a file already holding a draft/viewed/audit/pr_author row (all four byte-identical,
`sqlite_master` unchanged for the seven v1–v3 tables); M8.2.7's three armed checks resident in the gate
(`putSnapshot` / `appendAudit` / `recordPrAuthor` each throwing `StoreWriteError` under the tripwires,
`openDirectStore` still booting) with their one-time reds in the Log; the injection acceptance gate
(payload rejected before any `runner.run`, arg sink empty, no file on disk); both D7 reds Logged —
M8.3.8's structural guard on the pre-M8.3.1 tree and M8.4.6's with the `github-client` import added,
failure messages in the Log, then green; M8.4.9's loop and draft-survival matrix green over M8.4.8's
clone-guarded harness; M8.8.1's Check (real
`check-ref-format`: exit 0 on `pinRefsFor` output, exit 1 on the design's literal form). M8.8.1/.2 commits
sit on `m8.8` branched off the `m8.4` tip — **no PR yet**; board In-flight and handover name them exactly.
Fable reviews ×3. Handover: package #1 confirmed complete, with the as-built schema shape attached so the
owner rules on facts.

**Exit condition** — `m8.2`/`m8.3`/`m8.4` PRs stacked (or ready-to-open pending splice), `bun run check`
green at the `m8.4` tip; `bun test -t 'local writes never touch'` green in isolation **with M8.2.7's
tripwires still armed** — the armed proof is a permanent assertion, not a Log memory; migration proof,
injection gate, and both D7 red-then-greens recorded in ticket Logs; M8.3.8's fixture self-test and
M8.3.9's offline GitHub-producer leg green; M8.4.9's loop and draft-survival matrix green; M8.8.1/.2 green
on `m8.8`; decision package #1 complete in HANDOVER.md.

**Stop risks** — §5.1 at M8.2.1: if even the generation-discriminator hedge cannot reconcile §4.2 with §8
case 22, that is a design finding — stop, do not amend §8. §5.3 at M8.3.3/.4: the plumbing parsing
(three-field rename records, the empty third numstat field, per-file patch slicing at the first `@@`) is the
likeliest top-tier Check failure. §5.4 at M8.3.8/.5/.7: CI has no git identity — every fixture commit (the
harness's own included) passes
`-c user.email -c user.name -c commit.gpgsign=false` or the suite is green locally and red on CI; and
identity is not isolation — the harness's exported env pins `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at
nonexistent paths (M8.10.2's recipe, adopted at M8.3.8) so a developer's `diff.external`/`log.showSignature`
cannot flip the gate in either direction. §5.5 at
W3–W5: the three sanctioned fan-outs are the only places a semantic (not append) conflict can appear; if two
workers restructured the same helper, that is a decision, not a rebase. §5.7 at M8.4.6/M8.2.7: a guard rail
that cannot be made to bite is decorative — stop rather than ship it soft.

## Session 4 — The join + hardening

**Goal** Wire the daemon ([M8.5](./tickets/M8.5-daemon-wiring.md)), prove the milestone's headline exit
criterion **in-session**, then land pinning/rebase-safety ([M8.8](./tickets/M8.8-resync-and-pinning.md).3–.8)
and retention ([M8.10](./tickets/M8.10-retention-and-gc.md)) in the same warm head — with
[M8.11](./tickets/M8.11-conformance-e2e-docs.md).1/.5/.7/.8 as a dependency-free side lane. · **Tickets**
M8.5, M8.8 (rest), M8.10, M8.11 (units 1/5/7/8) · **Boundary reason** human decision (M8.9's rulings) +
verification (offline proof, pinning control, retention sweep — inspected before the proof session) ·
**Estimated agents** ~31.

**Preconditions** — S2 + S3 PRs open and spliced into the chain; **rulings present**: M8.5 OQ1 (shapes
M8.5.4's option before it is written), M8.8 OQ2 (before M8.8.3 rewrites `reconcile.test.ts:428` — the
point of no return; entering without it means M8.8.3 does not dispatch), M8.10 OQ1/OQ2/OQ3. Spike B's
classification in hand for M8.5.4.

**Waves** — hard rule: **no unit that builds on the serving path dispatches before W5's gate is green.**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.5.1 ∥ M8.5.4 ∥ M8.10.2 ∥ M8.10.3 ∥ M8.11.1 ∥ M8.11.8 | opus ×6 | none — `direct-api.ts` / `context.ts`+`session.ts` / new `retention.ts` / `store.ts` / new shared suite / new tools tsconfig | M8.5.1's suite is written red before the dispatch exists; M8.5.4 is declared fully independent of .1–.3; M8.10.2/.3 are pure primitives needing only M8.2 — and M8.10.2's leg (d), the reflog-expire + `gc --prune=now` recipe, is the repo's first real-`git`-spawning test (isolation recipe in the stop risks); M8.11.1 now carries leg E's mock runner, so the shared suite is **executed and gating from the commit that creates it**, never a module without a runner; M8.11.8 brings `e2e/` + `test/` into `tsc -b` **before** any unit writes files there |
| W2 | M8.5.2 ∥ M8.5.3 ∥ M8.10.1 ∥ M8.8.3 ∥ M8.11.5 | opus ×4 / sonnet | **worktree** on M8.5.2/.3 (both append the `direct-router` dispatch chain — sanctioned trivial merge); M8.10.1 sequenced after W1's M8.10.3 in `store.ts` | M8.8.3 (shared reconcile + the **real** mock driven through `@revu/app/mock` — the hand-transcribed oracle cannot prove parity — with `mockDev.reset()` in `beforeAll`, ruling in hand) touches `reconcile.ts` alone this wave — M8.8.4 must not ride beside it (corrected collision); M8.11.5's harness decision extracted to a pure `resolveHarnessOptions()` with its predicate test written first |
| W3 | M8.5.5 ∥ M8.5.8 ∥ M8.10.4 ∥ M8.11.7 | opus ×3 / sonnet | none — `index.ts`+new `local-boot.test.ts` / `direct-router.ts` (after W2's dispatch writers) / retention / docs | boot assembly (discovered toplevel, never `context.cwd`) around the three exported seams, its fourth-mode tripwire proven by its negative control; **M8.5.8's broker-gate case lands red before its router edit** — the reads-only write gate 501ing a local-id write, `addReaction`'s band input reading the value the router validated, the id ceiling asserted rather than assumed; immutable prune over W1's live-key read with no-TTL asserted (a live-but-stale immutable survives while a fresh orphan goes); docs with the nav + security-claims guards in-gate |
| W4 | M8.5.6 ∥ M8.8.5 ∥ M8.10.5 | opus | none — router+api / `local-sync.ts`+new test / retention | honest degradation; deleted-ref survivability (the no-deletion invariant promoted from a grep to a runtime store-decorator tripwire); blob prune behind its default-off flag |
| W5 | **M8.5.7 — the gate** | opus | none | the offline HTTP proof: full loop over `fetch`, no origin, no token, no network, spoofed-`humanId`, restart-same-id — with the `--preload` fetch tripwire asserting process-level network silence (its residual gap — raw sockets, subprocesses — is a recorded exception, not a claim). M8.5's whole Verify runs here, incl. the manual offline drill (corroboration), and the `m8.5` PR opens |
| W6 | M8.8.4 ∥ M8.8.6 | opus | none — `reconcile.ts`+`direct-api.ts`+new `local-objects-missing.test.ts` / app files (settled by S2) | post-gate both: the objects-missing pre-flight maps `StoreUnreadableError` onto M8.5.1's dispatch **at the API edge** (its Files line carries `direct-api.ts`), so it waits for the gate and for M8.5.6 — preserving the strict `direct-api.ts` order M8.5 → M8.8.4 → M8.10.7 → M8.10.6; its `hasBlob` pre-flight breaks `reconcile.test.ts`'s throwing fake, so the new disjoint test file is required, not optional; the dialog's rewrite copy + D8 proof |
| W7 | M8.10.7 ∥ M8.8.7 ∥ M8.8.8 | opus | none — `direct-api.ts` (this wave's sole writer, after M8.8.4) / `drafts.ts`+`reconcile-dialog.tsx`+new `reconcile-plan.ts` / new prune-survival suite | **M8.10.7 lands the in-flight-sync gate before M8.10.6 wires any caller** — a process-local counter at the `direct-api.ts` seam, deterministic interleave with hand-resolved promises, rejected-sync and nesting cases, no timers; M8.8.7 (after M8.8.6, per the ticket's own sequencing) extracts `planReconcileApply` so the head-mutator-before-submit regression is a permanent pre/post pair rather than a Log note; M8.8.8 owns the prune-survival walk with its control as a **permanent second test** — `update-ref` swallowed → `git cat-file -t <stored headSha>` exits non-zero, a *named* red, not "at least one assertion fails" |
| W8 | M8.10.6 | opus | none | retention wiring + the served DELETE rewriting M8.5.2's pinned 501 case — the session's last `direct-api.ts`/`direct-router.ts` writer, behind M8.10.7's gate, ahead of only M8.9.5 |

**Integration** — M8.8.8's prune-survival suite with teeth: `git reflog expire --expire=now
--expire-unreachable=now --all && git gc --prune=now`, the `blobs`-table-cleared leg, **and the
swallowed-`update-ref` control asserting its named red as a permanent gate resident** (the one-time
observed red still recorded — without the control the suite passes with the
feature absent, because the blob store is cache-forever). M8.10's over-deletion sweep: every row in
`snapshots` and `local_snapshots` resolves through its getter, zero throws — a named helper called at the
end of every prune-shaped test. `mode-select.test.ts` green with
zero diff (the D5 tripwire) **plus** `local-boot.test.ts` green with the fourth-mode tripwire's control
run; `context.test.ts`'s refuse-to-start block unedited; `collector/audit-integrity.test.ts` and
`conformance-reads.test.ts` green unamended (this session puts every non-draft `DELETE` into `store.ts` and
wraps `syncPull`). Happy-path e2e green with
`git diff e2e/happy-path.ts` empty (M8.11.5's no-behavior-change proof); M8.11.8's tools project proven in
the build graph (its negative control observed). PRs `m8.8`, `m8.10` open in chain
order; M8.11.1/.5/.7/.8 commits parked on `m8.11` (no PR — but M8.11.1's leg-E runner and M8.11.8's tsc
project are already gating). Fable reviews ×3. Handover: decision package #2
finalized — **M8.9 OQ1** (detection input; recommend the targeted
`GET /pulls?head=<owner>:<branch>&base=<base>&state=all` per live review — exact, catches closed/merged,
costs one request per review), **M8.9 OQ2** (sweep trigger; candidates: on local sync / on `GET /api/pulls`
with a per-review cooldown / on boot — direct mode has no tick, so "on the poll" means "never"),
**M8.9 OQ4** (archived `pull.state` — amend §4.1 to stay `'open'` with archival carried in
`LocalReviewSummary`, or make the inbox filters archive-aware; both are real changes, the design picks
neither, and S5 does not start without the pick), **M8.9 OQ8** (the different-base copy line), **M8.9 OQ5**
(the PR link on Enterprise — recommend appending a stored-URL follow-up to the board rather than a post-v4
column now), **M8.11 OQ3** (leave M8.1.6's scenario test standalone — it is another ticket's file),
**M8.11 OQ6/OQ7** (no screenshots; archived state proven at unit level only, said in the driver docstring).

**Exit condition** — `m8.5`/`m8.8`/`m8.10` PRs stacked; `bun run check` green at the `m8.10` tip;
`local-reviews-serve.test.ts` green offline incl. restart-same-id-same-draft; `local-boot.test.ts` green
incl. the fourth-mode tripwire with its control observed; M8.5.8's broker-gate red recorded; M8.8.8's
prune-survival suite green **with the permanent swallowed-`update-ref` control asserting its named red**;
`retention.test.ts` green including the sweep and its source-scan legs (dependency allowlist, no-VACUUM —
self-checked so the scanner cannot go vacuous); M8.10.7's interleave, rejected-sync and nesting cases
green; `mode-select` zero-diff; `direct/local-write-isolation.test.ts` still green; manual offline drill
commands in M8.5's Log (corroboration); package #2 in HANDOVER.md.

**Stop risks** — §5.6 at M8.5.4: relaxation is about GitHub preconditions only — anything that also softens
`MissingGitIdentityError` files every human's drafts under one blank id; immediate stop. §5.7 at M8.5.1 /
M8.9-adjacent seams: the local branch must be taken **above** the `writeDeps` bundle; a conditional inside a
shared write function does not satisfy D7. §5.5 at W2/W6/W7/W8: `direct-api.ts`/`direct-router.ts` are
written by eight units across three tickets this session — the strict order above
(M8.5 → M8.8.4 → M8.10.7 → M8.10.6) is the mitigation; a non-append conflict stops. §5.4 at M8.10.2 leg
(d): the repo's first real-`git`-spawning test — `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at a nonexistent
path, identity and `commit.gpgsign=false` via `-c`, or a developer's global signing key decides whether the
gate is green. §5.4 at
M8.5.7: the `REVU_DIST_DIR` stub-dist landmine plus a leaked port reads as a feature failure. §5.8 at
M8.5 OQ6: the headline criterion is not reachable through `bin/revu` — state it is proven against `revud`
directly and append the CLI ticket; do not absorb it.

## Session 5 — Archive + the proof

**Goal** Implement D1 ([M8.9](./tickets/M8.9-archive-on-pr.md)) with its rulings in hand — detection,
sticky non-destructive archival, an ETag that actually moves, the superseded chrome dead-last — then convert
the milestone's intentions into gates ([M8.11](./tickets/M8.11-conformance-e2e-docs.md).2/.3/.4/.6) and walk
the exit criteria. · **Tickets** M8.9, M8.11 (rest) · **Boundary reason** milestone exit · **Estimated
agents** ~15.

**Preconditions** — S4 PRs open; decision package #2 ruled (S5 does not start without M8.9 OQ4); `m8.11`
branch carrying units 1/5/7/8.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.9.1 ∥ M8.9.2 ∥ M8.11.2 | opus | none | predicate + sticky column are file-disjoint; M8.9.2's `DELETE` allowlist reads `store.ts` and pins every delete target as a literal, so M8.10's second DELETE had to be named rather than slipping in; M8.11.2 owns leg F and the `smoke.ts` reconciliation (leg E's runner moved into M8.11.1 and has been gating since S4). **M8.9.3 is held out of this wave**: its Files line shares `local-archive.ts` with M8.9.1 despite the ticket's "disjoint" claim — the collision the panel missed |
| W2 | M8.9.3 ∥ M8.11.3 | opus | none | the listing seam (after .1 settles `local-archive.ts`, its zero-requests fetch double now carrying its control); leg G's bridge + runner — the adapter shape-shifts only, a divergence it cannot bridge is a finding about the daemon, never a suite edit, and the offline walk is replaced by the in-runner `globalThis.fetch` tripwire + zero-remotes assertion, which holds on a runner that *does* have a network |
| W3 | M8.9.4 ∥ M8.11.6 | **fable** / opus | none | the sweep + four write refusals is fable (it adds the archived guard to M8.4's sink while the detector legitimately holds a GitHub seam — the one place D7 can quietly die); its banned-specifier addition lands green, so its negative control is mandatory, and the sweep trigger is driven end-to-end with a seamless-case companion (archives nothing, spends nothing — a sweep nothing calls would otherwise ship green, especially in direct mode where there is no tick). The e2e driver + netlog guard (exported `isOutboundUrl` predicate, conditional self-install, installed-marker sentinel — "empty" alone is exactly what a never-loaded guard produces) are independent of M8.9 |
| W4 | M8.9.5 | opus | none | the ETag that must move — modelled on `checks-rollup.test.ts`; mock parity per D6 with **both** transports' ETags pinned (the mock moves for free, revud does not — the exact asymmetry two transports drift through); the archived review asserted still present in the list body |
| W5 | M8.9.6 ∥ M8.9.7 | opus | none — app chrome / daemon sync pin, sequenced behind W4's router writer | superseded chrome, **dead last** among app writers — the banner portal-free, prop-driven and asserted as real HTML, plus the pure `archivedPrUrl` with its path-shaped-identity → `null` row; M8.9.7 decides whether an archived review still re-syncs (OQ9 — previously a side effect of dispatch anyone could flip) and pins whichever branch lands, re-asserting the four write refusals **after** the sync so the sync decision cannot quietly restore writability |
| W6 | M8.11.4 | opus | none | wire E/F/G into the matrix as `required`, fix the stale CI copy, then break one assertion on purpose and watch it exit 1 naming the leg |

**Integration** — M8.9's Verify: the end-to-end both-halves proof (exactly one review archives; the fork row
with identical head ref does **not**; the PR on github.com carries zero comments — the D1 acceptance, a
recorded exception by nature: it needs a real PR the gate must never have, so it corroborates and the
in-gate assertions carry the proof; PR URL
recorded in the Log); M8.9.7's post-sync refusal re-assertions green; re-run M8.4's D7 assertion as a gate.
M8.11's Verify: matrix seven legs; e2e both
drivers with the netlog **empty and the guard's installed-marker present**; **all five negative controls
observed red and reverted** (among them: broken suite
assertion → matrix exits 1 naming the leg; injected `fetch` → e2e fails naming the URL);
`env -u GH_TOKEN -u GITHUB_TOKEN bun test`; `bun run scripts/smoke.ts` (its count assertions reconciled, not
loosened); `bun run docs:build` with the new slug in the nav. Fable reviews ×2 (§8) — `m8.9`'s full diff and
`m8.11`'s full diff including the units parked there since S4 — then open `m8.9` and `m8.11`. Then the
exit-criteria walk: each of MILESTONE.md's six criteria ticked against the run that proves it, per
BOARD.md's coverage table — anything unticked stops the milestone, not the ticket. Final handover + LOG
entry + memories per §9.

**Exit condition** — eleven PRs in one chain up from `main`; `bun run conformance:matrix` exits 0 printing
seven lines with `[E] PASS` `[F] PASS` `[G] PASS` required and `[C]`/`[D]` SKIP with reasons;
`bun run test:e2e` exits 0, both drivers `ALL CHECKS PASSED`, `REVU_E2E_NETLOG` empty **with the
installed-marker present** (an empty log from a never-loaded guard is the trap the marker exists for); all
five negative controls Logged; M8.9.7's re-sync decision pinned with the four refusals re-asserted
post-sync; the token-free full gate green; all six exit criteria ticked.

**Stop risks** — §5.4 at M8.11.2: a SECOND mock-driving conformance file in one process — order-dependent
interference reads as a flake and names the wrong leg; never chase it by loosening the suite. §5.2 at
M8.11.3: the temptation to "fix" the `DirectApi`/`RevuApi` divergence in `direct-api.ts` or to make the
daemon serve `listReviewThreads` — both forbidden; the fallback is the HTTP-in-direct leg. §5.6/§5.7 at
M8.9.3/.4: if the detector enters the write sink's import graph, D7 is gone — stop, do not reason about it.
§5.8 at M8.9 OQ5 and the e2e's 10-minute cap: both are proposals to append, not changes to make.

## Critical path

Wall-clock is the serial chain **S1 → S3 → S4 → S5** (~26 waves). S2 is off the critical path *only* when a
second machine runs it beside S3; on one machine it adds its ten waves to the total — that concurrency is
the single largest schedulable win in the plan, worth an entire session of wall-clock, and it is real
because the two sessions share zero files. Inside the path, the long poles are S4's W1→W5 spine
(M8.5.1 → .2/.3 → .5/.8 → .6 → .7 — the join is irreducibly sequential) and S3's W1→W5 (harnesses, then
seams, then fan-outs — wave one is guard rails and fixtures, the depth §4 charges so that every later red
is observable and attributable to the code it constrains rather than to a harness that never loaded). The **real** parallelism: the M8.2 store fan-out (×4), the M8.3/M8.4 fan-outs (×3 each), S2 ∥ S3,
and M8.11's side lane inside S4. The **decorative** kind, deliberately not taken: a fifth worker in
`local-sync.ts`, a worktree for a one-line barrel append, or any width beyond a ticket's own Units note —
each buys minutes and exposes the night to a §5.5 stop the orchestrator manufactured itself. The human's
merge cadence never gates the path (§6); rulings do — which is why both decision packages are seeded a full
session before they are consumed.

## Risk register

| risk | surfaces in | early warning | what to do |
| --- | --- | --- | --- |
| **Rebase + `git gc` object reachability** — the pinning suite passes with pinning absent (blob store is cache-forever; `gc` alone has a two-week grace) | S4 (M8.8.8) | prune-survival green but the swallowed-`update-ref` control also green, or the control skipped "for time" | M8.8.8 makes the control a permanent second test asserting a named red (`git cat-file -t` non-zero); the reflog-expire and the one-time observed red remain non-negotiable exit conditions — a green run without them is not evidence, treat as unproven, not as done |
| **v3→v4 migration wipes drafts** | S3 (M8.2.1) | any edit near the corruption check; `sqlite_master` diff on the seven v1–v3 tables | doctrine: one statement constant, two call sites; test against a genuinely reconstructed v3 file holding a draft; byte-identical assertion is the gate |
| **Boot relaxation ripples or softens identity** | S4 (M8.5.4) | `tsc` breaks beyond Spike B's classified count; the refuse-to-start block (`context.test.ts:101-209`) edited; `MissingGitIdentityError` touched | GitHub half goes typed-absent, never empty-string; identity guard stays hard on every path; §5.6 stop if it moves |
| **Frozen-contract creep** | S1, then every session's temptation | non-empty `suite.ts` diff; a second `ApiErrorCode`; a route param outside `n\|sha\|threadId\|id`; `fillPath` throwing three packages away | only M8.1.2 may touch the union, once; everything later is a §5.2 stop with the finding named |
| **Conformance-adapter divergence (M8.11.3's bridge)** — `DirectApi` is not a `RevuApi` (sync `getSnapshot`, differently-signed `listPulls`, no `listReviewThreads`) | S5 | pressure to weaken the shared suite or implement the 501'd thread route | the adapter shape-shifts only; `listReviewThreads` is served adapter-locally from the snapshot; an unbridgeable divergence is a finding about the daemon; fallback: leg G over revud-in-direct HTTP (loses `throwingGithubClient` injection — say so) |
| **Shared mock-store leakage** | S1, S2, S4, S5 | green locally, order-dependent red on the slower CI runner | `mockDev.reset()` in every mock-driving `beforeAll` — M8.1.7's dispatch sweep and M8.8.3's real-mock parity leg are mock-driving files too; run the directory, not the file, before calling a leg green |
| **Archive ETag never moves** — the client 304s forever and keeps writing into a read-only review | S5 (M8.9.5) | conditional GET replaying the pre-archive ETag still answers 304 | fold archived state into the ETag hash exactly as the CI rollup was; the `checks-rollup.test.ts` model is the required test shape |
| **M8.2 OQ1 contradiction baked into DDL** | S3 (M8.2.1) | mint path cannot express a successor review without a migration | the generation-discriminator hedge is directed here; behavior ruled by owner in package #1/#2; if even the hedge cannot hold both readings, §5.1 stop |
| **Two-machine splice goes wrong** | S2/S3 concurrent | a PR based on a branch that does not exist; a rebase that is not clean | the daemon session owns the splice; app sits directly above `m8.1` so it never waits; any non-mechanical conflict at the splice is a §5.5 stop by definition |
| **The e2e budget** | S5 (M8.11.6) | the 10-minute job approaching its cap with a second browser flow | a timeout is a budget decision, not a flake — propose the CI cap change in the handover, never make it mid-session |

## If a session fails

A cold session inheriting a half-finished one recovers from the board alone — that is §7's resume contract,
and this plan's job was to keep it cheap: PRs open per-ticket as Verifies go green, partial-ticket branches
(`m8.8` after S3, `m8.11` after S4) are named in **In flight right now** with exact unit state, and both
decision packages live in HANDOVER.md, not in anyone's head. The recovery sequence: read `BOARD.md`'s
In-flight section, the affected tickets' `## Log`, and the newest HANDOVER.md entry — in that order; discard
any uncommitted worktree whose unit has no Log entry (unlanded work is re-dispatched, never archaeologized);
for a unit whose Check exists but whose Log entry does not, run the Check and either land it or revert it —
never assume, and a green Check whose required observed-red or negative-control entry is missing from the
Log is *unproven*, not done (§4) — re-run the control before counting the unit landed; re-run
`bun run check` at the chain head before dispatching anything; then continue **this
roadmap's wave plan from the first unlanded wave** — the sequencing above is not re-derived mid-recovery.
Two special cases: if S3/S2 died mid-splice, the chain state (which PRs are open, on which bases) is in the
handover's stack record per §6 — restore bases first, work second; if a session died on a §5 stop, the stop
is the product — the next session's first act is routing the finding to the human, not retrying the unit.

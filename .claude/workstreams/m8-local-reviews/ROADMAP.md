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
| S1 | The spec | [M8.1](./tickets/M8.1-contract-and-mock.md) (+ Spike B) | **Verification gate** — the frozen-contract extension proven before 60+ units conform to it (D6); also the fork point for two parallel sessions and the human's cheapest contract-ratification moment | `m8.1` PR open, conformance matrix green with zero diff to `suite.ts`, invariant tests unamended, recorded `?mock=1` walk with zero `/api/*` requests, decision package #1 seeded in HANDOVER.md |
| S2 | The app, whole | [M8.6](./tickets/M8.6-app-creation-flow.md), [M8.7](./tickets/M8.7-app-local-chrome.md) | **Verification gate** — the entire feature visible and proven under `?mock=1` before any daemon exists; the chrome sweep observed RED before it is trusted | `m8.6`+`m8.7` PRs stacked, chrome-sweep test seen red-then-green, zero-diff on the four KEEP files, recorded walk: no `#1000000001`, tab strip Conversation·Files·Commits, no rate chip |
| S3 | The daemon core | [M8.2](./tickets/M8.2-store-v4.md), [M8.3](./tickets/M8.3-local-snapshot-builder.md), [M8.4](./tickets/M8.4-local-write-sink.md), + M8.8.1/M8.8.2 | **Human decision** — decision package #1 (M8.5 OQ1, M8.8 OQ2, M8.10 OQ1–OQ3, M8.2 OQ1's behavioral half) must be ruled before the join session shapes options around it | three PRs stacked, v3→v4 migration byte-identical proof, injection gate with empty arg sink, D7 guard observed red-then-green, pin-ref legality proven against real git |
| S4 | The join + hardening | [M8.5](./tickets/M8.5-daemon-wiring.md), [M8.8](./tickets/M8.8-resync-and-pinning.md) (rest), [M8.10](./tickets/M8.10-retention-and-gc.md), + M8.11.1/.5/.7 | **Human decision + verification** — M8.9's rulings (OQ1/OQ2/OQ4/OQ8) needed next; the headline offline proof, the pinning control, and the retention sweep must be inspected before the milestone-proof session builds gates on them | `local-reviews-serve` green offline, `mode-select` zero-diff (D5 tripwire), prune-survival green **with the pinning-disabled control observed failing**, retention sweep zero throws, three more PRs |
| S5 | Archive + the proof | [M8.9](./tickets/M8.9-archive-on-pr.md), [M8.11](./tickets/M8.11-conformance-e2e-docs.md) (rest) | **Milestone exit** — every criterion in MILESTONE.md ticked against the run that proves it | matrix exit 0 with `[E][F][G] PASS` required, e2e netlog empty, both negative controls observed red and reverted, `env -u GH_TOKEN -u GITHUB_TOKEN bun test` green, eleven PRs in one chain |

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
in the strict order M8.5 → M8.8.4 → M8.10.6 → M8.9.5. Also kept: the human-decision boundary in front of
M8.9 (its OQ4 — archived `pull.state` vs. the inbox's open-only filters — is a genuine design contradiction
no unsupervised session may resolve), per-session verification gates, and max two-way file contention.

**From max-parallelism: the width, at unit level.** Its serialization critique was correct: package-disjoint
work must not queue. So the app pair and the daemon trio run as *concurrent sessions* (S2 ∥ S3), and unit
frontiers are exploited inside sessions — M8.3.6 starts beside M8.3.1; M8.3.3/.4/.5 run three-wide against
fixture SHAs; M8.8.1/M8.8.2 run at their real frontier (after M8.2+M8.3, ahead of M8.5, exactly as M8.8's
"Why the Depends row" note records) inside S3; M8.11.1/.5/.7 run as a side lane in S4 so the closing session
is four units, not seven. Also kept verbatim: its observed-RED exit-condition style — every guard rail
(M8.4.6, M8.7.6, M8.8's pinning-disabled control, M8.11's two negative controls) appears in an exit
condition as *seen red, reverted, failure text in the Log*, never merely "green". Dropped: its 41-unit
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

## Session 1 — The spec

**Goal** Land [M8.1](./tickets/M8.1-contract-and-mock.md) — the frozen-contract extension, the mock oracle
(D6), the fixture, and the scenario walk. Everything downstream conforms to what lands here; eight open
questions freeze on merge. Run Spike B in parallel scratch. · **Tickets** M8.1 · **Boundary reason**
verification gate (+ the fork point: S2 and S3 both hang off this) · **Estimated agents** ~9 (6 units,
1 spike, 1 fable pre-merge review, escalation margin).

**Preconditions** — PR #69 (design docs) merged or mergeable; the pre-flight defaults above acknowledged or
overridden by the owner; nothing else.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.1.1 ∥ M8.1.2 ∥ Spike B | opus / **fable** / sonnet | none — orchestrator owns the one shared `packages/shared/src/index.ts` barrel line | .1 and .2 are declared independent (no shared symbol); M8.1.2 is fable because it settles the `ApiErrorCode` question — the single place §5.2 can fire. Spike B: throwaway `tsc` probe of `DirectContext.github` going typed-absent; deliverable is the break count with a three-way classification, written to HANDOVER.md, never committed |
| W2 | M8.1.3 | **fable** | none | the oracle — its semantics *are* the contract (D6); thread-id shape (OQ8) and D-b freeze here |
| W3 | M8.1.4 | opus | none | the atomic widening — deliberately one commit, red at four sites mid-unit |
| W4 | M8.1.5 ∥ M8.1.6 | sonnet / opus | none — disjoint files | both depend on .4, independent of each other; both drive the shared mock store — `mockDev.reset()` in `beforeAll`, non-negotiable |

**Integration** — run M8.1's full Verify (matrix with zero `suite.ts` diff; insertions-only diff on
`client.ts`/`http.ts`; `draft-isolation` + `token-custody` green with zero edits; the recorded `?mock=1`
walk with the network tab empty; `http-contract` round-trips). Fable pre-merge review (§8). Open the `m8.1`
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
`git diff main -- packages/shared/conformance/suite.ts` is empty; both invariant tests green unamended;
the `?mock=1` walk (create → sync → comment → submit → reply → resolve on the fixture) recorded in the Log
with zero `/api/*` requests; HANDOVER.md carries Spike B + package #1.

**Stop risks** — §5.2 at M8.1.2: `same_ref`/`unrelated_histories`/`shallow_clone` fit into `conflict` or
**exactly one** new code (+ `vApiErrorCode` + `http.ts:165`); a second code stops. §5.4 at
M8.1.3/.5/.6: the process-wide `localStorage` Map — order-dependent red on CI reads as a flake; never loosen
`scenarios.test.ts:61`. §5.1 at M8.1.5: D-a moves the two count assertions deliberately — a handover must
say they moved by design, not by accident. §5.8 at OQ3: a `default` marker on `BranchRef` growing into
per-human state → `HumanPreferences` → a bigger contract change; stop and append.

## Session 2 — The app, whole (∥-eligible with S3)

**Goal** The entire app surface against the mock alone: creation flow + inbox
([M8.6](./tickets/M8.6-app-creation-flow.md)), then mode chrome + copy correctness
([M8.7](./tickets/M8.7-app-local-chrome.md)). The whole feature is clickable and provable under `?mock=1`
with no daemon, no git, no token, no network — the owner sees pixels four sessions before the daemon serves
them. · **Tickets** M8.6, M8.7 · **Boundary reason** verification gate (chrome sweep observed RED; the
`?mock=1` walk is the acceptance surface) · **Estimated agents** ~19.

**Preconditions** — `m8.1` PR open with Verify green (merge not required — stack off it). Pre-flight
defaults for M8.6 OQ2 / M8.7 OQ1/OQ4/OQ5/OQ8 in hand. On two machines this session runs concurrently with
S3; it works off `m8.1` and its PRs open in chain position (`m8.6` on `m8.1`, `m8.7` on `m8.6`) —
no splice needed, the app pair sits directly above M8.1 in the chain.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.6.1 ∥ M8.6.2 | opus | none | declared independent; .1 claims the app's **single** `isLocalReviewId` call site — the sentence M8.7.4's grep later enforces |
| W2 | M8.6.3 ∥ M8.6.4 | opus | none — new dialog file vs `inbox.tsx` | the two biggest commits, mutually independent |
| W3 | M8.6.5 ∥ M8.6.6 | opus | **worktree** — both edit `inbox.tsx` (different regions; trivial merge expected) | .5 needs .3's dialog; .6 needs only .1 |
| W4 | M8.7.1 | opus | none | gates every other M8.7 unit; consolidates `matchPrNumber`; touches `palette.tsx` after M8.6.5 settled it |
| W5 | M8.7.2 ∥ M8.7.4 ∥ M8.7.9 | opus | none — `pr-layout.tsx`+`palette.tsx`+`App.tsx` / `conversation.tsx` / `threads.ts`; orchestrator owns `lib/mode-copy.ts` | the `pr-layout` chain starts (.2 first per ticket order) while the two independent units run beside it |
| W6 | M8.7.3 ∥ M8.7.5 | opus | none — `pr-layout.tsx` (after .2) / `review-bar.tsx`+`reconcile-dialog.tsx`; copy functions returned to the orchestrator | mode-copy contention (the tickets' own blind spot) is dissolved by single-writer integration, not worktrees |
| W7 | M8.7.6 | opus | none | the residual sweep + the sweep test — after .3/.4/.5 centralized the strings; touches `pr-layout.tsx:154-157`, so it cannot ride beside .8 |
| W8 | M8.7.8 | opus | none | dirty banner in the author-banner slot — last `pr-layout.tsx` writer |
| W9 | M8.7.7 | sonnet | none | the closing proof: github-mode literals pinned `toBe`, zero-diff on the four KEEP files (vs the `m8.6` tip — see the exit condition) |

**Integration** — after M8.6's Verify: fable review, open `m8.6`. After M8.7's Verify: sweep test observed
RED (re-add `logs live on github.com`, run, revert — failure text in the Log), fable review, open `m8.7`.
Record the full `?mock=1` walk (M8.7 Verify 3–5) in the Log.

**Exit condition** — both PRs open and stacked; `bun run check` green at the `m8.7` tip;
`bun test packages/app/src/lib/chrome-sweep.test.ts` green **and observed red once**;
`git diff --stat m8.6 -- packages/app/src/state/queries.ts packages/app/src/lib/shortcuts.ts
packages/app/src/components/review/head-moved-dialog.tsx packages/app/src/components/review/error-copy.ts`
at the `m8.7` tip reports zero changed files — against the `m8.6` tip, **not** `main` as M8.7.7's Check
literally spells it: M8.6.2's key-factory append and M8.6.5's chord catalog entry legitimately touch two of
the four, so the `main`-based form is unsatisfiable on the chain; what the unit proves is that **M8.7**
changed nothing there (flag the Check's wording to the owner in the handover, do not amend the ticket); `failure-drills.test.ts` green unamended; recorded walk shows tab strip
Conversation · Files · Commits, `base ← head` + local chip, `document.body.innerText` containing no
synthetic id, no rate chip, no author banner; duplicate creation navigates to the same id with one inbox row.

**Stop risks** — §5.1 across M8.7's owner calls: any resolution implying §4.1's field table is wrong is a
finding. §5.8 at M8.6.2/OQ7: "remember my last base branch" → `HumanPreferences` → frozen-contract change;
append and continue without it. §5.3 at M8.7.6: the sweep must scan source without tripping on docstrings —
`audit-integrity.test.ts:116-125` is the only proven shape. §5.4: mock-store leakage (three new mock-driving
files this session). Handover if it dies: which `pr-layout.tsx` writer was in flight (the W5–W8 chain is the
only sequenced thing here) and which mode-copy functions the orchestrator holds unintegrated.

## Session 3 — The daemon core (∥-eligible with S2)

**Goal** The three mutually independent daemon pieces, each proven alone: the `local_*` store
([M8.2](./tickets/M8.2-store-v4.md)), the git-only builder ([M8.3](./tickets/M8.3-local-snapshot-builder.md)),
the write sink ([M8.4](./tickets/M8.4-local-write-sink.md)) — plus
[M8.8](./tickets/M8.8-resync-and-pinning.md).1/.2 at their true unit frontier. Hazard-bearing seams land in
wave one and guard rails land red-then-green **before** the code they guard. · **Tickets** M8.2, M8.3, M8.4
(+ M8.8.1, M8.8.2) · **Boundary reason** human decision — package #1 must be ruled before S4 shapes
M8.5.4's option and rewrites `reconcile.test.ts:428` · **Estimated agents** ~27.

**Preconditions** — `m8.1` open with Verify green. Directives in hand: high-water-mark minting; generation
discriminator in the unique key; builder lives in `direct/`; dirty = `-uno`. On two machines this session
runs concurrently with S2 **working off `m8.1`**, and owns the splice: before opening PRs it rebases `m8.2`
onto the `m8.7` tip (mechanical — zero shared files); if S2 has not produced `m8.7` yet, the three PRs wait
in the handover as ready-to-open, bases named.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.2.1 ∥ M8.3.1 ∥ M8.3.6 ∥ M8.4.1 | opus / **fable** / opus / opus | none — four disjoint file sets | the four seams, one per hazard: the v4 DDL (with the two directives applied), the injection defense (fable — every later unit shells out through it), the optional-`github` blob change, the D7 port. Risk-first: nothing that spawns git exists before M8.3.1 does |
| W2 | M8.2.2–M8.2.5 ∥ M8.3.2 ∥ M8.4.2 + M8.4.6 | opus ×4 / opus / opus | **worktree** on the M8.2 four (shared `DirectStore` append **and** `store.test.ts` — the tickets' undercounted collision) | the store fan-out is the ticket-sanctioned width; M8.3.2 resolves refs through the now-landed seam; **M8.4.6 lands here, red-then-green, before a single write verb exists** — the guard-first rule, applied |
| W3 | M8.3.3 ∥ M8.3.4 ∥ M8.3.5 ∥ M8.4.3 ∥ M8.4.4 ∥ M8.4.5 | opus ×6 | **worktree** ×2 groups — three in `local-sync.ts` (the sanctioned width, against fixture SHAs), three in `local-writes.ts` | the two fan-outs the tickets explicitly bless; not one worker more |
| W4 | M8.2.6 ∥ M8.3.7 ∥ M8.4.7 | opus | none | the D4 containment trigger test (needs .2–.5), `listBranches` (needs only M8.3.1), the optimistic-convergence pinning (needs .3–.5) |
| W5 | M8.8.1 | **fable** | none | the pin seam at its real frontier — needs M8.3 only; fable because the ref-namespace shape is the recorded answer to M8.10 OQ5 and the `..`-rejection subtlety is where a cosmetic-looking substitution is load-bearing |
| W6 | M8.8.2 | opus | none | pin **before** the first object read — edits `local-sync.ts` after M8.3 fully settled it; ordering asserted with a recording runner, not a was-it-called check |

**Integration** — per-ticket Verify as each completes, PR opened immediately: the real v3→v4 in-place
migration on a file already holding a draft/viewed/audit/pr_author row (all four byte-identical,
`sqlite_master` unchanged for the seven v1–v3 tables); the injection acceptance gate (payload rejected
before any `runner.run`, arg sink empty, no file on disk); the D7 guard observed RED with the
`github-client` import added, failure message in the Log, then green; M8.8.1's Check (real
`check-ref-format`: exit 0 on `pinRefsFor` output, exit 1 on the design's literal form). M8.8.1/.2 commits
sit on `m8.8` branched off the `m8.4` tip — **no PR yet**; board In-flight and handover name them exactly.
Fable reviews ×3. Handover: package #1 confirmed complete, with the as-built schema shape attached so the
owner rules on facts.

**Exit condition** — `m8.2`/`m8.3`/`m8.4` PRs stacked (or ready-to-open pending splice), `bun run check`
green at the `m8.4` tip; `bun test -t 'local writes never touch'` green in isolation; migration proof,
injection gate, and D7 red-then-green all recorded in ticket Logs; M8.8.1/.2 green on `m8.8`;
decision package #1 complete in HANDOVER.md.

**Stop risks** — §5.1 at M8.2.1: if even the generation-discriminator hedge cannot reconcile §4.2 with §8
case 22, that is a design finding — stop, do not amend §8. §5.3 at M8.3.3/.4: the plumbing parsing
(three-field rename records, the empty third numstat field, per-file patch slicing at the first `@@`) is the
likeliest top-tier Check failure. §5.4 at M8.3.5/.7: CI has no git identity — every fixture commit passes
`-c user.email -c user.name -c commit.gpgsign=false` or the suite is green locally and red on CI. §5.5 at
W2/W3: the three sanctioned fan-outs are the only places a semantic (not append) conflict can appear; if two
workers restructured the same helper, that is a decision, not a rebase. §5.7 at M8.4.6: a guard rail that
cannot be made to bite is decorative — stop rather than ship it soft.

## Session 4 — The join + hardening

**Goal** Wire the daemon ([M8.5](./tickets/M8.5-daemon-wiring.md)), prove the milestone's headline exit
criterion **in-session**, then land pinning/rebase-safety ([M8.8](./tickets/M8.8-resync-and-pinning.md).3–.7)
and retention ([M8.10](./tickets/M8.10-retention-and-gc.md)) in the same warm head — with
[M8.11](./tickets/M8.11-conformance-e2e-docs.md).1/.5/.7 as a dependency-free side lane. · **Tickets** M8.5,
M8.8 (rest), M8.10, M8.11 (units 1/5/7) · **Boundary reason** human decision (M8.9's rulings) +
verification (offline proof, pinning control, retention sweep — inspected before the proof session) ·
**Estimated agents** ~27.

**Preconditions** — S2 + S3 PRs open and spliced into the chain; **rulings present**: M8.5 OQ1 (shapes
M8.5.4's option before it is written), M8.8 OQ2 (before M8.8.3 rewrites `reconcile.test.ts:428` — the
point of no return; entering without it means M8.8.3 does not dispatch), M8.10 OQ1/OQ2/OQ3. Spike B's
classification in hand for M8.5.4.

**Waves** — hard rule: **no unit that builds on the serving path dispatches before W5's gate is green.**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.5.1 ∥ M8.5.4 ∥ M8.10.2 ∥ M8.10.3 ∥ M8.11.1 | opus / opus / opus / opus / opus | none — `direct-api.ts` / `context.ts`+`session.ts` / new `retention.ts` / `store.ts` / new shared suite | M8.5.4 is declared fully independent of .1–.3; M8.10.2/.3 are pure primitives needing only M8.2; the shared suite needs only M8.1 |
| W2 | M8.5.2 ∥ M8.5.3 ∥ M8.10.1 ∥ M8.8.3 ∥ M8.11.5 | opus ×4 / sonnet | **worktree** on M8.5.2/.3 (both append the `direct-router` dispatch chain — sanctioned trivial merge); M8.10.1 sequenced after W1's M8.10.3 in `store.ts` | M8.8.3 (shared reconcile + mock in lockstep, ruling in hand) touches `reconcile.ts` alone this wave — M8.8.4 must not ride beside it (corrected collision) |
| W3 | M8.5.5 ∥ M8.10.4 ∥ M8.11.7 | opus ×2 / sonnet | none | boot assembly (discovered toplevel, never `context.cwd`); immutable prune over W1's live-key read; docs |
| W4 | M8.5.6 ∥ M8.8.5 ∥ M8.10.5 | opus | none — router+api / `local-sync.ts`+new test / retention | honest degradation; deleted-ref survivability; blob prune behind its default-off flag |
| W5 | **M8.5.7 — the gate** | opus | none | the offline HTTP proof: full loop over `fetch`, no origin, no token, no network, spoofed-`humanId`, restart-same-id. M8.5's whole Verify runs here, incl. the manual offline drill, and the `m8.5` PR opens |
| W6 | M8.8.4 ∥ M8.8.6 | opus | none — `reconcile.ts`+`direct-api.ts` / app files (settled by S2) | post-gate both: the objects-missing pre-flight maps `getLocalSnapshot` onto M8.5.1's dispatch **at the API edge** (its Files line carries `direct-api.ts`), so it waits for the gate and for M8.5.6 — preserving the strict `direct-api.ts` order M8.5 → M8.8.4 → M8.10.6; the dialog's rewrite copy + D8 proof |
| W7 | M8.8.7 ∥ M8.10.6 | opus | none — `drafts.ts`+`reconcile-dialog.tsx` / retention wiring + the served DELETE | `drafts.ts` + `reconcile-dialog.tsx` after M8.8.6, per the ticket's own sequencing; the delete route takeover rewriting M8.5.2's pinned 501 case — the session's last `direct-api.ts`/`direct-router.ts` writer, after M8.8.4, ahead of only M8.9.5 |

**Integration** — M8.8's prune-survival Verify with teeth: `git reflog expire --expire=now
--expire-unreachable=now --all && git gc --prune=now`, the `blobs`-table-cleared leg, **and the
pinning-disabled control observed failing** (recorded — without the control the suite passes with the
feature absent, because the blob store is cache-forever). M8.10's over-deletion sweep: every row in
`snapshots` and `local_snapshots` resolves through its getter, zero throws. `mode-select.test.ts` green with
zero diff (the D5 tripwire); `context.test.ts`'s refuse-to-start block unedited. Happy-path e2e green with
`git diff e2e/happy-path.ts` empty (M8.11.5's no-behavior-change proof). PRs `m8.8`, `m8.10` open in chain
order; M8.11.1/.5/.7 commits parked on `m8.11` (no PR). Fable reviews ×3. Handover: decision package #2
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
`local-reviews-serve.test.ts` green offline incl. restart-same-id-same-draft; `local-resync.test.ts` green
**including the control observed failing**; `retention.test.ts` green including the sweep;
`mode-select` zero-diff; `direct/local-write-isolation.test.ts` still green; manual offline drill commands
in M8.5's Log; package #2 in HANDOVER.md.

**Stop risks** — §5.6 at M8.5.4: relaxation is about GitHub preconditions only — anything that also softens
`MissingGitIdentityError` files every human's drafts under one blank id; immediate stop. §5.7 at M8.5.1 /
M8.9-adjacent seams: the local branch must be taken **above** the `writeDeps` bundle; a conditional inside a
shared write function does not satisfy D7. §5.5 at W2/W6/W7: `direct-api.ts` is written by six units across
three tickets this session — the strict order above is the mitigation; a non-append conflict stops. §5.4 at
M8.5.7: the `REVU_DIST_DIR` stub-dist landmine plus a leaked port reads as a feature failure. §5.8 at
M8.5 OQ6: the headline criterion is not reachable through `bin/revu` — state it is proven against `revud`
directly and append the CLI ticket; do not absorb it.

## Session 5 — Archive + the proof

**Goal** Implement D1 ([M8.9](./tickets/M8.9-archive-on-pr.md)) with its rulings in hand — detection,
sticky non-destructive archival, an ETag that actually moves, the superseded chrome dead-last — then convert
the milestone's intentions into gates ([M8.11](./tickets/M8.11-conformance-e2e-docs.md).2/.3/.4/.6) and walk
the exit criteria. · **Tickets** M8.9, M8.11 (rest) · **Boundary reason** milestone exit · **Estimated
agents** ~14.

**Preconditions** — S4 PRs open; decision package #2 ruled (S5 does not start without M8.9 OQ4); `m8.11`
branch carrying units 1/5/7.

**Waves**

| wave | units | tier | isolation | why these run together |
| --- | --- | --- | --- | --- |
| W1 | M8.9.1 ∥ M8.9.2 ∥ M8.11.2 | opus | none | predicate + sticky column are file-disjoint; legs E/F need only the S1 mock. **M8.9.3 is held out of this wave**: its Files line shares `local-archive.ts` with M8.9.1 despite the ticket's "disjoint" claim — the collision the panel missed |
| W2 | M8.9.3 ∥ M8.11.3 | opus | none | the listing seam (after .1 settles `local-archive.ts`); leg G's bridge + runner — the adapter shape-shifts only, and a divergence it cannot bridge is a finding about the daemon, never a suite edit |
| W3 | M8.9.4 ∥ M8.11.6 | **fable** / opus | none | the sweep + four write refusals is fable (it adds the archived guard to M8.4's sink while the detector legitimately holds a GitHub seam — the one place D7 can quietly die); the e2e driver + netlog guard are independent of M8.9 |
| W4 | M8.9.5 | opus | none | the ETag that must move — modelled on `checks-rollup.test.ts`; mock parity per D6 |
| W5 | M8.9.6 | opus | none | superseded chrome, **dead last** — the only unit editing three files two other tickets rewrote, entered with OQ4's ruling applied |
| W6 | M8.11.4 | opus | none | wire E/F/G into the matrix as `required`, fix the stale CI copy, then break one assertion on purpose and watch it exit 1 |

**Integration** — M8.9's Verify: the end-to-end both-halves proof (exactly one review archives; the fork row
with identical head ref does **not**; the PR on github.com carries zero comments — the D1 acceptance, PR URL
recorded in the Log); re-run M8.4's D7 assertion as a gate. M8.11's Verify: matrix seven legs; e2e both
drivers with the netlog **empty**; **both negative controls observed red and reverted** (broken suite
assertion → matrix exits 1 naming the leg; injected `fetch` → e2e fails naming the URL);
`env -u GH_TOKEN -u GITHUB_TOKEN bun test`; `bun run scripts/smoke.ts` (its count assertions reconciled, not
loosened); `bun run docs:build` with the new slug in the nav. Fable reviews ×2 (§8) — `m8.9`'s full diff and
`m8.11`'s full diff including the units parked there since S4 — then open `m8.9` and `m8.11`. Then the
exit-criteria walk: each of MILESTONE.md's six criteria ticked against the run that proves it, per
BOARD.md's coverage table — anything unticked stops the milestone, not the ticket. Final handover + LOG
entry + memories per §9.

**Exit condition** — eleven PRs in one chain up from `main`; `bun run conformance:matrix` exits 0 printing
seven lines with `[E] PASS` `[F] PASS` `[G] PASS` required and `[C]`/`[D]` SKIP with reasons;
`bun run test:e2e` exits 0, both drivers `ALL CHECKS PASSED`, `REVU_E2E_NETLOG` empty; both negative
controls Logged; the token-free full gate green; all six exit criteria ticked.

**Stop risks** — §5.4 at M8.11.2: a SECOND mock-driving conformance file in one process — order-dependent
interference reads as a flake and names the wrong leg; never chase it by loosening the suite. §5.2 at
M8.11.3: the temptation to "fix" the `DirectApi`/`RevuApi` divergence in `direct-api.ts` or to make the
daemon serve `listReviewThreads` — both forbidden; the fallback is the HTTP-in-direct leg. §5.6/§5.7 at
M8.9.3/.4: if the detector enters the write sink's import graph, D7 is gone — stop, do not reason about it.
§5.8 at M8.9 OQ5 and the e2e's 10-minute cap: both are proposals to append, not changes to make.

## Critical path

Wall-clock is the serial chain **S1 → S3 → S4 → S5** (~24 waves). S2 is off the critical path *only* when a
second machine runs it beside S3; on one machine it adds its nine waves to the total — that concurrency is
the single largest schedulable win in the plan, worth an entire session of wall-clock, and it is real
because the two sessions share zero files. Inside the path, the long poles are S4's W1→W5 spine
(M8.5.1 → .2/.3 → .5 → .6 → .7 — the join is irreducibly sequential) and S3's W1→W3 (seams before
fan-outs). The **real** parallelism: the M8.2 store fan-out (×4), the M8.3/M8.4 fan-outs (×3 each), S2 ∥ S3,
and M8.11's side lane inside S4. The **decorative** kind, deliberately not taken: a fifth worker in
`local-sync.ts`, a worktree for a one-line barrel append, or any width beyond a ticket's own Units note —
each buys minutes and exposes the night to a §5.5 stop the orchestrator manufactured itself. The human's
merge cadence never gates the path (§6); rulings do — which is why both decision packages are seeded a full
session before they are consumed.

## Risk register

| risk | surfaces in | early warning | what to do |
| --- | --- | --- | --- |
| **Rebase + `git gc` object reachability** — the pinning suite passes with pinning absent (blob store is cache-forever; `gc` alone has a two-week grace) | S4 (M8.8 Verify) | prune-survival green but the pinning-disabled control also green, or the control skipped "for time" | the control and the reflog-expire are non-negotiable exit conditions; a green run without an observed-red control is not evidence — treat as unproven, not as done |
| **v3→v4 migration wipes drafts** | S3 (M8.2.1) | any edit near the corruption check; `sqlite_master` diff on the seven v1–v3 tables | doctrine: one statement constant, two call sites; test against a genuinely reconstructed v3 file holding a draft; byte-identical assertion is the gate |
| **Boot relaxation ripples or softens identity** | S4 (M8.5.4) | `tsc` breaks beyond Spike B's classified count; the refuse-to-start block (`context.test.ts:101-209`) edited; `MissingGitIdentityError` touched | GitHub half goes typed-absent, never empty-string; identity guard stays hard on every path; §5.6 stop if it moves |
| **Frozen-contract creep** | S1, then every session's temptation | non-empty `suite.ts` diff; a second `ApiErrorCode`; a route param outside `n\|sha\|threadId\|id`; `fillPath` throwing three packages away | only M8.1.2 may touch the union, once; everything later is a §5.2 stop with the finding named |
| **Conformance-adapter divergence (M8.11.3's bridge)** — `DirectApi` is not a `RevuApi` (sync `getSnapshot`, differently-signed `listPulls`, no `listReviewThreads`) | S5 | pressure to weaken the shared suite or implement the 501'd thread route | the adapter shape-shifts only; `listReviewThreads` is served adapter-locally from the snapshot; an unbridgeable divergence is a finding about the daemon; fallback: leg G over revud-in-direct HTTP (loses `throwingGithubClient` injection — say so) |
| **Shared mock-store leakage** | S1, S2, S5 | green locally, order-dependent red on the slower CI runner | `mockDev.reset()` in every mock-driving `beforeAll`; run the directory, not the file, before calling a leg green |
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
never assume; re-run `bun run check` at the chain head before dispatching anything; then continue **this
roadmap's wave plan from the first unlanded wave** — the sequencing above is not re-derived mid-recovery.
Two special cases: if S3/S2 died mid-splice, the chain state (which PRs are open, on which bases) is in the
handover's stack record per §6 — restore bases first, work second; if a session died on a §5 stop, the stop
is the product — the next session's first act is routing the finding to the human, not retrying the unit.

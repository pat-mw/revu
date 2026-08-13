# M8 — handover

Cross-session handover. **Newest at the top** — the first entry is the live one. Written so a cold agent can
act from it alone.

---

## 2026-08-13 — Session 1 (the spec) — M8.1 landed; **decision package #1 below needs your rulings**

> **Read the four rulings in "Decision package #1" first if you read nothing else.** Session 3 ends blocked on
> them, and Session 4 cannot start without three of them.

### State

**M8.1 is `In Review`. PR [#70](https://github.com/pat-mw/revu/pull/70) is open**, on base
**`m8/local-reviews-design`** (PR [#69](https://github.com/pat-mw/revu/pull/69)), **not** `main`. That is
deliberate: the board and `docs/agent/LOCAL_REVIEWS.md` exist only on that branch, so a `main`-based branch
would strand every board write. #69 carries **zero files under `packages/`**, so #70's code diff is identical
to a `main`-based one, and GitHub retargets #70 to `main` automatically when #69 merges. **Merge #69 first,
then #70.** Nothing was committed to `main`; nothing was merged. Working tree clean, In flight empty.

The chain is therefore `main → m8/local-reviews-design (#69) → m8.1 → …`, which is the same linear chain the
roadmap specifies with one extra (docs-only) link at the bottom.

### What landed

**M8.1 — 8 units** (7 planned + 1 appended). Gate green after **every** unit, never batched.

> ⚠️ **If this entry is the newest thing you are reading and `BOARD.md`'s In-flight section is not empty, the
> session died mid-wave.** The table below lists exactly what is committed. Anything in In-flight and *not*
> in this table is unlanded: discard its uncommitted worktree and re-dispatch it. Do not archaeologize
> unlanded work (§7 / the roadmap's recovery rule).

| unit | commit | gate at that commit |
| --- | --- | --- |
| M8.1.1 id bands + disjointness proof | `164b1d7` | wave tip 1181 pass · 0 fail |
| M8.1.7 route guard rails (landed **before** the widening) | `0d2c1b0` | ″ |
| M8.1.2 wire types, validators, ref validator | `d0d1ce8` | ″ |
| M8.1.3 the mock local-review engine — **the oracle** | `e60f9da` | 1193 pass · 0 fail |
| M8.1.4 the contract extension (atomic) | `5bb5e82` | 1201 pass · 0 fail |
| M8.1.8 local-id dispatch in the mock adapter (**appended**) | `0aeb75a` | 1219 pass · 0 fail |

Full detail — every red observed, every control, every frozen ruling — is in the ticket's `## Log`. It is long
on purpose: it is the specification's rationale, and D6 means later tickets conform to it.

**Eight open questions froze.** OQ1 wire shapes · OQ2 route spellings · OQ3 `listBranches` shape + fixture ·
OQ4 minting · OQ5 delete boundary · OQ6 rate limit (confirmed, unchanged) · OQ7 the error code · OQ8 thread id
shape. Each with reasoning, in the ticket Log. **Reversing one is now a contract change, not a preference.**

**The frozen contract is provably additive:** `client.ts` **+39/-0**, `types.ts` **+87/-0**. The single
deletion anywhere on the branch is one `http.ts` docstring line that said `:n (prNumber)` — now also a local
review id, and the stale text invited exactly the range check that would reject every local review. Both
invariant tests (`draft-isolation.test.ts`, `token-custody.test.ts`) pass **unamended**, 19 pass · 703 expect.

### A unit was appended mid-ticket — M8.1.8 (7 → 8 units)

M8.1.4 discovered the engine was **unreachable through the contract**: `requireRemote()`
(`packages/app/src/api/mock/adapter.ts:87`) is called at five sites and throws `not_found` for any id with no
remote pull — which is every local review — so `syncPull` / `submitReview` / `replyToThread` / `resolveThread`
all rejected local ids, and **M8.1.6's walk was unsatisfiable as written**. This sat squarely inside M8.1's own
Goal ("a working local-review implementation in the mock adapter, reachable under `?mock=1`"), so it was
appended and numbered rather than absorbed silently or escalated as §5.8 growth. Existing units were not
renumbered.

**Its ruling constrains later work:** local reviews reach `listPulls` through **exactly one** path — the
stored record — because a fixture placed in `fixtureDB.pulls` would be listed by the remote path *and* the
local path, the same review twice. That is the "two truths" hazard D-c exists to prevent, and it **supersedes
M8.1.5's ticket text**, which said the fixture is "registered in `fixtureDB.pulls`".

### Decisions not to relitigate

D1–D8 unchanged. Added by this session, all with rationale in the ticket Log:

- **`unprocessable` (HTTP 422) is the one new `ApiErrorCode`, and the union is now closed for the workstream.**
  `same_ref` / `unrelated_histories` / `shallow_clone` share one honest class. Reusing `conflict` was rejected:
  it already carries the draft-conflict meaning, and rendering "you picked the same branch twice" with that
  copy would misdescribe the failure. Verified separately that **no consumer maps over `ApiErrorCode`
  exhaustively**, so the new code leaves no rendering hole.
- **Minting is persisted high-water counters, never a max-scan** — a scan recycles a deleted review's id and
  the recycled id inherits the dead review's drafts, viewed state and caches. **M8.2 must persist a high-water
  mark rather than literal `MAX(id)+1`**; §3.1's spelling under-specifies the delete case.
- **Deletion is full-record removal; drafts and viewed state are orphaned, never destroyed.** A delete must not
  become the one path that discards user text. Blobs untouched (M8.10's remit).
- **Thread ids are `local:<reviewId>:<rootCommentId>`.** Nothing parses them, so the only reader served is a
  person reading a log. **M8.4.2 conforms to this.**
- **The local branch is taken ABOVE the remote lookup, never inside it.** Stamping, the shared-bot author, the
  approve refusal and the `mutable.reviews` append all stay strictly below it. This is the shape D7 is later
  held to — locality as a property of the code's shape, not of a branch someone could mis-take.
- **The record is the one truth; the snapshot is rebuilt from it** (`refreshSnapshotThreads`), exactly as
  re-sync does. M8.4's sink should copy that shape.

### Hazards for the next session

1. **A second `STORE_VERSION` pin exists that no ticket names.** revud reuses the app's mock store, so the
   3→4 bump moved `packages/revud/src/revud.test.ts:737` (`expect(onDisk.v).toBe(3)`) — a file outside M8.1.3's
   Files line. Verified before touching: that test boots a daemon against a **v2** document and every
   draft-survival assertion in it still passes; only the literal was stale, and it was moved deliberately and
   kept a hardcoded pin. **Any future store bump hits this pin too.**
2. **`.claude/worktrees/` is NOT gitignored.** Session 3 uses worktree isolation in three waves and Session 4
   in two; an agent worktree can be staged into a PR. Managed this session by removing Spike B's worktree and
   staging explicitly, but it wants a one-line `.gitignore` entry. **Appended rather than absorbed** — it is
   harness config, not this ticket's territory.
3. **`scripts/smoke.ts:54-61` is now stale and in no gate** — the accepted testing exception. M8.11.2 owns
   reconciling it. Until then a green smoke run is **no signal** on fixture counts.
4. The two pre-existing bugs from the previous handover still stand (unconditional optimistic reply stamping;
   a `conflict`-ending reconcile-apply never updating `draft.headSha`).

### The adversarial review found a real defect — and falsified one of my own rulings

A fable-tier reviewer read the full diff with a brief to refute. It ran the suite, ran two reverted
experiments, and **demonstrated** that the anti-neuter guard on the pinned route table was vacuous:
`|ROUTES| >= |PINNED_ROUTES|` holds by construction whenever the pin test passes, so deleting a pin was green.
The dispatch sweep's floor had also never been raised from `19` to `23`, so **precisely the four newest routes
were deletable** by a coordinated deletion (interface method + both adapters + `ROUTES` entry + pin) with
every guard still green. The ticket Log's ruling 1 recorded a property the code did not have. **Fixed before
the PR opened**, with the deletion controls as its acceptance — see the ticket Log.

That is the value of the review step, and it is worth stating plainly: the additive-only property was *not*
actually asserted for two of the eight units' worth of work, and only an adversarial pass found it.

**Findings deliberately NOT fixed, each needing an owner or a later ticket:**

- **`addReaction` on a local review is a shared rollup, not per-human** — a second human reacting with the same
  emoji gets the unchanged rollup and their optimistic bump snaps back silently. This is **pinned as
  deliberate** now (it matches the standing project rule that reactions are shared-and-honest and per-human
  reaction simulation is explicitly not to be built), but locally the shared-bot rationale is gone, so
  **it is a product call worth confirming.** M8.4 will reproduce whatever is pinned.
- **Submitting before the first sync succeeds but shows nothing** — `status: 'ok'`, yet `listReviewThreads` is
  `[]` and `getSnapshot` is `null` until a later sync. Unreachable through today's UI. **Pinned exactly as-is
  so the daemon cannot diverge silently**, deliberately *without* changing the behaviour: whether it should be
  refused (`unprocessable` before first sync) is a design question, and it contradicts §6's premise that the
  client invalidates "expecting them to appear". **Needs a ruling.**
- **A local review's synthesized `pull.user` follows the acting human**, because the record stores no creator.
  Left alone on purpose: adding a creator column would be a change to the frozen wire shape and §4.2's column
  set, which M8.2 would then have to mirror. Moot daemon-side (one git identity); an unpinned nondeterminism
  in the mock that a UI test could trip over.
- **The optimistic reply still stamps on the local path** (`packages/app/src/state/threads.ts:161` calls
  `prefixBody` unconditionally and attributes to the bot), so a local reply renders stamped and bot-authored
  for the optimistic interval before snapping to verbatim. This is one of the two pre-existing bugs above, and
  **no ticket in this branch names the fix** — confirm M8.7 owns it, or "no stamping" holds on the wire but
  not on screen.
- **Direct mode will forward a local-band id to GitHub today**: `direct-router.ts:148-151` gates only
  `Number.isInteger(n) && n > 0`, so a hand-crafted `/api/pulls/1000000001/sync` issues a real GitHub GET
  (404 back; no content leaves). The four new routes correctly 501 via `isKnownApiPath`. **M8.5's dispatch must
  land above the GitHub call, exactly as the mock's does** — add this to M8.5's landmines.
- **`api-router.ts`'s `badRequest()` emits `{code:'not_found'}` with HTTP 400** — a pre-existing code/status
  mismatch that the new delete route's malformed-id branch inherits. Untouched; worth its own small ticket.
- **The `listPulls` etag now covers local rows**, so purely local activity turns the next poll into an etag
  miss costing one rate unit. Consistent with D-a and intended, recorded here because it is a real behaviour
  change on the pre-existing surface.

**What the reviewer attacked and could not break:** frozen-file additivity; draft loss on any v1/v2/v3
migration; the id-band boundaries; the three frozen transport semantics, which hold **structurally** on the
local path rather than only in the test's walk; every stamp/tripwire/partial-key/sweep control (all real, none
vacuous); the comment convention; and the conformance suite.

### Spike B — the boot-relaxation probe (throwaway; nothing committed, worktree removed)

Making `DirectContext.github` typed-absent (`github?: GithubClient`) breaks **exactly 2 lines**, both
`github: context.github` funnelling into `createDirectApi`: `packages/revud/src/index.ts:174` (`mainDirect`)
and `:305` (`mainBroker`). Classification: **mechanical 0 · needs-a-real-local-mode-branch 2 · dangerous 0**
(six pre-existing unrelated baseline errors excluded).

**The §5.6 signal is green:** `MissingGitIdentityError`, the identity guard and `context.test.ts`'s
refuse-to-start block appear **nowhere** in the break set — confirmed by grep over the `tsc` output and by the
diff. Identity resolution lives in `session.ts`, fed by `runner`/`cwd`, neither of which changes type.

**Carry the caveat, not just the number.** The probe ran against `177068a`, which has no per-method
`isLocalReviewId` dispatch, so the small blast radius is an artifact of the pre-M8 tree. Once local dispatch
and the write sink land, the same edit surfaces the real choice — **optional-deps-with-guards vs.
never-assemble-the-api** — at every GitHub-touching method rather than at two boot-time call sites. The risk is
reading "2 breaks" as "typed-absent is cheap"; the cost is deferred into M8.5.1/M8.5.5, not avoided.

### Decision package #1 — **four rulings owed by the owner**

Session 3 ends blocked on these; Session 4's preconditions name three of them. Each carries a recommendation.

**1. M8.5 OQ1 — how is local-only switched on?**
Candidates: an explicit flag/env, or automatically when GitHub resolution fails.
**Recommend explicit.** Automatic turns a transient `gh` failure — an expired token, a flaky network, a
misconfigured remote — into a **silently local-only daemon**: the human keeps working, comments land nowhere
near GitHub, and nothing says so. Explicit costs one flag and makes the mode legible. Shapes M8.5.4's option
before it is written.

**2. M8.8 OQ2 — does the commit-delta rewrite land on the shipped GitHub PR path** (rewriting
`reconcile.test.ts:428`)?
**Recommend yes.** The hard constraint is that reconcile logic is *shared, not duplicated* — `anchor.ts` is
pure and the server-side reconcile must import the same module the UI previews with, because divergence there
is the worst bug in the most important flow. A local-only fork of the delta logic would violate that
directly, so **"no" is a §5.1 finding rather than an option**. Must be ruled **before** M8.8.3 dispatches —
it is the point of no return.

**3. M8.10 OQ1/OQ2/OQ3 — blob prune defaults.**
**Recommend: prune default OFF; pruning runs only inside `deleteLocalReview`; deleting a review with an
unsubmitted draft refuses without an explicit force.**
Two refinements this session's rulings add. (a) Blobs are **content-addressed and shared** — they may serve
another snapshot — which is why pruning is not a side effect of deletion but its own opted-in step. (b) The
force question is now about **surprise, not data loss**: M8.1.3 settled that deletion orphans drafts rather
than destroying them, so a delete can never discard written text. That weakens the case for a hard refusal but
not the case for a confirmation. **The confirm dialog is new scope** — appended to the board, not absorbed.

**4. M8.2 OQ1 (behavioral half) — successor-mint vs one-way door on an archived triple.**

The schema hedge is already directed (generation discriminator in the unique key), so the DDL can express
either answer without a migration. The behaviour cannot be inferred and is needed before S5.
**Recommend the one-way door** (an archived triple does not mint a successor; the archived review stays the
review for that `(repo, base, head)`), because it is the answer that matches what the mock does **today**:
`createLocalReview` on an existing triple returns the **existing** review, and there is no archived state in
the mock yet. **Whichever way you rule, note the D6 consequence:** if you choose successor-mint, the *mock*
must change too — it is the specification, and the daemon may not diverge from it. That is a real cost on the
successor-mint side and the main reason to prefer the door.

**Two further rulings, surfaced by the adversarial review rather than by the tickets.** Both are **pinned
as-is** so nothing can diverge while they wait — neither blocks a session, but both shape M8.4.
- **Should the local reaction rollup stay shared-per-review?** Today a second human adding an emoji already
  present gets the unchanged rollup and no error. That matches the standing rule against per-human reaction
  simulation, but that rule was written for the shared-GitHub-bot case, and locally the rationale is gone.
- **Should submitting before the first sync be refused rather than succeeding invisibly?** Today it returns
  `ok` and creates no snapshot, so nothing is listable until a sync. Nothing is lost, and it is unreachable
  through today's UI — but it contradicts §6's premise that the client invalidates "expecting them to appear".

### Next

1. Merge **#69**, then **#70**.
2. Rule decision package #1 above.
3. **Sessions 2 and 3 both fork off `m8.1` and are genuinely concurrent** (zero shared files — `packages/app`
   vs `packages/revud`). On two machines that is the single largest schedulable win in the plan. S3 owns the
   splice. S3 needs rulings 1, 2 and 4; S2 needs none of them and can start immediately.
4. `ROADMAP.md` → Session 2 / Session 3 carry the wave plans; `SESSION_PROTOCOL.md` is unchanged and settled.

---

## 2026-08-12 — planned; ready to start Session 1

**State: clean.** `main` unchanged at `177068a`. Branch `m8/local-reviews-design`, PR
[#69](https://github.com/pat-mw/revu/pull/69) — docs + board only, gate green, awaiting human merge. Nothing
in flight, no implementation started.

**The workstream is fully planned.** [`ROADMAP.md`](./ROADMAP.md) is the execution plan;
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) is how sessions behave. Both were produced adversarially — the
roadmap by a three-way judge panel (max-parallelism vs stack-linear vs risk-first; stack-linear won
unanimously) then verified unit-by-unit against the real tickets: **every unit placed exactly once, zero invented ids,
every wave's file-disjointness checked against the tickets' own Files lines.**

**Five sessions, one linear chain:** `main → m8.1 → m8.6 → m8.7 → m8.2 → m8.3 → m8.4 → m8.5 → m8.8 → m8.10 →
m8.9 → m8.11`. S1 the spec · S2 the app · S3 the daemon core · S4 the join + hardening · S5 archive + the
proof. **S2 and S3 are genuinely concurrent** (zero shared files — `packages/app` vs `packages/revud`), so on
two machines serial depth is 4. A ticket's PR opens the moment its Verify goes green, mid-session, never
batched — that is what keeps a dead session's handover small.

**Test-first, verified.** A later audit pass took the ticket set from 74 to **87 units**: 67 Checks were
strengthened from one-time observations into durable assertions, 13 units were added for test work that had no
owner, and every ticket now carries a `## Testing exceptions` section naming what genuinely cannot be asserted.
The doctrine is `SESSION_PROTOCOL.md` §4 — test first and observed RED, guards before the code they guard,
negative controls for any assertion of absence. Two residuals worth knowing: wiring pins prove a call site is
present but not that it executes, and break-observe-revert controls are enforced by the Log requirement rather
than by CI — **a green Check with no logged red is unproven.**

**Start here: Session 1 — the spec** ([M8.1](./tickets/M8.1-contract-and-mock.md), 7 units + a spike). It is the fork point for S2 and S3, and the frozen-contract extension must be proven before 60+
units conform to it (D6). Its exit condition and wave plan are in `ROADMAP.md` → Session 1; a ready-to-paste
session prompt is in [`PROMPTS.md`](./PROMPTS.md).

**What S1 owes the human on completion:** decision package #1 — M8.5 OQ1 (how local-only is switched on),
M8.8 OQ2 (whether the commit-delta rewrite lands on the shipped GitHub PR path), M8.10 OQ1–OQ3 (blob-prune
defaults), and M8.2 OQ1's behavioral half. S3 ends blocked on those rulings, so S1's handover must state them
with a recommendation each.

**Decisions, hazards, and board hygiene:** unchanged from the entry below — read it too.

---

## 2026-08-12 — designed and seeded; no implementation started

**State: clean.** `main` is unchanged at `177068a`. One PR open: [#69](https://github.com/pat-mw/revu/pull/69)
— docs only, `bun run check` green, awaiting human merge. Working branch `m8/local-reviews-design`. Nothing
uncommitted, nothing in flight.

### What exists

| artifact | where |
| --- | --- |
| The design — surface map, 8 decisions, 26 edge cases | `docs/agent/LOCAL_REVIEWS.md` |
| Ticket seed text M8.1–M8.11 | `docs/agent/MILESTONES.md` → `## Milestone M8` |
| The board (**tracking source of truth**) | `.claude/workstreams/m8-local-reviews/` |
| Linear | milestone only — **its tickets could not be created** |

### ⚠️ Tracking is local now, not Linear

The Uzo Linear workspace is at its **free issue cap**: `save_issue` returns `You've exceeded the free issue
limit for this workspace`. Milestones, comments and status updates still write; **issues and sub-issues do
not.** So this workstream runs on the file board in `.claude/workstreams/`. Read
[`BOARD.md`](./BOARD.md) first — it is the only file that claims to describe right now. The protocol is
[`../README.md`](../README.md).

Do not attempt to seed M8 into Linear without first confirming the cap has been raised; a session already
burned eleven failed `save_issue` calls discovering this.

### The design in one paragraph

Very little of revu is actually about GitHub, which is what makes this cheap. `anchor.ts` is pure — its whole
input surface is a pending comment, a file list, a blob index, and a `resolveBlobLines(sha)` callback, all
derivable from `git diff --raw` / `git cat-file`. `reconcile.ts` never sees a client, a repo ref, or a token.
`blobs.ts` is already local-git-first. The two-half `compareKey` cache is provenance-blind. **Only 6 of 21
`RevuApi` methods touch GitHub.** So M8 is **one new snapshot producer + one new write sink**, not a parallel
application — and "re-sync after new commits" falls out of the existing cache for free, needing no new route.
The git side is not a downgrade either: `git diff --raw -M` yields both sides' blob SHAs, statuses and renames
in one command, with no 3000-file cap and no truncatable tree.

### Decisions not to relitigate

D1–D8, in [`MILESTONE.md`](./MILESTONE.md), full rationale in the design doc. The two most load-bearing:

- **D2/D4 — the identity is split across layers on purpose.** The reserved band (`>= 1e9`) identifies a local
  review at the **contract** level, which is what keeps `RevuApi`, all 21 routes, both routers' `n > 0` gates,
  the validators, `/pr/:n`, the two `/^\/pr\/(\d+)/` path regexes, and every React Query key unchanged. It must
  **never** be written to `snapshots.pr_number`, `audit_log.pr`, or `pr_author.pr` — the host collector and
  poll loop read those as real PR numbers. The store gets its own `local_*` tables.
- **D7 — the local write path has no GitHub client in scope.** Structural, not conditional, asserted by a test
  that fails if one is introduced. This is what makes "local comments never reach the client repo" a property
  of the code's shape rather than of a branch someone could mis-take.

### Hazards the next session must not walk into

1. **Rebase + `git gc`** — a rebase makes every SHA in a draft unreachable at once; `store.getBlob → null`
   degrades to `lost/line-deleted`, so **a rebase that changed nothing in a file can mass-classify every
   comment on it as lost, purely from missing objects.** New-commit detection then falls to the author-date
   heuristic, which **under-reports silently** (a rebase rewrites committer date, preserves author date).
   Owned by M8.8: pin objects under `refs/revu/reviews/<id>/<compareKey>`.
2. **Zero eviction exists in the store today** — the only `DELETE` is `deleteDraft`, no TTL anywhere. A
   rebased local branch orphans an immutable half on every sync. Owned by M8.10, which would be the first
   `DELETE` this store ever grows.

Two pre-existing bugs to inherit knowingly rather than reproduce: the optimistic reply path stamps
unconditionally (rendering `**Name** (role)` as literal body text when `botLogin === ''`), and a
reconcile-apply ending in `conflict` never updates `draft.headSha`, so the *next* reconcile counts new commits
from a stale head.

### Board hygiene — needs a human call

Two Linear issues sit **In Progress** but do not look in flight: **UZO-617** (M6.3 — Coder template wiring),
whose work appears shipped (image v23 rolled to all three workspaces), and **UZO-575** (M3.1 — Scratch App +
org), which the doc marks *deferred*. Left untouched rather than guessed at — a ticket only moves to Done when
its Verify has actually run green.

### Next

1. Human merges [#69](https://github.com/pat-mw/revu/pull/69) and the board PR.
2. Start **M8.1** — it is the spec (D6) and gates every other ticket. Read its ticket file; it carries its
   units, its Verify, and verified code anchors.
3. Then fan out: daemon core (M8.2 / M8.3 / M8.4, mutually independent → M8.5), app (M8.6 / M8.7, which need
   only the mock and never wait on revud), hardening (M8.8 after M8.3, M8.10 after M8.2). M8.11 closes.

Still open from before this workstream and unrelated to it: `pr_author` has no writer in production
(UZO-968), so every PR reports `authorHumanId: null` live; and `docs/security-review.md` is out of date, its
threat model predating the hostile-PR-commenter work. M8.11 adds a third item to that doc's backlog.

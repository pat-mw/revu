# M8 — handover

Cross-session handover. **Newest at the top** — the first entry is the live one. Written so a cold agent can
act from it alone.

---

## 2026-08-14 — Session 2 (the app) — **decision package #1 is RULED; 16 standing rulings below**

> **These rulings are settled. No later session relitigates them.** Decision package #1 is complete, so
> **Session 3 is unblocked** and can start on another machine immediately. Where a ruling changes a ticket's
> text or the roadmap's exit condition, the amendment is stated under _Amendments the rulings force_ — the
> ruling wins over the ticket, exactly as M8.1.8's ruling superseded M8.1.5's text.

### State — live

Branch **`m8.7/app-local-chrome`**, based on `m8.6`. `main` untouched at **`177068a`**; nothing merged.
The merge protocol in the entry below is unchanged: **nothing merges until the whole workstream lands.**

**The chain, bottom-up:** `main` → `m8/local-reviews-design` ([#69](https://github.com/pat-mw/revu/pull/69))
→ `m8.1/contract-and-mock` ([#70](https://github.com/pat-mw/revu/pull/70)) →
`m8.6/app-creation-flow` ([#71](https://github.com/pat-mw/revu/pull/71)) → `m8.7/app-local-chrome` (no PR yet).

| ticket | state | PR |
| --- | --- | --- |
| M8.1 | `In Review` — **9 units** (M8.1.9 appended by a ruling this session) | [#70](https://github.com/pat-mw/revu/pull/70) |
| M8.6 | `In Review` — 7 units, `Verify` green incl. the recorded browser walk | [#71](https://github.com/pat-mw/revu/pull/71) |
| M8.7 | `In Progress` — M8.7.10 (the static-render harness) in flight, nothing landed | — |

**Gate after every unit, never batched: 1246 → 1362 pass · 1 skip · 0 fail · 76 files**, and **every gate was
re-run by the orchestrator in the main tree** rather than trusted from a worker's isolated one.

> ⚠️ **If `BOARD.md`'s In-flight section is not empty when you read this, the session died mid-wave.** Nothing
> on `m8.7` has landed; discard any uncommitted worktree and re-dispatch from M8.7.10. Do not archaeologize
> unlanded work.

### What the two adversarial reviews found — the reason to keep running them

Both found **real defects**, not nits, and one falsified an assertion that had been recorded as passing.

- **M8.1.9's review** proved the refusal real (neutralize the guard → exactly its two assertions fail; blanket
  throw → both fail *at their controls*) but found the frozen `unprocessable` docstring **excluding the
  meaning the refusal gives it** — a daemon author reading that discriminator would emit `conflict`/409 and
  **pass the entire conformance suite**, which has no local-review coverage. Also that the guard's key was
  invisible to the suite: swapping it left all 1246 tests green, though the two keys disagree with **opposite**
  outcomes on a split document. Both fixed in `8b73a77`.
- **M8.6's review** found the **command palette rendering `#1000000001`** and making a review findable by
  typing an id no user is ever shown — on a surface the ticket's own text says shows the branch pair. It was
  never asserted because a command dialog serializes to `''` through its portal: **the same blind spot the row
  tests were split apart to avoid, one surface over.** It also found the keyboard gate's one-line derivation
  deletable with the whole suite green, reset-on-open asserted by nothing, and a docstring **claiming a guard
  nobody had written**. All fixed in `a637522`.

> **The single most instructive observation of the session:** a source pin's first draft **passed with its
> guard deleted** — a loose regex matched an identical line in the `catch` branch. Only the mandatory negative
> control caught it. **A source pin is exactly as strong as the control that proves it can fail**, and this was
> the second time in the session a guard was found asserting nothing.

### Deviations from the roadmap's S2 plan — all four recorded with reasons

1. **W1 ran as M8.6.7 alone, not `∥ M8.7.10`.** M8.7.10's files belong to `m8.7`, which did not exist yet;
   running it early means holding an uncommitted diff across seven units — the unlanded work §7 says to
   discard rather than reconstruct. It runs first on `m8.7` instead.
2. **W2/W3 run worktree-isolated where the roadmap says "none".** Two agents in one tree cannot each run
   `bun run check` — it ends in `vite build` and concurrent builds race on the same `dist`. "None" assumed the
   wave was sequenced; per-unit gating is the harder requirement.
3. **W4 was serialized rather than parallel.** The roadmap flagged one shared file; there are **three**, one of
   them the shared test — where "different regions, trivial merge" stops holding. Two workers restructuring the
   same helper is a §5.5 stop, and manufacturing one to buy a single unit of wall-clock is the trade the
   roadmap's own critical-path note warns against.
4. **M8.1 was reopened.** Ruling 6 changes the mock, and the mock is the specification, so the refusal had to
   land there rather than in the daemon. #70 is unmerged, so it is an added commit, not rewritten history.

### Harness hazards this session paid for — all now in `memories/known-landmines.md`

1. **An isolated agent worktree is created at the repo's BASE commit, not the branch tip, and has no
   `node_modules`.** Two agents lost real time before every brief carried a mandatory STEP ZERO
   (`git log` → `git merge --ff-only <tip>` → `bun install`, and any result from before it is void).
2. **The lint pass reads an agent worktree unless `.gitignore` covers it *on the branch being gated*.** Gating
   `m8.1` linted a running agent's half-finished file and failed on work that branch does not contain. The
   ignore entry now sits at the bottom of the chain where every branch inherits it.
3. **The preload's `document` stub has no `documentElement`** — the *second* import-time wall, after the
   missing `location`. `@/state/theme` → `@/lib/highlight` reads it at module scope, so **anything importing
   `app-shell.tsx` is still unimportable from a test.** M8.7 renders far more chrome and will meet this.
4. **Synthetic key injection does not reach the app's global handlers** in the browser harness (⌘K will not
   open the palette), so keyboard legs of a walk cannot be driven. M8.6's Verify step 6 is recorded as **not
   run**, not as passed.

### Standing rulings — owner, 2026-08-14

**Decision package #1 (was blocking Session 3 — now closed).**

1. **M8.5 OQ1 — local-only is switched on by an EXPLICIT flag/env.** Never automatic-on-resolution-failure.
   The rejected option turns a transient `gh` failure — expired token, flaky network, misconfigured remote —
   into a silently local-only daemon: the human keeps working, comments land nowhere near GitHub, and nothing
   says so. **Consumed by M8.5.4**, which shapes its option around this.
2. **M8.8 OQ2 — YES, the commit-delta rewrite lands on the shipped GitHub PR path**, rewriting
   `reconcile.test.ts:428`'s expectations in the same commit. One delta implementation, imported by both
   paths. A local-only fork would violate the standing hard constraint that reconcile logic is shared and not
   duplicated. **Must be in hand before M8.8.3 dispatches — it is the point of no return.**
3. **M8.10 OQ1/OQ2/OQ3 — prune default OFF; pruning runs only inside `deleteLocalReview`; deleting a review
   that holds an unsubmitted draft requires an explicit force / a confirmation.** Blobs are content-addressed
   and shared, so an unattended sweep can degrade another snapshot's comments to `lost`. The confirm dialog is
   **new scope** — appended to the board as its own ticket (below), never absorbed into M8.10.
4. **M8.2 OQ1 (behavioral half) — the ONE-WAY DOOR.** An archived triple does not mint a successor; the
   archived review stays the review for that `(repo, base, head)`. This is what the mock does today, so it
   costs zero mock change. The generation discriminator stays in the unique key as a no-migration escape hatch
   for a later milestone.

**Surfaced by M8.1's adversarial review.**

5. **The local reaction rollup stays SHARED per review**, exactly as pinned. A duplicate emoji from a second
   human is a silent no-op. **M8.4 reproduces it.** In the single-human local case — the overwhelmingly common
   one — shared and per-human are the same thing, and per-human simulation remains a thing this project does
   not build.
6. **Submitting before the first sync is REFUSED**, with `unprocessable` (422) and a message naming sync as
   the fix. ⚠️ **This changes the mock, which is the specification** — so it lands as **appended unit M8.1.9**
   on `m8.1/contract-and-mock`, inside M8.1's own Goal (same precedent as M8.1.8; existing units are not
   renumbered). PR #70 is unmerged, so this is an added commit, not rewritten history. It gets its own
   fable-tier review. **M8.4's sink must refuse identically.**

**M8.6 / M8.7 — the app's own questions (the roadmap's pre-flight defaults were NOT applied; each was put to
the owner).**

7. **M8.6 OQ2 — the `Local reviews` section renders iff `listLocalReviews()` returns ANYTHING**, archived and
   closed rows included. Position is conditional: **above `Waiting on you` when it has open rows, below every
   other section when it is empty**, and absent entirely when the human has no local reviews at all. The
   literal "show only if ever used" was rejected *by me, not by the owner*: it needs persisted per-human state,
   whose only sanctioned home is `HumanPreferences` in the frozen `types.ts` — a contract amendment and a §5.2
   stop. The `listLocalReviews` derivation captures the same intent with no contract change; its only gap is
   that deleting every local review removes the section again, which is correct behaviour rather than a gap.
8. **M8.7 OQ1 — `/pr/<local>/checks` and `/pr/<local>/description` REDIRECT to `files`.** The decision is the
   pure `redirectTargetFor(mode, tab)`, never an inline ternary, and `App.tsx` carries a `readFileSync` pin
   that it imports the function. This closes the bookmark hole that otherwise leaves the two worst strings in
   the inventory one URL away.
9. **M8.7 OQ2 — the rate chip is suppressed WORKSPACE-scoped, not route-scoped**: it disappears when the
   workspace has no GitHub at all, not merely when a local review is open. The owner ruled this **with the
   consequence made explicit**: under `?mock=1` the workspace *does* have GitHub, so the chip still renders on
   the fixture local review, and the roadmap's S2 exit condition is amended accordingly (below). The M8.7 work
   is therefore `showRateChip({ rateAvailable })` plus the real fix — **distinguishing *loading* from
   *unavailable* so the chip OMITS rather than skeletons forever**. **New M8.5 obligation, appended below.**
10. **M8.7 OQ3(a) — the local marker is `Badge variant="outline"`, not a second `.seal`.** Violet is reserved
    for pending work and gold for "time moved"; a local marker is a provenance fact. No new CSS class —
    `globals.css` stays a read-only shared input.
11. **M8.7 OQ3(b) — the `open`/`closed` state chip KEEPS rendering, with local wording**, via a pure
    `stateChipCopy(mode, state)` in `lib/mode-copy.ts`. M8.7 owns the `open` branch; **M8.9.6 owns the
    archived branch and reconciles with this function rather than adding a second one.**
12. **M8.7 OQ4 — the author row RENDERS the local human plainly** (initials disc, no org ring, no github.com
    title). The org-member treatment that the sentinel author drags in is killed separately in M8.7.6, and
    that fix is load-bearing for this ruling — if it regresses, this row is where it shows.
13. **M8.7 OQ5 — the Walk-threads action SURVIVES on a local review, under local copy**; only the "You
    authored this PR" framing is suppressed. A contractor walking the reviewer's feedback on their own branch
    is the most valuable local flow and this is its only discoverable door.
14. **M8.7 OQ8 — the local submit toast is "Review saved — N comments on this branch."** Claims no API call,
    no post; "on this branch" is the honest noun. Summary-only submits take the parallel form.
15. **M8.7 OQ6 — the Conversation tab STAYS on a local review**, threads-only, with an empty state that is an
    invitation pointing at Files (asserted to match `/files/i`, so a sweep cannot reduce it to a bare noun).
    Keeping it also keeps the `go-conversation` chord un-orphaned, which M8.7.7 asserts.

**Orchestrator ruling forced by #12 + #13 (recorded, not owner-asked, because it is a derived consequence).**

16. **The author-banner slot becomes a vertical STACK, ordered superseded → dirty worktree → walk threads.**
    Three components now want that one `empty:hidden` slot. Each is props-only and decides its own visibility,
    so M8.7.8's `toBe('')` assertions still hold per component, and **M8.9.6's superseded banner appends to the
    stack rather than displacing anything.**

**Implementer calls made this session** (each was explicitly an implementer call in its ticket, so they were
decided rather than put to the owner):

- **M8.6 OQ4 (tree)** — local reviews are EXCLUDED from `buildPullTree`'s input and rendered as their own
  group above the roots. A local review can never *steal* a parent (`byHead` resolves ties by lowest number and
  a ≥1e9 id always loses) but it CAN become one, nesting a real PR under something that does not exist on
  GitHub. The Tree arrangement therefore shows the same reviews as List, just grouped — which is what
  `inbox.tsx:419` promises.
- **M8.6 OQ5 (chord)** — **`g l`**, registered SHELL-side, catalog group `Global`. `g i`/`g f`/`g c` are the
  live `g` prefixes and `l` is free; the shortcuts test asserts no two entries claim the same keys, so a
  collision is caught in-gate rather than by eye. Shell-side registration makes the chord work from a PR page,
  matching the palette entry's global reach, and lifts the dialog into the shell's existing three-overlay set.
- **M8.6 OQ6 (title editable after creation)** — **NO.** M8.1 froze the route set at `GET /api/branches`,
  `POST /api/local-reviews`, `GET /api/local-reviews`, `DELETE /api/local-reviews/:n`. There is no update verb,
  so the title is chosen once, in the dialog, forever. This is a fact about the frozen contract, not a
  preference; the dialog's docstring says so.
- **M8.7 OQ7 (unresolved-thread count badge)** — **keep reading `item.broker.unresolvedThreads`**; do not
  compute it client-side. The mock populates it on a local row (M8.1.6's walk observed it at `1` after a
  submit), and D6 binds the daemon to match. **New M8.5 obligation, appended below.**

### Amendments the rulings force

Each of these is a ticket or roadmap text that a ruling above now overrides. **The ruling wins.**

1. **`ROADMAP.md` → S2 exit condition: "no rate chip" LEAVES the recorded `?mock=1` walk** (ruling 9 — the
   mock workspace has GitHub, so the chip legitimately renders there). It is replaced by the in-gate predicate
   assertion on `showRateChip({ rateAvailable })` in both states. Everything else in the S2 exit condition
   stands.
2. **M8.6.4's Check "the local section is first" becomes CONDITIONAL** (ruling 7): first when the section has
   open rows, LAST when it is empty, absent when there are no local reviews at all. Section *position* is now a
   property of the pure `buildInboxSections` and is asserted in all three states.
3. **M8.6.2's annotation query gains one more reader — section PRESENCE** (ruling 7). This is deliberately not
   a two-truths violation: the annotation query supplies a boolean about existence, never a row, a title, a ref
   pair or a `broker.*` field. `usePullList` remains the sole row source. Say so in the docstring, because the
   next reader will check.
4. **M8.7.6's rate-chip gate is `showRateChip({ rateAvailable })`, not `showRateChip(mode)`** (ruling 9), and
   the unit's real work is the loading-vs-unavailable distinction, not a mode branch.
5. **M8.7.3 gains `stateChipCopy`** (ruling 11) and **renders the author row** (ruling 12) rather than
   suppressing it; **M8.7.3/M8.7.8 share the banner slot as a stack** (ruling 16).
6. **M8.1 gains unit M8.1.9** (ruling 6). Units are appended, never renumbered.

### New scope appended to the board — NOT absorbed

- **M8.12 — delete-confirm for a local review holding an unsubmitted draft** (ruling 3). The API force flag is
  M8.10's; the dialog and its copy are net-new UI that no ticket owns.
- **M8.5 obligation — a local-only daemon must make `getRateLimit` UNAVAILABLE** (a typed error / 501), never
  fabricate a bucket (ruling 9). Without it the app cannot tell "no GitHub" from "still loading" and the chip
  skeletons forever.
- **M8.5 obligation — local list items must carry a populated `broker.unresolvedThreads`** (OQ7 call). If the
  daemon ships local rows with an unpopulated broker block, the badge silently never appears — and the same
  block feeds `useStaleness`, which has no fallback, so a quiet seal would look like a fresh snapshot.

---

## 2026-08-13 — Session 1 (the spec) — M8.1 landed; **decision package #1 below needs your rulings**

> **Read the four rulings in "Decision package #1" first if you read nothing else.** Session 3 ends blocked on
> them, and Session 4 cannot start without three of them.

### State

**M8.1 is `In Review`. PR [#70](https://github.com/pat-mw/revu/pull/70) is open**, on base
**`m8/local-reviews-design`** (PR [#69](https://github.com/pat-mw/revu/pull/69)), **not** `main`. That is
deliberate: the board and `docs/agent/LOCAL_REVIEWS.md` exist only on that branch, so a `main`-based branch
would strand every board write. #69 carries **zero files under `packages/`**, so #70's code diff is identical
to a `main`-based one. Nothing was committed to `main`; nothing was merged. Working tree clean, In flight
empty.

> ### ⚠️ Merge protocol for the rest of M8 — set by the owner 2026-08-13
>
> **Nothing merges until the whole workstream lands.** Every session **keeps stacking**: branch off the
> previous ticket's branch, open the PR with that branch as its base, never merge, never retarget to `main`.
> The chain reaches ~12 PRs before anything merges, and `main` stays at `177068a` throughout.
>
> Consequences a cold agent must not rediscover:
> - **#70 will NOT auto-retarget to `main`** — it stays based on #69 for the duration. Any handover text
>   assuming an early merge is stale.
> - **Rebase-on-merge never happens mid-workstream**, so the "when a base merges, rebase the rest of the
>   stack" step in `SESSION_PROTOCOL.md` §6 simply does not fire. The chain order in `ROADMAP.md` is
>   therefore load-bearing for the whole milestone, not just until the first merge — it is what keeps every
>   later rebase mechanical.
> - **The concurrent S2 ∥ S3 splice matters more, not less.** With no merges thinning the chain, whichever
>   of the two finishes second rebases its lane onto the other's tip before opening PRs (S3 owns the splice,
>   per `ROADMAP.md` §6).
> - The exit-criteria walk at the end of S5 runs against the assembled chain head, never against `main`.

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

1. **Interview the owner interactively on the open questions before dispatching anything that consumes them.**
   The owner has asked to be asked rather than to have recommendations applied — so decision package #1 above
   (M8.5 OQ1, M8.8 OQ2, M8.10 OQ1–OQ3, M8.2 OQ1's behavioral half) **and** the two rulings the adversarial
   review surfaced (the shared reaction rollup; whether submit-before-first-sync should be refused) are put to
   them directly at the **start** of the next session. The recommendations above are the starting position for
   that conversation, not a default to apply. Record each answer in `HANDOVER.md` as a standing ruling so no
   later session relitigates it.
2. **Then run Session 2 — the app** ([M8.6](./tickets/M8.6-app-creation-flow.md),
   [M8.7](./tickets/M8.7-app-local-chrome.md)), stacked on `m8.1`. It is the natural next link in the chain
   (`m8.6` sits directly above `m8.1`) and it consumes **none** of the rulings, so it proceeds regardless of
   how the interview goes.
3. **Session 3 — the daemon core** is unblocked the moment rulings 1, 2 and 4 are given. S2 and S3 are
   genuinely concurrent (zero shared files — `packages/app` vs `packages/revud`); on two machines that is the
   single largest schedulable win in the plan, and S3 owns the splice.
4. `ROADMAP.md` → Session 2 / Session 3 carry the wave plans; `SESSION_PROTOCOL.md` is unchanged and settled,
   **except** that §6's "when a base merges, rebase the rest of the stack" never fires this milestone — see
   the merge protocol above.

**What Session 1 confirmed the app work will find** (from the recorded `?mock=1` walk, not speculation): a
local review today renders the synthetic id `#1000000001`, a `Description` tab, a `Checks` tab, an `open`
state chip and an "org PR — approvable" chip. Every one is a GitHub-flavored affordance M8.7 exists to
remove, so S2's exit condition is genuinely unmet rather than accidentally already satisfied.

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

# M8 board — local-only reviews

**Start here.** This file is the only one that claims to describe *right now*. It wins over any `State` row
in a ticket file; the two change in the same edit.

Workstream: [`MILESTONE.md`](./MILESTONE.md) · Handover: [`HANDOVER.md`](./HANDOVER.md) · Work log:
[`LOG.md`](./LOG.md) · Plan: [`ROADMAP.md`](./ROADMAP.md) · How sessions run:
[`SESSION_PROTOCOL.md`](./SESSION_PROTOCOL.md) · Design:
[`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md)

## In flight right now

**M8.5 (daemon wiring) is IN PROGRESS on `m8.5/daemon-wiring`, branched off the `m8.4` tip at `90d3876`.**
The daemon track below it (M8.2, M8.3, M8.4) is complete and in review on #73 / #74 / #75.

| unit | tier | state |
| --- | --- | --- |
| **OQ5 design pass** — the seam + the five findings | fable | ✅ spec only |
| **M8.5.4** — boot relaxation | opus | ✅ `5bfdf38` — 2453 · 1 · 0 · 91 |
| **M8.5.1** — band dispatch | opus | ✅ `369af01` — 2458 · 1 · 0 · 92 |
| **M8.5.9** — two daemons on one data dir | opus | ✅ `6a837ae` — 2460 · 1 · 0 · 92 |
| **M8.5.2** — create / list / branches routes | opus | ✅ `4a281ba` — 2474 · 1 · 0 · 92 |
| **M8.5.10** — the local surface factory | opus | ✅ `d239db6` — 2528 · 1 · 0 · 93 |
| **M8.5.5** — boot assembly | opus | ✅ `eb1eb5c` — 2563 · 1 · 0 · 94 |
| **M8.5.3** — `listPulls`, local merged | opus | ✅ `fd5aca1` — **2568 · 1 · 0 · 94** |
| **M8.5.8** — the write path's router band handling | opus | ✅ `c462105` — **2571 · 1 · 0 · 94** |
| **M8.5.6** — honest degradation (+ the exit-criterion unblock) | opus | ✅ `5b7057c` — **2577 · 1 · 0 · 94** |
| **M8.5.7** — the end-to-end HTTP proof, offline | opus | ✅ `6f52c96` — **2605 · 1 · 0 · 95** |

**All ten units are landed and `Verify` is GREEN** — 171 pass across the seven Verify suites, 92 pass across
the four that must be untouched (and `git diff` confirms all four byte-unchanged), the mode axis held, and the
frozen contract unedited. Full diff: **26 files, 7792 insertions**.

### ⚠️ The pre-merge review found FOUR blockers, all reproduced. The PR is held.

Six lenses over the full diff, each finding put to two independent verifiers — one reasoning to refute, one
attempting an actual reproduction — with only findings **both** agreed on treated as real. 27 raw findings,
4 confirmed, 3 contested, and a dismissal list so the next session does not re-raise them.

**This is the fourth ticket running whose pre-merge review caught something a green gate did not.**

| # | defect | why it matters |
| --- | --- | --- |
| **M1** | `--local-only` inside a **GitHub clone** still resolves the repo and builds a client, but skips the token probe — so `viewerLogin` is `undefined` while `githubEnabled` is `true` | The approve gate inverts to always-false with a **factually untrue** message, and the submit idempotency re-check compares against `''` and can never match. Both reproductions **posted duplicate reviews with duplicate inline comments to a real pull request.** |
| **M2** | Local review lookup is **never scoped by repository** — `deps.repo` is a listing filter and nothing else | A daemon in one repo accepted `syncPull` on another's review, resolved refs against the wrong toplevel, stamped the wrong SHAs onto the row, and landed a durable thread anchored to a file that exists only in the other repo. The payload still reported the original repo, so the corruption is invisible. **The thread is the part that does not heal.** |
| **M3** | `writeSnapshotRows` is still a **deferred** read-then-write transaction, so the new busy timeout does not cover the snapshot persist | Measured: deferred threw `database is locked` in 1.3ms; immediate succeeded after 395.8ms. A peer taking the lock mid-sequence leaves threads and summary written with **no envelope** — the only durable home for the authorship map. |
| **M4** | The list ETag hashes **compare keys alone** | A submit or resolve moves `unresolvedThreads` and **no** SHA, so the inbox 304s forever on a stale count. The docstring directly above asserts the opposite property. Four independent reviewers found it. |

Three of the four are contradicted by docstrings this branch also introduces — the strongest available signal
that the author's model and the code disagree.

**Two SHOULD-FIX, both being fixed with them:** a deleted head branch answers "the broker is unreachable" on a
daemon with no broker; and `--local-only` **without** `--direct` silently boots mock mode and serves the
fixture app.

**All four blocker fixes landed**, each re-gated by the orchestrator in the main tree:

| fix | commit | gate |
| --- | --- | --- |
| **M3** — the snapshot persist takes the write lock at `BEGIN` | `6b0b047` | 2606 · 1 · 0 · 95 |
| **M2** — repo-scoped review lookup + typed head errors | `e167923` | 2614 · 1 · 0 · 95 |
| **M1 + M4 + the mode/flag refusal** | `b605ac3` | **2625 · 1 · 0 · 95** |

`Verify` re-run after the fixes and still green: 182 pass across the seven suites, 92 across the four that
must be untouched, all four still byte-identical, mode axis and frozen contract intact.

### ⚠️ The review's own prescription was wrong, and the implementer caught it

The review prescribed adding `session.viewerLogin !== undefined` to the api's `githubEnabled` capability, and
the orchestrator relayed it. **That would have introduced a new regression.** `GITHUB_ONLY_PULL_ROUTES`
contains `syncPull` and `getSnapshot` — both **reads** — and a broker booted without a bot login legitimately
carries no `viewerLogin` while still being required to serve them. The guard would have answered those reads
with a 501 about a missing repository, and **no existing test would have caught it** (broker-serve uses a
hand-built fake api, and the reads-only conformance write cases are refused by an earlier gate). The invariant
was placed at the write bundle instead, which is exactly the surface where the two guards invert, and the
deviation is pinned by its own test. Verified independently by the orchestrator before accepting it.
**A reviewer's prescription is not automatically right either.**

### The flake rule paid for itself

One gate run during the fix round went red with six ~5000ms hook timeouts and **2591 tests registered against
2615**. The count discriminator classified it as the known load artifact rather than a failed Check; a re-run
on a quiet tree was green. No spurious tier escalation, no test weakened.

### 🔴 CI IS RED ON #74 AND #75 — one test, and `m8.5` would have failed the same way

Raised by the owner. `check` fails on **#74** and **#75** (which skips `conformance-matrix` and `e2e` on both);
#69–#73 are fully green. **One test, the same on both:**

```
(fail) the commits of a range arrive oldest first
       > the dates come back in UTC, whatever offset the machine authored under
```

**It is a control with a false premise, and it is environment-dependent.** The control asserts git's raw
`%aI` output carries a numeric offset, with a comment claiming *"It holds on a machine running in UTC too,
where git prints `+00:00`."* **Git does not.** `%aI` is strict ISO 8601, which prints **`Z`** for a zero
offset — measured on git 2.50.1, so not even a version difference:

| authored at | `git log -1 --format=%aI` |
| --- | --- |
| `+01:00` | `2026-08-19T15:40:03+01:00` |
| **`+00:00`** | **`2026-08-18T10:00:00Z`** |
| `+05:30` | `2026-08-18T10:00:00+05:30` |

The fixture pins commit **identity** — explicitly because a CI runner has none — but never pins the commit
**timezone**, so every fixture commit inherits the machine's offset. A developer machine passes; a UTC runner
fails. **The local gate could never have caught this**, and `m8.5` would have failed CI identically the moment
its PR opened.

**Relaxing the regex to also accept `Z` would be the wrong fix** — it would make the control *vacuous on CI*,
where git's output would then be byte-identical to the converted output and prove nothing exactly where it
currently fails. That converts a red into a guard that asserts nothing, this project's most-measured defect
class. The fixture is pinned to a **non-UTC** offset instead, so the conversion genuinely does work everywhere.

The conversion logic itself is sound and already has a deterministic guard (`local-sync.test.ts:3185` pins
`+01:00` → `.000Z` through a fake runner). Only the real-git integration control was environment-dependent.

**Fixed at the root, not on the tip:** it lands on **`m8.3`**, so `m8.4` and `m8.5` inherit it by rebase.
Fixing only on `m8.5` would leave #74 and #75 red — the divergence the owner flagged. Rebase order:
`m8.3` → `m8.4` → `m8.5`, **re-gating in the main tree after each**, because a clean rebase is not a proof and
one turned a guard red in a previous session.

### The `setPreferences` lost-update race — fixed, held for landing

Owner-requested, **out of M8 scope**, so it rides its **own branch stacked on the rebased `m8.5`** rather than
widening the daemon-wiring PR. Gate in its worktree: 2626 · 1 · 0 · 95. The red was deterministic across three
runs — the child committed one key, the parent patched a different one and put back a document carrying the
default for the first. **Neither side threw; both writes "succeeded".**
*Its negative control was stronger than the one asked for:* it held the transaction constant and varied only
the **read's position**, proving the test measures where the read happens rather than merely that a
transaction exists. And it sharpened the diagnosis — a WAL reader never blocks, so the untransacted `SELECT`
returns immediately and the busy timeout then makes the *upsert* wait, which means the timeout **widens** the
staleness window rather than merely failing to close it.
*New finding, no owner:* `setViewed` / `setLocalViewed` take a **whole** state object, so that
read-modify-write lives in the **caller**, outside the store — the same lost-update class may exist there and
the store's API shape cannot prevent it. Callers not investigated.

**In flight:** a **second-pass adversarial review of the fix diff only** — four lenses hunting the two failure
modes specific to reviewing a fix (the original defect not actually closed, and the fix breaking something that
worked). And, at the owner's direct request, the **`setPreferences` lost-update race** (out of M8 scope, in an
isolated worktree so it cannot disturb the tree the review is reading; it will ride its **own branch stacked on
`m8.5`**, not this PR, since it is not daemon wiring).


**The review also named coverage gaps worth keeping:** the 304 empty-body assertion cannot fail (the transport
strips the body — the implementer had already flagged this independently); the "either half moves the etag"
case moves only the field that *is* in the composition, so it would still pass with M4 present; nothing
verifies the network tripwire is actually installed in the child; and there is **no cross-repository test
anywhere in the codebase**.

**Every gate above was re-run by the orchestrator in the main tree**, never trusted from a worker's isolated
one, and every number matched the worker's report.

### M8.5.10 was appended because the factory had no owner

The ticket's M8.5.5 assembles "the local surface" and its four Check blocks all test **boot seams** — the mode
tripwire, the requirement switch, root discovery, the startup line. None of them touches the wiring itself, so
the factory that maps the store onto the write port, computes the head, and sources the default branch was
assumed rather than assigned. Appended as its own unit rather than absorbed into boot wiring, where its three
traps would have been invisible to M8.5.5's Check.

### ⚠️ The router chain is serialized, correcting the roadmap

`ROADMAP.md`'s S4 plans **M8.5.2 ∥ M8.5.3** with a "sanctioned trivial merge" on `direct-router.ts`. That
repeats the exact assumption that already cost the app track and the daemon track a re-plan: **integration is
by copying whole files out of an isolated worktree, so two workers on one file means one is silently
discarded.** `.2`, `.3`, `.8` and `.6` all write `direct-router.ts` **and** `direct-router.test.ts`. Honest
order: **`.1` → `.2` → `.3` → `.8` → `.6` → `.7`**, with `.5` (which owns `index.ts`) running beside the chain
once `.1` lands, and `.9` beside it throughout.

`.6` must land **after** `.2`, not before: its route-partition assertion classifies every route as
served / degraded / not-implemented, and until `.2` serves them the four local-review routes sit in **none** of
those buckets — they answer 501 through the *generic* fall-through while not being in `NOT_IMPLEMENTED_ROUTES`.
Asserting a three-way partition today would either fail or require calling them "not implemented", which is
false.

### ⚠️ The ticket contradicts itself on M8.5.4's blast radius — resolved by measurement

The Units preamble calls M8.5.4 "fully independent of M8.5.1–M8.5.3 — it touches `direct/context.ts` +
`direct/session.ts`". Its own **Landmines** section says the opposite: making `DirectContext.repo` typed-absent
"ripples" into `createDirectApi({repo})`, `runSyncPull`, `provisionBlobs` and the poll loop. M8.5.1 was held
until M8.5.4 reported what it actually touched. **It touched `index.ts`, not `direct-api.ts`** — five reads of
`context.repo` and two of `context.github` across `mainDirect` and `mainBroker`, folded behind one exported
total narrowing function. So the collision did not materialise, but it was real enough to be worth the wait.


**Gate at the branch point (`90d3876`), re-run in the main tree:** 2445 pass · 1 skip · 0 fail · 91 files.

⚠️ **The gate is not perfectly deterministic.** One run in six went red with **9 fail** and *three fewer tests
registered* (2443 vs 2446) — the signature of a fixture-driven suite blowing the default 5-second hook budget
under load, which is already on record as an unowned finding. Four subsequent runs were green, including two
run concurrently. **Rule for this session: tee every gate run to a log, and treat a red as a failed Check only
when it reproduces on a quiet tree with the same `(fail)` lines.** The first red was lost by not teeing it.

### Decisions taken this session on M8.5's open questions

The ticket delegates these; they are settled so no unit re-decides them mid-flight.

- **OQ1 — how the local-only capability is switched on: an EXPLICIT switch**, never automatic. Automatic
  relaxation on a failed repo/token probe means a transient `gh` failure inside a genuine GitHub clone boots a
  daemon that silently shows an empty inbox — which reads as data loss. Pinned by M8.5.5's
  `resolveGithubRequirement` table.
- **OQ3 — `GET /api/rate-limit` on a GitHub-less daemon answers a typed `not_implemented` (501)**, not the
  synthetic rate shape. The synthetic shape stays *inside* `PullListResponse` per §4.1, which is a different
  surface. M8.7's rate chip is already three-valued (`null` loading · `false` unavailable · `true` available)
  and omits on unavailable, so 501 lands on a designed path rather than a new one.
- **OQ4 — merged ETag composition** follows the M4 broker precedent: a hash over both halves, so a change in
  either moves it. Ordering is deterministic — broker items in poll-loop order, then local items by id
  descending.
- **OQ6 — `bin/revu` does NOT gain a local-only path in this ticket.** The milestone's headline exit criterion
  is proven against `revud` directly (M8.5.7 durably, plus the manual drill). The CLI path is a follow-up, not
  a silent absorption into M8.5.
- **Finding 5 — the untyped storage failure on the local write path is NOT touched.** Whether it should be
  `persist_failed` is the owner's call and is reserved. Any envelope work in M8.5.2/M8.5.6 must leave that
  path's observable code unchanged.

### ⚠️ The three blockers the pre-merge reviews found — none was visible to any suite

Every one of these passed a green gate. **This is the argument for reviewing the full diff before the PR opens
rather than after.**

1. **M8.2 — a corrupt id high-water mark minted `id 1`.** SQLite casts a non-numeric string to `0` silently, so
   the increment produced a value **inside the forge's pull-request range**, in the table whose entire purpose is
   to stay out of it, and then **overwrote the corrupt value**. Fixed in the statement's `WHERE` clause, because
   the entity allocator has no surrounding transaction and a check on the result would refuse only after the
   overwrite committed.
2. **M8.3 — a typechange made a review unbuildable.** Git reports it once in the raw and numstat reads but splits
   it into **two** patch sections, so the index zip refused the whole change set — and it falsified this ticket's
   own *verified* claim that the three reads agree. The fixture seeded only a symlink *addition*, so nothing
   caught it. **Plus:** the patch read inherited the user's git config, so **any external differ emitted zero
   sections** — every local review in that repository unbuildable.
3. **M8.4 — the D7 structural guard was evadable, demonstrated end to end.** Its closure walk resolved a relative
   import to a `.ts` sibling only, so a helper with any other extension was invisible at every depth. A real
   client imported that way left **the guard green, the compiler happy and the whole suite passing** while
   loading at runtime. Fixed with an **allowlist** — every relative specifier must resolve into the pinned set —
   because teaching a walk more extensions is a ban list, and this workstream has measured sixteen and found a
   dead member in twelve.

**And one that was not a blocker only because dispatch is not wired yet:** both write verbs read the snapshot,
awaited head resolution, then wrote an envelope built from the **stale pre-await read**, so a reply that fully
persisted in that window was **erased** by a concurrent submit — comment and authorship entry gone — while both
verbs answered success. Fixed by re-reading after the single await.

### A cross-lane defect only the rebase could reveal

Merging lane C onto lane B turned one test red: M8.3.1's `process.cwd()` coverage guard, which asserts its
scanned list equals the modules **actually present** in the directory. Combining the branches put three
write-path modules there. **The rebase was clean, every file was disjoint, and the defect was still real** — the
single strongest argument for re-gating after a rebase rather than trusting it.

| ticket | state | where |
| --- | --- | --- |
| M8.1 | `In Review` — 9 units | PR [#70](https://github.com/pat-mw/revu/pull/70), base `m8/local-reviews-design` |
| M8.6 | `In Review` — 7 units, Verify green incl. the browser walk | PR [#71](https://github.com/pat-mw/revu/pull/71), base `m8.1` |
| **M8.7** | `In Review` — 13 units, `Verify` green, fable review run | PR [#72](https://github.com/pat-mw/revu/pull/72), base `m8.6` |

**M8.7's PR opened mid-session, in the order the protocol requires: `Verify` green (`3e7bfa6`) → the
fable-tier adversarial review of the full diff → its fixes (`de30223`) → PR #72, one minute later.** Review
before the PR opens is §8 of the protocol; the PR is not batched to session end. `main` is still untouched at
`177068a`; nothing has merged.

### M8.7 — exactly what has landed, and what has not

| unit | commit | gate at that commit |
| --- | --- | --- |
| M8.7.10 — the static-render harness | `f2ba173` | 1365 pass · 1 skip · 0 fail · 77 files |
| M8.7.1 — mode derivation + single-call-site guard | `ad0bd54` | 1373 pass · 1 skip · 0 fail · 78 files |
| M8.7.2 — tab set: omit Checks and Description | `efd260d` | 1391 pass · 1 skip · 0 fail · 79 files |
| M8.7.9 — the two optimistic-path bugs | `38b9bd3` | 1405 pass · 1 skip · 0 fail · 80 files |
| M8.7.4 — Conversation: threads only | `548f8e5` | 1411 pass · 1 skip · 0 fail · 81 files |
| M8.7.3 — header identity, state chip, 404, banner stack | `4a9cd44` | 1440 pass · 1 skip · 0 fail · 81 files |
| M8.7.5 — review-bar: no lock, no API claim, no broker | `27453da` | 1472 pass · 1 skip · 0 fail · 81 files |
| M8.7.6 — residual sweep, rate chip, org-member title | `71c71e0` | 1534 pass · 1 skip · 0 fail · 82 files |
| M8.7.8 — the dirty-worktree banner | `6dc373b` | 1551 pass · 1 skip · 0 fail · 83 files |
| M8.7.12 — the header draws the branch pair once | `c50787b` | 1558 pass · 1 skip · 0 fail · 83 files |
| M8.7.11 — the optimistic reply's author | `dd1931c` | 1570 pass · 1 skip · 0 fail · 83 files |
| M8.7.7 — the closing proof: GitHub path unchanged | `82c9d55` | 1589 pass · 1 skip · 0 fail · 83 files |
| M8.7 `Verify` — unit set, control ledger, mock walk | `3e7bfa6` | 232 pass · 0 fail in the unit-check set |
| M8.7.13 + review fixes — palette, and 7 guards made real | `de30223` | **1611 pass · 1 skip · 0 fail · 83 files** |

**All thirteen units are landed and M8.7 is complete.** The unit count grew by one when the pre-merge review
found the command palette still framing a local review as a pull request — appended as **M8.7.13** rather than
absorbed, the same handling M8.7.11 and M8.7.12 got.

### M8.6 and M8.1 — landed and pushed

| unit | commit | branch |
| --- | --- | --- |
| M8.1.9 refuse submit before first sync · review fixes | `4fbc5fb` · `8b73a77` | `m8.1` → [#70](https://github.com/pat-mw/revu/pull/70) |
| M8.6.7 harness · M8.6.1 · M8.6.2 · M8.6.3 | `440aa74` `8385bdf` `113aee8` `eb20f17` | `m8.6` → [#71](https://github.com/pat-mw/revu/pull/71) |
| M8.6.4 · M8.6.5 · M8.6.6 · review fixes · Verify | `be9442a` `836b841` `59e3e75` `a637522` `de14043` | `m8.6` → #71 |

**Every gate above was re-run by the orchestrator in the main tree**, never trusted from a worker's isolated
one. `main` is untouched at **`177068a`**; nothing merged.

## Tickets

**95 units across 12 tickets.** Dependencies below are the **post-review** graph — two adversarial passes over
the ticket set corrected several of them, so this table is authoritative over any earlier sketch. The unit
count grew from 74 when a test-first audit added thirteen units carrying test work that had no owner, then
from 87 when the owner's rulings appended M8.1.9 and the M8.12 ticket (2026-08-14).

| ID | Ticket | State | Units | Surface | Depends | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [M8.1](./tickets/M8.1-contract-and-mock.md) | Contract additions + the mock as the spec | In Review | 9 | shared, app, revud | — | `m8.1/contract-and-mock` | [#70](https://github.com/pat-mw/revu/pull/70) |
| [M8.2](./tickets/M8.2-store-v4.md) | Store v4: `local_*` tables | **In Review** | 7 | revud | M8.1 | `m8.2/store-v4` | [#73](https://github.com/pat-mw/revu/pull/73) |
| [M8.3](./tickets/M8.3-local-snapshot-builder.md) | Local snapshot builder (git-only) | **In Review** | 9 | revud | M8.1 | `m8.3/local-snapshot-builder` | [#74](https://github.com/pat-mw/revu/pull/74) |
| [M8.4](./tickets/M8.4-local-write-sink.md) | Local write sink | **In Review** | 9 | revud | M8.1 | `m8.4/local-write-sink` | [#75](https://github.com/pat-mw/revu/pull/75) |
| [M8.5](./tickets/M8.5-daemon-wiring.md) | Daemon wiring: dispatch, routes, `listPulls`, boot relaxation | **In Progress** | 9 | revud | M8.1, M8.2, M8.3, M8.4 | `m8.5/daemon-wiring` | — |
| [M8.6](./tickets/M8.6-app-creation-flow.md) | App: creation flow + inbox surface | In Review | 7 | app | M8.1 | `m8.6/app-creation-flow` | [#71](https://github.com/pat-mw/revu/pull/71) |
| [M8.7](./tickets/M8.7-app-local-chrome.md) | App: local-mode chrome + copy correctness | In Review | 13 | app | M8.1, M8.6 | `m8.7/app-local-chrome` | [#72](https://github.com/pat-mw/revu/pull/72) |
| [M8.8](./tickets/M8.8-resync-and-pinning.md) | Re-sync, rebase safety, and object pinning | Todo | 8 | revud | M8.2, M8.3, M8.5 | `m8.8/resync-and-pinning` | — |
| [M8.9](./tickets/M8.9-archive-on-pr.md) | Archive when a PR appears | Todo | 7 | revud, app | M8.4, M8.5, M8.6, M8.7 | `m8.9/archive-on-pr` | — |
| [M8.10](./tickets/M8.10-retention-and-gc.md) | Retention and GC | Todo | 7 | revud | M8.2, M8.5 | `m8.10/retention-and-gc` | — |
| [M8.11](./tickets/M8.11-conformance-e2e-docs.md) | Conformance leg, e2e, and docs | Todo | 8 | all | M8.5, M8.6, M8.7, M8.8, M8.9, M8.10 | `m8.11/conformance-e2e-docs` | — |
| [M8.12](./tickets/M8.12-delete-confirm.md) | Delete confirmation for a review holding a draft | Todo | 3 | app | M8.6, M8.10 | `m8.12/delete-confirm` | — |

## Dependency graph

Four layers. Everything in a layer is mutually independent.

```
L0    M8.1   contract + mock ── the spec; gates everything (D6)
        │
        ├────────────┬────────────┬────────────┐
        ▼            ▼            ▼            ▼
L1    M8.2         M8.3         M8.4         M8.6
      store v4     git builder  write sink   app: create + inbox
        │            │            │            │
        └─────┬──────┴─────┬──────┘            ▼
              ▼            │                 M8.7  app: chrome + copy
L2          M8.5  daemon wiring                │
              │  (needs 8.1,8.2,8.3,8.4)       │
        ┌─────┼─────────────┐                  │
        ▼     ▼             ▼                  │
L3   M8.8   M8.10         M8.9 ◄───────────────┘
     rebase  GC           archive-on-PR
     safety               (needs 8.4,8.5,8.6,8.7)
        └─────┴─────────────┴──────┐
                                   ▼
L4                              M8.11  conformance · e2e · docs
```

**Where the real parallelism is.** M8.1 gates everything — it *is* the spec. After it lands, two tracks run
concurrently on genuinely disjoint packages and never wait on each other:

- **daemon** (`packages/revud`) — M8.2, M8.3, M8.4 mutually independent → M8.5 → M8.8 / M8.10.
- **app** (`packages/app`) — M8.6 → M8.7, needing only the mock, never revud.

They rejoin at M8.9, which needs both. M8.11 closes the milestone and needs everything.

Ticket-level dependencies are a coarse approximation of the real unit-level ones — [M8.8](./tickets/M8.8-resync-and-pinning.md)'s
units 1–3, for instance, are startable after M8.2 + M8.3 alone, ahead of M8.5. The session plan in
[`ROADMAP.md`](./ROADMAP.md) exploits that; it is the authority on execution order, and this graph is the
constraint it must satisfy.

## Exit criteria coverage

Which ticket's `Verify` proves each milestone exit criterion. An exit criterion with no proving ticket is a
gap in the plan, not a gap in the work.

| exit criterion | proved by |
| --- | --- |
| Full loop works with no remote, no token, no network | M8.5, M8.11 |
| Re-sync / amend / rebase keep drafts alive; no mass-`lost` from missing objects | M8.8 |
| Nothing ever reaches GitHub — structurally enforced + asserted | M8.4, M8.11 |
| No synthetic id in `snapshots.pr_number` / `audit_log.pr` / `pr_author.pr` | M8.2 |
| Conformance leg green in every transport; `check` + e2e green | M8.11 |
| No GitHub-flavored affordance on a local review | M8.7 |

## Conventions

- States: `Backlog` · `Todo` · `In Progress` · `In Review` · `Done` (+ `Canceled`).
- A ticket goes `In Review` when its PR is open. `Done` needs **both** its `Verify` run green **and** its PR
  merged — Verify alone is not sufficient, or a ticket would be `Done` while its code is still only on a
  branch. M8.6 and M8.7 both have green Verifies and stay `In Review` for exactly that reason.
- Units are `M8.x.n` inside each ticket file, numbered in default execution order. Append-only — never
  renumber; new units continue the sequence.
- Branch names carry the M-ID. A unit gets its own branch only if it ships as its own PR in a stack.
- The full protocol is [`../README.md`](../README.md).

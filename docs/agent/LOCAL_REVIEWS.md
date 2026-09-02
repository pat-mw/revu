# Local-only reviews — design

Review a local git branch against a base branch **before** any pull request exists, with the full revu
review workflow, and with nothing ever sent to GitHub. This document is the design source for milestone
**M8**; `docs/agent/MILESTONES.md` carries the ticket breakdown, and the Linear board carries the units.

---

## 1. Why

A contractor learning a real client codebase needs feedback on their work. Today the only reviewable
artifact is a pull request on the client's repo, so every piece of training feedback is published to the
client — including the bad first drafts that the training exists to eliminate. The reviewer cannot say
"this whole approach is wrong" without the client seeing that it was ever proposed.

A local-only review makes the branch reviewable inside the workspace. Same diff surface, same inline
comments, same drafts, same reconcile-after-new-commits flow — but the artifact is local, and the client
repo learns nothing until a PR is deliberately opened.

The second, quieter benefit: the review pipeline stops depending on GitHub at all. A local review needs
no token, no network, and no `origin`. That is a strictly larger product than the one that exists today,
and it is the same product — the offline snapshot was always the core, and the pull request was only ever
one way to name a diff.

---

## 2. Shape of the design

The decisive discovery from the surface mapping is that **very little of revu is actually about GitHub**.

- `lib/anchor.ts` — the reconcile/drift/lost engine — is pure. Its entire input surface is a pending
  comment, a file list, a blob index, and a `resolveBlobLines(sha)` callback. Every one of those is
  derivable from `git diff --raw`, `git ls-tree`, and `git cat-file`.
- `reconcile.ts` never sees a GitHub client, a repo ref, or a token.
- `blobs.ts` is already local-git-first; for a local branch its GitHub tier never executes.
- The two-half cache is keyed by `compareKey = mergeBase...head` and is entirely provenance-blind — it
  only ever sees a string key and a `SnapshotImmutable`.
- Of the 21 `RevuApi` methods, **6 touch GitHub**: `syncPull`, `getRateLimit`, and the four writes.
  Everything else is a store read that is already agnostic to where the snapshot came from.

So this is not a parallel application. It is **one new snapshot producer and one new write sink**, plugged
into machinery that is already indifferent to provenance.

```
                    ┌── GitHub reads ──────┐
   syncPull ────────┤                      ├──► SnapshotImmutable ──► store (compareKey)
                    └── git-only reads ────┘         (unchanged)
                        ▲ NEW: local
                                                       │
   reconcileDraft ◄──── anchor.ts (pure, unchanged) ◄───┘
                                                       │
                    ┌── GitHub writes ─────┐           │
   submitReview ────┤                      ├──► threads / review summary
                    └── local write sink ──┘      (same types, local ids)
                        ▲ NEW: local
```

---

## 3. Decisions

Three product forks were settled with the owner; the rest follow from the mapping.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Archive on PR appearance.** When a PR is detected for the same repo + head ref + base ref, the local review goes read-only and links to it. Nothing is copied to the PR, ever. | The point of the feature is that training feedback never reaches the client repo. A publish path would reintroduce exactly the leak it exists to prevent. |
| D2 | **Reserved high-number identity at the contract level.** Local reviews are identified by a synthetic positive integer from a reserved band. | Keeps `RevuApi` signatures, all 21 HTTP routes, both routers' `Number.isInteger(n) && n > 0` gates, the validators, the `/pr/:n` route family, and every React Query key **completely unchanged**. The alternative (a string `ReviewId`) touches the frozen contract, every route, the store schema, the mock, and the whole conformance suite. |
| D3 | **Committed content only, with a dirty-worktree warning.** The snapshot is `merge-base(base, head)..head`, built from commit SHAs; `git status --porcelain` drives an explicit "you have uncommitted changes that are not in this review" banner. | Content-addressed blobs stay honest, anchoring stays well-defined, and "sync" keeps meaning "the branch got new commits". The warning closes the one confusion the choice creates. |
| D4 | **The reserved band is contract-level only; the store gets its own tables.** No synthetic number is ever written to `snapshots.pr_number`, `audit_log.pr`, or `pr_author.pr`. | Those columns are read by the host-side collector and the broker poll loop as *real* GitHub PR numbers. A sentinel there would leak outward. New `local_*` tables keep D2's convenience without corrupting the meaning of an existing column. |
| D5 | **A capability inside direct/broker mode, not a fourth mode.** | `REVU_MODE` is a credential-custody + bind axis, not a data-source axis. Direct and broker already share the whole read/persist surface. A fourth mode would duplicate `mainDirect` to change two booleans. |
| D6 | **The mock implements local reviews first.** | The mock is the permanent oracle: its semantics *are* the spec, and the conformance suite runs against it. Local reviews are specified in the mock, then revud conforms. |
| D7 | **The local write path has no GitHub client in scope.** Not a conditional, a structural absence. | "Local comments never reach GitHub" must be a property of the code's shape, not of a branch that could be mis-taken. |
| D8 | **Local reviews use the live base tip; GitHub PRs use `pull.base.sha`.** Documented, not accidental. | GitHub only refreshes `base.sha` on a `synchronize` event, so a PR's merge base can be stale. `git merge-base <base-tip> <head>` is computed against the live tip — arguably more correct, and it means a local review's `compareKey` can change on a base advance with zero new head commits. The two paths genuinely disagree about "what changed"; pick the local one deliberately. |

### 3.1 The id bands

Defined once in `packages/shared`, so the app, revud, and the mock cannot disagree:

```ts
/** Review ids at or above this are local-only; no GitHub PR number approaches it. */
export const LOCAL_REVIEW_ID_BASE = 1_000_000_000

/** Locally minted comment / review-summary ids. Disjoint from GitHub's (~1e9–3e9)
 *  and from the mock's 700_000_000 band. */
export const LOCAL_ENTITY_ID_BASE = 9_000_000_000_000

export const isLocalReviewId = (n: number): boolean =>
  Number.isInteger(n) && n >= LOCAL_REVIEW_ID_BASE
```

Constraints this respects, each verified against code rather than assumed:

- `direct-router.ts` requires `Number.isInteger(n) && n > 0` — satisfied.
- `vNumber` imposes no range at all — satisfied trivially.
- The route-param allowlist test admits only `n | sha | threadId | id`; local reviews reuse `:n`, and the
  new create/list routes use `:n` too — satisfied without amending an invariant test.
- The palette and app-shell both parse the PR out of the path with `/^\/pr\/(\d+)(?:\/|$)/` — a positive
  integer matches, so `g f` / `g c` and the "This PR" palette group keep working. A negative or string id
  would have silently broken all three.
- React Query keys are `JSON.stringify`-hashed; a distinct number hashes distinctly. A `NaN` from
  `Number('local-abc')` would have collapsed *every* local review onto one cache entry.
- Local ids are stable across restarts via a `UNIQUE(repo, base_ref, head_ref)` constraint plus
  `MAX(id) + 1` minting — creating the same review twice returns the existing one rather than minting a
  second.

`#1000000001` is never rendered. The local variant of the header shows `base ← head` and a `local` seal
where a PR shows `#347`.

---

## 4. Data model

### 4.1 What is synthesized

A local review persists a real `Snapshot`. Every required GitHub-shaped field has a legal local value:

| Field | Local value |
|---|---|
| `pull.number` | the local id |
| `pull.id` / `node_id` | local band / `local:<id>` |
| `pull.title` | the head branch name (or a user-supplied title) |
| `pull.state` | `'open'`, or `'closed'` once archived (D1) |
| `pull.user` | a sentinel `GhUser` — the local reviewer's git-config name, `type:'Bot'`, empty `avatar_url`/`html_url`. **Never the email.** |
| `pull.head` / `base` | real branch names + `git rev-parse` SHAs; `repo.full_name` = the local repo identifier |
| `pull.merge_base_sha` | `git merge-base <base> <head>` |
| `pull.mergeable` / `mergeable_state` | `null` / `'unknown'` — both already legal |
| `merged`, `merged_at`, `requested_reviewers` | `false`, `null`, `[]` |
| `mutable.checks` / `reviews` / `issueComments` | `[]` — all already legal empty states |
| `PullListResponse.etag` | hash of the local reviews' `compareKey`s |
| `PullListResponse.rateLimit` | the mock's synthetic shape (large limit, `used: 0`) so honest-error copy reads "not rate limited" |

`SnapshotImmutable` and blob storage need **nothing**: both are content-addressed by SHAs that git produces
locally, and both are already repo-agnostic.

### 4.2 Store schema (v3 → v4)

Additive only — `CREATE TABLE IF NOT EXISTS`, no row rewritten, no primary key altered. This matches the
existing migration doctrine exactly, and it is why widening the current PKs was rejected: SQLite cannot
alter a primary key without a table rebuild, and rebuilding is what the doctrine forbids.

```sql
local_reviews(
  id INTEGER PRIMARY KEY,          -- >= LOCAL_REVIEW_ID_BASE
  repo TEXT NOT NULL,              -- repo identity, scoped from day one
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  base_sha TEXT, merge_base_sha TEXT, head_sha TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  archived_pr INTEGER,             -- set when a PR supersedes it (D1)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_synced_at TEXT,
  UNIQUE(repo, base_ref, head_ref)
)
local_snapshots(local_id INTEGER PRIMARY KEY, data TEXT NOT NULL)
local_threads(local_id INTEGER NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL,
              PRIMARY KEY (local_id, thread_id))
local_reviews_submitted(local_id INTEGER NOT NULL, review_id INTEGER NOT NULL, data TEXT NOT NULL,
              PRIMARY KEY (local_id, review_id))
local_drafts(human_id TEXT NOT NULL, local_id INTEGER NOT NULL, data TEXT NOT NULL,
             PRIMARY KEY (human_id, local_id))
local_viewed(human_id TEXT NOT NULL, local_id INTEGER NOT NULL, data TEXT NOT NULL,
             PRIMARY KEY (human_id, local_id))
```

`immutables` and `blobs` are reused untouched. `audit_log` and `pr_author` are **not written** by the local
path — that is D4, and it is what keeps the host collector's view of "PR #N" truthful.

**Repo scoping.** The existing store is repo-blind: two repos sharing a `REVU_DATA_DIR` collide on
`snapshots.pr_number`. With PR numbers that needs the same number in both repos; with branch names,
`main`/`feature/x` collide across *every* repo. So `repo` is part of the local key from day one. Whether to
backfill repo-scoping into the PR-keyed tables is a separate question this milestone raises but does not
answer.

**Draft isolation is preserved verbatim.** `local_drafts` is keyed `(human_id, local_id)` and `human_id` is
taken from the session and overwritten on write, exactly as `drafts` is today — a client cannot write
another human's draft, and the existing isolation test extends to the local tables unchanged.

---

## 5. Building a local snapshot

Replaces two GitHub calls with git; everything downstream is unchanged.

| Today (GitHub) | Local |
|---|---|
| `GET /pulls/{n}` → `head.sha`, `base.sha` | `git rev-parse <head>` / `<base>` |
| `GET /compare/{b}...{h}` → merge base | `git merge-base <base> <head>` |
| `GET /pulls/{n}/files` (paginated, capped 3000) → filenames, statuses, counts, patches, head blob SHAs | `git diff --raw -M <mergeBase> <head>` → **both** blob SHAs, statuses and renames in one command; `--numstat` → counts; `-U3` → patch text |
| `GET git/trees/{mergeBase}?recursive=1` → base blob SHAs (truncatable) | folded into `--raw` above |
| `GET /pulls/{n}/commits` | `git log --format=... <mergeBase>..<head>` |

The local path is *more* complete than the API path: no 3000-file cap, no truncated tree, and base + head
blob SHAs from a single command. Two conventions must be reproduced deliberately rather than inherited:
an **absent `patch` means "binary or oversize"** (the UI already switches on this), and the binary
heuristic stays "NUL byte in the first 8000 bytes", same as git.

`provisionBlobs` is reused as-is except for one flag: it must be told **local-only, never fall back to the
API**, otherwise an offline local review either spends requests or fails. Its git tier hits 100% for a
local branch, so its GitHub tier is dead code on this path — which is also how D7 is enforced.

### 5.1 Object pinning — the non-obvious requirement

A local branch is amended and rebased constantly. When it is, the SHAs a draft's anchors resolved against
can become unreachable, and `git gc` is entitled to delete them. `store.getBlob` returning `null` degrades
to `resolveBlobLines → null → lost/line-deleted` — so **a rebase that changed nothing in a file could
mass-classify every comment on it as `lost`, purely from missing objects.**

Mitigation: on every local sync, write a ref per snapshot under `refs/revu/reviews/<id>/<compareKey>`
pinning the merge-base and head commits. Objects stay reachable, anchoring always has content to match, and
retention becomes an explicit delete rather than an accident of `git gc`.

---

## 6. Writes

Local implementations of the four write verbs. Each must return a **complete, well-formed** value, because
the app's optimistic mutations copy fields back out of the response — a no-op that returns the old value
makes an optimistic update silently snap back, which reads as a bug rather than an error.

| Verb | Local behavior | Why it must not be a stub |
|---|---|---|
| `submitReview` | Local head guard (`git rev-parse <head>` vs `expectedHeadSha`) → on match, materialize each `PendingComment` into a local `ReviewThread` with a locally minted thread id and **positive** comment ids → mint a local `ReviewSummary` → delete the draft. | Returning `ok` with no threads breaks the client, which invalidates the snapshot expecting them to appear: the draft vanishes and nothing is posted. |
| `replyToThread` | Append a locally-id'd `ReviewComment` to the thread. | The client swaps by id and re-keys `commentAuthors`; a negative or duplicate id orphans the entry. Optimistic synthetics already reserve negatives, so local ids must be positive. |
| `resolveThread` | Flip `isResolved`, set `resolvedBy`, return the whole normalized thread. | The client copies `isResolved`/`isOutdated`/`resolvedBy` back from the response. |
| `addReaction` | Store a local rollup and return it. | Returning the old rollup makes the optimistic bump revert with no error. |

**`head_moved` stays live, and matters more locally than it does for a PR.** An amend or rebase moves head
silently, with no PR event to notice it. It remains a 200-level value, never a throw. `conflict` becomes
unreachable (nothing re-validates line positions server-side), but the type stays.

Two steps have no local analogue and are deliberately dropped: the idempotency re-check (it exists because
a network response can be lost) and the 422 path (it exists because GitHub re-validates). A local sink is
synchronous and total.

**No stamping.** `prefixBody` exists solely because N humans share one GitHub bot account; locally there is
one author and the store can hold the real `Human.id` on the comment. Two latent direct-mode bugs must not
be inherited: the optimistic reply currently stamps unconditionally and briefly renders `**Name** (role)`
as literal body text, and the optimistic resolve attributes to an empty `brokerLogin`.

**Review verdicts stay meaningful.** `COMMENT` / `APPROVE` / `REQUEST_CHANGES` are kept as local training
verdicts, and `canApprove` is true — there is no GitHub self-review rule to enforce and no org member to
defer to. The lock popover that tells the user to go get an approval on github.com must not render here.

---

## 7. Frontend

Route family is unchanged: `/pr/:n/*` with a synthetic `n`. That is D2's payoff — no new routes, no
duplicated regexes, no new query-key factories, no `NaN` collisions.

The variance is a `mode: 'github' | 'local'` derived once from `isLocalReviewId` and threaded through the
PR chrome. The established precedent for the gating is the dev-controls capability probe: **omit the group
entirely rather than render it empty.**

**Tabs.** Files, Conversation (threads only — issue comments and submitted reviews are always empty), and
Commits are fully meaningful. **Checks** and **Description** are omitted: there is no CI on an unpushed
branch, and Description would assert "It was opened with an empty body", which is false rather than empty.
There is no precedent for omitting a tab today; this is genuinely new.

**Creation flow.** Net-new, and the only part of the feature that is not a variant of something existing:
a branch picker (local branches + remote-tracking refs for the base), a base picker, and a create action.
It sits in the inbox header row beside the List/Tree control, with a `Local reviews` section above
`Waiting on you`. One command-palette entry in the **Go** group, plus a catalog entry if it gets a chord.

**Copy.** A substantial list of strings asserts GitHub facts that would be false on a local review. The
actively harmful ones — not merely wrong, but instructing the user to do something impossible or claiming a
write that never happened — are: the `canApprove` lock popover naming an org member who "approves on
github.com"; the "Review posted … in one API call" toast; the rate chip and the "~N requests from the
shared 5,000/hr bucket" estimate; the Checks tab's "logs live on github.com"; and the "isn't in this
installation" 404, which is exactly the screen a mis-keyed local review would land on. The full inventory
belongs in the implementing ticket.

The staleness and reconcile vocabulary — "The branch moved while you were reviewing", N new commits, base
advanced, head moved — is **correct as-is locally**. It is the strongest reuse story in the feature.

---

## 8. Edge cases

### Creation
1. `base == head` → reject with a typed error.
2. Head has no commits ahead of base → allowed; renders as an empty review rather than an error.
3. Base exists only as a remote-tracking ref (`origin/main`) → allowed; the picker offers both.
4. Unrelated histories, no merge base → typed error naming the two refs.
5. Shallow clone → `git merge-base` can fail; detect and say so rather than reporting an empty diff.
6. Duplicate (repo, base, head) → returns the existing review; the `UNIQUE` constraint enforces it.
7. **Ref names arriving over HTTP are option-injection vectors.** The command runner takes an argv array
   (no shell), so shell injection is impossible — but a ref beginning with `-` is read by git as a *flag*,
   and nothing validates command arguments today. Normalize to `refs/heads/…`, pass `--`, and validate with
   `git check-ref-format`.
8. Repo root is never discovered today (`cwd` is just `process.cwd()`); worktrees and bare repos need
   `git rev-parse --show-toplevel`.
9. Submodule (mode 160000) and symlink (120000) entries in `git diff --raw` → skipped or explicitly marked,
   not fed to the blob provider as if they were files.
10. Very large diffs — the local path has no 3000-file cap, so a cap becomes a UI decision rather than an
    API constraint.

### Re-sync
11. New commits → new `compareKey` → new immutable half → reconcile. **This falls out of the existing cache
    for free**; "re-sync" is literally `syncPull`, no new route.
12. **Amend / rebase — the hardest case.** Every SHA in the draft becomes unreachable at once.
    `draft.headSha` is no longer in `commits`, so new-commit detection falls to the author-date heuristic —
    and since a rebase rewrites committer date but *preserves author date*, that fallback **under-reports,
    silently**. Combined with the GC hazard in §5.1, this is the edge case most likely to produce
    "everything is lost" for no visible reason. Object pinning plus an explicit "the branch was rewritten"
    state, rather than a silent miscount, is the mitigation.
13. Base advances with no head commits → merge base moves → `compareKey` changes → `baseMoved`. Correct
    under D8, and a real behavioral difference from the PR path worth stating in the UI.
14. Head or base branch deleted or renamed → typed `not_found`; the review goes read-only. **Drafts and
    threads are never discarded** — drafts surviving everything is the product.
15. Repo re-cloned or data dir moved → snapshot references objects that are not present. Today a dangling
    reference is a hard unreadable error; this needs a graceful "objects missing, re-sync to rebuild" state.
16. Worktree dirty at sync → recorded on the review and surfaced as a banner (D3).

### Writes
17. Locally minted comment ids must be positive (negatives are reserved for optimistic synthetics) and in a
    band disjoint from GitHub's and from the mock's.
18. A reconcile-apply that ends in `conflict` never updates `draft.headSha` — an existing latent bug that
    makes the *next* reconcile compute new commits from a stale head. Local reviews inherit it; it should be
    fixed rather than reproduced.
19. Draft deletion stays gated on confirmed submit success, which locally is trivially satisfiable and must
    still be coded that way.

### Archive (D1)
20. Detection is on repo + head ref + **base ref**, and must compare `head.repo.full_name` too — a fork can
    have an identically named branch.
21. Direct mode has no pull listing of its own (its inbox list is the local one), so detection is a
    targeted read — the open pull requests for one head/base pair — behind an optional seam that is absent
    in a workspace with no origin or token, and it runs on each sync of that review.
22. Archiving is read-only, never destructive: threads, drafts and history stay visible, with a link to the
    PR, and the review freezes at the sync that found the PR. A PR closed without merging does not
    un-archive; the branch pair is a one-way door — creating the same pair again returns the archived review
    (the store ruling that shaped v4's unique key).

### Retention
23. **Zero eviction exists anywhere in the store today** — the only `DELETE` is `deleteDraft`. PRs made that
    tolerable; a constantly-rebased local branch mints a fresh `compareKey` on every sync and orphans the
    previous immutable half forever. Pruning immutables unreferenced by any snapshot, plus dropping the
    pinned refs of deleted reviews, becomes a real design item — and the first `DELETE` this store grows.

### Security
24. **The local write path must not have a GitHub client in scope** (D7) — a structural guarantee, not a
    conditional one.
25. Local writes are not journaled to `audit_log`, so the host collector and the out-of-band-write detector
    keep their current, truthful meaning: they describe writes to the client repo. That local reviews are
    invisible to the audit trail is a deliberate consequence of them being invisible to the client.
26. The email-is-a-key-never-a-body rule still binds on the synthesized `GhUser`.

---

## 9. What this does not do

- No cross-workspace review — a local review lives in the workspace that created it.
- No publishing local comments to a PR, ever (D1).
- No review of uncommitted work (D3).
- No shared database.

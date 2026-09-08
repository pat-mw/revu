# M8 — Local-only reviews (pre-PR branch review)

| field | value |
| --- | --- |
| **Status** | ACTIVE |
| **Depends** | M2 (the direct sync engine, store, and reconcile this reuses) |
| **Independent of** | M3–M6 — no broker, no collector, no on-prem hardware |
| **Design** | [`docs/agent/LOCAL_REVIEWS.md`](../../../docs/agent/LOCAL_REVIEWS.md) |
| **Seed text** | [`docs/agent/MILESTONES.md`](../../../docs/agent/MILESTONES.md) → `## Milestone M8` |
| **Linear** | milestone exists ([revu project](https://linear.app/uzo/project/revu-553eaefcab18)); **tickets do not** — issue cap. This board is authoritative. |

## Goal

Review a local git branch against a base branch **before any pull request exists**, with the full revu review
workflow, and with nothing ever sent to GitHub.

The motivating case: a contractor learning a real client codebase needs feedback on their work, but today the
only reviewable artifact is a pull request on the client's repo — so every piece of training feedback is
published to the client, including the bad first drafts the training exists to eliminate. A reviewer cannot
say "this whole approach is wrong" without the client seeing that it was ever proposed.

A second outcome falls out for free: the review pipeline stops depending on GitHub at all. A local review
needs no token, no network, and no `origin`. That is a strictly larger product than the one that exists
today, and it is the same product — the offline snapshot was always the core, and the pull request was only
ever one way to name a diff.

## Exit criteria

- [ ] A local review is creatable from a branch + base pair in a repo with **no GitHub remote, no token, and
      no network**, and the full loop works: sync → inline comments → draft → submit → threads → reply →
      resolve. *(proved by M8.5, M8.11)*
- [ ] Re-syncing after new commits, an amend, and a rebase all keep drafts alive through the existing
      reconcile flow; a rebase never mass-classifies comments as `lost` through unreachable objects.
      *(proved by M8.8)*
- [ ] No local comment, thread, review, or reaction ever reaches GitHub — enforced structurally (no GitHub
      client in the local write path) and asserted by a test that fails if one is introduced.
      *(proved by M8.4, M8.11)*
- [ ] No synthetic id is ever written to `snapshots.pr_number`, `audit_log.pr`, or `pr_author.pr`; the host
      collector's and poll loop's view of "PR #N" is unchanged. *(proved by M8.2)*
- [ ] Conformance green over a local-review leg in every transport (mock in-process, revud-mock HTTP,
      direct); `bun run check` + e2e green. *(proved by M8.11)*
- [ ] No GitHub-flavored affordance renders on a local review: no Checks or Description tab, no rate-limit
      cost copy, no "approves on github.com" lock, no "posted in one API call" toast. *(proved by M8.7)*

## The shape

Very little of revu is actually about GitHub, and that is what makes this cheap.

- `lib/anchor.ts` — the reconcile/drift/lost engine — is **pure**. Its entire input surface is a pending
  comment, a file list, a blob index, and a `resolveBlobLines(sha)` callback, all derivable from
  `git diff --raw` / `git ls-tree` / `git cat-file`.
- `reconcile.ts` never sees a GitHub client, a repo ref, or a token.
- `blobs.ts` is already local-git-first; for a local branch its GitHub tier never executes.
- The two-half cache is keyed by `compareKey = mergeBase...head` and is entirely provenance-blind.
- **Only 6 of the 21 `RevuApi` methods touch GitHub** — `syncPull`, `getRateLimit`, and the four writes.

So M8 is **one new snapshot producer and one new write sink**, plugged into machinery that is already
indifferent to provenance — not a parallel application. "Re-sync after new commits" falls out of the existing
cache for free (new head → new `compareKey` → new immutable half) and needs no new route.

## Decisions

Full rationale in [`LOCAL_REVIEWS.md §3`](../../../docs/agent/LOCAL_REVIEWS.md). **Do not relitigate these
without a recorded reason** — three were owner calls and the rest are load-bearing.

| id | decision | owner call? |
| --- | --- | --- |
| **D1** | **Archive on PR appearance; never publish.** Local comments are never copied to a PR. | yes |
| **D2** | **Reserved high-number identity at the contract level** (`>= 1e9`), keeping `RevuApi`, all 21 routes, both routers' `n > 0` gates, the validators, `/pr/:n`, and every React Query key unchanged. | yes |
| **D3** | **Committed content only**, plus an explicit dirty-worktree warning. | yes |
| **D4** | **The band is contract-level only; the store gets its own `local_*` tables.** No synthetic id ever reaches `snapshots.pr_number` / `audit_log.pr` / `pr_author.pr` — the host collector and poll loop read those as real PR numbers. | — |
| **D5** | **A capability inside direct/broker mode, not a fourth mode.** `REVU_MODE` is a credential-custody + bind axis, not a data-source axis. | — |
| **D6** | **The mock specifies it first** — it is the permanent oracle and its semantics *are* the contract. | — |
| **D7** | **The local write path has no GitHub client in scope** — structural, not conditional. | — |
| **D8** | **Local reviews use the live base tip** where PRs use GitHub's `pull.base.sha` (refreshed only on `synchronize`). The two paths genuinely disagree about "what changed"; the local policy is chosen deliberately. | — |

## The two hazards to design against

1. **Rebase + `git gc`.** A rebase makes every SHA in a draft unreachable at once. `store.getBlob → null`
   degrades to `resolveBlobLines → null → lost/line-deleted`, so **a rebase that changed nothing in a file can
   mass-classify every comment on it as `lost`, purely from missing objects.** New-commit detection then falls
   to the author-date heuristic, which **under-reports silently** — a rebase rewrites committer date but
   preserves author date. Owned by **M8.8** (pin objects under `refs/revu/reviews/<id>/<compareKey>`).
2. **Zero eviction exists anywhere in the store today** — the only `DELETE` is `deleteDraft`, and there is no
   TTL on immutables or blobs. PRs made that tolerable; a constantly rebased local branch mints a fresh
   `compareKey` on every sync and orphans the previous immutable half forever. Owned by **M8.10**.

## Status

Designed 2026-08-12. Design landed on [PR #69](https://github.com/pat-mw/revu/pull/69) (docs only, gate
green). Implemented across a linear stack of twelve PRs, none merged; as of 2026-09-02 every exit criterion
above has a green run on the stack tip ([#80](https://github.com/pat-mw/revu/pull/80), M8.11) — the walk is
at that ticket's Verify 7. The boxes tick when the chain merges. M8.9 (archive on PR appearance) and M8.12
(delete confirmation) remain; neither is named by an exit criterion. Current ticket states are in
[`BOARD.md`](./BOARD.md).

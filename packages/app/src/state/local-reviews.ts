import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { api } from '@/api'
import { ApiError } from '@revu/shared'
import type { BranchRef, CreateLocalReviewInput, LocalReviewSummary, RevuApi } from '@revu/shared'
import { qk } from './queries'

/**
 * Local-only reviews: a branch pair with no pull request behind it, carrying a
 * reserved high-band id so every route, key and layout keyed by a PR number
 * works on one unchanged.
 *
 * Two query sources are involved, and their division of labour is the whole
 * design:
 *
 * - **`usePullList` is the row source for every rendered row.** Local reviews
 *   are merged into the pull list by the transport, and a review can only be
 *   resolved out of that list — one missing from it opens as "not in this
 *   installation". Titles, ref pairs and every `broker.*` field come from
 *   there and from nowhere else.
 * - **The annotation query below supplies only what the frozen list-item type
 *   cannot carry**: the per-review local annotations (`dirty`, `archivedPr`),
 *   plus one boolean about EXISTENCE — whether the human has any local review
 *   at all, archived and closed ones included, which the row source cannot
 *   answer because callers filter it to open reviews.
 *
 * A boolean about existence and a set of annotations are not a second source
 * of truth for a row: nothing here renders a row, a title, a ref pair or a
 * `broker.*` field. Keeping this query under its own key, and reading it only
 * for those two things, is what keeps a single review from having two truths.
 */

/**
 * The branches this workspace can offer as review sides — local branches and
 * remote-tracking refs both, because a base is often tracked and never checked
 * out. Reading them is a read of the local repository, not of GitHub, so it
 * costs the shared rate bucket nothing.
 *
 * The staleness window is deliberately short and the query refetches whenever
 * a fresh observer mounts: branches are created, renamed and deleted under the
 * user constantly, so a picker opened a minute later must not offer a listing
 * from a minute ago. `enabled` exists for a picker that stays mounted while
 * closed — there is nothing to list until it is open.
 */
export function useBranches(options?: { enabled?: boolean }): UseQueryResult<BranchRef[], ApiError> {
  return useQuery<BranchRef[], ApiError>({
    queryKey: qk.branches,
    queryFn: () => api.listBranches(),
    enabled: options?.enabled ?? true,
    staleTime: 10_000,
    refetchOnMount: 'always',
  })
}

/**
 * Every local review in this workspace, read ONLY for its local-only
 * annotations and for whether any exist at all. Never for a row.
 *
 * No staleness window: the annotations track workspace state that changes
 * without any list ETag moving, and re-reading them is local and free.
 */
export function useLocalReviewAnnotations(): UseQueryResult<LocalReviewSummary[], ApiError> {
  return useQuery<LocalReviewSummary[], ApiError>({
    queryKey: qk.localReviews,
    queryFn: () => api.listLocalReviews(),
  })
}

/**
 * Whether the human has any local review at all — the one question the row
 * source cannot answer, because a caller that filters rows to open reviews has
 * already dropped the archived ones.
 *
 * Kept here rather than left to each caller as `data.length > 0` so the
 * question has one definition, and so `undefined` (the query has not resolved
 * yet) reads as "none known" instead of throwing.
 */
export function hasAnyLocalReview(summaries: LocalReviewSummary[] | undefined): boolean {
  return summaries !== undefined && summaries.length > 0
}

/** The same existence question, read straight off the annotation query. */
export function useHasAnyLocalReview(): boolean {
  return hasAnyLocalReview(useLocalReviewAnnotations().data)
}

/**
 * Bring the caches back in step with a local review that has just been
 * created, and resolve only once the pull list actually carries it.
 *
 * A caller navigates to the new review's id the moment this resolves, and the
 * layout there resolves the review by searching the pull list — so a refresh
 * that has not landed the row yet sends the user to an empty "not in this
 * installation" screen.
 *
 * `refetchType: 'all'` is load-bearing, not decoration. The default is
 * `'active'`, which refetches only entries with a mounted observer: on a
 * client that has none — a freshly navigated app, or any caller driving this
 * directly — the default marks the entry stale, refetches nothing, and leaves
 * the pre-create list in the cache for the navigation to read.
 *
 * A non-hook so the behavior can be driven and asserted without a renderer.
 */
export async function refreshAfterLocalReviewCreate(qc: QueryClient): Promise<void> {
  await refreshLocalReviewLists(qc)
}

/**
 * Re-read both lists a local review appears in, and resolve once they have
 * landed rather than once they have been marked stale.
 *
 * Shared by every mutation that adds or removes one, so a caller navigating on
 * the strength of either cannot find the two lists disagreeing about which
 * reviews exist — and so the `refetchType` above is decided once instead of
 * once per mutation.
 */
async function refreshLocalReviewLists(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.pulls, refetchType: 'all' }),
    qc.invalidateQueries({ queryKey: qk.localReviews, refetchType: 'all' }),
  ])
}

/**
 * Open a local review of one branch against another.
 *
 * Creation is idempotent per branch pair: asking twice for the same pair
 * returns the review that already exists rather than minting a second, and
 * that is a success, not a conflict. The created (or pre-existing) review is
 * returned so the caller navigates by its id instead of re-deriving it from a
 * list.
 *
 * `onSuccess` awaits the refresh, and the mutation does not resolve until it
 * has — so `await mutateAsync(...)` followed by a navigation is safe by
 * construction.
 */
export function useCreateLocalReview(): UseMutationResult<
  LocalReviewSummary,
  ApiError,
  CreateLocalReviewInput
> {
  const qc = useQueryClient()
  return useMutation<LocalReviewSummary, ApiError, CreateLocalReviewInput>({
    mutationFn: (input) => api.createLocalReview(input),
    onSuccess: () => refreshAfterLocalReviewCreate(qc),
  })
}

// ————————————————————————————————————————————————————————————————
// Deleting a local review
// ————————————————————————————————————————————————————————————————

/**
 * What one delete attempt came back with — every branch of it, faults
 * included, as a value.
 *
 * Nothing here throws, and that is the whole point of the type. The discard
 * and the delete are two calls, either can fail, and the caller's next act
 * depends on WHICH did: a thrown error carries the failure but loses the one
 * fact that decides whether the reader's text still exists. So the fact rides
 * on every branch instead.
 *
 * `discarded` is that fact, and it is reported for the branches that failed as
 * loudly as for the one that worked, because it is exactly there that it
 * matters: a discard that succeeded before a delete that did not has already
 * destroyed text, and a caller that reads it as "nothing happened" then drops
 * the surviving copy of it.
 */
export type LocalReviewDeleteResult =
  /** The review is gone. */
  | { outcome: 'deleted'; discarded: boolean }
  /** Refused, carrying the sentence the workspace refused it with. */
  | { outcome: 'refused'; reason: string; discarded: boolean }
  /** A fault with no remedy this flow can offer, carried rather than raised. */
  | { outcome: 'failed'; error: unknown; discarded: boolean }

/** What one delete attempt needs: where to send it, which review, and how to discard. */
export interface LocalReviewDeleteInput {
  /**
   * The one call a delete makes on its own. Narrowed to it so the whole
   * decision can be driven with a stand-in, and so nothing here can reach for
   * a second.
   */
  api: Pick<RevuApi, 'deleteLocalReview'>
  reviewId: number
  /**
   * Discard this reader's own draft before deleting, or `null` to delete
   * without touching any draft.
   *
   * Injected rather than called from here, and for a reason that is not
   * tidiness. Discarding a draft is more than one request: the editing surface
   * holds a debounced save and a single retry behind it, and a discard that
   * skips them races a timer that re-creates the draft between the discard and
   * the delete — which comes back as a refusal blaming a draft the reader has
   * already discarded, or worse, strands a save after the review is gone. The
   * caller owns those timers, so the caller owns the discard, and this
   * function only decides when it runs.
   *
   * `null` rather than a boolean: a delete that discarded a draft nobody
   * handed it a way to discard destroys text silently, and there is nothing to
   * infer it from here.
   */
  discard: (() => Promise<void>) | null
}

/**
 * Delete a local review, optionally discarding this reader's own draft first.
 *
 * The workspace refuses the delete for as long as ANY human's draft on the
 * review holds text, and there is no flag that forces it — so the way through
 * is the one the refusal names, and it is two calls rather than one variant of
 * a call: discard, then repeat the identical delete. That shape is deliberate.
 * A client that never asks for the discard cannot destroy a draft even by
 * mistake, which is why the protection lives at the far end and this function
 * is only allowed to do what it was explicitly told to.
 *
 * Every ending is a VALUE, the faults included, and that is the difference
 * between this and a function that throws what it cannot handle. The reader's
 * text may or may not still exist by the time the delete answers, and the
 * caller has a cache holding the only copy of it — so what the caller needs is
 * not "the delete failed" but "the delete failed AND the discard had already
 * gone through". A thrown error cannot carry the second half, and a caller
 * that guesses at it drops text that is still there or keeps a stale copy of
 * text that is not.
 *
 * A discard that fails ends the attempt where it stands. The delete after it
 * would be refused anyway — the draft it was meant to clear is still there —
 * and sending it would replace an accurate report of the failed discard with a
 * refusal blaming a draft the reader just tried to remove.
 *
 * A refusal that outlives a successful discard is somebody else's unsubmitted
 * text — the check spans every human's draft, not the caller's alone — and
 * nothing from here can or should reach it.
 *
 * Pure and renderer-free so the whole round trip is drivable without a
 * component: this is where "text leaves only by its writer's own choice" is
 * actually kept on the reading side.
 */
export async function performLocalReviewDelete({
  api: transport,
  reviewId,
  discard,
}: LocalReviewDeleteInput): Promise<LocalReviewDeleteResult> {
  let discarded = false
  if (discard !== null) {
    try {
      await discard()
      discarded = true
    } catch (error) {
      return { outcome: 'failed', error, discarded: false }
    }
  }
  try {
    await transport.deleteLocalReview(reviewId)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unprocessable') {
      return { outcome: 'refused', reason: error.message, discarded }
    }
    return { outcome: 'failed', error, discarded }
  }
  return { outcome: 'deleted', discarded }
}

/**
 * Bring the caches back in step with a local review that has just been deleted.
 *
 * The two lists are refreshed exactly the way a create refreshes them — same
 * keys, same `refetchType` — because the hazard is the same one in mirror
 * image: a caller navigates away the moment this resolves, and a list still
 * carrying the deleted row puts it back on the screen it just left.
 *
 * The per-review entries are REMOVED rather than invalidated, and that is the
 * half a create has no counterpart for. An invalidated entry is refetched by
 * the next observer that mounts, which for a review that no longer exists is a
 * request that can only fail; and the id is never minted again, so nothing will
 * ever come along to overwrite what is left in the cache. Removal is the only
 * outcome that leaves no entry describing a review nothing can reach.
 *
 * Every per-review key goes, not the interesting ones: the snapshot, the
 * draft, and the per-file viewed marks alike. A key left behind is not a
 * harmless remnant — it is a cache entry describing a review nothing can name
 * again, kept alive for the life of the tab and refetched by any observer that
 * happens to mount on that id.
 *
 * A non-hook so the behavior can be driven and asserted without a renderer.
 */
export async function refreshAfterLocalReviewDelete(
  qc: QueryClient,
  reviewId: number,
): Promise<void> {
  qc.removeQueries({ queryKey: qk.snapshot(reviewId) })
  qc.removeQueries({ queryKey: qk.draft(reviewId) })
  qc.removeQueries({ queryKey: qk.viewed(reviewId) })
  await refreshLocalReviewLists(qc)
}

/**
 * Delete a local review, with the caches brought back in step on the way out.
 *
 * `onSuccess` awaits the refresh and the mutation does not resolve until it
 * has, so `await mutateAsync(...)` followed by a navigation is safe by
 * construction — the same guarantee the create mutation makes, and needed for
 * the same reason: the screen the caller leaves for reads the list this
 * refresh lands.
 *
 * ## The one rule about the draft cache
 *
 * The draft cache entry is dropped when, and only when, the attempt reports
 * that the draft was actually DISCARDED. Not when a discard was asked for.
 *
 * The difference is text. That cache entry is the editing surface itself — the
 * characters live in it whatever the far end answered, which is what keeps
 * typing off the network — so it can hold an edit whose save has not landed.
 * A discard that threw is the same condition that leaves an edit unsaved, and
 * dropping the entry there deletes the only copy of it: the far end still
 * holds the last text it managed to save, the cache holds nothing, and the
 * edit exists nowhere. Every mutator on that surface is a no-op over an empty
 * entry, so nothing puts it back either.
 *
 * A refusal is an answer the caller acts on rather than a fault, so the lists
 * are left alone after one — nothing about them changed. A discard that
 * succeeded ahead of it still drops the draft entry, because that draft really
 * is gone.
 *
 * A non-hook so the whole rule can be driven and asserted without a renderer,
 * which is the only way the case it exists for is reachable at all: the
 * interesting attempt is one whose discard FAILED, and a hook cannot be put in
 * that state from outside itself.
 */
export async function applyLocalReviewDeleteToCache(
  qc: QueryClient,
  reviewId: number,
  result: LocalReviewDeleteResult,
): Promise<void> {
  if (result.discarded) qc.removeQueries({ queryKey: qk.draft(reviewId) })
  if (result.outcome === 'deleted') await refreshAfterLocalReviewDelete(qc, reviewId)
}

/**
 * Delete a local review, with the caches brought back in step on the way out.
 *
 * `onSuccess` awaits the refresh and the mutation does not resolve until it
 * has, so `await mutateAsync(...)` followed by a navigation is safe by
 * construction — the same guarantee the create mutation makes, and needed for
 * the same reason: the screen the caller leaves for reads the list this
 * refresh lands.
 *
 * The mutation never rejects: every ending, faults included, comes back as a
 * value the caller reads off `result`. That is why the error parameter is
 * `never` rather than a code nothing produces, and why a caller has no
 * `onError` to write — and why `onSuccess` is where a FAILED attempt has its
 * effect on the cache decided.
 */
export function useDeleteLocalReview(): UseMutationResult<
  LocalReviewDeleteResult,
  never,
  Omit<LocalReviewDeleteInput, 'api'>
> {
  const qc = useQueryClient()
  return useMutation<LocalReviewDeleteResult, never, Omit<LocalReviewDeleteInput, 'api'>>({
    mutationFn: (input) => performLocalReviewDelete({ api, ...input }),
    onSuccess: (result, input) => applyLocalReviewDeleteToCache(qc, input.reviewId, result),
  })
}

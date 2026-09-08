import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { api } from '@/api'
import type {
  ApiError,
  BranchRef,
  CreateLocalReviewInput,
  LocalReviewSummary,
} from '@revu/shared'
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

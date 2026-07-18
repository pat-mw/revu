import type {
  CheckRun,
  CommitInfo,
  IssueComment,
  PullDetail,
  PullFile,
  ReviewSummary,
  Snapshot,
  SnapshotImmutable,
  SnapshotMutable,
} from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GithubClient, GhTreeEntry, Page, PageParams } from './github-client'
import { GithubRequestError } from './github-client'
import type { RepoRef } from './repo'
import type { DirectStore } from './store'
import { provisionBlobs } from './blobs'
import {
  mapCheckRuns,
  mapCommit,
  mapIssueComment,
  mapPullDetail,
  mapPullFile,
  mapReview,
} from './mappers'
import { fetchReviewThreads } from './threads'

/**
 * The direct-mode sync engine: the REST read path that `syncPull` runs and the
 * durable store it writes into.
 *
 * The snapshot is two halves, cached differently (the contract's core rule):
 *
 *   - The IMMUTABLE half — files, the base/head blob index, and commits — is a
 *     pure function of the compare `merge_base…head`. It is content-addressed by
 *     `compareKey`, cache-forever, no TTL. GitHub PR diffs are three-dot
 *     compares, so the diff changes when the base branch advances even though
 *     head did not; keying by head alone would wrongly reuse a stale diff, so the
 *     key is ALWAYS `${mergeBaseSha}...${headSha}`.
 *   - The MUTABLE half — pull detail, issue comments, reviews, check runs — is
 *     refetched on EVERY sync unconditionally. A thread can be resolved or a
 *     review submitted on github.com with zero commits landing, so a head-SHA
 *     match must never short-circuit the mutable fetch.
 *
 * The two-half split is enforced in exactly ONE place: `syncPull` below. It
 * computes the compareKey (step 1), and on a store hit for that key it fetches
 * ONLY the mutable half; otherwise it fetches both and persists the immutable
 * half under the compareKey. There is no other code path that decides this.
 *
 * Review THREADS are the one mutable field that comes from GraphQL, not REST:
 * `fetchMutable` runs the paginated `reviewThreads` query and normalizes the
 * nodes onto the REST `ReviewThread`/`ReviewComment` vocabulary. Those GraphQL
 * calls are part of the mutable half — fetched every sync — and are counted in
 * `syncStats.requests` alongside the REST calls.
 *
 * Blob BYTES are provisioned by the injected blob provider after the immutable
 * half is known: every SHA the blob index references (base + head) is resolved
 * from the content-addressed store first, then the local git clone (zero API
 * cost, works offline), then the GitHub API for anything the clone lacks. Only
 * true API transfers count as `blobsFetched`; store hits are `blobsReused` and
 * local-git reads cost nothing — so a cold sync with a warm clone reports
 * `blobsFetched: 0`. A blob no tier could produce is named in `partial` rather
 * than reported as present, and API requests the provider spent (only the cold-
 * cache fallback) are folded into `syncStats.requests`.
 */

/** GitHub's maximum page size; the engine always requests it to minimize requests. */
const PER_PAGE = 100

/**
 * A `CommandRunner` that never produces a local blob — used when no runner is
 * injected, so the provider's local-git tier is skipped cleanly (every probe
 * reports "not found") and blobs resolve from the store or the API instead.
 */
const NO_LOCAL_GIT_RUNNER: CommandRunner = {
  async run() {
    return { ok: false, code: -1, stdout: '', stderr: 'no local git runner injected' }
  },
}

/**
 * Merge the immutable half's own partial reason (file cap, truncated tree) with a
 * snapshot-scoped list of blob SHAs no tier could provision. The result carries
 * the union of both incompletenesses so the UI names everything it did not get;
 * `null` only when there is nothing missing on either axis.
 */
function mergePartial(
  immutablePartial: Snapshot['partial'],
  missingBlobShas: string[],
): Snapshot['partial'] {
  if (missingBlobShas.length === 0) return immutablePartial
  const reasons: string[] = []
  if (immutablePartial && immutablePartial.reason.length > 0) {
    reasons.push(immutablePartial.reason)
  }
  reasons.push(
    `${missingBlobShas.length} blob(s) could not be provisioned from the local ` +
      'git clone or the GitHub API; re-sync to retry fetching them.',
  )
  const priorMissing = immutablePartial?.missingBlobShas ?? []
  return {
    missingBlobShas: [...priorMissing, ...missingBlobShas],
    reason: reasons.join(' '),
  }
}

/**
 * The upper bound on files a single sync will paginate. A PR larger than this is
 * not an error — the snapshot is kept with an HONEST `partial` reason so the UI
 * can say what it did not fetch, exactly as a mid-transfer drop does.
 */
export const MAX_FILES = 3000

/** Result of a `syncPull`: the assembled snapshot (which may carry `partial`). */
export type SyncResult = Snapshot

/** A tiny request counter so `syncStats.requests` reflects real REST cost. */
class RequestCounter {
  private n = 0
  bump(by = 1): void {
    this.n += by
  }
  get count(): number {
    return this.n
  }
}

/**
 * Fetch every page of a paginated list, honoring GitHub's `Link: rel="next"`.
 * `onPage` is invoked per page so a caller can enforce a cap mid-stream. Returns
 * the flattened items and how many requests it spent.
 */
async function paginate<T>(
  fetchPage: (params: PageParams) => Promise<Page<T>>,
  counter: RequestCounter,
): Promise<T[]> {
  const items: T[] = []
  let page = 1
  for (;;) {
    const result = await fetchPage({ page, perPage: PER_PAGE })
    counter.bump()
    items.push(...result.items)
    if (!result.hasNext) break
    page += 1
  }
  return items
}

/**
 * Fetch the immutable half of a snapshot: the pull's files (paginated, capped),
 * its commits, and the base-side blob SHAs resolved from the merge-base tree in
 * one call. Returns the assembled `SnapshotImmutable` plus a `partial` reason
 * when the file cap was hit.
 */
async function fetchImmutable(
  github: GithubClient,
  repo: RepoRef,
  prNumber: number,
  mergeBaseSha: string,
  headSha: string,
  compareKey: string,
  counter: RequestCounter,
): Promise<{ immutable: SnapshotImmutable; partial: Snapshot['partial'] }> {
  // Files — paginated up to the cap. Beyond the cap, stop and report partial
  // rather than paging forever or throwing.
  const rawFiles: unknown[] = []
  let page = 1
  let capped = false
  for (;;) {
    const result = await github.getPullFiles(repo.owner, repo.repo, prNumber, {
      page,
      perPage: PER_PAGE,
    })
    counter.bump()
    for (const f of result.items) {
      if (rawFiles.length >= MAX_FILES) {
        capped = true
        break
      }
      rawFiles.push(f)
    }
    if (capped || !result.hasNext) break
    page += 1
  }
  const files: PullFile[] = rawFiles.map(mapPullFile)

  // Head-side blob SHA per path comes straight from the files payload (`file.sha`
  // is the head blob SHA). Record it into the blob index; a removed file has no
  // head side (null).
  const blobIndex: SnapshotImmutable['blobIndex'] = {}
  for (const f of files) {
    const head = f.status === 'removed' ? null : f.sha.length > 0 ? f.sha : null
    blobIndex[f.filename] = { base: null, head }
  }

  // Base-side blob SHAs for every changed path in ONE call: the recursive tree of
  // the merge base. An added file has no base side (stays null). GitHub truncates
  // the listing for very large repos; a truncated tree can silently miss base
  // paths, so it is reported as `partial` below rather than passed off as "those
  // files have no base side".
  const tree = await github.getTree(repo.owner, repo.repo, mergeBaseSha)
  counter.bump()
  const baseByPath = new Map<string, string>()
  for (const entry of tree.tree) {
    if (entry.type === 'blob') baseByPath.set(entry.path, entry.sha)
  }
  for (const f of files) {
    // A rename's base side lives under the previous filename.
    const basePath = f.previous_filename ?? f.filename
    if (f.status === 'added') continue
    const baseSha = baseByPath.get(basePath)
    if (baseSha !== undefined) blobIndex[f.filename].base = baseSha
  }

  // Commits — paginated; part of the immutable half (they don't change without
  // head changing).
  const rawCommits = await paginate(
    (params) => github.getPullCommits(repo.owner, repo.repo, prNumber, params),
    counter,
  )
  const commits: CommitInfo[] = rawCommits.map(mapCommit)

  const immutable: SnapshotImmutable = {
    compareKey,
    mergeBaseSha,
    headSha,
    files,
    blobIndex,
    commits,
  }

  const reasons: string[] = []
  if (capped) {
    reasons.push(
      `This pull request changes more than ${MAX_FILES} files; ` +
        `the snapshot covers the first ${MAX_FILES}. Review the rest on github.com.`,
    )
  }
  if (tree.truncated) {
    reasons.push(
      'GitHub truncated the merge-base tree listing, so base-side blob SHAs ' +
        'may be missing for some files.',
    )
  }
  const partial: Snapshot['partial'] =
    reasons.length > 0 ? { missingBlobShas: [], reason: reasons.join(' ') } : null

  return { immutable, partial }
}

/**
 * Fetch the mutable half: pull detail (with the derived merge base folded in),
 * issue comments, reviews, check runs for the head commit, and the review
 * threads. Threads are the one field sourced from GraphQL rather than REST; they
 * are refetched every sync (a thread can resolve with no head movement) and the
 * GraphQL calls they cost are folded into the same request counter.
 */
async function fetchMutable(
  github: GithubClient,
  repo: RepoRef,
  prNumber: number,
  detailRaw: unknown,
  mergeBaseSha: string,
  headSha: string,
  syncedAt: string,
  counter: RequestCounter,
): Promise<SnapshotMutable> {
  const pull: PullDetail = mapPullDetail(detailRaw, mergeBaseSha)

  const rawIssueComments = await paginate(
    (params) => github.getIssueComments(repo.owner, repo.repo, prNumber, params),
    counter,
  )
  const issueComments: IssueComment[] = rawIssueComments.map(mapIssueComment)

  const rawReviews = await paginate(
    (params) => github.getPullReviews(repo.owner, repo.repo, prNumber, params),
    counter,
  )
  const reviews: ReviewSummary[] = rawReviews.map(mapReview)

  // Check runs are auxiliary CI status, and reading them needs the `checks:read`
  // permission. A token without it (a grant that never included checks, or one
  // reduced on rotation) answers 403 "Resource not accessible by integration".
  // That must not abort the whole sync — CI status degrades to "no checks" while
  // the rest of the mutable half loads. Any other failure (network, rate limit, a
  // real server error) still propagates.
  let checks: CheckRun[] = []
  try {
    const checkRunsRaw = await github.getCheckRuns(repo.owner, repo.repo, headSha)
    checks = mapCheckRuns(checkRunsRaw)
  } catch (err) {
    if (!(err instanceof GithubRequestError && err.status === 403)) throw err
  }
  counter.bump()

  // Threads come from the GraphQL `reviewThreads` connection, normalized to the
  // REST `ReviewThread`/`ReviewComment` shape. Each GraphQL page is counted in
  // the shared request counter, so `syncStats.requests` reflects the mutable-half
  // GraphQL cost honestly. `commentAuthors` is broker-only (there is no write log
  // in direct mode), so it is deliberately absent.
  const threads = await fetchReviewThreads(github, repo, prNumber, counter)

  return {
    fetchedAt: syncedAt,
    pull,
    threads,
    issueComments,
    reviews,
    checks,
  }
}

/** Everything `syncPull` needs, injected so it is unit-testable with fakes. */
export interface SyncDeps {
  github: GithubClient
  repo: RepoRef
  store: DirectStore
  /**
   * Runs `git cat-file` for the local-first blob provider. Optional: when absent,
   * blob provisioning skips the local-git tier and resolves every blob from the
   * store or the API. Injected so tests drive `cat-file` with a fake.
   */
  runner?: CommandRunner
  /**
   * The git clone directory the blob provider's `git cat-file` runs in — the repo
   * being reviewed. Required alongside `runner` for the local-git tier; absent
   * with no `runner`, blobs come from the store/API only.
   */
  cwd?: string
  /** Timestamp source; injectable so tests get deterministic `syncedAt`. */
  now?: () => string
}

/**
 * Run one burst sync for a pull request and persist the result. This is the
 * SINGLE place the two-half split is enforced:
 *
 *   1. Read pull detail and derive the merge base → compute `compareKey`.
 *   2. Look up the immutable half by `compareKey` in the store.
 *      - HIT  → reuse it untouched — including its own honest `partial` (a
 *               capped or truncated half stays partial on reuse) — and fetch
 *               ONLY the mutable half (files, base tree, commits all skipped).
 *      - MISS → fetch BOTH halves and persist the immutable half under the key.
 *   3. Assemble the snapshot (threads from GraphQL, folded into the mutable half)
 *      and persist it.
 *
 * The mutable half is fetched on EVERY path, so a head-SHA match never
 * short-circuits it. There is no TTL: a compareKey hit is reused forever.
 */
export async function syncPull(deps: SyncDeps, prNumber: number): Promise<SyncResult> {
  const { github, repo, store } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const counter = new RequestCounter()
  const syncedAt = now()

  // Step 1 — pull detail + merge base → the compare key.
  const detailRaw = await github.getPullDetail(repo.owner, repo.repo, prNumber)
  counter.bump()
  const { headSha, baseSha } = readHeadBase(detailRaw)
  const compare = await github.getCompare(repo.owner, repo.repo, baseSha, headSha)
  counter.bump()
  const mergeBaseSha = compare.merge_base_commit.sha
  const compareKey = `${mergeBaseSha}...${headSha}`

  // ——— The two-half split, enforced HERE and nowhere else. ———
  const cachedImmutable = store.getImmutable(compareKey)

  let immutable: SnapshotImmutable
  let partial: Snapshot['partial']
  if (cachedImmutable !== null) {
    // Cache hit for this exact compare: the immutable half is reused untouched.
    // Files, base tree, and commits are NOT refetched — the requests they cost
    // are skipped entirely. Its stored `partial` is reattached too: a capped or
    // truncated half is STILL incomplete on reuse and must keep saying so.
    immutable = cachedImmutable.immutable
    partial = cachedImmutable.partial
  } else {
    const built = await fetchImmutable(
      github,
      repo,
      prNumber,
      mergeBaseSha,
      headSha,
      compareKey,
      counter,
    )
    immutable = built.immutable
    partial = built.partial
    // Persist the immutable half under its compareKey (cache-forever, no TTL),
    // carrying its own partial so a later hit stays honest.
    store.putImmutable(immutable, partial)
  }

  // The mutable half is fetched unconditionally, on both the hit and the miss
  // path — a resolved thread or a new review changes it with no head movement.
  const mutable = await fetchMutable(
    github,
    repo,
    prNumber,
    detailRaw,
    mergeBaseSha,
    headSha,
    syncedAt,
    counter,
  )

  // Provision blob BYTES for every SHA the index references (base + head): store
  // reuse first, then the local git clone (zero API cost, works offline), then
  // the API for anything the clone lacked. Only API transfers count as fetches;
  // any request the provider spends is folded into the shared counter, so
  // `syncStats.requests` stays honest.
  const blobs = await provisionBlobs(
    {
      github,
      repo,
      store,
      runner: deps.runner ?? NO_LOCAL_GIT_RUNNER,
      cwd: deps.cwd ?? '.',
      counter,
    },
    immutable.blobIndex,
  )

  // A blob that no tier could produce (local git missing AND the API omitted it)
  // is named in `partial` rather than reported present — never fabricate a blob.
  // This is a snapshot-scoped partial (missing bytes a retry can fix), distinct
  // from the immutable half's own file-cap/tree-truncation partial, so the two
  // reasons are merged honestly.
  const finalPartial = mergePartial(partial, blobs.missing)

  const snapshot: Snapshot = {
    prNumber,
    syncedAt,
    partial: finalPartial,
    syncStats: {
      blobsFetched: blobs.stats.blobsFetched,
      blobsReused: blobs.stats.blobsReused,
      requests: counter.count,
    },
    immutable,
    mutable,
  }

  // Persist the assembled snapshot. A durable write failure surfaces as a typed
  // StoreWriteError from the store — never swallowed into a false success.
  store.putSnapshot(snapshot)
  return snapshot
}

/** Read the head and base commit SHAs out of a raw pull-detail response. */
function readHeadBase(raw: unknown): { headSha: string; baseSha: string } {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const head = (p.head && typeof p.head === 'object' ? p.head : {}) as Record<string, unknown>
  const base = (p.base && typeof p.base === 'object' ? p.base : {}) as Record<string, unknown>
  const headSha = typeof head.sha === 'string' ? head.sha : ''
  const baseSha = typeof base.sha === 'string' ? base.sha : ''
  return { headSha, baseSha }
}

/** Re-export for tests that assert against tree-entry typing without a real API. */
export type { GhTreeEntry }

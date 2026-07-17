/**
 * The direct-mode sync engine, driven entirely by a fake GitHub client — no
 * network, no `gh`, no disk beyond an in-memory SQLite store. The tests pin the
 * engine's headline behaviors:
 *
 *   - `compareKey` is `${mergeBaseSha}...${headSha}` (three-dot compare), so a
 *     base advance under a fixed head produces a NEW key and refetches the
 *     immutable half.
 *   - The two-half split: a warm re-sync of an UNCHANGED compare skips the files,
 *     base-tree, and commits calls (asserted by request count) and refetches ONLY
 *     the mutable half. A head-SHA match never short-circuits the mutable fetch.
 *   - Pagination follows `Link: rel="next"`, and a PR past the 3000-file cap
 *     resolves an honest `partial` rather than throwing.
 *   - Snapshot assembly matches the contract shape: immutable carries files +
 *     blobIndex (base + head) + commits; mutable carries pull/comments/reviews/
 *     checks plus the GraphQL-sourced threads (normalized to the REST shape),
 *     and no `commentAuthors`.
 */
import { describe, expect, test } from 'bun:test'
import type { GhGraphqlPageInfo, GhReviewThreadNode, Page, PageParams } from './github-client'
import type { GhCompareRaw, GhTreeRaw, GithubClient } from './github-client'
import type { RepoRef } from './repo'
import { openDirectStore, type DirectStore } from './store'
import { MAX_FILES, syncPull } from './sync'

const REPO: RepoRef = { owner: 'o', repo: 'r' }

/** Records every call so a test can assert the exact request mix (the two-half split). */
interface Calls {
  pullDetail: number
  compare: number
  files: number
  tree: number
  commits: number
  issueComments: number
  reviews: number
  checkRuns: number
  reviewThreads: number
}

interface FakeConfig {
  headSha: string
  baseSha: string
  mergeBaseSha: string
  /** File pages, in order; each page's `hasNext` is derived from whether a later page exists. */
  filePages: unknown[][]
  treeEntries: { path: string; type: 'blob' | 'tree' | 'commit'; sha: string }[]
  /** When true the fake tree response reports GitHub's truncation flag. */
  treeTruncated?: boolean
  commits?: unknown[]
  issueComments?: unknown[]
  reviews?: unknown[]
  checkRuns?: unknown[]
  /** GraphQL review-thread nodes returned as a single page (no next page). */
  reviewThreads?: GhReviewThreadNode[]
}

/** Build a fake GithubClient plus the call counter it increments. */
function fakeClient(cfg: FakeConfig): { client: GithubClient; calls: Calls } {
  const calls: Calls = {
    pullDetail: 0,
    compare: 0,
    files: 0,
    tree: 0,
    commits: 0,
    issueComments: 0,
    reviews: 0,
    checkRuns: 0,
    reviewThreads: 0,
  }
  const page = <T>(all: T[][], params: PageParams): Page<T> => {
    const idx = params.page - 1
    const items = all[idx] ?? []
    return { items, hasNext: idx < all.length - 1 }
  }
  const client: GithubClient = {
    async getViewer() {
      return { login: 'v', id: 1 }
    },
    async getPullDetail() {
      calls.pullDetail += 1
      return {
        number: 204,
        title: 'A PR',
        state: 'open',
        user: { login: 'author', id: 2, type: 'User' },
        head: { sha: cfg.headSha, ref: 'feature' },
        base: { sha: cfg.baseSha, ref: 'main' },
        commits: (cfg.commits ?? []).length,
        changed_files: cfg.filePages.flat().length,
      }
    },
    async getCompare(): Promise<GhCompareRaw> {
      calls.compare += 1
      return { merge_base_commit: { sha: cfg.mergeBaseSha } }
    },
    async getPullFiles(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.files += 1
      return page(cfg.filePages, params)
    },
    async getIssueComments(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.issueComments += 1
      return page([cfg.issueComments ?? []], params)
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.reviews += 1
      return page([cfg.reviews ?? []], params)
    },
    async getPullCommits(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.commits += 1
      return page([cfg.commits ?? []], params)
    },
    async getCheckRuns() {
      calls.checkRuns += 1
      return { check_runs: cfg.checkRuns ?? [] }
    },
    async getTree(): Promise<GhTreeRaw> {
      calls.tree += 1
      return { tree: cfg.treeEntries, truncated: cfg.treeTruncated === true }
    },
    async graphql<T>(): Promise<T> {
      throw new Error('graphql not used directly in this fake')
    },
    async getReviewThreads(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }> {
      calls.reviewThreads += 1
      return {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: cfg.reviewThreads ?? [],
      }
    },
    async getThreadComments(): Promise<{
      pageInfo: GhGraphqlPageInfo
      nodes: never[]
    }> {
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
  }
  return { client, calls }
}

function file(name: string, headSha: string, status = 'modified'): unknown {
  return {
    sha: headSha,
    filename: name,
    status,
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1 +1 @@\n-a\n+b',
  }
}

function baseConfig(): FakeConfig {
  return {
    headSha: 'HEAD1',
    baseSha: 'BRANCH1',
    mergeBaseSha: 'MB1',
    filePages: [[file('a.ts', 'blobA'), file('b.ts', 'blobB')]],
    treeEntries: [
      { path: 'a.ts', type: 'blob', sha: 'baseA' },
      { path: 'b.ts', type: 'blob', sha: 'baseB' },
      { path: 'unrelated.ts', type: 'blob', sha: 'baseX' },
    ],
    commits: [{ sha: 'c1', commit: { message: 'm', author: { date: '2026-01-01' } } }],
    issueComments: [{ id: 1, body: 'hi', user: { login: 'x', id: 9, type: 'User' } }],
    reviews: [{ id: 2, state: 'APPROVED', user: { login: 'y', id: 10, type: 'User' } }],
    checkRuns: [{ id: 3, name: 'ci', status: 'completed', conclusion: 'success' }],
  }
}

function store(): DirectStore {
  return openDirectStore({ dataDir: ':memory:' })
}

describe('compareKey computation', () => {
  test('compareKey is merge_base...head (three-dot compare)', async () => {
    const { client } = fakeClient(baseConfig())
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.immutable.compareKey).toBe('MB1...HEAD1')
    expect(snap.immutable.mergeBaseSha).toBe('MB1')
    expect(snap.immutable.headSha).toBe('HEAD1')
  })
})

describe('Snapshot assembly matches the contract shape', () => {
  test('immutable half carries files, both-sided blobIndex, and commits', async () => {
    const { client } = fakeClient(baseConfig())
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.immutable.files.map((f) => f.filename)).toEqual(['a.ts', 'b.ts'])
    // Head blob SHA from the files payload; base blob SHA from the merge-base tree.
    expect(snap.immutable.blobIndex['a.ts']).toEqual({ base: 'baseA', head: 'blobA' })
    expect(snap.immutable.blobIndex['b.ts']).toEqual({ base: 'baseB', head: 'blobB' })
    expect(snap.immutable.commits).toHaveLength(1)
  })

  test('mutable half carries pull/comments/reviews/checks/threads, no commentAuthors', async () => {
    const { client } = fakeClient(baseConfig())
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.mutable.pull.number).toBe(204)
    expect(snap.mutable.issueComments).toHaveLength(1)
    expect(snap.mutable.reviews).toHaveLength(1)
    expect(snap.mutable.checks).toHaveLength(1)
    // No threads in the base config → an empty array is contract-valid.
    expect(snap.mutable.threads).toEqual([])
    // commentAuthors is broker-only and must be absent in direct mode.
    expect(snap.mutable.commentAuthors).toBeUndefined()
  })

  test('mutable half normalizes GraphQL threads onto the REST ReviewThread shape', async () => {
    const cfg = baseConfig()
    cfg.reviewThreads = [
      {
        id: 'PRRT_kwDOthread1',
        isResolved: true,
        isOutdated: false,
        path: 'a.ts',
        line: 12,
        originalLine: 12,
        startLine: null,
        originalStartLine: null,
        diffSide: 'RIGHT',
        startDiffSide: null,
        subjectType: 'LINE',
        resolvedBy: { login: 'reviewer' },
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              fullDatabaseId: '3605992420',
              path: 'a.ts',
              diffHunk: '@@ -1 +1 @@\n-a\n+b',
              line: 12,
              originalLine: 12,
              startLine: null,
              originalStartLine: null,
              subjectType: 'LINE',
              body: 'looks good',
              createdAt: '2026-07-01T00:00:00Z',
              updatedAt: '2026-07-01T00:00:00Z',
              author: { login: 'reviewer' },
              pullRequestReview: { fullDatabaseId: '4725905880' },
              replyTo: null,
              commit: { oid: 'headoid' },
              originalCommit: { oid: 'origoid' },
              url: 'https://github.com/o/r/pull/204#discussion_r3605992420',
            },
          ],
        },
      },
    ]
    const { client } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.mutable.threads).toHaveLength(1)
    const t = snap.mutable.threads[0]
    // Thread id is the PRRT_ node id verbatim; resolved/outdated carried straight.
    expect(t.id).toBe('PRRT_kwDOthread1')
    expect(t.isResolved).toBe(true)
    expect(t.resolvedBy).toEqual({ login: 'reviewer' })
    // The comment id is the REST-numeric fullDatabaseId (a BigInt string → number).
    expect(t.comments[0].id).toBe(3605992420)
    // diffSide → side (RIGHT); diffHunk → diff_hunk carried verbatim.
    expect(t.comments[0].side).toBe('RIGHT')
    expect(t.comments[0].diff_hunk).toBe('@@ -1 +1 @@\n-a\n+b')
    expect(t.comments[0].pull_request_review_id).toBe(4725905880)
  })

  test('an added file has no base side; a removed file has no head side', async () => {
    const cfg = baseConfig()
    cfg.filePages = [[file('added.ts', 'blobNew', 'added'), file('gone.ts', 'blobOld', 'removed')]]
    cfg.treeEntries = [{ path: 'gone.ts', type: 'blob', sha: 'baseGone' }]
    const { client } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.immutable.blobIndex['added.ts']).toEqual({ base: null, head: 'blobNew' })
    expect(snap.immutable.blobIndex['gone.ts']).toEqual({ base: 'baseGone', head: null })
  })

  test('a renamed file resolves its base side from the previous filename', async () => {
    const cfg = baseConfig()
    cfg.filePages = [
      [
        {
          sha: 'blobNew',
          filename: 'new.ts',
          previous_filename: 'old.ts',
          status: 'renamed',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1 +1 @@',
        },
      ],
    ]
    // The merge-base tree only knows the OLD path — the rename's base side must
    // be looked up there and recorded under the NEW filename.
    cfg.treeEntries = [{ path: 'old.ts', type: 'blob', sha: 'baseOld' }]
    const { client } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.immutable.blobIndex['new.ts']).toEqual({ base: 'baseOld', head: 'blobNew' })
  })

  test('a binary/oversize file (no patch) is represented honestly with patch absent', async () => {
    const cfg = baseConfig()
    cfg.filePages = [[{ sha: 'bin', filename: 'img.png', status: 'added', additions: 0, deletions: 0, changes: 0 }]]
    cfg.treeEntries = []
    const { client } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.immutable.files[0].patch).toBeUndefined()
  })
})

describe('the two-half split (enforced in one place)', () => {
  test('a cold sync fetches both halves', async () => {
    const { client, calls } = fakeClient(baseConfig())
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.partial).toBeNull()
    // Immutable half was fetched: files + tree + commits all ran.
    expect(calls.files).toBeGreaterThan(0)
    expect(calls.tree).toBe(1)
    expect(calls.commits).toBeGreaterThan(0)
    // Mutable half ran too.
    expect(calls.issueComments).toBeGreaterThan(0)
    expect(calls.reviews).toBeGreaterThan(0)
    expect(calls.checkRuns).toBe(1)
    expect(calls.reviewThreads).toBe(1)
  })

  test('a warm re-sync of an UNCHANGED compare skips the immutable fetch entirely', async () => {
    const st = store()
    const cold = fakeClient(baseConfig())
    await syncPull({ github: cold.client, repo: REPO, store: st }, 204)

    // Re-sync with a FRESH counter but the same compare (same head + base + mb).
    const warm = fakeClient(baseConfig())
    const snap = await syncPull({ github: warm.client, repo: REPO, store: st }, 204)

    // Step 1 (detail + compare) always runs to compute the compareKey.
    expect(warm.calls.pullDetail).toBe(1)
    expect(warm.calls.compare).toBe(1)
    // Immutable half SKIPPED: no files, no tree, no commits.
    expect(warm.calls.files).toBe(0)
    expect(warm.calls.tree).toBe(0)
    expect(warm.calls.commits).toBe(0)
    // Mutable half STILL refetched (a thread could resolve with no head change).
    expect(warm.calls.issueComments).toBe(1)
    expect(warm.calls.reviews).toBe(1)
    expect(warm.calls.checkRuns).toBe(1)
    // Threads are mutable — refetched on the warm path too.
    expect(warm.calls.reviewThreads).toBe(1)
    // The reused immutable half is intact.
    expect(snap.immutable.compareKey).toBe('MB1...HEAD1')
  })

  test('a base advance under a FIXED head produces a new compareKey and refetches the immutable half', async () => {
    const st = store()
    await syncPull({ github: fakeClient(baseConfig()).client, repo: REPO, store: st }, 204)

    // Same head, but the base branch advanced → new merge base → new compareKey.
    const moved = baseConfig()
    moved.mergeBaseSha = 'MB2'
    const advanced = fakeClient(moved)
    const snap = await syncPull({ github: advanced.client, repo: REPO, store: st }, 204)

    expect(snap.immutable.compareKey).toBe('MB2...HEAD1')
    // The immutable half was NOT reused (new key) — it was refetched.
    expect(advanced.calls.files).toBeGreaterThan(0)
    expect(advanced.calls.tree).toBe(1)
    // Both compare keys are now cached forever, no TTL.
    expect(st.getImmutable('MB1...HEAD1')).not.toBeNull()
    expect(st.getImmutable('MB2...HEAD1')).not.toBeNull()
  })
})

describe('pagination and the file cap', () => {
  test('files paginate across pages following Link rel=next', async () => {
    const cfg = baseConfig()
    cfg.filePages = [[file('a.ts', 'A')], [file('b.ts', 'B')], [file('c.ts', 'C')]]
    cfg.treeEntries = []
    const { client, calls } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(calls.files).toBe(3)
    expect(snap.immutable.files.map((f) => f.filename)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  test('a PR past the 3000-file cap resolves an honest partial, does not throw', async () => {
    const cfg = baseConfig()
    // One giant page just over the cap.
    const big: unknown[] = []
    for (let i = 0; i < MAX_FILES + 5; i++) big.push(file(`f${i}.ts`, `blob${i}`))
    cfg.filePages = [big]
    cfg.treeEntries = []
    const { client } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    expect(snap.immutable.files).toHaveLength(MAX_FILES)
    expect(snap.partial).not.toBeNull()
    expect(snap.partial!.reason).toContain(String(MAX_FILES))
  })

  test('a warm re-sync of a CAPPED compare keeps the honest partial, not a silent upgrade to complete', async () => {
    const st = store()
    const cfg = baseConfig()
    const big: unknown[] = []
    for (let i = 0; i < MAX_FILES + 5; i++) big.push(file(`f${i}.ts`, `blob${i}`))
    cfg.filePages = [big]
    cfg.treeEntries = []
    const cold = await syncPull({ github: fakeClient(cfg).client, repo: REPO, store: st }, 204)
    expect(cold.partial).not.toBeNull()

    // Same compare → the truncated immutable half is reused. It is STILL
    // truncated, so the snapshot must still carry the honest partial reason.
    const warm = await syncPull({ github: fakeClient(cfg).client, repo: REPO, store: st }, 204)
    expect(warm.immutable.files).toHaveLength(MAX_FILES)
    expect(warm.partial).not.toBeNull()
    expect(warm.partial!.reason).toContain(String(MAX_FILES))
  })

  test('a truncated merge-base tree resolves an honest partial (base sides may be missing)', async () => {
    const cfg = baseConfig()
    cfg.treeTruncated = true
    const { client } = fakeClient(cfg)
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    // GitHub declined to list the whole merge-base tree, so base-side blob SHAs
    // may be silently absent — the snapshot must say so, not claim completeness.
    expect(snap.partial).not.toBeNull()
    expect(snap.partial!.reason).toContain('merge-base tree')
  })
})

describe('syncStats and persistence', () => {
  test('requests counts the real REST calls made', async () => {
    const { client } = fakeClient(baseConfig())
    const snap = await syncPull({ github: client, repo: REPO, store: store() }, 204)
    // detail(1) + compare(1) + files(1) + tree(1) + commits(1) + issueComments(1)
    // + reviews(1) + checkRuns(1) + reviewThreads(1) = 9 for this single-page cold
    // sync — the review-thread GraphQL call is mutable-half cost, counted honestly.
    expect(snap.syncStats!.requests).toBe(9)
  })

  test('the synced snapshot is persisted and reads back', async () => {
    const st = store()
    const { client } = fakeClient(baseConfig())
    await syncPull({ github: client, repo: REPO, store: st }, 204)
    const read = st.getSnapshot(204)
    expect(read).not.toBeNull()
    expect(read!.immutable.compareKey).toBe('MB1...HEAD1')
  })
})

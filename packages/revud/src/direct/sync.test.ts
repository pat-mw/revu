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
import type {
  GhBlobRaw,
  GhGraphqlBlobObject,
  GhGraphqlPageInfo,
  GhReviewThreadNode,
  Page,
  PageParams,
} from './github-client'
import type { GhCompareRaw, GhTreeRaw, GithubClient } from './github-client'
import type { CommandRunner } from './command-runner'
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
  blobObjects: number
  blob: number
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
  /** SHAs the API cannot resolve — the batch returns null for them (drives the missing-blob partial). */
  unresolvableBlobs?: string[]
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
    blobObjects: 0,
    blob: 0,
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
    async getBlob(_o, _r, sha): Promise<GhBlobRaw> {
      calls.blob += 1
      // An unresolvable SHA 404s on the REST fallback too (drives missing-blob).
      if (cfg.unresolvableBlobs?.includes(sha)) {
        throw new Error(`no rest blob for ${sha}`)
      }
      const text = `content-of-${sha}\n`
      return {
        content: Buffer.from(text, 'utf8').toString('base64'),
        encoding: 'base64',
        size: Buffer.byteLength(text, 'utf8'),
      }
    },
    async getBlobObjects(_o, _r, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      calls.blobObjects += 1
      const out: Record<string, GhGraphqlBlobObject | null> = {}
      for (const sha of shas) {
        // Every SHA resolves to a small text blob unless the config marks it
        // unresolvable (null), which drives the missing-blob partial path.
        if (cfg.unresolvableBlobs?.includes(sha)) {
          out[sha] = null
          continue
        }
        const text = `content-of-${sha}\n`
        out[sha] = { isBinary: false, text, byteSize: text.length }
      }
      return out
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
    // + reviews(1) + checkRuns(1) + reviewThreads(1) = 9 REST/GraphQL sync calls,
    // + 1 blob batch (no local-git runner injected, so the 4 unique blob SHAs
    // resolve through ONE GraphQL object() batch) = 10 for this single-page cold
    // sync. The review-thread and blob-batch GraphQL calls are counted honestly.
    expect(snap.syncStats!.requests).toBe(10)
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

/**
 * A fake `git cat-file` runner: `objects` maps SHA → its bytes; an absent SHA
 * reports "not found" (exit 1) so the provider falls through to the API tier.
 */
function gitRunner(objects: Record<string, Uint8Array>): CommandRunner {
  return {
    async run(args: string[]) {
      const [, sub, flagOrType, sha] = args
      if (sub !== 'cat-file') return { ok: false, code: -1, stdout: '', stderr: 'x' }
      const bytes = sha !== undefined ? objects[sha] : undefined
      if (flagOrType === '-e') {
        const present = bytes !== undefined
        return { ok: present, code: present ? 0 : 1, stdout: '', stderr: '' }
      }
      if (flagOrType === '-s') {
        if (bytes === undefined) return { ok: false, code: 1, stdout: '', stderr: '' }
        return { ok: true, code: 0, stdout: `${bytes.length}\n`, stderr: '' }
      }
      if (flagOrType === 'blob') {
        if (bytes === undefined) return { ok: false, code: 1, stdout: '', stderr: '' }
        return { ok: true, code: 0, stdout: new TextDecoder().decode(bytes), stderr: '' }
      }
      return { ok: false, code: -1, stdout: '', stderr: 'x' }
    },
  }
}

describe('blob provisioning is wired into syncPull (the free lunch)', () => {
  test('local git supplies every blob → blobsFetched 0, no blob API call', async () => {
    const cfg = baseConfig()
    // The blob index for this config references baseA/blobA/baseB/blobB.
    const runner = gitRunner({
      baseA: new TextEncoder().encode('base a\n'),
      blobA: new TextEncoder().encode('head a\n'),
      baseB: new TextEncoder().encode('base b\n'),
      blobB: new TextEncoder().encode('head b\n'),
    })
    const { client, calls } = fakeClient(cfg)
    const snap = await syncPull(
      { github: client, repo: REPO, store: store(), runner, cwd: '/repo' },
      204,
    )
    // Every blob came from local git: zero fetches, and the blob batch never ran.
    expect(snap.syncStats!.blobsFetched).toBe(0)
    expect(snap.syncStats!.blobsReused).toBe(0)
    expect(calls.blobObjects).toBe(0)
    // requests == the 9 sync REST/GraphQL calls only (no blob API cost).
    expect(snap.syncStats!.requests).toBe(9)
  })

  test('a store hit is reused (blobsReused), a cold sync fetches only the rest', async () => {
    const st = store()
    // Pre-seed one head blob so the second sync reuses it from the store.
    st.putBlobs([{ sha: 'blobA', path: 'a.ts', content: 'head a\n', size: 7, binary: false }])
    const runner = gitRunner({}) // git has nothing → the rest go to the API
    const { client } = fakeClient(baseConfig())
    const snap = await syncPull(
      { github: client, repo: REPO, store: st, runner, cwd: '/repo' },
      204,
    )
    // blobA reused from the store; baseA/baseB/blobB fetched via the API batch.
    expect(snap.syncStats!.blobsReused).toBe(1)
    expect(snap.syncStats!.blobsFetched).toBe(3)
  })

  test('a binary blob from local git is flagged and collapsed in the store', async () => {
    const cfg = baseConfig()
    cfg.filePages = [[{ sha: 'IMG', filename: 'logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 }]]
    cfg.treeEntries = []
    const runner = gitRunner({ IMG: new Uint8Array([0x89, 0x50, 0x00, 0x01]) })
    const { client } = fakeClient(cfg)
    const st = store()
    await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    const blob = st.getBlob('IMG')
    expect(blob?.binary).toBe(true)
    expect(blob?.content).toBe('')
    expect(blob?.size).toBe(4)
  })

  test('a blob no tier can produce marks the snapshot partial, never fabricates it', async () => {
    const cfg = baseConfig()
    cfg.unresolvableBlobs = ['baseA', 'blobA', 'baseB', 'blobB']
    const runner = gitRunner({}) // git has nothing, and the API resolves none
    const { client } = fakeClient(cfg)
    const st = store()
    const snap = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    expect(snap.partial).not.toBeNull()
    expect(snap.partial!.reason).toContain('blob')
    expect(snap.partial!.missingBlobShas.length).toBeGreaterThan(0)
    // Nothing fabricated — the missing SHAs are absent from the store.
    expect(st.getBlob('baseA')).toBeNull()
  })

  test('a blob API that THROWS on cold SHAs resolves an honest partial, never a thrown sync', async () => {
    const cfg = baseConfig()
    const runner = gitRunner({}) // git has nothing → all four SHAs are cold
    const { client } = fakeClient(cfg)
    // Both blob tiers of the API are down; the sync data itself already fetched.
    client.getBlobObjects = async () => {
      throw new Error('graphql endpoint down')
    }
    client.getBlob = async () => {
      throw new Error('rest endpoint down')
    }
    const st = store()
    const snap = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    expect(snap.partial).not.toBeNull()
    expect(snap.partial!.missingBlobShas.sort()).toEqual(['baseA', 'baseB', 'blobA', 'blobB'])
    // The snapshot itself was still persisted (a retry can fix the blobs).
    expect(st.getSnapshot(204)).not.toBeNull()
  })

  test('a stale blob-missing partial does NOT resurrect on a warm re-sync once the blobs provision', async () => {
    const st = store()
    const cfg = baseConfig()
    cfg.unresolvableBlobs = ['baseA', 'blobA', 'baseB', 'blobB']
    const runner = gitRunner({}) // git never has them; only the API tier matters
    const { client } = fakeClient(cfg)
    const cold = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    expect(cold.partial).not.toBeNull()
    expect(cold.partial!.missingBlobShas.length).toBe(4)
    // The API recovers (same compare, so the immutable half warm-reuses) and the
    // blobs now provision. The snapshot-scoped blob-missing reason must clear —
    // it was never a property of the compare, so it must not ride the immutable
    // row back into the fresh snapshot.
    cfg.unresolvableBlobs = []
    const warm = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    expect(warm.partial).toBeNull()
    expect(warm.syncStats!.blobsFetched).toBe(4)
    // The persisted snapshot agrees — nothing stale survives on disk either.
    expect(st.getSnapshot(204)!.partial).toBeNull()
  })

  test('an immutable-scoped partial (truncated tree) DOES survive warm reuse while a blob reason clears', async () => {
    const st = store()
    const cfg = baseConfig()
    cfg.treeTruncated = true
    cfg.unresolvableBlobs = ['baseA', 'blobA', 'baseB', 'blobB']
    const runner = gitRunner({})
    const { client } = fakeClient(cfg)
    const cold = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    // Cold: both incompletenesses are named.
    expect(cold.partial!.reason).toContain('merge-base tree')
    expect(cold.partial!.reason).toContain('could not be provisioned')
    cfg.unresolvableBlobs = []
    const warm = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    // Warm: the truncated tree is STILL a property of this compare — it stays.
    // The blob-missing reason was retry-scoped and the retry succeeded — it goes.
    expect(warm.partial).not.toBeNull()
    expect(warm.partial!.reason).toContain('merge-base tree')
    expect(warm.partial!.reason).not.toContain('could not be provisioned')
  })

  test('offline: with the blob API blackholed, local git alone still completes the sync', async () => {
    const cfg = baseConfig()
    const runner = gitRunner({
      baseA: new TextEncoder().encode('a\n'),
      blobA: new TextEncoder().encode('a2\n'),
      baseB: new TextEncoder().encode('b\n'),
      blobB: new TextEncoder().encode('b2\n'),
    })
    const { client } = fakeClient(cfg)
    // Blackhole the blob API — if the provider touches it, the sync throws.
    client.getBlobObjects = async () => {
      throw new Error('network blackholed')
    }
    const st = store()
    const snap = await syncPull({ github: client, repo: REPO, store: st, runner, cwd: '/repo' }, 204)
    expect(snap.partial).toBeNull()
    expect(snap.syncStats!.blobsFetched).toBe(0)
    expect(st.getBlob('blobA')?.content).toBe('a2\n')
  })
})

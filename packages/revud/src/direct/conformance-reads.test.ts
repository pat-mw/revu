/**
 * Contract-conformance for the direct-mode READ path, held to the same
 * invariants the shared `RevuApi` conformance suite encodes — but scoped to what
 * the read path owns today (sync + snapshot + the two-half cache), driven by a
 * fake GitHub client so it stays in the network-free gate. The write path,
 * reconcile, threads, and blob bytes are not implemented yet, so the full
 * parameterized suite (which drives all of those) is not runnable against this
 * adapter; the invariants below are the subset that applies.
 *
 * The headline Verify — base-moved cache keying — is asserted here end to end:
 * a re-sync after the base advances under a fixed head produces a NEW compareKey
 * and rebuilds the immutable half, exactly the scenario the shared suite names
 * `baseAdvanced`. A head-SHA match never short-circuits the mutable fetch.
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
import type { RepoRef } from './repo'
import { createDirectApi, type DirectApi } from './direct-api'
import { openDirectStore, type DirectStore } from './store'
import type { Session } from '@revu/shared'

const REPO: RepoRef = { owner: 'o', repo: 'r' }
const SESSION: Session = {
  human: { id: 'h@x.io', name: 'H', role: 'contractor', email: 'h@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
  viewerLogin: 'h-gh',
}

/** A mutable fake whose head is fixed but whose merge base can be advanced between syncs. */
function movingBaseClient(state: { mergeBaseSha: string; unresolvedComments: number }): GithubClient {
  const page = <T>(items: T[], params: PageParams): Page<T> =>
    params.page === 1 ? { items, hasNext: false } : { items: [], hasNext: false }
  return {
    async getViewer() {
      return { login: 'h-gh', id: 1 }
    },
    async getPullDetail() {
      return {
        number: 204,
        state: 'open',
        user: { login: 'author', id: 2, type: 'User' },
        head: { sha: 'HEAD-FIXED' },
        base: { sha: 'BRANCH' },
      }
    },
    async getCompare(): Promise<GhCompareRaw> {
      return { merge_base_commit: { sha: state.mergeBaseSha } }
    },
    async getPullFiles(_o, _r, _n, params): Promise<Page<unknown>> {
      return page(
        [
          {
            sha: 'blobHead',
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -1 +1 @@',
          },
        ],
        params,
      )
    },
    async getIssueComments(_o, _r, _n, params): Promise<Page<unknown>> {
      // The mutable half reflects however many comments exist NOW — this is what
      // proves a head-unchanged re-sync still refreshes the mutable half.
      const items = Array.from({ length: state.unresolvedComments }, (_v, i) => ({
        id: i + 1,
        body: 'c',
        user: { login: 'x', id: 9, type: 'User' },
      }))
      return page(items, params)
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      return page([], params)
    },
    async getPullCommits(_o, _r, _n, params): Promise<Page<unknown>> {
      return page([{ sha: 'c1', commit: { message: 'm', author: { date: '2026-01-01' } } }], params)
    },
    async getCheckRuns() {
      return { check_runs: [] }
    },
    async getTree(): Promise<GhTreeRaw> {
      return { tree: [{ path: 'a.ts', type: 'blob', sha: `base-${state.mergeBaseSha}` }], truncated: false }
    },
    async getBlob(_o, _r, sha): Promise<GhBlobRaw> {
      const text = `content-of-${sha}\n`
      return {
        content: Buffer.from(text, 'utf8').toString('base64'),
        encoding: 'base64',
        size: Buffer.byteLength(text, 'utf8'),
      }
    },
    async getBlobObjects(_o, _r, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      const out: Record<string, GhGraphqlBlobObject | null> = {}
      for (const sha of shas) {
        const text = `content-of-${sha}\n`
        out[sha] = { isBinary: false, text, byteSize: text.length }
      }
      return out
    },
    async graphql<T>(): Promise<T> {
      throw new Error('graphql not used directly in this fake')
    },
    async getReviewThreads(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }> {
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
    async getThreadComments(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: never[] }> {
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
  }
}

function build(client: GithubClient, store: DirectStore): DirectApi {
  return createDirectApi({ session: SESSION, github: client, repo: REPO, store })
}

describe('direct read path — contract conformance (reads subset)', () => {
  test('getSnapshot is null (not an error) for a never-synced PR', () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const api = build(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    expect(api.getSnapshot(204)).toBeNull()
  })

  test('a cold sync produces a well-formed snapshot with a populated immutable half', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const api = build(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    const snap = await api.syncPull(204)
    expect(snap.prNumber).toBe(204)
    expect(snap.partial).toBeNull()
    expect(snap.immutable.files.length).toBeGreaterThan(0)
    expect(snap.immutable.compareKey).toBe('MB1...HEAD-FIXED')
    // getSnapshot after sync returns the cached snapshot.
    expect(api.getSnapshot(204)?.immutable.compareKey).toBe('MB1...HEAD-FIXED')
  })

  test('base advanced under a fixed head: compareKey moves and the immutable half rebuilds', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 0 }
    const api = build(movingBaseClient(state), store)

    const first = await api.syncPull(204)
    expect(first.immutable.compareKey).toBe('MB1...HEAD-FIXED')

    // The base branch advances — head is unchanged, but the three-dot diff moved.
    state.mergeBaseSha = 'MB2'
    const second = await api.syncPull(204)

    // A head-only cache would have wrongly reused the stale diff. The compareKey
    // is merge_base...head, so it MOVED and the immutable half was rebuilt.
    expect(second.immutable.headSha).toBe('HEAD-FIXED')
    expect(second.immutable.compareKey).toBe('MB2...HEAD-FIXED')
    expect(second.immutable.blobIndex['a.ts'].base).toBe('base-MB2')
  })

  test('head unchanged still refetches the mutable half (a resolved/added comment lands)', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 2 }
    const api = build(movingBaseClient(state), store)

    const first = await api.syncPull(204)
    expect(first.mutable.issueComments).toHaveLength(2)

    // Nothing about the compare changes (same head, same base) — only the mutable
    // half drifts. A head match must NOT short-circuit the mutable fetch.
    state.unresolvedComments = 0
    const second = await api.syncPull(204)
    expect(second.immutable.compareKey).toBe(first.immutable.compareKey)
    expect(second.mutable.issueComments).toHaveLength(0)
  })
})

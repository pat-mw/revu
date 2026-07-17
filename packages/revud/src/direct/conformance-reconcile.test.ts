/**
 * Contract-conformance for the direct-mode RECONCILE path — the crown-jewel
 * flow — driven end to end against the REAL direct adapter (`createDirectApi`)
 * with a fake GitHub client, so it stays in the network-free gate. This is the
 * direct-adapter analog of the shared `RevuApi` conformance suite's reconcile
 * block (`packages/shared/conformance/suite.ts`): sync a snapshot, write a draft
 * against that head, force-push (head + head blob rewritten, three commits
 * added), re-sync, then reconcile and assert the classifications, `newCommits`,
 * and — critically — that the client-side PREVIEW matches the report for every
 * comment on both sides.
 *
 * The whole point: the report and the preview both run the SAME shared
 * `classifyPendingComment` with the SAME side-aware blob selection (base for a
 * LEFT anchor, head for a RIGHT anchor), so they cannot diverge. The suite pins
 * that rather than trusting it.
 */
import { describe, expect, test } from 'bun:test'
import type {
  AnchorResult,
  PendingComment,
  ReviewDraft,
  Session,
} from '@revu/shared'
import {
  blobContentToLines,
  classifyPendingComment,
  selectAnchorBlobSha,
} from '@revu/shared'
import type {
  GhBlobRaw,
  GhCompareRaw,
  GhGraphqlBlobObject,
  GhGraphqlPageInfo,
  GhReviewThreadNode,
  GhTreeRaw,
  GithubClient,
  Page,
  PageParams,
} from './github-client'
import type { RepoRef } from './repo'
import { createDirectApi, type DirectApi } from './direct-api'
import { unusedWriteMethods } from './github-write-stubs'
import { openDirectStore, type DirectStore } from './store'

const REPO: RepoRef = { owner: 'o', repo: 'r' }
const SESSION: Session = {
  human: { id: 'h@x.io', name: 'H', role: 'contractor', email: 'h@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
  viewerLogin: 'h-gh',
}
const PR = 5
const PATH = 'src/a.ts'

/** The base blob is FIXED across the force-push; a LEFT anchor reads it. */
const BASE_SHA = 'blob-base'
const BASE_LINES = ['base head', 'deleted base line', 'base tail']

/** The head blob is REWRITTEN by the force-push: SHA and content both change. */
const HEAD_SHA_OLD = 'blob-head-old'
const HEAD_LINES_OLD = ['clean anchor', 'drift anchor', 'lost anchor', 'tail one']
const HEAD_SHA_NEW = 'blob-head-new'
// Two lines inserted above 'drift anchor' (→ +2), 'lost anchor' deleted.
const HEAD_LINES_NEW = [
  'clean anchor',
  'inserted A',
  'inserted B',
  'drift anchor',
  'tail one',
  'tail two',
]

const BLOB_CONTENT: Record<string, string[]> = {
  [BASE_SHA]: BASE_LINES,
  [HEAD_SHA_OLD]: HEAD_LINES_OLD,
  [HEAD_SHA_NEW]: HEAD_LINES_NEW,
}

/** The mutable head SHA and commit list the fake advances on the force-push. */
interface RemoteState {
  headSha: string
  headBlobSha: string
  commits: { sha: string; date: string }[]
}

function initialState(): RemoteState {
  return {
    headSha: 'HEAD-OLD',
    headBlobSha: HEAD_SHA_OLD,
    commits: [
      { sha: 'C0', date: '2026-01-10T00:00:00.000Z' },
      { sha: 'HEAD-OLD', date: '2026-01-14T00:00:00.000Z' },
    ],
  }
}

/** Advance the remote as a force-push would: new head + head blob, three commits added. */
function forcePush(state: RemoteState): void {
  state.headSha = 'HEAD-NEW'
  state.headBlobSha = HEAD_SHA_NEW
  state.commits = [
    ...state.commits,
    { sha: 'C2', date: '2026-01-16T00:00:00.000Z' },
    { sha: 'C3', date: '2026-01-17T00:00:00.000Z' },
    { sha: 'HEAD-NEW', date: '2026-01-18T00:00:00.000Z' },
  ]
}

/** A fake whose head, head blob, and commit list advance when `forcePush` runs. */
function movingHeadClient(state: RemoteState): GithubClient {
  const page = <T>(items: T[], params: PageParams): Page<T> =>
    params.page === 1 ? { items, hasNext: false } : { items: [], hasNext: false }
  return {
    async getViewer() {
      return { login: 'h-gh', id: 1 }
    },
    async getPullDetail() {
      return {
        number: PR,
        state: 'open',
        user: { login: 'author', id: 2, type: 'User' },
        head: { sha: state.headSha },
        base: { sha: 'BRANCH' },
      }
    },
    async getCompare(): Promise<GhCompareRaw> {
      return { merge_base_commit: { sha: 'MB' } }
    },
    async getPullFiles(_o, _r, _n, params): Promise<Page<unknown>> {
      return page(
        [
          {
            sha: state.headBlobSha,
            filename: PATH,
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
      return page([], params)
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      return page([], params)
    },
    async getPullCommits(_o, _r, _n, params): Promise<Page<unknown>> {
      const items = state.commits.map((c) => ({
        sha: c.sha,
        commit: { message: `commit ${c.sha}`, author: { name: 'A', email: 'a@x.io', date: c.date } },
      }))
      return page(items, params)
    },
    async getCheckRuns() {
      return { check_runs: [] }
    },
    async getTree(): Promise<GhTreeRaw> {
      // Merge base is fixed → the base blob SHA never changes.
      return { tree: [{ path: PATH, type: 'blob', sha: BASE_SHA }], truncated: false }
    },
    async getBlob(_o, _r, sha): Promise<GhBlobRaw> {
      const lines = BLOB_CONTENT[sha] ?? []
      const text = lines.length === 0 ? '' : lines.join('\n') + '\n'
      return {
        content: Buffer.from(text, 'utf8').toString('base64'),
        encoding: 'base64',
        size: Buffer.byteLength(text, 'utf8'),
      }
    },
    async getBlobObjects(_o, _r, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      const out: Record<string, GhGraphqlBlobObject | null> = {}
      for (const sha of shas) {
        const lines = BLOB_CONTENT[sha] ?? []
        const text = lines.length === 0 ? '' : lines.join('\n') + '\n'
        out[sha] = { isBinary: false, text, byteSize: Buffer.byteLength(text, 'utf8') }
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
    ...unusedWriteMethods(),
  }
}

function build(client: GithubClient, store: DirectStore): DirectApi {
  return createDirectApi({ session: SESSION, github: client, repo: REPO, store })
}

/** The draft's pending comments — a RIGHT clean/drift/lost trio and a LEFT clean. */
function draftComments(): PendingComment[] {
  return [
    {
      key: 'c-clean',
      path: PATH,
      side: 'RIGHT',
      start_side: null,
      line: 1,
      start_line: null,
      body: 'clean note',
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
      anchor: { lineText: 'clean anchor', contextBefore: [], contextAfter: ['drift anchor'] },
    },
    {
      key: 'c-drift',
      path: PATH,
      side: 'RIGHT',
      start_side: null,
      line: 2,
      start_line: null,
      body: 'drift note',
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
      anchor: {
        lineText: 'drift anchor',
        contextBefore: ['clean anchor'],
        contextAfter: ['tail one'],
      },
    },
    {
      key: 'c-lost',
      path: PATH,
      side: 'RIGHT',
      start_side: null,
      line: 3,
      start_line: null,
      body: 'lost note',
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
      anchor: { lineText: 'lost anchor', contextBefore: [], contextAfter: [] },
    },
    {
      key: 'c-left',
      path: PATH,
      side: 'LEFT',
      start_side: null,
      line: 2,
      start_line: null,
      body: 'left note',
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
      anchor: {
        lineText: 'deleted base line',
        contextBefore: ['base head'],
        contextAfter: ['base tail'],
      },
    },
  ]
}

/**
 * Sync PR #5, seed a draft against that (soon-to-be-stale) head, force-push, and
 * re-sync — leaving the adapter ready for a reconcile against the fresh snapshot.
 */
async function seedForcePushed(api: DirectApi, state: RemoteState): Promise<ReviewDraft> {
  const first = await api.syncPull(PR)
  expect(first.immutable.headSha).toBe('HEAD-OLD')

  const draft = api.saveDraft({
    humanId: SESSION.human.id,
    prNumber: PR,
    headSha: first.immutable.headSha,
    compareKey: first.immutable.compareKey,
    body: 'review body',
    event: 'COMMENT',
    comments: draftComments(),
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  })

  forcePush(state)
  const second = await api.syncPull(PR)
  expect(second.immutable.headSha).toBe('HEAD-NEW')
  return draft
}

describe('direct reconcile path — contract conformance', () => {
  test('the seeded snapshot is behind the remote head after the force-push', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialState()
    const api = build(movingHeadClient(state), store)
    const first = await api.syncPull(PR)
    const draft = api.saveDraft({
      humanId: SESSION.human.id,
      prNumber: PR,
      headSha: first.immutable.headSha,
      compareKey: first.immutable.compareKey,
      body: '',
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    })
    // The draft was written against the (now stale) snapshot head.
    expect(draft.headSha).toBe(first.immutable.headSha)
    forcePush(state)
    const detail = await api.syncPull(PR)
    expect(detail.immutable.headSha).not.toBe(draft.headSha)
    store.close()
  })

  test('after re-sync, reconcile yields clean / clean / drifted / lost with the expected delta and newCommits', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialState()
    const api = build(movingHeadClient(state), store)
    await seedForcePushed(api, state)

    const report = api.reconcileDraft(PR)
    const kinds = report.results.map((r) => r.kind).sort()
    // A RIGHT clean/drifted/lost trio plus a LEFT-side clean anchor: the LEFT
    // note targets a deleted base line whose merge base is unchanged, so it
    // re-anchors cleanly against the base blob.
    expect(kinds).toEqual(['clean', 'clean', 'drifted', 'lost'])

    const drifted = report.results.find((r) => r.kind === 'drifted')
    expect(drifted?.kind).toBe('drifted')
    expect(drifted?.kind === 'drifted' ? drifted.delta : null).toBe(2)

    // The LEFT-side comment classified against BASE content, not head.
    const leftResult = report.results.find((r) => r.comment.side === 'LEFT')
    expect(leftResult?.kind).toBe('clean')

    // Three commits landed after the draft's head (still in the fresh list).
    expect(report.newCommits.map((c) => c.sha)).toEqual(['C2', 'C3', 'HEAD-NEW'])
    expect(report.draftHeadSha).toBe('HEAD-OLD')
    expect(report.currentHeadSha).toBe('HEAD-NEW')

    store.close()
  })

  test('the client-side preview matches the reconcile report for every comment, both sides', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialState()
    const api = build(movingHeadClient(state), store)
    await seedForcePushed(api, state)

    const report = api.reconcileDraft(PR)
    const snap = api.getSnapshot(PR)
    const draft = api.getDraft(PR)
    expect(snap).not.toBeNull()
    expect(draft).not.toBeNull()

    // Resolve blob lines through the contract's getBlob, exactly as the dialog does.
    const resolveBlobLines = (sha: string): string[] | null => {
      const blob = api.getBlob(sha)
      return blob.binary ? null : blobContentToLines(blob.content)
    }

    const sides = new Set(draft!.comments.map((c) => c.side))
    expect(sides.has('LEFT')).toBe(true)
    expect(sides.has('RIGHT')).toBe(true)

    for (const comment of draft!.comments) {
      // Side chosen through the SAME shared selector the classifier uses, so the
      // parity check cannot prefetch the wrong blob and mask a divergence.
      const entry = snap!.immutable.blobIndex[comment.path]
      const sha = selectAnchorBlobSha(entry, comment.side)
      const preview: AnchorResult = classifyPendingComment({
        comment,
        files: snap!.immutable.files,
        blobIndex: snap!.immutable.blobIndex,
        resolveBlobLines: (s) => (s === sha ? resolveBlobLines(s) : null),
      })
      const reported = report.results.find((r) => r.comment.key === comment.key)
      expect(reported).toBeDefined()
      // Preview and report must be byte-identical for this comment.
      expect(preview).toEqual(reported!)
    }

    store.close()
  })
})

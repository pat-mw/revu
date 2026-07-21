import { expect } from 'bun:test'
import type {
  ChecksRollup,
  PendingComment,
  PullSummary,
  RateLimitInfo,
  ReviewDraft,
  Session,
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
  PullListClient,
  PullListPage,
} from './github-client'
import type { PollFactsSource, PollPullFacts } from '../broker/poll-loop'
import type { RepoRef } from './repo'
import type { DirectApi } from './direct-api'
import type { TokenSource } from './token-source'
import { unusedWriteMethods } from './github-write-stubs'

/**
 * Fake `GithubClient`s and fixtures shared by every network-free conformance run
 * of the shared read/persist engine — the direct-adapter read and reconcile
 * suites, and the broker-adapter suite (the same engine brought up against a
 * host-injected credential). Keeping the fakes in one place means every mode is
 * held to the same contract from one set of fixtures, and a fixture change lands
 * once. Test-support code: imported only by `*.test.ts`, nothing here runs in a
 * live daemon.
 */

/** The repo every conformance fake serves. */
export const CONFORMANCE_REPO: RepoRef = { owner: 'o', repo: 'r' }

/** The session every conformance fake keys per-human state against. */
export const CONFORMANCE_SESSION: Session = {
  human: { id: 'h@x.io', name: 'H', role: 'contractor', email: 'h@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
  viewerLogin: 'h-gh',
}

/** One-page helper: page 1 carries the items, every later page is empty. */
function page<T>(items: T[], params: PageParams): Page<T> {
  return params.page === 1 ? { items, hasNext: false } : { items: [], hasNext: false }
}

/**
 * Wrap a fake `GithubClient` so every call first resolves a token through the
 * injected source — the same ordering the real client uses (`getToken()` then
 * the request). This routes a fake's data through the broker's actual
 * credential-custody path, so a broker conformance run proves the engine and
 * the file-credential surface compose. When the credential file is empty the
 * source throws `AwaitingCredentialError` from the first wrapped method a
 * request reaches; on the top-level paths that propagates to the router as
 * `broker_unreachable` (502). Note the blob-provision tier catches per-blob
 * fetch failures and folds a missing blob into a 200 `partial` snapshot
 * instead, so an absent credential reached only through that broad catch
 * surfaces as `partial`, not a 502 — the two are exercised separately.
 */
export function tokenGated(client: GithubClient, tokenSource: TokenSource): GithubClient {
  const gate =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await tokenSource.getToken()
      return fn(...args)
    }
  const out = {} as Record<string, unknown>
  for (const [name, value] of Object.entries(client) as [string, unknown][]) {
    out[name] = typeof value === 'function' ? gate(value.bind(client) as never) : value
  }
  return out as unknown as GithubClient
}

// ————————————————————————————————————————————————————————————————
// The base-moved read fake (drives baseline + baseAdvanced + mutableDrift)
// ————————————————————————————————————————————————————————————————

/** PR number the base-moved read fake answers for. */
export const MOVING_BASE_PR = 204

/** A mutable fake whose head is fixed but whose merge base can be advanced between syncs. */
export function movingBaseClient(state: {
  mergeBaseSha: string
  unresolvedComments: number
}): GithubClient {
  return {
    async getViewer() {
      return { login: 'h-gh', id: 1 }
    },
    async getPullDetail() {
      return {
        number: MOVING_BASE_PR,
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
    async getRateLimit() {
      return { limit: 5000, remaining: 4999, used: 1, reset: '2026-01-01T00:00:00.000Z' }
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
    ...unusedWriteMethods(),
  }
}

/**
 * The head blob SHA `movingBaseClient` reports for its single changed file. The
 * partial fake below withholds exactly this SHA from every provisioning tier.
 */
export const MOVING_BASE_HEAD_BLOB_SHA = 'blobHead'

/**
 * A base-moved fake that CANNOT provision the head blob's bytes from any tier:
 * the GraphQL batch nulls that SHA and the single-blob straggler fails for it, so
 * the sync keeps the snapshot with an honest `partial` naming the missing SHA
 * rather than throwing. Every other blob is provisioned normally. This drives the
 * `partial`-tolerating sync path — an absent credential is a DIFFERENT thing (it
 * throws `AwaitingCredentialError`), so the two must not be conflated.
 */
export function partialBlobClient(state: {
  mergeBaseSha: string
  unresolvedComments: number
}): GithubClient {
  const base = movingBaseClient(state)
  return {
    ...base,
    async getBlob(owner, repo, sha): Promise<GhBlobRaw> {
      // The straggler fallback also fails for the withheld head SHA, so no tier
      // can produce it and it lands in `partial`.
      if (sha === MOVING_BASE_HEAD_BLOB_SHA) {
        throw new Error(`fake: blob ${sha} withheld to drive a partial`)
      }
      return base.getBlob(owner, repo, sha)
    },
    async getBlobObjects(owner, repo, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      const out = await base.getBlobObjects(owner, repo, shas)
      if (MOVING_BASE_HEAD_BLOB_SHA in out) out[MOVING_BASE_HEAD_BLOB_SHA] = null
      return out
    },
  }
}

// ————————————————————————————————————————————————————————————————
// The force-push reconcile fake (drives the reconcile scenario)
// ————————————————————————————————————————————————————————————————

/** PR number the reconcile fake answers for. */
export const RECONCILE_PR = 5
/** File path the reconcile fake's single changed file lives at. */
export const RECONCILE_PATH = 'src/a.ts'

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
export interface RemoteState {
  headSha: string
  headBlobSha: string
  commits: { sha: string; date: string }[]
}

export function initialReconcileState(): RemoteState {
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
export function forcePush(state: RemoteState): void {
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
export function movingHeadClient(state: RemoteState): GithubClient {
  return {
    async getViewer() {
      return { login: 'h-gh', id: 1 }
    },
    async getPullDetail() {
      return {
        number: RECONCILE_PR,
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
            filename: RECONCILE_PATH,
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
    async getRateLimit() {
      return { limit: 5000, remaining: 4999, used: 1, reset: '2026-01-01T00:00:00.000Z' }
    },
    async getCheckRuns() {
      return { check_runs: [] }
    },
    async getTree(): Promise<GhTreeRaw> {
      // Merge base is fixed → the base blob SHA never changes.
      return { tree: [{ path: RECONCILE_PATH, type: 'blob', sha: BASE_SHA }], truncated: false }
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

/** The draft's pending comments — a RIGHT clean/drift/lost trio and a LEFT clean. */
export function reconcileDraftComments(): PendingComment[] {
  return [
    {
      key: 'c-clean',
      path: RECONCILE_PATH,
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
      path: RECONCILE_PATH,
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
      path: RECONCILE_PATH,
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
      path: RECONCILE_PATH,
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
 * Sync the reconcile PR, seed a draft against that (soon-to-be-stale) head,
 * force-push, and re-sync — leaving the adapter ready for a reconcile against the
 * fresh snapshot. Returns the draft as it was seeded (against the OLD head).
 */
export async function seedForcePushed(api: DirectApi, state: RemoteState): Promise<ReviewDraft> {
  const first = await api.syncPull(RECONCILE_PR)
  // The draft is seeded against the OLD head; assert the fixture actually starts
  // there so a broken fixture fails precisely here at seed time, not later with a
  // confusing reconcile mismatch.
  expect(first.immutable.headSha).toBe('HEAD-OLD')

  const draft = api.saveDraft({
    humanId: CONFORMANCE_SESSION.human.id,
    prNumber: RECONCILE_PR,
    headSha: first.immutable.headSha,
    compareKey: first.immutable.compareKey,
    body: 'review body',
    event: 'COMMENT',
    comments: reconcileDraftComments(),
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  })

  forcePush(state)
  const second = await api.syncPull(RECONCILE_PR)
  // The re-sync must observe the force-pushed head — the whole point of the seed.
  expect(second.immutable.headSha).toBe('HEAD-NEW')
  return draft
}

// ————————————————————————————————————————————————————————————————
// Broker pulls-list poll fakes (drive the M4.1 poll-loop scenarios).
// Additive block: everything below is used only by the M4.1 poll-loop
// scenarios in conformance-broker.test.ts. It does not touch the fixtures above.
// ————————————————————————————————————————————————————————————————

/** A minimal open-pull row the poll fake serves; enough for `PullSummary` mapping. */
export interface FakePull {
  number: number
  headSha: string
  baseSha: string
  updatedAt: string
  /** Live facts the batched-GraphQL fake reports for this pull. */
  unresolvedThreads: number
  commitCount: number
  /** Merge base the compare fake reports; the compareKey is `${mergeBase}...${headSha}`. */
  mergeBaseSha: string
  /**
   * The head commit's CI rollup as the batched-facts fake reports it. Omit to
   * model a facts source that answers without a rollup at all (the field is never
   * observed, so a prior rollup carries forward); `null` models a pull the query
   * resolved but that has no CI reporting on it.
   *
   * Mutating this WITHOUT `mutatePulls` is how a test models a build finishing:
   * the ETag sequence does not move, so the next poll is still an upstream 304
   * and only the rollup has changed.
   */
  checks?: ChecksRollup | null
  /**
   * The PR author's github login. Defaults to `'author'` (an org member) when
   * omitted; set it to the broker bot login to model an App-authored PR, which
   * drives the `canApprove` annotation (a bot-authored PR is not self-approvable).
   */
  authorLogin?: string
}

/** Build a `PullSummary` from a `FakePull` row — the fields a REST list carries. */
function summaryFromFake(p: FakePull): PullSummary {
  return {
    id: p.number,
    node_id: `PR_${p.number}`,
    number: p.number,
    state: 'open',
    draft: false,
    merged_at: null,
    title: `PR #${p.number}`,
    body: null,
    user: {
      login: p.authorLogin ?? 'author',
      id: 2,
      node_id: 'U_2',
      avatar_url: '',
      html_url: '',
      type: 'User',
    },
    labels: [],
    requested_reviewers: [],
    head: { ref: 'feature', sha: p.headSha, label: 'o:feature', repo: { full_name: 'o/r', default_branch: 'main' } },
    base: { ref: 'main', sha: p.baseSha, label: 'o:main', repo: { full_name: 'o/r', default_branch: 'main' } },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: p.updatedAt,
  }
}

/** A steady rate limit the poll fake reports on every response (200 and 304). */
function fakeRateLimit(): RateLimitInfo {
  return { limit: 5000, remaining: 4999, used: 1, reset: '2026-01-01T01:00:00.000Z' }
}

/**
 * The mutable state the poll fake serves. `pulls` is the current open list;
 * `etagSeq` bumps whenever the list content changes so the conditional read can
 * answer 304 while unchanged and 200 on a change. `nonNotModified` counts the
 * responses that were NOT 304 — the cost-budget metric the idle-polling scenario
 * asserts on.
 */
export interface PollFakeState {
  pulls: FakePull[]
  /** Bumped by `mutatePulls` to force the next conditional read to be a 200. */
  etagSeq: number
  /** Requests answered with a 200 (a real cost); a 304 does not increment this. */
  nonNotModified: number
  /**
   * Batched facts queries issued. A tick with nothing to ask about must not
   * issue one at all, which is what keeps an idle poll free.
   */
  factsQueries: number
}

export function initialPollState(pulls: FakePull[]): PollFakeState {
  return { pulls, etagSeq: 1, nonNotModified: 0, factsQueries: 0 }
}

/** Apply a change and bump the ETag sequence so the next poll observes a 200. */
export function mutatePulls(state: PollFakeState, mutate: (pulls: FakePull[]) => void): void {
  mutate(state.pulls)
  state.etagSeq += 1
}

/**
 * A `PullListClient` + `PollFactsSource` over a mutable list state, with real
 * conditional-ETag semantics: the ETag is the current sequence, so a request
 * whose `If-None-Match` equals it answers 304 (free), and any content change
 * bumps the sequence so the next request is a 200. Every non-304 response is
 * counted, so a test can prove idle polling costs one non-304 then only 304s.
 */
export function fakePollSources(state: PollFakeState): {
  client: PullListClient
  facts: PollFactsSource
} {
  const currentEtag = (): string => `gh-list-etag-${state.etagSeq}`
  /**
   * The batched facts query, shared by both seams so a test cannot accidentally
   * exercise two different fakes. A pull the state does not know is OMITTED,
   * modelling a number GitHub could not resolve.
   */
  async function pullFacts(
    _owner: string,
    _repo: string,
    prNumbers: number[],
  ): Promise<Record<number, PollPullFacts>> {
    state.factsQueries += 1
    const out: Record<number, PollPullFacts> = {}
    for (const n of prNumbers) {
      const p = state.pulls.find((x) => x.number === n)
      if (p === undefined) continue
      out[n] = {
        unresolvedThreads: p.unresolvedThreads,
        commitCount: p.commitCount,
        ...(p.checks === undefined ? {} : { checks: p.checks }),
      }
    }
    return out
  }
  const client: PullListClient = {
    async listOpenPulls(_owner, _repo, etag): Promise<PullListPage> {
      const responseEtag = currentEtag()
      if (etag !== null && etag === responseEtag) {
        // Unchanged upstream: a free 304, no body, rate headers still returned.
        return { items: [], etag: responseEtag, notModified: true, rateLimit: fakeRateLimit() }
      }
      state.nonNotModified += 1
      return {
        items: state.pulls.map(summaryFromFake),
        etag: responseEtag,
        notModified: false,
        rateLimit: fakeRateLimit(),
      }
    },
    getPullFacts: pullFacts,
  }
  const facts: PollFactsSource = {
    getPullFacts: pullFacts,
    async getCompare(_owner, _repo, _base, head): Promise<GhCompareRaw> {
      const p = state.pulls.find((x) => x.headSha === head)
      return { merge_base_commit: { sha: p?.mergeBaseSha ?? 'UNKNOWN' } }
    },
  }
  return { client, facts }
}

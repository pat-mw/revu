/**
 * The GraphQL → REST review-thread normalizer, driven entirely by injected
 * GraphQL-response fixtures — no network, no `gh`. The tests pin the three
 * mappings the schema forces and the structural parity the contract demands:
 *
 *   - `fullDatabaseId` (a GraphQL `BigInt`, arriving as a JSON string) → the
 *     REST-numeric comment `id`.
 *   - the THREAD's `diffSide` → each comment's `side` (a comment node has no
 *     `diffSide` of its own).
 *   - `diffHunk` → `diff_hunk`, carried verbatim; `isResolved`/`isOutdated`/
 *     `resolvedBy` carried straight from the thread.
 *
 * The parity test asserts the normalizer's output is structurally identical
 * (same keys, same value types) to the shape the mock fixtures produce — the
 * `ReviewThread`/`ReviewComment` builders in the app's PR fixtures are the
 * frozen oracle for the client's one comment vocabulary. That oracle is
 * reproduced here (not imported) so the test stays inside this package and
 * network-free, exactly as the gate requires.
 */
import { describe, expect, test } from 'bun:test'
import type { ReviewComment, ReviewThread } from '@revu/shared'
import type {
  GhGraphqlPageInfo,
  GhReviewCommentNode,
  GhReviewThreadNode,
  GithubClient,
} from './github-client'
import type { RepoRef } from './repo'
import { fetchReviewThreads, normalizeReviewThread, normalizeReviewThreads } from './threads'

const REPO: RepoRef = { owner: 'o', repo: 'r' }

// ————————————————————————————————————————————————————————————————
// GraphQL-response fixture builders (what the client returns per page)
// ————————————————————————————————————————————————————————————————

function commentNode(over: Partial<GhReviewCommentNode> = {}): GhReviewCommentNode {
  return {
    fullDatabaseId: '3605992420',
    path: 'src/metering/rollup.ts',
    diffHunk: '@@ -1,4 +1,4 @@\n-import { db } from x\n+import { db, withTransaction } from x',
    line: 97,
    originalLine: 97,
    startLine: null,
    originalStartLine: null,
    subjectType: 'LINE',
    body: 'Is a re-run of the same window actually idempotent?',
    createdAt: '2026-07-15T00:00:00Z',
    updatedAt: '2026-07-15T00:00:00Z',
    author: { login: 'dkozlov' },
    pullRequestReview: { fullDatabaseId: '8347001' },
    replyTo: null,
    commit: { oid: 'headoid' },
    originalCommit: { oid: 'c3oid' },
    url: 'https://github.com/o/r/pull/3#discussion_r3605992420',
    ...over,
  }
}

function threadNode(over: Partial<GhReviewThreadNode> = {}): GhReviewThreadNode {
  return {
    id: 'PRRT_kwDOthread1',
    isResolved: false,
    isOutdated: false,
    path: 'src/metering/rollup.ts',
    line: 97,
    originalLine: 97,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [commentNode()],
    },
    ...over,
  }
}

// ————————————————————————————————————————————————————————————————
// The oracle: the exact shape the app's pr347 fixture builders produce
// ————————————————————————————————————————————————————————————————

/**
 * Reproduces the app fixture's `reviewComment()` output shape — every key the
 * frozen `ReviewComment` carries, at its documented type. This is the structural
 * contract the normalizer must match key-for-key (values differ; types must not).
 */
function oracleComment(): ReviewComment {
  return {
    id: 3471001,
    node_id: 'PRRC_kwDOxxxx',
    pull_request_review_id: 8347001,
    path: 'src/metering/rollup.ts',
    diff_hunk: '@@ -1,4 +1,4 @@\n-a\n+b',
    commit_id: 'headoid',
    original_commit_id: 'c3oid',
    line: 97,
    original_line: 97,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: 'line',
    user: {
      login: 'dkozlov',
      id: 0,
      node_id: '',
      avatar_url: '',
      html_url: '',
      type: 'User',
    },
    body: 'text',
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    reactions: {
      url: '',
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    html_url: 'https://github.com/o/r/pull/3#discussion_r3471001',
  }
}

/** Reproduces the app fixture's `thread()` output shape — every `ReviewThread` key. */
function oracleThread(): ReviewThread {
  return {
    id: 'PRRT_kwDOthread1',
    isResolved: false,
    isOutdated: false,
    path: 'src/metering/rollup.ts',
    line: 97,
    originalLine: 97,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [oracleComment()],
  }
}

/** A structural signature: every key mapped to its value's runtime type (null-aware). */
function shape(v: unknown): unknown {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.map(shape)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = shape((v as Record<string, unknown>)[k])
    }
    return out
  }
  return typeof v
}

describe('normalizeReviewThread — the three schema-forced mappings', () => {
  test('fullDatabaseId (a BigInt JSON string) becomes the REST-numeric comment id', () => {
    const t = normalizeReviewThread(threadNode())
    expect(t.comments[0].id).toBe(3605992420)
    expect(typeof t.comments[0].id).toBe('number')
  })

  test('a numeric fullDatabaseId passes through unchanged', () => {
    const t = normalizeReviewThread(
      threadNode({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ fullDatabaseId: 42 })] } }),
    )
    expect(t.comments[0].id).toBe(42)
  })

  test('an absent fullDatabaseId throws — never a fabricated 0 id', () => {
    // The comment id keys reply writes and the reactions route; two comments
    // silently coerced to 0 would collide. Failing the sync loudly beats
    // persisting a corrupt snapshot.
    expect(() =>
      normalizeReviewThread(
        threadNode({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ fullDatabaseId: null })] } }),
      ),
    ).toThrow(/fullDatabaseId/)
  })

  test('an unparseable or empty-string fullDatabaseId throws too (Number("") is 0)', () => {
    for (const bad of ['not-a-number', '', '   ']) {
      expect(() =>
        normalizeReviewThread(
          threadNode({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ fullDatabaseId: bad })] } }),
        ),
      ).toThrow(/fullDatabaseId/)
    }
  })

  test('an unparseable OPTIONAL id degrades to absent, not 0', () => {
    // pull_request_review_id is nullable and in_reply_to_id optional in the
    // contract, so a bad value there degrades honestly instead of inventing 0.
    const t = normalizeReviewThread(
      threadNode({
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [commentNode({ pullRequestReview: { fullDatabaseId: 'garbage' }, replyTo: { fullDatabaseId: '' } })],
        },
      }),
    )
    expect(t.comments[0].pull_request_review_id).toBeNull()
    expect(t.comments[0].in_reply_to_id).toBeUndefined()
  })

  test("the thread's diffSide maps to each comment's side (comment has no diffSide)", () => {
    const t = normalizeReviewThread(threadNode({ diffSide: 'LEFT' }))
    expect(t.diffSide).toBe('LEFT')
    expect(t.comments[0].side).toBe('LEFT')
  })

  test('a range that starts LEFT and ends RIGHT carries start_side LEFT (from startDiffSide)', () => {
    // GitHub allows a multi-line comment to span sides: `side` is the END line's
    // side, `start_side` the START line's. Those map to the thread's `diffSide`
    // and `startDiffSide` respectively — start_side must NOT copy the end side.
    const t = normalizeReviewThread(
      threadNode({
        diffSide: 'RIGHT',
        startDiffSide: 'LEFT',
        startLine: 90,
        originalStartLine: 90,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [commentNode({ startLine: 90, originalStartLine: 90 })],
        },
      }),
    )
    expect(t.comments[0].side).toBe('RIGHT')
    expect(t.comments[0].start_side).toBe('LEFT')
  })

  test('diffHunk is carried verbatim into diff_hunk', () => {
    const hunk = '@@ -10,3 +10,7 @@\n context\n+added'
    const t = normalizeReviewThread(
      threadNode({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ diffHunk: hunk })] } }),
    )
    expect(t.comments[0].diff_hunk).toBe(hunk)
  })

  test('isResolved / isOutdated / resolvedBy carry straight from the thread', () => {
    const resolved = normalizeReviewThread(
      threadNode({ isResolved: true, resolvedBy: { login: 'dkozlov' } }),
    )
    expect(resolved.isResolved).toBe(true)
    expect(resolved.resolvedBy).toEqual({ login: 'dkozlov' })

    const outdated = normalizeReviewThread(threadNode({ isOutdated: true, line: null }))
    expect(outdated.isOutdated).toBe(true)
    // An outdated thread reports line: null from GitHub — kept honestly, not faked.
    expect(outdated.line).toBeNull()
  })

  test('pullRequestReview.fullDatabaseId → pull_request_review_id; absent → null', () => {
    const withReview = normalizeReviewThread(threadNode())
    expect(withReview.comments[0].pull_request_review_id).toBe(8347001)

    const noReview = normalizeReviewThread(
      threadNode({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ pullRequestReview: null })] } }),
    )
    expect(noReview.comments[0].pull_request_review_id).toBeNull()
  })

  test('replyTo.fullDatabaseId becomes in_reply_to_id only for a reply', () => {
    const root = normalizeReviewThread(threadNode())
    expect(root.comments[0].in_reply_to_id).toBeUndefined()

    const reply = normalizeReviewThread(
      threadNode({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ replyTo: { fullDatabaseId: '3471001' } })] } }),
    )
    expect(reply.comments[0].in_reply_to_id).toBe(3471001)
  })

  test('a FILE-subject thread maps to REST file / LINE subject types', () => {
    const t = normalizeReviewThread(
      threadNode({
        subjectType: 'FILE',
        comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commentNode({ subjectType: 'FILE' })] },
      }),
    )
    expect(t.subjectType).toBe('FILE')
    expect(t.comments[0].subject_type).toBe('file')
  })
})

describe('structural parity with the frozen fixture shape (the oracle)', () => {
  test('a normalized thread has the identical key/type shape as the pr347 builders produce', () => {
    const normalized = normalizeReviewThread(threadNode())
    expect(shape(normalized)).toEqual(shape(oracleThread()))
  })

  test('a ranged, replied thread still matches the oracle shape (with in_reply_to_id present)', () => {
    // A two-comment thread where the second is a reply — the shape the fixture's
    // multi-comment threads (e.g. the naming/boundary threads) produce.
    const node = threadNode({
      startLine: 90,
      originalStartLine: 90,
      startDiffSide: 'RIGHT',
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          commentNode({ startLine: 90, originalStartLine: 90 }),
          commentNode({ fullDatabaseId: '3471002', replyTo: { fullDatabaseId: '3471001' }, startLine: 90, originalStartLine: 90 }),
        ],
      },
    })
    const normalized = normalizeReviewThread(node)

    const oracle = oracleThread()
    oracle.startLine = 90
    oracle.originalStartLine = 90
    oracle.startDiffSide = 'RIGHT'
    const c0 = oracleComment()
    c0.start_line = 90
    c0.original_start_line = 90
    c0.start_side = 'RIGHT'
    const c1 = oracleComment()
    c1.start_line = 90
    c1.original_start_line = 90
    c1.start_side = 'RIGHT'
    c1.in_reply_to_id = 3471001
    oracle.comments = [c0, c1]

    expect(shape(normalized)).toEqual(shape(oracle))
  })
})

describe('normalizeReviewThreads — a page of nodes', () => {
  test('normalizes a mid-review page: one resolved + one outdated thread', () => {
    const resolved = threadNode({ id: 'PRRT_resolved', isResolved: true, resolvedBy: { login: 'dkozlov' } })
    const outdated = threadNode({ id: 'PRRT_outdated', isOutdated: true, line: null })
    const threads = normalizeReviewThreads([resolved, outdated])
    expect(threads).toHaveLength(2)
    expect(threads[0].isResolved).toBe(true)
    expect(threads[0].resolvedBy).toEqual({ login: 'dkozlov' })
    expect(threads[1].isOutdated).toBe(true)
    expect(threads[1].line).toBeNull()
  })

  test('an empty page normalizes to an empty array (contract-valid)', () => {
    expect(normalizeReviewThreads([])).toEqual([])
  })
})

// ————————————————————————————————————————————————————————————————
// fetchReviewThreads — pagination of threads and of nested comments
// ————————————————————————————————————————————————————————————————

interface FetchCalls {
  threadPages: number
  commentPages: number
  /** The `after` cursor received on each thread-connection call, in order. */
  threadCursors: (string | null)[]
  /** The `after` cursor received on each comment-drain call, in order. */
  commentCursors: (string | null)[]
}

/**
 * A GraphQL-only fake client: it answers `getReviewThreads` from `threadPages`
 * (each an already-paged slice) and `getThreadComments` from `commentPages`
 * keyed by thread id. Only the two GraphQL methods are exercised here, so the
 * REST methods throw if touched.
 */
function graphqlFake(
  threadPages: { pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }[],
  commentPages: Record<string, { pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] }[]>,
): { client: GithubClient; calls: FetchCalls } {
  const calls: FetchCalls = { threadPages: 0, commentPages: 0, threadCursors: [], commentCursors: [] }
  const commentCursor: Record<string, number> = {}
  const unused = (): never => {
    throw new Error('REST method not used in a GraphQL-only test')
  }
  const client = {
    getViewer: unused,
    getPullDetail: unused,
    getCompare: unused,
    getPullFiles: unused,
    getIssueComments: unused,
    getPullReviews: unused,
    getPullCommits: unused,
    getCheckRuns: unused,
    getTree: unused,
    async graphql<T>(): Promise<T> {
      throw new Error('graphql not used directly here')
    },
    async getReviewThreads(
      _owner: string,
      _repo: string,
      _prNumber: number,
      cursor: string | null,
    ): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }> {
      const page = threadPages[calls.threadPages] ?? {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      }
      calls.threadPages += 1
      calls.threadCursors.push(cursor)
      return page
    },
    async getThreadComments(
      threadId: string,
      cursor: string | null,
    ): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] }> {
      calls.commentPages += 1
      calls.commentCursors.push(cursor)
      const idx = commentCursor[threadId] ?? 0
      commentCursor[threadId] = idx + 1
      return (
        commentPages[threadId]?.[idx] ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
      )
    },
  } as unknown as GithubClient
  return { client, calls }
}

function counter(): { n: number; bump(by?: number): void } {
  return {
    n: 0,
    bump(by = 1) {
      this.n += by
    },
  }
}

describe('fetchReviewThreads — pagination', () => {
  test('follows reviewThreads pageInfo across multiple thread pages, counting each call', async () => {
    const p1 = {
      pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
      nodes: [threadNode({ id: 'PRRT_a' })],
    }
    const p2 = {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [threadNode({ id: 'PRRT_b' })],
    }
    const { client, calls } = graphqlFake([p1, p2], {})
    const c = counter()
    const threads = await fetchReviewThreads(client, REPO, 3, c)
    expect(threads.map((t) => t.id)).toEqual(['PRRT_a', 'PRRT_b'])
    // Two thread-connection GraphQL calls, both counted in syncStats.requests.
    expect(calls.threadPages).toBe(2)
    expect(c.n).toBe(2)
  })

  test('drains a thread whose comments overflow one page, appending every comment', async () => {
    // The first page carries the thread with its first comment and hasNextPage=true
    // on the nested comment connection; the overflow page carries the second.
    const thread = threadNode({
      id: 'PRRT_big',
      comments: {
        pageInfo: { hasNextPage: true, endCursor: 'CCUR1' },
        nodes: [commentNode({ fullDatabaseId: '1' })],
      },
    })
    const threadPage = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread] }
    const commentOverflow = {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [commentNode({ fullDatabaseId: '2' })],
    }
    const { client, calls } = graphqlFake([threadPage], { PRRT_big: [commentOverflow] })
    const c = counter()
    const threads = await fetchReviewThreads(client, REPO, 3, c)
    expect(threads).toHaveLength(1)
    expect(threads[0].comments.map((cm) => cm.id)).toEqual([1, 2])
    // One thread page + one nested-comment drain page.
    expect(calls.threadPages).toBe(1)
    expect(calls.commentPages).toBe(1)
    expect(c.n).toBe(2)
  })

  test('every page passes the PREVIOUS page pageInfo.endCursor as its cursor', async () => {
    // A two-page thread connection AND a thread whose comments need two drain
    // pages: each request must carry the cursor the previous page returned —
    // a fake that ignored cursors would hide a stale-cursor regression.
    const deep = threadNode({
      id: 'PRRT_deep',
      comments: {
        pageInfo: { hasNextPage: true, endCursor: 'CCUR1' },
        nodes: [commentNode({ fullDatabaseId: '1' })],
      },
    })
    const p1 = { pageInfo: { hasNextPage: true, endCursor: 'CUR1' }, nodes: [deep] }
    const p2 = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [threadNode({ id: 'PRRT_tail' })] }
    const overflow1 = {
      pageInfo: { hasNextPage: true, endCursor: 'CCUR2' },
      nodes: [commentNode({ fullDatabaseId: '2' })],
    }
    const overflow2 = {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [commentNode({ fullDatabaseId: '3' })],
    }
    const { client, calls } = graphqlFake([p1, p2], { PRRT_deep: [overflow1, overflow2] })
    const c = counter()
    const threads = await fetchReviewThreads(client, REPO, 3, c)
    expect(threads.map((t) => t.id)).toEqual(['PRRT_deep', 'PRRT_tail'])
    expect(threads[0].comments.map((cm) => cm.id)).toEqual([1, 2, 3])
    // Cursor threading: first thread page with null, second with page 1's cursor;
    // drain pages with the embedded connection's cursor, then the overflow's.
    expect(calls.threadCursors).toEqual([null, 'CUR1'])
    expect(calls.commentCursors).toEqual(['CCUR1', 'CCUR2'])
    // 2 thread pages + 2 drain pages, all counted.
    expect(c.n).toBe(4)
  })
})

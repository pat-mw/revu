/**
 * The direct-mode WRITE core, held to the contract semantics that MUST survive.
 * Every test drives a fake GitHub client (no socket) and a real in-memory store,
 * so the draft-survival and idempotency invariants are exercised against genuine
 * persistence without touching the network.
 *
 * The invariants under test:
 *   - head-guard mismatch → `head_moved` VALUE, and NOTHING is posted;
 *   - 1:1 comment mapping — a multi-line comment sends `start_line`/`start_side`,
 *     a single-line comment OMITS them;
 *   - a 422 → `conflict`, and the draft is RETAINED;
 *   - the draft is deleted ONLY on a confirmed successful submit;
 *   - a retry-after-timeout re-checks GitHub and short-circuits — no double-post;
 *   - `replyToThread` replies to the thread's FIRST comment;
 *   - `resolveThread` runs the mutation and normalizes the result;
 *   - `addReaction` is shared-and-honest (reads the rollup back);
 *   - every successful write records through the `WriteDecorator` with the
 *     GitHub id plus its endpoint + PR (the metadata an audit row carries).
 */
import { describe, expect, test } from 'bun:test'
import type {
  IssueComment,
  ReactionKey,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  Session,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError } from '@revu/shared'
import type {
  GhReviewThreadNode,
  GithubClient,
  Page,
  ReviewCommentInput,
  SubmitReviewBody,
} from './github-client'
import { GithubRequestError } from './github-client'
import { throwingGithubClient } from './github-write-stubs'
import type { RepoRef } from './repo'
import { openDirectStore, type DirectStore } from './store'
import { createDirectWriteDecorator } from './write-decorator'
import type { WriteDecorator } from './write-decorator'
import { addReaction, replyToThread, resolveThread, submitReview } from './writes'

const REPO: RepoRef = { owner: 'o', repo: 'r' }
const SESSION: Session = {
  human: { id: 'alice@x.io', name: 'Alice', role: 'contractor', email: 'alice@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
  viewerLogin: 'alice-gh',
}

/** A record of everything the fake client was asked to do. */
interface WriteSpy {
  reviewsPosted: SubmitReviewBody[]
  repliesPosted: { commentId: number; body: string }[]
  reactionsPosted: { commentId: number; reaction: string }[]
  issueReactionsPosted: { commentId: number; reaction: string }[]
  resolutionsRun: { threadId: string; resolved: boolean }[]
  pullDetailReads: number
  reviewListReads: number
  reviewCommentListReads: number
}

interface FakeClientConfig {
  /** Head SHA the fake `GET /pulls/{n}` reports. */
  headSha: string
  /** Author login the fake pull detail reports (drives canApprove). */
  authorLogin: string
  /** Current PR commit count the fake pull detail reports. */
  commitCount?: number
  /**
   * Reviews the fake `GET /pulls/{n}/reviews` returns (drives the idempotency
   * re-check). Each carries its posted inline comments, which the fake
   * `GET /reviews/{id}/comments` serves back for the comment-level match.
   */
  existingReviews?: {
    id: number
    login: string
    commit_id: string
    state: string
    body: string
    comments?: {
      path: string
      side?: 'LEFT' | 'RIGHT'
      line: number
      start_line?: number | null
      body: string
    }[]
  }[]
  /** When set, `submitReview` throws a GithubRequestError with this status. */
  submitThrowsStatus?: number
  /** The comment the reply endpoint returns (raw REST shape). */
  replyReturns?: Record<string, unknown>
  /** The thread node the resolve mutation returns. */
  resolveReturns?: GhReviewThreadNode
  /** The comment the reaction read-back returns. */
  reactionCommentReturns?: Record<string, unknown>
}

function fakeClient(cfg: FakeClientConfig): { client: GithubClient; spy: WriteSpy } {
  const spy: WriteSpy = {
    reviewsPosted: [],
    repliesPosted: [],
    reactionsPosted: [],
    issueReactionsPosted: [],
    resolutionsRun: [],
    pullDetailReads: 0,
    reviewListReads: 0,
    reviewCommentListReads: 0,
  }
  let reviewSeq = 9000
  const client: GithubClient = {
    ...throwingGithubClient(),
    async getViewer() {
      return { login: SESSION.viewerLogin ?? '', id: 1 }
    },
    async getPullDetail() {
      spy.pullDetailReads += 1
      return {
        number: 1,
        user: { login: cfg.authorLogin, id: 2, type: 'User' },
        head: { sha: cfg.headSha },
        base: { sha: 'base1' },
        commits: cfg.commitCount ?? 1,
      }
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      spy.reviewListReads += 1
      if (params.page !== 1) return { items: [], hasNext: false }
      const items = (cfg.existingReviews ?? []).map((rv) => ({
        id: rv.id,
        node_id: '',
        user: { login: rv.login, id: 3, type: 'User' },
        body: rv.body,
        state: rv.state,
        submitted_at: '',
        commit_id: rv.commit_id,
      }))
      return { items, hasNext: false }
    },
    async getReviewComments(_o, _r, _n, reviewId, params): Promise<Page<unknown>> {
      spy.reviewCommentListReads += 1
      if (params.page !== 1) return { items: [], hasNext: false }
      const review = (cfg.existingReviews ?? []).find((rv) => rv.id === reviewId)
      const items = (review?.comments ?? []).map((c) => ({
        path: c.path,
        side: c.side ?? 'RIGHT',
        line: c.line,
        original_line: c.line,
        start_line: c.start_line ?? null,
        original_start_line: c.start_line ?? null,
        body: c.body,
      }))
      return { items, hasNext: false }
    },
    async submitReview(_o, _r, _n, body: SubmitReviewBody): Promise<unknown> {
      spy.reviewsPosted.push(body)
      if (cfg.submitThrowsStatus !== undefined) {
        throw new GithubRequestError(cfg.submitThrowsStatus, '/reviews', 'boom', 'POST')
      }
      const id = reviewSeq++
      return {
        id,
        node_id: 'PRR_x',
        user: { login: SESSION.viewerLogin, id: 1, type: 'User' },
        body: body.body,
        state: body.event === 'APPROVE' ? 'APPROVED' : body.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED',
        submitted_at: '2026-01-01T00:00:00.000Z',
        commit_id: body.commit_id,
      }
    },
    async replyToReviewComment(_o, _r, _n, commentId: number, body: string): Promise<unknown> {
      spy.repliesPosted.push({ commentId, body })
      return (
        cfg.replyReturns ?? {
          id: 7001,
          in_reply_to_id: commentId,
          path: 'a.ts',
          body,
          side: 'RIGHT',
          user: { login: SESSION.viewerLogin, id: 1, type: 'User' },
        }
      )
    },
    async addReaction(_o, _r, commentId: number, reaction: string): Promise<unknown> {
      spy.reactionsPosted.push({ commentId, reaction })
      return { id: 1, content: reaction }
    },
    async addIssueCommentReaction(
      _o,
      _r,
      commentId: number,
      reaction: string,
    ): Promise<unknown> {
      spy.issueReactionsPosted.push({ commentId, reaction })
      return { id: 1, content: reaction }
    },
    async getIssueComment(): Promise<unknown> {
      return (
        cfg.reactionCommentReturns ?? {
          id: 9101,
          reactions: {
            url: '', total_count: 1, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 1, rocket: 0, eyes: 0,
          },
        }
      )
    },
    async getReviewComment(): Promise<unknown> {
      return (
        cfg.reactionCommentReturns ?? {
          id: 8001,
          reactions: {
            url: '', total_count: 1, '+1': 1, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0,
          },
        }
      )
    },
    async setThreadResolution(threadId: string, resolved: boolean): Promise<GhReviewThreadNode> {
      spy.resolutionsRun.push({ threadId, resolved })
      return (
        cfg.resolveReturns ?? {
          id: threadId,
          isResolved: resolved,
          isOutdated: false,
          path: 'a.ts',
          line: 3,
          originalLine: 3,
          startLine: null,
          originalStartLine: null,
          diffSide: 'RIGHT',
          startDiffSide: null,
          subjectType: 'LINE',
          resolvedBy: resolved ? { login: SESSION.viewerLogin ?? '' } : null,
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        }
      )
    },
  }
  return { client, spy }
}

function memStore(): DirectStore {
  return openDirectStore({ dataDir: ':memory:' })
}

function seedDraft(store: DirectStore, headSha: string, comments: ReviewDraft['comments']): ReviewDraft {
  const draft: ReviewDraft = {
    humanId: SESSION.human.id,
    prNumber: 1,
    headSha,
    compareKey: `base1...${headSha}`,
    body: 'the review body',
    event: 'COMMENT',
    comments,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  store.putDraft(draft)
  return draft
}

function comment(over: Partial<ReviewDraft['comments'][number]>): ReviewDraft['comments'][number] {
  return {
    key: 'k1',
    path: 'a.ts',
    side: 'RIGHT',
    start_side: null,
    line: 10,
    start_line: null,
    body: 'inline note',
    createdAt: '',
    updatedAt: '',
    anchor: { lineText: '', contextBefore: [], contextAfter: [] },
    ...over,
  }
}

function deps(client: GithubClient, store: DirectStore, decorator?: WriteDecorator) {
  return {
    github: client,
    repo: REPO,
    store,
    session: SESSION,
    writeDecorator: decorator ?? createDirectWriteDecorator(SESSION.human),
  }
}

function input(over: Partial<SubmitReviewInput> = {}): SubmitReviewInput {
  return {
    prNumber: 1,
    expectedHeadSha: 'head1',
    event: 'COMMENT',
    body: 'the review body',
    comments: [],
    ...over,
  }
}

describe('submitReview — head guard', () => {
  test('a head mismatch returns head_moved as a VALUE and posts NOTHING', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { client, spy } = fakeClient({ headSha: 'head2', authorLogin: 'someone', commitCount: 4 })
    const result = await submitReview(deps(client, store), input({ expectedHeadSha: 'head1' }))

    expect(result.status).toBe('head_moved')
    if (result.status === 'head_moved') {
      expect(result.currentHeadSha).toBe('head2')
    }
    // Nothing was posted and no review list was even consulted.
    expect(spy.reviewsPosted).toHaveLength(0)
    expect(spy.reviewListReads).toBe(0)
    // The draft SURVIVES the head move.
    expect(store.getDraft(SESSION.human.id, 1)).not.toBeNull()
  })

  test('newCommits is the non-negative delta over the snapshot commit count', async () => {
    const store = memStore()
    const { client } = fakeClient({ headSha: 'head2', authorLogin: 'someone', commitCount: 5 })
    // No snapshot present → prior count 0 → delta clamps to the current count.
    const result = await submitReview(deps(client, store), input({ expectedHeadSha: 'head1' }))
    expect(result.status).toBe('head_moved')
    if (result.status === 'head_moved') expect(result.newCommits).toBe(5)
  })
})

describe('submitReview — post + 1:1 mapping', () => {
  test('a matching head posts one review; a multi-line comment sends start_line/start_side', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [
      comment({ key: 'multi', line: 20, start_line: 15, start_side: 'RIGHT', body: 'ranged' }),
    ])
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const result = await submitReview(
      deps(client, store),
      input({ comments: [comment({ key: 'multi', line: 20, start_line: 15, start_side: 'RIGHT', body: 'ranged' })] }),
    )

    expect(result.status).toBe('ok')
    expect(spy.reviewsPosted).toHaveLength(1)
    const posted = spy.reviewsPosted[0]
    expect(posted.commit_id).toBe('head1')
    expect(posted.event).toBe('COMMENT')
    const c: ReviewCommentInput = posted.comments[0]
    expect(c.line).toBe(20)
    expect(c.start_line).toBe(15)
    expect(c.start_side).toBe('RIGHT')
  })

  test('a single-line comment OMITS start_line/start_side entirely', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    await submitReview(
      deps(client, store),
      input({ comments: [comment({ line: 10, start_line: null, start_side: null })] }),
    )
    const c: ReviewCommentInput = spy.reviewsPosted[0].comments[0]
    expect(c.line).toBe(10)
    expect('start_line' in c).toBe(false)
    expect('start_side' in c).toBe(false)
  })

  test('direct mode posts bodies verbatim — no smuggled prefix, no email', async () => {
    const store = memStore()
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    await submitReview(
      deps(client, store),
      input({ body: 'review text', comments: [comment({ body: 'inline text' })] }),
    )
    const posted = spy.reviewsPosted[0]
    expect(posted.body).toBe('review text')
    expect(posted.comments[0].body).toBe('inline text')
    expect(JSON.stringify(posted)).not.toContain('alice@x.io')
    expect(posted.body).not.toContain('**Alice**')
  })
})

describe('submitReview — draft survival', () => {
  test('the draft is deleted ONLY after a confirmed successful review', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { client } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    expect(store.getDraft(SESSION.human.id, 1)).not.toBeNull()
    const result = await submitReview(deps(client, store), input())
    expect(result.status).toBe('ok')
    expect(store.getDraft(SESSION.human.id, 1)).toBeNull()
  })

  test('a 422 surfaces as conflict and the draft is RETAINED', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [comment({})])
    const { client } = fakeClient({ headSha: 'head1', authorLogin: 'someone', submitThrowsStatus: 422 })
    let thrown: unknown
    try {
      await submitReview(deps(client, store), input({ comments: [comment({})] }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('conflict')
    // The draft SURVIVES a validation failure — the whole invariant.
    expect(store.getDraft(SESSION.human.id, 1)).not.toBeNull()
  })

  test('a non-422 GitHub error propagates and the draft is retained', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { client } = fakeClient({ headSha: 'head1', authorLogin: 'someone', submitThrowsStatus: 500 })
    await expect(submitReview(deps(client, store), input())).rejects.toBeInstanceOf(GithubRequestError)
    expect(store.getDraft(SESSION.human.id, 1)).not.toBeNull()
  })
})

describe('submitReview — idempotent retry', () => {
  test('a retry short-circuits to an already-created matching review — no double-post', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    // GitHub already has the review this submit would create (the first response
    // was lost). Same viewer, commit, verdict, body.
    const { client, spy } = fakeClient({
      headSha: 'head1',
      authorLogin: 'someone',
      existingReviews: [
        { id: 4242, login: 'alice-gh', commit_id: 'head1', state: 'COMMENTED', body: 'the review body' },
      ],
    })
    const result = await submitReview(deps(client, store), input({ body: 'the review body' }))

    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.review.id).toBe(4242)
    // The POST was NOT made a second time.
    expect(spy.reviewsPosted).toHaveLength(0)
    // The review landed, so the draft is gone.
    expect(store.getDraft(SESSION.human.id, 1)).toBeNull()
  })

  test('a same-key review with DIFFERENT comments must not steal a new submit', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [comment({ body: 'new note', line: 10 })])
    // An EARLIER, unrelated review shares the whole review-level key — same
    // viewer, same commit, COMMENTED, and the same (empty) summary body — the
    // common shape when a reviewer submits inline-comments-only reviews twice at
    // one head. Only its inline comments differ. Short-circuiting to it would
    // silently swallow the new comments and delete the new draft.
    const { client, spy } = fakeClient({
      headSha: 'head1',
      authorLogin: 'someone',
      existingReviews: [
        {
          id: 4242,
          login: 'alice-gh',
          commit_id: 'head1',
          state: 'COMMENTED',
          body: '',
          comments: [{ path: 'a.ts', line: 3, body: 'old note' }],
        },
      ],
    })
    const result = await submitReview(
      deps(client, store),
      input({ body: '', comments: [comment({ body: 'new note', line: 10 })] }),
    )
    expect(result.status).toBe('ok')
    // The new review WAS posted — the coincidental key match did not block it.
    expect(spy.reviewsPosted).toHaveLength(1)
    if (result.status === 'ok') expect(result.review.id).not.toBe(4242)
  })

  test('a true retry WITH comments short-circuits when the posted comments match', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [comment({})])
    // The first submit landed (review 4242 with exactly this inline comment) but
    // the response was lost; the retry must find it by comments too, not just by
    // the review-level key.
    const { client, spy } = fakeClient({
      headSha: 'head1',
      authorLogin: 'someone',
      existingReviews: [
        {
          id: 4242,
          login: 'alice-gh',
          commit_id: 'head1',
          state: 'COMMENTED',
          body: 'the review body',
          comments: [{ path: 'a.ts', side: 'RIGHT', line: 10, start_line: null, body: 'inline note' }],
        },
      ],
    })
    const result = await submitReview(
      deps(client, store),
      input({ body: 'the review body', comments: [comment({})] }),
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.review.id).toBe(4242)
    expect(spy.reviewsPosted).toHaveLength(0)
    expect(store.getDraft(SESSION.human.id, 1)).toBeNull()
  })

  test('a non-matching existing review does NOT block a genuine first post', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { client, spy } = fakeClient({
      headSha: 'head1',
      authorLogin: 'someone',
      // A different review (different body) must not be mistaken for this one.
      existingReviews: [
        { id: 1, login: 'alice-gh', commit_id: 'head1', state: 'COMMENTED', body: 'an unrelated older review' },
      ],
    })
    const result = await submitReview(deps(client, store), input({ body: 'the review body' }))
    expect(result.status).toBe('ok')
    expect(spy.reviewsPosted).toHaveLength(1)
  })
})

describe('submitReview — approve gating', () => {
  test('APPROVE on a self-authored PR returns forbidden (a value), draft kept', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    // The viewer authored the PR → cannot approve their own.
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'alice-gh' })
    const result = await submitReview(deps(client, store), input({ event: 'APPROVE' }))
    expect(result.status).toBe('forbidden')
    expect(spy.reviewsPosted).toHaveLength(0)
    expect(store.getDraft(SESSION.human.id, 1)).not.toBeNull()
  })

  test('APPROVE on someone else’s PR is allowed and posts an APPROVE review', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'bob-gh' })
    const result = await submitReview(deps(client, store), input({ event: 'APPROVE', body: '' }))
    expect(result.status).toBe('ok')
    expect(spy.reviewsPosted[0].event).toBe('APPROVE')
  })
})

/** A recording decorator: passthrough bodies, every recordWrite captured with its meta. */
function recordingDecorator(): {
  decorator: WriteDecorator
  recorded: { id: number; endpoint: string; pr: number }[]
} {
  const recorded: { id: number; endpoint: string; pr: number }[] = []
  return {
    recorded,
    decorator: {
      decorateBody: (b) => b,
      recordWrite: (id, meta) => recorded.push({ id, endpoint: meta.endpoint, pr: meta.pr }),
    },
  }
}

describe('submitReview — WriteDecorator seam', () => {
  test('a stamping decorator stamps every body and records every created id + meta', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const recorded: { id: number; endpoint: string; pr: number }[] = []
    const stamping: WriteDecorator = {
      decorateBody: (b) => (b.length > 0 ? `**Alice** (contractor)\n\n${b}` : b),
      recordWrite: (id, meta) => recorded.push({ id, endpoint: meta.endpoint, pr: meta.pr }),
    }
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const result = await submitReview(
      deps(client, store, stamping),
      input({ body: 'review', comments: [comment({ body: 'inline' })] }),
    )
    expect(result.status).toBe('ok')
    expect(spy.reviewsPosted[0].body).toContain('**Alice** (contractor)')
    expect(spy.reviewsPosted[0].comments[0].body).toContain('**Alice** (contractor)')
    // The created review id was recorded with the endpoint + PR the audit row carries.
    if (result.status === 'ok') {
      expect(recorded).toEqual([{ id: result.review.id, endpoint: 'submitReview', pr: 1 }])
    }
  })

  test('the idempotent short-circuit records the already-landed review id too', async () => {
    const store = memStore()
    seedDraft(store, 'head1', [])
    const { decorator, recorded } = recordingDecorator()
    const { client } = fakeClient({
      headSha: 'head1',
      authorLogin: 'someone',
      existingReviews: [
        { id: 4242, login: 'alice-gh', commit_id: 'head1', state: 'COMMENTED', body: 'the review body' },
      ],
    })
    const result = await submitReview(
      deps(client, store, decorator),
      input({ body: 'the review body' }),
    )
    expect(result.status).toBe('ok')
    // The review landed on the lost first attempt; the retry still journals it.
    expect(recorded).toEqual([{ id: 4242, endpoint: 'submitReview', pr: 1 }])
  })
})

describe('replyToThread', () => {
  test('replies to the thread’s FIRST comment id, returns the normalized comment', async () => {
    const store = memStore()
    // A snapshot whose thread carries two comments; the reply targets the first.
    const thread: ReviewThread = {
      id: 'PRRT_abc',
      isResolved: false,
      isOutdated: false,
      path: 'a.ts',
      line: 3,
      originalLine: 3,
      startLine: null,
      originalStartLine: null,
      diffSide: 'RIGHT',
      startDiffSide: null,
      subjectType: 'LINE',
      resolvedBy: null,
      comments: [
        { id: 111 } as ReviewComment,
        { id: 222 } as ReviewComment,
      ],
    }
    store.putSnapshot(snapshotWithThreads(thread))
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const out = await replyToThread(deps(client, store), 1, 'PRRT_abc', 'thanks')
    expect(spy.repliesPosted).toHaveLength(1)
    expect(spy.repliesPosted[0].commentId).toBe(111)
    expect(out.body).toBe('thanks')
    expect(out.in_reply_to_id).toBe(111)
  })

  test('a thread absent from the snapshot is a typed not_found', async () => {
    const store = memStore()
    const { client } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    let thrown: unknown
    try {
      await replyToThread(deps(client, store), 1, 'PRRT_missing', 'hi')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('not_found')
  })
})

describe('resolveThread', () => {
  test('runs the mutation and normalizes the mutated thread', async () => {
    const store = memStore()
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const out = await resolveThread(deps(client, store), 1, 'PRRT_abc', true)
    expect(spy.resolutionsRun).toEqual([{ threadId: 'PRRT_abc', resolved: true }])
    expect(out.id).toBe('PRRT_abc')
    expect(out.isResolved).toBe(true)
    expect(out.resolvedBy?.login).toBe('alice-gh')
  })

  test('unresolve runs the unresolve mutation', async () => {
    const store = memStore()
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const out = await resolveThread(deps(client, store), 1, 'PRRT_abc', false)
    expect(spy.resolutionsRun).toEqual([{ threadId: 'PRRT_abc', resolved: false }])
    expect(out.isResolved).toBe(false)
    expect(out.resolvedBy).toBeNull()
  })
})

describe('addReaction', () => {
  test('posts the reaction and reads the rollup back (shared-and-honest)', async () => {
    const store = memStore()
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const rollup = await addReaction(deps(client, store), 1, 8001, '+1' as ReactionKey)
    expect(spy.reactionsPosted).toEqual([{ commentId: 8001, reaction: '+1' }])
    // The rollup is the honest count read back from the comment, not a local bump.
    expect(rollup['+1']).toBe(1)
    expect(rollup.total_count).toBe(1)
  })

  test('a conversation (issue) comment routes to the ISSUE reaction endpoints', async () => {
    const store = memStore()
    // The snapshot carries comment 9101 among the conversation comments —
    // GitHub keeps those in a different id namespace than review comments, so
    // the pulls endpoints would 404 on it.
    store.putSnapshot(snapshotWithIssueComments({ id: 9101 } as IssueComment))
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    const rollup = await addReaction(deps(client, store), 1, 9101, 'heart' as ReactionKey)
    expect(spy.issueReactionsPosted).toEqual([{ commentId: 9101, reaction: 'heart' }])
    // The review-comment endpoints were never touched for an issue comment.
    expect(spy.reactionsPosted).toHaveLength(0)
    // The rollup is read back from the issue comment itself.
    expect(rollup.heart).toBe(1)
  })

  test('an id absent from the snapshot still uses the review-comment endpoints', async () => {
    const store = memStore()
    // A fresh reply's id is not in the snapshot yet (the snapshot re-syncs
    // later); the honest default is the review-comment namespace.
    store.putSnapshot(snapshotWithIssueComments({ id: 5555 } as IssueComment))
    const { client, spy } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    await addReaction(deps(client, store), 1, 8001, '+1' as ReactionKey)
    expect(spy.reactionsPosted).toEqual([{ commentId: 8001, reaction: '+1' }])
    expect(spy.issueReactionsPosted).toHaveLength(0)
  })
})

describe('every write operation records through the WriteDecorator', () => {
  test('replyToThread records the created comment id with endpoint + pr', async () => {
    const store = memStore()
    const thread: ReviewThread = {
      id: 'PRRT_abc',
      isResolved: false,
      isOutdated: false,
      path: 'a.ts',
      line: 3,
      originalLine: 3,
      startLine: null,
      originalStartLine: null,
      diffSide: 'RIGHT',
      startDiffSide: null,
      subjectType: 'LINE',
      resolvedBy: null,
      comments: [{ id: 111 } as ReviewComment],
    }
    store.putSnapshot(snapshotWithThreads(thread))
    const { decorator, recorded } = recordingDecorator()
    const { client } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    await replyToThread(deps(client, store, decorator), 1, 'PRRT_abc', 'thanks')
    expect(recorded).toEqual([{ id: 7001, endpoint: 'replyToThread', pr: 1 }])
  })

  test('resolveThread records the thread root comment id with endpoint + pr', async () => {
    const store = memStore()
    const { decorator, recorded } = recordingDecorator()
    const { client } = fakeClient({
      headSha: 'head1',
      authorLogin: 'someone',
      resolveReturns: {
        id: 'PRRT_abc',
        isResolved: true,
        isOutdated: false,
        path: 'a.ts',
        line: 3,
        originalLine: 3,
        startLine: null,
        originalStartLine: null,
        diffSide: 'RIGHT',
        startDiffSide: null,
        subjectType: 'LINE',
        resolvedBy: { login: 'alice-gh' },
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              // The GraphQL BigInt id arrives as a string; the normalizer coerces it.
              fullDatabaseId: '111',
              path: 'a.ts',
              diffHunk: '',
              line: 3,
              originalLine: 3,
              startLine: null,
              originalStartLine: null,
              subjectType: 'LINE',
              body: 'root note',
              createdAt: '',
              updatedAt: '',
              author: { login: 'bob-gh' },
              pullRequestReview: null,
              replyTo: null,
              commit: null,
              originalCommit: null,
              url: '',
            },
          ],
        },
      },
    })
    await resolveThread(deps(client, store, decorator), 1, 'PRRT_abc', true)
    expect(recorded).toEqual([{ id: 111, endpoint: 'resolveThread', pr: 1 }])
  })

  test('addReaction records the reacted-to comment id with endpoint + pr', async () => {
    const store = memStore()
    const { decorator, recorded } = recordingDecorator()
    const { client } = fakeClient({ headSha: 'head1', authorLogin: 'someone' })
    await addReaction(deps(client, store, decorator), 1, 8001, '+1' as ReactionKey)
    expect(recorded).toEqual([{ id: 8001, endpoint: 'addReaction', pr: 1 }])
  })
})

/** A minimal snapshot carrying the given threads, enough for the reply lookup. */
function snapshotWithThreads(...threads: ReviewThread[]) {
  return snapshotWith(threads, [])
}

/** A minimal snapshot carrying conversation comments, for reaction routing. */
function snapshotWithIssueComments(...issueComments: IssueComment[]) {
  return snapshotWith([], issueComments)
}

function snapshotWith(threads: ReviewThread[], issueComments: IssueComment[]) {
  return {
    prNumber: 1,
    syncedAt: '2026-01-01T00:00:00.000Z',
    partial: null,
    syncStats: null,
    immutable: {
      compareKey: 'base1...head1',
      mergeBaseSha: 'base1',
      headSha: 'head1',
      files: [],
      blobIndex: {},
      commits: [],
    },
    mutable: {
      fetchedAt: '2026-01-01T00:00:00.000Z',
      pull: {} as never,
      threads,
      issueComments,
      reviews: [],
      checks: [],
    },
  }
}

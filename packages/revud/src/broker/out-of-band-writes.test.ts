/**
 * The out-of-band write detector and its host-side reconcile, exercised with an
 * injected fake client and fake journal — no store file, no socket. The suite
 * pins the exit criterion: every bot-authored artifact the audit journal's
 * CREATING rows cannot account for is flagged; everything mediated,
 * member-authored, or merely deleted-after-journaling is not — and touch-only
 * journal rows (resolveThread, addReaction) never absolve anything.
 */
import { describe, expect, test } from 'bun:test'
import type { Page, PageParams } from '../direct/github-client'
import type {
  AuditJournalReader,
  JournaledIds,
  OutOfBandReadClient,
  PullArtifacts,
} from './out-of-band-writes'
import {
  detectOutOfBandWrites,
  reconcileOutOfBand,
  reconcilePullOutOfBand,
  splitJournaledIds,
} from './out-of-band-writes'

const BOT_LOGIN = 'revu-app[bot]'
const BOT = { login: BOT_LOGIN, id: 111, type: 'Bot' }
const OTHER_BOT = { login: 'other-app[bot]', id: 222, type: 'Bot' }
const MEMBER = { login: 'alice', id: 7, type: 'User' }

/** Raw REST-shaped fixtures — only the fields the reconcile maps. */
function ghReview(id: number, user: unknown): unknown {
  return { id, state: 'COMMENTED', user, body: 'r' }
}
function ghReviewComment(
  id: number,
  user: unknown,
  reviewId: number | null = null,
  timestamps?: { createdAt: string; updatedAt: string },
): unknown {
  return {
    id,
    body: 'c',
    user,
    pull_request_review_id: reviewId,
    ...(timestamps === undefined
      ? {}
      : { created_at: timestamps.createdAt, updated_at: timestamps.updatedAt }),
  }
}
function ghIssueComment(
  id: number,
  user: unknown,
  timestamps?: { createdAt: string; updatedAt: string },
): unknown {
  return {
    id,
    body: 'c',
    user,
    ...(timestamps === undefined
      ? {}
      : { created_at: timestamps.createdAt, updated_at: timestamps.updatedAt }),
  }
}

/** Pages served per list: index 0 is page 1; `hasNext` while later pages remain. */
interface FakeRemote {
  reviews: unknown[][]
  reviewComments: unknown[][]
  issueComments: unknown[][]
}

interface ListCalls {
  reviews: number
  reviewComments: number
  issueComments: number
}

function fakeReadClient(remote: FakeRemote): { client: OutOfBandReadClient; calls: ListCalls } {
  const calls: ListCalls = { reviews: 0, reviewComments: 0, issueComments: 0 }
  const page = (all: unknown[][], params: PageParams): Page<unknown> => {
    const idx = params.page - 1
    return { items: all[idx] ?? [], hasNext: idx < all.length - 1 }
  }
  const client: OutOfBandReadClient = {
    async getPullReviews(_o, _r, _n, params) {
      calls.reviews += 1
      return page(remote.reviews, params)
    },
    async getPullReviewComments(_o, _r, _n, params) {
      calls.reviewComments += 1
      return page(remote.reviewComments, params)
    },
    async getIssueComments(_o, _r, _n, params) {
      calls.issueComments += 1
      return page(remote.issueComments, params)
    },
  }
  return { client, calls }
}

/** A journal fake over an in-memory row list, honoring the `pr` filter. */
function fakeJournal(
  rows: { githubId: number; endpoint: string; pr: number; createdAt?: string }[],
): AuditJournalReader {
  return {
    listAudit(filter = {}) {
      return rows.filter((r) => filter.pr === undefined || r.pr === filter.pr)
    },
  }
}

const REPO = { owner: 'o', repo: 'r' }
const PR = 5

function emptyArtifacts(): PullArtifacts {
  return { reviews: [], reviewComments: [], issueComments: [] }
}

/** Build a JournaledIds literal for the pure detector; unspecified sets are empty. */
function journaled(
  parts: { reviews?: number[]; created?: number[]; touched?: number[] } = {},
): JournaledIds {
  return {
    reviewIds: new Set(parts.reviews ?? []),
    createdCommentIds: new Set(parts.created ?? []),
    touchedIds: new Set(parts.touched ?? []),
  }
}

describe('splitJournaledIds (the id-space and provenance discriminator)', () => {
  test('routes submitReview to the review space, replyToThread to created comments, and touch/unknown endpoints to touched', () => {
    const split = splitJournaledIds([
      { githubId: 10, endpoint: 'submitReview', createdAt: '2026-07-01T10:00:00Z' },
      { githubId: 20, endpoint: 'replyToThread', createdAt: '2026-07-01T11:00:00Z' },
      { githubId: 30, endpoint: 'resolveThread' },
      { githubId: 40, endpoint: 'addReaction' },
      // An endpoint unknown to the split rule must land with the touch rows,
      // where it can only widen the informational report — never absolve.
      { githubId: 50, endpoint: 'someFutureEndpoint' },
    ])
    expect([...split.reviewIds]).toEqual([10])
    expect([...split.createdCommentIds]).toEqual([20])
    expect([...split.touchedIds].sort((a, b) => a - b)).toEqual([30, 40, 50])
    expect(split.reviewJournaledAt?.get(10)).toBe('2026-07-01T10:00:00Z')
    expect(split.createdCommentJournaledAt?.get(20)).toBe('2026-07-01T11:00:00Z')
  })
})

describe('detectOutOfBandWrites (pure)', () => {
  test('a bot issue comment is out-of-band by construction — even when its id sits in the touched journal set', () => {
    // revu can journal an issue comment's id via addReaction (it reacted TO the
    // comment); the reaction being mediated must not absolve the comment itself.
    const report = detectOutOfBandWrites(
      journaled({ touched: [900] }),
      {
        ...emptyArtifacts(),
        issueComments: [{ id: 900, author: { login: BOT_LOGIN, type: 'Bot' } }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([
      { kind: 'issue_comment', id: 900, authorLogin: BOT_LOGIN },
    ])
  })

  test('a review comment is absolved by its own replyToThread id or its parent review journaled by submitReview', () => {
    const report = detectOutOfBandWrites(
      journaled({ reviews: [70], created: [71] }),
      {
        ...emptyArtifacts(),
        reviews: [{ id: 70, author: { login: BOT_LOGIN, type: 'Bot' } }],
        reviewComments: [
          // Created inline by the mediated review 70 (only the review id is journaled).
          { id: 700, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: 70 },
          // A mediated reply, journaled by its own comment id.
          { id: 71, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: null },
          // Neither: an out-of-band comment (its implicit parent review 99 was never journaled).
          { id: 72, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: 99 },
        ],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([
      { kind: 'review_comment', id: 72, authorLogin: BOT_LOGIN },
    ])
  })

  test('a touched id (resolveThread/addReaction provenance) never absolves a review comment', () => {
    // The laundering attempt in miniature: the out-of-band comment's id IS in
    // the journal — but only because revu touched it, not because revu made it.
    const report = detectOutOfBandWrites(
      journaled({ touched: [800] }),
      {
        ...emptyArtifacts(),
        reviewComments: [{ id: 800, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: null }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([
      { kind: 'review_comment', id: 800, authorLogin: BOT_LOGIN },
    ])
  })

  test('a review named as parent by a replyToThread-created comment is absolved (the implicit COMMENTED wrapper)', () => {
    const report = detectOutOfBandWrites(
      journaled({ created: [71] }),
      {
        ...emptyArtifacts(),
        // GitHub minted review 4444 to wrap the mediated reply 71; revu never
        // saw 4444's id, so only the reverse linkage can account for it.
        reviews: [{ id: 4444, author: { login: BOT_LOGIN, type: 'Bot' } }],
        reviewComments: [{ id: 71, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: 4444 }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([])
  })

  test('a touched comment id does not vouch for its parent review', () => {
    // Mirror of the wrapper absolution: the linkage must require CREATED
    // provenance. A reacted-to out-of-band comment names its implicit review,
    // but neither the comment nor the review is thereby mediated.
    const report = detectOutOfBandWrites(
      journaled({ touched: [801] }),
      {
        ...emptyArtifacts(),
        reviews: [{ id: 5555, author: { login: BOT_LOGIN, type: 'Bot' } }],
        reviewComments: [{ id: 801, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: 5555 }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([
      { kind: 'review', id: 5555, authorLogin: BOT_LOGIN },
      { kind: 'review_comment', id: 801, authorLogin: BOT_LOGIN },
    ])
  })

  test('non-bot artifacts are ignored entirely, journaled or not', () => {
    const report = detectOutOfBandWrites(
      journaled(),
      {
        reviews: [{ id: 1, author: { login: 'alice', type: 'User' } }],
        reviewComments: [
          { id: 2, author: { login: 'acme', type: 'Organization' }, reviewId: null },
          { id: 3, author: null, reviewId: null },
        ],
        issueComments: [{ id: 4, author: { login: 'alice', type: 'User' } }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([])
  })

  test('the required botLogin narrows bot-authorship: another App\'s bot is not this journal\'s concern', () => {
    const report = detectOutOfBandWrites(
      journaled(),
      {
        ...emptyArtifacts(),
        issueComments: [{ id: 5, author: { login: 'other-app[bot]', type: 'Bot' } }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([])
  })

  test('an id-space collision cannot mask a violation: a journaled review id does not absolve a comment with the same number, nor vice versa', () => {
    // submitReview journaled review 777; a bot review COMMENT also numbered 777
    // (a different id-space) was posted out-of-band. Pooling the journal into
    // one set would absolve it; the split must not.
    const first = detectOutOfBandWrites(
      journaled({ reviews: [777] }),
      {
        ...emptyArtifacts(),
        reviews: [{ id: 777, author: { login: BOT_LOGIN, type: 'Bot' } }],
        reviewComments: [{ id: 777, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: null }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(first.outOfBand).toEqual([
      { kind: 'review_comment', id: 777, authorLogin: BOT_LOGIN },
    ])

    // The mirror image: replyToThread journaled comment 555; a bot REVIEW also
    // numbered 555 was posted out-of-band and must still be flagged. (The
    // created reply carries no parent linkage here, so the wrapper absolution
    // does not apply — only the raw id collision is in play.)
    const second = detectOutOfBandWrites(
      journaled({ created: [555] }),
      {
        ...emptyArtifacts(),
        reviews: [{ id: 555, author: { login: BOT_LOGIN, type: 'Bot' } }],
        reviewComments: [{ id: 555, author: { login: BOT_LOGIN, type: 'Bot' }, reviewId: null }],
      },
      { botLogin: BOT_LOGIN },
    )
    expect(second.outOfBand).toEqual([{ kind: 'review', id: 555, authorLogin: BOT_LOGIN }])
  })

  test('a journaled id absent from GitHub is informational (unmatched), never a violation — created and touched alike', () => {
    const report = detectOutOfBandWrites(
      { ...journaled({ reviews: [100], created: [200], touched: [200, 300] }) },
      emptyArtifacts(),
      { botLogin: BOT_LOGIN },
    )
    expect(report.outOfBand).toEqual([])
    // 200 sits in both comment-provenance sets (revu created it, then reacted
    // to it) yet reports once: the unmatched check measures presence, not
    // provenance.
    expect(report.unmatchedJournal).toEqual([
      { idSpace: 'review', githubId: 100 },
      { idSpace: 'comment', githubId: 200 },
      { idSpace: 'comment', githubId: 300 },
    ])
  })

  test('the edit signal honors the journal write instant: an edit at or before it is suppressed, a later one reported', () => {
    const artifactsUpdatedAt = (updatedAt: string): PullArtifacts => ({
      ...emptyArtifacts(),
      reviewComments: [
        {
          id: 71,
          author: { login: BOT_LOGIN, type: 'Bot' },
          reviewId: null,
          createdAt: '2026-07-01T10:00:00Z',
          updatedAt,
        },
      ],
    })
    const withInstant: JournaledIds = {
      ...journaled({ created: [71] }),
      createdCommentJournaledAt: new Map([[71, '2026-07-01T10:00:10Z']]),
    }
    // updated_at moved past created_at but not past the journal row's write
    // instant — the "edit" predates mediation, so no signal.
    const suppressed = detectOutOfBandWrites(
      withInstant,
      artifactsUpdatedAt('2026-07-01T10:00:05Z'),
      { botLogin: BOT_LOGIN },
    )
    expect(suppressed.outOfBand).toEqual([])
    expect(suppressed.editedAfterMediation).toEqual([])

    const reported = detectOutOfBandWrites(
      withInstant,
      artifactsUpdatedAt('2026-07-01T10:30:00Z'),
      { botLogin: BOT_LOGIN },
    )
    expect(reported.outOfBand).toEqual([])
    expect(reported.editedAfterMediation).toEqual([
      {
        kind: 'review_comment',
        id: 71,
        authorLogin: BOT_LOGIN,
        createdAt: '2026-07-01T10:00:00Z',
        updatedAt: '2026-07-01T10:30:00Z',
      },
    ])
  })
})

describe('reconcilePullOutOfBand (host-side, injected client + journal)', () => {
  test('flags a bot issue comment no journal row accounts for (the gh-pr-comment bypass)', async () => {
    const { client } = fakeReadClient({
      reviews: [[]],
      reviewComments: [[]],
      issueComments: [[ghIssueComment(9001, BOT), ghIssueComment(9002, MEMBER)]],
    })
    const report = await reconcilePullOutOfBand(
      { github: client, journal: fakeJournal([]), repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.pr).toBe(PR)
    expect(report.outOfBand).toEqual([
      { kind: 'issue_comment', id: 9001, authorLogin: BOT_LOGIN },
    ])
  })

  test('flags a bot review comment posted directly (absent from the journal)', async () => {
    const { client } = fakeReadClient({
      reviews: [[]],
      // A direct POST /pulls/{n}/comments — its implicit parent review was never journaled.
      reviewComments: [[ghReviewComment(8001, BOT, 4444)]],
      issueComments: [[]],
    })
    const report = await reconcilePullOutOfBand(
      { github: client, journal: fakeJournal([]), repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([
      { kind: 'review_comment', id: 8001, authorLogin: BOT_LOGIN },
    ])
  })

  test('a bot review comment revu only REACTED to is still flagged — the addReaction row cannot launder it', async () => {
    // The full laundering attempt: an out-of-band bot review comment (and the
    // implicit review GitHub minted around it), followed by a MEDIATED
    // reaction to that comment. The reaction's journal row holds the comment's
    // id with touch provenance, so both artifacts stay flagged.
    const { client } = fakeReadClient({
      reviews: [[ghReview(4444, BOT)]],
      reviewComments: [[ghReviewComment(8001, BOT, 4444)]],
      issueComments: [[]],
    })
    const journal = fakeJournal([{ githubId: 8001, endpoint: 'addReaction', pr: PR }])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([
      { kind: 'review', id: 4444, authorLogin: BOT_LOGIN },
      { kind: 'review_comment', id: 8001, authorLogin: BOT_LOGIN },
    ])
    // The touch row is accounted for by the comment's presence on GitHub.
    expect(report.unmatchedJournal).toEqual([])
  })

  test('a bot review comment whose thread revu RESOLVED is still flagged — the resolveThread row cannot launder it', async () => {
    const { client } = fakeReadClient({
      reviews: [[]],
      reviewComments: [[ghReviewComment(8002, BOT, 4445)]],
      issueComments: [[]],
    })
    const journal = fakeJournal([{ githubId: 8002, endpoint: 'resolveThread', pr: PR }])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([
      { kind: 'review_comment', id: 8002, authorLogin: BOT_LOGIN },
    ])
  })

  test('the implicit COMMENTED review GitHub mints around a mediated reply is absolved, and the reply stays absolved', async () => {
    // GitHub wraps every standalone reply in an implicit COMMENTED review that
    // shows up in the reviews list under the bot's authorship. The mediated
    // reply's journal row vouches for its wrapper — no finding for either.
    const { client } = fakeReadClient({
      reviews: [[ghReview(4444, BOT)]],
      reviewComments: [[ghReviewComment(71, BOT, 4444)]],
      issueComments: [[]],
    })
    const journal = fakeJournal([{ githubId: 71, endpoint: 'replyToThread', pr: PR }])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([])
    expect(report.unmatchedJournal).toEqual([])
  })

  test('journaled mediated writes present on GitHub produce no findings — equal timestamps raise no edit signal', async () => {
    const at = { createdAt: '2026-07-01T10:00:00Z', updatedAt: '2026-07-01T10:00:00Z' }
    const { client } = fakeReadClient({
      reviews: [[ghReview(70, BOT)]],
      reviewComments: [
        [
          ghReviewComment(700, BOT, 70, at), // inline comment of the journaled review
          ghReviewComment(71, BOT, null, at), // journaled reply
        ],
      ],
      issueComments: [[]],
    })
    const journal = fakeJournal([
      { githubId: 70, endpoint: 'submitReview', pr: PR },
      { githubId: 71, endpoint: 'replyToThread', pr: PR },
    ])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([])
    expect(report.unmatchedJournal).toEqual([])
    expect(report.editedAfterMediation).toEqual([])
  })

  test('a mediated reply later edited on GitHub surfaces as informational editedAfterMediation, not a violation', async () => {
    const { client } = fakeReadClient({
      reviews: [[ghReview(4444, BOT)]],
      reviewComments: [
        [
          ghReviewComment(71, BOT, 4444, {
            createdAt: '2026-07-01T10:00:00Z',
            updatedAt: '2026-07-02T09:00:00Z',
          }),
        ],
      ],
      issueComments: [[]],
    })
    const journal = fakeJournal([
      { githubId: 71, endpoint: 'replyToThread', pr: PR, createdAt: '2026-07-01T10:00:01Z' },
    ])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([])
    expect(report.editedAfterMediation).toEqual([
      {
        kind: 'review_comment',
        id: 71,
        authorLogin: BOT_LOGIN,
        createdAt: '2026-07-01T10:00:00Z',
        updatedAt: '2026-07-02T09:00:00Z',
      },
    ])
  })

  test('org-member artifacts are ignored even with an empty journal', async () => {
    const { client } = fakeReadClient({
      reviews: [[ghReview(1, MEMBER)]],
      reviewComments: [[ghReviewComment(2, MEMBER, 1)]],
      issueComments: [[ghIssueComment(3, MEMBER)]],
    })
    const report = await reconcilePullOutOfBand(
      { github: client, journal: fakeJournal([]), repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([])
  })

  test('a journaled id no longer on GitHub reconciles as unmatched, not out-of-band', async () => {
    const { client } = fakeReadClient({
      reviews: [[]],
      reviewComments: [[]],
      issueComments: [[]],
    })
    const journal = fakeJournal([
      { githubId: 300, endpoint: 'submitReview', pr: PR },
      { githubId: 301, endpoint: 'resolveThread', pr: PR },
    ])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([])
    expect(report.unmatchedJournal).toEqual([
      { idSpace: 'review', githubId: 300 },
      { idSpace: 'comment', githubId: 301 },
    ])
  })

  test('pagination: bot artifacts across multiple pages are all reconciled, none truncated', async () => {
    const { client, calls } = fakeReadClient({
      reviews: [[ghReview(10, MEMBER)], [ghReview(11, BOT)]],
      reviewComments: [[ghReviewComment(20, MEMBER, 10)], [ghReviewComment(21, BOT, null)]],
      issueComments: [[ghIssueComment(30, MEMBER)], [ghIssueComment(31, BOT)]],
    })
    const report = await reconcilePullOutOfBand(
      { github: client, journal: fakeJournal([]), repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    // Every list was drained past its first page.
    expect(calls).toEqual({ reviews: 2, reviewComments: 2, issueComments: 2 })
    expect(report.outOfBand).toEqual([
      { kind: 'review', id: 11, authorLogin: BOT_LOGIN },
      { kind: 'review_comment', id: 21, authorLogin: BOT_LOGIN },
      { kind: 'issue_comment', id: 31, authorLogin: BOT_LOGIN },
    ])
  })

  test('only the target PR\'s journal rows participate: a row on another PR absolves nothing', async () => {
    const { client } = fakeReadClient({
      reviews: [[ghReview(70, BOT)]],
      reviewComments: [[]],
      issueComments: [[]],
    })
    // Review 70 was journaled — but against a DIFFERENT pull request.
    const journal = fakeJournal([{ githubId: 70, endpoint: 'submitReview', pr: 6 }])
    const report = await reconcilePullOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([{ kind: 'review', id: 70, authorLogin: BOT_LOGIN }])
  })

  test('a malformed list item without a numeric id is skipped, the rest still reconcile', async () => {
    const { client } = fakeReadClient({
      reviews: [[]],
      reviewComments: [[]],
      issueComments: [[{ body: 'no id' }, null, ghIssueComment(40, BOT)]],
    })
    const report = await reconcilePullOutOfBand(
      { github: client, journal: fakeJournal([]), repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([
      { kind: 'issue_comment', id: 40, authorLogin: BOT_LOGIN },
    ])
  })

  test('another Bot-typed author is not flagged: botLogin scopes the reconcile to this deployment\'s App', async () => {
    const { client } = fakeReadClient({
      reviews: [[]],
      reviewComments: [[]],
      issueComments: [[ghIssueComment(50, OTHER_BOT)]],
    })
    const report = await reconcilePullOutOfBand(
      { github: client, journal: fakeJournal([]), repo: REPO, botLogin: BOT_LOGIN },
      PR,
    )
    expect(report.outOfBand).toEqual([])
  })
})

describe('reconcileOutOfBand (a set of PRs)', () => {
  test('returns one report per PR, each reconciled against its own journal rows', async () => {
    const { client } = fakeReadClient({
      reviews: [[ghReview(70, BOT)]],
      reviewComments: [[]],
      issueComments: [[]],
    })
    // The same remote answers both PRs; only PR 5 journaled review 70.
    const journal = fakeJournal([{ githubId: 70, endpoint: 'submitReview', pr: 5 }])
    const reports = await reconcileOutOfBand(
      { github: client, journal, repo: REPO, botLogin: BOT_LOGIN },
      [5, 6],
    )
    expect(reports.map((r) => r.pr)).toEqual([5, 6])
    expect(reports[0].outOfBand).toEqual([])
    expect(reports[1].outOfBand).toEqual([{ kind: 'review', id: 70, authorLogin: BOT_LOGIN }])
  })
})

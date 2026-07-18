/**
 * Contract-conformance for BROKER WRITES — the write path a broker serves once
 * the deployment configures the bot identity (`REVU_BOT_LOGIN`): the session
 * self-identifies as the GitHub App's bot login (`brokerLogin` = `viewerLogin`
 * = the bot), every posted body carries the human's stamped `**name** (role)`
 * prefix, and every confirmed write lands one append-only `audit_log` row keyed
 * to the human's id. The fake GitHub remote attributes every review it accepts
 * to that bot login — exactly the attribution a real installation token
 * produces — and, as in the broker read suite, every call first resolves a
 * token through the injected file-credential source, so writes are proven
 * through the broker's actual credential-custody path.
 *
 * What this suite pins:
 *   - the stamped prefix round-trips: the posted body parses back to the human
 *     via the shared parser, and the git-config email NEVER appears in any
 *     posted body (it is a local journal key only);
 *   - submit idempotency BY SELF: a retry whose first response was lost finds
 *     the bot's OWN prior review on GitHub and short-circuits — no double-post;
 *   - the approve gate self-identifies as the bot: APPROVE on a bot-authored PR
 *     is `forbidden` as a 200 VALUE (draft kept, nothing posted), APPROVE on an
 *     org-member-authored PR posts;
 *   - a confirmed submit journals an audit row — github id, human id,
 *     workspace, endpoint, pr, timestamp — readable via `listAudit`, and a
 *     landed-review retry journals again (the journal covers every write that
 *     reached GitHub);
 *   - a mediated reply posts the stamped prefix to the thread's root comment,
 *     round-trips through the shared parser with no email in the body, and
 *     journals its own audit row;
 *   - a broker WITHOUT the bot identity answers 501 on ALL FOUR write routes:
 *     boot injects no broker decorator, so the api lacks the broker write
 *     capability the router gates on — the write path never runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PendingComment,
  ReviewComment,
  Session,
  Snapshot,
  SubmitReviewInput,
} from '@revu/shared'
import { parseCommentIdentity, parsePrefixedBody, prefixBody } from '@revu/shared'
import { createFileCredentialTokenSource } from '../broker/token-source'
import { handleDirectApi } from '../direct-router'
import type { CommandResult, CommandRunner } from './command-runner'
import { CONFORMANCE_REPO, tokenGated } from './conformance-fakes'
import { createDirectApi, type DirectApi } from './direct-api'
import type { GithubClient, Page, SubmitReviewBody } from './github-client'
import { throwingGithubClient } from './github-write-stubs'
import { buildBrokerSession } from './session'
import { openDirectStore, type DirectStore } from './store'
import { createBrokerWriteDecorator } from './write-decorator'

/** The bot login this deployment's GitHub App posts as — injected, never hardcoded in the engine. */
const BOT_LOGIN = 'revu-conformance[bot]'
/** The pull request every write scenario targets. */
const WRITE_PR = 42
/** The current head SHA the fake remote reports (submits pass the head guard). */
const HEAD = 'HEAD-W1'
/** Deterministic timestamp injected into the broker decorator's audit rows. */
const NOW = '2026-07-18T12:00:00.000Z'
/** The human's git-config identity; the mixed-case email proves the id lowercases. */
const HUMAN_NAME = 'Alice Nguyen'
const HUMAN_EMAIL = 'Alice.Nguyen@Contractor.CO'
const HUMAN_ID = 'alice.nguyen@contractor.co'

/** A CommandRunner answering `git config <key>` from a map; anything else fails. */
function gitConfigRunner(config: Record<string, string>): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      if (args[0] === 'git' && args[1] === 'config') {
        const value = config[args[2]]
        if (value !== undefined) return { ok: true, code: 0, stdout: `${value}\n`, stderr: '' }
        return { ok: false, code: 1, stdout: '', stderr: '' }
      }
      return { ok: false, code: 127, stdout: '', stderr: 'unexpected command' }
    },
  }
}

/** Build a broker session through the REAL builder, with or without the bot identity. */
async function brokerSession(env: Record<string, string | undefined>): Promise<Session> {
  return buildBrokerSession({
    runner: gitConfigRunner({ 'user.name': HUMAN_NAME, 'user.email': HUMAN_EMAIL }),
    repo: CONFORMANCE_REPO,
    env,
  })
}

/** One accepted review as the fake remote keeps it: the raw review + its as-posted comments. */
interface PostedReview {
  id: number
  raw: Record<string, unknown>
  comments: Record<string, unknown>[]
}

/** The fake remote's mutable state, inspected by assertions after each request. */
interface WriteRemoteState {
  headSha: string
  /** The login `GET /pulls/{n}` reports as the PR author — drives the approve gate. */
  authorLogin: string
  /** Reviews on the PR; grows on every accepted POST, re-served to the idempotency re-check. */
  reviews: PostedReview[]
  /** How many times `POST /pulls/{n}/reviews` actually ran — the double-post detector. */
  postCount: number
  /** Thread replies the remote accepted: which comment each targeted, and the raw as stored. */
  replies: { commentId: number; raw: Record<string, unknown> }[]
}

function initialWriteState(authorLogin: string): WriteRemoteState {
  return { headSha: HEAD, authorLogin, reviews: [], postCount: 0, replies: [] }
}

/** GitHub's review state string for each submit event, as the fake reports it back. */
const REVIEW_STATE: Record<SubmitReviewBody['event'], string> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
}

/** One-page helper: page 1 carries the items, every later page is empty. */
function onePage<T>(items: T[], page: number): Page<T> {
  return page === 1 ? { items, hasNext: false } : { items: [], hasNext: false }
}

/**
 * A fake GitHub remote for the write path. Every review it accepts is authored
 * by the configured bot login — the attribution a real GitHub App installation
 * token produces — and re-served by `getPullReviews`/`getReviewComments` in the
 * as-posted shape (`original_line`/`original_start_line`), so a retried submit
 * sees its own prior review exactly as the live API would show it. Unstubbed
 * methods throw: a write scenario must not wander into the read surface.
 */
function brokerWriteRemote(state: WriteRemoteState): GithubClient {
  let nextReviewId = 500
  return {
    ...throwingGithubClient(),
    async getPullDetail() {
      return {
        number: WRITE_PR,
        state: 'open',
        user: {
          login: state.authorLogin,
          id: 2,
          type: state.authorLogin === BOT_LOGIN ? 'Bot' : 'User',
        },
        head: { sha: state.headSha },
        base: { sha: 'BRANCH' },
        commits: 2,
      }
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      return onePage(
        state.reviews.map((r) => r.raw),
        params.page,
      )
    },
    async getReviewComments(_o, _r, _n, reviewId, params): Promise<Page<unknown>> {
      const review = state.reviews.find((r) => r.id === reviewId)
      return onePage(review?.comments ?? [], params.page)
    },
    async submitReview(_o, _r, _n, body: SubmitReviewBody): Promise<unknown> {
      state.postCount += 1
      const id = nextReviewId++
      const raw: Record<string, unknown> = {
        id,
        node_id: `PRR_${id}`,
        user: { login: BOT_LOGIN, id: 99, type: 'Bot' },
        body: body.body,
        state: REVIEW_STATE[body.event],
        submitted_at: NOW,
        commit_id: body.commit_id,
      }
      const comments = body.comments.map((c, i) => ({
        id: 9000 + i,
        path: c.path,
        side: c.side,
        original_line: c.line,
        original_start_line: c.start_line ?? null,
        body: c.body,
        user: { login: BOT_LOGIN, id: 99, type: 'Bot' },
      }))
      state.reviews.push({ id, raw, comments })
      return raw
    },
    async replyToReviewComment(_o, _r, _n, commentId, body): Promise<unknown> {
      // Like a real installation-token reply: the new comment is authored by
      // the bot and attached under the addressed root comment.
      const id = 7000 + state.replies.length
      const raw: Record<string, unknown> = {
        id,
        node_id: `RC_${id}`,
        in_reply_to_id: commentId,
        path: 'src/a.ts',
        side: 'RIGHT',
        line: 3,
        original_line: 3,
        body,
        user: { login: BOT_LOGIN, id: 99, type: 'Bot' },
      }
      state.replies.push({ commentId, raw })
      return raw
    },
  }
}

let dataDir: string
let credentialFile: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-broker-writes-'))
  credentialFile = join(dataDir, '.git-credentials')
  // The host has injected a (fake) token before the first request.
  writeFileSync(
    credentialFile,
    'https://x-access-token:ghs_broker_writes_fake@github.com\n',
    'utf8',
  )
})

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Assemble the write-enabled broker surface exactly as broker boot does: the
 * token-gated client (credential custody proven on every call), the on-disk
 * store, and the broker `WriteDecorator` (stamping + audit journal) with a
 * deterministic clock.
 */
function buildWriteApi(session: Session, client: GithubClient, store: DirectStore): DirectApi {
  return createDirectApi({
    session,
    github: tokenGated(client, createFileCredentialTokenSource({ path: credentialFile })),
    repo: CONFORMANCE_REPO,
    store,
    writeDecorator: createBrokerWriteDecorator(session, store, () => NOW),
  })
}

/** A single-line pending comment carrying `body`, valid under the shared validators. */
function pendingComment(body: string): PendingComment {
  return {
    key: 'k1',
    path: 'src/a.ts',
    side: 'RIGHT',
    start_side: null,
    line: 3,
    start_line: null,
    body,
    createdAt: NOW,
    updatedAt: NOW,
    anchor: { lineText: 'x', contextBefore: [], contextAfter: [] },
  }
}

function submitInput(overrides: Partial<SubmitReviewInput> = {}): SubmitReviewInput {
  return {
    prNumber: WRITE_PR,
    expectedHeadSha: HEAD,
    event: 'COMMENT',
    body: 'Overall solid; one nit inline.',
    comments: [pendingComment('Use a Map here instead of an object.')],
    ...overrides,
  }
}

/** POST the submit through the router in broker mode and return the response. */
async function postReview(
  session: Session,
  api: DirectApi,
  input: SubmitReviewInput,
): Promise<Response> {
  const req = new Request(`http://127.0.0.1/api/pulls/${WRITE_PR}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const res = await handleDirectApi(req, session, api, 'broker')
  expect(res).not.toBeNull()
  return res as Response
}

/**
 * A minimal cached snapshot for the write PR carrying one unresolved thread —
 * the reply path reads the thread's FIRST comment id from the snapshot (the
 * snapshot is the source of truth for a thread's shape), so a reply scenario
 * must seed one. Only the fields the reply lookup touches are honest.
 */
function threadSnapshot(threadId: string, rootCommentId: number): Snapshot {
  return {
    prNumber: WRITE_PR,
    syncedAt: NOW,
    partial: null,
    syncStats: null,
    immutable: {
      compareKey: `MB...${HEAD}`,
      mergeBaseSha: 'MB',
      headSha: HEAD,
      files: [],
      blobIndex: {},
      commits: [],
    },
    mutable: {
      fetchedAt: NOW,
      pull: {} as never,
      threads: [
        {
          id: threadId,
          isResolved: false,
          isOutdated: false,
          path: 'src/a.ts',
          line: 3,
          originalLine: 3,
          startLine: null,
          originalStartLine: null,
          diffSide: 'RIGHT',
          startDiffSide: null,
          subjectType: 'LINE',
          resolvedBy: null,
          comments: [{ id: rootCommentId } as ReviewComment],
        },
      ],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

/** Seed a draft for the write PR; the write path may delete it ONLY on a confirmed success. */
function seedDraft(store: DirectStore, humanId: string): void {
  store.putDraft({
    humanId,
    prNumber: WRITE_PR,
    headSha: HEAD,
    compareKey: `MB...${HEAD}`,
    body: 'draft body',
    event: 'COMMENT',
    comments: [],
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('RevuApi conformance — broker writes (bot identity configured)', () => {
  test('a mediated submit posts the stamped prefix, which round-trips to the human (no email in any body)', async () => {
    const session = await brokerSession({ REVU_BOT_LOGIN: BOT_LOGIN })
    expect(session.brokerLogin).toBe(BOT_LOGIN)
    expect(session.viewerLogin).toBe(BOT_LOGIN)

    const state = initialWriteState('org-member')
    const store = openDirectStore({ dataDir })
    const api = buildWriteApi(session, brokerWriteRemote(state), store)

    const input = submitInput()
    const res = await postReview(session, api, input)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; review: { id: number } }
    expect(body.status).toBe('ok')
    expect(state.postCount).toBe(1)

    // The posted review body carries the canonical stamped prefix…
    const posted = state.reviews[0]
    expect(posted.raw.body).toBe(prefixBody(session.human, input.body))
    // …which round-trips through the shared parser back to the human, prefix stripped.
    const parsed = parsePrefixedBody(posted.raw.body as string)
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe(HUMAN_NAME)
    expect(parsed!.role).toBe('contractor')
    expect(parsed!.rest).toBe(input.body)

    // A bot-authored comment routes into the prefix parser (brokerLogin = bot)
    // and renders as the human, not the bare bot.
    const rendered = parseCommentIdentity(
      {
        user: {
          login: BOT_LOGIN,
          id: 99,
          node_id: '',
          avatar_url: '',
          html_url: '',
          type: 'Bot',
        },
        body: posted.raw.body as string,
      },
      session.brokerLogin,
    )
    expect(rendered.identity).toEqual({ kind: 'human', name: HUMAN_NAME, role: 'contractor' })
    expect(rendered.body).toBe(input.body)

    // The inline comment is stamped identically…
    expect(posted.comments[0].body).toBe(prefixBody(session.human, input.comments[0].body))

    // …and the email NEVER enters any posted body: it is a local journal key only.
    for (const text of [posted.raw.body as string, posted.comments[0].body as string]) {
      expect(text.toLowerCase()).not.toContain(HUMAN_EMAIL.toLowerCase())
    }

    store.close()
  })

  test('a retried submit finds the bot-authored prior review and short-circuits — no double-post', async () => {
    const session = await brokerSession({ REVU_BOT_LOGIN: BOT_LOGIN })
    const state = initialWriteState('org-member')
    const store = openDirectStore({ dataDir })
    const api = buildWriteApi(session, brokerWriteRemote(state), store)
    seedDraft(store, session.human.id)

    const input = submitInput()
    const first = await postReview(session, api, input)
    const firstBody = (await first.json()) as { status: string; review: { id: number } }
    expect(firstBody.status).toBe('ok')
    expect(state.postCount).toBe(1)
    // Confirmed success is the ONLY thing that deletes the draft.
    expect(store.getDraft(session.human.id, WRITE_PR)).toBeNull()

    // The first response was "lost": the client still holds its draft and
    // retries the identical submit. The fake now serves the BOT-authored review
    // it accepted, and the idempotency re-check — self-identifying as the bot
    // via viewerLogin — recognizes it as this submit's own prior review.
    seedDraft(store, session.human.id)
    const retry = await postReview(session, api, input)
    const retryBody = (await retry.json()) as { status: string; review: { id: number } }
    expect(retryBody.status).toBe('ok')
    expect(retryBody.review.id).toBe(firstBody.review.id)
    // NOT posted again: the short-circuit fired.
    expect(state.postCount).toBe(1)
    // The review DID land, so the landed-review retry deletes the draft too.
    expect(store.getDraft(session.human.id, WRITE_PR)).toBeNull()

    store.close()
  })

  test('APPROVE on a PR the bot itself authored returns forbidden as a 200 VALUE and posts nothing', async () => {
    const session = await brokerSession({ REVU_BOT_LOGIN: BOT_LOGIN })
    // The PR author IS the bot: with viewerLogin = bot, the approve gate must
    // reject self-review exactly as GitHub would.
    const state = initialWriteState(BOT_LOGIN)
    const store = openDirectStore({ dataDir })
    const api = buildWriteApi(session, brokerWriteRemote(state), store)
    seedDraft(store, session.human.id)

    const res = await postReview(session, api, submitInput({ event: 'APPROVE' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('forbidden')
    // Nothing posted, the draft kept, nothing journaled — no write reached GitHub.
    expect(state.postCount).toBe(0)
    expect(store.getDraft(session.human.id, WRITE_PR)).not.toBeNull()
    expect(store.listAudit()).toHaveLength(0)

    store.close()
  })

  test('APPROVE on an org-member-authored PR posts an APPROVED review', async () => {
    const session = await brokerSession({ REVU_BOT_LOGIN: BOT_LOGIN })
    const state = initialWriteState('org-member')
    const store = openDirectStore({ dataDir })
    const api = buildWriteApi(session, brokerWriteRemote(state), store)

    const res = await postReview(session, api, submitInput({ event: 'APPROVE' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
    expect(state.postCount).toBe(1)
    expect(state.reviews[0].raw.state).toBe('APPROVED')

    store.close()
  })

  test('a confirmed submit appends the review row plus one row per inline comment, and a landed-review retry journals again', async () => {
    const session = await brokerSession({ REVU_BOT_LOGIN: BOT_LOGIN })
    const state = initialWriteState('org-member')
    const store = openDirectStore({ dataDir })
    const api = buildWriteApi(session, brokerWriteRemote(state), store)

    const input = submitInput()
    const first = await postReview(session, api, input)
    const firstBody = (await first.json()) as { status: string; review: { id: number } }
    expect(firstBody.status).toBe('ok')

    // The submit journals the REVIEW id (review id-space)…
    const reviewRows = store.listAudit().filter((r) => r.endpoint === 'submitReview')
    expect(reviewRows).toHaveLength(1)
    expect(reviewRows[0]).toEqual({
      githubId: firstBody.review.id,
      humanId: HUMAN_ID,
      workspace: session.workspace,
      endpoint: 'submitReview',
      pr: WRITE_PR,
      createdAt: NOW,
    })
    // …AND one row per created inline comment (comment id-space), so the author of
    // each comment the review opened is recoverable for the snapshot's
    // commentAuthors map. The fake remote assigns inline comment ids from 9000.
    const commentRows = store.listAudit().filter((r) => r.endpoint === 'submitReviewComment')
    expect(commentRows).toHaveLength(input.comments.length)
    expect(commentRows[0]).toEqual({
      githubId: 9000,
      humanId: HUMAN_ID,
      workspace: session.workspace,
      endpoint: 'submitReviewComment',
      pr: WRITE_PR,
      createdAt: NOW,
    })

    // A retry that short-circuits to the already-landed review journals again:
    // the audit log covers every write that reached GitHub, including one whose
    // first response was lost, so the same GitHub id may legitimately appear twice.
    const retry = await postReview(session, api, input)
    expect(((await retry.json()) as { status: string }).status).toBe('ok')
    expect(state.postCount).toBe(1)
    const afterReview = store.listAudit().filter((r) => r.endpoint === 'submitReview')
    expect(afterReview).toHaveLength(2)
    expect(afterReview[1].githubId).toBe(firstBody.review.id)
    expect(afterReview[1].humanId).toBe(HUMAN_ID)

    // The journal filters compose with the rows just written: two submits, each
    // journaling one review row + one inline-comment row.
    expect(store.listAudit({ pr: WRITE_PR })).toHaveLength(4)
    expect(store.listAudit({ pr: WRITE_PR + 1 })).toHaveLength(0)

    store.close()
  })

  test('a mediated reply posts the stamped prefix to the thread root and journals one audit row', async () => {
    const session = await brokerSession({ REVU_BOT_LOGIN: BOT_LOGIN })
    const state = initialWriteState('org-member')
    const store = openDirectStore({ dataDir })
    // The reply path reads the thread's first comment id from the cached
    // snapshot, so the scenario seeds one unresolved thread rooted at 111.
    store.putSnapshot(threadSnapshot('PRRT_w1', 111))
    const api = buildWriteApi(session, brokerWriteRemote(state), store)

    const replyBody = 'Good catch — fixing in the next push.'
    const req = new Request(
      `http://127.0.0.1/api/pulls/${WRITE_PR}/threads/PRRT_w1/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: replyBody }),
      },
    )
    const res = await handleDirectApi(req, session, api, 'broker')
    expect(res).not.toBeNull()
    expect((res as Response).status).toBe(200)
    const returned = (await (res as Response).json()) as {
      id: number
      body: string
      in_reply_to_id?: number
    }

    // The reply landed on the thread's FIRST comment, stamped with the
    // canonical smuggled prefix…
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0].commentId).toBe(111)
    const posted = state.replies[0].raw.body as string
    expect(posted).toBe(prefixBody(session.human, replyBody))
    // …which round-trips through the shared parser back to the human…
    const parsed = parsePrefixedBody(posted)
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe(HUMAN_NAME)
    expect(parsed!.role).toBe('contractor')
    expect(parsed!.rest).toBe(replyBody)
    // …and the email NEVER enters the posted body (a local journal key only).
    expect(posted.toLowerCase()).not.toContain(HUMAN_EMAIL.toLowerCase())
    // The returned comment is the bot-authored reply as GitHub stored it.
    expect(returned.in_reply_to_id).toBe(111)
    expect(returned.body).toBe(posted)

    // Exactly one audit row, keyed by the id GitHub assigned the new comment.
    const rows = store.listAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      githubId: returned.id,
      humanId: HUMAN_ID,
      workspace: session.workspace,
      endpoint: 'replyToThread',
      pr: WRITE_PR,
      createdAt: NOW,
    })

    store.close()
  })

  test('without REVU_BOT_LOGIN, ALL FOUR write routes answer 501 not_implemented', async () => {
    // The real builder with no bot login yields the reads-only session, and the
    // real assembly (no decorator argument) yields an api WITHOUT the broker
    // write capability — the thing the router actually gates on. The remote
    // throws on ANY call, so a 501 (rather than a 500) proves each request was
    // turned away before the write path or GitHub was ever touched.
    const session = await brokerSession({})
    const store = openDirectStore({ dataDir })
    const api = createDirectApi({
      session,
      github: tokenGated(
        throwingGithubClient(),
        createFileCredentialTokenSource({ path: credentialFile }),
      ),
      repo: CONFORMANCE_REPO,
      store,
    })
    expect(api.brokerWritesEnabled).toBe(false)

    const writeRoutes = [
      { endpoint: 'submitReview', path: `/api/pulls/${WRITE_PR}/review` },
      { endpoint: 'replyToThread', path: `/api/pulls/${WRITE_PR}/threads/PRRT_w1/reply` },
      { endpoint: 'resolveThread', path: `/api/pulls/${WRITE_PR}/threads/PRRT_w1/resolve` },
      { endpoint: 'addReaction', path: `/api/comments/111/reactions?pr=${WRITE_PR}` },
    ]
    for (const route of writeRoutes) {
      const req = new Request(`http://127.0.0.1${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const res = await handleDirectApi(req, session, api, 'broker')
      expect(res).not.toBeNull()
      expect((res as Response).status).toBe(501)
      const body = (await (res as Response).json()) as { code: string }
      expect(body.code).toBe('not_implemented')
    }
    // Nothing was journaled by any of the four attempts.
    expect(store.listAudit()).toHaveLength(0)

    store.close()
  })

  test('without REVU_BOT_LOGIN a broker write still answers 501, and the write path never runs', async () => {
    // The real builder with no bot login yields the reads-only session shape;
    // the router's gate must close on it even though this api COULD write.
    const session = await brokerSession({})
    expect(session.brokerLogin).toBe('')
    expect(session.viewerLogin).toBeUndefined()

    const state = initialWriteState('org-member')
    const store = openDirectStore({ dataDir })
    const api = createDirectApi({
      session,
      github: tokenGated(
        brokerWriteRemote(state),
        createFileCredentialTokenSource({ path: credentialFile }),
      ),
      repo: CONFORMANCE_REPO,
      store,
    })
    const guarded: DirectApi = {
      ...api,
      submitReview: async () => {
        throw new Error('an identity-less broker must not dispatch submitReview')
      },
    }

    const res = await postReview(session, guarded, submitInput())
    expect(res.status).toBe(501)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('not_implemented')
    // Nothing reached the fake remote and nothing was journaled.
    expect(state.postCount).toBe(0)
    expect(store.listAudit()).toHaveLength(0)

    store.close()
  })
})

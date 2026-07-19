/**
 * Contract-conformance for BROKER mode — the same read/persist engine direct
 * mode runs, brought up the way broker mode boots it: the GitHub credential is
 * read from an injected `~/.git-credentials`-style file via the file-credential
 * `TokenSource` (never `gh`), the store is a real on-disk SQLite file, and the
 * whole run is network-free. The GitHub client is the SAME fake the direct
 * in-gate conformance drives, WRAPPED so every method first resolves a token
 * through the injected source — exactly what the real `createGithubClient` does
 * before it builds the Bearer header. That wrapper is what proves the broker's
 * distinctive value end to end:
 *
 *   - every READ scenario passes with a token present in the credential file, so
 *     the engine + the file-credential custody surface compose correctly;
 *   - a draft survives an on-disk store restart (the durability check), the
 *     analog of the daemon reloading from `REVU_DATA_DIR` after a rebind;
 *   - an EMPTY credential file makes the source throw `AwaitingCredentialError`,
 *     which the router maps to `broker_unreachable` (502) rather than a crash —
 *     the transient "credential not injected yet" state, surfaced per request.
 *
 * A broker WITHOUT a configured bot identity is reads-only: the router gates the
 * four write endpoints to `not_implemented` (501). This suite covers the
 * read/persist scenarios the engine owns — baseline, baseAdvanced, mutableDrift,
 * partialSync, and reconcile (both LEFT and RIGHT sides, with preview/report
 * parity) — plus the restart survival check and a check that a write route on an
 * identity-less broker answers 501, all driven through the broker assembly. The
 * write-ENABLED broker (bot identity configured, stamping + audit journal) has
 * its own conformance suite in `conformance-broker-writes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AnchorResult,
  GhUser,
  Session,
  SubmitReviewInput,
} from '@revu/shared'
import {
  blobContentToLines,
  classifyPendingComment,
  isOwnComment,
  prefixBody,
  selectAnchorBlobSha,
} from '@revu/shared'
import { AwaitingCredentialError, createFileCredentialTokenSource } from '../broker/token-source'
import type { GithubClient, Page, PageParams, SubmitReviewBody } from './github-client'
import type { TokenSource } from './token-source'
import { createDirectApi, type DirectApi } from './direct-api'
import { handleDirectApi } from '../direct-router'
import { openDirectStore, type DirectStore } from './store'
import { createBrokerWriteDecorator } from './write-decorator'
import {
  CONFORMANCE_REPO,
  CONFORMANCE_SESSION,
  initialReconcileState,
  MOVING_BASE_HEAD_BLOB_SHA,
  MOVING_BASE_PR,
  movingBaseClient,
  movingHeadClient,
  partialBlobClient,
  RECONCILE_PR,
  seedForcePushed,
  tokenGated,
} from './conformance-fakes'

/** A fake token the credential file carries; never a real secret. */
const FAKE_TOKEN = 'ghs_broker_conformance_fake'

/** A git-credential-store line the file-credential source parses to `FAKE_TOKEN`. */
function credentialLine(token: string): string {
  return `https://x-access-token:${token}@github.com\n`
}

/**
 * The reads-only broker session shape: no bot identity configured, so
 * `viewerLogin` is ABSENT and `brokerLogin` is the empty "no bot" sentinel —
 * exactly what `buildBrokerSession` yields without `REVU_BOT_LOGIN`. The
 * router's write gate keys on that absent self-identity, so this is the session
 * the gating check below must drive.
 */
const READS_ONLY_BROKER_SESSION: Session = {
  human: CONFORMANCE_SESSION.human,
  brokerLogin: '',
  workspace: CONFORMANCE_SESSION.workspace,
}

let dataDir: string
let credentialFile: string

/** The broker token source, reading the per-test temp credential file. */
function brokerTokenSource(): TokenSource {
  return createFileCredentialTokenSource({ path: credentialFile })
}

/** Assemble the broker read/persist surface: the token-gated fake + on-disk store. */
function buildBrokerApi(client: GithubClient, store: DirectStore): DirectApi {
  return createDirectApi({
    session: CONFORMANCE_SESSION,
    github: tokenGated(client, brokerTokenSource()),
    repo: CONFORMANCE_REPO,
    store,
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-broker-conf-'))
  credentialFile = join(dataDir, '.git-credentials')
  // The host has injected a (fake) token before the first request.
  writeFileSync(credentialFile, credentialLine(FAKE_TOKEN), 'utf8')
})

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('RevuApi conformance — broker (file-credential engine, reads-only)', () => {
  test('baseline: a never-synced pull reads back null, then a cold sync fetches blobs', async () => {
    const store = openDirectStore({ dataDir })
    const api = buildBrokerApi(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)

    expect(api.getSnapshot(MOVING_BASE_PR)).toBeNull()

    const snap = await api.syncPull(MOVING_BASE_PR)
    expect(snap.prNumber).toBe(MOVING_BASE_PR)
    expect(snap.partial).toBeNull()
    expect(snap.syncStats?.blobsFetched ?? 0).toBeGreaterThan(0)
    expect(snap.immutable.files.length).toBeGreaterThan(0)
    expect(snap.immutable.compareKey).toBe('MB1...HEAD-FIXED')

    // A synced blob is readable from the local store.
    const headSha = snap.immutable.blobIndex[snap.immutable.files[0].filename]?.head
    expect(typeof headSha).toBe('string')
    const blob = api.getBlob(headSha as string)
    expect(blob.content.length).toBeGreaterThan(0)

    store.close()
  })

  test('baseAdvanced: base moves under a fixed head → compareKey moves, immutable rebuilds', async () => {
    const store = openDirectStore({ dataDir })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 0 }
    const api = buildBrokerApi(movingBaseClient(state), store)

    const first = await api.syncPull(MOVING_BASE_PR)
    expect(first.immutable.compareKey).toBe('MB1...HEAD-FIXED')

    state.mergeBaseSha = 'MB2'
    const second = await api.syncPull(MOVING_BASE_PR)
    expect(second.immutable.headSha).toBe('HEAD-FIXED')
    expect(second.immutable.compareKey).toBe('MB2...HEAD-FIXED')
    expect(second.immutable.blobIndex['a.ts'].base).toBe('base-MB2')

    store.close()
  })

  test('mutableDrift: head unchanged still refetches the mutable half, reusing every blob', async () => {
    const store = openDirectStore({ dataDir })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 2 }
    const api = buildBrokerApi(movingBaseClient(state), store)

    const first = await api.syncPull(MOVING_BASE_PR)
    expect(first.mutable.issueComments).toHaveLength(2)

    state.unresolvedComments = 0
    const second = await api.syncPull(MOVING_BASE_PR)
    // Head/base unchanged → the immutable half is reused untouched (zero blobs
    // refetched) even though the mutable half is refreshed.
    expect(second.immutable.compareKey).toBe(first.immutable.compareKey)
    expect(second.syncStats?.blobsFetched).toBe(0)
    expect(second.mutable.issueComments).toHaveLength(0)

    store.close()
  })

  test('partialSync: a blob no tier can provision resolves an honest partial, not a throw', async () => {
    const store = openDirectStore({ dataDir })
    const api = buildBrokerApi(partialBlobClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)

    // The head blob is withheld from every tier, so the sync keeps the snapshot
    // with an honest `partial` naming exactly that SHA rather than throwing — the
    // frozen contract that a `partial` is a 200 value, never an error.
    const snap = await api.syncPull(MOVING_BASE_PR)
    expect(snap.partial).not.toBeNull()
    expect(snap.partial?.missingBlobShas ?? []).toContain(MOVING_BASE_HEAD_BLOB_SHA)
    // The snapshot is still cached and re-readable — a partial is a kept snapshot.
    expect(api.getSnapshot(MOVING_BASE_PR)).not.toBeNull()

    store.close()
  })

  test('reconcile: after a force-push and re-sync, reconcile yields clean/clean/drifted/lost', async () => {
    const store = openDirectStore({ dataDir })
    const state = initialReconcileState()
    const api = buildBrokerApi(movingHeadClient(state), store)
    const draft = await seedForcePushed(api, state)
    expect(draft.headSha).toBe('HEAD-OLD')

    const report = api.reconcileDraft(RECONCILE_PR)
    const kinds = report.results.map((r) => r.kind).sort()
    expect(kinds).toEqual(['clean', 'clean', 'drifted', 'lost'])
    expect(report.newCommits.map((c) => c.sha)).toEqual(['C2', 'C3', 'HEAD-NEW'])

    // The client-side preview matches the report for every comment, both sides —
    // the same parity the direct suite pins, proven through the broker assembly.
    const snap = api.getSnapshot(RECONCILE_PR)
    const stored = api.getDraft(RECONCILE_PR)
    expect(snap).not.toBeNull()
    expect(stored).not.toBeNull()
    const sides = new Set(stored!.comments.map((c) => c.side))
    expect(sides.has('LEFT')).toBe(true)
    expect(sides.has('RIGHT')).toBe(true)
    for (const comment of stored!.comments) {
      const entry = snap!.immutable.blobIndex[comment.path]
      const sha = selectAnchorBlobSha(entry, comment.side)
      const resolveBlobLines = (s: string): string[] | null => {
        if (s !== sha) return null
        const blob = api.getBlob(s)
        return blob.binary ? null : blobContentToLines(blob.content)
      }
      const preview: AnchorResult = classifyPendingComment({
        comment,
        files: snap!.immutable.files,
        blobIndex: snap!.immutable.blobIndex,
        resolveBlobLines,
      })
      const reported = report.results.find((r) => r.comment.key === comment.key)
      expect(reported).toBeDefined()
      expect(preview).toEqual(reported!)
    }

    store.close()
  })

  test('restart: a written draft survives reopening the on-disk store', async () => {
    // Write a draft, close the store, reopen the SAME data dir, and re-read — the
    // on-disk analog of the daemon reloading from REVU_DATA_DIR after a rebind.
    let store = openDirectStore({ dataDir })
    let api = buildBrokerApi(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    const snap = await api.syncPull(MOVING_BASE_PR)
    const now = '2026-01-20T00:00:00.000Z'
    api.saveDraft({
      humanId: CONFORMANCE_SESSION.human.id,
      prNumber: MOVING_BASE_PR,
      headSha: snap.immutable.headSha,
      compareKey: snap.immutable.compareKey,
      body: 'Durable broker draft — must survive a restart.',
      event: 'COMMENT',
      comments: [],
      createdAt: now,
      updatedAt: now,
    })
    store.close()

    // Reopen: a fresh store handle over the same on-disk file.
    store = openDirectStore({ dataDir })
    api = buildBrokerApi(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    const reloaded = api.getDraft(MOVING_BASE_PR)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.body).toContain('must survive a restart')
    expect(reloaded!.headSha).toBe(snap.immutable.headSha)
    store.close()
  })
})

describe('broker without a bot identity gates writes to not_implemented (reads-only)', () => {
  test('POST submit review returns 501 not_implemented, and the write path never runs', async () => {
    // The api's submitReview must never be reached when the broker session has
    // no bot self-identity: assert it by wiring an api that would throw if the
    // router dispatched the write.
    const store = openDirectStore({ dataDir })
    const api = buildBrokerApi(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    const guarded: DirectApi = {
      ...api,
      submitReview: async () => {
        throw new Error('an identity-less broker must not dispatch submitReview')
      },
    }

    const req = new Request(`http://127.0.0.1/api/pulls/${MOVING_BASE_PR}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prNumber: MOVING_BASE_PR,
        expectedHeadSha: 'x',
        event: 'COMMENT',
        body: '',
        comments: [],
      }),
    })
    const res = await handleDirectApi(req, READS_ONLY_BROKER_SESSION, guarded, 'broker')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(501)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('not_implemented')

    store.close()
  })

  test('the same submit endpoint IS served in direct mode (the gate is broker-only)', async () => {
    // A submit against a stale head returns head_moved as a 200 VALUE in direct
    // mode — proof the reads-only gate is scoped to broker and leaves direct
    // writes byte-for-byte unchanged.
    const store = openDirectStore({ dataDir })
    const state = initialReconcileState()
    const api = buildBrokerApi(movingHeadClient(state), store)
    const first = await api.syncPull(RECONCILE_PR)
    api.saveDraft({
      humanId: CONFORMANCE_SESSION.human.id,
      prNumber: RECONCILE_PR,
      headSha: first.immutable.headSha,
      compareKey: first.immutable.compareKey,
      body: 'seeded',
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    })

    const req = new Request(`http://127.0.0.1/api/pulls/${RECONCILE_PR}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prNumber: RECONCILE_PR,
        expectedHeadSha: 'not-the-real-head',
        event: 'COMMENT',
        body: '',
        comments: [],
      }),
    })
    const res = await handleDirectApi(req, CONFORMANCE_SESSION, api, 'direct')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { status: string }
    expect(body.status).toBe('head_moved')

    store.close()
  })
})

describe('broker awaiting-credential → broker_unreachable (502)', () => {
  test('an empty credential file makes getToken throw AwaitingCredentialError', async () => {
    writeFileSync(credentialFile, '', 'utf8')
    const source = brokerTokenSource()
    let caught: unknown = null
    try {
      await source.getToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
  })

  test('a READ whose getToken throws AwaitingCredentialError is a 502 broker_unreachable', async () => {
    // Empty the credential file: the token-gated client throws
    // AwaitingCredentialError on the first method a READ reaches, which propagates
    // through the engine to the router, which must map it to broker_unreachable
    // (502) — never an unhandled 500, never a crashed request. Driven through a
    // READ (sync) so the top-level path surfaces the awaiting state directly.
    writeFileSync(credentialFile, '', 'utf8')
    const store = openDirectStore({ dataDir })
    const api = buildBrokerApi(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)

    const req = new Request(`http://127.0.0.1/api/pulls/${MOVING_BASE_PR}/sync`, { method: 'POST' })
    const res = await handleDirectApi(req, CONFORMANCE_SESSION, api, 'broker')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(502)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('broker_unreachable')
    // No token material ever crosses the HTTP boundary.
    expect(body.message).not.toContain(FAKE_TOKEN)

    store.close()
  })
})

// ————————————————————————————————————————————————————————————————
// commentAuthors ground truth — broker-authored comments detected as OWN
// (additive block; keeps its own fixtures so it merges without touching the
// scenarios above)
// ————————————————————————————————————————————————————————————————

/** The bot login the write-enabled broker posts every comment as. */
const AUTHORS_BOT_LOGIN = 'revu-authors[bot]'
/** Deterministic timestamp injected into the broker decorator's audit rows. */
const AUTHORS_NOW = '2026-07-18T12:00:00.000Z'

/**
 * A write-enabled broker session: the session self-identifies as the bot for the
 * write guards (`viewerLogin` = bot) AND routes the prefix parser through the bot
 * (`brokerLogin` = bot). The human is a real contractor whose lowercased email is
 * the audit/journal key — never rendered into a body.
 */
const AUTHORS_SESSION: Session = {
  human: { id: 'dana@contractor.co', name: 'Dana Ortiz', role: 'contractor', email: 'dana@contractor.co' },
  brokerLogin: AUTHORS_BOT_LOGIN,
  workspace: 'direct-o-r',
  viewerLogin: AUTHORS_BOT_LOGIN,
}

/** One page carrying `items` on page 1, empty thereafter. */
function authorsPage<T>(items: T[], params: PageParams): Page<T> {
  return params.page === 1 ? { items, hasNext: false } : { items: [], hasNext: false }
}

/** The bot user object every broker-authored comment carries. */
function botUser(): GhUser {
  return {
    login: AUTHORS_BOT_LOGIN,
    id: 99,
    node_id: 'BOT',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }
}

/**
 * A read+write fake for the `commentAuthors` scenario: the base-moved read
 * surface (so a sync produces a real snapshot) composed with a submit path that
 * accepts one review, attributes it and its inline comments to the bot, and
 * re-serves the created inline comments by review id — exactly what
 * `journalReviewComments` reads to journal each comment's authorship.
 */
function authorsWriteRemote(state: {
  mergeBaseSha: string
  reviewComments: Record<string, unknown>[]
}): GithubClient {
  const base = movingBaseClient({ mergeBaseSha: state.mergeBaseSha, unresolvedComments: 0 })
  let nextReviewId = 600
  return {
    ...base,
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      // No prior reviews exist, so the idempotency re-check finds no candidate
      // and the submit posts fresh.
      return authorsPage([], params)
    },
    async submitReview(_o, _r, _n, body: SubmitReviewBody): Promise<unknown> {
      const id = nextReviewId++
      // Each inline comment gets a bot-authored id in the comment id-space; the
      // POST response body itself is the review only, matching real GitHub.
      state.reviewComments = body.comments.map((c, i) => ({
        id: 9100 + i,
        path: c.path,
        side: c.side,
        original_line: c.line,
        original_start_line: c.start_line ?? null,
        body: c.body,
        user: botUser(),
      }))
      return {
        id,
        node_id: `PRR_${id}`,
        user: botUser(),
        body: body.body,
        state: 'COMMENTED',
        submitted_at: AUTHORS_NOW,
        commit_id: body.commit_id,
      }
    },
    async getReviewComments(_o, _r, _n, _reviewId, params): Promise<Page<unknown>> {
      // The per-review comment list the submit path reads to journal each
      // created inline comment's id.
      return authorsPage(state.reviewComments, params)
    },
  }
}

describe('commentAuthors ground truth (broker-authored comment detected as OWN)', () => {
  test('a mediated inline review comment is journaled, rides the synced snapshot, and resolves as the session human OWN via commentAuthors', async () => {
    const store = openDirectStore({ dataDir })
    const state = { mergeBaseSha: 'MB1', reviewComments: [] as Record<string, unknown>[] }
    const api = createDirectApi({
      session: AUTHORS_SESSION,
      github: tokenGated(authorsWriteRemote(state), brokerTokenSource()),
      repo: CONFORMANCE_REPO,
      store,
      // The broker decorator stamps every body and journals every confirmed
      // write to the workspace audit log — the ground truth commentAuthors reads.
      writeDecorator: createBrokerWriteDecorator(AUTHORS_SESSION, store, () => AUTHORS_NOW),
    })

    // A cold sync establishes the snapshot and the head the submit guards against.
    const first = await api.syncPull(MOVING_BASE_PR)
    // No writes yet → no authorship journaled → the field is omitted (not empty).
    expect(first.mutable.commentAuthors).toBeUndefined()

    const input: SubmitReviewInput = {
      prNumber: MOVING_BASE_PR,
      expectedHeadSha: first.immutable.headSha,
      event: 'COMMENT',
      body: 'Overall solid; one nit inline.',
      comments: [
        {
          key: 'k1',
          path: 'a.ts',
          side: 'RIGHT',
          start_side: null,
          line: 1,
          start_line: null,
          body: 'Use a Map here instead of an object.',
          createdAt: AUTHORS_NOW,
          updatedAt: AUTHORS_NOW,
          anchor: { lineText: 'x', contextBefore: [], contextAfter: [] },
        },
      ],
    }
    const result = await api.submitReview(input)
    expect(result.status).toBe('ok')

    // The submit journaled the review id AND each inline comment id: the
    // comment-creating row (submitReviewComment) is what commentAuthors consumes.
    const commentRows = store.listAudit({ pr: MOVING_BASE_PR }).filter(
      (r) => r.endpoint === 'submitReviewComment',
    )
    expect(commentRows).toHaveLength(1)
    const createdCommentId = commentRows[0].githubId
    expect(commentRows[0].humanId).toBe(AUTHORS_SESSION.human.id)

    // A re-sync now carries commentAuthors, mapping the real GitHub comment id to
    // the human id — the M1.3 id-path assembled from the journal end to end.
    const second = await api.syncPull(MOVING_BASE_PR)
    const authors = second.mutable.commentAuthors
    expect(authors).toBeDefined()
    expect(authors![createdCommentId]).toBe(AUTHORS_SESSION.human.id)

    // The verify scenario, isolated so commentAuthors ground truth is what WINS
    // (not a coincidental name-match): the bot-authored comment smuggles a
    // DIFFERENT human's name into its body than the journal recorded, so name
    // matching alone would give the WRONG answer for both humans. The write log
    // overrides it in both directions.
    const otherHuman = { id: 'eve@contractor.co', name: 'Eve Lin', role: 'contractor' as const, email: 'eve@contractor.co' }
    const brokerComment = {
      id: createdCommentId,
      user: botUser(),
      // Stamped with Eve's name, but the journal attributes this comment id to Dana.
      body: prefixBody(otherHuman, 'Use a Map here instead of an object.'),
    }
    // Dana IS the author per the write log, even though the body names Eve.
    expect(
      isOwnComment(brokerComment, {
        human: AUTHORS_SESSION.human,
        commentAuthors: authors,
        botLogin: AUTHORS_SESSION.brokerLogin,
        viewerLogin: AUTHORS_SESSION.viewerLogin,
      }),
    ).toBe(true)

    // Eve is NOT the author per the write log, even though the body names Eve —
    // the log wins over the (misleading) name-match and keys on the stable id, so
    // it distinguishes the humans behind the one shared bot login.
    expect(
      isOwnComment(brokerComment, {
        human: otherHuman,
        commentAuthors: authors,
        botLogin: AUTHORS_SESSION.brokerLogin,
        viewerLogin: AUTHORS_SESSION.viewerLogin,
      }),
    ).toBe(false)

    store.close()
  })
})

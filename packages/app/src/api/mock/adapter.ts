import type { AnchorResult, CommitInfo, FileBlob, FileViewedState, Human, HumanPreferences, IssueComment, PullDetail, PullFile, PullListItem, PullListResponse, PullSummary, RateLimitInfo, ReactionKey, ReactionRollup, ReconcileReport, ReviewComment, ReviewDraft, ReviewSummary, ReviewThread, Session, Snapshot, SubmitResult, SubmitReviewInput } from '@revu/shared'
import { ApiError, prefixBody, blobContentToLines, classifyPendingComment } from '@revu/shared'
import type { RevuApi } from '@revu/shared'
import type { FixtureDB, RemotePull } from '@/fixtures/contract'
import { fixtureDB } from '@/fixtures'
import { buildSnapshot, emptyReactions, nodeId } from '@/fixtures/helpers'
import { store } from './store'
import { delay, localDelay } from './latency'

/**
 * Mock implementation of `RevuApi`, backed by fixtures (the remote side) and
 * the persistent broker store (the cached side).
 *
 * Transport semantics honored throughout:
 * - Every method waits a network-shaped delay first; local-cache reads
 *   (`getSnapshot`, `getBlob`, `listReviewThreads`, `getDraft`,
 *   `getFileViewed`) use a short fixed delay instead and NEVER fail under
 *   any failure mode — a synced PR stays fully reviewable offline.
 * - Remote reads fail only under failureMode 'all'; writes fail under
 *   'writes'/'all'; sync fails under 'sync'/'all'.
 * - Rate budget: a listPulls etag miss costs 1, a sync costs its request
 *   count, each GitHub write costs 1. 304s are free. Broker-side state
 *   (drafts, viewed) never touches GitHub, so it never spends the bucket.
 * - Writes are applied to the remote-mutation overlay AND to the cached
 *   snapshot's mutable half, so the UI reflects them without a re-sync and
 *   they survive a reload.
 */

const db = fixtureDB as FixtureDB

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

function nowISO(): string {
  return new Date().toISOString()
}

function currentHuman(): Human {
  const dev = store.getDev()
  const h = db.humans.find((x) => x.id === dev.humanId) ?? db.humans[0]
  return { ...h }
}

// ————————————————————————————————————————————————————————————————
// Failure-mode gates
// ————————————————————————————————————————————————————————————————

function failReads(): void {
  if (store.getDev().failureMode === 'all') {
    throw new ApiError(
      'broker_unreachable',
      "The broker didn't respond. Cached snapshots still work — reads are local.",
    )
  }
}

function failWrites(message: string): void {
  const mode = store.getDev().failureMode
  if (mode === 'writes' || mode === 'all') {
    throw new ApiError('network', message)
  }
}

function failSync(): void {
  const mode = store.getDev().failureMode
  if (mode === 'sync' || mode === 'all') {
    throw new ApiError(
      'network',
      'Network unreachable — the workspace has no route to the broker right now.',
    )
  }
}

// ————————————————————————————————————————————————————————————————
// Shared lookups
// ————————————————————————————————————————————————————————————————

function requireRemote(prNumber: number): RemotePull {
  const remote = store.effectiveRemote(prNumber)
  if (!remote) {
    throw new ApiError(
      'not_found',
      `Pull request #${prNumber} does not exist on ${db.repo.full_name}.`,
    )
  }
  return remote
}

function findReactable(
  container: { threads: ReviewThread[]; issueComments: IssueComment[] },
  commentId: number,
): { reactions: ReactionRollup } | null {
  for (const t of container.threads) {
    for (const c of t.comments) {
      if (c.id === commentId) return c
    }
  }
  for (const c of container.issueComments) {
    if (c.id === commentId) return c
  }
  return null
}

/** Exactly the fields a REST list item carries — never detail-only counts. */
function toSummary(detail: PullDetail): PullSummary {
  const {
    id,
    node_id,
    number,
    state,
    draft,
    merged_at,
    title,
    body,
    user,
    labels,
    requested_reviewers,
    head,
    base,
    created_at,
    updated_at,
  } = detail
  return {
    id,
    node_id,
    number,
    state,
    draft,
    merged_at,
    title,
    body,
    user,
    labels,
    requested_reviewers,
    head,
    base,
    created_at,
    updated_at,
  }
}

// ————————————————————————————————————————————————————————————————
// Hunk synthesis for new threads: slice the containing patch hunk up to the
// anchored line (max 4 lines) and synthesize a matching @@ header.
// ————————————————————————————————————————————————————————————————

interface HunkLine {
  text: string
  oldNo: number | null
  newNo: number | null
}

function synthesizeHunk(
  files: PullFile[],
  path: string,
  line: number,
  side: 'LEFT' | 'RIGHT',
): string {
  const patch = files.find((f) => f.filename === path)?.patch
  const fallback = `@@ -${line},1 +${line},1 @@`
  if (!patch) return fallback

  let oldNo = 0
  let newNo = 0
  let current: HunkLine[] | null = null
  const hunks: HunkLine[][] = []
  for (const raw of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      current = []
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith('+')) current.push({ text: raw, oldNo: null, newNo: newNo++ })
    else if (raw.startsWith('-')) current.push({ text: raw, oldNo: oldNo++, newNo: null })
    else if (raw.startsWith('\\')) current.push({ text: raw, oldNo: null, newNo: null })
    else current.push({ text: raw, oldNo: oldNo++, newNo: newNo++ })
  }

  for (const body of hunks) {
    const anchor = body.findIndex((l) =>
      side === 'RIGHT' ? l.newNo === line : l.oldNo === line,
    )
    if (anchor === -1) continue
    const slice = body.slice(Math.max(0, anchor - 3), anchor + 1)
    const oldLines = slice.filter((l) => l.oldNo !== null)
    const newLines = slice.filter((l) => l.newNo !== null)
    const oldStart = oldLines[0]?.oldNo ?? line
    const newStart = newLines[0]?.newNo ?? line
    const header = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`
    return [header, ...slice.map((l) => l.text)].join('\n')
  }
  return fallback
}

// ————————————————————————————————————————————————————————————————
// The adapter
// ————————————————————————————————————————————————————————————————

export function createMockApi(): RevuApi {
  const api: RevuApi = {
    async getSession(): Promise<Session> {
      await delay('read')
      failReads()
      const human = currentHuman()
      return {
        human,
        brokerLogin: db.brokerBot.login,
        workspace: `coder-ws-${human.id}`,
      }
    },

    async listPulls(opts?: { etag?: string }): Promise<PullListResponse> {
      await delay('read')
      failReads()
      const items: PullListItem[] = store.listEffectiveRemotes().map((r) => ({
        pull: toSummary(r.detail),
        broker: {
          ...r.broker,
          // The broker's poll loop is always fresh — these are recomputed
          // from the current effective remote, never trusted from fixtures.
          unresolvedThreads: r.threads.filter((t) => !t.isResolved).length,
          commitCount: r.commits.length,
          compareKey: `${r.detail.merge_base_sha}...${r.detail.head.sha}`,
        },
      }))
      items.sort((a, b) => b.pull.updated_at.localeCompare(a.pull.updated_at))
      const etag = `W/"${djb2(JSON.stringify(items)).toString(16)}"`
      if (opts?.etag !== undefined && opts.etag === etag) {
        // A 304 is free against the shared bucket. Items stay populated as a
        // mock convenience — a real transport would return no body.
        return { items, etag, notModified: true, rateLimit: store.rateInfo() }
      }
      store.spendRate(1)
      return { items, etag, notModified: false, rateLimit: store.rateInfo() }
    },

    async syncPull(
      prNumber: number,
      opts?: { signal?: AbortSignal },
    ): Promise<Snapshot> {
      await delay('sync')
      if (opts?.signal?.aborted) {
        throw new DOMException('The sync was aborted.', 'AbortError')
      }
      failSync()
      const remote = requireRemote(prNumber)
      const attempt = store.getSyncAttempts(prNumber)
      store.bumpSyncAttempts(prNumber)
      const syncedAt = nowISO()

      // Blob transfer is content-addressed: only SHAs absent from the local
      // store are fetched; everything else is a cache hit.
      const needed: FileBlob[] = []
      const seen = new Set<string>()
      for (const b of remote.blobs) {
        if (!seen.has(b.sha)) {
          seen.add(b.sha)
          needed.push(b)
        }
      }
      const missing = needed.filter((b) => !store.hasBlob(b.sha))
      const reused = needed.length - missing.length

      // First attempt only: the connection dies mid-transfer, a partial
      // snapshot is kept (it names what is missing), and the retry succeeds.
      const failAfter = remote.scenario?.failSyncAfterBlobs
      if (attempt === 0 && typeof failAfter === 'number' && missing.length > failAfter) {
        const fetched = missing.slice(0, failAfter)
        const rest = missing.slice(failAfter)
        store.putBlobs(fetched)
        const partialSnap = buildSnapshot(remote, syncedAt, {
          partial: {
            missingBlobShas: rest.map((b) => b.sha),
            reason: `Connection lost mid-sync after ${failAfter} of ${missing.length} blobs`,
          },
          syncStats: {
            blobsFetched: failAfter,
            blobsReused: reused,
            requests: 3 + failAfter,
          },
        })
        store.putSnapshot(partialSnap)
        store.spendRate(3 + failAfter)
        throw new ApiError(
          'network',
          'Connection dropped during sync — a partial snapshot was kept.',
        )
      }

      store.putBlobs(missing)
      const requests = 3 + missing.length
      const syncStats = { blobsFetched: missing.length, blobsReused: reused, requests }
      const compareKey = `${remote.detail.merge_base_sha}...${remote.detail.head.sha}`
      const existing = store.getSnapshot(prNumber)

      let snap: Snapshot
      if (existing && existing.immutable.compareKey === compareKey) {
        // Same merge_base...head compare: the immutable half is reused
        // untouched (content-addressed honesty) and only the mutable half is
        // refreshed. When nothing was missing, blobsFetched is 0; a retry
        // after a partial sync fetches exactly the blobs that were lost.
        const fresh = buildSnapshot(remote, syncedAt, { syncStats })
        snap = { ...fresh, immutable: existing.immutable }
      } else {
        snap = buildSnapshot(remote, syncedAt, { syncStats })
      }
      store.putSnapshot(snap)
      store.spendRate(requests)
      return snap
    },

    async getSnapshot(prNumber: number): Promise<Snapshot | null> {
      await localDelay()
      return store.getSnapshot(prNumber)
    },

    async getBlob(sha: string): Promise<FileBlob> {
      await localDelay()
      const blob = store.getBlob(sha)
      if (!blob) {
        throw new ApiError(
          'not_found',
          `Blob ${sha} is not in the local snapshot store — re-sync this pull request to fetch it.`,
        )
      }
      return blob
    },

    async listReviewThreads(prNumber: number): Promise<ReviewThread[]> {
      await localDelay()
      const snap = store.getSnapshot(prNumber)
      return snap ? snap.mutable.threads : []
    },

    async replyToThread(
      prNumber: number,
      threadId: string,
      body: string,
    ): Promise<ReviewComment> {
      await delay('write')
      failWrites('The broker did not answer — your reply was not posted.')
      const remote = requireRemote(prNumber)
      const thread = remote.threads.find((t) => t.id === threadId)
      if (!thread || thread.comments.length === 0) {
        throw new ApiError(
          'not_found',
          `Thread ${threadId} was not found on pull #${prNumber} — it may have been deleted upstream.`,
        )
      }
      const human = currentHuman()
      const first = thread.comments[0]
      const id = store.nextId()
      const at = nowISO()
      // The UI sends clean markdown; the broker smuggles the human identity
      // into the body prefix, since GitHub only ever sees the bot.
      const comment: ReviewComment = {
        id,
        node_id: nodeId('PRRC', id),
        pull_request_review_id: first.pull_request_review_id,
        in_reply_to_id: first.id,
        path: thread.path,
        diff_hunk: first.diff_hunk,
        commit_id: remote.detail.head.sha,
        original_commit_id: first.original_commit_id,
        line: thread.line,
        original_line: thread.originalLine,
        start_line: null,
        original_start_line: null,
        side: thread.diffSide,
        start_side: null,
        subject_type: thread.subjectType === 'FILE' ? 'file' : 'line',
        user: { ...db.brokerBot },
        body: prefixBody(human, body),
        created_at: at,
        updated_at: at,
        reactions: emptyReactions(id),
        html_url: `https://github.com/${db.repo.full_name}/pull/${prNumber}#discussion_r${id}`,
      }
      store.appendReply(prNumber, threadId, comment)
      const snap = store.getSnapshot(prNumber)
      if (snap) {
        const cached = snap.mutable.threads.find((t) => t.id === threadId)
        if (cached) {
          cached.comments.push(clone(comment))
          // Record this broker-authored comment in the write log carried by the
          // snapshot, so own-comment detection resolves it by author id.
          ;(snap.mutable.commentAuthors ??= {})[comment.id] = human.id
          store.putSnapshot(snap)
        }
      }
      store.spendRate(1)
      return comment
    },

    async resolveThread(
      prNumber: number,
      threadId: string,
      resolved: boolean,
    ): Promise<ReviewThread> {
      await delay('write')
      failWrites('The broker did not answer — the thread state was not changed.')
      const remote = requireRemote(prNumber)
      const thread = remote.threads.find((t) => t.id === threadId)
      if (!thread) {
        throw new ApiError(
          'not_found',
          `Thread ${threadId} was not found on pull #${prNumber}.`,
        )
      }
      const resolvedBy = resolved ? { login: db.brokerBot.login } : null
      store.setResolution(prNumber, threadId, resolved, resolvedBy)
      const snap = store.getSnapshot(prNumber)
      if (snap) {
        const cached = snap.mutable.threads.find((t) => t.id === threadId)
        if (cached) {
          cached.isResolved = resolved
          cached.resolvedBy = resolvedBy ? { ...resolvedBy } : null
          store.putSnapshot(snap)
        }
      }
      store.spendRate(1)
      thread.isResolved = resolved
      thread.resolvedBy = resolvedBy
      return thread
    },

    async addReaction(
      prNumber: number,
      commentId: number,
      reaction: ReactionKey,
    ): Promise<ReactionRollup> {
      await delay('write')
      failWrites('The broker did not answer — the reaction was not saved.')
      const remote = requireRemote(prNumber)
      const target = findReactable(remote, commentId)
      if (!target) {
        throw new ApiError(
          'not_found',
          `Comment ${commentId} was not found on pull #${prNumber}.`,
        )
      }
      // GitHub dedupes reactions per user, and every human here IS the same
      // bot: once that emoji is on the comment, another human's identical
      // reaction changes nothing. The rollup comes back unchanged — the
      // shared-identity constraint made visible.
      if (target.reactions[reaction] > 0) {
        store.spendRate(1)
        return target.reactions
      }
      store.bumpReaction(prNumber, commentId, reaction)
      target.reactions[reaction] += 1
      target.reactions.total_count += 1
      const snap = store.getSnapshot(prNumber)
      if (snap) {
        const cached = findReactable(snap.mutable, commentId)
        if (cached) {
          cached.reactions[reaction] += 1
          cached.reactions.total_count += 1
          store.putSnapshot(snap)
        }
      }
      store.spendRate(1)
      return target.reactions
    },

    async submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
      await delay('write')
      failWrites(
        'The broker did not answer — your review was not submitted. The draft is untouched.',
      )
      const remote = requireRemote(input.prNumber)
      const currentHeadSha = remote.detail.head.sha

      if (input.expectedHeadSha !== currentHeadSha) {
        // Head moved under the draft. Returned (not thrown) so the UI routes
        // through reconcile; the draft is not touched.
        const snap = store.getSnapshot(input.prNumber)
        return {
          status: 'head_moved',
          currentHeadSha,
          newCommits: Math.max(
            0,
            remote.commits.length - (snap?.immutable.commits.length ?? 0),
          ),
        }
      }

      if (input.event !== 'COMMENT' && !remote.broker.canApprove) {
        return {
          status: 'forbidden',
          reason:
            'GitHub refuses self-review: this PR was opened by the App identity. Comment instead — an org member can approve on github.com.',
        }
      }

      const human = currentHuman()
      const at = nowISO()
      const reviewId = store.nextId()
      const stateMap = {
        COMMENT: 'COMMENTED',
        APPROVE: 'APPROVED',
        REQUEST_CHANGES: 'CHANGES_REQUESTED',
      } as const
      const review: ReviewSummary = {
        id: reviewId,
        node_id: nodeId('PRR', reviewId),
        user: { ...db.brokerBot },
        body: input.body.trim().length > 0 ? prefixBody(human, input.body) : '',
        state: stateMap[input.event],
        submitted_at: at,
        commit_id: currentHeadSha,
      }

      const snap = store.getSnapshot(input.prNumber)
      const diffFiles = snap?.immutable.files ?? remote.files
      const newThreads: ReviewThread[] = input.comments.map((c) => {
        const commentId = store.nextId()
        const comment: ReviewComment = {
          id: commentId,
          node_id: nodeId('PRRC', commentId),
          pull_request_review_id: reviewId,
          path: c.path,
          diff_hunk: synthesizeHunk(diffFiles, c.path, c.line, c.side),
          commit_id: currentHeadSha,
          original_commit_id: currentHeadSha,
          line: c.line,
          original_line: c.line,
          start_line: c.start_line,
          original_start_line: c.start_line,
          side: c.side,
          start_side: c.start_side,
          subject_type: 'line',
          user: { ...db.brokerBot },
          body: prefixBody(human, c.body),
          created_at: at,
          updated_at: at,
          reactions: emptyReactions(commentId),
          html_url: `https://github.com/${db.repo.full_name}/pull/${input.prNumber}#discussion_r${commentId}`,
        }
        return {
          id: nodeId('PRRT', commentId),
          isResolved: false,
          isOutdated: false,
          path: c.path,
          line: c.line,
          originalLine: c.line,
          startLine: c.start_line,
          originalStartLine: c.start_line,
          diffSide: c.side,
          startDiffSide: c.start_side,
          subjectType: 'LINE',
          resolvedBy: null,
          comments: [comment],
        }
      })

      store.appendReview(input.prNumber, review, newThreads)
      if (snap) {
        snap.mutable.reviews.push(clone(review))
        snap.mutable.threads.push(...newThreads.map((t) => clone(t)))
        // Record every broker-authored comment this review opened in the write
        // log, so own-comment detection resolves them by author id.
        const authors = (snap.mutable.commentAuthors ??= {})
        for (const t of newThreads) {
          for (const c of t.comments) authors[c.id] = human.id
        }
        store.putSnapshot(snap)
      }
      store.deleteDraft(human.id, input.prNumber)
      // One API call regardless of comment count — writes are cheap.
      store.spendRate(1)
      return { status: 'ok', review }
    },

    async reconcileDraft(prNumber: number): Promise<ReconcileReport> {
      await delay('read')
      failReads()
      const human = currentHuman()
      const draft = store.getDraft(human.id, prNumber)
      if (!draft) {
        throw new ApiError(
          'not_found',
          `No draft exists for pull #${prNumber} — there is nothing to reconcile.`,
        )
      }
      const snap = store.getSnapshot(prNumber)
      if (!snap) {
        throw new ApiError(
          'not_found',
          `Pull #${prNumber} has no local snapshot — sync it before reconciling.`,
        )
      }
      const { files, blobIndex, commits, headSha } = snap.immutable

      // Each comment is classified against the side its anchor lives on
      // (base for LEFT, head for RIGHT), resolving the blob lines from the
      // store. This is the SAME shared decision the reconcile dialog previews
      // with, so a preview and this report never disagree.
      const results: AnchorResult[] = draft.comments.map((c) =>
        classifyPendingComment({
          comment: c,
          files,
          blobIndex,
          resolveBlobLines: (sha) => {
            const blob = store.getBlob(sha)
            return blob && !blob.binary ? blobContentToLines(blob.content) : null
          },
        }),
      )

      // Commits that landed after the draft was written. Preferred: slice the
      // snapshot's base→head commit list after the draft's head SHA. When the
      // draft's head predates the whole list (it fell out of the compare),
      // approximate by author date newer than the draft's creation — honest
      // enough for a prototype, and the count is what the UI communicates.
      const draftHeadIndex = commits.findIndex((c) => c.sha === draft.headSha)
      const newCommits: CommitInfo[] =
        draftHeadIndex >= 0
          ? commits.slice(draftHeadIndex + 1)
          : commits.filter((c) => c.commit.author.date > draft.createdAt)

      return {
        prNumber,
        draftHeadSha: draft.headSha,
        currentHeadSha: headSha,
        newCommits,
        results,
      }
    },

    async getDraft(prNumber: number): Promise<ReviewDraft | null> {
      await localDelay()
      return store.getDraft(currentHuman().id, prNumber)
    },

    async saveDraft(draft: ReviewDraft): Promise<ReviewDraft> {
      await delay('write')
      failWrites(
        'The broker did not answer — your draft was not saved. Your text is still in the editor; retry when the broker is reachable.',
      )
      const stored: ReviewDraft = { ...clone(draft), updatedAt: nowISO() }
      store.putDraft(stored)
      return stored
    },

    async discardDraft(prNumber: number): Promise<void> {
      await delay('write')
      failWrites('The broker did not answer — the draft was not discarded.')
      store.deleteDraft(currentHuman().id, prNumber)
    },

    async getFileViewed(prNumber: number): Promise<FileViewedState> {
      await localDelay()
      return store.getViewed(currentHuman().id, prNumber)
    },

    async setFileViewed(
      prNumber: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): Promise<FileViewedState> {
      await delay('write')
      failWrites('The broker did not answer — viewed state was not saved.')
      const humanId = currentHuman().id
      const viewedState = store.getViewed(humanId, prNumber)
      viewedState[path] = { viewed, blobSha, at: nowISO() }
      store.setViewed(humanId, prNumber, viewedState)
      return viewedState
    },

    async getPreferences(): Promise<HumanPreferences> {
      // Broker-side per-human state, cached locally — a local read that never
      // fails, so preferences survive offline exactly like drafts and viewed.
      await localDelay()
      return store.getPreferences(currentHuman().id)
    },

    async setPreferences(patch: Partial<HumanPreferences>): Promise<HumanPreferences> {
      await delay('write')
      failWrites('The broker did not answer — your preference was not saved.')
      return store.setPreferences(currentHuman().id, patch)
    },

    async getRateLimit(): Promise<RateLimitInfo> {
      await delay('read')
      failReads()
      return store.rateInfo()
    },
  }
  return api
}

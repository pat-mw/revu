import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { api } from '@/api'
import type { ApiError, GhUser, ReactionKey, ReactionRollup, ReviewComment, ReviewThread, Session, Snapshot } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import { qk, useSnapshot } from './queries'
import { useSession } from './session'

/**
 * Thread mutations, all optimistic against the snapshot cache — the snapshot
 * is the single source the review surfaces render from, so the optimistic
 * write lands exactly where the eventual server truth will. Every mutation
 * keeps a pre-write copy and rolls back to it on failure; user-typed text is
 * never lost (the rollback context carries it back to the composer).
 */

// ————————————————————————————————————————————————————————————————
// Snapshot-cache update helpers (immutable — new references throughout,
// so structural sharing and memoized renderers see the change).
// ————————————————————————————————————————————————————————————————

function withThread(
  snap: Snapshot,
  threadId: string,
  update: (t: ReviewThread) => ReviewThread,
): Snapshot {
  return {
    ...snap,
    mutable: {
      ...snap.mutable,
      threads: snap.mutable.threads.map((t) => (t.id === threadId ? update(t) : t)),
    },
  }
}

/** Replace the rollup on whichever comment (review or issue) carries the id. */
function withCommentRollup(
  snap: Snapshot,
  commentId: number,
  rollup: ReactionRollup,
): Snapshot {
  return {
    ...snap,
    mutable: {
      ...snap.mutable,
      threads: snap.mutable.threads.map((t) =>
        t.comments.some((c) => c.id === commentId)
          ? {
              ...t,
              comments: t.comments.map((c) =>
                c.id === commentId ? { ...c, reactions: rollup } : c,
              ),
            }
          : t,
      ),
      issueComments: snap.mutable.issueComments.map((c) =>
        c.id === commentId ? { ...c, reactions: rollup } : c,
      ),
    },
  }
}

function findRollup(snap: Snapshot, commentId: number): ReactionRollup | null {
  for (const t of snap.mutable.threads) {
    for (const c of t.comments) {
      if (c.id === commentId) return c.reactions
    }
  }
  for (const c of snap.mutable.issueComments) {
    if (c.id === commentId) return c.reactions
  }
  return null
}

function bumpRollup(rollup: ReactionRollup, key: ReactionKey): ReactionRollup {
  const next: ReactionRollup = { ...rollup }
  next[key] = rollup[key] + 1
  next.total_count = rollup.total_count + 1
  return next
}

function emptyRollup(): ReactionRollup {
  return {
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
  }
}

// ————————————————————————————————————————————————————————————————
// Synthetic reply construction
// ————————————————————————————————————————————————————————————————

/** Negative ids so a synthetic comment can never collide with a server id. */
let syntheticSeq = -1
function nextSyntheticId(): number {
  return syntheticSeq--
}

function brokerUser(login: string): GhUser {
  return { login, id: 0, node_id: '', avatar_url: '', html_url: '', type: 'Bot' }
}

/**
 * Builds the reply exactly as the server would return it: authored by the
 * broker bot, with the human identity smuggled into the body prefix — so the
 * render pipeline (identity parsing included) treats the optimistic comment
 * identically to the real one that replaces it.
 */
function syntheticReply(
  thread: ReviewThread,
  session: Session,
  body: string,
  id: number,
): ReviewComment {
  const first: ReviewComment | undefined = thread.comments[0]
  const at = new Date().toISOString()
  return {
    id,
    node_id: `pending_${-id}`,
    pull_request_review_id: first?.pull_request_review_id ?? null,
    in_reply_to_id: first?.id,
    path: thread.path,
    diff_hunk: first?.diff_hunk ?? '',
    commit_id: first?.commit_id ?? '',
    original_commit_id: first?.original_commit_id ?? '',
    line: thread.line,
    original_line: thread.originalLine,
    start_line: null,
    original_start_line: null,
    side: thread.diffSide,
    start_side: null,
    subject_type: thread.subjectType === 'FILE' ? 'file' : 'line',
    user: brokerUser(session.brokerLogin),
    body: prefixBody(session.human, body),
    created_at: at,
    updated_at: at,
    reactions: emptyRollup(),
    html_url: '',
  }
}

// ————————————————————————————————————————————————————————————————
// Hooks
// ————————————————————————————————————————————————————————————————

/**
 * Review threads for a PR, derived from the cached snapshot's mutable half.
 * `null` means the PR was never synced — distinct from "synced, no threads".
 */
export function useThreads(prNumber: number): ReviewThread[] | null {
  const snapshot = useSnapshot(prNumber).data
  return snapshot ? snapshot.mutable.threads : null
}

export interface ReplyVariables {
  threadId: string
  body: string
}

export interface ReplyContext {
  /** Snapshot cache before the optimistic append — the rollback target. */
  previousSnapshot: Snapshot | null | undefined
  /** Id of the optimistic comment, replaced by the server comment on success. */
  syntheticId: number
  /**
   * The exact markdown the user typed. On failure, callers refill the
   * composer from this — typed text is never lost to a failed write.
   */
  restoredText: string
}

/** Immediate (non-drafted) reply to an existing thread, optimistic. */
export function useReplyToThread(
  prNumber: number,
): UseMutationResult<ReviewComment, ApiError, ReplyVariables, ReplyContext> {
  const qc = useQueryClient()
  const session = useSession()
  return useMutation<ReviewComment, ApiError, ReplyVariables, ReplyContext>({
    mutationFn: ({ threadId, body }) => api.replyToThread(prNumber, threadId, body),
    onMutate: async ({ threadId, body }) => {
      await qc.cancelQueries({ queryKey: qk.snapshot(prNumber) })
      const previousSnapshot = qc.getQueryData<Snapshot | null>(qk.snapshot(prNumber))
      const syntheticId = nextSyntheticId()
      if (previousSnapshot) {
        const thread = previousSnapshot.mutable.threads.find((t) => t.id === threadId)
        if (thread) {
          const synthetic = syntheticReply(thread, session, body, syntheticId)
          qc.setQueryData<Snapshot | null>(
            qk.snapshot(prNumber),
            withThread(previousSnapshot, threadId, (t) => ({
              ...t,
              comments: [...t.comments, synthetic],
            })),
          )
        }
      }
      return { previousSnapshot, syntheticId, restoredText: body }
    },
    onError: (_error, _vars, context) => {
      if (context && context.previousSnapshot !== undefined) {
        qc.setQueryData(qk.snapshot(prNumber), context.previousSnapshot)
      }
    },
    onSuccess: (comment, { threadId }, context) => {
      const current = qc.getQueryData<Snapshot | null>(qk.snapshot(prNumber))
      if (current) {
        qc.setQueryData<Snapshot | null>(
          qk.snapshot(prNumber),
          withThread(current, threadId, (t) => {
            const hasSynthetic = t.comments.some((c) => c.id === context.syntheticId)
            return {
              ...t,
              comments: hasSynthetic
                ? t.comments.map((c) => (c.id === context.syntheticId ? comment : c))
                : [...t.comments, comment],
            }
          }),
        )
      } else {
        void qc.invalidateQueries({ queryKey: qk.snapshot(prNumber) })
      }
      void qc.invalidateQueries({ queryKey: qk.rate })
    },
  })
}

export interface ResolveVariables {
  threadId: string
  resolved: boolean
}

interface ResolveContext {
  previousSnapshot: Snapshot | null | undefined
}

/** Resolve/unresolve a thread — optimistic flip with rollback. */
export function useResolveThread(
  prNumber: number,
): UseMutationResult<ReviewThread, ApiError, ResolveVariables, ResolveContext> {
  const qc = useQueryClient()
  const session = useSession()
  return useMutation<ReviewThread, ApiError, ResolveVariables, ResolveContext>({
    mutationFn: ({ threadId, resolved }) => api.resolveThread(prNumber, threadId, resolved),
    onMutate: async ({ threadId, resolved }) => {
      await qc.cancelQueries({ queryKey: qk.snapshot(prNumber) })
      const previousSnapshot = qc.getQueryData<Snapshot | null>(qk.snapshot(prNumber))
      if (previousSnapshot) {
        qc.setQueryData<Snapshot | null>(
          qk.snapshot(prNumber),
          withThread(previousSnapshot, threadId, (t) => ({
            ...t,
            isResolved: resolved,
            // GitHub records the resolver as the shared bot — mirror that.
            resolvedBy: resolved ? { login: session.brokerLogin } : null,
          })),
        )
      }
      return { previousSnapshot }
    },
    onError: (_error, _vars, context) => {
      if (context && context.previousSnapshot !== undefined) {
        qc.setQueryData(qk.snapshot(prNumber), context.previousSnapshot)
      }
    },
    onSuccess: (serverThread, { threadId }) => {
      const current = qc.getQueryData<Snapshot | null>(qk.snapshot(prNumber))
      if (current) {
        qc.setQueryData<Snapshot | null>(
          qk.snapshot(prNumber),
          withThread(current, threadId, (t) => ({
            ...t,
            isResolved: serverThread.isResolved,
            isOutdated: serverThread.isOutdated,
            resolvedBy: serverThread.resolvedBy,
          })),
        )
      }
      void qc.invalidateQueries({ queryKey: qk.rate })
    },
  })
}

export interface ReactionVariables {
  commentId: number
  reaction: ReactionKey
}

interface ReactionContext {
  previousSnapshot: Snapshot | null | undefined
}

/**
 * Add a reaction — optimistic rollup bump with rollback. The server may
 * return an UNCHANGED rollup: every human here is the same bot to GitHub, so
 * a second identical reaction dedupes to nothing. `onSuccess` reconciles the
 * cache to the server rollup silently either way — no error, no toast; the
 * shared-identity constraint is just how the world is.
 */
export function useAddReaction(
  prNumber: number,
): UseMutationResult<ReactionRollup, ApiError, ReactionVariables, ReactionContext> {
  const qc = useQueryClient()
  return useMutation<ReactionRollup, ApiError, ReactionVariables, ReactionContext>({
    mutationFn: ({ commentId, reaction }) => api.addReaction(prNumber, commentId, reaction),
    onMutate: async ({ commentId, reaction }) => {
      await qc.cancelQueries({ queryKey: qk.snapshot(prNumber) })
      const previousSnapshot = qc.getQueryData<Snapshot | null>(qk.snapshot(prNumber))
      if (previousSnapshot) {
        const rollup = findRollup(previousSnapshot, commentId)
        if (rollup) {
          qc.setQueryData<Snapshot | null>(
            qk.snapshot(prNumber),
            withCommentRollup(previousSnapshot, commentId, bumpRollup(rollup, reaction)),
          )
        }
      }
      return { previousSnapshot }
    },
    onError: (_error, _vars, context) => {
      if (context && context.previousSnapshot !== undefined) {
        qc.setQueryData(qk.snapshot(prNumber), context.previousSnapshot)
      }
    },
    onSuccess: (serverRollup, { commentId }) => {
      const current = qc.getQueryData<Snapshot | null>(qk.snapshot(prNumber))
      if (current) {
        qc.setQueryData<Snapshot | null>(
          qk.snapshot(prNumber),
          withCommentRollup(current, commentId, serverRollup),
        )
      }
      void qc.invalidateQueries({ queryKey: qk.rate })
    },
  })
}

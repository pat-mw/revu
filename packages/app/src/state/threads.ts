import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { api } from '@/api'
import type { ApiError, GhUser, ReactionKey, ReactionRollup, ReviewComment, ReviewThread, Session, Snapshot } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import type { ReviewMode } from '@/lib/review-mode'
import { reviewMode } from '@/lib/review-mode'
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

/** Record a comment's author in the snapshot's write log (a new reference). */
function withCommentAuthor(snap: Snapshot, commentId: number, humanId: string): Snapshot {
  return {
    ...snap,
    mutable: {
      ...snap.mutable,
      commentAuthors: { ...snap.mutable.commentAuthors, [commentId]: humanId },
    },
  }
}

/** Drop a comment id from the write log (used to clear an orphaned synthetic id). */
function dropCommentAuthor(snap: Snapshot, commentId: number): Snapshot {
  const authors = snap.mutable.commentAuthors
  if (!authors || !(commentId in authors)) return snap
  const { [commentId]: _dropped, ...rest } = authors
  return { ...snap, mutable: { ...snap.mutable, commentAuthors: rest } }
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

/**
 * An author on the github.com side, as much of one as an optimistic comment can
 * know. The login is certain — it is the account the write authenticates as —
 * while the numeric id, node id and URLs are minted by github.com and arrive
 * with the stored comment. They are left empty rather than guessed: an empty
 * avatar already means "no avatar" to every renderer, and nothing downstream
 * reads a comment author's ids.
 */
function pendingGithubUser(login: string, type: GhUser['type']): GhUser {
  return { login, id: 0, node_id: '', avatar_url: '', html_url: '', type }
}

/**
 * The sentinel author a local write records. The display name rides in `login`,
 * the only name-shaped field a GitHub user has; `id: 0` sits outside every real
 * band (GitHub ids are positive and nothing local mints them); `type: 'Bot'`
 * marks it as not a genuine GitHub account; the URLs are empty because there is
 * nothing on github.com to link to. The email never appears — it is a storage
 * key, not something to render.
 */
function localReviewer(name: string): GhUser {
  return {
    login: name,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }
}

/**
 * Whether writes from this session go out as one shared bot — which decides
 * both who authors a mediated comment and whether its body carries the human's
 * smuggled `**Name** (role)` prefix.
 *
 * `brokerLogin` is the fact: it is the empty "no bot" sentinel when the session
 * writes as a real GitHub user or has no write identity at all, and the bot's
 * login when one shared account fronts many humans. That is the same fact the
 * write path branches on, so reading it here keeps the optimistic comment and
 * the stored one derived from one condition instead of two that can drift
 * apart.
 */
function stampsWrites(session: Session): boolean {
  return session.brokerLogin !== ''
}

/**
 * The body an optimistic reply should carry: stamped only when the session
 * stamps AND the reply lands on a pull request.
 *
 * A stamp exists solely to distinguish humans who share one account. Applying
 * it where nothing is shared puts `**Name** (role)` into the rendered comment
 * as literal markdown until the unstamped stored comment replaces it, because
 * the identity parser only strips a prefix off a comment authored by the bot.
 *
 * Both halves of the condition are real. A session with no bot never stamps
 * anything. A local review is never stamped even under a session that carries
 * a bot, because a local write is never mediated by an account at all: it is
 * stored verbatim beside a record of who wrote it, so the identity a stamp
 * would smuggle is already held structurally.
 */
export function optimisticBody(session: Session, mode: ReviewMode, body: string): string {
  if (mode === 'local' || !stampsWrites(session)) return body
  return prefixBody(session.human, body)
}

/**
 * Who an optimistic resolve is attributed to: the identity the write records,
 * which is a different identity on a local review than on a pull request.
 *
 * A local resolution names the reviewer's display name, because there is no
 * account behind it to name and an email is never rendered. On a pull request
 * the session's own login is what lands: with a shared bot it IS the bot login,
 * and without one it is the real authenticated user. The display name is also
 * the last resort for a session carrying no login at all — that shape cannot
 * write, but a derivation that can return an empty login is one an empty login
 * can reach the screen through, and the resolved-by line renders whatever it is
 * given.
 */
export function optimisticResolvedBy(session: Session, mode: ReviewMode): { login: string } {
  if (mode === 'local') return { login: session.human.name }
  if (session.viewerLogin !== undefined && session.viewerLogin !== '') {
    return { login: session.viewerLogin }
  }
  if (session.brokerLogin !== '') return { login: session.brokerLogin }
  return { login: session.human.name }
}

/**
 * Who an optimistic reply is authored by: the identity the write path records,
 * which is a different identity on a local review, under a shared bot, and
 * under a session that reaches GitHub as itself.
 *
 * The optimistic comment is replaced by the stored one on success, so an author
 * that disagrees is a visible change of face under the reader — and the widest
 * disagreement available is an author with no login at all, which is what a
 * session carrying no shared account holds.
 *
 * A local reply is authored by the sentinel local reviewer under EVERY session,
 * because a local write is never mediated by an account: the local branch of
 * the write path is taken above the account it would otherwise write through,
 * so a bot the session happens to carry never reaches the stored comment. On a
 * pull request the shared bot is the author wherever one exists, since every
 * mediated write really is posted by that one account; without one the session
 * writes to GitHub as the authenticated viewer, and that login is what lands.
 *
 * The last branch is a session with no write identity at all — a shape whose
 * writes are refused before they reach GitHub. It converges on nothing because
 * nothing is ever stored; it only has to be total and nameable, and a display
 * name is the one name such a session holds. It is kept separate from the local
 * branch whose login it coincides with: the two carry the same name for
 * unrelated reasons, and folding them together would read as a rule.
 */
export function optimisticAuthor(session: Session, mode: ReviewMode): GhUser {
  if (mode === 'local') return localReviewer(session.human.name)
  if (stampsWrites(session)) return pendingGithubUser(session.brokerLogin, 'Bot')
  if (session.viewerLogin !== undefined && session.viewerLogin !== '') {
    return pendingGithubUser(session.viewerLogin, 'User')
  }
  return pendingGithubUser(session.human.name, 'Bot')
}

/**
 * Builds the reply exactly as the write path would return it: authored by the
 * identity that write records, and stamped only where that write path stamps —
 * so the render pipeline (identity parsing included) treats the optimistic
 * comment identically to the real one that replaces it.
 */
function syntheticReply(
  thread: ReviewThread,
  session: Session,
  mode: ReviewMode,
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
    user: optimisticAuthor(session, mode),
    body: optimisticBody(session, mode, body),
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
          const synthetic = syntheticReply(thread, session, reviewMode(prNumber), body, syntheticId)
          const withReply = withThread(previousSnapshot, threadId, (t) => ({
            ...t,
            comments: [...t.comments, synthetic],
          }))
          // Record the optimistic comment's author in the snapshot's write log
          // so its "(you)" affordance resolves by id, exactly as the server
          // comment that replaces it will.
          qc.setQueryData<Snapshot | null>(
            qk.snapshot(prNumber),
            withCommentAuthor(withReply, syntheticId, session.human.id),
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
        const swapped = withThread(current, threadId, (t) => {
          const hasSynthetic = t.comments.some((c) => c.id === context.syntheticId)
          return {
            ...t,
            comments: hasSynthetic
              ? t.comments.map((c) => (c.id === context.syntheticId ? comment : c))
              : [...t.comments, comment],
          }
        })
        // Re-key the write log from the optimistic id onto the server id so the
        // comment's author survives the swap; drop the now-orphaned synthetic
        // entry.
        const prior = swapped.mutable.commentAuthors ?? {}
        const author = prior[context.syntheticId] ?? session.human.id
        const rekeyed = withCommentAuthor(swapped, comment.id, author)
        qc.setQueryData<Snapshot | null>(
          qk.snapshot(prNumber),
          dropCommentAuthor(rekeyed, context.syntheticId),
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
            // Attribute to the acting identity, which is what the write records
            // — an optimistic resolver that disagrees swaps under the reader on
            // success, because `onSuccess` copies `resolvedBy` from the response.
            resolvedBy: resolved ? optimisticResolvedBy(session, reviewMode(prNumber)) : null,
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

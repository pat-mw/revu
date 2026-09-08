/**
 * The pieces every local-review conformance block is built from, in one place
 * so two blocks driving the same surface cannot drift on any of them.
 *
 * Three kinds of thing live here:
 *
 * - The config shapes a runner fills in — a branch pair, an anchor, and the
 *   `Lazy` wrapper that lets either arrive after the runner's own setup has
 *   run rather than when the block is registered.
 * - `Answered`, the promise-tolerant method shape. Every call in a block is
 *   awaited, so an in-process engine whose reads answer SYNCHRONOUSLY is held
 *   to the same assertions as a transport that answers over the wire, with no
 *   adapter in between and no assertion about the shape of the answer.
 * - The three fixtures a block writes with: a pending comment on the runner's
 *   anchor, a draft on one review against one head, and a rejection captured
 *   whole so its code and message can both be read.
 *
 * Like the blocks themselves this imports only the shared contract, so
 * `shared` stays a leaf.
 */
import { ApiError } from '../src/index.ts'
import type { LocalReviewSummary, PendingComment, ReviewDraft } from '../src/index.ts'

/** Where a submitted comment on the runner's branch pair can anchor. */
export interface LocalReviewAnchor {
  /** A path the reviewed range changes, or that the runner's diff carries. */
  path: string
  line: number
  /** The text of that line on the head side, captured as an editor would. */
  lineText: string
}

/** A branch pair an implementation can create a review of, as the client would spell it. */
export interface LocalReviewPair {
  baseRef: string
  headRef: string
}

/**
 * A value, or a function that produces it once the runner's own setup has run.
 * A runner over a seeded repository only knows its branch names after the
 * repository exists, and a runner over a daemon only knows its session after
 * the daemon answers — both later than the block is registered.
 */
export type Lazy<T> = T | (() => T | Promise<T>)

/** Read a lazy config value, whether it was given directly or as a producer. */
export async function resolve<T>(value: Lazy<T>): Promise<T> {
  return typeof value === 'function' ? (value as () => T | Promise<T>)() : value
}

/** An answer accepted whether or not it arrives as a promise. */
export type MaybePromise<T> = T | Promise<T>

/** One contract method, with its answer accepted whether or not it arrives as a promise. */
export type Answered<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => MaybePromise<Awaited<R>>
  : never

/**
 * A pending comment on the runner's anchor, keyed under `keyPrefix` so two
 * blocks writing drafts on the same anchor cannot mint the same comment key.
 */
export function pendingAt(
  anchor: LocalReviewAnchor,
  body: string,
  keyPrefix: string,
): PendingComment {
  const at = new Date().toISOString()
  return {
    key: `${keyPrefix}-${anchor.line}`,
    path: anchor.path,
    side: 'RIGHT',
    start_side: null,
    line: anchor.line,
    start_line: null,
    body,
    createdAt: at,
    updatedAt: at,
    anchor: { lineText: anchor.lineText, contextBefore: [], contextAfter: [] },
  }
}

/** A draft on one review against one head, keyed to the session's human. */
export function draftOn(
  humanId: string,
  review: LocalReviewSummary,
  head: { headSha: string; compareKey: string },
  content: { body: string; comments: PendingComment[] },
): ReviewDraft {
  const at = new Date().toISOString()
  return {
    humanId,
    prNumber: review.id,
    headSha: head.headSha,
    compareKey: head.compareKey,
    body: content.body,
    event: 'COMMENT',
    comments: content.comments,
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * One call's rejection, captured whole so its code and message can both be
 * read. Takes the call rather than its promise so an adapter that throws
 * synchronously is captured the same way as one that rejects.
 */
export async function rejection(call: () => unknown): Promise<ApiError | null> {
  try {
    await call()
    return null
  } catch (e) {
    return e instanceof ApiError ? e : null
  }
}

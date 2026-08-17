/**
 * The write sink for a LOCAL review — a review of a branch that has no pull
 * request, which lives and is answered entirely on this machine. Four verbs:
 * submit a review, reply to a thread, resolve a thread, add a reaction.
 *
 * Nothing any of them produces is ever posted anywhere, and that property is
 * STRUCTURAL rather than conditional. This module holds no client for a remote
 * forge, no write decorator and no command runner, so there is no branch that
 * could decide to reach out and no injected seam a later change could repoint at
 * something that does. Its whole import surface is the shared contract types.
 *
 * Three seams the GitHub write core injects are absent here on purpose, and each
 * absence is a decision rather than an omission.
 *
 * NO GITHUB CLIENT. There is nothing to post, so there is nothing to post it
 * with. The seam is not present at all, which is what makes the guarantee
 * checkable from the outside: a reader — or a source scan — can see that the
 * capability is missing rather than having to prove that every code path
 * declines to use it. The name is written here in prose deliberately: the
 * structural scan that enforces this reads import statements, not sentences, so
 * an explanation cannot trip it and cannot be deleted to green it. One form that
 * scan cannot anchor to the start of a line is the expression form of an import,
 * so the rule this file follows is to name a module in prose and never write a
 * quoted module path in a comment — which would be read as a real import, and
 * would fail loudly rather than quietly.
 *
 * NO WRITE DECORATOR. The injected decorator the GitHub write core carries does
 * two things, and both are inert on a local review:
 *
 *   - `decorateBody` stamps a comment body with the writing human's display
 *     name. That exists because many humans share one bot account upstream and
 *     the body is the only channel that survives. A local comment has no shared
 *     account to disambiguate and is never stamped: authorship is recorded as a
 *     key beside the comment, where it cannot be rendered as text.
 *   - `recordWrite` appends an audit row. The journal's subject is writes that
 *     reached the forge, and a local write reaches nothing, so there is nothing
 *     to attest.
 *
 * Both halves being inert, the seam is OMITTED rather than injected as a pair of
 * no-ops. That is the stronger half of the reasoning: an injected decorator is a
 * live socket for the wrong strategy. The stamping-and-journalling one could
 * later be wired in by a change that looks like configuration, and locally
 * minted ids — which name objects that exist nowhere but this disk — would start
 * entering the audit journal, whose rows are read as ground truth about what
 * exists upstream. An absent seam cannot be filled by accident.
 *
 * NO COMMAND RUNNER. Head resolution arrives as an injected `resolveHead`, so
 * this module runs no subprocess at all: it never assembles a git argument list
 * and therefore cannot mishandle a ref name beginning with a dash, which git
 * reads as a flag rather than as a ref. That hardening belongs to the resolver
 * that actually runs git; a second copy here would either duplicate it or, worse,
 * reimplement half of it.
 *
 * The store slice below is declared as its own interface rather than picked off
 * the durable store's type. The port then states exactly what a local write
 * needs and nothing more, and any store whose methods match it structurally can
 * satisfy it — an in-memory one in tests, the durable one in the daemon —
 * without this module depending on either.
 *
 * THE FOUR SIGNATURES ARE FINAL; THEIR BEHAVIOUR IS NOT WRITTEN YET. Each verb's
 * docstring states the contract its signature commits to, and each body refuses
 * rather than answering until that contract can be met in full. A refusal is the
 * only other honest answer a write verb has: the caller reads a successful submit
 * as permission to discard the draft it just sent, so a verb that answered while
 * materializing nothing would destroy the reviewer's text with no error anywhere
 * to notice. That is why no body here returns a placeholder value, and why the
 * refusals are asserted by this module's tests rather than merely present.
 */
import type {
  ReactionKey,
  ReactionRollup,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Session,
  Snapshot,
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'

/**
 * The narrow slice of durable storage a local write touches, and nothing wider.
 *
 * Every method is keyed by the local review's synthetic id, and the two draft
 * methods additionally by the human, exactly as the durable store keys them —
 * one human's draft is never reachable under another's key. There is
 * deliberately no draft WRITER here: a local write may read a draft and, on a
 * confirmed success, delete it, but it never rewrites one. That is the narrowest
 * surface that can honour "a draft is deleted only on confirmed success", and a
 * surface that cannot rewrite a draft cannot silently mangle one either.
 */
export interface LocalWriteStore {
  /**
   * The stored snapshot for a local review, or `null` when it has never been
   * synced. `null` is an answer, not a failure: a local review can exist with no
   * snapshot behind it, and a write has to say so rather than materialize into
   * nowhere.
   */
  getLocalSnapshot(localId: number): Snapshot | null
  /** Persist the whole snapshot envelope, threads and authorship map included. */
  putLocalSnapshot(snapshot: Snapshot): void
  /** Upsert one thread of a local review, replacing any prior row for that thread id. */
  putLocalThread(localId: number, thread: ReviewThread): void
  /**
   * Persist a submitted review summary against the local review. It is stored
   * here and nowhere else — in particular it is never appended to a snapshot's
   * submitted-review list, which stays empty on a local review for its whole
   * life so the surfaces that read it keep telling the truth.
   */
  putLocalReviewSummary(localId: number, review: ReviewSummary): void
  /**
   * The human's draft for a local review, or `null` when none is stored. The
   * document is an ordinary review draft whose pull-request field carries the
   * local review's synthetic id — there is no separate local draft type, so the
   * pure re-anchoring helpers keep working on it unchanged.
   */
  getLocalDraft(humanId: string, localId: number): ReviewDraft | null
  /** Remove exactly one human's draft for one local review. */
  deleteLocalDraft(humanId: string, localId: number): void
}

/**
 * Everything a local write needs, injected so the sink is exercisable against
 * in-memory fakes with no daemon, no disk and no forge.
 *
 * The store slice is spread flat rather than nested under a `store` member so
 * the port's whole surface is one list of names — which is what lets a single
 * assertion pin it and notice a member arriving or leaving.
 *
 * What is NOT here is as much a part of the contract as what is: no client, no
 * decorator, no runner. See this module's header for why each is absent.
 */
export interface LocalWriteDeps extends LocalWriteStore {
  /** Who is writing. `human.id` is the authorship key; it never enters a body. */
  session: Session
  /**
   * The local branch's current head and its commit count, resolved by the
   * caller. Injected as a resolved function rather than as a process runner so
   * this module spawns nothing and ref-name hardening lives in exactly one
   * place.
   */
  resolveHead: () => Promise<{ sha: string; commitCount: number }>
  /**
   * Allocate the next id for a locally created comment or review summary.
   * Strictly positive and monotonic — negative ids belong to the optimistic
   * entries the client mints before a write lands, and colliding with one would
   * orphan the entry it was meant to replace. Injected because the durable
   * high-water mark is the store's to own, not this module's.
   */
  nextEntityId: () => number
  /** Timestamp source; injectable so stored documents are deterministic in tests. */
  now?: () => string
}

/**
 * Refuse a verb whose behaviour has not been written, loudly, and report the two
 * facts a caller needs: what was asked, and that the review's draft is untouched.
 *
 * A local write verb has exactly two honest answers — a complete value, or a
 * failure — and until the value can be produced the failure is the only one
 * available. Answering anything else would be the worst outcome this path can
 * produce: the client treats a successful submit as permission to discard the
 * draft it just sent, so a verb that reported success while materializing
 * nothing would delete the reviewer's text and leave no trace of it anywhere.
 * Throwing keeps the draft, because a thrown verb has provably not reached the
 * one call that deletes it.
 */
function refuseUnwritten(
  verb: string,
  deps: LocalWriteDeps,
  localId: number,
  request: Readonly<Record<string, string | number | boolean>>,
): never {
  const asked = Object.entries(request)
    .map(([field, value]) => `${field}=${value}`)
    .join(' ')
  const draftHeld = deps.getLocalDraft(deps.session.human.id, localId) !== null
  throw new Error(
    `revud: the local write verb ${verb} has no behaviour written for it, so it ` +
      `materialized nothing and deleted no draft (local review ${localId}; ${asked}; ` +
      `draft ${draftHeld ? 'still stored' : 'absent'}). Returning a value instead ` +
      `would tell the caller the write landed and let it discard the submitted ` +
      `draft — the one outcome this path exists to prevent.`,
  )
}

/**
 * Submit a local review: guard the head, materialize one thread per pending
 * comment plus one review summary, then — and only then — delete the draft.
 *
 * A moved head is a RETURNED value and never a throw, so the caller routes into
 * reconcile with its draft intact; that matters more on a local review than on a
 * pull request, because an amend or a rebase moves the head with no event
 * anywhere to announce it. There is no self-review rule to enforce, since no
 * forge identity opened anything, so every verdict stays available and the
 * refusal variant of the result is unreachable here. The idempotency re-check
 * and the server-side re-validation the remote path carries both exist to absorb
 * a lost network response; a synchronous local sink has none, so neither appears.
 *
 * The contract above is what this signature commits to, not what the body does
 * today: the behaviour is unwritten and the verb refuses.
 */
export async function submitLocalReview(
  deps: LocalWriteDeps,
  input: SubmitReviewInput,
): Promise<SubmitResult> {
  return refuseUnwritten('submitLocalReview', deps, input.prNumber, {
    event: input.event,
    expectedHeadSha: input.expectedHeadSha,
    pendingComments: input.comments.length,
  })
}

/**
 * Reply to a thread of a local review, returning the created comment.
 *
 * The reply is addressed to the thread as a whole and derives its own fields
 * from the thread's first comment, mirroring how the read path shapes a thread,
 * so a reply and a re-read produce structurally identical comments. Its body is
 * stored exactly as written — no stamping — and its id comes from the positive
 * local band, because the client swaps its optimistic entry by id and a
 * duplicate or negative id would orphan that entry.
 *
 * The contract above is what this signature commits to, not what the body does
 * today: the behaviour is unwritten and the verb refuses.
 */
export async function replyToLocalThread(
  deps: LocalWriteDeps,
  localId: number,
  threadId: string,
  body: string,
): Promise<ReviewComment> {
  return refuseUnwritten('replyToLocalThread', deps, localId, {
    threadId,
    bodyLength: body.length,
  })
}

/**
 * Resolve or unresolve a thread of a local review, returning the WHOLE stored
 * thread with only its resolution fields changed.
 *
 * Returning the stored thread rather than a rebuilt one is the point: the client
 * copies the resolution fields straight out of this answer, so a thread
 * reassembled from parts would quietly overwrite cached state — an outdated
 * thread flipped back to current, with no error anywhere to notice it.
 *
 * The contract above is what this signature commits to, not what the body does
 * today: the behaviour is unwritten and the verb refuses.
 */
export async function resolveLocalThread(
  deps: LocalWriteDeps,
  localId: number,
  threadId: string,
  resolved: boolean,
): Promise<ReviewThread> {
  return refuseUnwritten('resolveLocalThread', deps, localId, { threadId, resolved })
}

/**
 * Add a reaction to a comment of a local review and return the comment's new
 * rollup.
 *
 * A local review's conversation-tab comments are always empty, so the
 * two-namespace classification the remote path needs collapses to a single
 * lookup across the review's threads, and an id found nowhere is a plain
 * not-found. A repeat of the same reaction returns the rollup unchanged, which
 * is honest rather than a stub: there is exactly one author here, the counts
 * cannot go higher, and the client reconciles an unchanged rollup silently.
 *
 * The contract above is what this signature commits to, not what the body does
 * today: the behaviour is unwritten and the verb refuses.
 */
export async function addLocalReaction(
  deps: LocalWriteDeps,
  localId: number,
  commentId: number,
  reaction: ReactionKey,
): Promise<ReactionRollup> {
  return refuseUnwritten('addLocalReaction', deps, localId, { commentId, reaction })
}

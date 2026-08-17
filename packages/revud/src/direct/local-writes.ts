/**
 * The write sink for a LOCAL review — a review of a branch that has no pull
 * request, which lives and is answered entirely on this machine. Four verbs:
 * submit a review, reply to a thread, resolve a thread, add a reaction.
 *
 * Nothing any of them produces is ever posted anywhere, and that property is
 * STRUCTURAL rather than conditional. This module holds no client for a remote
 * forge, no write decorator and no command runner, so there is no branch that
 * could decide to reach out and no injected seam a later change could repoint at
 * something that does. Its whole import surface is the shared contract types and
 * the sibling that names locally created objects, which itself imports nothing
 * but those same types.
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
 * THE FOUR SIGNATURES ARE FINAL; ONE OF THE FOUR BEHAVIOURS IS WRITTEN. Submit
 * is implemented below. The remaining three verbs' docstrings state the contract
 * each signature commits to, and each of those bodies refuses rather than
 * answering until that contract can be met in full. A refusal is the only other
 * honest answer a write verb has: the caller reads a successful submit as
 * permission to discard the draft it just sent, so a verb that answered while
 * materializing nothing would destroy the reviewer's text with no error anywhere
 * to notice. That is why no body here returns a placeholder value, and why the
 * refusals are asserted by this module's tests rather than merely present.
 *
 * PERSIST FIRST, DELETE THE DRAFT LAST. Every write here that materializes state
 * writes that state through the store and only then, on a confirmed success,
 * removes the reviewer's draft. The rule reads as pedantry on a synchronous
 * local sink, where the success is trivially reachable, and it is coded
 * explicitly for exactly that reason: the ordering is what the guarantee IS, and
 * an ordering that holds by accident today is one an unrelated edit can reverse
 * without anything noticing. The client treats a successful submit as permission
 * to clear the draft it just sent and to re-read the review expecting the new
 * threads, so an answer of success with nothing stored deletes the reviewer's
 * text and shows them nothing in its place.
 */
import type {
  GhUser,
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
import { ApiError } from '@revu/shared'
import { mintLocalEntityId, mintLocalThreadId } from './local-ids'

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
 * The review state each verdict is recorded as, in the same vocabulary a review
 * of a pull request is recorded in.
 *
 * Every verdict stays available on a local review. The self-review rule that
 * makes one of them refusable upstream is a forge rule about who opened the
 * thing being reviewed, and nobody opened this: there is no remote object, no
 * author account and no reviewer account, so there is nothing for such a rule to
 * compare. A verdict here is the reviewer's own note to themselves about work
 * they are about to push, and refusing to record one would remove the only
 * reason the verdicts exist locally.
 */
const EVENT_STATE: Record<SubmitReviewInput['event'], ReviewSummary['state']> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
}

/**
 * The author a locally created comment or review summary carries.
 *
 * Everything about it is chosen so that it cannot be mistaken for an account and
 * cannot leak an address. The reviewer's git-config display NAME is the only
 * field with content — never their email, which is the key their drafts and
 * their authorship entries are stored under and which must never reach anything
 * rendered as text. The numeric id is zero and the avatar and profile links are
 * empty because there is no account behind this and no page to link to; a
 * fabricated id or URL would be an invitation to dereference something that does
 * not exist. The account type says machine rather than person for the same
 * reason: this value is synthesized to fill a required field, not read from
 * anywhere.
 *
 * Nothing keys off it. Ownership of a local comment is decided by the authorship
 * map stored beside the comment, which is why this value can afford to carry no
 * identity at all.
 */
function localAuthor(displayName: string): GhUser {
  return {
    login: displayName,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }
}

/** The rollup a freshly created comment carries: every count zero, no resource behind it. */
function zeroedReactions(): ReactionRollup {
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

/** The one clock every document a single write creates is stamped from. */
function timestamp(deps: LocalWriteDeps): string {
  return deps.now?.() ?? new Date().toISOString()
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
 * Three steps here, where a review of a pull request takes five. A moved head is a
 * RETURNED value and never a throw, so the caller routes into reconcile with its
 * draft intact; that matters more on a local review than on a pull request,
 * because an amend or a rebase moves the head with no event anywhere to announce
 * it. There is no self-review rule to enforce, since no forge identity opened
 * anything, so every verdict stays available and the refusal variant of the
 * result is unreachable here. The idempotency re-check and the server-side
 * re-validation the remote path carries both exist to absorb a lost network
 * response; a synchronous local sink has none, so neither appears.
 *
 * A REVIEW WITH NO STORED SNAPSHOT CANNOT BE SUBMITTED, and that is checked
 * before the head guard rather than after it. The threads this creates are
 * carried by the snapshot, so with no snapshot there is nowhere for them to land
 * and no compare standing behind the head the draft quotes — answering "the head
 * moved" would send the reviewer to reconcile against a state that does not
 * exist. The honest answer names the fix, which is to sync first.
 *
 * WHAT IS WRITTEN, AND WHERE. Each pending comment becomes one thread holding
 * one comment, both named from the local band, with the body stored exactly as
 * written. Bodies are never stamped with the author's name: a stamp exists only
 * where many people write through one shared account and the text is the only
 * channel that survives, and here the author is recorded as a KEY beside the
 * comment — in the snapshot's authorship map, whose values the contract states
 * are never rendered. That map is not decorative. Deciding whether a comment is
 * the reader's own has three signals, and the other two are a stamped name and a
 * match against the reader's forge login: with nothing stamped and no forge
 * login behind a synthesized author, the map is the only signal that can answer,
 * so a comment created without an entry in it is permanently unattributable.
 *
 * The review summary goes to its own store and is NEVER appended to the
 * snapshot's submitted-review list, which stays empty on a local review for its
 * whole life. So does the conversation-level comment list. Those two lists being
 * permanently empty is what several surfaces read as "this review has only
 * threads", and one appended summary would quietly falsify all of them.
 *
 * THE WRITE ORDER, AND THE ONE WINDOW IT CANNOT CLOSE. Threads, then the
 * summary, then the snapshot envelope carrying both the new threads and the new
 * authorship entries, and only then the draft. Any of those failing leaves the
 * draft exactly where it was, which is the whole point of the ordering. The
 * residue is the last step: a draft deletion that fails AFTER the review has
 * been materialized is reported as a persistence failure, so the caller sees a
 * rejection for a submit that actually landed — and because nothing here
 * re-checks for an already-created review, a resubmit materializes the comments
 * a second time. That is the accepted cost of the ordering, and it is the right
 * side to err on: a duplicated thread is visible and can be deleted, while text
 * deleted after a write that did not land is gone.
 */
export async function submitLocalReview(
  deps: LocalWriteDeps,
  input: SubmitReviewInput,
): Promise<SubmitResult> {
  const localId = input.prNumber
  const humanId = deps.session.human.id

  const snapshot = deps.getLocalSnapshot(localId)
  if (snapshot === null) {
    throw new ApiError(
      'unprocessable',
      `Local review ${localId} has no stored snapshot for its threads to appear in — ` +
        `sync it, then submit.`,
    )
  }

  // 1. Head guard. A mismatch is a returned value, never a throw, and nothing
  //    below this point runs: no document is created and the draft is untouched.
  const head = await deps.resolveHead()
  if (head.sha !== input.expectedHeadSha) {
    return {
      status: 'head_moved',
      currentHeadSha: head.sha,
      // Best effort, and honestly under-reported: this is the count the branch
      // carries now against the count the stored compare was built from, so a
      // rebase that rewrites commits without adding any reports zero while the
      // head really has moved. The sha mismatch is the signal; this number only
      // sizes it, and reconcile refines it against a freshly synced compare.
      newCommits: Math.max(0, head.commitCount - snapshot.immutable.commits.length),
    }
  }

  // 2. Materialize. Every id comes from the injected allocator through the
  //    minters, so nothing here invents a name of its own.
  const at = timestamp(deps)
  const author = localAuthor(deps.session.human.name)
  const reviewId = mintLocalEntityId(deps.nextEntityId)
  const review: ReviewSummary = {
    id: reviewId,
    node_id: `local:review:${reviewId}`,
    user: author,
    // Verbatim. See this function's docstring for why nothing here stamps.
    body: input.body,
    state: EVENT_STATE[input.event],
    submitted_at: at,
    commit_id: head.sha,
  }

  const authored: Record<number, string> = {}
  const threads: ReviewThread[] = input.comments.map((pending) => {
    const commentId = mintLocalEntityId(deps.nextEntityId)
    authored[commentId] = humanId
    const comment: ReviewComment = {
      id: commentId,
      node_id: `local:comment:${commentId}`,
      pull_request_review_id: reviewId,
      path: pending.path,
      // The minimal single-line header rather than a slice of the real patch.
      // A comment's hunk is rendered only once its thread has gone outdated,
      // and a thread created against the head currently checked out is by
      // definition current, so nothing reads this until a later sync has had
      // the chance to replace it with a hunk cut from the diff it belongs to.
      diff_hunk: `@@ -${pending.line},1 +${pending.line},1 @@`,
      commit_id: head.sha,
      original_commit_id: head.sha,
      line: pending.line,
      original_line: pending.line,
      start_line: pending.start_line,
      original_start_line: pending.start_line,
      side: pending.side,
      start_side: pending.start_side,
      subject_type: 'line',
      user: author,
      body: pending.body,
      created_at: at,
      updated_at: at,
      reactions: zeroedReactions(),
      html_url: '',
    }
    return {
      id: mintLocalThreadId(localId, commentId),
      isResolved: false,
      isOutdated: false,
      path: pending.path,
      line: pending.line,
      originalLine: pending.line,
      startLine: pending.start_line,
      originalStartLine: pending.start_line,
      diffSide: pending.side,
      startDiffSide: pending.start_side,
      subjectType: 'LINE',
      resolvedBy: null,
      comments: [comment],
    }
  })

  // 3. Persist, in the order that keeps a partial failure recoverable, and then
  //    delete the draft. Nothing above this line touches the draft.
  for (const thread of threads) deps.putLocalThread(localId, thread)
  deps.putLocalReviewSummary(localId, review)
  deps.putLocalSnapshot({
    ...snapshot,
    mutable: {
      ...snapshot.mutable,
      // Appended, never replaced: a submit adds to the review's conversation.
      threads: [...snapshot.mutable.threads, ...threads],
      commentAuthors: { ...(snapshot.mutable.commentAuthors ?? {}), ...authored },
    },
  })

  try {
    deps.deleteLocalDraft(humanId, localId)
  } catch (cause) {
    throw new ApiError(
      'persist_failed',
      `The review was recorded on local review ${localId}, but its draft could not be ` +
        `removed from storage. Re-read the review before submitting again — the ` +
        `comments are already there, and submitting a second time would create them ` +
        `twice. (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }

  return { status: 'ok', review }
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

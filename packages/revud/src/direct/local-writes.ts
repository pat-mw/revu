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
 * ALL FOUR BEHAVIOURS ARE WRITTEN, AND NO BODY HERE RETURNS A PLACEHOLDER. A
 * local write verb has exactly two honest answers — a complete value, or a
 * failure — because the caller reads a successful submit as permission to
 * discard the draft it just sent, so a verb that answered while materializing
 * nothing would destroy the reviewer's text with no error anywhere to notice.
 * Every failure this module RAISES is therefore an `ApiError` carrying a
 * contract code the transport can map, rather than a bare internal throw, and
 * that shape is asserted over the whole verb list rather than verb by verb: a
 * verb added later whose body could not answer in full would have to fail that
 * assertion to reach green.
 *
 * The failures it merely PROPAGATES are a different matter, and the claim above
 * does not reach them. A store write that throws, and a head resolution that
 * rejects, travel out of here exactly as they arrived, whatever shape that is.
 * This module neither wraps them nor unwraps them. Head resolution types the
 * ordinary repository states it can name — a ref that no longer resolves, a
 * range it cannot count — so those arrive already carrying a code; a store
 * write's failure arrives untyped. Passing both through unchanged is
 * deliberate rather than an oversight: the code such a failure should carry is a
 * property of the storage and git seams, which the caller owns and this module
 * only borrows, and a code invented here would describe a layer this module
 * cannot see. The one exception is a draft deletion that fails AFTER the review
 * has been materialized, which is wrapped because the wrapping is the only place
 * the "it landed anyway, do not resubmit" warning can be carried. The behaviour
 * is pinned by the suite; only the shape of the claim is narrower than it reads.
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
 *
 * RE-READ AFTER THE LAST AWAIT, AND BUILD THE ENVELOPE FROM THAT READ. Two
 * verbs here suspend in the middle of their work: submitting and replying both
 * await the branch head between reading the review's snapshot and writing a
 * whole envelope back. Every store method this module is given is SYNCHRONOUS,
 * so that await is the only point at which either verb yields — and another
 * write on the same review can run to completion while one is parked there. An
 * envelope built from the read taken BEFORE the await then republishes the old
 * thread list and the old authorship map over whatever landed in between: the
 * other write's comment disappears, its authorship entry disappears with it —
 * and a local comment with no entry can never be recognized as its writer's own
 * again — while both verbs answer success. Text the reviewer was told had been
 * saved would be gone, with nothing anywhere reporting it.
 *
 * The synchrony of the store is what makes a re-read a fix rather than a
 * narrowing. Once a verb resumes, its whole tail runs to completion with no
 * further interleaving, so a read taken at the top of that tail already carries
 * every write that landed during the await and nothing can land after it. The
 * obligation this places on later work is worth stating, because nothing about
 * the shape of such a change looks like a lost update: a verb that awaits
 * anywhere between its read and its write, or a store slice that grows an
 * asynchronous method, reopens the window in silence.
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
   * The local branch's current head, and the number of commits in the SAME
   * COMPARE the stored snapshot was built from — the range from the merge base
   * to that head, and never the branch's whole history.
   *
   * The scope is part of the contract rather than an implementation detail of
   * whoever wires this up, because the moved-head answer subtracts the stored
   * compare's commit list from this number. Counted over the whole of the
   * current head, it would be that list plus every commit the base branch
   * already carried, and the answer would report the repository's age as new
   * work on the branch. The pull-request path compares the same two quantities
   * — a pull's own commit count against the commits its stored compare holds —
   * and the subtraction only means anything while both are counted over one
   * range.
   *
   * Injected as a resolved function rather than as a process runner so this
   * module spawns nothing and ref-name hardening lives in exactly one place.
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
 * The stored snapshot for a local review, or the typed refusal that names the
 * fix. Written as one helper because a submit reads it TWICE — once to refuse
 * before the head is resolved, and once after, so the envelope it writes is
 * built from state no concurrent write can have already replaced — and the two
 * reads have to answer identically for the second one to be invisible to a
 * caller.
 */
function requireStoredSnapshot(deps: LocalWriteDeps, localId: number): Snapshot {
  const snapshot = deps.getLocalSnapshot(localId)
  if (snapshot === null) {
    throw new ApiError(
      'unprocessable',
      `Local review ${localId} has no stored snapshot for its threads to appear in — ` +
        `sync it, then submit.`,
    )
  }
  return snapshot
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

  const snapshot = requireStoredSnapshot(deps, localId)

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
  //
  //    The envelope is built from a snapshot re-read HERE rather than from the
  //    one the head guard was checked against. The head resolution above is the
  //    only await in this verb, and another write on the same review can have
  //    completed while it was outstanding; an envelope built from the earlier
  //    read would republish that write's thread list and authorship map away.
  //    Everything from this line to the end is synchronous, so this read carries
  //    every such write and no further one can interleave.
  const current = requireStoredSnapshot(deps, localId)
  for (const thread of threads) deps.putLocalThread(localId, thread)
  deps.putLocalReviewSummary(localId, review)
  deps.putLocalSnapshot({
    ...current,
    mutable: {
      ...current.mutable,
      // Appended, never replaced: a submit adds to the review's conversation.
      threads: [...current.mutable.threads, ...threads],
      commentAuthors: { ...(current.mutable.commentAuthors ?? {}), ...authored },
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
 * The stored thread with this id on this local review, together with the
 * snapshot it was read out of — or a typed not-found.
 *
 * A review with NO stored snapshot answers the same way rather than with a
 * distinct code, and that is a decision. A submit refuses such a review with
 * "sync it, then submit", because a submit really can be retried once a
 * snapshot exists. A thread id cannot: it is minted by the submit that
 * materializes the thread, so an id naming nothing here names nothing anywhere,
 * and there is no state a caller could reach that would make this particular id
 * appear. Telling them to sync would be advice that cannot help.
 */
function requireStoredThread(
  deps: LocalWriteDeps,
  localId: number,
  threadId: string,
): { snapshot: Snapshot; thread: ReviewThread } {
  const snapshot = deps.getLocalSnapshot(localId)
  const thread = snapshot?.mutable.threads.find((held) => held.id === threadId)
  if (snapshot === null || thread === undefined) {
    throw new ApiError('not_found', `Thread ${threadId} was not found on local review ${localId}.`)
  }
  return { snapshot, thread }
}

/**
 * The stored thread, the snapshot it came out of, and the comment a reply is
 * addressed to — or the typed not-found that either missing state answers with.
 *
 * Bundled into one helper because a reply reads all three TWICE: once before the
 * branch head is resolved, so a thread that does not exist refuses without
 * costing a git read, and once after, so every field the reply derives comes
 * from state no concurrent write can already have replaced. Both reads must
 * answer identically for the second one to be invisible to a caller, which a
 * single helper guarantees and two written-out copies would not.
 */
function requireThreadWithRoot(
  deps: LocalWriteDeps,
  localId: number,
  threadId: string,
): { snapshot: Snapshot; thread: ReviewThread; root: ReviewComment } {
  const { snapshot, thread } = requireStoredThread(deps, localId, threadId)
  const root = thread.comments[0]
  if (root === undefined) {
    throw new ApiError(
      'not_found',
      `Thread ${threadId} on local review ${localId} has no comment to reply to.`,
    )
  }
  return { snapshot, thread, root }
}

/**
 * Persist one changed thread: its own row first, then the whole snapshot
 * envelope with that thread swapped in place, every other thread carried
 * unchanged, and any new authorship entries merged onto the map.
 *
 * The envelope's thread list is rebuilt by MAPPING over the stored one rather
 * than by naming the single thread that changed. A store is free to read a
 * snapshot write as the whole truth about which threads a review has, so an
 * envelope carrying only the touched thread would delete every other thread of
 * the review — silently, because nothing was asked to delete anything. The
 * authorship map is merged for the same reason: replacing it would orphan every
 * comment written before this call, and an unattributable local comment can
 * never be recognized as its writer's own again.
 */
function persistThread(
  deps: LocalWriteDeps,
  localId: number,
  snapshot: Snapshot,
  thread: ReviewThread,
  authored: Readonly<Record<number, string>> = {},
): void {
  deps.putLocalThread(localId, thread)
  deps.putLocalSnapshot({
    ...snapshot,
    mutable: {
      ...snapshot.mutable,
      threads: snapshot.mutable.threads.map((held) => (held.id === thread.id ? thread : held)),
      commentAuthors: { ...(snapshot.mutable.commentAuthors ?? {}), ...authored },
    },
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
 * WHICH FIELD COMES FROM WHERE, AND WHY THE TWO SOURCES ARE NOT
 * INTERCHANGEABLE. The two review-shaped links — the review the conversation
 * belongs to, and the comment being answered — are read off the thread's FIRST
 * comment, because a thread's identity is its root's and a reply to the fifth
 * comment of a thread is still a reply to the thread. The LOCATION is read off
 * the thread instead: the thread is the anchor a re-read rebuilds every
 * comment's location from, and a thread that has gone outdated carries a null
 * line while its root still remembers the line it was written against — so
 * reading a location off the root would place the reply on a line the thread no
 * longer claims. The remaining two carried fields are the root's because they
 * describe the text the thread was opened against, which a reply does not move.
 *
 * A reply carries no range. A multi-line selection belongs to the comment that
 * opened the thread; a reply is a message on that thread, not a second
 * selection of its own.
 *
 * Authorship is recorded as a KEY beside the new comment. Nothing else can
 * answer whether a local comment is the reader's own: there is no stamped name
 * to parse and no forge login behind a synthesized author, so a reply created
 * without an entry in the authorship map is permanently unattributable.
 *
 * The reviewer's DRAFT is not touched, on any path. A reply is an immediate
 * write of text the reviewer has already committed to sending; the draft holds
 * different text, for a review that has not been submitted yet.
 */
export async function replyToLocalThread(
  deps: LocalWriteDeps,
  localId: number,
  threadId: string,
  body: string,
): Promise<ReviewComment> {
  // Read once before the branch is, so a thread this review does not hold
  // refuses without costing a git read. The read this reply is BUILT from is
  // taken again below, after the await.
  requireThreadWithRoot(deps, localId, threadId)

  // Resolved before anything is minted, so a failure to read the branch costs
  // no id: the allocator's high-water mark only ever moves forward.
  const head = await deps.resolveHead()

  // Re-read after the last await, and derive everything from this read. Another
  // write on the same review can have completed while the head resolution was
  // outstanding, and the envelope persisted below is rebuilt from the snapshot —
  // so a snapshot read earlier would republish that write away. Everything from
  // this line to the end is synchronous, so nothing further can interleave.
  const { snapshot, thread, root } = requireThreadWithRoot(deps, localId, threadId)
  const at = timestamp(deps)
  const id = mintLocalEntityId(deps.nextEntityId)
  const comment: ReviewComment = {
    id,
    node_id: `local:comment:${id}`,
    pull_request_review_id: root.pull_request_review_id,
    in_reply_to_id: root.id,
    path: thread.path,
    diff_hunk: root.diff_hunk,
    // The branch as it stands now, which is what this comment was written
    // against; the original commit stays the root's, because that is the state
    // the thread was opened against and a reply does not restate it.
    commit_id: head.sha,
    original_commit_id: root.original_commit_id,
    line: thread.line,
    original_line: thread.originalLine,
    start_line: null,
    original_start_line: null,
    side: thread.diffSide,
    start_side: null,
    subject_type: thread.subjectType === 'FILE' ? 'file' : 'line',
    user: localAuthor(deps.session.human.name),
    // Verbatim. See this module's header for why nothing here stamps.
    body,
    created_at: at,
    updated_at: at,
    reactions: zeroedReactions(),
    html_url: '',
  }

  persistThread(
    deps,
    localId,
    snapshot,
    { ...thread, comments: [...thread.comments, comment] },
    { [id]: deps.session.human.id },
  )
  return comment
}

/**
 * Resolve or unresolve a thread of a local review, returning the WHOLE stored
 * thread with only its resolution fields changed.
 *
 * Returning the stored thread rather than a rebuilt one is the point, and it is
 * the reason this verb is written as a spread of what was read. The client
 * copies the resolution fields straight out of this answer into its cached
 * state, so a thread reassembled from parts overwrites that cache with whatever
 * the reassembly happened to fill in. `isOutdated` is the field that makes this
 * dangerous: it is not derivable from anything this module holds — it says
 * whether the diff has moved out from under the thread, which only a snapshot
 * built against the current head can decide — so a rebuild has nothing to
 * compute it from and would default it to false. An outdated thread would flip
 * back to current, its hunk would stop being rendered, and there would be no
 * error anywhere to notice. It is therefore CARRIED, never recomputed and never
 * defaulted, and the same argument covers every other field the thread holds:
 * a resolve knows about resolution and about nothing else.
 *
 * WHAT `resolvedBy.login` CARRIES, AND WHY. It carries the sentinel author's
 * own login, which is the reviewer's git-config display NAME. Two readings of
 * the field were available — reuse the sentinel everywhere, or write the
 * display name directly — and locally they are the SAME STRING, since the
 * sentinel a local review synthesizes has the display name as its login. What
 * remains is which one to derive it from, and the sentinel wins: the two
 * cannot then drift, and a change to what a local author is called reaches this
 * field without anybody remembering to make it twice. The field's ordinary
 * meaning elsewhere is a forge account name, and this is not one — but no forge
 * account resolved this thread, and inventing an account-shaped string would
 * name something that does not exist. An address never appears here: the
 * reviewer's key is an email, this value is rendered, and the two never meet.
 *
 * The reviewer's DRAFT is not touched, on any path — resolving a thread says
 * nothing about a review that has not been submitted.
 */
export async function resolveLocalThread(
  deps: LocalWriteDeps,
  localId: number,
  threadId: string,
  resolved: boolean,
): Promise<ReviewThread> {
  const { snapshot, thread } = requireStoredThread(deps, localId, threadId)
  const updated: ReviewThread = {
    ...thread,
    isResolved: resolved,
    resolvedBy: resolved ? { login: localAuthor(deps.session.human.name).login } : null,
  }
  persistThread(deps, localId, snapshot, updated)
  return updated
}

/**
 * Add a reaction to a comment of a local review and return the comment's NEW
 * rollup.
 *
 * ONE LOOKUP IS THE WHOLE CLASSIFICATION. A review of a pull request has to
 * decide first which of two id namespaces the comment belongs to — review
 * comments and conversation-tab comments live behind separate endpoints and
 * their ids are drawn from separate sequences — and it decides that against the
 * cached snapshot's conversation-comment list. A local review's conversation
 * comment list is empty for its whole life, so there is no second namespace for
 * an id to be in and no classification left to get wrong: the comment is looked
 * for across the review's threads, and an id found nowhere is a plain typed
 * not-found rather than an id assumed to belong to the other kind.
 *
 * A REPEAT OF THE SAME REACTION ANSWERS WITH THE ROLLUP UNCHANGED AND WRITES
 * NOTHING, and that is the specification rather than an unfinished body. A
 * reaction is per-account and not per-press: upstream one shared account carries
 * every human's reactions, so a second identical one has nothing to add, and
 * locally there is exactly one author, so the count cannot pass one either way.
 * The verb is idempotent in the same way the forge is, and the client is built
 * for it — it overwrites its optimistic rollup with whatever comes back, so an
 * unchanged answer reconciles silently instead of reading as a lost write.
 *
 * That is a different thing from a verb which ALWAYS hands back the value it
 * read, and the distinguishing property is that a FIRST reaction really does
 * move a count and really is stored. Which is why the two halves are separate
 * claims rather than one: a verb that answered with the right rollup while
 * storing nothing, and a verb that stored the right rollup while answering with
 * the old one, are different defects, and neither is visible to a check of the
 * other half alone.
 *
 * ONLY THE LOCATED COMMENT'S ROLLUP MOVES. The comment is rebuilt with a new
 * rollup rather than edited in place, because the snapshot it was read out of is
 * the store's copy to hand out and a write that mutated it would change stored
 * state with no write call to attribute it to. Every other field of that
 * comment, every other comment of that thread and every other thread of the
 * review are carried through unchanged, and the authorship map is not touched at
 * all: a reaction authors no comment, and a map rewritten by a verb that created
 * nothing would orphan comments no later write could re-attribute.
 *
 * The reviewer's DRAFT is not touched, on any path — a reaction says nothing
 * about a review that has not been submitted.
 */
export async function addLocalReaction(
  deps: LocalWriteDeps,
  localId: number,
  commentId: number,
  reaction: ReactionKey,
): Promise<ReactionRollup> {
  const snapshot = deps.getLocalSnapshot(localId)
  const thread = snapshot?.mutable.threads.find((held) =>
    held.comments.some((comment) => comment.id === commentId),
  )
  const comment = thread?.comments.find((held) => held.id === commentId)
  if (snapshot === null || thread === undefined || comment === undefined) {
    throw new ApiError(
      'not_found',
      `Comment ${commentId} was not found on local review ${localId}.`,
    )
  }

  if (comment.reactions[reaction] > 0) return comment.reactions

  // The stored counts carried forward and exactly one of them moved. Rebuilding
  // the rollup from a zeroed one instead would answer with the same total for
  // this reaction and silently discard every other reaction on the comment.
  const bumped: ReactionRollup = {
    ...comment.reactions,
    total_count: comment.reactions.total_count + 1,
  }
  bumped[reaction] = comment.reactions[reaction] + 1

  persistThread(deps, localId, snapshot, {
    ...thread,
    comments: thread.comments.map((held) =>
      held.id === commentId ? { ...held, reactions: bumped } : held,
    ),
  })
  return bumped
}

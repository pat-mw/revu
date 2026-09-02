/**
 * The sentences the chrome says, where they differ by the kind of review.
 *
 * A review of two local branches has no pull request behind it, so a good deal
 * of the app's copy — written when every review was one — would assert a fact
 * that is not true of it. The wording is kept here rather than inline in the
 * components for the reason the review error copy already is: a string with one
 * source of truth is a string a component renders and a test pins, and the two
 * cannot drift.
 *
 * ## Why a module and not just careful components
 *
 * Much of this copy never reaches markup a test can read. Tooltip bodies,
 * popover bodies and dialog bodies are rendered through a portal, and a portal
 * has no target during static rendering — so a closed tooltip serialises as its
 * trigger and nothing else. An assertion that a portalled sentence does NOT
 * name a pull request, written against that markup, passes without ever having
 * seen the sentence. Calling the function directly is the only form of that
 * assertion which can fail, and it is the reason even one-line strings live
 * here.
 *
 * ## The shape every export takes
 *
 * A pure function of the review's mode, plus whatever it interpolates, that
 * returns strings — a bare one where the copy is a single sentence, a record of
 * named lines where a component renders several. No JSX, no hooks, and nothing
 * imported from a component: a copy function a test cannot call without a
 * renderer defeats the point of the module.
 *
 * One export returns a chip TINT rather than a sentence, and belongs here for
 * the same reason the rest do: it is half of what that chip says, it varies by
 * exactly the same question, and a colour that contradicts the word beside it
 * is a claim no sweep over wording would ever catch.
 */
import type { ReviewMode } from './review-mode'

/** The lines an empty state renders: a heading, a next move, and its control. */
export interface EmptyStateCopy {
  title: string
  /** One line pointing at the next action. */
  hint: string
  /** The label on the control that takes the reader there. */
  action: string
}

/**
 * The Conversation tab with nothing on it yet.
 *
 * Both readings are invitations rather than shrugs — they name where the first
 * comment is written and offer the trip in one click — because an empty
 * conversation is the ordinary state of a review nobody has commented on, not a
 * failure to report. The branch-pair title says branch instead of discussion
 * because on that path this state is the entire page: no description block
 * renders above it to supply the context the shorter heading leans on.
 */
export function conversationEmptyCopy(mode: ReviewMode): EmptyStateCopy {
  const hint = 'Open Files and leave the first comment (c on any line).'
  const action = 'Open files'
  if (mode === 'local') {
    return { title: 'No comments on this branch yet', hint, action }
  }
  return { title: 'No discussion yet', hint, action }
}

/**
 * The screen a review that is not in the list lands on.
 *
 * Both readings are the same fact — the path names a review this workspace
 * does not hold — but the pull-request one explains it by an installation the
 * app can see through, and a review of two local branches passes through no
 * installation at all: it exists only where it was created. Saying otherwise
 * would send a reader to check a setting that has nothing to do with what went
 * wrong.
 *
 * `review` is the review as the path named it, and it is interpolated on the
 * pull-request path ONLY. A local review is keyed by a synthetic integer that
 * exists so routes and cache keys can stay plain numbers; repeating it back at
 * a reader names nothing they could look up.
 */
export function notFoundCopy(mode: ReviewMode, review: string | number): EmptyStateCopy {
  const action = 'Back to inbox'
  if (mode === 'local') {
    return {
      title: "This local review isn't in this workspace",
      hint: 'Reviews of two local branches live only in the workspace that created them — this one was deleted, or was never here.',
      action,
    }
  }
  return {
    title: `PR #${review} isn't in this installation`,
    hint: 'The broker only sees pull requests in repos this GitHub App is installed on.',
    action,
  }
}

/** Which state a review is in, as the chip in its header reports it. */
export type ReviewState = 'open' | 'closed' | 'merged'

/**
 * The word in the state chip beside a review's title.
 *
 * The chip renders on both kinds of review: a review still taking comments and
 * one that is finished with them look identical without it. But "open" is a
 * state a pull request is in, and a branch pair has none — it is simply under
 * review until something ends that.
 *
 * The one thing that ends it is a pull request coming to cover the same branch
 * pair, at which point the review is kept and archived rather than deleted.
 * The surfaces that explain that supersession to a reader — the chip's own
 * tint below, the badge on the row, and the banner over the review — extend
 * this family rather than growing a second vocabulary beside it, so the header
 * and every one of them cannot come to different conclusions about the same
 * review.
 */
export function stateChipCopy(mode: ReviewMode, state: ReviewState): string {
  if (mode === 'local') {
    return state === 'open' ? 'in review' : 'archived'
  }
  // A pull request's chip says what GitHub calls the state, so the word is the
  // state itself.
  return state
}

/** The badge tints the state chip is drawn in, named as the badge names them. */
export type StateChipVariant = 'add' | 'default' | 'danger'

/** A pull request's chip: live, landed, or closed without landing. */
const GITHUB_STATE_VARIANT: Record<ReviewState, StateChipVariant> = {
  open: 'add',
  merged: 'default',
  closed: 'danger',
}

/**
 * The tint the state chip is drawn in — the other half of what the chip says,
 * and the half a reader takes in before reading the word.
 *
 * A pull request that closed without landing is the one state in this table
 * worth looking twice at, so it keeps the alarm tint. A branch pair that has
 * left the open state left it for exactly one reason: a pull request now
 * covers the same pair, which is work moving forward rather than work
 * abandoned. Drawn in the same tint it would read as a failure on every
 * archived review in the inbox and in every header — a false alarm repeated
 * everywhere, told by a colour no sweep over words would ever catch.
 *
 * Beside the wording rather than in the component for that reason: the tint
 * and the word are one claim, and two claims about the same review kept in two
 * places will eventually disagree.
 */
export function stateChipVariant(mode: ReviewMode, state: ReviewState): StateChipVariant {
  if (mode === 'local') return state === 'open' ? 'add' : 'default'
  return GITHUB_STATE_VARIANT[state]
}

/**
 * The badge on an inbox row whose review a pull request has come to cover, or
 * null on a pull request, which nothing supersedes in this sense.
 *
 * Terse because of where it sits: a row already carries its branch pair, its
 * kind and whatever draft is on it, and this is one more chip in that cluster.
 * It names the number and says the review is archived, which is as much as a
 * row can carry — the full statement of what "archived" costs and does not
 * cost belongs to the banner over the review itself, which is one click away
 * and is where a reader goes to act on it.
 *
 * The number is the only number on the row: a local review's identity slot
 * draws its branch pair, because the key it is routed by is synthetic and
 * names nothing a reader could look up. This one is a real pull request
 * number, and it is the whole reason the badge is worth its space.
 */
export function supersededBadgeCopy(mode: ReviewMode, prNumber: number): string | null {
  if (mode !== 'local') return null
  return `archived · superseded by #${prNumber}`
}

/** The lines of the banner over a review a pull request has superseded. */
export interface SupersededBannerCopy {
  /** What happened, and which pull request it happened for. */
  title: string
  /** What is true of the review now: what it can't do, and what it still holds. */
  hint: string
}

/**
 * The banner over a review that a pull request has taken over from.
 *
 * This is the one local surface that legitimately names a pull request, and it
 * has to: the review is read-only BECAUSE that pull request exists, and a
 * reader told only "archived" has been handed half a fact and no way to reach
 * the other half.
 *
 * Every clause earns its place, and each one answers a question the reader
 * would otherwise answer wrongly. What took over — so the work can be
 * followed. Read-only — so a reader stops looking for the composer they
 * remember. Frozen at its last sync — so the diff being older than the branch
 * is a property rather than a bug. Every thread and draft kept — because
 * "archived" reads as "thrown away" to most people, and the fear of losing a
 * morning's comments is what would stop them making local reviews at all.
 * Nothing was sent — because a reader who assumes their private notes went out
 * on a pull request has been badly surprised in the least recoverable way.
 *
 * The vocabulary of the self-approval refusal is deliberately absent, and it
 * is the nearest wrong reading: both say a control will not do what it looks
 * like it does, so borrowing that wording would turn this into "you may not
 * approve your own work, comment instead" — a live review with a narrowed
 * verdict, which is the opposite of what this is. The word "lost" is absent
 * for the same reason inverted: nothing here was.
 *
 * The number is named once, in the title. The surface that draws this also
 * offers the pull request as somewhere to GO, and a sentence that repeated the
 * number beside that link would read as two different pull requests to anyone
 * skimming it.
 *
 * `null` on the other reading. Nothing supersedes a pull request in this sense
 * — a pull request closes for its own reasons, none of them this one — so
 * there is no softer sentence to fall back to, and inventing one would invent
 * the fact behind it.
 */
export function supersededBannerCopy(
  mode: ReviewMode,
  prNumber: number,
): SupersededBannerCopy | null {
  if (mode !== 'local') return null
  return {
    title: `Archived — superseded by pull request #${prNumber}`,
    hint: 'This review is read-only and frozen at its last sync. Every thread and draft in it is kept; nothing in it was sent to that pull request.',
  }
}

/**
 * The heading over the launcher group that acts on the review already open.
 *
 * The group holds that review's sections, a re-sync and the trip into its
 * thread queue — actions that exist on either kind of review — so the entries
 * are shared and only the name over them varies. On a branch pair there is no
 * pull request for the heading to point at, and the launcher is one chord away
 * from every screen, which makes this the most reachable false claim a review
 * with no pull request behind it could carry.
 *
 * The heading is drawn inside a dialog, which renders through a portal and
 * reaches no static markup, so this is the only place either wording can be
 * pinned at all.
 */
export function paletteReviewHeading(mode: ReviewMode): string {
  return mode === 'local' ? 'This review' : 'This PR'
}

/** The lines of the banner that leads into the thread queue. */
export interface AuthorBannerCopy {
  /**
   * Whose work the review is, or absent when nothing about the review supports
   * the claim.
   */
  lead?: string
  /** What is waiting, following the count the banner draws in its own element. */
  waiting: string
  /** The label on the control that walks the queue. */
  action: string
}

/**
 * The banner over the thread queue, for a review with `unresolved` threads
 * still open.
 *
 * The action is the same on both paths and deliberately so: it is the only
 * entry to the thread queue anywhere in the header, and walking a reviewer's
 * feedback on your own branch is what a review of two local branches is for.
 *
 * What does not survive is the authorship claim. Every mediated pull request
 * is opened by one shared identity on behalf of a human, and the lead line is
 * the broker-side attribution that says which human — a fact with no local
 * counterpart, because nothing was opened anywhere. So the lead is absent
 * rather than reworded, and the count line names the branch the threads are on
 * instead of the person they are waiting on.
 */
export function authorBannerCopy(mode: ReviewMode, unresolved: number): AuthorBannerCopy {
  const action = 'Walk threads'
  const plural = unresolved === 1 ? '' : 's'
  if (mode === 'local') {
    return {
      waiting:
        unresolved > 0
          ? `unresolved thread${plural} on this branch`
          : 'no unresolved threads — clear',
      action,
    }
  }
  return {
    lead: 'You authored this PR',
    waiting:
      unresolved > 0
        ? `unresolved thread${plural} waiting on you`
        : 'no unresolved threads — clear',
    action,
  }
}

/** A toast's two lines: the headline, and the sentence drawn under it. */
export interface ToastCopy {
  title: string
  detail: string
}

/**
 * The toast at the end of a submitted review.
 *
 * On a mediated pull request the whole review — the summary and every line
 * comment — leaves in a single request, and saying so is the point of the
 * sentence rather than trivia: it tells a reader that reviewing costs one round
 * trip instead of one per comment, which is why the draft is batched at all.
 *
 * Neither half of that survives on a review of two local branches. Nothing was
 * published anywhere, so there is nothing to have posted; and no request was
 * made, so there is no call to have made one of. What did happen is worth
 * saying plainly, because it is the reassurance the sentence is really for: the
 * review was written down, and it is on the branch the reader is looking at.
 *
 * `comments` is the number of line comments in the draft. Zero means the review
 * is a summary alone, which is submittable and gets its own line rather than
 * being reported as none.
 */
export function submitSuccessCopy(mode: ReviewMode, comments: number): ToastCopy {
  const counted = `${comments} ${comments === 1 ? 'comment' : 'comments'}`
  if (mode === 'local') {
    return {
      title: 'Review saved',
      detail:
        comments === 0 ? 'Summary saved on this branch.' : `${counted} on this branch.`,
    }
  }
  return {
    title: 'Review posted',
    detail:
      comments === 0 ? 'Summary posted in one API call.' : `${counted} in one API call.`,
  }
}

/**
 * The toast at the end of a review submitted through the reconcile screen.
 *
 * The tally is the receipt for a decision session the reader just spent real
 * time on — which comments survived the branch moving under them, and which
 * they chose to let go — so it is identical on both readings. What changes is
 * the clause after it, for the same reason the plain submit's does: on a branch
 * pair no request was made and nothing was published.
 */
export function reconcileSuccessCopy(
  mode: ReviewMode,
  kept: number,
  dropped: number,
): ToastCopy {
  const tally = `${kept} kept, ${dropped} dropped`
  if (mode === 'local') {
    return {
      title: 'Review saved after reconcile',
      detail: `${tally} — saved on this branch.`,
    }
  }
  return {
    title: 'Review posted after reconcile',
    detail: `${tally} — one API call.`,
  }
}

/**
 * The line under a write that failed, where the headline is the error itself.
 *
 * The headline is the same on both readings and is not this module's to choose
 * — it is whatever the failure was. This is the sentence beneath it, and its
 * whole job is to stop a reader from retyping a review they still have.
 */
export interface FailureDetailCopy {
  detail: string
}

/**
 * What a failed submit says about the draft it did not send.
 *
 * Only the custodian differs. The promise is the load-bearing half and is true
 * on both readings: a write that fails rolls back to an editable draft with
 * every character intact, and a reader who is not told that will assume the
 * opposite and start again.
 */
export function submitFailureCopy(mode: ReviewMode): FailureDetailCopy {
  if (mode === 'local') {
    return { detail: 'Your draft is untouched in this workspace — nothing was lost.' }
  }
  return { detail: 'Your draft is untouched on the broker — nothing was lost.' }
}

/**
 * What a failed reconcile says about the draft it did not send.
 *
 * The same promise a failed plain submit makes, and it matters more here: the
 * draft it is about is one the reader just re-decided comment by comment, so
 * losing it would cost the decisions as well as the text.
 */
export function reconcileFailureCopy(mode: ReviewMode): FailureDetailCopy {
  if (mode === 'local') {
    return {
      detail: 'Your reconciled draft is saved in this workspace — nothing was lost.',
    }
  }
  return { detail: 'Your reconciled draft is saved on the broker — nothing was lost.' }
}

/** The persistence whisper beside the draft controls, and what it expands to. */
export interface DraftSavedCopy {
  /** The quiet line that says the draft is written down. */
  label: string
  /** Where it lives and what that means, on hover. */
  tooltip: string
}

/**
 * The whisper that says an unfinished review is safe to walk away from.
 *
 * Two facts, and they are why the whisper earns its space: the draft is
 * private, and it will still be there later. Both hold on either reading, but
 * for different reasons, and the reasons are the difference in wording.
 *
 * A mediated pull request's draft is held away from the machine it was typed
 * on, by the same service that mediates the writes — which is what lets it
 * survive the workspace being thrown away and rebuilt, and what makes "nobody
 * else can see it" a claim about the other people sharing that service. A
 * review of two local branches keeps its draft where the review itself lives,
 * so the durability it can honestly promise is smaller: reloads and coming back
 * tomorrow, not a rebuild of the very thing holding it. Claiming the larger one
 * would invite a reader to discard exactly the work it told them was safe.
 */
export function draftSavedCopy(mode: ReviewMode): DraftSavedCopy {
  if (mode === 'local') {
    return {
      label: 'saved · workspace',
      tooltip:
        'Drafts are kept beside the review in this workspace — invisible to GitHub and to anyone else. They survive reloads and tomorrow.',
    }
  }
  return {
    label: 'saved · broker',
    tooltip:
      'Drafts live on the broker, keyed to you — invisible to GitHub and to other contractors. They survive reloads, tomorrow, and a workspace rebuild.',
  }
}

/**
 * What one sync will do, on the control that starts it.
 *
 * The sentence exists to answer "is this expensive?" before a reader commits to
 * it, and the honest answer is not the same on both readings. Pulling a pull
 * request down means spending a shared read budget, roughly in proportion to
 * how big the diff is, and quoting that is what makes the one-burst design
 * legible rather than mysterious. A branch pair is already on the machine: the
 * sync copies it out of the repository beside the app, spends nothing anyone
 * else is sharing, and quoting a budget cost for it would be inventing one.
 *
 * What survives on both is the promise after the comma — that once this
 * finishes, nothing else needs the network — because that is the property the
 * whole design is for.
 */
export function syncCostCopy(mode: ReviewMode): string {
  if (mode === 'local') {
    return 'Reads the whole branch pair off this machine in one pass, then review is fully local.'
  }
  return 'Pulls the whole PR down in one burst (~3 + 2 requests per changed file), then review is fully local.'
}

/** The lines of the screen a review that has never been synced shows. */
export interface NeverSyncedCopy {
  title: string
  /** What one sync fetches, what it costs, and what it buys. */
  hint: string
}

/**
 * The screen standing in for a review whose content has not been read yet.
 *
 * `estimatedRequests` is a coarse order of magnitude for the read budget one
 * sync spends, and it is interpolated on the pull-request reading ONLY: a
 * branch pair's sync reads a repository that is already on this machine, so
 * there is no budget to quote and no number that would mean anything.
 */
export function neverSyncedCopy(
  mode: ReviewMode,
  estimatedRequests: number,
): NeverSyncedCopy {
  if (mode === 'local') {
    return {
      title: 'This branch pair was never synced',
      hint: 'One sync reads the diff, every thread, and enough blob context to expand any hunk straight off this machine. After that, review is entirely local — it works with the network gone.',
    }
  }
  return {
    title: 'This PR was never synced',
    hint: `One sync pulls the diff, every thread, and enough blob context to expand any hunk (~${estimatedRequests} requests from the shared 5,000/hr bucket). After that, review is entirely local — it works with the network gone.`,
  }
}

/** The sentences a failed sync falls back on when the error names no better one. */
export interface SyncErrorCopy {
  /** The headline for a failure with no more specific shape. */
  title: string
  /** The detail for a refused read whose retry time is unknown. */
  refused: string
}

/**
 * What a sync that did not land says about itself.
 *
 * Both lines are fallbacks: the transport names its own failure whenever it
 * can, and these are what is left when it cannot. The pull-request reading
 * blames the shared read budget because that is overwhelmingly what a refused
 * read means there. Nothing shares a budget with a branch pair, so its reading
 * says only what is certainly true — the read did not happen, and what was
 * already stored is exactly as it was.
 */
export function syncErrorCopy(mode: ReviewMode): SyncErrorCopy {
  if (mode === 'local') {
    return {
      title: "Couldn't sync this branch pair",
      refused: 'Nothing was read; the stored snapshot is untouched.',
    }
  }
  return {
    title: "Couldn't sync this pull request",
    refused: 'Rate limit exhausted on the shared bucket.',
  }
}

/** The lines of the banner that says what a review does not cover. */
export interface DirtyWorktreeCopy {
  /** The fact and its consequence, in one line. */
  title: string
  /** The rule the fact follows from, and the one move that closes the gap. */
  hint: string
}

/**
 * The banner over a review whose working tree held changes nobody had committed
 * when it was last read.
 *
 * A review of two local branches is assembled out of commits: the diff is the
 * merge base of the pair against the tip of the head branch, and every blob in
 * it is addressed by content the repository already holds. Edits still sitting
 * in the working tree are in none of that — and the gap is invisible from the
 * screen, because the files are listed by the same paths the reader has open in
 * an editor beside them. Nothing else in the chrome would ever mention it.
 *
 * So the wording states the fact and its consequence together rather than
 * warning vaguely, and names the one move that closes the gap. A hedge ("some
 * changes may not appear") would leave the reader unsure whether what they are
 * reading is the work, which is the confusion this banner exists to end.
 *
 * `null` on the other reading, and null rather than a softer sentence: a
 * mediated review is built from what was pushed, so no working tree on this
 * machine bears on what it contains. There is nothing true to say, the banner
 * never renders there, and inventing a line for it would be inventing the fact
 * behind the line.
 */
export function dirtyWorktreeCopy(mode: ReviewMode): DirtyWorktreeCopy | null {
  if (mode !== 'local') return null
  return {
    title: 'Uncommitted changes are not in this review',
    hint: 'This review covers committed content only. Commit the rest and re-sync to bring it in.',
  }
}

/**
 * The notice standing in for a diff that was never inlined.
 *
 * A file can be too big for a diff to be produced for it, and the notice says
 * so where the diff would have been. Who declined to produce it is the part
 * that differs: on a pull request the diff arrives already assembled and the
 * omission is upstream's; on a branch pair it is produced here from the
 * repository, so naming an upstream service would point a reader at something
 * that was never asked.
 */
export function tooLargeDiffCopy(mode: ReviewMode): string {
  if (mode === 'local') {
    return 'No inline diff for this file (file too large) — no text patch to render'
  }
  return 'GitHub did not inline this diff (file too large) — no text patch to render'
}

/**
 * The hover title on the avatar disc of an author the identity parser resolved
 * to a GitHub account, or null when there is nothing true to say about one.
 *
 * The parser calls any author whose login is not the shared write identity's a
 * GitHub account — which is every author of a branch pair, because the author
 * recorded on one is synthesized locally and carries no shared login. So the
 * treatment this title belongs to fires exactly where it is least true: it
 * tells a reader that the person who wrote the branch reviews on a site this
 * workspace may not even reach.
 *
 * The ring the treatment also draws is dropped with the title rather than
 * separately: they are one claim about where a person works, and half of it is
 * not a smaller claim, only a quieter one.
 */
export function orgMemberTitle(mode: ReviewMode): string | null {
  return mode === 'local' ? null : 'org member · reviews on github.com'
}

/**
 * The descriptor drawn beside the name of an author resolved to a GitHub
 * account, or null when there is nothing true to say about one.
 *
 * The same claim the avatar's title makes, in the one place a reader sees it
 * without hovering. It is dropped on a branch pair for the same reason, and
 * dropped rather than reworded: on a branch pair the author's name is the whole
 * fact, and a descriptor that added nothing would be noise beside it.
 */
export function orgMemberChip(mode: ReviewMode): string | null {
  return mode === 'local' ? null : 'org member · github.com'
}

/** What an unsubmitted draft holds, as much as the confirmation needs to say. */
export interface DeleteDraftSummary {
  /** Line comments written and not yet submitted. */
  pendingCount: number
  /** Whether the summary field has any character in it. */
  hasBody: boolean
}

/** The lines of the confirmation asked before a review is deleted. */
export interface DeleteReviewCopy {
  /** The question, naming the act rather than hedging it. */
  title: string
  /** What goes with the review, and what the reader is giving up to delete it. */
  body: string
  /** The label on the destructive control, which names everything it does. */
  confirm: string
  /** The label on the way out. */
  cancel: string
}

/** How a draft is described inside the body, or null when it holds nothing. */
function describeDraft(draft: DeleteDraftSummary | null): string | null {
  if (draft === null) return null
  const comments =
    draft.pendingCount > 0
      ? `${draft.pendingCount} pending comment${draft.pendingCount === 1 ? '' : 's'}`
      : null
  const summary = draft.hasBody ? 'a summary' : null
  if (comments !== null && summary !== null) return `${comments} and ${summary}`
  return comments ?? summary
}

/**
 * The confirmation asked before a review of two local branches is deleted, or
 * `null` on the other reading.
 *
 * Null rather than a softer sentence, and it is not a stylistic choice: nothing
 * in this app deletes a mediated review. There is no act to confirm there, so
 * there is no honest wording to fall back to, and inventing one would invent
 * the act behind it.
 *
 * ## Why the draft clause is a promise the copy has to keep exactly
 *
 * A delete is refused outright while any human's unsubmitted draft on the
 * review holds text, and the only way past that refusal is to discard the
 * draft first. So confirming here does two things, not one, and the second is
 * irreversible in a way the first is not: the review's threads and history are
 * a record the reader chose to build, while the draft is text they were still
 * writing.
 *
 * The wording therefore says DISCARDED, and says the text is not kept. It must
 * not say "lost" — the product reserves that word for the guarantee that
 * nothing was, and every other failure sentence in this module ends with it —
 * and it must not imply the text survives somewhere out of reach. Both
 * readings would be a promise of recovery that does not exist: after the
 * discard the characters are gone, by the reader's own explicit choice, which
 * is exactly why they are asked before it happens rather than told after.
 *
 * A draft holding nothing gets the plain wording, because the plain wording is
 * what is true of it: the delete is not refused for an empty draft, no discard
 * happens, and promising one would describe an act the confirm never performs.
 */
export function deleteLocalReviewCopy(
  mode: ReviewMode,
  draft: DeleteDraftSummary | null,
): DeleteReviewCopy | null {
  if (mode !== 'local') return null
  const held = describeDraft(draft)
  const kept = 'Its threads, its submitted reviews and its synced history go with it.'
  const branches = 'The two branches themselves are untouched.'
  if (held === null) {
    return {
      title: 'Delete this local review?',
      body: `${kept} ${branches}`,
      confirm: 'Delete review',
      cancel: 'Cancel',
    }
  }
  return {
    title: 'Delete this local review?',
    body: `${kept} Deleting first discards your unsubmitted draft — ${held} — and that text is not kept anywhere. ${branches}`,
    confirm: 'Discard draft and delete',
    cancel: 'Cancel',
  }
}

/**
 * What one delete attempt actually did to this reader's own draft.
 *
 * Every sentence about an attempt that did not end in a deletion has to say
 * this, because the two readings differ by the one irreversible thing that can
 * have happened: a discard the reader asked for and cannot take back. A frame
 * that is blind to it either claims text was destroyed when none was, or
 * reports a failure while saying nothing about the text it consumed on the way.
 */
export interface DeleteAttemptFacts {
  /** Whether this reader's own draft was discarded during the attempt. */
  discarded: boolean
}

/**
 * The frame over a delete the workspace refused, or `null` on the other
 * reading.
 *
 * Two readings, and choosing between them is a truth claim rather than a
 * nicety. The refusal spans every human's draft rather than the caller's alone
 * — two people reviewing one branch pair hold two drafts, and the delete would
 * take both.
 *
 * - A refusal that survived this reader's OWN discard can only be somebody
 *   else's unsubmitted text, and nothing on this screen can or should reach it.
 *   That reading also owes the reader the fact that their draft is already
 *   gone: it was discarded on the way to an attempt that then changed nothing.
 * - A refusal met with NO discard behind it says only that a draft with text is
 *   still on the review. Whose it is, is not known here — the reader's own may
 *   simply never have been read — so naming an absent third party would be an
 *   invention, and one that sends the reader off to ask somebody who does not
 *   exist.
 *
 * It is a FRAME, not a replacement: the surface that draws it also draws the
 * refusal exactly as the workspace worded it, because only that side knows
 * which review and which draft. This says what the reader needs before reading
 * it.
 */
export function deleteLocalReviewRefusedCopy(
  mode: ReviewMode,
  attempt: DeleteAttemptFacts,
): string | null {
  if (mode !== 'local') return null
  if (attempt.discarded) {
    return 'Your draft was discarded, but nothing was deleted: an unsubmitted draft written by someone else is still on this review, and only they can discard it.'
  }
  return 'Nothing was deleted — an unsubmitted draft with text in it is still on this review, and it has to be discarded before the review can go.'
}

/**
 * The frame over a delete that failed for a reason no draft explains, or
 * `null` on the other reading.
 *
 * A fault with no remedy this screen can offer — a workspace that did not
 * answer, a review that is not there — and the sentence beside it is whatever
 * the failure itself said. What this adds is the half the failure cannot know:
 * whether the reader's own draft was already discarded on the way to it.
 *
 * That half is the whole reason this is a function of the attempt rather than
 * one constant. A discard that succeeded before a delete that did not leaves
 * the review standing and the text gone, which is the one arrangement the
 * reader would never guess from a sentence about a delete alone — and guessing
 * wrong means going back to look for text that is not there.
 */
export function deleteLocalReviewFailedCopy(
  mode: ReviewMode,
  attempt: DeleteAttemptFacts,
): string | null {
  if (mode !== 'local') return null
  if (attempt.discarded) {
    return 'Your draft was discarded, but the review could not be deleted — it is still here, and that text is not.'
  }
  return "Couldn't delete this review"
}

/**
 * The sentence shown in place of the confirm when this reader's own draft
 * could not be read, or `null` on the other reading.
 *
 * Whether the delete discards a draft is decided from that read, so an
 * unanswered one leaves the confirmation unable to say what pressing it would
 * do. Offering it anyway would send a delete that leaves the reader's own text
 * in the way and then explains the refusal as somebody else's — so the offer is
 * withdrawn and the reason given, rather than the question being asked in words
 * that might be false.
 */
export function deleteLocalReviewDraftUnreadableCopy(mode: ReviewMode): string | null {
  if (mode !== 'local') return null
  return 'Your unsubmitted draft on this review could not be read, so a delete cannot say whether it would discard one. Close this and try again in a moment.'
}

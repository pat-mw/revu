/**
 * The chrome's per-mode copy, asserted by calling it.
 *
 * Every case here reads a string straight out of the module rather than out of
 * rendered markup, which is the whole reason the module exists: much of this
 * copy lands in a tooltip, a popover or a dialog body, all of which Radix
 * renders through a portal and static rendering therefore drops entirely. A
 * `not.toMatch` written against that markup passes vacuously.
 *
 * Absences get one test body each. Two `not.toMatch` assertions in one body
 * abort at the first, so the second is never independently falsifiable and its
 * control only looks like it bites.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as modeCopy from './mode-copy'
import {
  authorBannerCopy,
  conversationEmptyCopy,
  deleteLocalReviewCopy,
  deleteLocalReviewRefusedCopy,
  dirtyWorktreeCopy,
  draftSavedCopy,
  neverSyncedCopy,
  notFoundCopy,
  orgMemberChip,
  orgMemberTitle,
  paletteReviewHeading,
  reconcileFailureCopy,
  reconcileSuccessCopy,
  stateChipCopy,
  stateChipVariant,
  submitFailureCopy,
  submitSuccessCopy,
  supersededBadgeCopy,
  supersededBannerCopy,
  syncCostCopy,
  syncErrorCopy,
  tooLargeDiffCopy,
} from './mode-copy'
import type { DeleteDraftSummary, DirtyWorktreeCopy } from './mode-copy'
import type { ReviewMode } from './review-mode'

/**
 * Every line of the empty state as one string, so a field added to the copy
 * later is swept by the assertions below without editing them.
 */
function emptyStateText(mode: ReviewMode): string {
  return Object.values(conversationEmptyCopy(mode)).join(' ')
}

describe('the conversation tab with nothing on it yet', () => {
  test('a branch pair is invited to comment, and told where', () => {
    // An empty state is an invitation, not a shrug: without a next action a
    // later sweep could reduce this to a bare noun and still satisfy both
    // absences below.
    expect(emptyStateText('local')).toMatch(/files/i)
  })

  test('and is not told it has a pull request', () => {
    expect(emptyStateText('local')).not.toMatch(/pull request/i)
  })

  test('and is not told anything about github', () => {
    expect(emptyStateText('local')).not.toMatch(/github/i)
  })

  test('each kind of review gets its own sentence', () => {
    // The control for the three assertions above. Today's pull-request copy
    // already happens to name neither banned word, so a copy function that
    // ignored its argument would satisfy all three and prove nothing. Pinning
    // both titles is what makes them bite — and pins the sentence a reader
    // actually sees, which is the point of keeping copy in a module at all.
    expect(conversationEmptyCopy('local').title).toBe('No comments on this branch yet')
    expect(conversationEmptyCopy('github').title).toBe('No discussion yet')
  })

  test('and both are sent to the same place, in the same words', () => {
    // The two lines that do NOT vary, pinned on the pull-request reading as
    // well as the branch-pair one. A line a mode branch leaves alone is still a
    // line a reword can change, and the pull-request reading of it is what a
    // reader of an ordinary review sees.
    expect(conversationEmptyCopy('github').hint).toBe(
      'Open Files and leave the first comment (c on any line).',
    )
    expect(conversationEmptyCopy('github').action).toBe('Open files')
    expect(conversationEmptyCopy('local').hint).toBe(
      'Open Files and leave the first comment (c on any line).',
    )
    expect(conversationEmptyCopy('local').action).toBe('Open files')
  })
})

/** A review key from the reserved band, spelled out so a search can find it whole. */
const LOCAL_KEY = 1_000_000_001

/** Every line of the not-found screen as one string, swept the same way. */
function notFoundText(mode: ReviewMode, review: string | number): string {
  return Object.values(notFoundCopy(mode, review)).join(' ')
}

describe('the screen a review that is not in the list lands on', () => {
  test('a pull request is named by the number that was asked for', () => {
    // The current literal, pinned character for character: this path is
    // reached by a real mistyped pull request number and its wording is not
    // this module's to reword.
    expect(notFoundCopy('github', 415).title).toBe("PR #415 isn't in this installation")
    expect(notFoundCopy('github', 415).hint).toBe(
      'The broker only sees pull requests in repos this GitHub App is installed on.',
    )
    // The way out is the same on both readings and is pinned on both, because
    // an empty state with no next action is a dead end whichever kind of review
    // led to it.
    expect(notFoundCopy('github', 415).action).toBe('Back to inbox')
    expect(notFoundCopy('local', LOCAL_KEY).action).toBe('Back to inbox')
  })

  test('a branch pair gets its own two sentences', () => {
    // The control for the four absences below. Both sentences above name an
    // installation and a pull request, so a function that ignored its mode
    // would fail every one of them — but only because these two literals are
    // pinned to be different sentences rather than assumed to be.
    expect(notFoundCopy('local', LOCAL_KEY).title).toBe(
      "This local review isn't in this workspace",
    )
    expect(notFoundCopy('local', LOCAL_KEY).hint).toBe(
      'Reviews of two local branches live only in the workspace that created them — this one was deleted, or was never here.',
    )
  })

  // One absence per test: a runner stops at the first failure in a body, so a
  // pair of them would leave the second never independently falsifiable.
  test('and names no installation, which may not exist', () => {
    expect(notFoundText('local', LOCAL_KEY)).not.toMatch(/installation/i)
  })

  test('and claims no pull request', () => {
    expect(notFoundText('local', LOCAL_KEY)).not.toMatch(/pull request/i)
  })

  test('and points at nothing on github.com', () => {
    expect(notFoundText('local', LOCAL_KEY)).not.toMatch(/github\.com/i)
  })

  test('and never repeats the key it was routed by', () => {
    // Searched whole. Hunting for digits OF the key would collapse to "names
    // no 0 and no 1", which an ordinary branch name trips with nothing leaked.
    expect(notFoundText('local', LOCAL_KEY)).not.toContain(String(LOCAL_KEY))
  })
})

describe('what the state chip says a review is', () => {
  test('a pull request is in the state GitHub calls it', () => {
    expect(stateChipCopy('github', 'open')).toBe('open')
    expect(stateChipCopy('github', 'closed')).toBe('closed')
    expect(stateChipCopy('github', 'merged')).toBe('merged')
  })

  test('a branch pair is in review rather than open', () => {
    // The chip keeps rendering on a branch pair — a review that is still
    // taking comments looks exactly like one that is finished with them if the
    // chip is simply dropped — but "open" is a state a pull request is in.
    expect(stateChipCopy('local', 'open')).toBe('in review')
  })

  test('and is archived once it is no longer taking comments', () => {
    // The word the chip falls back to for a branch pair that has left the open
    // state. There is one way that happens — a pull request now covers the same
    // branch pair — and the surface that explains the supersession extends this
    // function rather than growing a second one beside it.
    expect(stateChipCopy('local', 'closed')).toBe('archived')
    expect(stateChipCopy('local', 'merged')).toBe('archived')
  })
})

/** The review a superseding pull request is numbered by, in every case below. */
const SUPERSEDING_PR = 101

/** Every line of the archived banner as one string, swept the same way. */
function supersededText(mode: ReviewMode): string {
  const copy = supersededBannerCopy(mode, SUPERSEDING_PR)
  return copy === null ? '' : Object.values(copy).join(' ')
}

describe('the tint of the state chip', () => {
  test('a closed pull request is drawn as the failure it may be', () => {
    // Today's value, pinned because it is the reading the change below must
    // not disturb: a pull request that closed without merging is the one state
    // in this table a reader should look twice at.
    expect(stateChipVariant('github', 'closed')).toBe('danger')
  })

  test('an archived branch pair is drawn neutrally instead', () => {
    // The whole point of a variant that varies. A review superseded by a pull
    // request is a review that ENDED WELL — the work moved on — so drawing it
    // in the palette reserved for failure would have every archived review in
    // the inbox read as something that went wrong.
    expect(stateChipVariant('local', 'closed')).not.toBe('danger')
    expect(stateChipVariant('local', 'closed')).toBe('default')
  })

  test('and a review still taking comments is drawn the same way on both', () => {
    // The tint varies by mode only where the two states mean different things.
    // A review that is live is live, and pinning both readings is what stops a
    // later edit from splitting a distinction that does not exist.
    expect(stateChipVariant('github', 'open')).toBe('add')
    expect(stateChipVariant('local', 'open')).toBe('add')
  })
})

describe('the badge on a row whose review a pull request has covered', () => {
  test('a branch pair names the number that superseded it', () => {
    // The literal, character for character. The row's identity slot shows a
    // branch pair rather than a number, so this badge is the only place the
    // number appears on that row.
    expect(supersededBadgeCopy('local', SUPERSEDING_PR)).toBe('archived · superseded by #101')
  })

  test('a pull request has no such badge at all, rather than a reworded one', () => {
    expect(supersededBadgeCopy('github', SUPERSEDING_PR)).toBeNull()
  })
})

describe('the banner over a review a pull request has superseded', () => {
  test('a branch pair is told what happened, and what is true of it now', () => {
    // Both lines pinned character for character, and every clause in them is
    // load-bearing: which pull request took over, that the review can no longer
    // be written to, that what it shows is the last thing it read, that the
    // work in it is still here, and that none of it ever left. A reader who is
    // told only "archived" will assume the rest went with it.
    //
    // The number appears once, in the title. The banner draws the pull request
    // as a place to go as well, and a second number beside that link reads as
    // a second pull request.
    const copy = supersededBannerCopy('local', SUPERSEDING_PR)
    expect(copy?.title).toBe('Archived — superseded by pull request #101')
    expect(copy?.hint).toBe(
      'This review is read-only and frozen at its last sync. Every thread and draft in it is kept; nothing in it was sent to that pull request.',
    )
  })

  test('a pull request has no such banner at all', () => {
    // Nothing supersedes a pull request in this sense, so there is no softer
    // sentence to fall back to — inventing one would invent the fact behind it.
    expect(supersededBannerCopy('github', SUPERSEDING_PR)).toBeNull()
  })

  test('and it says nothing about approving', () => {
    // The vocabulary of the self-approval refusal, which is the wrong
    // explanation wearing the right shape: both say a control will not do what
    // it looks like it does. Read as that one, an archived review becomes "you
    // may not approve your own work, comment instead" — a live review with a
    // narrowed verdict, which is not what this is.
    expect(supersededText('local')).not.toMatch(/approv/i)
  })

  test('and nothing about who wrote it', () => {
    // The other half of that vocabulary. Nothing here turns on whose branch it
    // is; a review is archived because a pull request covers the same pair,
    // whoever opened it.
    expect(supersededText('local')).not.toMatch(/author/i)
  })

  test('and never says the review was lost', () => {
    // The one word this banner must never carry. Every thread and draft is
    // kept, and a reader who reads otherwise will go looking for a backup — or
    // stop making local reviews at all.
    expect(supersededText('local')).not.toMatch(/lost/i)
  })

  test('and sends nobody to check an installation', () => {
    expect(supersededText('local')).not.toMatch(/installation/i)
  })

  test('while still naming the pull request that took over', () => {
    // The control for the five absences above, which copy reduced to empty
    // strings — or to the bare word "archived" — would satisfy for free. This
    // is also the one local surface that legitimately names a pull request:
    // the review is archived BECAUSE one exists, and a reader who cannot get
    // to it has been told half a fact.
    expect(supersededText('local')).toContain('#101')
    expect(supersededText('local')).toMatch(/pull request/i)
  })
})

describe('what the launcher calls the group acting on the open review', () => {
  test('a pull request is named as one', () => {
    // Today's literal, copied character for character out of the launcher. It
    // is drawn inside a dialog and reaches no static markup, so this is the
    // only place either wording can be pinned.
    expect(paletteReviewHeading('github')).toBe('This PR')
  })

  test('a branch pair is named as the review it is', () => {
    // The control for the pin above and the fix for the claim it replaces: the
    // launcher is one chord away from every screen, so a heading calling a
    // branch pair a pull request is the most reachable false claim in the app.
    expect(paletteReviewHeading('local')).toBe('This review')
  })

  test('and a branch pair is not told it has a pull request', () => {
    expect(paletteReviewHeading('local')).not.toMatch(/pull request/i)
  })

  test('nor an abbreviated one', () => {
    expect(paletteReviewHeading('local')).not.toMatch(/\bPR\b/)
  })
})

/** Every line of the author banner as one string. */
function bannerText(mode: ReviewMode, unresolved: number): string {
  return Object.values(authorBannerCopy(mode, unresolved)).join(' ')
}

describe('the banner over the thread queue', () => {
  test('a pull request tells its author the work is theirs', () => {
    expect(authorBannerCopy('github', 3).lead).toBe('You authored this PR')
  })

  test('and counts what is waiting, singular or plural or none', () => {
    expect(authorBannerCopy('github', 3).waiting).toBe('unresolved threads waiting on you')
    expect(authorBannerCopy('github', 1).waiting).toBe('unresolved thread waiting on you')
    expect(authorBannerCopy('github', 0).waiting).toBe('no unresolved threads — clear')
  })

  test('a branch pair claims no authorship', () => {
    // The control for the two absences below sits in the same fact: the
    // pull-request lead is the sentence carrying the banned words, so its
    // absence here is the suppression and not an empty record.
    expect(authorBannerCopy('local', 3).lead).toBeUndefined()
    expect(authorBannerCopy('local', 3).waiting).toBe('unresolved threads on this branch')
  })

  test('but keeps the trip into the queue, which is the whole point of it', () => {
    // The action survives on a branch pair: it is the only entry to the thread
    // queue anywhere in the header, and walking feedback on your own branch is
    // the flow this kind of review exists for.
    expect(authorBannerCopy('local', 3).action).toBe('Walk threads')
    expect(authorBannerCopy('github', 3).action).toBe('Walk threads')
  })

  test('and mentions no pull request', () => {
    expect(bannerText('local', 3)).not.toMatch(/pull request/i)
  })

  test('and does not abbreviate one either', () => {
    expect(bannerText('local', 3)).not.toMatch(/\bPR\b/)
  })
})

/** Every line of the submitted-review toast as one string. */
function submitSuccessText(mode: ReviewMode, comments: number): string {
  return Object.values(submitSuccessCopy(mode, comments)).join(' ')
}

describe('the toast at the end of a submitted review', () => {
  test('a pull request is told what left, and that it left in one go', () => {
    // Today's literals, pinned character for character. The count line carries
    // a singular form a sweep could quietly lose, and the "one call" claim is
    // the point of the sentence on this path: it tells a reader that a review
    // costs one round trip rather than one per comment.
    expect(submitSuccessCopy('github', 3).title).toBe('Review posted')
    expect(submitSuccessCopy('github', 3).detail).toBe('3 comments in one API call.')
    expect(submitSuccessCopy('github', 1).detail).toBe('1 comment in one API call.')
    expect(submitSuccessCopy('github', 0).detail).toBe('Summary posted in one API call.')
  })

  test('a branch pair is told what was written down, and where', () => {
    // The control for the three absences below, and the sentence a reader sees
    // at the end of every review of two local branches — pinned as a value
    // rather than left merely un-wrong.
    expect(submitSuccessCopy('local', 3).title).toBe('Review saved')
    expect(submitSuccessCopy('local', 3).detail).toBe('3 comments on this branch.')
    expect(submitSuccessCopy('local', 1).detail).toBe('1 comment on this branch.')
    expect(submitSuccessCopy('local', 0).detail).toBe('Summary saved on this branch.')
  })

  test('and its two lines read as one sentence', () => {
    // The toast draws its headline above its detail; read together they are
    // the wording this sentence was settled as, which neither line pins alone.
    const copy = submitSuccessCopy('local', 3)
    expect(`${copy.title} — ${copy.detail}`).toBe('Review saved — 3 comments on this branch.')
  })

  // One absence per test: a runner stops at the first failure in a body, so a
  // pair of them would leave the second never independently falsifiable.
  test('and claims no call was made, because none was', () => {
    expect(submitSuccessText('local', 3)).not.toMatch(/API call/i)
  })

  test('and claims nothing was posted, because nothing was', () => {
    expect(submitSuccessText('local', 3)).not.toMatch(/posted/i)
  })

  test('and names no github, which was not involved', () => {
    expect(submitSuccessText('local', 3)).not.toMatch(/github/i)
  })
})

/** Every line of the reconciled-review toast as one string. */
function reconcileSuccessText(mode: ReviewMode, kept: number, dropped: number): string {
  return Object.values(reconcileSuccessCopy(mode, kept, dropped)).join(' ')
}

describe('the toast at the end of a reconciled review', () => {
  test('a pull request makes the same claim the plain submit makes', () => {
    expect(reconcileSuccessCopy('github', 5, 2).title).toBe('Review posted after reconcile')
    expect(reconcileSuccessCopy('github', 5, 2).detail).toBe(
      '5 kept, 2 dropped — one API call.',
    )
  })

  test('a branch pair keeps the tally and drops the claim', () => {
    // The tally is the whole value of this toast — it is the receipt for a
    // decision session the reader just spent minutes on — so it survives the
    // reword unchanged while the sentence around it stops asserting a write.
    expect(reconcileSuccessCopy('local', 5, 2).title).toBe('Review saved after reconcile')
    expect(reconcileSuccessCopy('local', 5, 2).detail).toBe(
      '5 kept, 2 dropped — saved on this branch.',
    )
  })

  test('and claims no call was made on this path either', () => {
    expect(reconcileSuccessText('local', 5, 2)).not.toMatch(/API call/i)
  })

  test('and claims nothing was posted on this path either', () => {
    expect(reconcileSuccessText('local', 5, 2)).not.toMatch(/posted/i)
  })
})

/** Every line of the failed-submit detail as one string. */
function submitFailureText(mode: ReviewMode): string {
  return Object.values(submitFailureCopy(mode)).join(' ')
}

describe('the line under a submit that failed', () => {
  test('a pull request is told where its draft still is', () => {
    expect(submitFailureCopy('github').detail).toBe(
      'Your draft is untouched on the broker — nothing was lost.',
    )
  })

  test('a branch pair is told the same thing about a different custodian', () => {
    expect(submitFailureCopy('local').detail).toBe(
      'Your draft is untouched in this workspace — nothing was lost.',
    )
  })

  test('and both keep the guarantee, which is the half true on either', () => {
    // Only the custodian changes. That the text a reader typed survived the
    // failure is a hard rule of every write here, and a reword that dropped it
    // would leave someone retyping a review they still have.
    expect(submitFailureCopy('github').detail).toMatch(/nothing was lost/)
    expect(submitFailureCopy('local').detail).toMatch(/nothing was lost/)
  })

  test('and a branch pair names no broker, since none is holding it', () => {
    expect(submitFailureText('local')).not.toMatch(/\bbroker\b/i)
  })
})

/** Every line of the failed-reconcile detail as one string. */
function reconcileFailureText(mode: ReviewMode): string {
  return Object.values(reconcileFailureCopy(mode)).join(' ')
}

describe('the line under a reconcile that failed', () => {
  test('a pull request is told its reconciled draft is safe', () => {
    expect(reconcileFailureCopy('github').detail).toBe(
      'Your reconciled draft is saved on the broker — nothing was lost.',
    )
  })

  test('a branch pair is told the same about a different custodian', () => {
    expect(reconcileFailureCopy('local').detail).toBe(
      'Your reconciled draft is saved in this workspace — nothing was lost.',
    )
  })

  test('and both keep the guarantee here too', () => {
    // This one matters more than the plain submit's: the draft it promises is
    // safe is one the reader just re-decided comment by comment.
    expect(reconcileFailureCopy('github').detail).toMatch(/nothing was lost/)
    expect(reconcileFailureCopy('local').detail).toMatch(/nothing was lost/)
  })

  test('and a branch pair names no broker here either', () => {
    expect(reconcileFailureText('local')).not.toMatch(/\bbroker\b/i)
  })
})

/** Every line of the draft-saved whisper as one string. */
function draftSavedText(mode: ReviewMode): string {
  return Object.values(draftSavedCopy(mode)).join(' ')
}

describe('the whisper that says the draft is safe', () => {
  test('a pull request names the broker holding it', () => {
    // The tooltip is pinned as one line because that is how it reads: the
    // component splits it across three source lines and the renderer joins
    // them back with single spaces.
    expect(draftSavedCopy('github').label).toBe('saved · broker')
    expect(draftSavedCopy('github').tooltip).toBe(
      'Drafts live on the broker, keyed to you — invisible to GitHub and to other contractors. They survive reloads, tomorrow, and a workspace rebuild.',
    )
  })

  test('a branch pair names the workspace that does', () => {
    // Surviving a workspace rebuild is a property of a draft kept somewhere
    // else, so the branch-pair reading does not claim it. What it keeps is the
    // durability it actually has.
    expect(draftSavedCopy('local').label).toBe('saved · workspace')
    expect(draftSavedCopy('local').tooltip).toBe(
      'Drafts are kept beside the review in this workspace — invisible to GitHub and to anyone else. They survive reloads and tomorrow.',
    )
  })

  test('and both still promise nobody else can read it', () => {
    // The half of the pull-request sentence that is true on a branch pair as
    // well, and the reason to reword the custodian rather than delete the
    // tooltip: a private draft is the thing that makes an unfinished review
    // safe to leave open.
    expect(draftSavedCopy('local').tooltip).toMatch(/invisible to GitHub/)
  })

  test('and a branch pair names no broker', () => {
    expect(draftSavedText('local')).not.toMatch(/\bbroker\b/i)
  })
})

describe('what one sync will do, on the control that starts it', () => {
  test('a pull request is quoted a budget cost, roughly', () => {
    // Today's literal, pinned character for character. The estimate is the
    // point of the sentence on this path: it answers "is this expensive?"
    // before a reader commits to the burst.
    expect(syncCostCopy('github')).toBe(
      'Pulls the whole PR down in one burst (~3 + 2 requests per changed file), then review is fully local.',
    )
  })

  test('a branch pair is told where it reads from instead', () => {
    // The control for the absence below. A branch pair's sync spends nothing
    // anyone is sharing, so there is no cost to quote — but the promise after
    // the comma is the same on both, and dropping it would lose the reason the
    // sync is one burst at all.
    expect(syncCostCopy('local')).toBe(
      'Reads the whole branch pair off this machine in one pass, then review is fully local.',
    )
  })

  test('and is quoted no budget it does not spend', () => {
    expect(syncCostCopy('local')).not.toMatch(/\brequests\b/i)
  })
})

/** Every line of the never-synced screen as one string. */
function neverSyncedText(mode: ReviewMode, estimate: number): string {
  return Object.values(neverSyncedCopy(mode, estimate)).join(' ')
}

describe('the screen a review whose content was never read shows', () => {
  test('a pull request is told the burst size it is about to spend', () => {
    expect(neverSyncedCopy('github', 25).title).toBe('This PR was never synced')
    expect(neverSyncedCopy('github', 25).hint).toBe(
      'One sync pulls the diff, every thread, and enough blob context to expand any hunk (~25 requests from the shared 5,000/hr bucket). After that, review is entirely local — it works with the network gone.',
    )
  })

  test('a branch pair is told what one sync reads and what it buys', () => {
    // The control for the two absences below, and the half that must survive:
    // "after this, the network is not needed" is the property the whole design
    // exists for and is true on both readings.
    expect(neverSyncedCopy('local', 25).title).toBe('This branch pair was never synced')
    expect(neverSyncedCopy('local', 25).hint).toBe(
      'One sync reads the diff, every thread, and enough blob context to expand any hunk straight off this machine. After that, review is entirely local — it works with the network gone.',
    )
  })

  test('and is quoted no shared budget', () => {
    expect(neverSyncedText('local', 25)).not.toMatch(/\bbucket\b/i)
  })

  test('and no request count either', () => {
    expect(neverSyncedText('local', 25)).not.toMatch(/\brequests\b/i)
  })

  test('and the estimate reaches the sentence that quotes one', () => {
    // The estimate is interpolated on one path only, so this is what says the
    // argument is used rather than accepted and dropped.
    expect(neverSyncedCopy('github', 41).hint).toContain('~41 requests')
  })
})

/** Every line of the failed-sync fallback as one string. */
function syncErrorText(mode: ReviewMode): string {
  return Object.values(syncErrorCopy(mode)).join(' ')
}

describe('what a sync that did not land falls back on saying', () => {
  test('a pull request blames the budget it shares, which is usually right', () => {
    expect(syncErrorCopy('github').title).toBe("Couldn't sync this pull request")
    expect(syncErrorCopy('github').refused).toBe('Rate limit exhausted on the shared bucket.')
  })

  test('a branch pair says only what is certainly true', () => {
    // The control for the two absences below. Nothing shares a budget with a
    // branch pair, so the fallback keeps the one guarantee that survives every
    // cause: whatever failed, the stored snapshot is as it was.
    expect(syncErrorCopy('local').title).toBe("Couldn't sync this branch pair")
    expect(syncErrorCopy('local').refused).toBe(
      'Nothing was read; the stored snapshot is untouched.',
    )
  })

  test('and blames no limit nothing is enforcing', () => {
    expect(syncErrorText('local')).not.toMatch(/rate limit/i)
  })

  test('and claims no pull request', () => {
    expect(syncErrorText('local')).not.toMatch(/pull request/i)
  })
})

/**
 * The banner's lines, or a failure naming the mode that had none.
 *
 * Thrown rather than defaulted, so a mode that stops having a sentence fails in
 * the test that expected one instead of being quietly compared against a blank.
 */
function dirtyWorktreeLines(mode: ReviewMode): DirtyWorktreeCopy {
  const copy = dirtyWorktreeCopy(mode)
  if (copy === null) {
    throw new Error(`the dirty-worktree banner says nothing on a ${mode} review`)
  }
  return copy
}

/** Every line of the banner as one string, or none where it has nothing to say. */
function dirtyWorktreeText(mode: ReviewMode): string {
  const copy = dirtyWorktreeCopy(mode)
  return copy === null ? '' : Object.values(copy).join(' ')
}

describe('the banner over a review whose working tree held uncommitted changes', () => {
  test('a branch pair is told what is missing and what closes the gap', () => {
    // Both lines pinned character for character. This is the ONLY assertion in
    // this block that a mode-blind copy function fails on the branch-pair side,
    // and the reason is worth stating: the wording below names none of the
    // three banned words in the first place, so every absence in this block is
    // satisfied for free by copy that ignored its argument entirely.
    const copy = dirtyWorktreeLines('local')
    expect(copy.title).toBe('Uncommitted changes are not in this review')
    expect(copy.hint).toBe(
      'This review covers committed content only. Commit the rest and re-sync to bring it in.',
    )
  })

  test('and the rule it turns on is named rather than left to be inferred', () => {
    // The required half. Without the rule the banner is a complaint about the
    // reader's own working tree instead of a statement about what is on the
    // screen, and a later sweep could shorten it to that and satisfy every
    // absence below.
    expect(dirtyWorktreeText('local')).toContain('covers committed content only')
  })

  test('a pull request has no such sentence at all, rather than a reworded one', () => {
    // The other pin, and the one that carries this block. A review mediated
    // elsewhere is built from what was pushed, so no working tree on this
    // machine bears on what it contains and the banner never renders there.
    // `null` states that; a softened warning would invent a fact.
    expect(dirtyWorktreeCopy('github')).toBeNull()
  })

  test('and the branch-pair wording claims no pull request', () => {
    expect(dirtyWorktreeText('local')).not.toMatch(/pull request/i)
  })

  test('and names no github', () => {
    expect(dirtyWorktreeText('local')).not.toMatch(/github/i)
  })

  test('and no broker either', () => {
    expect(dirtyWorktreeText('local')).not.toMatch(/\bbroker\b/i)
  })
})

describe('the notice standing in for a diff that was never inlined', () => {
  test('a pull request names who declined to produce it', () => {
    expect(tooLargeDiffCopy('github')).toBe(
      'GitHub did not inline this diff (file too large) — no text patch to render',
    )
  })

  test('a branch pair states the fact without an author', () => {
    // The control for the absence below, and the half that must survive on
    // both: WHY there is nothing to read, which is what stops the blank area
    // reading as a failure to load.
    expect(tooLargeDiffCopy('local')).toBe(
      'No inline diff for this file (file too large) — no text patch to render',
    )
  })

  test('and blames nobody who was never asked', () => {
    expect(tooLargeDiffCopy('local')).not.toMatch(/github/i)
  })
})

describe('the descriptor on an author resolved to a GitHub account', () => {
  test('a pull request says where that person reviews', () => {
    // Today's two literals. They are a hover title and a chip rather than
    // paragraphs, which is exactly why they went unnoticed for so long — and
    // why they are pinned here as values rather than looked for in prose.
    expect(orgMemberTitle('github')).toBe('org member · reviews on github.com')
    expect(orgMemberChip('github')).toBe('org member · github.com')
  })

  test('a branch pair says nothing, because there is nothing true to say', () => {
    // The author of a review of two local branches resolves to this same case:
    // their login is simply not the shared write identity's. So the treatment
    // fires exactly where it is least true, and the honest answer is silence —
    // the person's name is already the whole fact.
    expect(orgMemberTitle('local')).toBeNull()
    expect(orgMemberChip('local')).toBeNull()
  })
})

// ————————————————————————————————————————————————————————————————
// Deleting a review of two local branches
// ————————————————————————————————————————————————————————————————

/** A draft holding both kinds of text, as the confirmation summarises one. */
const FULL_DRAFT: DeleteDraftSummary = { pendingCount: 3, hasBody: true }

/**
 * Every line the confirmation says about a branch pair, as one string — so a
 * field added to the copy later is swept by the bans below without editing
 * them, and so a `null` on the branch-pair reading fails loudly instead of
 * satisfying every absence for free.
 */
function deleteText(draft: DeleteDraftSummary | null): string {
  const copy = deleteLocalReviewCopy('local', draft)
  if (copy === null) throw new Error('a branch pair was offered no delete confirmation')
  return Object.values(copy).join(' ')
}

describe('the confirmation before a branch pair is deleted', () => {
  test('names the act and what goes with the review', () => {
    const copy = deleteLocalReviewCopy('local', null)
    expect(copy?.title).toBe('Delete this local review?')
    expect(copy?.body).toBe(
      'Its threads, its submitted reviews and its synced history go with it. The two branches themselves are untouched.',
    )
    expect(copy?.confirm).toBe('Delete review')
    expect(copy?.cancel).toBe('Cancel')
  })

  test('and a pull request is offered no such thing', () => {
    // Null rather than a reworded sentence: nothing in this app deletes a pull
    // request, so there is no softer wording to fall back to and inventing one
    // would invent the act behind it.
    expect(deleteLocalReviewCopy('github', null)).toBeNull()
    expect(deleteLocalReviewCopy('github', FULL_DRAFT)).toBeNull()
  })

  test('an unsubmitted draft is counted, and said to be discarded rather than kept', () => {
    const copy = deleteLocalReviewCopy('local', FULL_DRAFT)
    expect(copy?.body).toBe(
      'Its threads, its submitted reviews and its synced history go with it. Deleting first discards your unsubmitted draft — 3 pending comments and a summary — and that text is not kept anywhere. The two branches themselves are untouched.',
    )
    expect(copy?.confirm).toBe('Discard draft and delete')
  })

  test('one pending comment is counted as one', () => {
    expect(deleteLocalReviewCopy('local', { pendingCount: 1, hasBody: false })?.body).toContain(
      'your unsubmitted draft — 1 pending comment —',
    )
  })

  test('a summary with no pending comments is named as what it is', () => {
    expect(deleteLocalReviewCopy('local', { pendingCount: 0, hasBody: true })?.body).toContain(
      'your unsubmitted draft — a summary —',
    )
  })

  test('and the two bodies are different sentences', () => {
    // The check that needs no wording to be useful: a function that returns one
    // paragraph whatever it is handed satisfies every ban below, because a ban
    // is satisfied by any wording that happens not to contain the word — the
    // wording it was supposed to replace included.
    const withDraft = deleteLocalReviewCopy('local', FULL_DRAFT)
    const without = deleteLocalReviewCopy('local', null)
    expect(withDraft?.body).not.toBe(without?.body)
    expect(withDraft?.confirm).not.toBe(without?.confirm)
  })

  test('a draft holding nothing is the same offer as no draft at all', () => {
    // Total over the input rather than only over the inputs the app sends. A
    // draft an editor made on its own holds no text, discarding it destroys
    // nothing, and the review deletes without a refusal — so promising to
    // discard something would be a sentence about an act that never happens.
    expect(deleteLocalReviewCopy('local', { pendingCount: 0, hasBody: false })).toEqual(
      deleteLocalReviewCopy('local', null),
    )
  })
})

describe('a refusal that outlives the discard', () => {
  test('says whose draft is in the way, and that nothing was deleted', () => {
    expect(deleteLocalReviewRefusedCopy('local')).toBe(
      'Nothing was deleted — an unsubmitted draft written by someone else is still on this review, and only they can discard it.',
    )
  })

  test('and a pull request has no such refusal to explain', () => {
    expect(deleteLocalReviewRefusedCopy('github')).toBeNull()
  })
})

/**
 * Everything this surface says about a branch pair, in one string.
 *
 * The bans below get one test body each: two `not.toMatch` calls in one body
 * abort at the first, so the second is never independently falsifiable and its
 * control only looks like it bites.
 */
const DELETE_VOCABULARY = [
  deleteText(FULL_DRAFT),
  deleteText(null),
  deleteLocalReviewRefusedCopy('local') ?? '',
].join(' ')

describe('what the delete copy must never claim', () => {
  test('it really is reading the sentences it sweeps', () => {
    // The positive control every absence below rests on: an empty string
    // satisfies all four of them and asserts nothing at all.
    expect(DELETE_VOCABULARY).toMatch(/discard/i)
    expect(DELETE_VOCABULARY.length).toBeGreaterThan(200)
  })

  test('nothing here was lost', () => {
    // The word the product reserves for the guarantee that nothing was. Text
    // discarded here is discarded by the reader's own explicit choice, which is
    // the opposite of the thing that word is used to deny.
    expect(DELETE_VOCABULARY).toMatch(/discard/i)
    expect(DELETE_VOCABULARY).not.toMatch(/lost/i)
  })

  test('and no pull request is mentioned', () => {
    expect(DELETE_VOCABULARY).toMatch(/review/i)
    expect(DELETE_VOCABULARY).not.toMatch(/pull request/i)
  })

  test('nor abbreviated to one', () => {
    expect(DELETE_VOCABULARY).toMatch(/branches/i)
    expect(DELETE_VOCABULARY).not.toMatch(/\bPR\b/)
  })

  test('and nothing is described as merely unreachable', () => {
    // The wording an earlier design would have used, when a delete stranded a
    // draft under an id nothing could name again. It does not: the draft is
    // discarded outright, by the reader, before the review goes — and copy that
    // said otherwise would promise a recovery that does not exist.
    expect(DELETE_VOCABULARY).toMatch(/not kept/i)
    expect(DELETE_VOCABULARY).not.toMatch(/unreachable/i)
  })
})

/** One chrome file's source, read as text. */
function chromeSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const REVIEW_BAR_SOURCE = chromeSource('../components/review/review-bar.tsx')
const RECONCILE_DIALOG_SOURCE = chromeSource('../components/review/reconcile-dialog.tsx')

/** The names a file pulls out of this module, or none if it pulls out nothing. */
function importedFromHere(source: string): string {
  return /import\s*\{([^}]*)\}\s*from\s*'@\/lib\/mode-copy'/.exec(source)?.[1] ?? ''
}

describe('the chrome draws these sentences rather than its own', () => {
  test('the reads are looking at the files they name', () => {
    // The control for the two pins below: a path resolving to the wrong file,
    // or to an empty one, would fail them for a reason with nothing to do with
    // where the copy lives.
    expect(REVIEW_BAR_SOURCE).toMatch(/export function ReviewBar\(/)
    expect(RECONCILE_DIALOG_SOURCE).toMatch(/export function ReconcileDialog\(/)
  })

  test('the review bar takes all three of its mode-varying lines from here', () => {
    // PRESENCE, not execution — nothing here proves a toast ever fires. What it
    // turns red is a sentence pasted back inline, which every assertion above
    // is blind to: they call this module, and a component that quietly stopped
    // calling it would leave all of them green while the screen went back to
    // claiming a write that never happened.
    const names = importedFromHere(REVIEW_BAR_SOURCE)
    expect(names).toContain('submitSuccessCopy')
    expect(names).toContain('submitFailureCopy')
    expect(names).toContain('draftSavedCopy')
  })

  test('and the reconcile dialog takes both of its own', () => {
    const names = importedFromHere(RECONCILE_DIALOG_SOURCE)
    expect(names).toContain('reconcileSuccessCopy')
    expect(names).toContain('reconcileFailureCopy')
  })
})

// ————————————————————————————————————————————————————————————————
// Coverage — every sentence is pinned on both readings, and every sentence
// really has two
// ————————————————————————————————————————————————————————————————

/** One copy function's two answers, for the checks that span the whole module. */
interface BothReadings {
  /** The exported name, matched against the module's own export list. */
  name: string
  /** What it says about a mediated pull request. */
  github: unknown
  /** What it says about a review of two local branches. */
  local: unknown
}

/**
 * Every export of this module, asked both ways.
 *
 * Arguments are chosen to reach the wordiest branch of each function, and the
 * whole returned value is kept rather than one line of it, so a line added to
 * one of these records later is compared without touching this list.
 */
const BOTH_READINGS: BothReadings[] = [
  {
    name: 'conversationEmptyCopy',
    github: conversationEmptyCopy('github'),
    local: conversationEmptyCopy('local'),
  },
  {
    name: 'deleteLocalReviewCopy',
    github: deleteLocalReviewCopy('github', FULL_DRAFT),
    local: deleteLocalReviewCopy('local', FULL_DRAFT),
  },
  {
    name: 'deleteLocalReviewRefusedCopy',
    github: deleteLocalReviewRefusedCopy('github'),
    local: deleteLocalReviewRefusedCopy('local'),
  },
  {
    name: 'notFoundCopy',
    github: notFoundCopy('github', 415),
    local: notFoundCopy('local', LOCAL_KEY),
  },
  {
    name: 'stateChipCopy',
    github: stateChipCopy('github', 'open'),
    local: stateChipCopy('local', 'open'),
  },
  {
    name: 'authorBannerCopy',
    github: authorBannerCopy('github', 3),
    local: authorBannerCopy('local', 3),
  },
  {
    name: 'submitSuccessCopy',
    github: submitSuccessCopy('github', 3),
    local: submitSuccessCopy('local', 3),
  },
  {
    name: 'reconcileSuccessCopy',
    github: reconcileSuccessCopy('github', 5, 2),
    local: reconcileSuccessCopy('local', 5, 2),
  },
  {
    name: 'submitFailureCopy',
    github: submitFailureCopy('github'),
    local: submitFailureCopy('local'),
  },
  {
    name: 'reconcileFailureCopy',
    github: reconcileFailureCopy('github'),
    local: reconcileFailureCopy('local'),
  },
  { name: 'draftSavedCopy', github: draftSavedCopy('github'), local: draftSavedCopy('local') },
  { name: 'syncCostCopy', github: syncCostCopy('github'), local: syncCostCopy('local') },
  {
    name: 'neverSyncedCopy',
    github: neverSyncedCopy('github', 25),
    local: neverSyncedCopy('local', 25),
  },
  { name: 'syncErrorCopy', github: syncErrorCopy('github'), local: syncErrorCopy('local') },
  {
    name: 'dirtyWorktreeCopy',
    github: dirtyWorktreeCopy('github'),
    local: dirtyWorktreeCopy('local'),
  },
  {
    name: 'tooLargeDiffCopy',
    github: tooLargeDiffCopy('github'),
    local: tooLargeDiffCopy('local'),
  },
  { name: 'orgMemberTitle', github: orgMemberTitle('github'), local: orgMemberTitle('local') },
  { name: 'orgMemberChip', github: orgMemberChip('github'), local: orgMemberChip('local') },
  {
    name: 'paletteReviewHeading',
    github: paletteReviewHeading('github'),
    local: paletteReviewHeading('local'),
  },
  {
    name: 'stateChipVariant',
    github: stateChipVariant('github', 'closed'),
    local: stateChipVariant('local', 'closed'),
  },
  {
    name: 'supersededBadgeCopy',
    github: supersededBadgeCopy('github', 101),
    local: supersededBadgeCopy('local', 101),
  },
  {
    name: 'supersededBannerCopy',
    github: supersededBannerCopy('github', 101),
    local: supersededBannerCopy('local', 101),
  },
]

/** Two answers compared as whole values, records and nulls included. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

describe('every sentence in the module is accounted for on both readings', () => {
  test('every export is asked both ways here', () => {
    // The guard that stops the pins above decaying into a record of whatever
    // the module happened to export the day they were written. A copy function
    // added later and never pinned on the pull-request reading would leave that
    // reading — the one an ordinary review shows — checked by nothing at all.
    // Each entry named here has its literal pinned in its own block above; this
    // is what says no export is missing a block.
    const exported = Object.entries(modeCopy as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    const covered = new Set(BOTH_READINGS.map((c) => c.name))
    expect(exported.filter((name) => !covered.has(name))).toEqual([])
  })

  test('and there really are functions here to ask', () => {
    // The positive half of the guard above: an empty export list satisfies it
    // for free, and would satisfy the check below as well.
    expect(BOTH_READINGS.length).toBeGreaterThan(10)
    expect(BOTH_READINGS.every((c) => c.name !== '')).toBe(true)
  })

  test('and nothing here escapes being asked by not being a function', () => {
    // The hole in the guard above rather than in the list it checks. It reads
    // this module's exports and KEEPS ONLY THE FUNCTIONS, so a sentence
    // exported as a bare constant is dropped by the filter instead of reported
    // by it: never pinned on either reading, and never asked which review is
    // asking. Every sentence here varies by that, which is the whole reason the
    // module exists — a constant is a sentence that has stopped varying and
    // said so to nobody.
    const notFunctions = Object.entries(modeCopy as Record<string, unknown>)
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
    expect(notFunctions).toEqual([])
  })

  test('and no sentence gives the same answer whichever review asked it', () => {
    // The check that needs no wording to be useful, and the one that would have
    // caught the failure this whole module family was reorganised around: a
    // copy function that ignores its argument satisfies every absence written
    // about it, because an absence is satisfied by any wording that happens not
    // to contain the banned word — including the wording it was supposed to
    // replace. Two identical answers mean the mode reached the function and
    // changed nothing, which is the shape of that bug and of no correct
    // function here.
    const blind = BOTH_READINGS.filter((c) => same(c.github, c.local)).map((c) => c.name)
    expect(blind).toEqual([])
  })
})

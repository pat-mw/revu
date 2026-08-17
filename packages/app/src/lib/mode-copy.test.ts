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
import {
  authorBannerCopy,
  conversationEmptyCopy,
  draftSavedCopy,
  notFoundCopy,
  reconcileFailureCopy,
  reconcileSuccessCopy,
  stateChipCopy,
  submitFailureCopy,
  submitSuccessCopy,
} from './mode-copy'
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

/**
 * The review-mode derivation, the path matcher it shares with the chrome, the
 * per-mode data every gate reads, and the structural rules that keep all of it
 * defined and consulted exactly once.
 *
 * The behavioural half is small on purpose — a review number is either in the
 * reserved local band or it is a pull request, a path either has a review open
 * or it does not, and which sections a review offers is a table. The
 * interesting half is structural, and reads SOURCE rather than behaviour,
 * because the rules it holds are ABSENCES: a second copy of the path matcher, a
 * second reader of the band predicate, a threshold written out where the
 * predicate would have been asked, a route guard someone tidied away, and a
 * component handed a kind of review chosen at the call site rather than read
 * off the review. Every one of them compiles, passes every other test in the
 * suite, and ships. Nothing but a scan over the tree can hold them, so the
 * scans live here beside the derivation they protect.
 *
 * ## Why the predicate scan stops at the transport seam
 *
 * The rule is not "the predicate is imported once in the package". A transport
 * adapter MINTS ids in the reserved band and dispatches on them, so it
 * implements the boundary rather than reading it, and the fixtures it answers
 * from describe ids that are already in the band. Both sit below the seam that
 * keeps the UI ignorant of which transport answered, and both legitimately hold
 * many calls.
 *
 * What must stay singular is the READING side: components, pages, view-models
 * and the query layer ask one module what "local" means, so no second place
 * above the seam can drift about it. The scan is therefore scoped by directory
 * rather than by an allowlist of today's files — an allowlist would rot the
 * moment the transport grows a file, and would have to be edited by exactly the
 * change it exists to catch.
 *
 * Suites are excluded for the same reason the transport is: a test that asserts
 * a minted id lands in the band is checking the transport's behaviour, not
 * teaching the UI a second definition of local, and nothing a suite says
 * reaches a reader's screen. The exclusion is categorical, so adding a suite
 * never edits this list.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import {
  conversationSections,
  forbiddenSubmitRerouteAllowed,
  matchPrNumber,
  prPaletteCommands,
  redirectTargetFor,
  reviewArchived,
  reviewComposerHidden,
  reviewMode,
  reviewTabs,
  showRateChip,
  showSelfReviewLock,
  supersededBadgeShown,
  useRouteReviewMode,
} from './review-mode'

describe('the mode a review number is in', () => {
  test('a pull request number is github and a reserved-band id is local', () => {
    expect(reviewMode(347)).toBe('github')
    expect(reviewMode(1_000_000_001)).toBe('local')
  })
})

describe('reading the review number out of a path', () => {
  test('matches a review route with a tab and without one', () => {
    expect(matchPrNumber('/pr/1000000001/files')).toBe(1000000001)
    expect(matchPrNumber('/pr/347')).toBe(347)
  })

  test('is null where no review is open', () => {
    expect(matchPrNumber('/inbox')).toBe(null)
  })

  test('captures digits and nothing else, which the id design depends on', () => {
    // A review with no pull request behind it is identified by a SYNTHETIC
    // POSITIVE INTEGER precisely so this matcher, and every route and cache key
    // built on it, need no new shape. Widening the capture to admit non-digits
    // would make `/prs/347` and `/pr/abc` look like open reviews, which silently
    // breaks the tab-switch sequences and the palette's current-review group —
    // all three read a null here as "no review is open".
    expect(matchPrNumber('/pr/abc')).toBe(null)
    expect(matchPrNumber('/prs/347')).toBe(null)
  })
})

/** Renders whatever the hook returns under a router, as text a test can read. */
function ModeProbe() {
  return createElement('span', null, String(useRouteReviewMode()))
}

/** The hook's answer at one path, with the probe's markup taken back off. */
function modeAt(pathname: string): string {
  const markup = renderToStaticMarkup(
    createElement(StaticRouter, { location: pathname }, createElement(ModeProbe)),
  )
  return markup.replace(/<[^>]*>/g, '')
}

describe('the mode of the review the current path has open', () => {
  test('follows the number in the path, and is null off the review routes', () => {
    expect(modeAt('/pr/347/files')).toBe('github')
    expect(modeAt('/pr/1000000001/conversation')).toBe('local')
    expect(modeAt('/inbox')).toBe('null')
  })
})

describe('which sections a review offers', () => {
  test('a pull request offers all five, in the order the strip draws them', () => {
    // Pinned as a whole list rather than probed for two memberships: the order
    // is what a reader scans and the set is what the route guard reads, and an
    // exact value is the only form in which "and nothing else" can be read off.
    const githubTabs = ['description', 'conversation', 'files', 'commits', 'checks']
    expect(reviewTabs('github')).toEqual(githubTabs)
  })

  test('a local review offers only the three that mean something on a branch', () => {
    // No continuous integration runs against a branch pair and no body was
    // typed into a form for it, so those two sections have nothing true to say.
    const localTabs = ['conversation', 'files', 'commits']
    expect(reviewTabs('local')).toEqual(localTabs)
  })
})

describe('which blocks the conversation tab stacks', () => {
  test('a pull request stacks the description, the timeline and the threads', () => {
    // The whole list rather than three memberships: the order is the order the
    // page stacks them, and an exact value is the only form in which "and
    // nothing else" can be read off.
    const githubSections = ['description', 'timeline', 'threads']
    expect(conversationSections('github')).toEqual(githubSections)
  })

  test('a local review stacks the threads and nothing else', () => {
    // The description block names an author who "opened this pull request"
    // over a body nobody typed, and the timeline is fed by issue comments and
    // submitted reviews — neither of which a branch pair ever accumulates,
    // because a review submitted against one is persisted to its own record
    // rather than appended to the snapshot. So the description block is the
    // only one that would assert something untrue, and the timeline is inert
    // by construction. Re-adding either to this list is what this assertion
    // exists to turn red.
    expect(conversationSections('local')).toEqual(['threads'])
  })
})

describe('which of the current review the palette offers', () => {
  test('a local review is offered no Checks command', () => {
    expect(prPaletteCommands('local')).not.toContain('checks')
  })

  test('a pull request is — the control that the command exists at all', () => {
    // Without this, the absence above is satisfied by a palette group that
    // lost its Checks entry on both paths, which is a different change.
    expect(prPaletteCommands('github')).toContain('checks')
  })

  test('everything else the group offers is offered in both', () => {
    // The omission is one entry wide. A gate that swept the whole group off
    // the local path would still satisfy the assertion above.
    const shared = ['files', 'conversation', 'commits', 'resync', 'walk-threads']
    for (const command of shared) {
      expect(prPaletteCommands('local')).toContain(command)
      expect(prPaletteCommands('github')).toContain(command)
    }
  })
})

describe('a tab reached by bookmark that the strip no longer offers', () => {
  test('a local review sends the two omitted tabs to Files', () => {
    // Omitting a link does not omit its route: both paths stay typeable and
    // bookmarkable, and both would otherwise render a screen whose entire
    // content is a claim about a service this workspace is not talking to.
    expect(redirectTargetFor('local', 'checks')).toBe('files')
    expect(redirectTargetFor('local', 'description')).toBe('files')
  })

  test('a tab the review does offer is left alone', () => {
    // The control for the two redirects: a guard that redirected everything
    // would satisfy them and make the whole review one tab deep.
    expect(redirectTargetFor('github', 'checks')).toBe(null)
    expect(redirectTargetFor('github', 'description')).toBe(null)
    expect(redirectTargetFor('local', 'files')).toBe(null)
    expect(redirectTargetFor('local', 'conversation')).toBe(null)
    expect(redirectTargetFor('local', 'commits')).toBe(null)
  })
})

describe('whether the verdict picker locks its approving segments', () => {
  test('a branch pair does not, not even before its list entry has arrived', () => {
    // The case this gate exists for. The approval flag is read off the review's
    // list entry and falls back to false while that list is still loading — a
    // state EVERY review passes through on first paint, and one any list error
    // leaves it in for good. Gated on the flag alone, a review of two local
    // branches therefore shows the mediated-pull-request explanation, which
    // names a person and a website that have nothing to do with it, for as long
    // as the list takes to arrive.
    expect(showSelfReviewLock({ mode: 'local', canApprove: false })).toBe(false)
  })

  test('and does not once that entry says it may approve either', () => {
    expect(showSelfReviewLock({ mode: 'local', canApprove: true })).toBe(false)
  })

  test('a pull request this identity may not approve does', () => {
    // The control for the two above: a gate that answered false everywhere
    // would satisfy both and silently remove the only explanation of why two
    // of the three segments refuse to select on a mediated pull request.
    expect(showSelfReviewLock({ mode: 'github', canApprove: false })).toBe(true)
  })

  test('and one it may approve does not', () => {
    expect(showSelfReviewLock({ mode: 'github', canApprove: true })).toBe(false)
  })
})

describe('whether a review has been superseded and gone read-only', () => {
  test('a local review whose row reports it closed is archived', () => {
    // The positive leg. Every case below is a refusal, and a predicate that
    // refused everything would satisfy all of them at once.
    expect(reviewArchived({ mode: 'local', state: 'closed' })).toBe(true)
  })

  test('and one still taking comments is not', () => {
    expect(reviewArchived({ mode: 'local', state: 'open' })).toBe(false)
  })

  test('and one whose row has not been read yet is not either', () => {
    // The state of every review on first paint, and of any review for good
    // after a list error. "Not known yet" is not evidence that a review was
    // superseded, so it takes the same path as a live one — the refusal at the
    // other end of the write is what makes that safe rather than optimistic.
    expect(reviewArchived({ mode: 'local', state: undefined })).toBe(false)
  })

  test('a closed pull request is never archived in this sense', () => {
    // A pull request closes for its own reasons and none of them are this one.
    // Asserted across all three readings of the state, because a gate that
    // tested only the state would pass the first of them.
    expect(reviewArchived({ mode: 'github', state: 'closed' })).toBe(false)
    expect(reviewArchived({ mode: 'github', state: 'open' })).toBe(false)
    expect(reviewArchived({ mode: 'github', state: undefined })).toBe(false)
  })
})

describe('whether the review bar offers a way to write', () => {
  test('an archived local review is offered none', () => {
    expect(reviewComposerHidden({ mode: 'local', state: 'closed' })).toBe(true)
  })

  test('and a live one keeps every one of them', () => {
    // The control: a gate that hid the composer everywhere would satisfy the
    // case above and leave no review anywhere writable.
    expect(reviewComposerHidden({ mode: 'local', state: 'open' })).toBe(false)
  })

  test('and one whose row has not arrived keeps them too', () => {
    // Deliberately permissive while the row is unknown. A composer that
    // vanished on every first paint would be worse than one offered on a
    // review that turns out to refuse the write, which is answered where the
    // write is answered.
    expect(reviewComposerHidden({ mode: 'local', state: undefined })).toBe(false)
  })

  test('a closed pull request keeps them as well', () => {
    // Commenting on a closed pull request is ordinary and still goes through.
    expect(reviewComposerHidden({ mode: 'github', state: 'closed' })).toBe(false)
  })
})

describe('whether a refused submit may rewrite the verdict the draft holds', () => {
  test('a refused pull request review is moved to Comment', () => {
    // What the reroute was written for. A pull request opened by the shared
    // identity cannot be approved by it, so the verdict the draft holds is one
    // the far end will refuse again on every retry; moving it to the verdict
    // that can go through is the remedy the refusal itself names, applied.
    expect(forbiddenSubmitRerouteAllowed('github')).toBe(true)
  })

  test('and a refused local review keeps whatever verdict it holds', () => {
    // A local review is refused for one reason only — a pull request came to
    // cover its branch pair, so it is read-only — and no verdict would have
    // been accepted. Rewriting the draft's here would be the refusal quietly
    // editing the one thing that survives everything else: an author who asked
    // for changes would find a comment in its place, with nothing on the
    // screen having said so and nothing to undo it with.
    expect(forbiddenSubmitRerouteAllowed('local')).toBe(false)
  })
})

describe('whether a row says which pull request superseded it', () => {
  test('a local review carrying a number says so', () => {
    expect(supersededBadgeShown({ mode: 'local', archivedPr: 101 })).toBe(true)
  })

  test('and one carrying none does not', () => {
    expect(supersededBadgeShown({ mode: 'local', archivedPr: null })).toBe(false)
  })

  test('and neither does one whose annotations have not been read', () => {
    expect(supersededBadgeShown({ mode: 'local', archivedPr: undefined })).toBe(false)
  })

  test('a pull request never says it, even holding a number', () => {
    // The reading that matters most. The annotation this is drawn from is
    // local-only, so a pull request should never carry one at all — and a gate
    // that trusted the number alone would put "superseded by #101" on a pull
    // request the moment anything upstream started sending one.
    expect(supersededBadgeShown({ mode: 'github', archivedPr: 101 })).toBe(false)
  })
})

describe('whether the topbar draws the shared-budget chip', () => {
  test('a workspace with a budget to report gets one', () => {
    expect(showRateChip({ rateAvailable: true })).toBe(true)
  })

  test('a workspace with none gets no chip at all', () => {
    // OMITTED, not hidden and not emptied. The chip stands in for an unresolved
    // read with a shimmer, so a workspace that will never resolve one would
    // shimmer in its topbar for as long as it stayed open — which reads as a
    // load that never finishes rather than as a budget that does not exist.
    expect(showRateChip({ rateAvailable: false })).toBe(false)
  })

  test('and a workspace that has not answered yet keeps its place', () => {
    // The case the whole gate is really about, and the reason the input is
    // three-valued: a read still in flight is not evidence of absence. Folding
    // it in with "no budget" would blink the chip out of every topbar on every
    // load and back in a moment later; folding it in with "has one" is what the
    // chip did before, and is what leaves a workspace with no budget shimmering
    // forever. It is neither, and it falls to the side that keeps today's
    // behaviour while the question is open.
    expect(showRateChip({ rateAvailable: null })).toBe(true)
  })

  test('and the chip is a property of the workspace, not of the open review', () => {
    // The gate takes no mode, and that is a decision rather than an omission.
    // The budget is read once, globally, with no review to scope it to, so
    // suppressing the chip while a branch pair is open and restoring it on the
    // next pull request would report a different budget per screen for one
    // workspace. A workspace wired to an upstream service has a budget on every
    // screen including a branch pair's; one wired to none has it on no screen.
    //
    // Pinned as the signature rather than as behaviour, because there is no
    // input that could demonstrate the absence of a parameter.
    expect(read('lib/review-mode.ts')).toContain(
      'export function showRateChip({ rateAvailable }: RateChipInput): boolean',
    )
  })
})

/**
 * The router's source. Read as text because the claim below is about WIRING
 * that only a renderer could execute — the predicate above can be correct and
 * still be consulted by nobody.
 */
const APP_SOURCE = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

/** The review bar's source, read for the same reason the router's is. */
const REVIEW_BAR_SOURCE = readFileSync(
  new URL('../components/review/review-bar.tsx', import.meta.url),
  'utf8',
)

describe('the review bar consults the archived gate', () => {
  test('the bar imports the gate by name', () => {
    // PRESENCE, not execution. The predicate is asserted directly above; what
    // this turns red is the gate tidied away and the writing controls drawn
    // again on a review that can no longer take them — a change every
    // behavioural test in this file would stay green through, because none of
    // them can render the bar.
    const imported =
      /import\s*\{[^}]*\breviewComposerHidden\b[^}]*\}\s*from\s*'@\/lib\/review-mode'/
    expect(imported.test(REVIEW_BAR_SOURCE)).toBe(true)
  })

  test('and reads it exactly once, into the name its surfaces are drawn behind', () => {
    // One read is the read the whole bar branches on. A second is a second
    // opinion that can disagree with the first, and the disagreement would show
    // as one control still live on a review where its neighbours are gone.
    const reads = REVIEW_BAR_SOURCE.match(/reviewComposerHidden\(/g) ?? []
    expect(reads.length).toBe(1)
    expect(REVIEW_BAR_SOURCE).toContain('const writesHidden = reviewComposerHidden(')
  })

  test('and three drawn ways of writing a review are withheld behind that answer', () => {
    // The count is a literal taken from the surfaces themselves — the summary
    // composer, the verdict picker and Submit — rather than derived from
    // anything that moves with the file, so dropping a guard is a number that
    // changed rather than a green run over one fewer control. The fourth way
    // in, Start review, is unreachable instead: the bar draws nothing at all on
    // an archived review with no draft on it.
    const drawn = REVIEW_BAR_SOURCE.match(/\{!writesHidden/g) ?? []
    expect(drawn.length).toBe(3)
  })

  test('and the two keys that reach those controls are gated as well', () => {
    // A control that is not drawn is still reachable by the chord that opens
    // it: the summary key and the submit chord are registered globally and
    // would otherwise open a composer on a review with none, and send a draft
    // the far end refuses. Counted separately from the drawn surfaces above,
    // because these are the half no amount of looking at the strip would show.
    const keyed = REVIEW_BAR_SOURCE.match(/&& !writesHidden/g) ?? []
    expect(keyed.length).toBe(2)
  })

  test('and an archived review with no draft draws no bar at all', () => {
    // The other half of the same rule. Left in, the strip would say a review is
    // not in progress and offer to start one, on a review that would refuse it.
    expect(REVIEW_BAR_SOURCE).toContain('if (writesHidden && !active) return null')
  })
})

/** The review bar's source with runs of whitespace flattened to single spaces. */
const REVIEW_BAR_FLAT = REVIEW_BAR_SOURCE.replace(/\s+/g, ' ')

describe('what the review bar does with a submit the far end refused', () => {
  test('the bar imports the reroute gate by name', () => {
    // PRESENCE, not execution. The predicate is asserted directly above; what
    // this turns red is the gate tidied away and the verdict rewritten on
    // every refusal again, which no behavioural test in this file can see
    // because none of them renders the bar.
    //
    // Anchored to the import STATEMENT and the module it comes from, so a
    // mention of the name in a comment or a leftover local does not satisfy it.
    const imported =
      /import\s*\{[^}]*\bforbiddenSubmitRerouteAllowed\b[^}]*\}\s*from\s*'@\/lib\/review-mode'/
    expect(imported.test(REVIEW_BAR_SOURCE)).toBe(true)
  })

  test('and the one verdict rewrite in it happens only behind that gate', () => {
    // The rewrite is persisted into the draft, so an ungated one is a silent
    // edit to a document the author never touched. The count is what makes the
    // guard above mean anything: a second rewrite somewhere else in the file
    // would restore the behaviour the gate replaced while the gate itself
    // stayed green beside it.
    expect(REVIEW_BAR_FLAT).toContain(
      "if (forbiddenSubmitRerouteAllowed(mode)) actions.setEvent('COMMENT')",
    )
    const rewrites = REVIEW_BAR_SOURCE.match(/setEvent\('COMMENT'\)/g) ?? []
    expect(rewrites.length).toBe(1)
  })

  test('and the refusal sentence is the toast body, never its title', () => {
    // The refusals this branch renders are whole sentences — one names the
    // pull request that superseded the review, its branch pair, and what did
    // not reach it. A title is set in medium weight and given no room to wrap
    // to; the body below it is where a sentence that long is legible.
    //
    // The control sits in this body rather than another, because "no sentence
    // in the title" is equally what a branch that dropped the reason entirely
    // would produce, and the two have to be told apart by one reading.
    expect(REVIEW_BAR_FLAT).toContain('detail: result.reason')
    expect(/title:\s*result\.reason/.test(REVIEW_BAR_SOURCE)).toBe(false)
  })
})

describe('the verdict picker consults the lock decision', () => {
  test('the read is looking at the bar it names', () => {
    // The control for the two pins below: a path resolving to the wrong file,
    // or to an empty one, would satisfy neither for a reason that has nothing
    // to do with wiring.
    expect(/export function ReviewBar\(/.test(REVIEW_BAR_SOURCE)).toBe(true)
  })

  test('the bar imports the lock decision by name', () => {
    // PRESENCE, not execution. The assertions above prove only that the
    // decision is right; nothing here proves the picker renders on its answer.
    // What it does turn red is the change it exists to catch — the gate tidied
    // away and the approval flag read straight into the picker again, which
    // every other test in this file would stay green through.
    //
    // Anchored to the import STATEMENT and the module it comes from, so a
    // mention of the name in a comment or a leftover local does not satisfy it.
    const imported =
      /import\s*\{[^}]*\bshowSelfReviewLock\b[^}]*\}\s*from\s*'@\/lib\/review-mode'/
    expect(imported.test(REVIEW_BAR_SOURCE)).toBe(true)
  })

  test('and the approval flag is read exactly once in it', () => {
    // The flag defaults to "may not approve" while the review's list entry
    // loads, which is why it is not a safe gate on its own. One read is the
    // read that feeds the gate; a second one is an ungated branch that restores
    // the behaviour the gate replaced, sitting beside a gate that stays green.
    const reads = REVIEW_BAR_SOURCE.match(/broker\.canApprove/g) ?? []
    expect(reads.length).toBe(1)
  })
})

/** The router's source with runs of whitespace flattened to single spaces. */
const APP_FLAT = APP_SOURCE.replace(/\s+/g, ' ')

/**
 * What the router mounts DIRECTLY at one review tab's path, by name — or a
 * sentence saying it mounts nothing there.
 *
 * Anchored to the path, so an answer about one tab is never an answer about
 * whichever route the table happens to list first. The component's name is
 * returned rather than a boolean because the failure is then the name of the
 * thing that replaced the guard, which says what happened as well as that
 * something did.
 */
function elementAt(tab: string): string {
  const match = new RegExp(`<Route path="${tab}" element=\\{ ?<(\\w+)`).exec(APP_FLAT)
  return match === null ? `no route mounts a ${tab} tab` : match[1]
}

describe('the route table consults the redirect decision', () => {
  test('the read is looking at the router it names', () => {
    // The control for the pin below: a path resolving to the wrong file, or to
    // an empty one, would fail it for a reason with nothing to do with wiring.
    expect(/export function App\(\)/.test(APP_SOURCE)).toBe(true)
  })

  test('the router imports the redirect decision by name', () => {
    // PRESENCE, not execution. This does not prove the guard runs on the two
    // omitted tabs; the assertions above prove only that the decision is
    // right. What it does turn red is the change it exists to catch — the
    // route guard tidied away as dead-looking indirection, which silently
    // re-exposes both screens to anyone holding a bookmark and is invisible to
    // every other test in the suite.
    //
    // Anchored to the import STATEMENT and to the module it comes from, so a
    // mention of the name in a comment, a string, or a leftover local does not
    // satisfy it.
    const imported =
      /import\s*\{[^}]*\bredirectTargetFor\b[^}]*\}\s*from\s*'@\/lib\/review-mode'/
    expect(imported.test(APP_SOURCE)).toBe(true)
  })

  test('the read finds the route it names, and no route it was not asked for', () => {
    // The control for the two pins below. Without it they are equally satisfied
    // by a pattern that matched whichever route came first whatever path was
    // asked for — under which unwrapping exactly one screen leaves both green,
    // which is the single-route regression they exist for.
    expect(elementAt('commits')).toBe('ReviewSection')
    expect(elementAt('settings')).toBe('no route mounts a settings tab')
  })

  // One tab per test. Both are guarded by the same component today, so a pair
  // in one body would let the second tab's exposure hide behind the first.
  test('the checks route is answered by the guard, not by the screen', () => {
    // The import pin above says the guard exists somewhere in this table; it
    // cannot say which routes are inside it. Wrapping four of the five leaves
    // that pin satisfied, `tsc` clean and every test in the package green,
    // while a bookmarked branch-pair path renders a screen whose whole content
    // is where to find logs for a build that never ran.
    expect(elementAt('checks')).toBe('ReviewSection')
  })

  test('and so is the description route', () => {
    // The other screen with nothing true to render on a branch pair: a body
    // nobody typed into a form, described as having been opened empty.
    expect(elementAt('description')).toBe('ReviewSection')
  })
})

/** The app's source root — this file sits one directory below it. */
const SRC = join(import.meta.dir, '..')

/** Every `.ts`/`.tsx` file under the source root, as paths relative to it. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .sort()
}

/** One scanned file's text. */
function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8')
}

/** Directories that sit below the transport seam and implement the id band. */
const BELOW_THE_SEAM = ['api/', 'fixtures/']

/** Whether a scanned path is a suite rather than shipped source. */
function isSuite(relative: string): boolean {
  return /\.test\.tsx?$/.test(relative)
}

/** The shipped files above the transport seam — everything a reader can see. */
function readingSideFiles(): string[] {
  return sourceFiles().filter(
    (p) => !isSuite(p) && !BELOW_THE_SEAM.some((dir) => p.startsWith(dir)),
  )
}

/**
 * The shared band predicate's name, assembled from two halves so that this
 * file — which the scan below reads along with every other — cannot count
 * itself as a call site.
 */
const PREDICATE_TAIL = 'Id'
const BAND_PREDICATE = `isLocalReview${PREDICATE_TAIL}`

/**
 * Every way the band's first id can be written into a comparison.
 *
 * Three numeric spellings and the shared constant they all come from. The
 * numeric ones are bounded so a longer number that merely starts or ends the
 * same way is not mistaken for the threshold — a scan that cannot tell those
 * apart turns red on arithmetic that has nothing to do with review identity.
 */
const BAND_BASE_SPELLINGS: RegExp[] = [
  /1_000_000_000(?!\d|_)/,
  /(?<![\d_])1000000000(?!\d)/,
  /(?<![\w.])1e9\b/i,
  /LOCAL_REVIEW_ID_BASE/,
]

describe('the scan itself', () => {
  test('reads real files, and the seam it stops at is where the calls are', () => {
    // Both guards below assert an absence, and an absence is satisfied for free
    // by a scan that read nothing. This pins that the walk reaches shipped
    // source on both sides of the seam, and — the part that matters — that the
    // exclusion is LOAD-BEARING: the transport really does hold calls to the
    // predicate, so a guard that forgot to scope itself would be red on arrival
    // rather than quietly equivalent to this one.
    expect(readingSideFiles()).toContain('lib/local-reviews.ts')
    expect(readingSideFiles()).toContain('components/app-shell.tsx')

    const belowSeam = sourceFiles().filter(
      (p) => BELOW_THE_SEAM.some((dir) => p.startsWith(dir)) && read(p).includes(BAND_PREDICATE),
    )
    expect(belowSeam).toContain('api/mock/adapter.ts')
  })
})

describe('one definition, one reader', () => {
  test('the path matcher is defined exactly once in the app', () => {
    // The pattern needs real whitespace between the keyword and the name, so
    // naming the matcher in prose or in a quoted string does not trip it. This
    // scan is deliberately UNSCOPED — a duplicate matcher is a drift risk
    // wherever it appears, including below the transport seam.
    const definers: string[] = []
    let definitions = 0
    for (const relative of sourceFiles()) {
      const hits = read(relative).match(/function\s+matchPrNumber\b/g)
      if (hits === null) continue
      definers.push(relative)
      definitions += hits.length
    }
    expect(definers).toEqual(['lib/review-mode.ts'])
    expect(definitions).toBe(1)
  })

  test('the band predicate has one caller above the transport seam', () => {
    // Including this module, which derives a mode from that one caller's answer
    // rather than re-deriving the band membership itself.
    const callers = readingSideFiles().filter((p) => read(p).includes(BAND_PREDICATE))
    expect(callers).toEqual(['lib/local-reviews.ts'])
  })

  test('and nothing up here compares a review number to the band base itself', () => {
    // The other half of the same rule, and the half a scan for the predicate's
    // NAME cannot hold: a second reader does not have to call the predicate to
    // become a second opinion. Written out as a threshold — or as the shared
    // constant it is defined from — it is the same decision restated, and the
    // failure it produces is identical: a review that is local to one surface
    // and remote to another, silent on every screen but the one that renders a
    // key nobody was meant to see.
    //
    // Every spelling of the same number is looked for, because which one a
    // second reader reaches for is a matter of taste. The scan carries the same
    // categorical exclusions as the one above: the transport MINTS ids in the
    // band and legitimately names where it starts, and a suite asserting that a
    // minted id landed in the band is checking the transport rather than
    // teaching the interface a second definition of local. Suites are excluded
    // for that reason and, incidentally, are why this file cannot count itself.
    const offenders = readingSideFiles().filter((p) =>
      BAND_BASE_SPELLINGS.some((spelling) => spelling.test(read(p))),
    )
    expect(offenders).toEqual([])
  })
})

/** Every `<IdentityAvatar …>` element in one file, as its attribute text. */
function avatarElements(relative: string): string[] {
  const flat = read(relative).replace(/\s+/g, ' ')
  return [...flat.matchAll(/<IdentityAvatar\b([^>]*)>/g)].map((m) => m[1])
}

/** Whether an element's `mode` is a constant written at the call site. */
function handedAConstantMode(attributes: string): boolean {
  return /\bmode=(?:"[^"]*"|\{ ?'[^']*' ?\})/.test(attributes)
}

describe('the identity treatment is decided by the review, not by the call site', () => {
  // The ring and the hover title saying where a person reviews are drawn for
  // every author whose login is not the shared write identity's — which is EVERY
  // author of a review of two local branches, because the one recorded on it is
  // synthesized here and carries no shared login. The component takes the kind
  // of review as a REQUIRED prop so a call site that never considered the
  // question cannot compile; what nothing but a scan can say is that a call site
  // which did consider it answered from the review rather than from a guess.
  //
  // Scoped to the reading side for the reason every scan here is: a suite
  // renders the component with a chosen mode precisely to assert both
  // treatments, and the transport draws nothing.
  test('the scan finds the call sites it is scanning', () => {
    // The control. Every assertion below holds an absence, and an absence over
    // a walk that matched no elements at all is satisfied for free — by a
    // renamed component, a reformatted call site, or a regex that stopped
    // matching JSX.
    const drawn = readingSideFiles().filter((p) => avatarElements(p).length > 0)
    expect(drawn.length).toBeGreaterThan(3)
  })

  test('and no call site hands it a kind of review chosen by hand', () => {
    // A missing prop is a compile error and a WRONG one is nothing at all, so
    // this is the only thing standing between a screen and the treatment it was
    // taken off. Reported as the whole list of offending files rather than the
    // first, and derived from a walk rather than from a list of today's call
    // sites — a new surface drawing an avatar is covered without editing this.
    const offenders = readingSideFiles().filter((p) =>
      avatarElements(p).some(handedAConstantMode),
    )
    expect(offenders).toEqual([])
  })
})

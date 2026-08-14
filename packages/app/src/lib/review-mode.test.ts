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
 * second reader of the band predicate, and a route guard someone tidied away
 * all compile, pass every other test in the suite, and ship. Nothing but a scan
 * over the tree can hold them, so the scan lives here beside the derivation it
 * protects.
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
  matchPrNumber,
  prPaletteCommands,
  redirectTargetFor,
  reviewMode,
  reviewTabs,
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

/**
 * The router's source. Read as text because the claim below is about WIRING
 * that only a renderer could execute — the predicate above can be correct and
 * still be consulted by nobody.
 */
const APP_SOURCE = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

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
})

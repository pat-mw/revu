/**
 * The review header — its identity row, its meta row and its tab strip —
 * rendered as real HTML in both kinds of review, plus the pure decision behind
 * the one banner the header hangs beneath them.
 *
 * A review of two local branches has no continuous integration behind it and no
 * body someone typed into a form, so a Checks tab and a Description tab there
 * lead to screens whose only content is a claim about a service this workspace
 * is not talking to. The strip omits them. That is an ABSENCE, and an absence
 * asserted against markup is satisfied for free by markup that rendered nothing
 * at all — so every `not.toContain` below is paired with the same string
 * asserted PRESENT in the other mode, from the same component and the same
 * harness.
 *
 * `PrTabs`, `PrIdentityRow` and `PrMetaRow` are props-only for exactly this
 * reason: the layout around them needs a query client, a session and a
 * populated pull list before it renders a single element, while the strip needs
 * only the mode and two counts, the identity row needs only the mode and the
 * review itself, and the meta row needs those plus what the snapshot said.
 *
 * The reviews are read out of the fixture set rather than assembled here. What
 * is under test is what the header does with a real review — a branch pair
 * whose head is `release/0.41` is exactly the kind of name a careless identity
 * assertion mistakes for a leaked key — and a review built by the test would
 * prove only that the test built it that way.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import type {
  CheckRun,
  CommentIdentity,
  PullDetail,
  PullSummary,
  Snapshot,
  StalenessInfo,
} from '@revu/shared'
import { identityName, parseCommentIdentity } from '@revu/shared'
import { fixtureDB } from '@/fixtures'
import { countChecks } from '@/lib/checks-rollup'
import { renderStatic } from '@/lib/render-test'
import { SHORTCUT_CATALOG } from '@/lib/shortcuts'
import { authorBannerVisible } from '@/components/author/author-banner'
import { PrIdentityRow, PrMetaRow, PrTabs, SnapshotSeal } from './pr-layout'

/** The strip as HTML, with counts that make both count slots render. */
function strip(mode: 'github' | 'local'): string {
  return renderStatic(createElement(PrTabs, { mode, changedFiles: 12, unresolved: 3 }))
}

/** The nav's accessible name, or a sentence saying it has none. */
function navLabel(html: string): string {
  const match = /<nav[^>]*\saria-label="([^"]*)"/.exec(html)
  return match === null ? 'the tab strip has no accessible name' : match[1]
}

const GITHUB = strip('github')
const LOCAL = strip('local')

describe('which sections a review offers', () => {
  test('a pull request offers all five', () => {
    // The control for the two absences below: these exact strings do reach the
    // markup from this component, so their absence in the other mode is the
    // omission and not a component that rendered nothing.
    expect(GITHUB).toContain('Description')
    expect(GITHUB).toContain('Conversation')
    expect(GITHUB).toContain('Files')
    expect(GITHUB).toContain('Commits')
    expect(GITHUB).toContain('Checks')
  })

  test('a local review offers the three that mean something on a branch', () => {
    expect(LOCAL).toContain('Conversation')
    expect(LOCAL).toContain('Files')
    expect(LOCAL).toContain('Commits')
  })

  // The two absences are asserted one per test rather than together: a runner
  // stops a test at its first failure, so a pair in one body would let the
  // second tab's return go unreported behind the first.
  //
  // Both are searched over the WHOLE markup rather than over link labels, so a
  // tab reintroduced through a different element — a title, a heading, an
  // aria-label — is caught too. The hrefs are lowercase (`/checks`), so neither
  // string can be matched by a route that legitimately survives.
  test('and omits Checks', () => {
    expect(LOCAL).not.toContain('Checks')
  })

  test('and omits Description', () => {
    expect(LOCAL).not.toContain('Description')
  })
})

describe('what the tab strip is called', () => {
  test('a pull request names the pull request', () => {
    expect(navLabel(GITHUB)).toBe('Pull request sections')
  })

  test('a local review has a name, and it names no pull request', () => {
    // Both halves matter. Dropping the label entirely would satisfy the second
    // assertion while leaving the only landmark in the header unnamed.
    expect(navLabel(LOCAL)).not.toBe('the tab strip has no accessible name')
    expect(navLabel(LOCAL)).not.toMatch(/pull request/i)
  })
})

describe('the tabs that survive the omission', () => {
  test('each is a link, and none suppresses the global focus ring', () => {
    // Three anchors in the local strip is the count itself, read off the
    // markup rather than off the component's source. `outline-none` anywhere
    // in a tab's classes would remove the one focus indicator the stylesheet
    // gives every focusable thing, and a tab that cannot be seen when focused
    // is a tab a keyboard reader loses.
    expect(LOCAL.match(/<a\b/g)).toHaveLength(3)
    expect(GITHUB.match(/<a\b/g)).toHaveLength(5)
    expect(LOCAL).not.toContain('outline-none')
    expect(GITHUB).not.toContain('outline-none')
  })

  test('the counts still reach the tabs that carry them', () => {
    // Guards the extraction: the two counts were props of the layout before
    // the strip was lifted out, and a strip that quietly stopped drawing them
    // would pass every assertion above.
    expect(LOCAL).toContain('12')
    expect(LOCAL).toContain('3')
  })

  test('a count slot is omitted rather than drawn as zero', () => {
    const quiet = renderStatic(
      createElement(PrTabs, { mode: 'local', changedFiles: undefined, unresolved: 0 }),
    )
    expect(quiet).toContain('Conversation')
    expect(quiet).not.toContain('>0<')
  })
})

/** Every catalogued chord whose id or label mentions one of these words. */
function chordsNaming(pattern: RegExp): string[] {
  return SHORTCUT_CATALOG.filter((s) => pattern.test(s.id + s.label)).map((s) => s.id)
}

describe('the chords the help sheet documents still lead somewhere', () => {
  test('the catalog does name the sections a review keeps', () => {
    // The control for the absence below: this search finds a chord when there
    // is one to find, so an empty result there is the omission rather than a
    // predicate that matches nothing at all.
    expect(chordsNaming(/files|conversation/i)).toContain('go-files')
    expect(chordsNaming(/files|conversation/i)).toContain('go-conversation')
  })

  test('and none of them targets a section a branch pair does not offer', () => {
    // Two sections are omitted from a review of two local branches, and a
    // documented chord that jumped to either would be a key the help sheet
    // promises and the strip cannot honour. Asserted as the whole list of
    // offenders so every one is named at once, and asserted here rather than
    // read once by eye so it stays true after the next chord is added.
    expect(chordsNaming(/checks|description/i)).toEqual([])
  })
})

// ————————————————————————————————————————————————————————————————
// The identity row
// ————————————————————————————————————————————————————————————————

/** The seeded pull request with this number, whole, or a failure naming it. */
function pullNumbered(n: number): (typeof fixtureDB.pulls)[number] {
  const found = fixtureDB.pulls.find((p) => p.detail.number === n)
  if (found === undefined) throw new Error(`the fixture set holds no pull request ${n}`)
  return found
}

const GITHUB_FIXTURE = pullNumbered(347)
const GITHUB_PULL: PullDetail = GITHUB_FIXTURE.detail
const LOCAL_SNAPSHOT = fixtureDB.localReviews[0].snapshot
const LOCAL_PULL: PullDetail = LOCAL_SNAPSHOT.mutable.pull

/** One review's identity row as HTML. */
function identityRow(mode: 'github' | 'local', pull: PullSummary): string {
  return renderStatic(createElement(PrIdentityRow, { mode, pull }))
}

/** Rendered text with the markup taken out, so an assertion reads what a reader would. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The identity slot's accessible name, or a sentence saying it has none. */
function identityLabel(markup: string): string {
  const match = /\saria-label="([^"]*)"/.exec(markup)
  return match === null ? 'the identity slot has no accessible name' : match[1]
}

const GITHUB_ROW = identityRow('github', GITHUB_PULL)
const LOCAL_ROW = identityRow('local', LOCAL_PULL)

describe('what a review is called in its own header', () => {
  test('a pull request is called by its number', () => {
    // The positive control for both absences below: this search does find a
    // number in this component's markup when there is one to find.
    expect(visibleText(GITHUB_ROW)).toContain('#347')
  })

  test('a branch pair is called by the two branches it compares', () => {
    expect(visibleText(LOCAL_ROW)).toContain(
      `${LOCAL_PULL.base.ref} ← ${LOCAL_PULL.head.ref}`,
    )
  })

  test('and renders no number anywhere in its markup', () => {
    // The rule as a regex over real markup rather than as a promise about one
    // element, so it stays true if a later edit reintroduces the number
    // through a different one — a heading, a title, an attribute. Searched
    // over the raw HTML for that reason, not over the visible text.
    expect(LOCAL_ROW).not.toMatch(/#\d+/)
  })

  test('nor the key itself, unadorned', () => {
    // Searched WHOLE. Hunting for digits of the key would collapse to "names
    // no 0 and no 1", which this fixture's own `release/0.41` trips with
    // nothing leaked at all.
    expect(LOCAL_ROW).not.toContain(String(LOCAL_PULL.number))
  })

  test('the pair is named as one thing, because an arrow has no spoken form', () => {
    expect(identityLabel(LOCAL_ROW)).toBe(
      `Local review of ${LOCAL_PULL.head.ref} against ${LOCAL_PULL.base.ref}`,
    )
  })

  test('a branch pair says where it came from, and a pull request does not', () => {
    // The marker is a provenance fact, so it is the quiet outline chip rather
    // than the violet reserved for pending work or the gold for a snapshot
    // time moved underneath.
    expect(LOCAL_ROW).toContain('>local<')
    expect(GITHUB_ROW).not.toContain('>local<')
  })

  test('both kinds of review still say what state they are in', () => {
    // Dropping the chip on one path would make a review still taking comments
    // look exactly like one that is finished with them.
    expect(visibleText(GITHUB_ROW)).toContain('open')
    expect(visibleText(LOCAL_ROW)).toContain('in review')
  })

  test('a pull request closed without landing is chipped as the alarm it may be', () => {
    // The positive control for the assertion below: the danger tint is real,
    // reachable from this component, and findable in its markup.
    const closedPull = identityRow('github', {
      ...GITHUB_PULL,
      state: 'closed',
      merged_at: null,
    })
    expect(closedPull).toContain('text-danger')
  })

  test('and an archived branch pair is chipped quietly instead', () => {
    // A local review leaves the open state for exactly one reason — a pull
    // request now covers the same branch pair — which is the work moving on
    // rather than anything going wrong. In the alarm tint every archived
    // review in the app would read as a failure, and a colour is a claim no
    // sweep over wording would catch.
    const archived = identityRow('local', { ...LOCAL_PULL, state: 'closed', merged_at: null })
    expect(archived).toContain('archived')
    expect(archived).not.toContain('text-danger')
  })

  test('and both draw the title they were given', () => {
    expect(visibleText(GITHUB_ROW)).toContain(GITHUB_PULL.title)
    expect(visibleText(LOCAL_ROW)).toContain(LOCAL_PULL.title)
  })
})

// ————————————————————————————————————————————————————————————————
// The meta row
// ————————————————————————————————————————————————————————————————

/**
 * Who a review's author resolves to, derived the way the layout derives it —
 * from the review's own user and the session's shared write identity — so the
 * row is rendered with the object it is actually handed rather than one the
 * test invented to suit itself.
 */
function authorOf(pull: PullDetail): CommentIdentity {
  return parseCommentIdentity(
    { user: pull.user, body: pull.body ?? '' },
    fixtureDB.brokerBot.login,
  ).identity
}

/**
 * One review's meta row as HTML.
 *
 * The review stands in for both of the layout's two readings of it: the list's
 * summary and the snapshot's fuller detail are the same review, and the row
 * draws different facts from each.
 */
function metaRow(mode: 'github' | 'local', pull: PullDetail, checks: CheckRun[]): string {
  return renderStatic(
    createElement(PrMetaRow, {
      mode,
      pull,
      author: authorOf(pull),
      detail: pull,
      checks: countChecks(checks),
    }),
  )
}

/** The branch pair exactly as a reader sees it drawn. */
function pairText(pull: PullSummary): string {
  return `${pull.base.ref} ← ${pull.head.ref}`
}

const GITHUB_META = metaRow('github', GITHUB_PULL, GITHUB_FIXTURE.checks)
const LOCAL_META = metaRow('local', LOCAL_PULL, LOCAL_SNAPSHOT.mutable.checks)

describe('which branches the meta row names', () => {
  test('a pull request names them here, because its own name is a number', () => {
    expect(visibleText(GITHUB_META)).toContain(pairText(GITHUB_PULL))
  })

  test('a branch pair does not, because the row above already is the pair', () => {
    // The positive control, first and in this same body on purpose: without it
    // the absence below is equally satisfied by a header that names the
    // branches NOWHERE, which is a worse defect than naming them twice — a
    // review whose only name is its branch pair would then have no name at all.
    expect(visibleText(LOCAL_ROW)).toContain(pairText(LOCAL_PULL))
    expect(visibleText(LOCAL_META)).not.toContain(pairText(LOCAL_PULL))
  })

  test('and everything else in the row survives the omission', () => {
    // The pair is the only thing dropped. Who wrote a review and how big its
    // diff is are facts about a branch pair exactly as much as about a pull
    // request, and a sweep that took the whole row would lose them silently.
    expect(visibleText(LOCAL_META)).toContain(identityName(authorOf(LOCAL_PULL)))
    expect(visibleText(LOCAL_META)).toContain(`${LOCAL_PULL.changed_files} files`)
  })
})

// ————————————————————————————————————————————————————————————————
// The header as a whole
// ————————————————————————————————————————————————————————————————

/**
 * Every part of the review header that is handed the review itself,
 * concatenated in the order the header draws them.
 *
 * The seal is the one part left out, and it is left out because it is handed a
 * snapshot and a staleness report and never sees a ref — so it has no branch
 * pair it could draw. Everything in the header that does see the refs is here,
 * which is what makes a count over this string a claim about the header rather
 * than about two components that happen to agree.
 */
function header(mode: 'github' | 'local', pull: PullDetail, checks: CheckRun[]): string {
  return (
    identityRow(mode, pull) +
    metaRow(mode, pull, checks) +
    renderStatic(createElement(PrTabs, { mode, changedFiles: 12, unresolved: 3 }))
  )
}

/**
 * How many times a reader is shown the branch pair.
 *
 * Counted rather than merely looked for, because presence and absence each
 * answer only half of it: an absence is satisfied by a header that draws the
 * pair nowhere, and a presence by one that draws it three times. A header
 * carrying no pair at all counts 0 here and fails just as loudly as one
 * carrying two.
 */
function pairCount(markup: string, pull: PullSummary): number {
  return visibleText(markup).split(pairText(pull)).length - 1
}

const GITHUB_HEADER = header('github', GITHUB_PULL, GITHUB_FIXTURE.checks)
const LOCAL_HEADER = header('local', LOCAL_PULL, LOCAL_SNAPSHOT.mutable.checks)

describe('how often the whole header names the branch pair', () => {
  test('a pull request: once, in the meta row', () => {
    // Also the control for the counter itself: it does find the pair in a
    // header that draws it, and finds it exactly once there.
    expect(pairCount(GITHUB_HEADER, GITHUB_PULL)).toBe(1)
  })

  test('a branch pair: once, in the identity row', () => {
    expect(pairCount(LOCAL_HEADER, LOCAL_PULL)).toBe(1)
  })
})

/**
 * Every name the markup offers a reader who is not looking at it, in the order
 * it offers them.
 *
 * BOTH naming attributes, and the second one is the point. A `title` is a name
 * channel as well as a hover: an element carrying no other accessible name is
 * announced by its title, and every sighted reader gets it by resting a pointer
 * on the element. It is also invisible to the text extraction above, which
 * strips whole tags and takes every attribute with them — so a branch pair that
 * reached a screen through a title would be seen by nothing in this file.
 *
 * That channel is not hypothetical here. The one identity claim this header had
 * to lose was carried by a title attribute, and it is precisely why it went
 * unnoticed through several readings of these screens.
 */
function accessibleNames(markup: string): string[] {
  return [...markup.matchAll(/\s(?:aria-label|title)="([^"]*)"/g)].map((m) => m[1])
}

/** The accessible names that name both of a review's branches. */
function labelsNamingBothBranches(markup: string, pull: PullSummary): string[] {
  return accessibleNames(markup).filter(
    (label) => label.includes(pull.base.ref) && label.includes(pull.head.ref),
  )
}

describe('what the header says to a reader who cannot see the arrow', () => {
  test('the read does find the names a header carries', () => {
    // The control for the two lists below: both are exact values and both would
    // be satisfied by an extraction that found no names at all — one because
    // the sentence it expects would then be missing, which fails loudly, and
    // the other because an empty list is precisely what it expects. This says
    // the reader can see names in the header it is reading, so the pull
    // request's empty list is an absence of qualifying names rather than an
    // absence of names.
    expect(accessibleNames(GITHUB_HEADER).length).toBeGreaterThan(0)
  })

  test('a branch pair is spoken once, as a sentence', () => {
    // An element with an accessible name is announced by that name instead of
    // by its contents, so the local pair's spoken form is this sentence and not
    // the arrow between two refs. Asserted as the whole list of qualifying
    // names rather than as a search: a second row growing a label — or a
    // title — of its own would report as an extra member here instead of hiding
    // behind a match.
    expect(labelsNamingBothBranches(LOCAL_HEADER, LOCAL_PULL)).toEqual([
      `Local review of ${LOCAL_PULL.head.ref} against ${LOCAL_PULL.base.ref}`,
    ])
  })

  test('a pull request offers no such sentence, because its pair is plain text', () => {
    // The meta row draws the pair as ordinary text with no name of its own, so
    // it is read out as written and needs no substitute. The identity slot
    // there is a number, which also reads as written.
    expect(labelsNamingBothBranches(GITHUB_HEADER, GITHUB_PULL)).toEqual([])
  })
})

// ————————————————————————————————————————————————————————————————
// The banner beneath the header
// ————————————————————————————————————————————————————————————————

describe('who the thread-queue banner is for', () => {
  test('a pull request shows it to the human who drove the identity that opened it', () => {
    // Pinned with an empty queue on purpose: this path shows the banner to its
    // author whether or not anything is waiting, and that is the rule the
    // local answer below must not leak into.
    expect(
      authorBannerVisible({
        mode: 'github',
        authorHumanId: 'h-1',
        humanId: 'h-1',
        state: 'open',
        unresolved: 0,
      }),
    ).toBe(true)
  })

  test('and to nobody else, however much is waiting', () => {
    expect(
      authorBannerVisible({
        mode: 'github',
        authorHumanId: 'h-2',
        humanId: 'h-1',
        state: 'open',
        unresolved: 3,
      }),
    ).toBe(false)
  })

  test('and not once the pull request is closed', () => {
    expect(
      authorBannerVisible({
        mode: 'github',
        authorHumanId: 'h-1',
        humanId: 'h-1',
        state: 'closed',
        unresolved: 3,
      }),
    ).toBe(false)
  })

  test('a branch pair shows it whenever threads are waiting, whoever is reading', () => {
    // Nobody drove a shared identity to open anything here, so there is no
    // authorship to match against — the banner is warranted by the trip it
    // offers, which is the only entry to the thread queue in the header.
    expect(
      authorBannerVisible({
        mode: 'local',
        authorHumanId: null,
        humanId: 'h-1',
        state: 'open',
        unresolved: 2,
      }),
    ).toBe(true)
  })

  test('and withholds it when the queue is empty and there is no trip to offer', () => {
    expect(
      authorBannerVisible({
        mode: 'local',
        authorHumanId: null,
        humanId: 'h-1',
        state: 'open',
        unresolved: 0,
      }),
    ).toBe(false)
  })

  test('and never on a review that has stopped taking comments', () => {
    expect(
      authorBannerVisible({
        mode: 'local',
        authorHumanId: null,
        humanId: 'h-1',
        state: 'closed',
        unresolved: 2,
      }),
    ).toBe(false)
  })
})

// ————————————————————————————————————————————————————————————————
// The snapshot seal
// ————————————————————————————————————————————————————————————————

/**
 * The seal reports that time moved underneath a stored snapshot, in four
 * readings: nothing has been read yet, commits landed, the base advanced under
 * an unmoved head, or the head was rewritten in place.
 *
 * All four are drawn from what a repository did to a branch, and a branch pair
 * on this machine does every one of those things — so the wording is the same
 * for both kinds of review and is meant to stay that way. That makes it exactly
 * the vocabulary a well-meaning sweep for GitHub-sounding words would take out,
 * which is why it is rendered and read here on every run rather than compared
 * against an older copy of the tree once.
 */

/** The seeded snapshot for one review, whole, or a failure naming it. */
function seededSnapshot(n: number): Snapshot {
  const found = fixtureDB.seededSnapshots.find((s) => s.prNumber === n)
  if (found === undefined) throw new Error(`the fixture set holds no snapshot for ${n}`)
  return found
}

const SYNCED = seededSnapshot(347)

/**
 * One staleness report, filled out around whichever of its two fields the
 * branch under test turns on.
 */
function stalenessOf(over: Partial<StalenessInfo>): StalenessInfo {
  return {
    stale: false,
    newCommits: 0,
    baseMoved: false,
    snapshotHeadSha: SYNCED.immutable.headSha,
    currentHeadSha: SYNCED.immutable.headSha,
    syncedAt: SYNCED.syncedAt,
    ...over,
  }
}

/**
 * The seal's markup with runs of whitespace flattened to single spaces.
 *
 * These sentences are written across several source lines, and a line break in
 * the source reaches the markup as one — so a sentence a reader sees as one
 * line arrives here broken, and an unflattened search for it fails on
 * formatting rather than on wording.
 */
function seal(
  mode: 'github' | 'local',
  snapshot: Snapshot | null,
  staleness: StalenessInfo | null,
): string {
  return renderStatic(
    createElement(SnapshotSeal, {
      mode,
      snapshot,
      loading: false,
      staleness,
      syncing: false,
      onSync: () => {},
    }),
  ).replace(/\s+/g, ' ')
}

const NEVER_SYNCED = stalenessOf({})
const COMMITS_LANDED = stalenessOf({ stale: true, newCommits: 3 })
const BASE_ADVANCED = stalenessOf({ stale: true, baseMoved: true })
const HEAD_REWRITTEN = stalenessOf({ stale: true })

describe('what the seal says about a snapshot time moved underneath', () => {
  test('a review whose content has never been read says so', () => {
    expect(seal('github', null, NEVER_SYNCED)).toContain('never synced')
  })

  test('commits that landed since the read are counted', () => {
    expect(seal('github', SYNCED, COMMITS_LANDED)).toContain('3 new commits since sync')
  })

  test('a base that advanced under an unmoved head is named as such', () => {
    expect(seal('github', SYNCED, BASE_ADVANCED)).toContain('base advanced — diff changed')
  })

  test('and a head rewritten in place is named as that', () => {
    // Stale with no commit delta and the base where it was: the only thing
    // left is the head being replaced rather than added to.
    expect(seal('github', SYNCED, HEAD_REWRITTEN)).toContain('head moved since sync')
  })
})

describe('and it says the same thing on either kind of review', () => {
  // Byte equality rather than a second search for the same words: it fails on
  // any divergence at all, including one introduced through a class, an
  // attribute or an element the wording assertions above would not see.
  //
  // The never-synced reading is left out on a stated ground rather than by
  // omission — its one difference is the sync's cost, which it says in a
  // tooltip body, and a tooltip body is rendered through a portal and reaches
  // no static markup. An equality there would be pinning that limit rather
  // than the vocabulary.
  test('commits landed', () => {
    expect(seal('local', SYNCED, COMMITS_LANDED)).toBe(seal('github', SYNCED, COMMITS_LANDED))
  })

  test('the base advanced', () => {
    expect(seal('local', SYNCED, BASE_ADVANCED)).toBe(seal('github', SYNCED, BASE_ADVANCED))
  })

  test('the head was rewritten', () => {
    expect(seal('local', SYNCED, HEAD_REWRITTEN)).toBe(seal('github', SYNCED, HEAD_REWRITTEN))
  })

  test('and both are told a review with nothing read yet has nothing read yet', () => {
    // The presence half for the reading the equality above leaves out.
    expect(seal('local', null, NEVER_SYNCED)).toContain('never synced')
  })
})

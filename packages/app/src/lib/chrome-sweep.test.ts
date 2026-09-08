/**
 * The chrome says nothing about GitHub on a review that has none — swept two
 * ways, because neither way alone would hold.
 *
 * ## The two passes, and why both are needed
 *
 * The FIRST pass reads chrome source as text and asserts the sentences this
 * module family owns are not also written inline somewhere. That is not a
 * duplicate of the second pass: a component that quietly stops calling the copy
 * module and pastes the old sentence back leaves every behavioural assertion in
 * the suite green, because those assertions call the module and the module is
 * still right. Only a read of the source that renders it can see the paste.
 *
 * The SECOND pass calls every copy function the module exports with the
 * branch-pair mode and sweeps the result for vocabulary that asserts a fact a
 * branch pair does not have. It covers the exports by NAME against the module's
 * own export list, so a copy function added later is swept without editing
 * anything here — a sweep whose coverage is a hand-written list is a sweep that
 * silently stops covering the newest thing in it.
 *
 * ## Why the source pass reads files rather than importing them
 *
 * The application shell transitively pulls a module whose top level reads
 * `document.documentElement`, which the headless test environment's `document`
 * stub does not have — so importing it from a test throws at import time,
 * before a single assertion runs. Reading source as text has no import graph
 * and cannot be broken by one. It is also the shape every other structural
 * assertion in this package already takes.
 *
 * The render assertions below DO import the two components they render. Both
 * are props-only and reach for nothing but their own props, which is exactly
 * why the identity treatment was extracted into them.
 *
 * ## What a source read can and cannot prove
 *
 * PRESENCE, not execution. Nothing here proves a gate runs or a toast fires.
 * What it turns red is the change no behavioural assertion can see: a sentence
 * pasted back inline, and a gate whose call site was tidied away as
 * dead-looking indirection. Both are invisible to a suite that only calls pure
 * functions, and one of them puts a false claim back on a screen.
 *
 * ## One absence per test body
 *
 * A runner stops a body at its first failure, so two absences in one body leave
 * the second never independently falsifiable. Every absence here is either its
 * own test or is expressed as an equality against an empty list of offenders,
 * which reports every offender at once rather than the first.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import type { CommentIdentity } from '@revu/shared'
import { IdentityAvatar } from '@/components/ui/avatar'
import * as modeCopy from './mode-copy'
import {
  authorBannerCopy,
  conversationEmptyCopy,
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
import { renderStatic } from './render-test'

/** The app's source root — this file sits one directory below it. */
const SRC = join(import.meta.dir, '..')

/**
 * One chrome file, named by the export that proves a read landed on it.
 *
 * The marker is the positive control the whole source pass rests on: every
 * assertion below holds an ABSENCE, and an absence is satisfied for free by a
 * read that returned an empty string, a renamed file, or the wrong file
 * entirely. Checking that each scanned file still exports what it is here for
 * turns "this file moved" into a loud failure rather than a quiet green over
 * nothing.
 */
interface ScannedFile {
  /** Path relative to the app's source root. */
  path: string
  /** A pattern the file must still match, proving the read found the right file. */
  marker: RegExp
}

const SCANNED: ScannedFile[] = [
  { path: 'components/app-shell.tsx', marker: /export function AppShell\(/ },
  { path: 'components/palette.tsx', marker: /export function CommandPalette\(/ },
  { path: 'pages/inbox.tsx', marker: /export function InboxPage\(/ },
  { path: 'pages/pr-layout.tsx', marker: /export function PrLayout\(/ },
  { path: 'pages/files.tsx', marker: /export function FilesPage\(/ },
  { path: 'pages/conversation.tsx', marker: /export function ConversationPage\(/ },
  { path: 'components/ui/avatar.tsx', marker: /export function IdentityAvatar\(/ },
  { path: 'components/threads/comment-view.tsx', marker: /export function CommentView\(/ },
  { path: 'components/files/use-flat-rows.ts', marker: /export function useFlatRows\(/ },
  { path: 'components/review/review-bar.tsx', marker: /export function ReviewBar\(/ },
  { path: 'components/review/reconcile-dialog.tsx', marker: /export function ReconcileDialog\(/ },
  { path: 'components/author/author-banner.tsx', marker: /export function AuthorBanner\(/ },
  { path: 'components/review/dirty-banner.tsx', marker: /export function DirtyWorktreeBanner\(/ },
  {
    path: 'components/review/superseded-banner.tsx',
    marker: /export function SupersededBanner\(/,
  },
  { path: 'components/review/head-moved-dialog.tsx', marker: /export function HeadMovedDialog\(/ },
]

/**
 * One scanned file's source, with runs of whitespace flattened to single
 * spaces so a sentence JSX split across three lines still matches as one.
 *
 * Read LAZILY and memoized. Reading at module scope instead would throw before
 * a single test ran the moment a scanned file moved, turning the one failure
 * this list exists to report into an unhandled error with no name attached.
 */
const SOURCES = new Map<string, string>()

function source(relative: string): string {
  const cached = SOURCES.get(relative)
  if (cached !== undefined) return cached
  const text = readFileSync(join(SRC, relative), 'utf8').replace(/\s+/g, ' ')
  SOURCES.set(relative, text)
  return text
}

describe('the sweep is looking at real files', () => {
  test('every scanned file is still where this list says it is', () => {
    // Checked before any of them is read, so a chrome file that was renamed or
    // moved fails here BY NAME instead of dropping out of the sweep and leaving
    // a green run over a shorter list than anyone believes. The path is carried
    // into the assertion rather than left to a bare boolean, because "expected
    // true, received false" would not say which file went missing.
    for (const { path } of SCANNED) {
      expect([path, existsSync(join(SRC, path))]).toEqual([path, true])
    }
  })

  test('and still exports the thing it is scanned for', () => {
    // The positive control the whole source pass rests on: every assertion
    // below holds an absence, and an absence is satisfied for free by a read
    // that landed on the wrong file or on an empty one.
    for (const { path, marker } of SCANNED) {
      expect([path, marker.test(source(path))]).toEqual([path, true])
    }
  })
})

/**
 * The one sentence in the scanned chrome that names an org member and
 * github.com and is CORRECT where it sits.
 *
 * It explains who can approve a pull request the single shared identity opened,
 * which is true, is the only useful thing to say there, and has no path to a
 * screen on a branch pair — the whole popover is unrendered when the lock is
 * off. It lives in a popover body, which renders through a portal and reaches
 * no static markup, so source is the only place it can be pinned at all.
 */
const LOCK_EXPLANATION =
  'Submit comments here — an org member (e.g. dkozlov) approves on github.com.'

/**
 * The one sentence subtracted from each file that has one, by path.
 *
 * Subtracted from the TEXT rather than expressed as a per-file exemption from a
 * pattern, and the difference is the whole point: exempting a file from a
 * pattern exempts every OTHER occurrence of it in that file as well, so a
 * second, wrong sentence naming the same thing lands in the file most likely to
 * regress into one and the sweep stays green over it. Removing the sentence
 * leaves every pattern live over everything else the file says.
 */
const EXEMPT_SENTENCE: Record<string, string> = {
  'components/review/review-bar.tsx': LOCK_EXPLANATION,
}

/**
 * One scanned file's text as the banned-literal pass reads it: its source with
 * its one exempt sentence taken out, ONCE.
 *
 * Once rather than globally, so a second verbatim paste of the sentence is
 * still an offender. A reword makes the removal a no-op, which the required pin
 * below reports by name rather than leaving as a silent widening.
 */
function scanned(relative: string): string {
  const sentence = EXEMPT_SENTENCE[relative]
  const text = source(relative)
  return sentence === undefined ? text : text.replace(sentence, ' ')
}

/**
 * How much of each file granted a subtraction the banned pass is not allowed to
 * read, by path.
 *
 * Derived from the map rather than from a path written out here, so a second
 * exemption is measured by the same bounds without editing anything — a check
 * over a hand-named file stops covering the newest exemption the moment one is
 * added, which is the shape of the hole it exists to close.
 */
function charactersExempted(): [string, number][] {
  return Object.keys(EXEMPT_SENTENCE).map((path) => [
    path,
    source(path).length - scanned(path).length,
  ])
}

/**
 * A sentence the copy module owns, which must therefore not also be written
 * inline in the chrome that renders it.
 *
 * Every pattern applies to every scanned file. What a file can be granted is
 * the removal of one exact sentence from the text this pass reads, which is
 * narrower than a per-pattern exemption by exactly the rest of the file.
 */
interface BannedLiteral {
  /** What the sweep looks for. */
  pattern: RegExp
}

const BANNED: BannedLiteral[] = [
  // The identity treatment that fires on a branch pair, because the author of a
  // local review resolves to a GitHub-shaped user whose login is not the shared
  // one. It is a hover title and a chip, not body text, which is why it
  // survived every earlier reading of these screens.
  { pattern: /org member/i },
  { pattern: /github\.com/i },
  // A claim that a write left in a single request, made where nothing was
  // written and no request happened.
  { pattern: /\bAPI call\b/i },
  // The shared read budget, quoted as a cost for work that spends none.
  //
  // Matched as phrases rather than as the bare word: source is not only copy,
  // and the flat-row builder groups a file's attachments into what its own
  // code calls a bucket. A word-level ban over source text cannot tell an
  // identifier from a sentence, and one that tries turns red on a rename that
  // changed no wording at all.
  { pattern: /on the shared bucket/i },
  { pattern: /requests per changed file/i },
  { pattern: /5,000\/hr/ },
  // The absent patch blamed on a service that was not asked.
  { pattern: /did not inline this diff/i },
  // The not-found screen's two sentences, which send a reader to check an app
  // installation that need not exist.
  { pattern: /isn't in this installation/i },
  { pattern: /GitHub App is installed on/i },
  // The draft's custodian, named where the draft is held beside the review.
  { pattern: /saved · broker/ },
  { pattern: /Drafts live on the broker/i },
  // The authorship claim on a branch nobody opened anything with.
  { pattern: /You authored this PR/i },
  // The rule that says what a review is built from, which is the one sentence
  // in the header that a reader with an editor open beside it depends on.
  { pattern: /covers committed content only/i },
  // The archived notice, whose wording is correct where it is drawn and would
  // be a second source of truth anywhere else. Fragments rather than whole
  // sentences, because both lines interpolate a pull request number and a
  // pattern built around one would stop matching the moment it changed.
  { pattern: /frozen at its last sync/i },
  { pattern: /archived · superseded by/i },
  // Three more sentences the module owns whose wording is CORRECT on a
  // mediated pull request. They are banned inline for the same reason the wrong
  // ones are: a second copy of a right sentence is a second source of truth,
  // and it is the one that will be left behind when the first is reworded.
  { pattern: /No discussion yet/i },
  { pattern: /Couldn't sync this pull request/i },
  { pattern: /nothing was lost/i },
]

describe('no sentence the copy module owns is also written inline', () => {
  for (const { pattern } of BANNED) {
    test(`nothing in the chrome still says ${String(pattern)}`, () => {
      // Every offender at once rather than the first: a list equality names all
      // of them, where a loop of assertions would stop at whichever file the
      // scan happened to reach first.
      const offenders = SCANNED.filter(({ path }) => pattern.test(scanned(path))).map(
        ({ path }) => path,
      )
      expect(offenders).toEqual([])
    })
  }
})

describe('the one exemption is anchored to the sentence it was granted for', () => {
  test('the verdict lock still explains who can approve a mediated pull request', () => {
    // A required literal, and the reason the subtraction above is narrow rather
    // than a hole: if this sentence is ever swept away or reworded, the removal
    // stops describing anything and must go with it.
    expect(source('components/review/review-bar.tsx')).toContain(LOCK_EXPLANATION)
  })

  test('and every subtraction really takes something out of its file', () => {
    // A reworded sentence makes the removal a silent no-op, and an exemption
    // that describes nothing is a hole nobody notices. The pin above reports
    // the reword by name; this reports the consequence, for every file granted
    // a subtraction rather than for the one that has one today.
    expect(charactersExempted().filter(([, removed]) => removed === 0)).toEqual([])
  })

  test('and stays one sentence wide rather than one file wide', () => {
    // The ceiling is a literal chosen independently of the sentences it bounds
    // rather than derived from their lengths. A bound computed from the thing
    // being measured moves with it, so widening a sentence to a paragraph — or
    // to the whole file — would satisfy a check written against its own new
    // size, which is a guard that asserts nothing. Every scanned file here is
    // tens of times longer than this bound.
    expect(charactersExempted().filter(([, removed]) => removed >= 120)).toEqual([])
  })

  test('and no sentence is granted one that no pattern would have caught', () => {
    // The positive control for the subtraction itself. Without it every
    // identity pattern above is satisfied by removing text that was never going
    // to match anything, which proves nothing about whether the removal is
    // doing any work — and quietly licenses removing whatever one likes.
    const pointless = Object.entries(EXEMPT_SENTENCE)
      .filter(([, sentence]) => !BANNED.some(({ pattern }) => pattern.test(sentence)))
      .map(([path]) => path)
    expect(pointless).toEqual([])
  })

  test('and the one granted here is caught by BOTH identity patterns', () => {
    // The file-wide exemption this subtraction replaced covered two patterns at
    // once, so both are named: an exemption that only ever needed to cover one
    // of them would be narrower still.
    expect(/org member/i.test(LOCK_EXPLANATION)).toBe(true)
    expect(/github\.com/i.test(LOCK_EXPLANATION)).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————
// The mirror of the ban: sentences that must still be there
// ————————————————————————————————————————————————————————————————

/**
 * A sentence that must still be in the source of the one file that draws it.
 *
 * These are the opposite risk to the banned ones. A review of two local
 * branches has a merge base, a head that can be rewritten, a base that can
 * advance underneath it and blobs addressed by their contents — so the
 * vocabulary describing all of that is exactly as true there as on a mediated
 * pull request, and is the strongest thing the two kinds of review share. It
 * also reads, to a fresh eye sweeping for GitHub-sounding words, like the next
 * thing to remove. Nothing else in the suite would notice if it went: every
 * one of these sentences lives in a tooltip body or a dialog body, which are
 * rendered through a portal and reach no static markup at all.
 *
 * Anchored to ONE path each rather than searched across the tree. A sentence
 * that survives somewhere else — in a comment, in a sibling component, in a
 * test's own fixture — is not the sentence a reader sees, and a scan that
 * accepts either cannot tell the two apart.
 *
 * Matched as a pattern rather than as plain text for the same reason: the
 * sync-stats sentence is also DESCRIBED, in nearly the same words, by the
 * docstring of the function that composes it, so a plain search for its
 * opening fragment is satisfied by the prose after the sentence itself is
 * gone. The pattern for that fragment requires the interpolated count that
 * follows it, which prose does not have and code cannot lose without losing
 * the sentence.
 */
interface RequiredSentence {
  /** Path relative to the app's source root — one file, not the tree. */
  path: string
  /** What the assertion is called, and therefore what its failure reports. */
  name: string
  /** What must still be in that file's source, whitespace flattened. */
  pattern: RegExp
}

const REQUIRED: RequiredSentence[] = [
  {
    path: 'pages/pr-layout.tsx',
    name: 'the seal still explains a diff that changed without the head moving',
    pattern:
      /The base branch moved, so the three-dot compare changed even though head/,
  },
  {
    path: 'pages/pr-layout.tsx',
    name: 'a finished sync still reports what it fetched',
    pattern: /blobs fetched, \$\{[^}]+\}/,
  },
  {
    path: 'pages/pr-layout.tsx',
    name: 'and what it reused instead of fetching',
    pattern: /reused \(content-addressed\)/,
  },
  {
    path: 'components/review/head-moved-dialog.tsx',
    name: 'a branch that moved mid-review can still be left where it was',
    pattern: /Keep reviewing on the old snapshot/,
  },
]

describe('the sentences both kinds of review share are still in the source', () => {
  test('and every one of them names a file this sweep already checks is there', () => {
    // What ties a required sentence to a file something else already vouches
    // for: every scanned path is checked to exist and to still export what it
    // is scanned for, so a required sentence naming a path outside that set
    // would be read from a file nobody had established is the right one.
    const unchecked = REQUIRED.map((r) => r.path).filter(
      (path) => !SCANNED.some((s) => s.path === path),
    )
    expect(unchecked).toEqual([])
  })

  for (const { path, name, pattern } of REQUIRED) {
    test(name, () => {
      // The path travels into the assertion so a failure says which file was
      // read as well as what was missing from it.
      expect([path, pattern.test(source(path))]).toEqual([path, true])
    })
  }
})

// ————————————————————————————————————————————————————————————————
// The wiring a pure function cannot prove: a gate whose call site went away
// ————————————————————————————————————————————————————————————————

/**
 * Whether a file imports `name` from `module` in an import STATEMENT.
 *
 * Anchored to the statement and to the module it names, so the name appearing
 * in a comment, in a string, or as a leftover local does not satisfy it — a
 * looser match stays green through the exact edit these pins exist to catch,
 * which is the import being removed while a stale call is left behind.
 */
function importsFrom(relative: string, module: string, name: string): boolean {
  const statement = new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'${module}'`,
  )
  return statement.test(source(relative))
}

describe('every swept surface asks the copy module for its sentence', () => {
  // PRESENCE, not execution. These do not prove a screen renders; what they
  // turn red is a surface that quietly stopped consulting the module. The
  // banned-literal pass above catches only the case where the OLD sentence came
  // back — a surface that invented a new wrong one would slip past it.
  test('the seal asks what one sync will cost', () => {
    expect(importsFrom('pages/pr-layout.tsx', '@/lib/mode-copy', 'syncCostCopy')).toBe(true)
  })

  test('the files tab asks for both of its sync sentences', () => {
    expect(importsFrom('pages/files.tsx', '@/lib/mode-copy', 'neverSyncedCopy')).toBe(true)
    expect(importsFrom('pages/files.tsx', '@/lib/mode-copy', 'syncErrorCopy')).toBe(true)
  })

  test('the avatar asks whether to name where a person reviews', () => {
    expect(importsFrom('components/ui/avatar.tsx', '@/lib/mode-copy', 'orgMemberTitle')).toBe(
      true,
    )
  })

  test('the comment header asks for the descriptor beside the name', () => {
    expect(
      importsFrom('components/threads/comment-view.tsx', '@/lib/mode-copy', 'orgMemberChip'),
    ).toBe(true)
  })

  test('the row builder asks what to say where a diff would have been', () => {
    expect(
      importsFrom('components/files/use-flat-rows.ts', '@/lib/mode-copy', 'tooLargeDiffCopy'),
    ).toBe(true)
  })

  test('the dirty-worktree banner asks for the sentence it draws', () => {
    expect(
      importsFrom('components/review/dirty-banner.tsx', '@/lib/mode-copy', 'dirtyWorktreeCopy'),
    ).toBe(true)
  })

  test('the archived banner asks for both of its lines', () => {
    expect(
      importsFrom(
        'components/review/superseded-banner.tsx',
        '@/lib/mode-copy',
        'supersededBannerCopy',
      ),
    ).toBe(true)
  })

  test('and the inbox row asks for the badge that names what took over', () => {
    expect(importsFrom('pages/inbox.tsx', '@/lib/mode-copy', 'supersededBadgeCopy')).toBe(true)
  })

  test('and the header asks for the tint of its state chip as well as its word', () => {
    // The tint is half of what the chip says and varies by the same question,
    // so a header that kept the word and reinvented the colour would put an
    // alarm back on every archived review with every sentence still right.
    expect(importsFrom('pages/pr-layout.tsx', '@/lib/mode-copy', 'stateChipVariant')).toBe(true)
  })
})

describe('the review layout draws the notice about what superseded a review', () => {
  test('the layout imports the banner by name', () => {
    // PRESENCE, not execution. The banner decides its own visibility and is
    // asserted on real markup beside itself; what nothing but a read of this
    // file can say is that the header still has a slot it is rendered into.
    expect(
      importsFrom(
        'pages/pr-layout.tsx',
        '@/components/review/superseded-banner',
        'ReviewSupersededBanner',
      ),
    ).toBe(true)
  })

  test('and renders it above the other banners in the stack', () => {
    // The order is the widest claim first: everything else the header says is
    // said about a review that can still be written to, and this one says it
    // cannot. Read as positions in the file rather than as a literal block, so
    // reformatting the slot does not turn it red.
    const text = source('pages/pr-layout.tsx')
    const superseded = text.indexOf('<ReviewSupersededBanner')
    const dirtyBanner = text.indexOf('<ReviewDirtyBanner')
    expect(superseded).toBeGreaterThan(-1)
    expect(dirtyBanner).toBeGreaterThan(superseded)
  })
})

/**
 * The attributes of every `<IdentityAvatar …>` element written in one file.
 *
 * Anchored to the element, so the read cannot be satisfied by the component's
 * name appearing in an import, a comment or a docstring.
 */
function avatarElements(relative: string): string[] {
  return [...scanned(relative).matchAll(/<IdentityAvatar\b([^>]*)>/g)].map((m) => m[1])
}

/**
 * The expression each of a file's avatars is handed for its mode, in source
 * order — or a sentence naming the omission, so a missing prop reports as
 * itself rather than as an empty list.
 */
function avatarModeExpressions(relative: string): string[] {
  return avatarElements(relative).map(
    (attributes) =>
      /\bmode=(\{[^}]*\}|"[^"]*")/.exec(attributes)?.[1] ?? 'this avatar is handed no mode',
  )
}

/**
 * What a file binds its own `mode` local to, or a sentence saying it binds
 * none. Read as the expression rather than as a whole-file search, so a failure
 * names what the binding became instead of reprinting the file.
 */
function modeBinding(relative: string): string {
  return /\bconst mode\b[^=]*= (\S+)/.exec(scanned(relative))?.[1] ?? 'this file binds no mode'
}

describe('the avatar is told which kind of review it is drawing inside', () => {
  // The treatment this decides — a ring and a title saying where a person
  // reviews — is drawn for every author whose login is not the shared write
  // identity's, which is EVERY author of a review of two local branches. The
  // component honours whatever mode it is handed, and its own render assertions
  // prove that; what they cannot see is a call site handing it the wrong one.
  //
  // A required prop turns a MISSING mode into a compile error and a WRONG one
  // into nothing at all, so the two surfaces where the treatment was reproduced
  // on a screen are pinned to the expression they derive it from. Each is read
  // out of its own file: a pattern satisfied by any file in the tree would stay
  // green through exactly the edit these exist to catch.
  test('the inbox row asks the review that row is for', () => {
    // An exact list rather than a search, so it is unsatisfiable in both
    // directions: a row that stopped drawing the avatar reports `[]`, and one
    // that hard-codes a kind reports the constant it hard-coded.
    expect(avatarModeExpressions('pages/inbox.tsx')).toEqual(['{reviewMode(pull.number)}'])
  })

  test('and the comment header asks the review the comment is on', () => {
    expect(avatarModeExpressions('components/threads/comment-view.tsx')).toEqual(['{mode}'])
  })

  test('and that binding is the review number, not a constant chosen once', () => {
    // The second link of the chain above. The comment card derives the mode one
    // line up because it also hands it to the descriptor beside the name, so
    // the call site names a binding — which is only as good as what the binding
    // is bound to.
    expect(modeBinding('components/threads/comment-view.tsx')).toBe('reviewMode(prNumber)')
  })
})

describe('the review header mounts the banners hung under it', () => {
  test('the header still mounts the dirty-worktree banner', () => {
    // The one regression in this sweep that adds no sentence and removes none:
    // a banner that is simply never mounted leaves every string assertion in
    // the suite green — the component renders correctly, in all four of its
    // states, on no screen at all. Its own suite asserts what it draws when
    // rendered; only a read of the header can say that anything renders it.
    //
    // Presence, not execution, and anchored to the import STATEMENT and the
    // module it names, so the name in a comment or a leftover local does not
    // satisfy it.
    expect(
      importsFrom('pages/pr-layout.tsx', '@/components/review/dirty-banner', 'ReviewDirtyBanner'),
    ).toBe(true)
  })
})

describe('the launcher names the open review rather than assuming one', () => {
  // Every entry the launcher draws lives inside a dialog, which renders through
  // a portal and reaches no static markup at all — so nothing about this
  // surface is assertable from a render, and the wording is pinned where it is
  // decided while the source says the surface still asks for it.
  test('the group over the open review asks what to call it', () => {
    // PRESENCE, not execution. Anchored to the import STATEMENT and the module
    // it names, so a mention in a comment or a leftover local does not satisfy
    // it — the group's own heading is one chord from every screen, and a
    // heading pasted back inline leaves every pin on the wording green.
    expect(importsFrom('components/palette.tsx', '@/lib/mode-copy', 'paletteReviewHeading')).toBe(
      true,
    )
  })

  test('and the search line offers to reach a review, not a pull request', () => {
    // Deliberately NOT a mode-varying sentence, so it is pinned here rather
    // than in the copy module: the launcher opens with no review at all and its
    // jump list holds both kinds at once, so there is no mode to branch on and
    // inventing one would state a fact this surface does not have. What it must
    // stay is true of everything the list can reach.
    expect(scanned('components/palette.tsx')).toContain(
      'placeholder="Jump to a review or run a command…"',
    )
  })
})

describe('the topbar consults the rate-chip gate', () => {
  test('the shell imports the gate by name', () => {
    // The rate chip is the one surface in this sweep whose regression adds NO
    // banned sentence: dropping the gate is a render change, not a string
    // change, so every pattern above stays green while a workspace with no
    // shared budget goes back to shimmering an empty chip in its topbar
    // forever. Presence, not execution — but a tidy-up that removes the call
    // site is caught here instead of by eye.
    //
    // Anchored to the import STATEMENT and to the module it names, so the name
    // appearing in a comment, a string or a leftover local does not satisfy it.
    expect(importsFrom('components/app-shell.tsx', '@/lib/review-mode', 'showRateChip')).toBe(
      true,
    )
  })
})

// ————————————————————————————————————————————————————————————————
// Pass two: every copy function, called with the branch-pair mode
// ————————————————————————————————————————————————————————————————

/** One copy function's whole output for a branch pair, as a single string. */
interface SweptCopy {
  /** The exported name, matched against the module's own export list. */
  name: string
  /** Every line the function returns, joined — including lines added later. */
  text: string
}

/** Everything a copy function can return, flattened to text. */
function flatten(value: string | null | object): string {
  if (value === null) return ''
  if (typeof value === 'string') return value
  // Read through `Object.values` rather than field by field, so a line added to
  // one of these records later is swept without editing anything here.
  return Object.values(value)
    .filter((line): line is string => typeof line === 'string')
    .join(' ')
}

/**
 * Every export of the copy module, called for a branch pair.
 *
 * Arguments are chosen to reach the wordiest branch of each function: a plural
 * count, a non-zero tally, a key from the reserved band. Records are flattened
 * with `Object.values` rather than field by field, so a line a later change
 * adds to one of them is swept by every pattern below without touching this
 * list.
 */
const SWEPT: SweptCopy[] = [
  { name: 'conversationEmptyCopy', text: flatten(conversationEmptyCopy('local')) },
  { name: 'notFoundCopy', text: flatten(notFoundCopy('local', 1_000_000_001)) },
  { name: 'stateChipCopy', text: flatten(stateChipCopy('local', 'open')) },
  { name: 'authorBannerCopy', text: flatten(authorBannerCopy('local', 3)) },
  { name: 'submitSuccessCopy', text: flatten(submitSuccessCopy('local', 3)) },
  { name: 'reconcileSuccessCopy', text: flatten(reconcileSuccessCopy('local', 5, 2)) },
  { name: 'submitFailureCopy', text: flatten(submitFailureCopy('local')) },
  { name: 'reconcileFailureCopy', text: flatten(reconcileFailureCopy('local')) },
  { name: 'draftSavedCopy', text: flatten(draftSavedCopy('local')) },
  { name: 'syncCostCopy', text: flatten(syncCostCopy('local')) },
  { name: 'neverSyncedCopy', text: flatten(neverSyncedCopy('local', 25)) },
  { name: 'syncErrorCopy', text: flatten(syncErrorCopy('local')) },
  { name: 'tooLargeDiffCopy', text: flatten(tooLargeDiffCopy('local')) },
  { name: 'orgMemberChip', text: flatten(orgMemberChip('local')) },
  { name: 'orgMemberTitle', text: flatten(orgMemberTitle('local')) },
  { name: 'dirtyWorktreeCopy', text: flatten(dirtyWorktreeCopy('local')) },
  { name: 'paletteReviewHeading', text: flatten(paletteReviewHeading('local')) },
  { name: 'stateChipVariant', text: flatten(stateChipVariant('local', 'closed')) },
  { name: 'supersededBadgeCopy', text: flatten(supersededBadgeCopy('local', 101)) },
  { name: 'supersededBannerCopy', text: flatten(supersededBannerCopy('local', 101)) },
]

describe('the copy sweep covers the module it is sweeping', () => {
  test('every exported copy function is called above', () => {
    // The guard that stops this sweep decaying into a list of whatever was true
    // the day it was written: a copy function added later and never added here
    // would be swept by nothing, and every pattern below would stay green over
    // a sentence nobody checked.
    const exported = Object.entries(modeCopy as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    const swept = new Set(SWEPT.map((c) => c.name))
    expect(exported.filter((name) => !swept.has(name))).toEqual([])
  })

  test('and the module really does export functions to sweep', () => {
    // The positive half of the control above: an empty export list would
    // satisfy it for free, and would satisfy every absence below as well.
    expect(SWEPT.length).toBeGreaterThan(10)
    expect(SWEPT.every((c) => c.name !== '')).toBe(true)
  })

  test('and nothing the module exports escapes that guard by not being one', () => {
    // The hole in the guard above rather than in the list it checks. It reads
    // the module's exports and KEEPS ONLY THE FUNCTIONS, so a sentence exported
    // as a bare constant is dropped by the filter instead of reported by it —
    // swept by nothing here, pinned by nothing anywhere, and free to say
    // whatever it likes on whichever screen renders it. Every sentence in this
    // module is a function of the kind of review asking, and a constant is a
    // sentence that has stopped being one.
    const notFunctions = Object.entries(modeCopy as Record<string, unknown>)
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
    expect(notFunctions).toEqual([])
  })
})

/**
 * The one pattern a copy function can be granted, and the family granted it.
 *
 * A branch pair has no pull request behind it — except in exactly one state.
 * When a pull request appears covering the same two branches the review is
 * archived against it, and from then on naming that pull request is not a
 * false claim but the whole content of the notice: the review is read-only
 * BECAUSE the pull request exists, and a reader told only "archived" cannot
 * reach the work that took over. So this family is granted the phrase and
 * nothing else, and every other pattern below still sweeps it.
 *
 * The same RegExp OBJECT is what the list holds, so the grant is anchored to
 * the entry actually being swept rather than to a re-spelling of it that could
 * drift away from it silently.
 */
const NAMES_A_PULL_REQUEST = /pull request/i

/**
 * The copy functions granted that phrase, by name.
 *
 * A name-level grant rather than a subtraction of one sentence, because these
 * functions interpolate a number: there is no fixed string to take out, and a
 * pattern built from one would stop matching the moment the number changed.
 * The controls below are what keep it narrow — every name here must be a real
 * swept function whose branch-pair copy really does name a pull request, so a
 * grant that has stopped doing anything fails instead of quietly widening the
 * sweep by one function.
 */
const NAMES_A_PULL_REQUEST_GRANTED = new Set(['supersededBannerCopy'])

/** Vocabulary that asserts something a review of two local branches lacks. */
const BANNED_VOCABULARY: RegExp[] = [
  /github\.com/i,
  /API call/i,
  /installation/i,
  /rate limit/i,
  /\bbucket\b/i,
  /org member/i,
  NAMES_A_PULL_REQUEST,
  /\bbroker\b/i,
  /\brequests\b/i,
]

/** Which functions this pattern is not swept over — none, for all but one. */
function granted(pattern: RegExp): ReadonlySet<string> {
  return pattern === NAMES_A_PULL_REQUEST ? NAMES_A_PULL_REQUEST_GRANTED : new Set<string>()
}

describe('no copy function says anything about GitHub for a branch pair', () => {
  for (const pattern of BANNED_VOCABULARY) {
    test(`no branch-pair copy matches ${String(pattern)}`, () => {
      const exempt = granted(pattern)
      const offenders = SWEPT.filter(
        (c) => !exempt.has(c.name) && pattern.test(c.text),
      ).map((c) => c.name)
      expect(offenders).toEqual([])
    })
  }
})

describe('the one grant is anchored to copy that needs it', () => {
  test('every granted name is a function this sweep actually calls', () => {
    // A grant spelled wrong exempts nothing and is invisible: the sweep stays
    // green because the name it names is not in the list either way, and the
    // function it was meant to cover is swept by everything. Reported by name
    // rather than as a count.
    const swept = new Set(SWEPT.map((c) => c.name))
    expect([...NAMES_A_PULL_REQUEST_GRANTED].filter((name) => !swept.has(name))).toEqual([])
  })

  test('and really does name a pull request, or the grant is a hole', () => {
    // The positive control for the exemption itself. Without it the grant is
    // satisfied by copy that never needed it — which proves nothing about
    // whether the exemption is doing any work, and quietly licenses adding
    // whatever names one likes to it.
    const idle = SWEPT.filter(
      (c) => NAMES_A_PULL_REQUEST_GRANTED.has(c.name) && !NAMES_A_PULL_REQUEST.test(c.text),
    ).map((c) => c.name)
    expect(idle).toEqual([])
  })

  test('and every other pattern still sweeps the granted copy', () => {
    // The grant is one phrase wide, not one function wide. Asserted directly
    // rather than left to the loop above: an exemption keyed on the function
    // instead of on the pattern would satisfy every test in that loop while
    // letting the archived notice say anything at all.
    const granted = SWEPT.filter((c) => NAMES_A_PULL_REQUEST_GRANTED.has(c.name))
    expect(granted.length).toBeGreaterThan(0)
    for (const pattern of BANNED_VOCABULARY) {
      if (pattern === NAMES_A_PULL_REQUEST) continue
      expect([String(pattern), granted.filter((c) => pattern.test(c.text))]).toEqual([
        String(pattern),
        [],
      ])
    }
  })

  test('and no other branch-pair copy borrows the phrase', () => {
    // The rule this whole file exists for, restated over the one exemption:
    // the archived notice is the ONE local surface that legitimately names a
    // pull request, and the grant is a list of one rather than a category
    // anything can join by having the phrase in it.
    expect([...NAMES_A_PULL_REQUEST_GRANTED]).toEqual(['supersededBannerCopy'])
  })
})

// ————————————————————————————————————————————————————————————————
// The identity treatment, asserted on real markup
// ————————————————————————————————————————————————————————————————

/**
 * An author the app resolved to a GitHub-shaped account.
 *
 * This is what the author of a local review parses as: the identity parser
 * classifies any user whose login is not the shared write identity's as a
 * GitHub account, and the synthesized local author's login is not that one. So
 * the branch-pair case below is not a hypothetical — it is the ordinary state
 * of every local review's author row and every comment on it.
 */
const GITHUB_USER: CommentIdentity = {
  kind: 'github',
  user: {
    login: 'octo-dev',
    id: 4242,
    node_id: 'U_octo-dev',
    avatar_url: '',
    html_url: '',
    type: 'User',
  },
}

/** The avatar's markup for one mode, rendered exactly as a browser receives it. */
function avatarMarkup(mode: 'github' | 'local'): string {
  return renderStatic(createElement(IdentityAvatar, { identity: GITHUB_USER, mode }))
}

describe('the author of a branch pair is drawn as a person, not an org member', () => {
  test('a pull request still carries the treatment', () => {
    // The positive control, and without it the two absences below prove
    // nothing: they would pass just as well against an avatar that drew no
    // title for anybody, which is a different bug wearing the same green.
    expect(avatarMarkup('github')).toContain('title="org member · reviews on github.com"')
  })

  test('and it is still a ring around that person', () => {
    // The title and the ring are one treatment and are dropped together. This
    // pins the half a title search cannot see, so a branch pair cannot end up
    // ringed but untitled.
    expect(avatarMarkup('github')).toContain('ring-1')
  })

  test('a branch pair carries no such title', () => {
    // A hover title, not body text: a sweep over rendered TEXT misses it
    // completely, which is why this reads the attribute out of real markup.
    expect(avatarMarkup('local')).not.toContain('org member')
  })

  test('and no ring either', () => {
    expect(avatarMarkup('local')).not.toContain('ring-1')
  })

  test('while still drawing the person it is the avatar of', () => {
    // The absences above are also satisfied by an avatar that renders nothing.
    // This is what says the author is still on the screen.
    expect(avatarMarkup('local')).toContain('octo-dev')
  })

  test('and the chip beside the name goes with it', () => {
    // The chip is drawn by a component that needs a query client, a session and
    // a loaded snapshot before it renders anything, so its wording is pinned
    // where it is decided. The source pass above is what proves the component
    // still asks for it rather than writing its own.
    expect(orgMemberChip('github')).toBe('org member · github.com')
    expect(orgMemberChip('local')).toBeNull()
  })
})

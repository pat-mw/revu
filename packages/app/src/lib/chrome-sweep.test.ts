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
  draftSavedCopy,
  neverSyncedCopy,
  notFoundCopy,
  orgMemberChip,
  orgMemberTitle,
  reconcileFailureCopy,
  reconcileSuccessCopy,
  stateChipCopy,
  submitFailureCopy,
  submitSuccessCopy,
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
  { path: 'pages/pr-layout.tsx', marker: /export function PrLayout\(/ },
  { path: 'pages/files.tsx', marker: /export function FilesPage\(/ },
  { path: 'pages/conversation.tsx', marker: /export function ConversationPage\(/ },
  { path: 'components/ui/avatar.tsx', marker: /export function IdentityAvatar\(/ },
  { path: 'components/threads/comment-view.tsx', marker: /export function CommentView\(/ },
  { path: 'components/files/use-flat-rows.ts', marker: /export function useFlatRows\(/ },
  { path: 'components/review/review-bar.tsx', marker: /export function ReviewBar\(/ },
  { path: 'components/review/reconcile-dialog.tsx', marker: /export function ReconcileDialog\(/ },
  { path: 'components/author/author-banner.tsx', marker: /export function AuthorBanner\(/ },
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
 * A sentence the copy module owns, which must therefore not also be written
 * inline in the chrome that renders it.
 *
 * `exempt` names the files where a match is CORRECT rather than a regression,
 * and every entry states why. An exemption is per file and per pattern — never
 * a file dropped from the scan, which would take every other pattern's coverage
 * of that file with it.
 */
interface BannedLiteral {
  /** What the sweep looks for. */
  pattern: RegExp
  /** Scanned paths where this pattern is correct copy. */
  exempt?: string[]
}

const BANNED: BannedLiteral[] = [
  // The identity treatment that fires on a branch pair, because the author of a
  // local review resolves to a GitHub-shaped user whose login is not the shared
  // one. It is a hover title and a chip, not body text, which is why it
  // survived every earlier reading of these screens.
  //
  // The verdict picker's lock is exempt from both identity patterns: its
  // explanation names the person who CAN approve a pull request the shared
  // identity opened, which is true, is the only useful thing to say there, and
  // has no path to a screen on a branch pair because the whole popover is
  // unrendered when the lock is off. The exemption is anchored by the pin
  // below, so it covers that one sentence rather than the whole file.
  { pattern: /org member/i, exempt: ['components/review/review-bar.tsx'] },
  { pattern: /github\.com/i, exempt: ['components/review/review-bar.tsx'] },
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
  // Three more sentences the module owns whose wording is CORRECT on a
  // mediated pull request. They are banned inline for the same reason the wrong
  // ones are: a second copy of a right sentence is a second source of truth,
  // and it is the one that will be left behind when the first is reworded.
  { pattern: /No discussion yet/i },
  { pattern: /Couldn't sync this pull request/i },
  { pattern: /nothing was lost/i },
]

describe('no sentence the copy module owns is also written inline', () => {
  for (const { pattern, exempt = [] } of BANNED) {
    test(`nothing in the chrome still says ${String(pattern)}`, () => {
      // Every offender at once rather than the first: a list equality names all
      // of them, where a loop of assertions would stop at whichever file the
      // scan happened to reach first.
      const offenders = SCANNED.filter(
        ({ path }) => !exempt.includes(path) && pattern.test(source(path)),
      ).map(({ path }) => path)
      expect(offenders).toEqual([])
    })
  }
})

describe('the one exemption is anchored to the sentence it was granted for', () => {
  test('the verdict lock still explains who can approve a mediated pull request', () => {
    // A required literal, and the reason the exemption above is narrow rather
    // than a hole: if this sentence is ever swept away, the exemption stops
    // describing anything and must go with it. It lives in a popover body,
    // which renders through a portal and reaches no static markup, so source is
    // the only place it can be pinned at all.
    expect(source('components/review/review-bar.tsx')).toContain(
      "Submit comments here — an org member (e.g. dkozlov) approves on github.com.",
    )
  })
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
})

/** Vocabulary that asserts something a review of two local branches lacks. */
const BANNED_VOCABULARY: RegExp[] = [
  /github\.com/i,
  /API call/i,
  /installation/i,
  /rate limit/i,
  /\bbucket\b/i,
  /org member/i,
  /pull request/i,
  /\bbroker\b/i,
  /\brequests\b/i,
]

describe('no copy function says anything about GitHub for a branch pair', () => {
  for (const pattern of BANNED_VOCABULARY) {
    test(`no branch-pair copy matches ${String(pattern)}`, () => {
      const offenders = SWEPT.filter((c) => pattern.test(c.text)).map((c) => c.name)
      expect(offenders).toEqual([])
    })
  }
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

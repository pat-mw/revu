/**
 * The line the reconcile dialog puts under its title, and the rewrite test it
 * branches on.
 *
 * ## Why the ordinary phrasing is pinned byte for byte
 *
 * This module was extracted from an expression that already rendered on screen,
 * and the failure mode of an extraction is not a crash — it is a sentence that
 * comes back subtly different: a lost separator, a dropped space around the
 * arrow, a singular branch quietly collapsed into the plural. None of that
 * throws, and none of it is visible to an assertion that only checks the count
 * appears somewhere in the result. So the unchanged case is asserted as a whole
 * string equality against a literal written out by hand here, not against a
 * template rebuilt from the same pieces the implementation uses — an expectation
 * derived from the code it checks moves whenever the code does and asserts
 * nothing.
 *
 * The singular row gets its own assertion for the same reason. `n === 1` is one
 * character of an inline ternary and the branch a hurried extraction drops
 * silently, because every other test in the file runs the plural.
 *
 * ## Why "not loaded" and "empty" are separate tests
 *
 * They are the same absence to a careless reader and opposite answers here. An
 * empty compare genuinely does not contain the draft's head, so the rewrite
 * test says so. A compare that has not arrived yet says nothing at all, and
 * treating it as a missing head would put "the branch was rewritten" on screen
 * for the duration of every fetch. Both are asserted, and both are asserted
 * against the exact sentence produced rather than against the absence of the
 * other one.
 *
 * ## Why this file reads the dialog's source
 *
 * This package has no DOM runner, so "the dialog renders this line" is not a
 * runnable assertion here. What IS checkable is that the dialog calls this
 * module and no longer carries its own copy of the expression — the one
 * regression the assertions above cannot see, because a component that quietly
 * kept its inline version leaves every pure-function test in this file green
 * while the screen never changes.
 *
 * That negative check is only safe because the positive one exists: the
 * ordinary string is pinned above as something this module still PRODUCES, so
 * the guard cannot be satisfied by the copy disappearing from the app
 * altogether. Deleting the line to make the scan pass turns the equality red.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { CommitInfo } from '@revu/shared'
import { compareChangeLine, isRewritten } from './reconcile-copy'

/** A compare entry — only the SHA is read here, the rest is shape. */
function commit(sha: string): CommitInfo {
  return {
    sha,
    commit: {
      message: `work at ${sha}`,
      author: { name: 'A', email: 'a@example.com', date: '2026-01-01T00:00:00Z' },
    },
    author: null,
    parents: [],
  }
}

const DRAFT_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const CURRENT_HEAD = 'f6e5d4c3b2a10918273645546372819000abcdef'

/** The compare a fast-forward leaves: the draft's head, then what landed on it. */
const FAST_FORWARD = [commit(DRAFT_HEAD), commit('11'), commit('22'), commit('33')]

/** The compare a rebase leaves: the draft's head is nowhere in it. */
const REWRITTEN = [commit('aa'), commit('bb'), commit('cc')]

describe('whether the branch was rewritten', () => {
  test('a compare that still contains the draft head was not', () => {
    // The negative leg, and the one a test over the report's `newCommits` would
    // get wrong: that list is the slice AFTER the draft head, so the head is
    // absent from it here too, and a membership test over it would call this
    // ordinary fast-forward a rewrite.
    expect(isRewritten(FAST_FORWARD, DRAFT_HEAD)).toBe(false)
  })

  test('and a compare the draft head has vanished from was', () => {
    // The positive leg. Without it, a function that answered `false` to
    // everything would satisfy the case above on its own.
    expect(isRewritten(REWRITTEN, DRAFT_HEAD)).toBe(true)
  })

  test('and an empty compare answers — it does not throw', () => {
    // An empty list is a real state, not a malformed one: it is what a compare
    // holds when head sits on the merge base. The draft head is not in it, so
    // the honest answer is the same one any other absence gets. Asserted
    // explicitly because "handles the empty list" is the claim most easily made
    // by a function that in fact reads element zero.
    expect(isRewritten([], DRAFT_HEAD)).toBe(true)
  })
})

describe('the line under the dialog title', () => {
  test('a rewritten branch is described as rewritten, not as new work', () => {
    // The whole reason this module exists. Three rewritten commits are three
    // SHAs the draft never saw, not three pieces of work that landed on top of
    // it, and the count alone cannot tell the human which of those happened.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: REWRITTEN,
        newCommits: REWRITTEN,
      }),
    ).toBe('a1b2c3d → f6e5d4c · the branch was rewritten — 3 commits, all new SHAs')
  })

  test('and a rewrite of exactly one commit reads as one commit', () => {
    // An amend. Both halves of the phrasing inflect — the noun and the claim
    // about the SHAs — so a plural left hard-coded in either place shows up
    // here and nowhere else.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: [commit('aa')],
        newCommits: [commit('aa')],
      }),
    ).toBe('a1b2c3d → f6e5d4c · the branch was rewritten — 1 commit, a new SHA')
  })

  test('an ordinary fast-forward still reads exactly as it always has', () => {
    // Byte for byte against a literal written out here. This is the sentence
    // that was already on screen before it had a module, and an extraction that
    // changes it by one space has changed the product without anyone deciding
    // to.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: FAST_FORWARD,
        newCommits: FAST_FORWARD.slice(1),
      }),
    ).toBe('a1b2c3d → f6e5d4c · 3 new commits')
  })

  test('and a single new commit is singular', () => {
    // The branch an inline ternary loses without a sound. Every other case in
    // this file exercises the plural, so this is the only assertion standing
    // between "commit" and "1 new commits" on screen.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: [commit(DRAFT_HEAD), commit('11')],
        newCommits: [commit('11')],
      }),
    ).toBe('a1b2c3d → f6e5d4c · 1 new commit')
  })

  test('a compare that has not loaded yet is never called a rewrite', () => {
    // The degradation that matters. The dialog reads its compare off a query
    // result that is absent while it settles, and the draft head is trivially
    // "not in" a list that does not exist. Accusing the branch of a rewrite for
    // the length of every fetch would make the alarming phrasing the ordinary
    // one. Pinned as the exact fast-forward sentence rather than as the absence
    // of the word "rewritten", so a fallback reduced to an empty string or to a
    // bare count fails here too.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: null,
        newCommits: [commit('11'), commit('22'), commit('33')],
      }),
    ).toBe('a1b2c3d → f6e5d4c · 3 new commits')
  })

  test('and neither is one that is merely undefined', () => {
    // The same absence in the shape the call site actually produces: the
    // dialog passes `snapshot?.immutable.commits`, which is undefined rather
    // than null while the snapshot is unread. A guard written against null
    // alone would pass the test above and fail on every real load.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: undefined,
        newCommits: [commit('11'), commit('22'), commit('33')],
      }),
    ).toBe('a1b2c3d → f6e5d4c · 3 new commits')
  })

  test('and an empty compare reports no new commits rather than a rewrite', () => {
    // The state a base that advanced under an unchanged head reaches: the
    // compare is empty, the draft head is therefore not in it, and yet nothing
    // was rewritten because there is nothing there to rewrite. The rewrite test
    // answers `true` for this list — asserted directly above — so this pins
    // that the SENTENCE does not follow it off the cliff.
    expect(
      compareChangeLine({
        draftHeadSha: DRAFT_HEAD,
        currentHeadSha: CURRENT_HEAD,
        commits: [],
        newCommits: [],
      }),
    ).toBe('a1b2c3d → f6e5d4c · 0 new commits')
  })
})

/**
 * The dialog's source with runs of whitespace flattened to single spaces, so an
 * expression JSX had split across three lines still matches as one.
 */
const DIALOG = readFileSync(new URL('./reconcile-dialog.tsx', import.meta.url), 'utf8').replace(
  /\s+/g,
  ' ',
)

describe('the dialog gets its line from here', () => {
  test('the scan is reading the dialog and not an empty string', () => {
    // The positive control every absence below rests on. A read that landed on
    // the wrong file, or returned nothing, satisfies "does not contain" for
    // free.
    expect(/export function ReconcileDialog\(/.test(DIALOG)).toBe(true)
  })

  test('it imports the line from this module', () => {
    expect(DIALOG).toContain("import { compareChangeLine } from './reconcile-copy'")
  })

  test('and calls it', () => {
    // Importing without calling is a real intermediate state of a half-finished
    // extraction, and it leaves the old expression on screen.
    expect(DIALOG).toContain('compareChangeLine({')
  })

  test('and no longer counts the commits itself', () => {
    // Scoped to the header expression by naming `live.newCommits.length`, the
    // report field only that expression read. The dialog has a second
    // commit-count ternary in the moved-again toast, over `outcome.newCommits`,
    // which this pattern cannot match — so the guard neither goes green because
    // the toast was edited nor red because it was not. Unrelated copy would
    // have to reach for this exact field to disturb it.
    expect(/\{live\.newCommits\.length\} new\{' '\}/.test(DIALOG)).toBe(false)
  })

  test('and no longer inflects the noun itself', () => {
    // The other half of the same expression, as its own test: a runner stops a
    // body at its first failure, so two absences in one body leave the second
    // never independently falsifiable.
    expect(/live\.newCommits\.length === 1 \? 'commit' : 'commits'/.test(DIALOG)).toBe(false)
  })
})

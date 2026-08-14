import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '@revu/shared'
import type { BranchRef } from '@revu/shared'
import {
  CreateLocalReviewForm,
  createLanding,
  describeCreateLocalReviewError,
  reduceCreateLocalReview,
} from './create-local-review'
import type { CreateLocalReviewFormProps, CreateLocalReviewState } from './create-local-review'

/**
 * The create-review form's behavior, asserted on the real HTML it produces and
 * on the two pure functions beside it.
 *
 * The dialog SHELL is deliberately absent from this file. A Radix
 * `DialogContent` renders through a portal, and a portal emits nothing on the
 * server — the whole dialog serializes to the empty string, so a test written
 * against it would assert on `''` and pass forever. The form body carries no
 * portal, so what these assertions see is what a browser receives.
 */

const MAIN: BranchRef = {
  ref: 'refs/heads/main',
  name: 'main',
  kind: 'local',
  isDefault: true,
}
const FEATURE: BranchRef = {
  ref: 'refs/heads/feature/x',
  name: 'feature/x',
  kind: 'local',
  isDefault: false,
}
/** A remote-tracking ref: a legal base, never a head. */
const TRACKED: BranchRef = {
  ref: 'refs/remotes/origin/release-2',
  name: 'origin/release-2',
  kind: 'remote',
  isDefault: false,
}
/**
 * The same display name as a LOCAL branch — the ambiguity fully qualified refs
 * exist to resolve, and the positive control for the head picker's exclusion.
 */
const TRACKED_AS_LOCAL: BranchRef = {
  ref: 'refs/heads/origin/release-2',
  name: 'origin/release-2',
  kind: 'local',
  isDefault: false,
}

function renderForm(overrides: Partial<CreateLocalReviewFormProps> = {}): string {
  const props: CreateLocalReviewFormProps = {
    branches: [MAIN, FEATURE, TRACKED],
    base: MAIN.ref,
    head: FEATURE.ref,
    title: null,
    pending: false,
    error: null,
    onBaseChange: () => {},
    onHeadChange: () => {},
    onTitleChange: () => {},
    onCreate: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(CreateLocalReviewForm, props))
}

/**
 * The markup of one branch picker. Each picker is a cmdk root, and the two roots
 * appear in source order — base first — so splitting on cmdk's own root marker
 * bounds the base picker exactly. The head slice runs to the end of the form,
 * which makes an absence assertion over it STRICTER than a bounded one (a stray
 * ref anywhere below would also fail) and never weaker; the positive control in
 * the same test is what proves the slice is not simply empty.
 */
function picker(html: string, which: 'base' | 'head'): string {
  const parts = html.split('cmdk-root=""')
  expect(parts).toHaveLength(3)
  return (which === 'base' ? parts[1] : parts[2]) ?? ''
}

function stateWith(overrides: Partial<CreateLocalReviewState> = {}): CreateLocalReviewState {
  return {
    base: MAIN.ref,
    head: FEATURE.ref,
    title: null,
    error: null,
    pending: false,
    createdId: null,
    attempt: 0,
    ...overrides,
  }
}

describe('the branch pickers', () => {
  it('offers every ref as a base and only local branches as a head', () => {
    const html = renderForm()

    const base = picker(html, 'base')
    expect(base).toContain('main')
    expect(base).toContain('feature/x')
    expect(base).toContain('origin/release-2')

    const head = picker(html, 'head')
    expect(head).toContain('main')
    expect(head).toContain('feature/x')
    expect(head).not.toContain('origin/release-2')

    // The control for that absence: the same display name, this time as a local
    // branch, must appear — otherwise the assertion above would pass on a head
    // picker that rendered nothing at all.
    const control = picker(renderForm({ branches: [MAIN, FEATURE, TRACKED_AS_LOCAL] }), 'head')
    expect(control).toContain('origin/release-2')
  })
})

describe('the title field', () => {
  it('defaults to the head branch name and yields to an edit', () => {
    expect(renderForm()).toContain('value="feature/x"')
    expect(renderForm({ title: 'Ingest path rewrite' })).toContain('value="Ingest path rewrite"')
  })
})

describe('reduceCreateLocalReview', () => {
  it('keeps every field the human wrote when a create fails', () => {
    const before = stateWith({ title: 'Half-written title', pending: true })
    const sentence = 'main and feature/x have unrelated histories.'

    const after = reduceCreateLocalReview(before, { type: 'create_failed', error: sentence })

    // Named one by one on purpose: a whole-object comparison would silently
    // stop covering any field added to the state later.
    expect(after.base).toBe(before.base)
    expect(after.head).toBe(before.head)
    expect(after.title).toBe(before.title)
    expect(after.pending).toBe(false)
    expect(after.error).toBe(sentence)
    expect(after.createdId).toBeNull()
  })

  it('treats a second create of the same pair as a success, not a conflict', () => {
    const first = reduceCreateLocalReview(stateWith({ pending: true }), {
      type: 'created',
      id: 1_000_000_001,
    })
    expect(first.createdId).toBe(1_000_000_001)

    // The same pair again: the id the caller already knows comes back, and it
    // resolves to the same closed state — no error sentence, nothing pending.
    const again = reduceCreateLocalReview(
      stateWith({ pending: true, error: 'an earlier failure' }),
      { type: 'created', id: 1_000_000_001 },
    )
    expect(again.createdId).toBe(1_000_000_001)
    expect(again.error).toBeNull()
    expect(again.pending).toBe(false)
  })

  it('starts over on reset, holding nothing the previous visit left behind', () => {
    // Reopening the dialog on the last attempt's half-typed fields — or on its
    // failure sentence — would show the human a form they already walked away
    // from. This transition is the only thing that stops it.
    const populated = stateWith({
      base: TRACKED.ref,
      head: FEATURE.ref,
      title: 'Half-written title',
      error: 'Could not reach the workspace.',
      pending: true,
      createdId: 1_000_000_001,
    })

    const after = reduceCreateLocalReview(populated, { type: 'reset' })

    // Named one by one for the same reason as above: a whole-object comparison
    // would silently stop covering any field added to the state later.
    expect(after.base).toBe('')
    expect(after.head).toBe('')
    expect(after.title).toBeNull()
    expect(after.error).toBeNull()
    expect(after.pending).toBe(false)
    expect(after.createdId).toBeNull()
  })
})

/**
 * A create the human walked away from while it was still in flight.
 *
 * The request is not cancellable and the review it makes is real either way —
 * what is at stake is only whether its answer is still allowed to move the
 * reader. Someone who dismissed the dialog went back to whatever they were
 * doing, and landing them on a review a moment later is a teleport out of it.
 *
 * The attempt counter is what separates the two cases, and it is a field of the
 * state machine rather than a private counter in the component precisely so
 * this can be asserted without a renderer.
 */
describe('an attempt the human walked away from', () => {
  const sent = stateWith({ pending: true, attempt: 4 })

  it('is no longer the attempt the form is on once the dialog is dismissed', () => {
    const after = reduceCreateLocalReview(sent, { type: 'dismissed' })
    expect(createLanding(sent.attempt, after.attempt)).toBe('abandoned')
  })

  it('while an attempt nobody walked away from does land', () => {
    // The control. Without it a landing rule that answered "abandoned" to
    // everything would satisfy the assertion above and strand every create on
    // a dialog that never closes.
    expect(createLanding(sent.attempt, sent.attempt)).toBe('land')
  })

  it('and reopening the dialog does not resurrect it', () => {
    const reopened = reduceCreateLocalReview(
      reduceCreateLocalReview(sent, { type: 'dismissed' }),
      { type: 'reset' },
    )
    expect(createLanding(sent.attempt, reopened.attempt)).toBe('abandoned')
    // The reopened form is a fresh one, not the old one with its spinner still
    // turning: reset advances the counter rather than restoring it, so the
    // first attempt cannot come back and land on the second form.
    expect(reopened.pending).toBe(false)
    expect(reopened.title).toBeNull()
  })

  it('stops the form claiming a create is still in flight', () => {
    expect(reduceCreateLocalReview(sent, { type: 'dismissed' }).pending).toBe(false)
  })
})

/**
 * That the dialog actually drives the two transitions above — asserted by
 * READING ITS SOURCE rather than by running it.
 *
 * The transitions themselves are pure and are held directly. What no assertion
 * can reach is the effect that dispatches them, because observing it needs the
 * dialog rendered, and the dialog is a portal: it serializes to the empty
 * string, so a test that rendered it would assert against `''` and pass through
 * any regression at all.
 *
 * So these assert the wiring is PRESENT, which is strictly weaker than running
 * it. An effect that dispatched into a reducer whose result went nowhere, or a
 * guard whose early return were unreachable, would satisfy every line here.
 * What it does catch is the deletion — the effect removed, or the guard
 * dropped — which is what leaves a reopened dialog showing the last visit's
 * fields, and a dismissed reader on a review they never asked to see.
 */
describe('what the dialog does with the form around it', () => {
  const source = readFileSync(new URL('./create-local-review.tsx', import.meta.url), 'utf8')

  /** Whether the module's source carries `pattern`, as a boolean — a failed
   *  match against a whole file prints the whole file. */
  const carries = (pattern: RegExp): boolean => pattern.test(source)

  it('is reading the module it names', () => {
    // The control for every match below: a path resolving to the wrong file
    // would fail them for a reason with nothing to do with the dialog.
    expect(carries(/export function CreateLocalReviewDialog/)).toBe(true)
  })

  it('starts the form over on open and ends the attempt on close', () => {
    expect(carries(/dispatch\(\{ type: open \? 'reset' : 'dismissed' \}\)/)).toBe(true)
    expect(carries(/\}, \[open\]\)/)).toBe(true)
  })

  it('and lets no abandoned attempt navigate', () => {
    // Anchored on the dispatch each guard stands in front of, and named per
    // path. A pattern searched loose over the file would be satisfied by the
    // OTHER path's copy of the same line, so deleting either one on its own
    // would go unnoticed — which is what a first draft of this did.
    const guard = String.raw`if \(createLanding\(attempt, attemptRef\.current\) === 'abandoned'\) return`
    expect(carries(new RegExp(`${guard}\\n\\s*dispatch\\(\\{ type: 'created'`))).toBe(true)
    expect(carries(new RegExp(`${guard}\\n\\s*dispatch\\(\\{ type: 'create_failed'`))).toBe(true)
  })

  it('and the landing it guards is a navigation, not a no-op', () => {
    // The control for the two above: guards standing in front of a submit path
    // that navigated nowhere would satisfy them and protect nothing.
    expect(carries(/navigate\(`\/pr\/\$\{review\.id\}`\)/)).toBe(true)
  })
})

describe('describeCreateLocalReviewError', () => {
  const sameRef = new ApiError(
    'unprocessable',
    'Base and head name the same ref (refs/heads/main) - a review needs two different sides.',
  )
  const unrelated = new ApiError(
    'unprocessable',
    'refs/heads/main and refs/heads/feature/x have unrelated histories, so there is no merge base to compare from.',
  )
  const shallow = new ApiError(
    'unprocessable',
    'This is a shallow clone, so git cannot compute a merge base. Fetch the full history and try again.',
  )
  const missing = new ApiError(
    'not_found',
    'The branch refs/heads/feature/x is no longer in this repository.',
  )

  it('gives each typed failure its own sentence', () => {
    const sentences = [sameRef, unrelated, shallow, missing].map(describeCreateLocalReviewError)
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0)
    expect(new Set(sentences).size).toBe(4)
  })

  it('names both refs when the histories are unrelated, and the form shows that sentence', () => {
    const sentence = describeCreateLocalReviewError(unrelated)
    expect(sentence).toContain('refs/heads/main')
    expect(sentence).toContain('refs/heads/feature/x')

    // Pinned to what the form actually renders, so the copy cannot drift into a
    // constant nothing shows.
    expect(renderForm({ error: sentence })).toContain(sentence)
    // The control: the line is conditional, not always on screen.
    expect(renderForm({ error: null })).not.toContain(sentence)
  })

  it('says the written text survived when the workspace could not be reached', () => {
    const sentence = describeCreateLocalReviewError(
      new ApiError('broker_unreachable', 'The broker did not respond.'),
    )
    expect(sentence.length).toBeGreaterThan(0)
    expect(renderForm({ error: sentence })).toContain(sentence)
  })
})

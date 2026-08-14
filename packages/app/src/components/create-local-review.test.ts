import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '@revu/shared'
import type { BranchRef } from '@revu/shared'
import {
  CreateLocalReviewForm,
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

/**
 * The confirmation shown before a review of two local branches is deleted,
 * asserted against the HTML a browser actually receives.
 *
 * Everything here renders the BODY, never the dialog around it. A Radix
 * `DialogContent` renders through a portal, a portal has no target during
 * static rendering, and the whole shell therefore serialises to the empty
 * string — so an assertion written against the dialog would be checking `''`
 * and would keep passing through every regression this file exists to catch.
 * That is the reason the body is its own component at all.
 *
 * Absences here are the load-bearing assertions — the discard promise must not
 * appear over a review that has no draft to discard, and the review's synthetic
 * key must never reach a screen — so each one carries a positive control in the
 * same test body, from the same component and the same harness.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import type { PullDetail } from '@revu/shared'
import { fixtureDB } from '@/fixtures'
import { buttonVariants } from '@/components/ui/button'
import { localReviewLabel } from '@/lib/local-reviews'
import type { RowIdentity } from '@/lib/local-reviews'
import { deleteLocalReviewCopy, deleteLocalReviewRefusedCopy } from '@/lib/mode-copy'
import type { DeleteDraftSummary } from '@/lib/mode-copy'
import { renderStatic } from '@/lib/render-test'
import { ConfirmDeleteLocalReviewBody } from './confirm-delete-local-review'

/**
 * A real seeded local review rather than one assembled here. What is under test
 * is what this dialog does with a review the app actually holds — a branch name
 * carrying digits is exactly what a careless key assertion mistakes for a leak —
 * and a review built by the test would prove only that the test built it so.
 */
const LOCAL_PULL: PullDetail = fixtureDB.localReviews[0].snapshot.mutable.pull

/** The identity slot for that review, derived the way a listed row derives it. */
const LOCAL_IDENTITY: RowIdentity = { kind: 'local', ...localReviewLabel(LOCAL_PULL) }

/** A draft holding both kinds of text, as the confirmation summarises one. */
const FULL_DRAFT: DeleteDraftSummary = { pendingCount: 3, hasBody: true }

/** The body as HTML, in whichever state the caller wants to look at. */
function body(options: {
  identity?: RowIdentity
  draft?: DeleteDraftSummary | null
  pending?: boolean
  refusal?: string | null
}): string {
  return renderStatic(
    createElement(ConfirmDeleteLocalReviewBody, {
      identity: options.identity ?? LOCAL_IDENTITY,
      draft: options.draft ?? null,
      pending: options.pending ?? false,
      refusal: options.refusal ?? null,
      onConfirm: () => {},
      onCancel: () => {},
    }),
  )
}

/** Rendered text with the markup taken out, so an assertion reads what a reader would. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The one `<button>` element whose own text is `label`, whole.
 *
 * Assertions about the destructive control have to be about THAT control: a
 * search over the whole body would be satisfied by a danger tint anywhere in
 * it, including the refusal box, which is drawn in the same palette.
 */
function buttonLabelled(markup: string, label: string): string {
  const found = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((m) => m[0])
    .filter((el) => visibleText(el).includes(label))
  if (found.length !== 1) {
    throw new Error(`expected exactly one button reading “${label}”, found ${found.length}`)
  }
  return found[0]
}

const WITH_DRAFT = body({ draft: FULL_DRAFT })
const WITHOUT_DRAFT = body({ draft: null })

/** The copy this surface is required to be drawing, read from its one source. */
const DRAFT_COPY = deleteLocalReviewCopy('local', FULL_DRAFT)
const PLAIN_COPY = deleteLocalReviewCopy('local', null)

describe('what the confirmation says about an unsubmitted draft', () => {
  test('a review holding one is told the draft is discarded first', () => {
    // Both halves in one body deliberately: the presence is the positive
    // control for the absence, and a control in another test would not prove
    // this render was capable of carrying the sentence at all.
    expect(visibleText(WITH_DRAFT)).toContain(DRAFT_COPY?.body ?? 'no copy')
    expect(visibleText(WITHOUT_DRAFT)).not.toContain(DRAFT_COPY?.body ?? 'no copy')
  })

  test('and a review holding none says only what a delete takes', () => {
    expect(visibleText(WITHOUT_DRAFT)).toContain(PLAIN_COPY?.body ?? 'no copy')
  })

  test('the destructive control names everything it is about to do', () => {
    expect(visibleText(WITH_DRAFT)).toContain('Discard draft and delete')
    expect(visibleText(WITHOUT_DRAFT)).toContain('Delete review')
  })
})

// ————————————————————————————————————————————————————————————————
// The destructive treatment, read from the button rather than paraphrased
// ————————————————————————————————————————————————————————————————

/**
 * The classes the danger variant adds and the default variant does not.
 *
 * Read out of the button's own variant table rather than written down here: a
 * literal copied from it is a second spelling of the treatment that goes stale
 * the moment the palette moves, and the assertion would then be green over a
 * confirm button drawn in some other colour entirely.
 */
const DANGER_ONLY: string[] = (() => {
  const plain = new Set(buttonVariants({ variant: 'default' }).split(/\s+/))
  return buttonVariants({ variant: 'danger' })
    .split(/\s+/)
    .filter((cls) => cls !== '' && !plain.has(cls))
})()

describe('the confirm control is drawn as the destructive act it is', () => {
  test('the variant table really distinguishes danger from the quiet default', () => {
    // The control for the assertion below: an empty difference would satisfy it
    // for free, whatever the button is actually wearing.
    expect(DANGER_ONLY.length).toBeGreaterThan(0)
  })

  test('and the confirm button wears every class that difference names', () => {
    const confirm = buttonLabelled(WITH_DRAFT, 'Discard draft and delete')
    expect(DANGER_ONLY.filter((cls) => !confirm.includes(cls))).toEqual([])
  })

  test('and the cancel button wears none of them', () => {
    // Red means destructive in this app, so the way out must not be wearing it.
    const cancel = buttonLabelled(WITH_DRAFT, PLAIN_COPY?.cancel ?? 'no copy')
    expect(DANGER_ONLY.filter((cls) => cancel.includes(cls))).toEqual([])
  })
})

describe('where the keyboard lands when the confirmation opens', () => {
  test('on the way out, not on the destructive control', () => {
    // A confirmation whose destructive button is focused is a confirmation that
    // Enter answers "yes" to. The default focus is the cancel, so the reflex
    // keystroke keeps the review.
    expect(buttonLabelled(WITH_DRAFT, PLAIN_COPY?.cancel ?? 'no copy')).toContain('autofocus')
    expect(buttonLabelled(WITH_DRAFT, 'Discard draft and delete')).not.toContain('autofocus')
  })

  test('and both controls are real buttons, reachable by tab', () => {
    // The positive control for the absence above, and the property the focus
    // rule rests on: a div dressed as a button carries no autofocus either, and
    // would satisfy that absence while being unreachable from the keyboard.
    expect(buttonLabelled(WITH_DRAFT, 'Discard draft and delete')).toMatch(
      /^<button\b[^>]*type="button"/,
    )
    expect(buttonLabelled(WITH_DRAFT, PLAIN_COPY?.cancel ?? 'no copy')).toMatch(
      /^<button\b[^>]*type="button"/,
    )
  })
})

describe('while a delete is in flight', () => {
  test('neither control can be pressed again', () => {
    // Matched as the ATTRIBUTE, not as the word: every button in this app
    // carries `disabled:` utility classes whatever state it is in, so a
    // substring search for the bare word is satisfied by a live control.
    const busy = body({ draft: FULL_DRAFT, pending: true })
    expect(buttonLabelled(busy, 'Discard draft and delete')).toMatch(/\sdisabled=""/)
    expect(buttonLabelled(busy, PLAIN_COPY?.cancel ?? 'no copy')).toMatch(/\sdisabled=""/)
  })

  test('and are pressable when nothing is', () => {
    // The positive control: disabled is a state this render can be in and can
    // leave, rather than an attribute the markup happens never to carry.
    expect(buttonLabelled(WITH_DRAFT, 'Discard draft and delete')).not.toMatch(/\sdisabled=""/)
  })
})

// ————————————————————————————————————————————————————————————————
// Identity — the pair, never the key
// ————————————————————————————————————————————————————————————————

/** The branch pair exactly as a reader sees it drawn. */
const PAIR = `${localReviewLabel(LOCAL_PULL).base} ← ${localReviewLabel(LOCAL_PULL).head}`

describe('what the confirmation calls the review', () => {
  test('the two branches it compares', () => {
    expect(visibleText(WITH_DRAFT)).toContain(PAIR)
  })

  test('and never the synthetic key it is routed by', () => {
    // Searched WHOLE, over the raw markup rather than the visible text: the
    // rule is that the key reaches no screen at all, through a heading, a title
    // or an attribute alike. Hunting for its digits would collapse to "names no
    // 0 and no 1", which an ordinary branch name trips with nothing leaked.
    //
    // The pair is the positive control: it proves this render really did draw
    // the review's identity, so the absence is about what was chosen to draw
    // rather than about a render that drew nothing.
    expect(visibleText(WITH_DRAFT)).toContain(PAIR)
    expect(WITH_DRAFT).not.toContain(String(LOCAL_PULL.number))
  })

  test('nor any review number at all', () => {
    expect(visibleText(WITH_DRAFT)).toContain(PAIR)
    expect(WITH_DRAFT).not.toMatch(/#\d+/)
  })
})

// ————————————————————————————————————————————————————————————————
// A refusal that outlived the discard
// ————————————————————————————————————————————————————————————————

/** A refusal worded the way the workspace words one, naming its own remedy. */
const REFUSAL =
  'Local review 1000000001 still holds an unsubmitted draft with text in it — discard that draft, then delete the review.'

describe('a delete the workspace refused', () => {
  test('shows the workspace’s own sentence, unedited', () => {
    // Passed through rather than reworded here. Only the side that refused
    // knows which review and whose draft, and a sentence invented on this side
    // could only be vaguer — or wrong, once that one is reworded.
    expect(visibleText(body({ refusal: REFUSAL }))).toContain(REFUSAL)
  })

  test('under a line saying what a reader can do about it', () => {
    expect(visibleText(body({ refusal: REFUSAL }))).toContain(
      deleteLocalReviewRefusedCopy('local') ?? 'no copy',
    )
  })

  test('and says nothing of the kind when nothing was refused', () => {
    expect(visibleText(body({ refusal: REFUSAL }))).toContain(REFUSAL)
    expect(visibleText(WITH_DRAFT)).not.toContain(REFUSAL)
  })
})

describe('a review that is not a branch pair', () => {
  test('is offered no confirmation here at all', () => {
    // Nothing in this app deletes a mediated review, so there is no honest
    // dialog to draw for one. The control is the branch-pair render above,
    // which is substantial from the same component and the same harness.
    expect(visibleText(WITH_DRAFT).length).toBeGreaterThan(100)
    expect(body({ identity: { kind: 'github', text: '#347' } })).toBe('')
  })
})

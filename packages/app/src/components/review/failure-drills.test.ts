/**
 * Failure drills that land on USER-FACING COPY — the two the frontend owns.
 *
 * Each drill exercises a real failure mode and asserts BOTH the behavior AND the
 * exact one sentence `describeApiError` produces for it, verified against the
 * real function (never a hardcoded copy string the code would not actually
 * emit). The remaining drills — the ones whose failure lives in the read/persist
 * engine — sit beside the engine in `packages/revud/src/direct/failure-drills.test.ts`.
 *
 * One drill's user-facing surface is NOT a `describeApiError` sentence at all:
 * the submit-window force-push returns `head_moved` as a VALUE (never a thrown
 * error), so the frontend routes it to the head-moved dialog instead of
 * `describeApiError`. Its copy — the dialog title — is pinned here too, against
 * the real exported constant the dialog renders.
 *
 * The two here run against the in-process mock adapter, whose store is a single
 * localStorage-backed document shared across every `bun test` file in the
 * process. So this suite resets it in `beforeAll` (and forces zero latency +
 * no ambient failure mode) to keep another file's mock mutations from leaking
 * in — the same discipline the mock conformance runner follows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ApiError } from '@revu/shared'
import type { ReviewDraft } from '@revu/shared'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { describeApiError, HEAD_MOVED_TITLE } from './error-copy'
import { minutesUntil } from '@/lib/time'

const api = createMockApi()

beforeAll(() => {
  mockDev.reset()
  mockDev.setLatency('zero')
  mockDev.setFailureMode('none')
})

afterAll(() => {
  // This suite toggles failureMode and writes drafts; restore the shared store
  // to a pristine seed so a later file inherits none of it.
  mockDev.setFailureMode('none')
  mockDev.reset()
})

// ————————————————————————————————————————————————————————————————
// Drill 1 — the broker goes down mid draft-save. The draft text is never lost:
// the failing save throws, the human's text is still in hand, and a retry once
// the broker recovers persists it intact.
// ————————————————————————————————————————————————————————————————

describe('drill: broker down mid draft-save keeps the draft, retry succeeds', () => {
  const DRAFT_TEXT = 'Half-written review the human must not lose to a broker blip.'

  // A PR with NO seeded draft, so a clean store (after reset) has nothing here —
  // making "the failed save landed nothing" a precise assertion. (312 and 389
  // carry seeded drafts; 204 does not.)
  const PR = 204

  /** A draft the human is composing, its text held in the editor. */
  function composingDraft(): ReviewDraft {
    return {
      humanId: 'h-priya',
      prNumber: PR,
      headSha: 'seeded-head',
      compareKey: 'seeded-base...seeded-head',
      body: DRAFT_TEXT,
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    }
  }

  test('the save fails loudly, the text survives, and the copy is the real describeApiError sentence', async () => {
    const draft = composingDraft()

    // The broker is unreachable for writes when the save is attempted.
    mockDev.setFailureMode('writes')
    let caught: unknown = null
    try {
      await api.saveDraft(draft)
    } catch (err) {
      caught = err
    }

    // The failure is loud and typed (never a silent swallow the human would read
    // as "saved"), and the copy the UI shows is exactly what describeApiError
    // yields for THIS error — the mock's own failure+consequence sentence.
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).code).toBe('network')
    expect(describeApiError(caught)).toBe(
      'The broker did not answer — your draft was not saved. Your text is still in ' +
        'the editor; retry when the broker is reachable.',
    )

    // The draft text was never mutated by the failed attempt — it is exactly the
    // string the human is still holding in the editor.
    expect(draft.body).toBe(DRAFT_TEXT)
    // And nothing partial landed on the broker: the store has no draft for this PR.
    expect(await api.getDraft(PR)).toBeNull()

    // The broker recovers; the SAME text retries and persists intact.
    mockDev.setFailureMode('none')
    const saved = await api.saveDraft(draft)
    expect(saved.body).toBe(DRAFT_TEXT)
    const reloaded = await api.getDraft(PR)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.body).toBe(DRAFT_TEXT)
  })
})

// ————————————————————————————————————————————————————————————————
// Drill 3 — the shared rate bucket is exhausted. A rate_limited ApiError with a
// resetAt drives the countdown copy, whose minute count comes from the real
// minutesUntil math — not a magic number baked into the assertion.
// ————————————————————————————————————————————————————————————————

describe('drill: rate-limit exhaustion surfaces the countdown copy', () => {
  test('describeApiError renders "Rate limit exhausted. Resets in N minutes." with N from minutesUntil', () => {
    // describeApiError calls minutesUntil(resetAt) without passing a clock, so it
    // falls back to minutesUntil's default of the real current time; the reset is
    // anchored to now and the expected minute count is read from the SAME
    // function the copy uses — never a magic number, and never racing a
    // wall-clock tick, because the resetAt sits far enough out that a few ms of
    // drift can't cross a minute.
    const resetAt = new Date(Date.now() + 25 * 60_000).toISOString()
    const error = new ApiError('rate_limited', 'GitHub rate limit reached.', resetAt)

    const minutes = minutesUntil(resetAt)
    // A ~25-minute reset must land as a positive whole-minute countdown.
    expect(minutes).toBeGreaterThan(0)

    // The countdown copy is exactly the real function's output for this error,
    // with the minute count derived from minutesUntil, not pasted in.
    expect(describeApiError(error)).toBe(`Rate limit exhausted. Resets in ${minutes} minutes.`)
  })

  test('an already-past reset floors at zero minutes rather than going negative', () => {
    const resetAt = new Date(Date.now() - 60_000).toISOString() // already elapsed
    const error = new ApiError('rate_limited', 'GitHub rate limit reached.', resetAt)

    const minutes = minutesUntil(resetAt)
    expect(minutes).toBe(0)
    expect(describeApiError(error)).toBe(`Rate limit exhausted. Resets in ${minutes} minutes.`)
  })

  test('a rate_limited ApiError with NO resetAt falls back to its plain message', () => {
    // The countdown branch fires only when resetAt is present; without it the
    // function surfaces the transport's own message verbatim.
    const error = new ApiError('rate_limited', 'GitHub rate limit reached; try again shortly.')
    expect(describeApiError(error)).toBe('GitHub rate limit reached; try again shortly.')
  })
})

// ————————————————————————————————————————————————————————————————
// Drill 5 (copy half) — the submit-window force-push. The engine drill in
// packages/revud/src/direct/failure-drills.test.ts pins the BEHAVIOR: the guard
// returns `head_moved` as a VALUE (never thrown), posts nothing, and the draft
// survives. Because head_moved is a returned value, the frontend routes it to
// the head-moved dialog — it never reaches `describeApiError`, whose sole input
// is a thrown value — so that function structurally has no branch for this case.
// The user-facing copy is therefore the dialog's title, pinned here against the
// real exported constant the dialog renders (not a hardcoded literal).
// ————————————————————————————————————————————————————————————————

describe('drill: submit-window force-push surfaces the head-moved dialog copy', () => {
  test('head_moved is a value that bypasses describeApiError; its copy is the dialog title', () => {
    // head_moved never surfaces through describeApiError: it is not an error the
    // frontend catches, it is a value it branches on to open the head-moved
    // dialog. So there is no describeApiError sentence to assert; the human-facing
    // copy is the dialog title, and this pins the exact title the dialog renders.
    expect(HEAD_MOVED_TITLE).toBe('The branch moved while you were reviewing')

    // Guard the structural claim itself: a head_moved value is not an Error, so
    // describeApiError would fall through to its non-Error branch — it never emits
    // the dialog's copy. This is why the copy is pinned against the dialog, not
    // this function.
    const headMovedValue = { status: 'head_moved', currentHeadSha: 'head2', newCommits: 1 }
    expect(describeApiError(headMovedValue)).toBe('Something went wrong.')
    expect(describeApiError(headMovedValue)).not.toBe(HEAD_MOVED_TITLE)
  })
})

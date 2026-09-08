/**
 * What applying a reconcile does to a draft, and the one thing it used to
 * forget.
 *
 * ## The bug these tests stand over
 *
 * A draft records the head its comments were captured against. That field was
 * written exactly once — when the draft was created — and never again. Applying
 * a reconcile re-captured every kept comment's anchor against the FRESHLY
 * synced head and then submitted. On the happy path the draft is consumed by
 * the submit and nobody notices. On a refused submit, or anything that throws,
 * the draft SURVIVES: comments describing the new head, `headSha` still naming
 * the old one.
 *
 * That is not a quiet inaccuracy. The next reconcile finds the recorded head in
 * the compare and slices everything after it; when the head is absent from the
 * compare entirely — which is exactly what a rebase or an amend leaves — there
 * is nothing to slice after, so every commit in the range is reported as new.
 * A stale head therefore makes the next reconcile claim the whole branch landed
 * since the draft was written.
 *
 * ## Why the assertions are split three ways
 *
 * The pure transform (`withDraftHead`) is checkable on its own and pins the
 * narrow claim: two fields move, nothing else does.
 *
 * The plan (`planReconcileApply`) is the decision logic lifted out of a React
 * closure so it can be run at all — this package has no DOM runner, and the
 * original loop closed over a query client, two mutations and a toast. Its
 * blob reads arrive through an injected resolver, so a fake map stands in for
 * the cache.
 *
 * Neither of those can show that the FIX WORKS, because neither touches a
 * draft store. So the regression is driven through the real mock adapter, and
 * both of its legs live in one test: the stale head reporting the entire
 * compare as new, and the same draft after the head is persisted reporting
 * none. Keeping them together is what stops the fix from decaying into a
 * no-op — a `nextHead` quietly returning null would still satisfy every
 * assertion about shapes and counts, and only the paired legs go red.
 *
 * ## The shared store
 *
 * The mock adapter's store is a single localStorage-backed document shared by
 * every `bun test` file in the process, so this suite resets it in `beforeAll`
 * (with zero latency and no ambient failure mode) and restores it in
 * `afterAll` — the same discipline the other mock-backed suites here follow.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AnchorResult, PendingComment, ReviewDraft, Snapshot } from '@revu/shared'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { withDraftHead } from '@/state/drafts'
import { coherentDraftHead, planReconcileApply } from './reconcile-plan'
import type { ReconcileDecision } from './reconcile-plan'

/** A pull request with no seeded draft, so what this file writes is all there is. */
const PR = 204

const OLD_HEAD = '1111111111111111111111111111111111111111'
const NEW_HEAD = '2222222222222222222222222222222222222222'
const MERGE_BASE = '0000000000000000000000000000000000000000'

const api = createMockApi()

let snapshot: Snapshot

beforeAll(async () => {
  mockDev.reset()
  mockDev.setLatency('zero')
  mockDev.setFailureMode('none')
  snapshot = await api.syncPull(PR)
})

afterAll(() => {
  // This suite writes drafts into the shared store; restore it to a pristine
  // seed so a later file inherits none of it.
  mockDev.setFailureMode('none')
  mockDev.reset()
})

/** A pending comment with everything filled in, so nothing is undefined by accident. */
function pending(
  key: string,
  path: string,
  line: number,
  startLine: number | null = null,
): PendingComment {
  return {
    key,
    path,
    side: 'RIGHT',
    start_side: startLine === null ? null : 'RIGHT',
    line,
    start_line: startLine,
    body: `a remark about ${path}:${line}`,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    anchor: {
      lineText: `original text at ${line}`,
      contextBefore: ['before one', 'before two'],
      contextAfter: ['after one'],
      startLineText: null,
    },
  }
}

/** A draft anchored to `OLD_HEAD`, carrying whatever comments a test needs. */
function draftAt(comments: PendingComment[]): ReviewDraft {
  return {
    humanId: 'h-priya',
    prNumber: PR,
    headSha: OLD_HEAD,
    compareKey: `${MERGE_BASE}...${OLD_HEAD}`,
    body: 'The summary the human wrote, which no reconcile may touch.',
    event: 'REQUEST_CHANGES',
    comments,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T01:00:00.000Z',
  }
}

// ————————————————————————————————————————————————————————————————
// The transform that moves a head
// ————————————————————————————————————————————————————————————————

describe('re-anchoring a draft to a new head', () => {
  test('moves the SHA and the compare key together and leaves the rest alone', () => {
    const draft = draftAt([pending('k1', 'src/a.ts', 10)])
    const moved = withDraftHead(draft, {
      headSha: NEW_HEAD,
      compareKey: `${MERGE_BASE}...${NEW_HEAD}`,
    })

    expect(moved.headSha).toBe(NEW_HEAD)
    expect(moved.compareKey).toBe(`${MERGE_BASE}...${NEW_HEAD}`)

    // The invariant the pair exists to hold, asserted on the RESULT rather than
    // on the argument: a key naming one commit beside a SHA naming another is
    // the exact document this whole unit exists to make unwritable, and a
    // transform that dropped one of the two assignments would still satisfy
    // both equalities above if the other happened to match.
    expect(moved.compareKey.endsWith(moved.headSha)).toBe(true)

    // Named individually because these are the fields a human would lose, and
    // "the comments survived a head move" deserves to fail by name.
    expect(moved.comments).toStrictEqual(draft.comments)
    expect(moved.body).toBe(draft.body)
    expect(moved.event).toBe(draft.event)
    expect(moved.createdAt).toBe(draft.createdAt)

    // And the whole rest of the document, so a field added to `ReviewDraft`
    // later is covered without anyone remembering to list it here: putting the
    // OLD pair back must reproduce the input exactly.
    expect({
      ...moved,
      headSha: draft.headSha,
      compareKey: draft.compareKey,
    }).toStrictEqual(draft)
  })

  test('and does not mutate the draft it was handed', () => {
    // The cache holds the draft object the UI is rendering from; a transform
    // that edited it in place would change what is on screen before anything
    // decided to write.
    const draft = draftAt([pending('k1', 'src/a.ts', 10)])
    withDraftHead(draft, { headSha: NEW_HEAD, compareKey: `${MERGE_BASE}...${NEW_HEAD}` })
    expect(draft.headSha).toBe(OLD_HEAD)
    expect(draft.compareKey).toBe(`${MERGE_BASE}...${OLD_HEAD}`)
  })
})

// ————————————————————————————————————————————————————————————————
// The coherence guard on the pair
// ————————————————————————————————————————————————————————————————

describe('forming the pair from two separate sources', () => {
  test('a key whose right-hand side is this head forms the pair', () => {
    expect(coherentDraftHead(NEW_HEAD, `${MERGE_BASE}...${NEW_HEAD}`)).toStrictEqual({
      headSha: NEW_HEAD,
      compareKey: `${MERGE_BASE}...${NEW_HEAD}`,
    })
  })

  test('a key naming a different head forms nothing', () => {
    // The hazard in its real shape: the head SHA comes off the reconcile
    // report and the compare key off the snapshot query, and on the tick
    // before that query settles the key still describes the PREVIOUS compare.
    // Stitching those two halves together produces a draft whose two head
    // fields permanently contradict each other, which is worse than leaving
    // the head where it was — that at least stays wrong in one direction that
    // the next reconcile makes loud.
    expect(coherentDraftHead(NEW_HEAD, `${MERGE_BASE}...${OLD_HEAD}`)).toBeNull()
  })

  test('and an absent key forms nothing rather than inventing one', () => {
    // A compare key is `mergeBase...head`; the report carries no merge base, so
    // there is no honest way to synthesize the key from the head alone. Both
    // absences the query layer can produce are covered — undefined is what
    // `snapshot?.immutable.compareKey` yields while the snapshot is unread.
    expect(coherentDraftHead(NEW_HEAD, undefined)).toBeNull()
    expect(coherentDraftHead(NEW_HEAD, null)).toBeNull()
    expect(coherentDraftHead(NEW_HEAD, '')).toBeNull()
  })

  test('and a head that is merely a suffix of the key is not a match', () => {
    // `endsWith(headSha)` alone would accept this: the key's head half is a
    // LONGER string that happens to end in the same characters. The separator
    // is part of the test for that reason.
    expect(coherentDraftHead('2222', `${MERGE_BASE}...9992222`)).toBeNull()
  })
})

// ————————————————————————————————————————————————————————————————
// The plan
// ————————————————————————————————————————————————————————————————

/** Sixty numbered lines, so a re-captured anchor's neighborhood is legible. */
const C_LINES = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)

const BLOB_INDEX = {
  'src/keep.ts': { base: null, head: 'blob-keep' },
  'src/drop.ts': { base: null, head: 'blob-drop' },
  'src/drift.ts': { base: null, head: 'blob-drift' },
}

const BLOBS: Record<string, string[]> = {
  'blob-keep': ['keep me'],
  'blob-drop': ['drop me'],
  'blob-drift': C_LINES,
}

describe('planning what apply will do', () => {
  const keep = pending('k-keep', 'src/keep.ts', 3)
  const drop = pending('k-drop', 'src/drop.ts', 7)
  const drift = pending('k-drift', 'src/drift.ts', 37)

  const results: AnchorResult[] = [
    { kind: 'clean', comment: keep },
    { kind: 'lost', comment: drop, reason: 'line-deleted' },
    { kind: 'drifted', comment: drift, newLine: 42, newStartLine: null, delta: 5 },
  ]

  const decisions: Record<string, ReconcileDecision | undefined> = {
    'k-keep': { kind: 'keep' },
    'k-drop': { kind: 'drop' },
    'k-drift': { kind: 'accept' },
  }

  test('one keep, one drop and one accepted drift', async () => {
    const asked: string[] = []
    const plan = await planReconcileApply({
      draft: draftAt([keep, drop, drift]),
      results,
      decisions,
      blobIndex: BLOB_INDEX,
      currentHeadSha: NEW_HEAD,
      currentCompareKey: `${MERGE_BASE}...${NEW_HEAD}`,
      resolveLines: (sha) => {
        asked.push(sha)
        return BLOBS[sha] ?? null
      },
    })

    // The submit payload: the survivors, in the draft's own order.
    expect(plan.updated.map((c) => c.key)).toEqual(['k-keep', 'k-drift'])
    expect(plan.removedKeys).toEqual(['k-drop'])
    expect(plan.kept).toBe(2)
    expect(plan.dropped).toBe(1)

    // A kept comment is carried byte for byte — same anchor, same timestamps.
    // A reconcile that "kept" a comment by rewriting it would leave the human
    // looking at an edit they did not make.
    expect(plan.updated[0]).toStrictEqual(keep)

    // The accepted drift takes the classification's new line and re-captures
    // its anchor from the NEW head's content: the line it now sits on, its
    // three neighbors above and its three below, in file order.
    const moved = plan.updated[1]
    expect(moved.line).toBe(42)
    expect(moved.start_line).toBeNull()
    expect(moved.anchor.lineText).toBe('line 42')
    expect(moved.anchor.contextBefore).toEqual(['line 39', 'line 40', 'line 41'])
    expect(moved.anchor.contextAfter).toEqual(['line 43', 'line 44', 'line 45'])
    expect(moved.anchor.startLineText).toBeNull()
    // Everything that is not a position is untouched.
    expect(moved.key).toBe(drift.key)
    expect(moved.body).toBe(drift.body)
    expect(moved.createdAt).toBe(drift.createdAt)

    // Only the comment that MOVED is written back. Writing all of `updated`
    // back would stamp a fresh `updatedAt` on the kept one, and a comment
    // nobody edited must not come out of a reconcile looking edited.
    expect(plan.reanchored).toEqual([moved])

    // The blob reads are exactly the ones a re-anchor needs: the dropped and
    // the kept comments' content is never fetched, because neither is being
    // re-captured.
    expect(asked).toEqual(['blob-drift'])

    // The freshly synced pair, never the draft's own — the whole point of
    // computing it here rather than reading it off the document being changed.
    expect(plan.nextHead).toStrictEqual({
      headSha: NEW_HEAD,
      compareKey: `${MERGE_BASE}...${NEW_HEAD}`,
    })
    expect(plan.nextHead?.headSha).not.toBe(OLD_HEAD)
  })

  test('a comment written after the report was generated is carried untouched', async () => {
    // It has no classification and no decision, because it did not exist when
    // the report was made. Dropping it would lose text the human is still
    // holding; rewriting it would re-anchor it against a comparison nobody
    // performed. It rides along exactly as written, and it counts as kept.
    const late = pending('k-late', 'src/late.ts', 12)
    const plan = await planReconcileApply({
      draft: draftAt([keep, late]),
      results: [{ kind: 'clean', comment: keep }],
      decisions: { 'k-keep': { kind: 'keep' } },
      blobIndex: BLOB_INDEX,
      currentHeadSha: NEW_HEAD,
      currentCompareKey: `${MERGE_BASE}...${NEW_HEAD}`,
      resolveLines: (sha) => BLOBS[sha] ?? null,
    })

    expect(plan.updated).toStrictEqual([keep, late])
    expect(plan.kept).toBe(2)
    expect(plan.dropped).toBe(0)
    expect(plan.reanchored).toEqual([])
  })

  test('an explicit re-anchor shifts a range by the same delta and floors it at line 1', async () => {
    // The span keeps its length: the end moves where the human put it and the
    // start follows by the same amount. The floor matters because a range
    // dragged far enough up would otherwise be handed a zero or negative start
    // line, which is not a line at all.
    const ranged = pending('k-range', 'src/drift.ts', 40, 38)
    const plan = await planReconcileApply({
      draft: draftAt([ranged]),
      results: [{ kind: 'lost', comment: ranged, reason: 'line-deleted' }],
      decisions: { 'k-range': { kind: 'reanchor', line: 12 } },
      blobIndex: BLOB_INDEX,
      currentHeadSha: NEW_HEAD,
      currentCompareKey: `${MERGE_BASE}...${NEW_HEAD}`,
      resolveLines: (sha) => BLOBS[sha] ?? null,
    })

    const [moved] = plan.updated
    expect(moved.line).toBe(12)
    expect(moved.start_line).toBe(10)
    expect(moved.anchor.lineText).toBe('line 12')
    // The range's START text is re-captured too, so the next reconcile can
    // check the start independently instead of shifting it rigidly again.
    expect(moved.anchor.startLineText).toBe('line 10')

    const floored = await planReconcileApply({
      draft: draftAt([pending('k-floor', 'src/drift.ts', 40, 38)]),
      results: [
        { kind: 'lost', comment: pending('k-floor', 'src/drift.ts', 40, 38), reason: 'line-deleted' },
      ],
      decisions: { 'k-floor': { kind: 'reanchor', line: 1 } },
      blobIndex: BLOB_INDEX,
      currentHeadSha: NEW_HEAD,
      currentCompareKey: `${MERGE_BASE}...${NEW_HEAD}`,
      resolveLines: (sha) => BLOBS[sha] ?? null,
    })
    expect(floored.updated[0].start_line).toBe(1)
  })

  test('and an unformable pair leaves nextHead null rather than a stitched one', async () => {
    // The snapshot has not settled, so there is no compare key to pair with the
    // report's head. The comments are still planned — nothing about the human's
    // decisions depends on the key — but the head move is withheld.
    const plan = await planReconcileApply({
      draft: draftAt([keep]),
      results: [{ kind: 'clean', comment: keep }],
      decisions: { 'k-keep': { kind: 'keep' } },
      blobIndex: undefined,
      currentHeadSha: NEW_HEAD,
      currentCompareKey: undefined,
      resolveLines: (sha) => BLOBS[sha] ?? null,
    })
    expect(plan.nextHead).toBeNull()
    expect(plan.updated).toStrictEqual([keep])
  })
})

// ————————————————————————————————————————————————————————————————
// The regression, at the API layer
// ————————————————————————————————————————————————————————————————

/** The draft as the current identity, since the mock files drafts by that id. */
function storedDraft(headSha: string, compareKey: string): ReviewDraft {
  return {
    ...draftAt([]),
    humanId: mockDev.get().humanId,
    headSha,
    compareKey,
  }
}

describe('the head a reconcile measures from', () => {
  test('saveDraft carries the pair, and the human key with it', async () => {
    // Everything below depends on the pair surviving a round trip: the app
    // writes the moved head through the ordinary draft save, so a transport
    // that rebuilt the document from a subset of its fields would silently
    // discard the fix. Pinned here rather than assumed.
    const pair = {
      headSha: snapshot.immutable.headSha,
      compareKey: snapshot.immutable.compareKey,
    }
    const saved = await api.saveDraft(storedDraft(OLD_HEAD, `${MERGE_BASE}...${OLD_HEAD}`))
    expect(saved.headSha).toBe(OLD_HEAD)

    await api.saveDraft(withDraftHead(saved, pair))
    const reloaded = await api.getDraft(PR)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.headSha).toBe(pair.headSha)
    expect(reloaded!.compareKey).toBe(pair.compareKey)
    // The draft came back at all, which means it was filed under this human —
    // a save that dropped the key would leave `getDraft` answering null.
    expect(reloaded!.humanId).toBe(mockDev.get().humanId)
  })

  test('a stale head reports the whole branch as new; the moved head reports none', async () => {
    const commits = snapshot.immutable.commits
    // The pre-fix leg is only meaningful over a compare with commits in it.
    expect(commits.length).toBeGreaterThan(1)

    // A head that exists nowhere in the current compare — what a rebase, an
    // amend, or any force-push that replaced the branch leaves behind, and
    // what a draft is left holding when its comments are re-anchored without
    // its head being moved.
    const gone = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    expect(commits.some((c) => c.sha === gone)).toBe(false)
    const stale = storedDraft(gone, `${snapshot.immutable.mergeBaseSha}...${gone}`)
    await api.saveDraft(stale)

    // Leg (i) — the behaviour being fixed. There is no commit to slice after,
    // so every commit in the range is reported as new: the draft is told the
    // entire branch landed since it was written. This assertion is what
    // distinguishes the fix from a no-op, so it is a check in the gate rather
    // than a remark in a comment.
    const before = await api.reconcileDraft(PR)
    expect(before.draftHeadSha).toBe(gone)
    expect(before.newCommits.length).toBe(commits.length)

    // The head the apply path would move this draft onto, computed by the same
    // function the dialog calls — not a pair assembled here by hand.
    const plan = await planReconcileApply({
      draft: stale,
      results: [],
      decisions: {},
      blobIndex: snapshot.immutable.blobIndex,
      currentHeadSha: snapshot.immutable.headSha,
      currentCompareKey: snapshot.immutable.compareKey,
      resolveLines: () => {
        throw new Error('a draft with no comments must resolve no blobs')
      },
    })
    expect(plan.nextHead).toStrictEqual({
      headSha: snapshot.immutable.headSha,
      compareKey: snapshot.immutable.compareKey,
    })

    // Persisted the ordinary way — the same call the debounced draft save
    // makes, so nothing about this path is special-cased for the head.
    await api.saveDraft(withDraftHead(stale, plan.nextHead!))

    // Leg (ii) — the fix. The recorded head is the tip of the compare, so
    // nothing landed after it and the delta is empty.
    const after = await api.reconcileDraft(PR)
    expect(after.newCommits).toHaveLength(0)
    expect(after.draftHeadSha).toBe(snapshot.immutable.headSha)

    // And the draft still exists. Nothing in moving a head may remove one.
    expect(await api.getDraft(PR)).not.toBeNull()
  })
})

// ————————————————————————————————————————————————————————————————
// Ordering, corroborated
// ————————————————————————————————————————————————————————————————

/** The dialog's source, read as text — no DOM runner exists to render it in. */
const DIALOG = readFileSync(new URL('./reconcile-dialog.tsx', import.meta.url), 'utf8')

describe('the head moves before the submit', () => {
  test('the scan is reading the dialog and not an empty string', () => {
    // The positive control the ordering check rests on. A read that landed on
    // the wrong file, or returned nothing, would make every index below -1 and
    // the comparison meaningless.
    expect(DIALOG).toContain('export function ReconcileDialog(')
  })

  test('the setHead call appears above the submit call in the source', () => {
    // CORROBORATION, not the proof. Source order is a weak proxy for execution
    // order — a call could be moved inside a branch that never runs, or behind
    // an await that resolves later, and this scan would not notice. What
    // actually proves the behaviour is the paired API-layer test above, where a
    // persisted head changes what the next reconcile reports. This check exists
    // because the ORDER is the part that survives a refused submit, and a
    // rearrangement that moved the head write after the submit would leave that
    // pair green while re-opening the bug for every conflict.
    const head = DIALOG.indexOf('actions.setHead(')
    const submit = DIALOG.indexOf('submit.mutateAsync(')
    expect(head).toBeGreaterThan(-1)
    expect(submit).toBeGreaterThan(-1)
    expect(head).toBeLessThan(submit)
  })

  test('and the dialog plans before it writes anything', () => {
    // The other half of the ordering: the decisions are computed as a value
    // first, so a blob that fails to load leaves the draft untouched instead of
    // half re-anchored.
    const plan = DIALOG.indexOf('planReconcileApply({')
    const remove = DIALOG.indexOf('actions.removeComment(')
    expect(plan).toBeGreaterThan(-1)
    expect(remove).toBeGreaterThan(-1)
    expect(plan).toBeLessThan(remove)
  })
})

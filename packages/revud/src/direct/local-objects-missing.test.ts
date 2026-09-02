/**
 * What a local review does when the content it was built from is no longer in
 * the data directory.
 *
 * There is no second source. A local review's objects came from one clone and
 * its bytes were cached in one store, so a data directory that was moved,
 * restored from a partial backup, or pruned out from under a review leaves the
 * envelope naming an immutable half that is not there. The store is right to
 * refuse that: returning a snapshot with an empty immutable half would report a
 * broken store as an ordinary one.
 *
 * But refusing is not the same as answering. `StoreUnreadableError` reaches the
 * transport as `persist_failed` (500) — "this daemon is corrupt" — when the
 * repository is still on disk and one sync rebuilds everything. So the throw is
 * kept and translated at the edge.
 *
 * The pair of assertions below is the whole point, and neither half is
 * sufficient alone: softening the store and translating at the edge look
 * identical from a client, and only asserting BOTH — the edge answers
 * `not_found`, the store still throws when called directly — tells them apart.
 *
 * The last case is the translation's BOUNDARY, and it belongs here rather than
 * anywhere else because it is the same message read against a different row. A
 * re-sync rebuilds a snapshot; it rebuilds no draft, because nothing anywhere
 * reconstructs unsubmitted human text from a repository. So a corrupt draft row
 * answered with "re-sync it, nothing you wrote was touched" is wrong in both
 * halves at once — it names a remedy that cannot work, about the very row that
 * is broken. That state is a genuinely corrupt store and travels as
 * `StoreUnreadableError`, and the case below is what stops the translation being
 * widened back over the read that produces it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@revu/shared'
import { ApiError } from '@revu/shared'
import { createBunCommandRunner } from './command-runner'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { createLocalReviewSurface } from './local-surface'
import type { LocalReviewSurface } from './local-surface'
import type { DirectStore } from './store'
import { StoreUnreadableError, openDirectStore } from './store'

const REPO = 'acme/revu'
const NOW = '2026-01-02T03:04:05.000Z'

/**
 * The key of the one pending comment the seeded draft carries. Named once so
 * the assertion that reconcile still reports on that exact comment after the
 * repair cannot drift away from the comment the fixture wrote.
 */
const DRAFT_COMMENT_KEY = 'objects-missing-anchor'

const SESSION: Session = {
  human: {
    id: 'dana.reeve@example.test',
    name: 'Dana Reeve',
    role: 'contractor',
    email: 'dana.reeve@example.test',
  },
  brokerLogin: '',
  workspace: 'local',
}

describe('a local review whose stored content is gone', () => {
  let fixture: FixtureRepo
  let dataDir: string
  let store: DirectStore
  let surface: LocalReviewSurface
  let localId = 0
  /**
   * A SECOND review, existing only to carry the corrupt draft row.
   *
   * Deliberately not the review above. That one's draft is the subject of the
   * final assertion in this file — that unsubmitted text outlived a store that
   * lost everything derivable — so corrupting it would destroy the thing the
   * suite exists to prove survives. Two reviews over the same repository are
   * two rows in `local_drafts` keyed by their own ids, so damaging one cannot
   * reach the other, and neither this review nor its draft is read by any case
   * but its own.
   */
  let corruptDraftId = 0

  function surfaceOver(open: DirectStore): LocalReviewSurface {
    return createLocalReviewSurface({
      store: open,
      runner: createBunCommandRunner(),
      toplevel: fixture.dir,
      repo: REPO,
      session: SESSION,
      now: () => NOW,
    })
  }

  beforeAll(async () => {
    fixture = await createFixtureRepo()
    dataDir = mkdtempSync(join(tmpdir(), 'revu-objects-missing-'))

    const first = openDirectStore({ dataDir })
    const review = await surfaceOver(first).createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    localId = review.id
    const synced = await surfaceOver(first).syncPull(localId)

    // A draft, written while the content it was anchored against is still
    // whole. This is a precondition of the reconcile assertion below, not
    // scenery: reconcile reads the draft BEFORE it reads the snapshot and
    // refuses outright when there is none, so a fixture without a draft answers
    // that leg with "there is nothing to reconcile" and never reaches the store
    // read whose failure the leg exists to describe. The test would then stay
    // green with the translation it guards deleted outright.
    //
    // The draft carries a comment for a second reason: an empty draft
    // reconciles trivially, and only a comment makes the post-repair check —
    // that reconciling actually classifies something once the content is back —
    // assert anything at all.
    surfaceOver(first).saveDraft({
      humanId: SESSION.human.id,
      prNumber: localId,
      headSha: synced.immutable.headSha,
      compareKey: synced.immutable.compareKey,
      body: 'Unsubmitted text, written before the data directory lost its content.',
      event: 'COMMENT',
      comments: [
        {
          key: DRAFT_COMMENT_KEY,
          path: fixture.paths.modified,
          side: 'RIGHT',
          start_side: null,
          line: 1,
          start_line: null,
          body: 'A note that must outlive the store it was written against.',
          createdAt: NOW,
          updatedAt: NOW,
          anchor: { lineText: '', contextBefore: [], contextAfter: [] },
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    })

    // The second review, over the same two branches with the sides swapped —
    // a different pair, so it is a review of its own rather than the first one
    // returned again, and it needs no third branch to exist.
    //
    // It is never synced, and that is not an omission. Reconcile reads the
    // draft first and the draft row here is about to become unreadable, so the
    // read under test is reached before a snapshot is ever wanted. Leaving the
    // snapshot absent also makes the case impossible to pass by accident: were
    // the corruption not to take, reconcile would fall through to "no local
    // snapshot", which is an `ApiError` and would fail the assertion that the
    // throw is the store's own.
    const swapped = await surfaceOver(first).createLocalReview({
      baseRef: fixture.headBranch,
      headRef: fixture.baseBranch,
    })
    corruptDraftId = swapped.id
    surfaceOver(first).saveDraft({
      humanId: SESSION.human.id,
      prNumber: corruptDraftId,
      // The real shape this pair would sync to: the merge base is shared with
      // the first review and the head is the base branch's tip, since the sides
      // are swapped. Written as the values they would be rather than as
      // placeholders, so the row that gets truncated below was a genuine draft.
      headSha: fixture.baseSha,
      compareKey: `${fixture.mergeBaseSha}...${fixture.baseSha}`,
      body: 'Unsubmitted text on a second review, about to become unreadable.',
      event: 'COMMENT',
      comments: [
        {
          key: 'objects-missing-corrupt',
          path: fixture.paths.modified,
          side: 'RIGHT',
          start_side: null,
          line: 1,
          start_line: null,
          body: 'A note in a row that a partial write is about to truncate.',
          createdAt: NOW,
          updatedAt: NOW,
          anchor: { lineText: '', contextBefore: [], contextAfter: [] },
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    })
    first.close()

    // The manoeuvre: the envelope survives, the immutable half it names does
    // not — exactly what a moved or partially restored data directory leaves
    // behind. Deleting the review's own row instead would be a different test,
    // because an absent review is already a clean answer.
    //
    // It runs AFTER the draft is written, and it empties one table only: the
    // draft lives in its own, so the seeding above cannot repair or repopulate
    // what this removes, and what remains is a review that still knows which
    // content it needs and a store that no longer holds it.
    const raw = new Database(join(dataDir, 'direct.sqlite'))
    raw.run('DELETE FROM immutables')

    // And the second damage, on the second review only: the draft row is
    // truncated where it stands. Truncation rather than a substituted string
    // because it is what a partial write actually leaves — a prefix of the
    // document that was really there — and because keeping the row PRESENT is
    // the whole point. An absent draft row is an ordinary answer reconcile
    // already has words for; only a present one that will not parse reaches the
    // store's corruption error.
    raw.run(
      'UPDATE local_drafts SET data = substr(data, 1, 40) WHERE human_id = ? AND local_id = ?',
      [SESSION.human.id, corruptDraftId],
    )
    raw.close()

    store = openDirectStore({ dataDir })
    surface = surfaceOver(store)
  }, 60_000)

  afterAll(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
    fixture.dispose()
  })

  test('the edge answers a re-syncable not_found, not a corrupt daemon', () => {
    let thrown: unknown
    try {
      surface.getSnapshot(localId)
    } catch (err) {
      thrown = err
    }
    // The class IS the assertion. `StoreUnreadableError` and `ApiError` are
    // sibling subclasses of `Error`, and the transport maps only the former to
    // a 500 "your daemon is broken" — so pinning the type here is what
    // separates that answer from the honest "rebuild this" one. Restating it as
    // a `not.toBeInstanceOf(StoreUnreadableError)` would add nothing: with the
    // classes unrelated, that check cannot fail once this one passes.
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('not_found')
    expect((thrown as ApiError).message).toMatch(/re-sync/i)
  })

  test('reconcile meets the same absence and gives the same answer', () => {
    let fromReconcile: unknown
    try {
      surface.reconcileDraft(localId)
    } catch (err) {
      fromReconcile = err
    }
    expect(fromReconcile).toBeInstanceOf(ApiError)
    expect((fromReconcile as ApiError).code).toBe('not_found')
    expect((fromReconcile as ApiError).message).toMatch(/re-sync/i)

    // Pinned as a literal rather than left to the two legs agreeing with each
    // other, because reconcile has a `not_found` of its own — the one it raises
    // when the objects a draft's comments are anchored against are gone — and
    // that error also names re-syncing as the remedy. Code and remedy alone
    // therefore cannot tell the two apart. This phrase belongs only to the
    // translation of an unreadable store, so it is what makes the leg fail if
    // reconcile ever answers from somewhere else.
    expect((fromReconcile as ApiError).message).toMatch(/no longer in this data directory/i)

    // "The same answer", asserted rather than asserted about: the identical
    // message, because a reader who reaches this state through reconcile and a
    // reader who reaches it through opening the review are in the same state
    // and owe the same instruction.
    let fromSnapshot: unknown
    try {
      surface.getSnapshot(localId)
    } catch (err) {
      fromSnapshot = err
    }
    expect(fromSnapshot).toBeInstanceOf(ApiError)
    expect((fromReconcile as ApiError).message).toBe((fromSnapshot as ApiError).message)
  })

  test('the store itself still throws, which is what keeps it honest', () => {
    // The other half of the pair. If this ever returns instead of throwing, the
    // store has been taught to report a present-but-unreadable row as an absent
    // one, and the edge translation above would be papering over a real
    // corruption rather than naming a recoverable one.
    expect(() => store.getLocalSnapshot(localId)).toThrow(StoreUnreadableError)
  })

  test('a corrupt draft is never answered with the re-sync advice', () => {
    // The positive control, first, because every assertion after it is about
    // something NOT happening and an absence over a fixture that never reached
    // the failing state proves nothing at all. This read goes nowhere near
    // reconcile: it asks the store directly, and it can only throw if the row
    // is both present and unparseable — an absent row comes back `null` and a
    // repaired one comes back as a draft, so either would fail here rather than
    // sail through the assertions below.
    expect(() => store.getLocalDraft(SESSION.human.id, corruptDraftId)).toThrow(
      StoreUnreadableError,
    )

    let thrown: unknown
    try {
      surface.reconcileDraft(corruptDraftId)
    } catch (err) {
      thrown = err
    }

    // Asserted as what it IS before anything is asserted about what it is not.
    // `table` is what pins the failure to the draft read specifically: any
    // other read reconcile makes would name a different table, so this cannot
    // pass on a throw that came from somewhere else.
    expect(thrown).toBeInstanceOf(StoreUnreadableError)
    expect((thrown as StoreUnreadableError).table).toBe('local_drafts')

    // And what it must not be. `ApiError` is the shape the edge translation
    // mints, and reaching the transport as anything other than the store's own
    // error is what would turn a corrupt row into a `not_found` — a review the
    // operator is told to re-sync instead of a row they are told to repair.
    expect(thrown).not.toBeInstanceOf(ApiError)

    // The message's two claims, refused one at a time, because the wording is
    // the defect and the class alone would not catch a translation that kept
    // the type and copied the text. No sync reconstructs unsubmitted text from
    // a repository, so naming one is advice that cannot be followed; and the
    // reassurance that drafts were untouched is exactly inverted when the draft
    // is the damaged row.
    const message = (thrown as Error).message
    expect(message).not.toMatch(/re-sync/i)
    expect(message).not.toMatch(/drafts.*has been touched/i)
    expect(message).not.toMatch(/no longer in this data directory/i)
  })

  test('a re-sync rebuilds what was lost', () => {
    // The claim the message makes, asserted rather than promised. Without this,
    // the edge could tell every reader to re-sync while re-syncing fixed
    // nothing, and the answer would be actionable in wording only.
    //
    // Runs last on purpose: it repairs the state every assertion above depends
    // on.
    return surface.syncPull(localId).then((snapshot) => {
      expect(snapshot.immutable.files.length).toBeGreaterThan(0)
      expect(surface.getSnapshot(localId)).not.toBeNull()

      // The same promise, kept for the reader who met the absence through
      // reconcile: the remedy has to restore the verb they were running, not
      // merely the one that opens the review.
      const report = surface.reconcileDraft(localId)
      expect(report.prNumber).toBe(localId)
      expect(report.results.map((r) => r.comment.key)).toEqual([DRAFT_COMMENT_KEY])

      // And the message's other promise — that nothing written against the
      // review was touched. The draft is the irreplaceable half of that claim:
      // a snapshot can be rebuilt from the repository, unsubmitted text cannot
      // be rebuilt from anywhere.
      const draft = surface.getDraft(localId)
      expect(draft?.comments.map((c) => c.key)).toEqual([DRAFT_COMMENT_KEY])
    })
  })
})

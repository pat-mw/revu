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
    await surfaceOver(first).syncPull(localId)
    first.close()

    // The manoeuvre: the envelope survives, the immutable half it names does
    // not — exactly what a moved or partially restored data directory leaves
    // behind. Deleting the review's own row instead would be a different test,
    // because an absent review is already a clean answer.
    const raw = new Database(join(dataDir, 'direct.sqlite'))
    raw.run('DELETE FROM immutables')
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
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('not_found')
    expect((thrown as ApiError).message).toMatch(/re-sync/i)
    // Stated explicitly rather than left implied by the instanceof above: these
    // two classes are what separate "rebuild this" from "your daemon is
    // broken", and the transport maps only one of them to a 500.
    expect(thrown).not.toBeInstanceOf(StoreUnreadableError)
  })

  test('reconcile meets the same absence and gives the same answer', () => {
    let thrown: unknown
    try {
      surface.reconcileDraft(localId)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).not.toBeInstanceOf(StoreUnreadableError)
  })

  test('the store itself still throws, which is what keeps it honest', () => {
    // The other half of the pair. If this ever returns instead of throwing, the
    // store has been taught to report a present-but-unreadable row as an absent
    // one, and the edge translation above would be papering over a real
    // corruption rather than naming a recoverable one.
    expect(() => store.getLocalSnapshot(localId)).toThrow(StoreUnreadableError)
  })

  test('a re-sync rebuilds what was lost', () => {
    // The claim the message makes, asserted rather than promised. Without this,
    // the edge could tell every reader to re-sync while re-syncing fixed
    // nothing, and the answer would be actionable in wording only.
    return surface.syncPull(localId).then((snapshot) => {
      expect(snapshot.immutable.files.length).toBeGreaterThan(0)
      expect(surface.getSnapshot(localId)).not.toBeNull()
    })
  })
})

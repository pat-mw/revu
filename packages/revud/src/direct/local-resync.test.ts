/**
 * A local review whose branches have been deleted or renamed.
 *
 * This is ordinary, not exceptional: a branch gets merged and tidied away, or
 * renamed halfway through the work, and the review of it is still the only
 * place the reader's unsubmitted comments exist. So the failure has to be
 * *survivable* rather than merely typed. The sync refuses, and every stored
 * artifact — the review row, the draft, the threads, the last good snapshot —
 * has to still be there and still be readable afterwards.
 *
 * The state is derived rather than stored: a review is read-only exactly when
 * its last sync answered `ref_not_found`, which the daemon already returns as a
 * typed error. Nothing is written to record it, so there is no schema column to
 * drift and no second source of truth about whether a review still works.
 *
 * ## Why the tripwire is a runtime decorator and not a grep
 *
 * The rule this file protects is a negative — no failure path may delete a
 * stored row — and a source scan for `delete` proves a spelling, not a path. It
 * cannot see a deletion reached through a helper, a store passed to another
 * module, or a method resolved dynamically. The decorator below throws from
 * every deletion method on the real store and the whole failing walk is run
 * through it, so what is asserted is that the path did not delete, rather than
 * that this file does not contain the word. Its negative control is permanent
 * and sits in the same describe: a sibling calls a deletion method through the
 * same decorator and asserts it DOES throw, so a tripwire silently wired to
 * nothing is red rather than green.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '@revu/shared'
import type { PendingComment, ReviewDraft, ReviewThread, Session } from '@revu/shared'
import { createBunCommandRunner } from './command-runner'
import type { CommandRunner } from './command-runner'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { createLocalReviewSurface } from './local-surface'
import type { LocalReviewSurface } from './local-surface'
import type { DirectStore } from './store'
import { openDirectStore } from './store'

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

/** Every method on the store whose name marks it as a deletion. */
const DELETION_METHODS = ['deleteDraft', 'deleteLocalDraft'] as const

/**
 * Wraps a store so that any deletion method throws when called.
 *
 * Derived from the store's own key set rather than from the list above, so a
 * deletion method added to `DirectStore` later is armed automatically instead of
 * being missed by a list nobody remembered to extend. The list is kept only as
 * the assertion that the derivation found something — a decorator that armed
 * nothing would pass every test in this file.
 */
function refuseDeletions(store: DirectStore): { store: DirectStore; armed: string[] } {
  const armed: string[] = []
  const proxy = new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      if (!prop.startsWith('delete')) {
        return (...args: unknown[]): unknown =>
          (value as (...a: unknown[]) => unknown).apply(target, args)
      }
      return (): never => {
        throw new Error(`a sync failure must never call store.${prop}`)
      }
    },
  })
  for (const name of Object.keys(store)) {
    if (name.startsWith('delete')) armed.push(name)
  }
  return { store: proxy, armed: armed.sort() }
}

function pending(path: string, line: number, body: string): PendingComment {
  return {
    key: `resync-${path}-${line}`,
    path,
    side: 'RIGHT',
    start_side: null,
    line,
    start_line: null,
    body,
    createdAt: NOW,
    updatedAt: NOW,
    anchor: { lineText: '', contextBefore: [], contextAfter: [] },
  }
}

interface Harness {
  readonly fixture: FixtureRepo
  readonly store: DirectStore
  readonly surface: LocalReviewSurface
  readonly dataDir: string
  readonly localId: number
  readonly draftBefore: ReviewDraft
  readonly threadsBefore: ReviewThread[]
  /** A second surface over the same data, optionally through a decorated store. */
  surfaceOver(store: DirectStore): LocalReviewSurface
  dispose(): void
}

/**
 * A synced local review carrying a draft with three comments and one published
 * thread — the artifacts whose survival is the point of this file.
 */
async function seed(): Promise<Harness> {
  const fixture = await createFixtureRepo()
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-resync-'))
  const real = openDirectStore({ dataDir })
  const runner: CommandRunner = createBunCommandRunner()
  const surfaceOver = (store: DirectStore): LocalReviewSurface =>
    createLocalReviewSurface({
      store,
      runner,
      toplevel: fixture.dir,
      repo: REPO,
      session: SESSION,
      now: () => NOW,
    })
  const surface = surfaceOver(real)

  const review = await surface.createLocalReview({
    baseRef: fixture.baseBranch,
    headRef: fixture.headBranch,
  })
  const localId = review.id
  const snapshot = await surface.syncPull(localId)

  // A published thread first: submitting a review is what turns pending
  // comments into stored threads, and the walk needs at least one of each.
  await surface.submitReview({
    prNumber: localId,
    expectedHeadSha: snapshot.immutable.headSha,
    event: 'COMMENT',
    body: 'A published review on this branch pair.',
    comments: [pending(fixture.paths.modified, 2, 'published')],
  })

  // Then the draft, written after the submit so the submit cannot delete it —
  // a confirmed submit is the one event allowed to discard a draft.
  surface.saveDraft({
    humanId: SESSION.human.id,
    prNumber: localId,
    headSha: snapshot.immutable.headSha,
    compareKey: snapshot.immutable.compareKey,
    body: 'Unsubmitted text that must outlive the branch it was written against.',
    event: 'COMMENT',
    comments: [
      pending(fixture.paths.modified, 1, 'first'),
      pending(fixture.paths.modified, 2, 'second'),
      pending(fixture.paths.added, 1, 'third'),
    ],
    createdAt: NOW,
    updatedAt: NOW,
  })

  return {
    fixture,
    store: real,
    surface,
    dataDir,
    localId,
    draftBefore: surface.getDraft(localId) as ReviewDraft,
    threadsBefore: surface.listThreads(localId),
    surfaceOver,
    dispose(): void {
      real.close()
      rmSync(dataDir, { recursive: true, force: true })
      fixture.dispose()
    },
  }
}

/** Runs one git command inside the fixture, for the branch surgery below. */
async function git(fixture: FixtureRepo, args: string[]): Promise<void> {
  const runner = createBunCommandRunner()
  const result = await runner.run(['git', ...args], { cwd: fixture.dir })
  if (!result.ok) throw new Error(`fixture git failed: ${args.join(' ')} — ${result.stderr}`)
}

describe('a deleted head branch is survivable, not destructive', () => {
  let h: Harness

  beforeAll(async () => {
    h = await seed()
    // The head branch has to stop being the checked-out one before git will
    // delete it, and the review records a branch PAIR rather than a checkout,
    // so moving off it changes nothing the review depends on.
    await git(h.fixture, ['checkout', '-q', h.fixture.baseBranch])
    await git(h.fixture, ['branch', '-D', h.fixture.headBranch])
  }, 90_000)

  afterAll(() => h.dispose())

  test('the sync refuses with a typed answer naming the ref', async () => {
    let thrown: unknown
    try {
      await h.surface.syncPull(h.localId)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('not_found')
    expect((thrown as ApiError).message).toContain(h.fixture.headBranch)
  }, 30_000)

  test('the draft is byte-for-byte what it was', () => {
    expect(h.surface.getDraft(h.localId)).toStrictEqual(h.draftBefore)
  })

  test('the threads are unchanged', () => {
    expect(h.surface.listThreads(h.localId)).toStrictEqual(h.threadsBefore)
  })

  test('the last good snapshot still opens', () => {
    const snapshot = h.surface.getSnapshot(h.localId)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.immutable.files.length).toBeGreaterThan(0)
  })

  test('the review is still listed, so it can be read and deleted deliberately', () => {
    expect(h.surface.listLocalReviews().map((r) => r.id)).toContain(h.localId)
  })
})

describe('a renamed base branch is survivable too', () => {
  let h: Harness

  beforeAll(async () => {
    h = await seed()
    await git(h.fixture, ['branch', '-m', h.fixture.baseBranch, 'renamed-base'])
  }, 90_000)

  afterAll(() => h.dispose())

  test('the sync refuses and names the base ref', async () => {
    let thrown: unknown
    try {
      await h.surface.syncPull(h.localId)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).message).toContain(h.fixture.baseBranch)
  }, 30_000)

  test('nothing the reader wrote was touched', () => {
    expect(h.surface.getDraft(h.localId)).toStrictEqual(h.draftBefore)
    expect(h.surface.listThreads(h.localId)).toStrictEqual(h.threadsBefore)
    expect(h.surface.getSnapshot(h.localId)).not.toBeNull()
  })
})

describe('the deletion tripwire', () => {
  let h: Harness

  beforeAll(async () => {
    // Seeded through the REAL store, then the tripwire is armed only for the
    // failing sync. Arming it during setup would catch `submitReview` removing
    // the draft it just published — the one deletion the product allows, and
    // not a sync failure at all.
    h = await seed()
    await git(h.fixture, ['checkout', '-q', h.fixture.baseBranch])
    await git(h.fixture, ['branch', '-D', h.fixture.headBranch])
  }, 90_000)

  afterAll(() => h.dispose())

  test('the decorator arms at least the deletions the store declares', () => {
    // The derivation's own check. A proxy that matched nothing would let every
    // assertion in this describe pass while guarding literally nothing.
    const { armed } = refuseDeletions(h.store)
    for (const name of DELETION_METHODS) expect(armed).toContain(name)
  })

  test('the failing sync completes its refusal without deleting anything', async () => {
    // The refusal must be the typed range error, NOT the tripwire's own throw.
    // Those are different failures and only one of them is the behaviour under
    // test, so the class is asserted rather than merely "it threw".
    const guarded = h.surfaceOver(refuseDeletions(h.store).store)
    let thrown: unknown
    try {
      await guarded.syncPull(h.localId)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('not_found')
  }, 30_000)

  test('the negative control: the same decorator does refuse a real deletion', () => {
    // Without this, an armed-nothing proxy and a correctly-behaving sync are
    // indistinguishable — both produce a green run above.
    const { store } = refuseDeletions(h.store)
    expect(() => store.deleteLocalDraft(SESSION.human.id, h.localId)).toThrow(
      /must never call store\.deleteLocalDraft/,
    )
  })

  test('and the draft really is still there afterwards', () => {
    expect(h.surface.getDraft(h.localId)).toStrictEqual(h.draftBefore)
  })
})

describe('source corroboration, not the check', () => {
  test('the sync module contains no deletion call', () => {
    // Cheap corroboration alongside the runtime tripwire above, which is what
    // actually holds the rule. Kept because it fails earlier and more legibly
    // when someone reaches for a deletion while editing this module.
    const source = readFileSync(new URL('./local-sync.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\.delete[A-Z]/)
    // The scanner proving itself: the pattern fires on the construct it bans.
    expect('store.deleteLocalDraft(who, id)').toMatch(/\.delete[A-Z]/)
  })
})

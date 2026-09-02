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
import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '@revu/shared'
import type {
  LocalReviewSummary,
  PendingComment,
  ReviewDraft,
  ReviewThread,
  Session,
} from '@revu/shared'
import { createBunCommandRunner } from './command-runner'
import type { CommandResult, CommandRunner } from './command-runner'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { createLocalReviewSurface } from './local-surface'
import type { LocalReviewSurface, LocalSyncOutcome } from './local-surface'
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
 *
 * The runner and the clock are both overridable: a recording runner is how a
 * case observes whether git was asked anything at all, and a moving clock is
 * what makes "this timestamp did not change" an observation rather than a
 * comparison of two reads of one constant.
 */
async function seed(
  overrides: { runner?: CommandRunner; now?: () => string } = {},
): Promise<Harness> {
  const fixture = await createFixtureRepo()
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-resync-'))
  const real = openDirectStore({ dataDir })
  const runner: CommandRunner = overrides.runner ?? createBunCommandRunner()
  const now = overrides.now ?? ((): string => NOW)
  const surfaceOver = (store: DirectStore): LocalReviewSurface =>
    createLocalReviewSurface({
      store,
      runner,
      toplevel: fixture.dir,
      repo: REPO,
      session: SESSION,
      now,
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

// ————————————————————————————————————————————————————————————————————————————
// The base side is read live, and that is observable.
// ————————————————————————————————————————————————————————————————————————————

/**
 * Advances the base branch by absorbing a commit the head branch already
 * carries, leaving the head branch exactly where it was.
 *
 * A plain new commit on the base branch would not do. The reviewed range starts
 * at the merge base — the common ancestor of the two tips — and a commit the
 * head branch does not contain can never become one, so an advance along
 * unrelated work moves the base tip and nothing else. Only an advance that
 * brings in a commit the head already has moves the ancestor, which is the case
 * where reading the base side live is observable at all.
 *
 * The identity, signing and hook flags are passed for the same reason the
 * fixture passes them on every commit: a runner has no git identity, and a
 * developer machine has a signing key and hooks that this merge must not reach.
 */
async function absorbIntoBase(fixture: FixtureRepo, sha: string): Promise<void> {
  await git(fixture, ['checkout', '-q', fixture.baseBranch])
  await git(fixture, [
    '-c',
    'user.email=base-advance@revu.invalid',
    '-c',
    'user.name=Base Advance',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'merge',
    '-q',
    '--no-ff',
    '--no-edit',
    sha,
  ])
}

describe('an advancing base branch moves the compare key with the head standing still', () => {
  let h: Harness
  let headBefore = ''
  let headAfter = ''
  let compareKeyBefore = ''
  let compareKeyAfter = ''

  beforeAll(async () => {
    h = await seed()
    const before = h.surface.getSnapshot(h.localId)
    if (before === null) throw new Error('the seed did not store a snapshot')
    headBefore = before.immutable.headSha
    compareKeyBefore = before.immutable.compareKey

    // Only the base branch is touched between the two syncs.
    await absorbIntoBase(h.fixture, h.fixture.headCommitShas[0])

    const after = await h.surface.syncPull(h.localId)
    headAfter = after.immutable.headSha
    compareKeyAfter = after.immutable.compareKey
  }, 120_000)

  afterAll(() => h.dispose())

  test('the head is byte-identical and the compare key is not', () => {
    // Both halves or neither, because either one alone is satisfied by a bug. A
    // compare key frozen at whatever the first sync answered passes the
    // head-unchanged half; a compare key that moved only because the head moved
    // passes the differs half. Only the pair says the range was recomputed
    // against the base branch as it is now rather than as it was first seen.
    expect(headAfter).toBe(headBefore)
    expect(compareKeyAfter).not.toBe(compareKeyBefore)
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The pin, proved against a real collection.
// ————————————————————————————————————————————————————————————————————————————

/**
 * A runner that swallows `update-ref` and delegates everything else.
 *
 * The control for the survival walk. It disables pinning without editing the
 * module under test and without a break-and-revert dance, so both halves of the
 * pair live permanently in the gate: one asserts the objects survive, the other
 * asserts that without the pin they do not. A survival test with no such
 * control passes just as happily when the feature is absent — which is exactly
 * how this walk would fail to notice pinning being removed.
 *
 * It reports success rather than failure, because a failing pin is a different
 * scenario — asserted where the sync surface is tested — and would let the sync
 * take a visibly different path. Here the sync must believe it pinned.
 */
function unpinnedRunner(): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      if (args.includes('update-ref')) {
        return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '' })
      }
      return real.run(args, opts)
    },
  }
}

/**
 * Rewrites the head branch so the previously synced head becomes unreachable,
 * then collects hard.
 *
 * Both commands are mandatory and the order matters. `git gc --prune=now` on
 * its own keeps unreachable objects for two weeks via the reflog, so a walk
 * without the expiry collects nothing and passes whatever the pin does —
 * verified against real git while writing this. `--expire-unreachable=now` is
 * the half that actually drops the rewritten commit's entry.
 */
async function rewriteAndCollect(fixture: FixtureRepo): Promise<void> {
  await git(fixture, ['checkout', '-q', fixture.headBranch])
  await git(fixture, [
    '-c',
    'user.email=pin-fixture@revu.invalid',
    '-c',
    'user.name=Pin Fixture',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '--amend',
    '--no-edit',
  ])
  await git(fixture, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
  await git(fixture, ['gc', '--prune=now', '-q'])
}

/** `git cat-file -t <sha>` — the object's type, or null when it is gone. */
async function objectType(fixture: FixtureRepo, sha: string): Promise<string | null> {
  const runner = createBunCommandRunner()
  const result = await runner.run(['git', 'cat-file', '-t', sha], { cwd: fixture.dir })
  return result.ok ? result.stdout.trim() : null
}

describe('a pin keeps the reviewed objects through a collection', () => {
  let h: Harness
  let storedMergeBase = ''
  let storedHead = ''
  let storedBlobShas: string[] = []

  beforeAll(async () => {
    h = await seed()
    const stored = h.surface.getSnapshot(h.localId)
    if (stored === null) throw new Error('the seed did not store a snapshot')
    storedMergeBase = stored.immutable.mergeBaseSha
    storedHead = stored.immutable.headSha
    storedBlobShas = Object.values(stored.immutable.blobIndex).flatMap((entry) =>
      [entry.base, entry.head].filter((sha): sha is string => sha !== null),
    )
    await rewriteAndCollect(h.fixture)
  }, 120_000)

  afterAll(() => h.dispose())

  test('the walk actually has objects to assert over', () => {
    // Asserted before "every SHA survived", because an empty index satisfies
    // that vacuously and would make the whole survival claim meaningless.
    expect(storedBlobShas.length).toBeGreaterThan(0)
  })

  test('both ends of the stored range survive', async () => {
    expect(await objectType(h.fixture, storedMergeBase)).toBe('commit')
    expect(await objectType(h.fixture, storedHead)).toBe('commit')
  }, 30_000)

  test('every blob the stored snapshot indexes survives, on both sides', async () => {
    for (const sha of storedBlobShas) {
      expect(await objectType(h.fixture, sha)).not.toBeNull()
    }
  }, 60_000)
})

describe('without the pin, the same objects are collected — the control', () => {
  let h: Harness
  let storedHead = ''

  beforeAll(async () => {
    h = await seed({ runner: unpinnedRunner() })
    const stored = h.surface.getSnapshot(h.localId)
    if (stored === null) throw new Error('the seed did not store a snapshot')
    storedHead = stored.immutable.headSha
    await rewriteAndCollect(h.fixture)
  }, 120_000)

  afterAll(() => h.dispose())

  test('the previously synced head is gone', async () => {
    // The SPECIFIC red, named rather than "at least one assertion fails". A
    // reconcile-level check is not a reliable discriminator here: the freshly
    // synced compare is reachable either way, and the blob cache is
    // cache-forever, so a naive rebase-gc-reconcile walk passes with pinning
    // entirely absent.
    expect(await objectType(h.fixture, storedHead)).toBeNull()
  }, 30_000)
})

/**
 * A pending comment whose anchor text is read out of the blob the snapshot
 * actually indexes, so the classification below is answering a real question.
 *
 * An anchor with empty text is fine for tests that never classify, but here it
 * would make every comment unmatchable and the whole leg would assert that a
 * broken fixture produces broken results.
 */
function anchoredOn(
  store: DirectStore,
  blobSha: string,
  path: string,
  line: number,
): PendingComment | null {
  const blob = store.getBlob(blobSha)
  if (!blob || blob.binary) return null
  const lines = blob.content.split('\n')
  const text = lines[line - 1]
  if (text === undefined || text.length === 0) return null
  return {
    key: `anchored-${path}-${line}`,
    path,
    side: 'RIGHT',
    start_side: null,
    line,
    start_line: null,
    body: 'A note that must survive the branch being rewritten.',
    createdAt: NOW,
    updatedAt: NOW,
    anchor: {
      lineText: text,
      contextBefore: lines.slice(Math.max(0, line - 3), line - 1),
      contextAfter: lines.slice(line, line + 2),
    },
  }
}

describe('the product-level claim: comments survive a rewrite plus a collection', () => {
  let h: Harness
  let results: string[] = []
  let commentCount = 0

  beforeAll(async () => {
    h = await seed()
    const stored = h.surface.getSnapshot(h.localId)
    if (stored === null) throw new Error('the seed did not store a snapshot')

    // Anchors taken from the indexed head blobs of as many files as carry one.
    const comments: PendingComment[] = []
    for (const [path, entry] of Object.entries(stored.immutable.blobIndex)) {
      if (entry.head === null) continue
      const comment = anchoredOn(h.store, entry.head, path, 1)
      if (comment) comments.push(comment)
      if (comments.length === 3) break
    }
    commentCount = comments.length
    h.surface.saveDraft({
      humanId: SESSION.human.id,
      prNumber: h.localId,
      headSha: stored.immutable.headSha,
      compareKey: stored.immutable.compareKey,
      body: 'Draft across three files.',
      event: 'COMMENT',
      comments,
      createdAt: NOW,
      updatedAt: NOW,
    })

    await rewriteAndCollect(h.fixture)

    // Emptying the blob cache forces the local git tier to be the ONLY producer
    // of these bytes, the hosted tier being structurally absent from this path.
    //
    // Note what this leg is and is not. It is the PRODUCT claim — a reader's
    // comments survive a rewrite plus a collection — and it is deliberately not
    // the proof that pinning works: the freshly rewritten compare is reachable
    // whether or not anything was pinned, so this walk would pass with the
    // feature entirely absent. The pinned/unpinned object-survival pair above
    // is what discriminates; this is what the discrimination is FOR.
    const raw = new Database(join(h.dataDir, 'direct.sqlite'))
    raw.run('DELETE FROM blobs')
    raw.close()

    const resynced = await h.surface.syncPull(h.localId)
    expect(resynced.partial).toBeNull()
    results = h.surface.reconcileDraft(h.localId).results.map((r) => r.kind)
  }, 120_000)

  afterAll(() => h.dispose())

  test('the draft really carried comments to classify', () => {
    expect(commentCount).toBeGreaterThan(0)
    expect(results).toHaveLength(commentCount)
  })

  test('not one comment was reported lost', () => {
    // The product claim. Every comment is either still where it was or moved,
    // and none is reported gone — which is the answer a reader would have
    // acted on by discarding text the rewrite never actually removed.
    expect(results.filter((kind) => kind === 'lost')).toEqual([])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// An archived review freezes at its last sync.
// ————————————————————————————————————————————————————————————————————————————

/**
 * A runner that records every argv it is handed and delegates to real git.
 * Recording is the whole instrument here: the claim under test is that a
 * frozen sync asks git NOTHING, and only a list of what was asked can show an
 * empty stretch.
 */
function recordingRunner(sink: string[][]): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      sink.push([...args])
      return real.run(args, opts)
    },
  }
}

/**
 * A clock a case moves by hand between two syncs. A timestamp that must stand
 * still is then measured against a clock that demonstrably did not, which a
 * fixed clock cannot show — two reads of one constant agree whatever happened.
 */
function movingClock(): { now: () => string; tick: () => void } {
  let ticks = 0
  return {
    now: () => `2026-01-02T03:04:${String(5 + ticks).padStart(2, '0')}.000Z`,
    tick: () => {
      ticks += 1
    },
  }
}

/** The tip of one branch, read from git rather than remembered. */
async function tipOf(fixture: FixtureRepo, branch: string): Promise<string> {
  const runner = createBunCommandRunner()
  const result = await runner.run(['git', 'rev-parse', '--verify', branch], { cwd: fixture.dir })
  if (!result.ok) throw new Error(`fixture git failed: rev-parse ${branch} — ${result.stderr}`)
  return result.stdout.trim()
}

/** One more commit on the head branch, so a sync that read git would see a moved head. */
async function advanceHead(fixture: FixtureRepo): Promise<void> {
  await git(fixture, ['checkout', '-q', fixture.headBranch])
  writeFileSync(join(fixture.dir, 'advanced.txt'), 'work done after the pull request appeared\n')
  await git(fixture, ['add', '-A'])
  await git(fixture, [
    '-c',
    'user.email=head-advance@revu.invalid',
    '-c',
    'user.name=Head Advance',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    'advance the head after the archive',
  ])
}

/** The pull request the archived cases below are archived against. */
const SUPERSEDING_PR = 77

/**
 * Everything a frozen sync must leave where it was, read from the store and
 * the outcome in one comparable record.
 */
interface SyncEvidence {
  readonly outcome: LocalSyncOutcome
  readonly stored: string
  readonly row: LocalReviewSummary
  readonly immutables: number
  /** How many argv the runner had recorded when the sync began. */
  readonly gitCallsBefore: number
  /** How many it had recorded when the sync returned. */
  readonly gitCallsAfter: number
}

async function syncWithEvidence(h: Harness, sink: string[][]): Promise<SyncEvidence> {
  const gitCallsBefore = sink.length
  const outcome = await h.surface.syncLocalReview(h.localId)
  const row = h.store.getLocalReview(h.localId)
  if (row === null) throw new Error('the review row vanished during a sync')
  return {
    outcome,
    stored: JSON.stringify(h.store.getLocalSnapshot(h.localId)),
    row,
    immutables: h.store.listImmutableKeys().length,
    gitCallsBefore,
    gitCallsAfter: sink.length,
  }
}

describe('an archived review freezes at its last sync', () => {
  let h: Harness
  let clock: ReturnType<typeof movingClock>
  const sink: string[][] = []
  /** The first sync after the mark: git once more, so the snapshot catches up with the row. */
  let catchUp: SyncEvidence
  /** The sync after that, with the head moved in between. */
  let frozen: SyncEvidence
  let headBeforeMove = ''
  let headAfterMove = ''

  beforeAll(async () => {
    clock = movingClock()
    h = await seed({ runner: recordingRunner(sink), now: clock.now })
    h.store.markLocalReviewArchived(h.localId, SUPERSEDING_PR)

    clock.tick()
    catchUp = await syncWithEvidence(h, sink)

    headBeforeMove = await tipOf(h.fixture, h.fixture.headBranch)
    await advanceHead(h.fixture)
    headAfterMove = await tipOf(h.fixture, h.fixture.headBranch)

    clock.tick()
    frozen = await syncWithEvidence(h, sink)
  }, 120_000)

  afterAll(() => h.dispose())

  test('the sync that first sees the mark is not frozen, and stores a snapshot that says closed', () => {
    // The row and the snapshot agree from this sync on: the pull is synthesized
    // from the row's number, so the stored envelope now presents the review as
    // closed, and nothing later has to rewrite it.
    expect(catchUp.outcome.frozen).toBe(false)
    expect(catchUp.outcome.snapshot.mutable.pull.state).toBe('closed')
    expect(JSON.stringify(catchUp.outcome.snapshot)).toBe(catchUp.stored)
    expect(catchUp.gitCallsAfter).toBeGreaterThan(catchUp.gitCallsBefore)
  })

  test('the head really moved between the two syncs', () => {
    // The control for every "unchanged" below: had the second sync read git, it
    // would have found a different tip than the one the stored snapshot names.
    expect(headAfterMove).not.toBe(headBeforeMove)
    expect(catchUp.outcome.snapshot.immutable.headSha).toBe(headBeforeMove)
  })

  test('the next sync is frozen', () => {
    expect(frozen.outcome.frozen).toBe(true)
  })

  test('a frozen sync answers the stored snapshot byte for byte, and stores nothing new', () => {
    expect(JSON.stringify(frozen.outcome.snapshot)).toBe(catchUp.stored)
    expect(frozen.stored).toBe(catchUp.stored)
  })

  test('the compare key did not follow the head', () => {
    expect(frozen.outcome.snapshot.immutable.compareKey).toBe(
      catchUp.outcome.snapshot.immutable.compareKey,
    )
    expect(frozen.outcome.snapshot.immutable.headSha).toBe(headBeforeMove)
  })

  test('the row was not re-stamped: lastSyncedAt stands although the clock moved', () => {
    expect(frozen.row.lastSyncedAt).toBe(catchUp.row.lastSyncedAt)
    expect(frozen.row.headSha).toBe(catchUp.row.headSha)
    expect(frozen.row.updatedAt).toBe(catchUp.row.updatedAt)
    // The clock a re-stamp would have used reads differently from the stamp
    // that stands, so equality above is not two reads of one constant.
    expect(clock.now()).not.toBe(catchUp.row.lastSyncedAt)
  })

  test('no immutable half was minted', () => {
    expect(frozen.immutables).toBe(catchUp.immutables)
  })

  test('git was not run at all for the frozen sync', () => {
    expect(frozen.gitCallsAfter).toBe(frozen.gitCallsBefore)
  })

  test('a frozen sync attempted no pin, and says so rather than claiming one', () => {
    expect(frozen.outcome.pin).toBeNull()
  })
})

describe('the control: the same sequence with no mark keeps syncing', () => {
  let h: Harness
  let clock: ReturnType<typeof movingClock>
  const sink: string[][] = []
  let first: SyncEvidence
  let second: SyncEvidence
  let headAfterMove = ''

  beforeAll(async () => {
    clock = movingClock()
    h = await seed({ runner: recordingRunner(sink), now: clock.now })
    // No mark. Everything else is the archived sequence above, step for step.
    clock.tick()
    first = await syncWithEvidence(h, sink)
    await advanceHead(h.fixture)
    headAfterMove = await tipOf(h.fixture, h.fixture.headBranch)
    clock.tick()
    second = await syncWithEvidence(h, sink)
  }, 120_000)

  afterAll(() => h.dispose())

  test('a live review is never frozen', () => {
    expect(first.outcome.frozen).toBe(false)
    expect(second.outcome.frozen).toBe(false)
  })

  test('the second sync read git, followed the head, and re-stamped the row', () => {
    // Every quantity the frozen case holds still moves here, so each of those
    // assertions is known to be capable of failing.
    expect(second.gitCallsAfter).toBeGreaterThan(second.gitCallsBefore)
    expect(second.outcome.snapshot.immutable.headSha).toBe(headAfterMove)
    expect(second.outcome.snapshot.immutable.compareKey).not.toBe(
      first.outcome.snapshot.immutable.compareKey,
    )
    expect(second.stored).not.toBe(first.stored)
    expect(second.row.lastSyncedAt).not.toBe(first.row.lastSyncedAt)
    expect(second.immutables).toBe(first.immutables + 1)
    expect(second.outcome.snapshot.mutable.pull.state).toBe('open')
  })
})

describe('an archived review with no stored snapshot syncs once, then freezes', () => {
  // Unreachable through the daemon — a review is only ever archived by a sync
  // that goes on to store a snapshot — but reachable through a hand-edited
  // store, and a review with nothing to serve is worse than a frozen one.
  let fixture: FixtureRepo
  let store: DirectStore
  let localId = 0
  const sink: string[][] = []
  let first: LocalSyncOutcome
  let second: LocalSyncOutcome
  let storedAfterFirst = ''
  let gitCallsDuringSecond = 0

  beforeAll(async () => {
    fixture = await createFixtureRepo()
    store = openDirectStore({ dataDir: ':memory:' })
    const surface = createLocalReviewSurface({
      store,
      runner: recordingRunner(sink),
      toplevel: fixture.dir,
      repo: REPO,
      session: SESSION,
      now: () => NOW,
    })
    localId = (
      await surface.createLocalReview({ baseRef: fixture.baseBranch, headRef: fixture.headBranch })
    ).id
    store.markLocalReviewArchived(localId, SUPERSEDING_PR)

    first = await surface.syncLocalReview(localId)
    storedAfterFirst = JSON.stringify(store.getLocalSnapshot(localId))
    const before = sink.length
    second = await surface.syncLocalReview(localId)
    gitCallsDuringSecond = sink.length - before
  }, 120_000)

  afterAll(() => {
    store.close()
    fixture.dispose()
  })

  test('the review really was archived with nothing stored', () => {
    expect(store.getLocalReview(localId)?.archivedPr).toBe(SUPERSEDING_PR)
    // Read off the outcome rather than the store, which now holds the first
    // sync's envelope: the first sync could only have been a full one.
    expect(first.frozen).toBe(false)
  })

  test('the first sync stores a snapshot that already says closed', () => {
    expect(first.snapshot.mutable.pull.state).toBe('closed')
    expect(JSON.stringify(first.snapshot)).toBe(storedAfterFirst)
  })

  test('the second sync is frozen on what the first stored, and asks git nothing', () => {
    expect(second.frozen).toBe(true)
    expect(JSON.stringify(second.snapshot)).toBe(storedAfterFirst)
    expect(gitCallsDuringSecond).toBe(0)
  })
})

describe('an archived review whose stored content was lost syncs once to rebuild it, then freezes', () => {
  // The repair every snapshot read names — re-sync to rebuild — has to work on
  // an archived review too, or a lost immutable half would leave it permanently
  // unopenable behind a freeze that has nothing readable to serve.
  let h: Harness
  let lostRefusal = ''
  let rebuilt: LocalSyncOutcome
  let afterRebuild: LocalSyncOutcome

  beforeAll(async () => {
    h = await seed()
    h.store.markLocalReviewArchived(h.localId, SUPERSEDING_PR)
    await h.surface.syncLocalReview(h.localId)

    const raw = new Database(join(h.dataDir, 'direct.sqlite'))
    raw.run('DELETE FROM immutables')
    raw.close()

    try {
      h.surface.getSnapshot(h.localId)
    } catch (error) {
      lostRefusal = error instanceof ApiError ? error.code : 'untyped'
    }
    rebuilt = await h.surface.syncLocalReview(h.localId)
    afterRebuild = await h.surface.syncLocalReview(h.localId)
  }, 120_000)

  afterAll(() => h.dispose())

  test('the content really was lost: the snapshot read refused before the rebuild', () => {
    expect(lostRefusal).toBe('not_found')
  })

  test('the rebuild was a full sync that stored a closed snapshot the read now opens', () => {
    expect(rebuilt.frozen).toBe(false)
    expect(rebuilt.snapshot.mutable.pull.state).toBe('closed')
    expect(h.surface.getSnapshot(h.localId)?.immutable.compareKey).toBe(
      rebuilt.snapshot.immutable.compareKey,
    )
  })

  test('and the sync after the rebuild is frozen on it', () => {
    expect(afterRebuild.frozen).toBe(true)
    expect(JSON.stringify(afterRebuild.snapshot)).toBe(JSON.stringify(rebuilt.snapshot))
  })
})

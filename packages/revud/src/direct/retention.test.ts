/**
 * Retention: the one path that drops a local review's pinned refs, the one that
 * reclaims unreferenced halves of the content cache, and the structural guards
 * that keep either from growing a second tier.
 *
 * A local review's file blobs have no second source. The objects its snapshot
 * was read from live in exactly one object database, and a pin ref is what
 * keeps them there. Dropping those refs is therefore one of the two places in the
 * local path where retention can be lost, so the suite is organised around the
 * two ways a drop can be wrong:
 *
 *   1. **It deletes nothing while reporting success.** Reconstructing a ref name
 *      from a compare key produces `<mergeBase>...<head>`, which git refuses as a
 *      ref name outright — and a delete of a name that cannot exist exits zero.
 *      The fake-runner legs pin the exact argv, so a drop that never discovers
 *      anything is red rather than green.
 *   2. **It deletes and the objects stay pinned anyway, or were never pinned.**
 *      Only real git can answer that, so the last leg runs the whole story: pin,
 *      make the object unreachable, collect hard, prove it survived; then drop,
 *      collect again, prove it is gone. That turns "retention is an explicit
 *      delete rather than an accident of garbage collection" into an assertion.
 *
 * ## The cache sweep fails in one direction only
 *
 * The other place retention can be lost is the shared cache of immutable halves,
 * and its two mistakes are nothing like symmetric. Leaving an unreferenced half
 * behind costs disk; the next sweep takes it. Removing a half a live snapshot
 * still names makes that review UNOPENABLE, with no symptom until someone opens
 * it — the envelope survives intact, the table merely looks tidier, and the
 * assembling read then refuses outright. So the sweep legs are built around one
 * assertion, `expectEverySnapshotStillReadable`, which opens every snapshot in
 * both tables and requires that none of them refuses. Every sweep-shaped test
 * ends with it; a sweep test that did not would be measuring only what was
 * removed, which is the half of the story that never catches this.
 *
 * That assertion carries two controls of its own, because a sweep like it is
 * exactly the shape that passes while asserting nothing. It is run over an
 * untouched store, where it must be green, and over a store with one referenced
 * half removed by hand, where it must be red — and it refuses to pass at all
 * unless the fixture seeded a snapshot of each kind for it to open.
 *
 * The pair that pins "no expiry" is a separate leg and deliberately so: a live
 * half whose every recorded timestamp is years old survives, while an orphan
 * written moments earlier goes. Any predicate over row age, `created_at` or
 * `last_synced_at` reverses that pair, which is the only durable way to hold a
 * cache-forever rule against a later editor.
 *
 * ## Why a source scan sits in a behavioural suite
 *
 * Two of the module's constraints are negatives over every code path at once —
 * it may never reach GitHub, and it may never issue a database statement that
 * rewrites storage wholesale. No runtime test can enumerate those; the durable
 * form is that the vocabulary needed to write them does not appear in the
 * source. A module that cannot name a client cannot mis-call one.
 *
 * A source scan is worthless unless it is proved to bite, so every scan here
 * carries its own controls: each scanned file is asserted to read back
 * non-empty (an absent or empty file satisfies every absence assertion
 * trivially), the specifier extractor is run over a fixture that deliberately
 * imports the forbidden module, and each banned pattern is matched against a
 * probe containing the exact construct it forbids.
 *
 * One absence per test throughout: the runner abandons a test body at its first
 * failed expectation, so two absence assertions sharing a body leave the second
 * unfalsifiable.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { ReviewDraft, Snapshot, SnapshotImmutable } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { pinRefsFor, pinSnapshotObjects } from './local-pins'
import { dropPinnedRefs, pruneImmutables } from './retention'
import {
  openDirectStore,
  StoreUnreadableError,
  StoreWriteError,
  type DirectStore,
} from './store'

/** A local id inside the reserved local-review band. */
const LOCAL_ID = 1_000_000_001
/** A second one, so "the other review's pins survived" is assertable. */
const OTHER_LOCAL_ID = 1_000_000_002

/** Forty hex characters — the shape a resolved sha1 object name arrives in. */
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** The two ref names one synced compare of `LOCAL_ID` is pinned behind. */
const PINNED_BASE = `refs/revu/reviews/${LOCAL_ID}/${SHA_A}-${SHA_B}/base`
const PINNED_HEAD = `refs/revu/reviews/${LOCAL_ID}/${SHA_A}-${SHA_B}/head`

/** A directory that is never touched: every fake-runner leg only records argv. */
const CWD = '/repo'

/** One recorded invocation, as the runner seam presents it. */
interface RecordedCall {
  args: string[]
  cwd?: string
}

/**
 * A `CommandRunner` that records every argv and answers from a caller-supplied
 * reply. The sink is the evidence both for the legs that assert something *was*
 * spawned and for the legs that assert nothing was, so one recorder serves both
 * and an empty sink can never be confused with a sink wired to nothing.
 */
function recordingRunner(
  reply: (args: readonly string[]) => CommandResult = () => ({
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
  }),
): CommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    async run(args, opts) {
      calls.push({
        args: [...args],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      })
      return reply(args)
    },
  }
}

/** Answers a discovery command with the given refnames and everything else cleanly. */
function discoveryReturning(...refs: string[]): (args: readonly string[]) => CommandResult {
  const stdout = refs.map((ref) => `${ref}\n`).join('')
  return (args) => ({
    ok: true,
    code: 0,
    stdout: args.includes('for-each-ref') ? stdout : '',
    stderr: '',
  })
}

describe('the commands a drop spawns', () => {
  test('discovery is one hardened for-each-ref over the review prefix', async () => {
    const runner = recordingRunner()
    await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    // Spelled out whole rather than by `toContain`, so a dropped `--format` —
    // which would hand the parser git's unspecified default shape — is red, and
    // so is a dropped `--end-of-options`, without which the hardened seam
    // refuses to spawn at all and the drop silently deletes nothing.
    expect(runner.calls[0]?.args).toEqual([
      'git',
      'for-each-ref',
      '--format=%(refname)',
      '--end-of-options',
      `refs/revu/reviews/${LOCAL_ID}/`,
    ])
    expect(runner.calls[0]?.cwd).toBe(CWD)
  })

  test('each discovered ref is deleted, after discovery and in listing order', async () => {
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, PINNED_HEAD))
    await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['git', 'for-each-ref', '--format=%(refname)', '--end-of-options', `refs/revu/reviews/${LOCAL_ID}/`],
      ['git', 'update-ref', '-d', '--end-of-options', PINNED_BASE],
      ['git', 'update-ref', '-d', '--end-of-options', PINNED_HEAD],
    ])
  })

  test('every command carries the caller-supplied working directory', async () => {
    // Nothing here reads the process working directory, so a command that lost
    // its `cwd` would act on whatever repository the daemon happened to start in.
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, PINNED_HEAD))
    await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls.map((call) => call.cwd)).toEqual([CWD, CWD, CWD])
  })

  test('the count and the refnames report what was dropped', async () => {
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, PINNED_HEAD))
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(result).toEqual({ ok: true, count: 2, dropped: [PINNED_BASE, PINNED_HEAD] })
  })

  test('an unpinned namespace spawns nothing beyond discovery', async () => {
    // The two-ref leg above is this one's standing control: it proves the same
    // recorder can count past one, so "only discovery ran" is a fact about the
    // drop rather than about a sink that never fills.
    const runner = recordingRunner(discoveryReturning())
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls).toHaveLength(1)
    expect(result).toEqual({ ok: true, count: 0, dropped: [] })
  })
})

describe('a drop refuses before it spawns anything it should not', () => {
  test('an id outside the local review band is refused and nothing is spawned', async () => {
    // A pull request number is a positive integer too. Listing a forge-keyed id
    // under the local namespace would answer a clean zero and hide the mistake.
    const runner = recordingRunner()
    const result = await dropPinnedRefs({ runner, cwd: CWD }, 42)
    expect(runner.calls).toEqual([])
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-local-id',
      detail: '42 is not an id in the local review band',
      count: 0,
      dropped: [],
    })
  })

  test('a discovered name outside the prefix aborts before any deletion', async () => {
    // The one place text this module did not write reaches an argument slot. A
    // `refs/`-shaped foreign name passes the hardened-argv check on shape alone,
    // so the prefix is what stops a listing that went wrong from deleting a
    // branch. Checked across the whole listing first, so a bad name late in it
    // cannot be preceded by deletions that already happened.
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, 'refs/heads/main'))
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls).toHaveLength(1)
    expect(result).toEqual({
      ok: false,
      reason: 'unexpected-ref',
      detail: `refs/heads/main is not under refs/revu/reviews/${LOCAL_ID}/`,
      count: 0,
      dropped: [],
    })
  })

  test('a failing discovery is a result, never a throw', async () => {
    const runner = recordingRunner(() => ({
      ok: false,
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository\n',
    }))
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(result).toEqual({
      ok: false,
      reason: 'git-failed',
      detail: 'fatal: not a git repository',
      count: 0,
      dropped: [],
    })
  })

  test('a failing deletion is a result, and reports the refs already dropped', async () => {
    const runner = recordingRunner((args) => {
      if (args.includes('for-each-ref')) {
        return { ok: true, code: 0, stdout: `${PINNED_BASE}\n${PINNED_HEAD}\n`, stderr: '' }
      }
      if (args.includes(PINNED_HEAD)) {
        return { ok: false, code: 1, stdout: '', stderr: 'fatal: cannot lock ref\n' }
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    })
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(result).toEqual({
      ok: false,
      reason: 'git-failed',
      detail: 'fatal: cannot lock ref',
      count: 1,
      dropped: [PINNED_BASE],
    })
  })
})

/** The data directory each cache-sweep test gets to itself. */
let storeDir: string

/** The pull request every cache-sweep fixture is seeded around. */
const SEEDED_PR = 204

/** The comparison the seeded pull request's snapshot currently references. */
const LIVE_PR_KEY = 'A...B'
/** The comparison the seeded local review's snapshot currently references. */
const LIVE_LOCAL_KEY = 'C...D'
/** The half left behind by the pull request's previous comparison. */
const ORPHAN_PR_KEY = 'A...old'
/** The half left behind by the local review's previous comparison. */
const ORPHAN_LOCAL_KEY = 'C...old'

/**
 * A timestamp years before every other date in this file, used wherever a test
 * has to make a row old. Nothing in the sweep reads it; that is the point.
 */
const LONG_AGO = '2019-03-04T05:06:07.000Z'

/** A store over the per-test data directory. */
function openStore(): DirectStore {
  return openDirectStore({ dataDir: storeDir })
}

/** The immutable half of one comparison, with just enough shape to be stored. */
function immutableHalf(compareKey: string): SnapshotImmutable {
  return {
    compareKey,
    mergeBaseSha: 'merge-base',
    headSha: 'head',
    files: [
      {
        sha: 'headblob',
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1 +1 @@',
      },
    ],
    blobIndex: { 'a.ts': { base: 'baseblob', head: 'headblob' } },
    commits: [],
  }
}

/**
 * A whole snapshot over one comparison. `syncedAt` is a parameter because the
 * pair that pins "no expiry" needs a live snapshot whose own timestamp is years
 * stale, and a fixture that hard-coded one date could not express it.
 */
function storedSnapshot(
  id: number,
  compareKey: string,
  syncedAt = '2026-01-01T00:00:00.000Z',
): Snapshot {
  return {
    prNumber: id,
    syncedAt,
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 0 },
    immutable: immutableHalf(compareKey),
    mutable: {
      fetchedAt: syncedAt,
      pull: { number: id } as Snapshot['mutable']['pull'],
      threads: [],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

/** An unsubmitted draft, the one piece of state no reclamation may ever reach. */
function unsubmittedDraft(humanId: string, id: number, body: string): ReviewDraft {
  return {
    humanId,
    prNumber: id,
    headSha: 'head',
    compareKey: 'merge-base...head',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Seed one pull-request snapshot, one local review with a snapshot of its own,
 * and the two halves their previous comparisons left behind.
 *
 * Both kinds of review, because the immutable cache is shared between them and a
 * sweep that consulted only one table would report the other's live halves as
 * referenced by nothing. Two orphans rather than one, because a sweep that stops
 * after its first delete still empties a single-orphan fixture.
 */
function seedTwoLiveAndTwoOrphans(store: DirectStore): number {
  store.putSnapshot(storedSnapshot(SEEDED_PR, LIVE_PR_KEY))
  const localId = store.createLocalReview({
    repo: 'acme/widgets',
    baseRef: 'refs/heads/main',
    headRef: 'refs/heads/feature/x',
    title: 'feature/x',
  }).id
  store.putLocalSnapshot(storedSnapshot(localId, LIVE_LOCAL_KEY))
  store.putImmutable(immutableHalf(ORPHAN_PR_KEY))
  store.putImmutable(immutableHalf(ORPHAN_LOCAL_KEY))
  return localId
}

/**
 * How many rows the immutable cache holds, counted through a handle of its own.
 *
 * Raw rather than through `listImmutableKeys`, because a sweep and a read of the
 * same table that went wrong the same way would agree with each other. The count
 * is the independent witness.
 */
function immutableRowCount(): number {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const row = raw.query('SELECT COUNT(*) AS n FROM immutables').get() as { n: number }
  raw.close()
  return row.n
}

/** One snapshot table's stored envelope bytes, exactly as they sit on disk. */
function readEnvelope(table: string, column: string, key: number): string {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const row = raw.query(`SELECT data FROM ${table} WHERE ${column} = ?`).get(key) as {
    data: string
  }
  raw.close()
  return row.data
}

/** Replace one snapshot table's stored envelope with the given bytes. */
function writeEnvelope(table: string, column: string, key: number, data: string): void {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  raw.run(`UPDATE ${table} SET data = ? WHERE ${column} = ?`, [data, key])
  raw.close()
}

/**
 * The three tables whose integer key is a real GitHub pull-request number. A
 * reclamation driven by the local path may read them and may never write them.
 */
const PR_KEYED_TABLES = ['snapshots', 'audit_log', 'pr_author'] as const

/**
 * Arm an aborting trigger over every write event of the pull-request keyspace
 * and hand back a freshly opened store.
 *
 * Every event rather than just `DELETE`, because the forbidden thing is any
 * write at all: an `UPDATE` that blanked an envelope and an `INSERT` that
 * fabricated one are as far outside the local path's standing as a removal, and
 * the journal in particular is append-only with no removal counterpart by
 * design.
 */
function armPrKeyedTripwires(store: DirectStore): DirectStore {
  store.close()
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  for (const table of PR_KEYED_TABLES) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      raw.run(
        `CREATE TRIGGER tripwire_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} ` +
          `BEGIN SELECT RAISE(ABORT, 'refused: ${event} on ${table}'); END`,
      )
    }
  }
  raw.close()
  return openStore()
}

/**
 * Prove the armed tripwires really bite, by issuing the write they forbid.
 *
 * Without this, "the sweep wrote no pull-request table" would pass just as
 * cleanly over triggers that were never created, created on another table, or
 * created against an event nothing raises.
 */
function expectPrSnapshotWritesRefused(): void {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  try {
    expect(() => raw.run('DELETE FROM snapshots WHERE pr_number = ?', [SEEDED_PR])).toThrow()
    expect(() => raw.run("UPDATE snapshots SET data = '{}' WHERE pr_number = ?", [SEEDED_PR])).toThrow()
  } finally {
    raw.close()
  }
}

/**
 * Opens every snapshot the store holds and asserts that not one of them refuses.
 *
 * This is the acceptance test the whole sweep exists to satisfy, and it is an
 * acceptance test only while EVERY sweep-shaped test below ends with it. The
 * failure it catches has no other symptom: a removed half leaves the envelope
 * that references it perfectly intact, so the table looks tidier and the store
 * looks fine, and the damage surfaces only when someone opens the review — at
 * which point the assembling read finds no immutable half and refuses outright.
 * A review that will not open is not a degraded review, and on the local path it
 * is not a re-syncable one either: the comparison was computed from one clone,
 * and a branch rewritten since no longer holds the commits its key names.
 *
 * The two counts are the control. A store holding no snapshots satisfies
 * "nothing threw" without opening anything, which is precisely how a sweep like
 * this passes while asserting nothing — so every fixture is required to have
 * seeded at least one snapshot of each kind, and the loops below are required to
 * have something to loop over.
 *
 * Read raw rather than through the store, because the store's own enumerations
 * go through the review row: a listing cannot show a snapshot whose review is
 * gone, and it is exactly the rows nothing lists that a reclamation strands.
 */
function expectEverySnapshotStillReadable(store: DirectStore): void {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const prNumbers = (
    raw.query('SELECT pr_number FROM snapshots ORDER BY pr_number ASC').all() as {
      pr_number: number
    }[]
  ).map((row) => row.pr_number)
  const localIds = (
    raw.query('SELECT local_id FROM local_snapshots ORDER BY local_id ASC').all() as {
      local_id: number
    }[]
  ).map((row) => row.local_id)
  raw.close()

  expect(prNumbers.length).toBeGreaterThan(0)
  expect(localIds.length).toBeGreaterThan(0)

  for (const prNumber of prNumbers) {
    expect(() => store.getSnapshot(prNumber)).not.toThrow()
    expect(store.getSnapshot(prNumber)).not.toBeNull()
  }
  for (const localId of localIds) {
    expect(() => store.getLocalSnapshot(localId)).not.toThrow()
    expect(store.getLocalSnapshot(localId)).not.toBeNull()
  }
}

describe('the readable-snapshot sweep is a live assertion before anything is swept', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('an untouched store passes the sweep', () => {
    // The sweep's own baseline: seeded and never reclaimed, every snapshot
    // opens. Without this, a red further down could be the sweep being wrong
    // about a healthy store rather than the reclamation being wrong about it.
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('the sweep fails when a half a live snapshot names is taken away', () => {
    // And the sweep proved to bite, against the exact damage it exists to catch:
    // one referenced half removed by hand, with the envelope left alone. An
    // assertion that never fails is not an assertion, and this is the failure the
    // whole module is built to prevent.
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    store.close()

    const raw = new Database(join(storeDir, 'direct.sqlite'))
    raw.run('DELETE FROM immutables WHERE compare_key = ?', [LIVE_PR_KEY])
    raw.close()

    const reopened = openStore()
    expect(() => expectEverySnapshotStillReadable(reopened)).toThrow()
    // The class as well as the throw: an unreadable store is what the daemon
    // reports as a failed persist, and any other error arriving from the same
    // read would be reported as something else entirely.
    expect(() => reopened.getSnapshot(SEEDED_PR)).toThrow(StoreUnreadableError)
    reopened.close()
  })
})

describe('sweeping the immutable cache by reference', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('every snapshot the store holds is still readable after a sweep', () => {
    // The load-bearing leg. Every other assertion in this block is about what
    // the sweep removed; this one is about what it must not have, and it is the
    // only one that fails when the live set is computed from one snapshot table
    // instead of both — a shape in which the sweep still reports a plausible
    // count while a pull request's half is gone and its review will not open.
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    pruneImmutables(store)
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('both unreferenced halves go and both referenced halves stay', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    // Pinned before the sweep, so the count after it is against rows that
    // demonstrably existed rather than against a table that was short all along.
    expect(immutableRowCount()).toBe(4)

    const result = pruneImmutables(store)

    expect(result.count).toBe(2)
    expect(immutableRowCount()).toBe(2)
    // Which two, not merely how many: a sweep that removed one orphan and one
    // live half also leaves two rows behind and also reports two removed.
    expect(store.listImmutableKeys()).toEqual([LIVE_PR_KEY, LIVE_LOCAL_KEY])
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('the sweep names the halves it removed', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)

    const result = pruneImmutables(store)

    // The report is what a caller reconciling its own view of the cache acts
    // on, so it names rows rather than counting them.
    expect(result.removed).toEqual([ORPHAN_PR_KEY, ORPHAN_LOCAL_KEY])
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('a second sweep over an already-swept store removes nothing', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    expect(pruneImmutables(store).count).toBe(2)

    // Idempotent, because a reclamation that ran once has to be safe to run
    // again: there is no state saying which keys were already considered, and
    // "already gone" is the outcome the caller asked for.
    expect(pruneImmutables(store)).toEqual({ count: 0, removed: [] })
    expect(immutableRowCount()).toBe(2)
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('a half stale by years survives while an orphan written moments ago is removed', () => {
    // The hard constraint made executable. Every timestamp this store records
    // about the live half is years in the past — the snapshot's own `syncedAt`
    // and the review's `last_synced_at` — while the orphan is written last and
    // is therefore the newest row in the table by every ordering the storage
    // engine could offer. An age predicate of any kind reverses this pair.
    const store = openStore()
    store.putSnapshot(storedSnapshot(SEEDED_PR, LIVE_PR_KEY, LONG_AGO))
    const localId = store.createLocalReview({
      repo: 'acme/widgets',
      baseRef: 'refs/heads/main',
      headRef: 'refs/heads/feature/x',
      title: 'feature/x',
    }).id
    store.putLocalSnapshot(storedSnapshot(localId, LIVE_LOCAL_KEY, LONG_AGO))
    store.patchLocalReviewSync(localId, {
      baseSha: 'C',
      mergeBaseSha: 'C',
      headSha: 'D',
      dirty: false,
      lastSyncedAt: LONG_AGO,
    })
    store.putImmutable(immutableHalf(ORPHAN_LOCAL_KEY))

    const result = pruneImmutables(store)

    expect(result.removed).toEqual([ORPHAN_LOCAL_KEY])
    expect(store.listImmutableKeys()).toEqual([LIVE_PR_KEY, LIVE_LOCAL_KEY])
    // Read back rather than assumed: the pair says nothing about expiry unless
    // the surviving half really is the stale one.
    expect(store.getLocalReview(localId)?.lastSyncedAt).toBe(LONG_AGO)
    expect(store.getLocalSnapshot(localId)?.syncedAt).toBe(LONG_AGO)
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('an unparseable snapshot envelope aborts the sweep with every row intact', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    store.close()

    const original = readEnvelope('snapshots', 'pr_number', SEEDED_PR)
    writeEnvelope('snapshots', 'pr_number', SEEDED_PR, 'not json')

    const reopened = openStore()
    expect(() => pruneImmutables(reopened)).toThrow(StoreUnreadableError)
    // Not merely that it threw. A row that cannot be parsed names no key, and a
    // sweep that treated it as naming none would turn every half it really
    // referenced into a candidate — so the count is what says the refusal
    // happened before any statement ran, not part-way through them.
    expect(immutableRowCount()).toBe(4)
    reopened.close()

    // Repaired, so the sweep can speak for what it did to the OTHER rows: if the
    // aborted attempt had removed anything on its way to the refusal, a snapshot
    // here would refuse too.
    writeEnvelope('snapshots', 'pr_number', SEEDED_PR, original)
    const repaired = openStore()
    expectEverySnapshotStillReadable(repaired)
    repaired.close()
  })

  test('a refused delete rolls the whole sweep back, leaving all four rows', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    store.close()

    // Refuses the SECOND of the two candidates, so the first has already been
    // deleted inside the transaction when the abort arrives. A count of three
    // afterwards is a sweep that is not one transaction; a count of four is the
    // rollback. The literal is independent of anything the sweep computes.
    const raw = new Database(join(storeDir, 'direct.sqlite'))
    raw.run(
      'CREATE TRIGGER refuse_one_delete BEFORE DELETE ON immutables ' +
        `WHEN OLD.compare_key = '${ORPHAN_LOCAL_KEY}' ` +
        "BEGIN SELECT RAISE(ABORT, 'refused: this row is not to be removed'); END",
    )
    raw.close()

    const reopened = openStore()
    // A persist that failed is never swallowed into a success that removed part
    // of what it named.
    expect(() => pruneImmutables(reopened)).toThrow(StoreWriteError)
    expect(immutableRowCount()).toBe(4)
    expectEverySnapshotStillReadable(reopened)
    reopened.close()
  })

  test('no draft is touched by a sweep, local or pull-request', () => {
    const store = openStore()
    const localId = seedTwoLiveAndTwoOrphans(store)
    store.putLocalDraft(unsubmittedDraft('h1', localId, 'unsubmitted local text'))
    store.putDraft(unsubmittedDraft('h1', SEEDED_PR, 'unsubmitted pull request text'))

    expect(pruneImmutables(store).count).toBe(2)

    // Unsubmitted text is the one thing in this store that cannot be recomputed
    // from anywhere, so a reclamation that reached it would be destroying the
    // only copy of a human's work to recover cache space.
    expect(store.getLocalDraft('h1', localId)?.body).toBe('unsubmitted local text')
    expect(store.getDraft('h1', SEEDED_PR)?.body).toBe('unsubmitted pull request text')
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('the sweep reads the pull-request tables and writes none of them', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    const armed = armPrKeyedTripwires(store)

    // The live set is built by READING `snapshots`, which is required — a set
    // that skipped it would report the pull request's half as unreferenced. What
    // is forbidden is writing there, and the tripwires guard every write event.
    const result = pruneImmutables(armed)

    expect(result.removed).toEqual([ORPHAN_PR_KEY, ORPHAN_LOCAL_KEY])
    // The control for the assertion above: a tripwire that was never installed,
    // or installed on the wrong table, would let the sweep pass without
    // guarding anything.
    expectPrSnapshotWritesRefused()
    expectEverySnapshotStillReadable(armed)
    armed.close()
  })
})

/**
 * The modules the source scan reads. Retention is scanned for everything; the
 * direct store joins it only for the storage-statement ban, because the two
 * modules together are the whole of what a drop could touch.
 */
const RETENTION_MODULE = 'retention.ts'
const STORE_MODULE = 'store.ts'

/**
 * Reads a scanned module, failing loudly when it is not there. `readFileSync`
 * would throw too, but the message matters: an absent module means the scan has
 * nothing to examine, and that is the failure mode these guards exist to
 * prevent.
 */
function readScanned(module: string): string {
  const url = new URL(`./${module}`, import.meta.url)
  if (!existsSync(url)) {
    throw new Error(
      `${module} does not exist, so this guard has nothing to scan — that is a failure, not a pass`,
    )
  }
  return readFileSync(url, 'utf8')
}

/**
 * Matches a module specifier in an import statement that has a source clause,
 * anchored at the start of a line so a specifier-shaped string inside prose or
 * inside a call cannot be mistaken for a dependency. The lazy span between the
 * keyword and its `from` clause is what carries a multi-line named-import list.
 */
const IMPORT_WITH_SOURCE = /^import\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm

/** Matches a side-effect import, which has no `from` clause to find. */
const SIDE_EFFECT_IMPORT = /^import\s+['"]([^'"]+)['"]/gm

/**
 * Every module specifier a source depends on, type-only ones included.
 * `verbatimModuleSyntax` means a type import is written exactly like a value
 * import and erased only at emit, so excluding it would leave the one spelling
 * that can name a client type without tripping the guard.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of [IMPORT_WITH_SOURCE, SIDE_EFFECT_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.push(specifier)
    }
  }
  return found
}

/** The trailing path segment of a specifier, which is where a module is named. */
function specifierBasename(specifier: string): string {
  const at = specifier.lastIndexOf('/')
  return at === -1 ? specifier : specifier.slice(at + 1)
}

/**
 * Everything retention is allowed to depend on.
 *
 * A subset rule rather than an exact set, because the module does not use every
 * entry at every moment: the store import arrived only once retention had stored
 * state to reconcile against, and an exact-set assertion would have been red in
 * the interval for no reason. What the rule actually forbids is the arrival of a
 * *new kind* of dependency — a network tier, an SDK, a second command seam — and
 * a subset rule catches that the moment it lands.
 *
 * `./store` is here because the cache sweep reasons about rows it must never
 * reach for itself. It reads two key sets through the store surface and hands
 * back candidates; the deletes, the transaction they share and the durability
 * wrapper around them all stay behind that seam, so there is no second statement
 * anywhere that can remove a cached half.
 *
 * `./local-git` is here because it owns the hardened argv form: it is the only
 * module that assembles a git command, places rev operands behind
 * `--end-of-options`, and refuses to spawn an argv that fails that check.
 * Reaching the runner directly to avoid the dependency would mean re-deriving
 * that hardening in a second place. `@revu/shared` is here for the local-id
 * band predicate, so retention decides what an id is by the same rule the pin
 * writer does rather than by a second, drifting copy.
 */
const ALLOWED_SPECIFIERS = ['./store', './command-runner', './local-git', '@revu/shared'] as const

/** A source-shaped fixture whose only purpose is to prove the extractor reports. */
const IMPORT_FIXTURE = [
  "import type { GithubClient } from './github-client'",
  "import { openDirectStore } from './store'",
  'import {',
  '  runGit,',
  "} from './local-git'",
  "import './side-effect-only'",
].join('\n')

interface BannedConstruct {
  /** How a failure names the thing that was found. */
  readonly label: string
  readonly pattern: RegExp
  /** Source-shaped text carrying the construct, so the pattern is proved to fire. */
  readonly probe: string
}

/**
 * Constructs whose presence in retention's source would contradict one of its
 * stated constraints.
 *
 * The spawn primitive is banned because retention runs commands through the
 * injected runner seam and nothing else; a direct spawn would bypass both the
 * argv hardening and every test's ability to observe what was run. The two
 * network spellings are banned because the local path has no second source to
 * reach for — that absence is the whole reason pins exist. The tracking-id
 * shape is banned because a comment in this codebase describes the code and its
 * constraints and never a ticket, a milestone or a numbered unit of work; the
 * rule is otherwise a convention nobody can enforce by reading.
 */
const BANNED: readonly BannedConstruct[] = [
  {
    label: 'a direct process spawn',
    pattern: /Bun\.spawn/,
    probe: "const proc = Bun.spawn(['git', 'update-ref'])",
  },
  {
    label: 'a network call',
    pattern: /fetch\(/,
    probe: 'const res = await fetch(url)',
  },
  {
    label: 'an absolute web address',
    pattern: /https:\/\//,
    probe: "const base = 'https://api.github.com'",
  },
  {
    label: 'a tracking id',
    pattern: /\bM\d+(\.\d+)+\b/,
    probe: ' * Landed as part of M8.8, see the board.',
  },
]

/**
 * A storage-wide rewrite, matched in its statement form: a quote opening a SQL
 * string, then the keyword. Matching the bare word instead would make a comment
 * explaining why the statement is banned trip its own scan, and a guard that
 * cannot be written about is a guard nobody documents.
 *
 * It is banned because it rewrites the database file in place. A local review's
 * pins are refs in a git object database rather than rows, so a storage rewrite
 * can never be part of dropping them — and reaching for one here would couple
 * ref eviction to a whole-file operation that blocks every reader.
 */
const QUOTED_STORAGE_REWRITE = /['"`]\s*VACUUM\b/i

describe('the scanned sources are present to be scanned', () => {
  for (const module of [RETENTION_MODULE, STORE_MODULE]) {
    test(`${module} exists`, () => {
      expect(existsSync(new URL(`./${module}`, import.meta.url))).toBe(true)
    })

    test(`${module} has source text to scan`, () => {
      // A present-but-empty file satisfies every absence assertion below, so
      // this is the self-check that keeps the whole scan from going vacuous.
      expect(readScanned(module).length).toBeGreaterThan(0)
    })
  }
})

describe('the specifier extractor reports what it is asked to find', () => {
  test('it reports a forbidden specifier present in a fixture', () => {
    // Without this the allowlist assertion below would pass over an extractor
    // that reports nothing at all, which is the shape a source scan fails in.
    expect(importSpecifiers(IMPORT_FIXTURE)).toContain('./github-client')
  })

  test('it reports every specifier in the fixture, multi-line and bare alike', () => {
    expect(importSpecifiers(IMPORT_FIXTURE).sort()).toEqual([
      './github-client',
      './local-git',
      './side-effect-only',
      './store',
    ])
  })
})

describe('retention depends on nothing but the store and the command seam', () => {
  test('every specifier is drawn from the allowlist', () => {
    const specifiers = importSpecifiers(readScanned(RETENTION_MODULE))
    const foreign = specifiers.filter(
      (specifier) => !ALLOWED_SPECIFIERS.includes(specifier as (typeof ALLOWED_SPECIFIERS)[number]),
    )
    expect(foreign).toEqual([])
  })

  test('nothing resolves to the GitHub client module', () => {
    expect(importSpecifiers(readScanned(RETENTION_MODULE))).not.toContain('./github-client')
  })

  test('no specifier names GitHub at all', () => {
    const named = importSpecifiers(readScanned(RETENTION_MODULE)).filter((specifier) =>
      specifierBasename(specifier).toLowerCase().includes('github'),
    )
    expect(named).toEqual([])
  })
})

describe('retention names no way to leave the local machine', () => {
  for (const banned of BANNED) {
    test(`the source contains no ${banned.label}`, () => {
      expect(readScanned(RETENTION_MODULE)).not.toMatch(banned.pattern)
    })

    test(`${banned.label} is matched in a source-shaped probe`, () => {
      // A pattern that matches nothing anywhere never objects to what it
      // forbids, so each one is proved live against the construct itself.
      expect(banned.probe).toMatch(banned.pattern)
    })
  }

  test('the ban list has four members', () => {
    // An independent literal rather than a count derived from the list, so
    // dropping a member is red here even though every other assertion passes.
    expect(BANNED).toHaveLength(4)
  })
})

describe('no storage-wide rewrite reaches either module', () => {
  for (const module of [RETENTION_MODULE, STORE_MODULE]) {
    test(`${module} contains no quoted storage rewrite`, () => {
      expect(readScanned(module)).not.toMatch(QUOTED_STORAGE_REWRITE)
    })
  }

  test('the statement form is matched where it would really be written', () => {
    expect("db.exec('VACUUM')").toMatch(QUOTED_STORAGE_REWRITE)
  })

  test('prose naming the banned statement does not trip the scan', () => {
    // The reason the pattern is the statement form and not the bare keyword:
    // the documentation of a ban must be able to name what it bans.
    expect(' * A whole-file VACUUM is never part of dropping a ref.').not.toMatch(
      QUOTED_STORAGE_REWRITE,
    )
  })
})

/** The review whose pins the retention story is told against. */
const RETENTION_ID = 1_000_000_003

/**
 * The identity and hook flags every fixture commit is made under.
 *
 * A runner has no global git identity and `git commit` fails outright without
 * one, while a developer machine has a signing key and a hooks path that would
 * otherwise decide whether this gate is green. Pinned here so the fixture
 * behaves the same in both places.
 */
const IDENTITY = [
  '-c',
  'user.email=retention-fixture@revu.invalid',
  '-c',
  'user.name=Retention Fixture',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
] as const

/**
 * Wraps a runner so every invocation is recorded and then really run. The
 * fake-runner legs prove which commands a drop *would* spawn; this proves the
 * same about a drop that actually reached git, which is what makes "the second
 * drop spawned only a discovery" a claim about real behaviour.
 */
function countingRunner(inner: CommandRunner): CommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    async run(args, opts) {
      calls.push({
        args: [...args],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      })
      return inner.run(args, opts)
    },
  }
}

describe('against a real repository', () => {
  let dir: string
  let shaOne: string
  let shaTwo: string
  let doomed: string
  let priorGlobalConfig: string | undefined
  let priorSystemConfig: string | undefined
  const runner = createBunCommandRunner()

  /** Runs one git command inside the fixture. Never against the working clone. */
  async function git(args: readonly string[]): Promise<CommandResult> {
    return runner.run(['git', ...args], { cwd: dir })
  }

  /** Runs a seeding command and refuses to continue if it failed. */
  async function seed(args: readonly string[]): Promise<string> {
    const result = await git(args)
    if (!result.ok) {
      throw new Error(
        `retention fixture seeding failed: \`git ${args.join(' ')}\` exited ${result.code}: ${result.stderr.trim()}`,
      )
    }
    return result.stdout.trim()
  }

  /** Commits nothing and answers the object name of the commit it made. */
  async function commit(message: string): Promise<string> {
    await seed([...IDENTITY, 'commit', '-q', '--allow-empty', '-m', message])
    return seed(['rev-parse', 'HEAD'])
  }

  /** Every ref currently under one review's prefix, newline-joined and trimmed. */
  async function listing(localId: number): Promise<string> {
    const result = await git([
      'for-each-ref',
      '--format=%(refname)',
      `refs/revu/reviews/${localId}/`,
    ])
    return result.stdout.trim()
  }

  /** Expires every reflog and collects hard, so only refs keep an object alive. */
  async function collect(): Promise<void> {
    await seed(['reflog', 'expire', '--expire=now', '--all'])
    await seed(['gc', '--prune=now', '-q'])
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-retention-')))
    // The production runner inherits this process's environment and takes no
    // environment argument, so pinning the config paths here is the only way
    // the isolation reaches the commands the code under test runs. Both point
    // inside the fixture at files that are never created: git reads a missing
    // config file as an empty one, which is the "no ambient configuration"
    // state an alias, a hooks path or a default branch name could otherwise
    // leak into.
    priorGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    priorSystemConfig = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'absent-global-gitconfig')
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'absent-system-gitconfig')

    await seed(['init', '-q', '-b', 'main', '.'])
    shaOne = await commit('one')
    shaTwo = await commit('two')

    // Written by the pin module rather than by hand: the drop discovers refs by
    // prefix, so a test that wrote the names itself would only prove this file
    // agrees with itself. Writing with the real pin path makes a divergence
    // between the two spellings turn these legs red.
    for (const localId of [LOCAL_ID, OTHER_LOCAL_ID]) {
      const pinned = await pinSnapshotObjects(runner, dir, localId, {
        mergeBaseSha: shaOne,
        headSha: shaTwo,
      })
      expect(pinned.ok).toBe(true)
    }
  }, 60_000)

  afterAll(() => {
    if (priorGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = priorGlobalConfig
    if (priorSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM
    else process.env.GIT_CONFIG_SYSTEM = priorSystemConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test('the drop reports both of the review’s refs', async () => {
    const refs = pinRefsFor(LOCAL_ID, `${shaOne}...${shaTwo}`)
    const result = await dropPinnedRefs({ runner, cwd: dir }, LOCAL_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(2)
    expect([...result.dropped].sort()).toEqual([refs.base, refs.head].sort())
  }, 30_000)

  test('nothing is left under that review’s prefix', async () => {
    // The absence this whole module exists to produce. Its control is the leg
    // below: the same listing command, run over a namespace that still has
    // refs, prints them — so an empty result here is a fact about the drop and
    // not about a listing that never prints anything.
    expect(await listing(LOCAL_ID)).toBe('')
  }, 30_000)

  test('the other local review keeps its pins', async () => {
    const refs = pinRefsFor(OTHER_LOCAL_ID, `${shaOne}...${shaTwo}`)
    expect((await listing(OTHER_LOCAL_ID)).split('\n').sort()).toEqual(
      [refs.base, refs.head].sort(),
    )
  }, 30_000)

  test('a second drop is a zero-count no-op that spawns only a discovery', async () => {
    const recorder = countingRunner(runner)
    const result = await dropPinnedRefs({ runner: recorder, cwd: dir }, LOCAL_ID)
    expect(result).toEqual({ ok: true, count: 0, dropped: [] })
    expect(recorder.calls.map((call) => call.args)).toEqual([
      ['git', 'for-each-ref', '--format=%(refname)', '--end-of-options', `refs/revu/reviews/${LOCAL_ID}/`],
    ])
  }, 30_000)

  test('a pinned object survives a collection that would otherwise reclaim it', async () => {
    // The control for the leg below, and the claim the pin exists to make. An
    // unreachable commit is collected by `--prune=now`; this one is held by
    // nothing but its pin, so its survival is the pin doing its job.
    doomed = await commit('doomed')
    const pinned = await pinSnapshotObjects(runner, dir, RETENTION_ID, {
      mergeBaseSha: shaOne,
      headSha: doomed,
    })
    expect(pinned.ok).toBe(true)

    await seed(['reset', '-q', '--hard', shaTwo])
    await collect()

    expect((await git(['cat-file', '-e', doomed])).code).toBe(0)
  }, 60_000)

  test('dropping the pin lets the same collection reclaim the object', async () => {
    // Retention as an explicit delete rather than an accident of collection:
    // the object above outlived a prune, and the only thing that changed
    // between then and now is that its refs are gone.
    const result = await dropPinnedRefs({ runner, cwd: dir }, RETENTION_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(2)

    await collect()

    expect((await git(['cat-file', '-e', doomed])).code).not.toBe(0)
  }, 60_000)
})

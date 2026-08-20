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
 * ## The blob pass fails in the same direction, worse, and more quietly
 *
 * Reclaiming the file bytes is the third thing this module can do, and it is
 * built on its own acceptance assertion for the same reason:
 * `expectEveryReferencedBlobStillPresent` reads back every SHA the surviving
 * comparisons name and requires the store to still hold it. Every blob-pass leg
 * below ends with it, and it carries the same two controls — green over an
 * untouched store, red over one with a referenced blob removed by hand.
 *
 * What makes it worse than the half sweep is sharing. A blob row is content-
 * addressed, so it is claimed by every comparison whose index names that SHA,
 * across pull requests and local reviews alike — which is why the fixture seeds
 * one blob named by a live pull request AND by a superseded local half, and
 * asserts that it really is shared before relying on it. A reference set built
 * from one kind of review's comparisons removes that blob and breaks a review
 * nobody was reclaiming for.
 *
 * What makes it quieter is the failure mode. A missing half makes a review
 * refuse to open. A missing blob does not: reconciling a draft resolves each
 * pending comment's anchor through a blob read, an absent blob reads as "no
 * content to match", and the comment is classified LOST — anchors disappear in
 * bulk with no error anywhere. That is why the pass is off by default, and why
 * the policy is pinned by a PAIR rather than by its off case alone: without the
 * on half, "off by default" and "the blob pass never worked" are the same green
 * suite.
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
import type { FileBlob, ReviewDraft, Snapshot, SnapshotImmutable } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import {
  CONFORMANCE_REPO,
  CONFORMANCE_SESSION,
  MOVING_BASE_PR,
  movingBaseClient,
} from './conformance-fakes'
import { createDirectApi } from './direct-api'
import type { GithubClient } from './github-client'
import type { LocalReviewSurface } from './local-surface'
import { pinRefsFor, pinSnapshotObjects } from './local-pins'
import {
  createSyncGate,
  dropPinnedRefs,
  pruneBlobs,
  pruneImmutables,
  sweepHeldOff,
  withSyncInFlight,
  type BlobPruneWithheld,
  type BlobRetentionPolicy,
  type SweepSkipped,
  type SyncGate,
} from './retention'
import {
  openDirectStore,
  StoreUnreadableError,
  StoreWriteError,
  type BlobDeletion,
  type DirectStore,
  type ImmutableDeletion,
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

/** The blob index every fixture uses unless it is about which SHAs are named. */
const DEFAULT_BLOB_INDEX: SnapshotImmutable['blobIndex'] = {
  'a.ts': { base: 'baseblob', head: 'headblob' },
}

/**
 * The immutable half of one comparison, with just enough shape to be stored.
 *
 * `blobIndex` is a parameter because the blob pass is entirely about which SHAs
 * a surviving comparison names: a fixture that hard-coded one index could not
 * express two comparisons sharing a blob, which is the case the whole pass has
 * to get right.
 */
function immutableHalf(
  compareKey: string,
  blobIndex: SnapshotImmutable['blobIndex'] = DEFAULT_BLOB_INDEX,
): SnapshotImmutable {
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
    blobIndex,
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
  blobIndex: SnapshotImmutable['blobIndex'] = DEFAULT_BLOB_INDEX,
): Snapshot {
  return {
    prNumber: id,
    syncedAt,
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 0 },
    immutable: immutableHalf(compareKey, blobIndex),
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

/**
 * How many blob rows the store holds, counted through a handle of its own.
 *
 * The blob table has no sweep of its own yet, so this exists to say what a sweep
 * of the immutable cache did NOT do to it: the two tables share no key space,
 * and a reclamation that reached across from one to the other would be reaching
 * for bytes the local path cannot fetch again.
 */
function blobRowCount(): number {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const row = raw.query('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }
  raw.close()
  return row.n
}

/** How many pull-request envelopes are on disk, counted the same independent way. */
function snapshotRowCount(): number {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const row = raw.query('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }
  raw.close()
  return row.n
}

/**
 * Runs a sweep that is expected to RUN, and hands back what it removed.
 *
 * The sweep may now decline, and a declined sweep removes nothing and reports
 * zero of everything — which is indistinguishable, at every assertion below,
 * from a sweep that ran over a store with nothing to reclaim. Every leg that is
 * about what a sweep removes therefore goes through this, so a sweep that
 * quietly stood aside is a loud failure rather than a green test measuring
 * nothing. The default gate is a fresh one per call: legs that are not about the
 * gate get an idle one that nothing else can have moved.
 */
function sweep(store: DirectStore, gate: SyncGate = createSyncGate()): ImmutableDeletion {
  const result = pruneImmutables(store, gate)
  if ('skipped' in result) {
    throw new Error(
      `the sweep stood aside with ${result.inFlight} sync(s) in flight, so it measured nothing`,
    )
  }
  return result
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
    sweep(store)
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('both unreferenced halves go and both referenced halves stay', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    // Pinned before the sweep, so the count after it is against rows that
    // demonstrably existed rather than against a table that was short all along.
    expect(immutableRowCount()).toBe(4)

    const result = sweep(store)

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

    const result = sweep(store)

    // The report is what a caller reconciling its own view of the cache acts
    // on, so it names rows rather than counting them.
    expect(result.removed).toEqual([ORPHAN_PR_KEY, ORPHAN_LOCAL_KEY])
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('a second sweep over an already-swept store removes nothing', () => {
    const store = openStore()
    seedTwoLiveAndTwoOrphans(store)
    expect(sweep(store).count).toBe(2)

    // Idempotent, because a reclamation that ran once has to be safe to run
    // again: there is no state saying which keys were already considered, and
    // "already gone" is the outcome the caller asked for.
    expect(sweep(store)).toEqual({ count: 0, removed: [] })
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

    const result = sweep(store)

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
    expect(() => sweep(reopened)).toThrow(StoreUnreadableError)
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
    expect(() => sweep(reopened)).toThrow(StoreWriteError)
    expect(immutableRowCount()).toBe(4)
    expectEverySnapshotStillReadable(reopened)
    reopened.close()
  })

  test('no draft is touched by a sweep, local or pull-request', () => {
    const store = openStore()
    const localId = seedTwoLiveAndTwoOrphans(store)
    store.putLocalDraft(unsubmittedDraft('h1', localId, 'unsubmitted local text'))
    store.putDraft(unsubmittedDraft('h1', SEEDED_PR, 'unsubmitted pull request text'))

    expect(sweep(store).count).toBe(2)

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
    const result = sweep(armed)

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
 * A promise the test resolves by hand, and the two halves of the handle needed
 * to do it.
 *
 * Every interleave below is ordered by these rather than by a sleep. A sleep
 * asserts that one thing probably happened before another and pays real
 * wall-clock for the guess; a promise the test holds asserts it exactly, because
 * the sync cannot pass the point it is parked at until this call is made.
 */
interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = () => {
      res()
    }
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A hosted client whose mutable-half fetch parks until the test lets it through,
 * and announces when it has been reached.
 *
 * `getIssueComments` is the park point because of where it sits in the sync: it
 * is the FIRST call the mutable half makes, so the engine has already written
 * the immutable half under its compare key and has not yet assembled — let alone
 * persisted — the envelope that would name it. That is precisely the window a
 * reference-based sweep gets wrong, and parking anywhere earlier would find no
 * fresh row to be wrong about.
 */
function pausableHostedClient(inner: GithubClient): {
  client: GithubClient
  reached: Promise<void>
  release: () => void
} {
  const arrived = deferred()
  const held = deferred()
  const client: GithubClient = {
    ...inner,
    async getIssueComments(...args: Parameters<GithubClient['getIssueComments']>) {
      arrived.resolve()
      await held.promise
      return inner.getIssueComments(...args)
    },
  }
  return { client, reached: arrived.promise, release: held.resolve }
}

/**
 * The same fake, reporting the merge-base tree listing as TRUNCATED.
 *
 * A truncated listing gives the immutable half an incompleteness of its OWN —
 * a property of the comparison, stored on the cached row and reattached to every
 * later reuse of that key. It is the field the interleave destroys permanently,
 * which is why one leg below needs a half that has one.
 */
function truncatedTreeClient(state: { mergeBaseSha: string; unresolvedComments: number }): GithubClient {
  const base = movingBaseClient(state)
  return {
    ...base,
    async getTree(...args: Parameters<GithubClient['getTree']>) {
      const tree = await base.getTree(...args)
      return { ...tree, truncated: true }
    },
  }
}

/**
 * A local surface that serves `syncPull` and refuses everything else by name.
 *
 * Only the sync is exercised here, and a double that answered the rest with
 * plausible values would let a leg drift onto a path it never meant to test
 * without saying so. The refusal names the method, so if that ever happens the
 * failure explains itself.
 */
function localSurfaceDouble(syncPull: (localId: number) => Promise<Snapshot>): LocalReviewSurface {
  return new Proxy({} as LocalReviewSurface, {
    get(_target, property) {
      if (property === 'syncPull') return syncPull
      return () => {
        throw new Error(`the local double serves syncPull alone, not ${String(property)}`)
      }
    },
  })
}

/** The blob bytes a local sync puts down before its envelope lands. */
const FRESH_BLOB_SHA = 'freshblob'

/** One blob row, shaped as the provisioning path writes it. */
function localBlob(sha: string): FileBlob {
  return { sha, path: 'a.ts', content: 'fresh bytes\n', size: 12, binary: false }
}

/** The review row every interleave leg's local half is created from. */
const LOCAL_REVIEW_INPUT = {
  repo: 'acme/widgets',
  baseRef: 'refs/heads/main',
  headRef: 'refs/heads/feature/x',
  title: 'feature/x',
} as const

describe('a sweep stands aside while a sync is still writing', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('a hosted sync mid-write is left alone, and the same sweep runs once it is over', async () => {
    const store = openStore()
    // One local snapshot, so the readable-snapshot assertion below has a
    // snapshot of each kind to open, and one genuine orphan, so the sweep has
    // something it really would remove. Without the orphan the "removed
    // nothing" assertion would hold over a store where there was nothing to
    // remove, which is the shape this whole leg is trying not to be.
    const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id
    store.putLocalSnapshot(storedSnapshot(localId, LIVE_LOCAL_KEY))
    store.putImmutable(immutableHalf(ORPHAN_PR_KEY))

    const gate = createSyncGate()
    const paused = pausableHostedClient(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }))
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: paused.client,
      repo: CONFORMANCE_REPO,
      store,
      syncGate: gate,
    })

    const syncing = api.syncPull(MOVING_BASE_PR)
    await paused.reached

    // The window is MEASURED, not assumed. The fresh half is on disk under its
    // compare key and no envelope names it — which is exactly why the reference
    // subtraction would propose it — and the count says how many rows a sweep
    // would find to be wrong about.
    expect(store.listImmutableKeys()).toContain('MB1...HEAD-FIXED')
    expect(snapshotRowCount()).toBe(0)
    expect(immutableRowCount()).toBe(3)

    const held = pruneImmutables(store, gate)

    // A value naming the reason and the count, so a caller can log why the
    // store was not reclaimed rather than reading a zero as "nothing to do".
    expect(held).toEqual({ skipped: 'syncs-in-flight', inFlight: 1 })
    // Whole, not partial: the orphan it would have removed is still there too.
    expect(immutableRowCount()).toBe(3)
    expect(store.listImmutableKeys()).toContain(ORPHAN_PR_KEY)
    // The blob table is untouched by this sweep at every moment. On the hosted
    // path it is also still EMPTY here, which is a fact about where the window
    // sits: the engine writes blob bytes as the last act of provisioning, with
    // no await between that write and the envelope, so a hosted sync's fresh
    // bytes are never exposed the way its fresh immutable half is.
    expect(blobRowCount()).toBe(0)

    paused.release()
    await syncing

    // The falsification of the skip: the SAME sweep over the SAME store, with
    // the sync finished, removes the orphan. A guard that skipped forever and a
    // guard that skips only while a sync runs are the same green test without
    // this half.
    expect(blobRowCount()).toBeGreaterThan(0)
    const swept = sweep(store, gate)
    expect(swept.removed).toEqual([ORPHAN_PR_KEY])
    expect(store.listImmutableKeys()).toEqual(['MB1...HEAD-FIXED', LIVE_LOCAL_KEY].sort())
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test("the immutable half's own incompleteness survives a sweep attempted mid-sync", async () => {
    // Why the interleave is not merely untidy. The envelope write rewrites the
    // immutable row, so a half removed mid-sync appears to come back — but that
    // write carries the row's own `partial` forward by READING it off disk, and
    // a row that was removed reads as absent, which is recorded as complete. A
    // comparison that was truncated is then cached forever as a whole one, and
    // every later reuse of that key repeats the lie.
    const store = openStore()
    const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id
    store.putLocalSnapshot(storedSnapshot(localId, LIVE_LOCAL_KEY))

    const gate = createSyncGate()
    const paused = pausableHostedClient(truncatedTreeClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }))
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: paused.client,
      repo: CONFORMANCE_REPO,
      store,
      syncGate: gate,
    })

    const syncing = api.syncPull(MOVING_BASE_PR)
    await paused.reached
    // Recorded before the sweep is attempted, so the assertion afterwards is
    // against a value that demonstrably existed rather than one that may never
    // have been written.
    expect(store.getImmutable('MB1...HEAD-FIXED')?.partial).not.toBeNull()

    pruneImmutables(store, gate)

    paused.release()
    const snapshot = await syncing

    const cached = store.getImmutable('MB1...HEAD-FIXED')
    expect(cached?.partial).not.toBeNull()
    expect(cached?.partial?.reason).toContain('truncated')
    // And the snapshot the caller was handed says so too, so the honesty is not
    // confined to a row nobody reads.
    expect(snapshot.partial?.reason).toContain('truncated')
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('a local review sync mid-write is left alone, with its fresh blob bytes exposed', async () => {
    // The other half of the window, and the one that cannot be recovered. The
    // local surface writes blob bytes and then reads git three more times before
    // its envelope lands, so on this path it is the BYTES that sit on disk
    // referenced by nothing — and a local review's bytes came from one clone
    // with no second tier to fetch them from again.
    const store = openStore()
    store.putSnapshot(storedSnapshot(SEEDED_PR, LIVE_PR_KEY))
    store.putImmutable(immutableHalf(ORPHAN_LOCAL_KEY))
    const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id

    const arrived = deferred()
    const held = deferred()
    const gate = createSyncGate()
    // The double reproduces the real surface's ORDER, which is the only part of
    // it this leg depends on: bytes down, more git read, envelope last.
    const surface = localSurfaceDouble(async (id: number) => {
      const snapshot = storedSnapshot(id, LIVE_LOCAL_KEY)
      store.putBlobs([localBlob(FRESH_BLOB_SHA)])
      arrived.resolve()
      await held.promise
      store.putLocalSnapshot(snapshot)
      return snapshot
    })
    // No hosted client and no repository: this daemon reviews local branch pairs
    // and nothing else, which is the deployment where the loss is permanent.
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      store,
      localReviews: surface,
      syncGate: gate,
    })

    const syncing = api.syncPull(localId)
    await arrived.promise

    // The window, measured: the bytes are on disk and nothing names them.
    expect(store.hasBlob(FRESH_BLOB_SHA)).toBe(true)
    expect(store.getLocalSnapshot(localId)).toBeNull()

    const blobsBefore = blobRowCount()
    const held2 = pruneImmutables(store, gate)

    // The assertion that would be red if only the hosted branch were wrapped.
    expect(held2).toEqual({ skipped: 'syncs-in-flight', inFlight: 1 })
    expect(immutableRowCount()).toBe(2)
    expect(blobRowCount()).toBe(blobsBefore)
    expect(store.hasBlob(FRESH_BLOB_SHA)).toBe(true)

    held.resolve()
    await syncing

    const swept = sweep(store, gate)
    expect(swept.removed).toEqual([ORPHAN_LOCAL_KEY])
    expect(store.hasBlob(FRESH_BLOB_SHA)).toBe(true)
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('a sync that REJECTS leaves nothing in flight, and the next sweep runs', async () => {
    // The assertion that matters most. A count left pinned by a failed sync has
    // no symptom: every later sweep stands aside and reports it, which from the
    // outside is a sweep that keeps finding nothing to reclaim. The store grows
    // forever and the only evidence is a number nobody is looking at.
    const store = openStore()
    const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id
    store.putLocalSnapshot(storedSnapshot(localId, LIVE_LOCAL_KEY))
    store.putSnapshot(storedSnapshot(SEEDED_PR, LIVE_PR_KEY))
    store.putImmutable(immutableHalf(ORPHAN_PR_KEY))

    const gate = createSyncGate()
    const refusing: GithubClient = {
      ...movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }),
      async getPullDetail() {
        throw new Error('the fake refuses to describe this pull request')
      },
    }
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: refusing,
      repo: CONFORMANCE_REPO,
      store,
      syncGate: gate,
    })

    await expect(api.syncPull(MOVING_BASE_PR)).rejects.toThrow(
      'the fake refuses to describe this pull request',
    )

    expect(gate.inFlight).toBe(0)
    // Read through the helper, which turns a sweep that stood aside into a
    // failure — so this is an assertion about the sweep RUNNING, not merely
    // about a counter reading zero.
    const swept = sweep(store, gate)
    expect(swept.removed).toEqual([ORPHAN_PR_KEY])
    expectEverySnapshotStillReadable(store)
    store.close()
  })

  test('two overlapping syncs hold the sweep off until BOTH have left', async () => {
    const store = openStore()
    const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id
    store.putLocalSnapshot(storedSnapshot(localId, LIVE_LOCAL_KEY))
    store.putSnapshot(storedSnapshot(SEEDED_PR, LIVE_PR_KEY))
    store.putImmutable(immutableHalf(ORPHAN_PR_KEY))

    const gate = createSyncGate()
    const first = deferred()
    const second = deferred()
    // Entered, not awaited: the count rises when the wrapper is CALLED, so both
    // are in flight here with no timer involved in saying so.
    const a = withSyncInFlight(gate, () => first.promise)
    const b = withSyncInFlight(gate, () => second.promise)

    expect(pruneImmutables(store, gate)).toEqual({ skipped: 'syncs-in-flight', inFlight: 2 })

    first.resolve()
    await a

    // One left, one still writing — and a sweep that decremented to zero on the
    // first exit would run here and take the second sync's rows with it.
    expect(pruneImmutables(store, gate)).toEqual({ skipped: 'syncs-in-flight', inFlight: 1 })
    expect(immutableRowCount()).toBe(3)

    second.resolve()
    await b

    expect(gate.inFlight).toBe(0)
    expect(sweep(store, gate).removed).toEqual([ORPHAN_PR_KEY])
    expectEverySnapshotStillReadable(store)
    store.close()
  })
})

/** The blob only the live pull request's comparison names. */
const PR_BLOB = 'blob-pr-head'
/** The blob only the live local review's comparison names. */
const LOCAL_BLOB = 'blob-local-head'
/**
 * The blob named by the live pull request's comparison AND by the local
 * review's superseded one — the case content addressing makes ordinary and the
 * one an over-eager reclamation destroys.
 */
const SHARED_BLOB = 'blob-shared-base'
/** The blob only the superseded local comparison names. The single candidate. */
const ORPHAN_BLOB = 'blob-orphan-head'
/** A blob no comparison has ever named, sorting last. */
const LOOSE_BLOB = 'blob-zz-loose'

/** One blob row, shaped as the provisioning path writes it. */
function blobRow(sha: string): FileBlob {
  return { sha, path: 'a.ts', content: `bytes of ${sha}\n`, size: 16, binary: false }
}

/**
 * Seed a store whose blob table is shared the way a real one is: one live pull
 * request, one live local review, one superseded local comparison, and four
 * blobs whose reference pattern spans all three.
 *
 * The shared blob is the whole reason this fixture is shaped this way. Blob rows
 * are content-addressed, so one row backs every comparison whose index names
 * that SHA — a base-side blob unchanged between a pull request and a local
 * branch really is one row — and a reclamation that reasons about one review's
 * halves alone proposes it for deletion. A fixture where each review's blobs
 * were disjoint would let that mistake pass.
 */
function seedSharedBlobs(store: DirectStore): number {
  store.putSnapshot(
    storedSnapshot(SEEDED_PR, LIVE_PR_KEY, undefined, {
      'a.ts': { base: SHARED_BLOB, head: PR_BLOB },
    }),
  )
  const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id
  store.putLocalSnapshot(
    storedSnapshot(localId, LIVE_LOCAL_KEY, undefined, {
      'a.ts': { base: null, head: LOCAL_BLOB },
    }),
  )
  // The half the local review's previous comparison left behind: nothing names
  // it any more, so the immutable sweep takes it — and with it the only other
  // claim on the shared blob.
  store.putImmutable(
    immutableHalf(ORPHAN_LOCAL_KEY, {
      'a.ts': { base: SHARED_BLOB, head: ORPHAN_BLOB },
    }),
  )
  store.putBlobs([
    blobRow(PR_BLOB),
    blobRow(LOCAL_BLOB),
    blobRow(SHARED_BLOB),
    blobRow(ORPHAN_BLOB),
  ])
  return localId
}

/**
 * Every blob SHA the store's SURVIVING comparisons name, walked independently of
 * the code under test.
 *
 * Read raw and walked here rather than asked of the store, for the reason every
 * count in this file is taken through a second handle: a reclamation and a read
 * of the same table that went wrong the same way would agree with each other.
 * Both sides of every path, because a base-side SHA is exactly what a head-only
 * walk loses.
 */
function referencedBlobShasOnDisk(): string[] {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const rows = raw
    .query('SELECT data FROM immutables ORDER BY compare_key ASC')
    .all() as { data: string }[]
  raw.close()
  const shas = new Set<string>()
  for (const row of rows) {
    const stored = JSON.parse(row.data) as { immutable: SnapshotImmutable }
    for (const sides of Object.values(stored.immutable.blobIndex)) {
      if (sides.base) shas.add(sides.base)
      if (sides.head) shas.add(sides.head)
    }
  }
  return [...shas].sort()
}

/**
 * Reads back every blob SHA a surviving comparison names and asserts that not
 * one of them is missing from the store.
 *
 * This is the acceptance test the whole blob pass exists to satisfy, and it is
 * an acceptance test only while EVERY blob-pass test below ends with it. The
 * failure it catches has no other symptom, and that is what separates it from
 * the readable-snapshot assertion it mirrors. A missing immutable half makes a
 * review refuse to open, loudly. A missing blob does not: reconciling a draft
 * resolves each pending comment's anchor through a blob read, an absent blob
 * reads as "there is no content to match against", and the comment is
 * classified LOST. The reviewer's anchors go missing in bulk and nothing
 * anywhere reports an error.
 *
 * The two counts are the control. A store holding no comparisons, or
 * comparisons naming no SHAs, satisfies "nothing was missing" without checking
 * anything — precisely how an assertion like this passes while asserting
 * nothing — so both are required to be non-empty.
 *
 * It assumes a fixture that really provisioned every SHA its comparisons name.
 * That is true of every fixture here and is not a universal property of the
 * store: a snapshot recorded as partial names SHAs no tier could fetch, and a
 * store holding one would fail this for a reason that has nothing to do with
 * reclamation.
 */
function expectEveryReferencedBlobStillPresent(store: DirectStore): void {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const surviving = (raw.query('SELECT COUNT(*) AS n FROM immutables').get() as { n: number }).n
  raw.close()
  const referenced = referencedBlobShasOnDisk()

  // Something to walk, and something for the walk to have found. A store with no
  // comparisons left, or comparisons naming no content, satisfies "nothing was
  // missing" without checking a single row.
  expect(surviving).toBeGreaterThan(0)
  expect(referenced.length).toBeGreaterThan(0)

  for (const sha of referenced) {
    expect(store.getBlob(sha)).not.toBeNull()
  }
}

/**
 * Runs a blob pass that is expected to RUN, and hands back what it removed.
 *
 * The pass may decline for either of two reasons, and a declined pass removes
 * nothing and reports zero of everything — indistinguishable, at every assertion
 * below, from a pass that ran over a store with nothing to reclaim. Every leg
 * that is about what the pass removes therefore goes through this, so a pass
 * that quietly stood aside or was never enabled is a loud failure rather than a
 * green test measuring nothing.
 */
function sweepBlobs(store: DirectStore, gate: SyncGate = createSyncGate()): BlobDeletion {
  const result = pruneBlobs(store, gate, { reclaimBlobs: true })
  if ('skipped' in result) {
    throw new Error(
      `the blob pass stood aside with ${result.inFlight} sync(s) in flight, so it measured nothing`,
    )
  }
  if ('withheld' in result) {
    throw new Error('the blob pass was withheld by policy, so it measured nothing')
  }
  return result
}

/**
 * Reclaims the halves and then the bytes, in the order a caller runs them.
 *
 * The blob policy is threaded through rather than fixed, because the pair that
 * pins "off by default" needs the SAME call with and without it — and "without
 * it" has to mean the argument is genuinely absent, not passed as false, or the
 * default is never exercised.
 *
 * The half pass is required to have run: it is what leaves the surviving
 * comparisons the byte pass reads, and a byte pass that followed a half pass
 * which stood aside would be measuring the wrong store.
 */
function fullPrune(
  store: DirectStore,
  gate: SyncGate = createSyncGate(),
  policy?: BlobRetentionPolicy,
): BlobDeletion | SweepSkipped | BlobPruneWithheld {
  sweep(store, gate)
  return policy === undefined ? pruneBlobs(store, gate) : pruneBlobs(store, gate, policy)
}

describe('the referenced-blob assertion is live before any byte is reclaimed', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('an untouched store passes it', () => {
    // The baseline: seeded and never reclaimed, every named blob is present.
    // Without this, a red further down could be the assertion being wrong about
    // a healthy store rather than the reclamation being wrong about it.
    const store = openStore()
    seedSharedBlobs(store)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('it fails when a blob a surviving comparison names is taken away', () => {
    // And the assertion proved to bite, against the exact damage it exists to
    // catch: one referenced blob removed by hand, with the comparison that names
    // it left intact. An assertion that never fails is not an assertion.
    const store = openStore()
    seedSharedBlobs(store)
    store.close()

    const raw = new Database(join(storeDir, 'direct.sqlite'))
    raw.run('DELETE FROM blobs WHERE sha = ?', [SHARED_BLOB])
    raw.close()

    const reopened = openStore()
    expect(() => expectEveryReferencedBlobStillPresent(reopened)).toThrow()
    reopened.close()
  })

  test('the fixture really does share one blob between the two kinds of review', () => {
    // The claim every leg below rests on, asserted rather than assumed. If the
    // pull request's comparison and the superseded local one did not name the
    // same SHA, the cross-review legs would be testing disjoint stores and would
    // pass over a reclamation that reasons about one review at a time.
    const store = openStore()
    seedSharedBlobs(store)

    const prIndex = store.getImmutable(LIVE_PR_KEY)?.immutable.blobIndex['a.ts']
    const orphanIndex = store.getImmutable(ORPHAN_LOCAL_KEY)?.immutable.blobIndex['a.ts']

    expect([prIndex?.base, orphanIndex?.base]).toEqual([SHARED_BLOB, SHARED_BLOB])
    store.close()
  })
})

describe('reclaiming blobs by reference', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('every blob a surviving comparison names is still present after a full prune', () => {
    // The load-bearing leg. Every other assertion in this block is about what
    // the pass removed; this one is about what it must not have, and it is the
    // only one that fails when the reference set is built from one kind of
    // review's comparisons instead of every stored one — a shape in which the
    // pass still reports a plausible count while another review's content is
    // gone and its reviewer's comments will silently classify as lost.
    const store = openStore()
    seedSharedBlobs(store)
    // With the policy ON, because a withheld pass removes nothing and would
    // satisfy this without the reclamation ever having been examined.
    fullPrune(store, createSyncGate(), { reclaimBlobs: true })
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('a blob only an orphaned comparison named is removed', () => {
    const store = openStore()
    seedSharedBlobs(store)
    // Pinned before the pass, so the count after it is against rows that
    // demonstrably existed rather than against a table that was short all along.
    expect(blobRowCount()).toBe(4)

    const result = fullPrune(store, createSyncGate(), { reclaimBlobs: true })

    // Which one, not merely how many: a pass that removed the orphan's blob and
    // the shared one also leaves rows behind and also reports a removal.
    expect(result).toEqual({ count: 1, removed: [ORPHAN_BLOB] })
    expect(blobRowCount()).toBe(3)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('a blob shared with a live pull request survives the orphan that also named it', () => {
    // The over-deletion this whole pass is shaped against. The shared blob's
    // only OTHER claim went with the superseded local half; a reference set
    // drawn from the local side alone therefore reports it as named by nothing,
    // and removes bytes a pull request nobody was reclaiming still depends on.
    const store = openStore()
    seedSharedBlobs(store)

    fullPrune(store, createSyncGate(), { reclaimBlobs: true })

    expect(store.getBlob(SHARED_BLOB)).not.toBeNull()
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('a live pull request keeps its own blob through the same pass', () => {
    const store = openStore()
    seedSharedBlobs(store)

    fullPrune(store, createSyncGate(), { reclaimBlobs: true })

    // The unshared half of the same claim: a blob named by one live comparison
    // and nothing else is not a candidate either.
    expect(store.getBlob(PR_BLOB)).not.toBeNull()
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('deleting the local review leaves the pull request’s blobs exactly where they are', () => {
    // The whole story end to end: a local review is removed, its half becomes
    // unreferenced and goes, its own blob becomes unnamed and goes — and the
    // pull request that shared a blob with it is untouched. This is the cross
    // review breakage the pass must not cause, driven by the act that really
    // causes it.
    const store = openStore()
    const localId = seedSharedBlobs(store)

    store.deleteLocalReview(localId)
    fullPrune(store, createSyncGate(), { reclaimBlobs: true })

    expect(store.listBlobShas()).toEqual([PR_BLOB, SHARED_BLOB].sort())
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('a second full prune over an already-reclaimed store removes nothing', () => {
    const store = openStore()
    seedSharedBlobs(store)
    expect(sweepBlobs(store)).toEqual({ count: 0, removed: [] })

    // Idempotent, because a reclamation that ran once has to be safe to run
    // again: there is no state saying which SHAs were already considered, and
    // "already gone" is the outcome the caller asked for. The first call above
    // removes nothing because the orphaned half is still there naming its blob
    // — which is itself the ordering claim: bytes are judged against what the
    // half pass left behind.
    const first = fullPrune(store, createSyncGate(), { reclaimBlobs: true })
    expect(first).toEqual({ count: 1, removed: [ORPHAN_BLOB] })
    expect(fullPrune(store, createSyncGate(), { reclaimBlobs: true })).toEqual({
      count: 0,
      removed: [],
    })

    expect(blobRowCount()).toBe(3)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('a blob stale by years survives while one written moments ago is removed', () => {
    // The hard constraint made executable. Every timestamp this store records
    // about the live pull request is years in the past, while the orphan's blob
    // is written last and is therefore the newest row in the table by every
    // ordering the storage engine could offer. An age predicate of any kind
    // reverses this pair — and the blob table records no time at all, so there
    // is nothing to read even if one were wanted.
    const store = openStore()
    store.putSnapshot(
      storedSnapshot(SEEDED_PR, LIVE_PR_KEY, LONG_AGO, {
        'a.ts': { base: SHARED_BLOB, head: PR_BLOB },
      }),
    )
    const localId = store.createLocalReview(LOCAL_REVIEW_INPUT).id
    store.patchLocalReviewSync(localId, {
      baseSha: 'C',
      mergeBaseSha: 'C',
      headSha: 'D',
      dirty: false,
      lastSyncedAt: LONG_AGO,
    })
    store.putBlobs([blobRow(SHARED_BLOB), blobRow(PR_BLOB)])
    store.putBlobs([blobRow(ORPHAN_BLOB)])

    expect(sweepBlobs(store)).toEqual({ count: 1, removed: [ORPHAN_BLOB] })

    // Read back rather than assumed: the pair says nothing about expiry unless
    // the surviving rows really are the stale ones.
    expect(store.getLocalReview(localId)?.lastSyncedAt).toBe(LONG_AGO)
    expect(store.getSnapshot(SEEDED_PR)?.syncedAt).toBe(LONG_AGO)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('no draft is touched by a blob pass, local or pull-request', () => {
    const store = openStore()
    const localId = seedSharedBlobs(store)
    store.putLocalDraft(unsubmittedDraft('h1', localId, 'unsubmitted local text'))
    store.putDraft(unsubmittedDraft('h1', SEEDED_PR, 'unsubmitted pull request text'))

    fullPrune(store, createSyncGate(), { reclaimBlobs: true })

    // Unsubmitted text is the one thing in this store that cannot be recomputed
    // from anywhere, so a reclamation that reached it would be destroying the
    // only copy of a human's work to recover cache space.
    expect(store.getLocalDraft('h1', localId)?.body).toBe('unsubmitted local text')
    expect(store.getDraft('h1', SEEDED_PR)?.body).toBe('unsubmitted pull request text')
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('the pass reads the pull-request tables and writes none of them', () => {
    const store = openStore()
    seedSharedBlobs(store)
    const armed = armPrKeyedTripwires(store)

    // The half pass READS `snapshots` to decide what survives, which is
    // required. What is forbidden is writing there, and the tripwires guard
    // every write event.
    const result = fullPrune(armed, createSyncGate(), { reclaimBlobs: true })

    expect(result).toEqual({ count: 1, removed: [ORPHAN_BLOB] })
    // The control for the assertion above: a tripwire that was never installed,
    // or installed on the wrong table, would let the pass go by unguarded.
    expectPrSnapshotWritesRefused()
    expectEveryReferencedBlobStillPresent(armed)
    armed.close()
  })

  test('an unparseable comparison aborts the pass with every blob intact', () => {
    const store = openStore()
    seedSharedBlobs(store)
    store.close()

    const raw = new Database(join(storeDir, 'direct.sqlite'))
    raw.run('UPDATE immutables SET data = ? WHERE compare_key = ?', ['not json', LIVE_PR_KEY])
    raw.close()

    const reopened = openStore()
    expect(() => sweepBlobs(reopened)).toThrow(StoreUnreadableError)
    // Not merely that it threw. A comparison that cannot be parsed names no
    // SHAs, and a pass that treated it as naming none would turn every blob it
    // really referenced into a candidate — so the count is what says the refusal
    // happened before any statement ran, not part-way through them.
    expect(blobRowCount()).toBe(4)
    reopened.close()
  })

  test('a refused delete rolls the whole pass back, leaving all five rows', () => {
    const store = openStore()
    seedSharedBlobs(store)
    // A second candidate, sorting after the first, so the pass has two rows to
    // remove and the abort can arrive with one already deleted.
    store.putBlobs([blobRow(LOOSE_BLOB)])
    store.close()

    // Refuses the SECOND candidate. A count of four afterwards is a pass that is
    // not one transaction; a count of five is the rollback. The literal is
    // independent of anything the pass computes.
    const raw = new Database(join(storeDir, 'direct.sqlite'))
    raw.run(
      'CREATE TRIGGER refuse_one_blob_delete BEFORE DELETE ON blobs ' +
        `WHEN OLD.sha = '${LOOSE_BLOB}' ` +
        "BEGIN SELECT RAISE(ABORT, 'refused: these bytes are not to be removed'); END",
    )
    raw.close()

    const reopened = openStore()
    // A persist that failed is never swallowed into a success that removed part
    // of what it named.
    expect(() => fullPrune(reopened, createSyncGate(), { reclaimBlobs: true })).toThrow(
      StoreWriteError,
    )
    expect(blobRowCount()).toBe(5)
    expectEveryReferencedBlobStillPresent(reopened)
    reopened.close()
  })
})

describe('the blob pass is off until a caller turns it on', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('a full prune WITHOUT the blob policy leaves the orphan-only blob where it is', () => {
    const store = openStore()
    seedSharedBlobs(store)
    expect(blobRowCount()).toBe(4)

    const result = fullPrune(store)

    // The half pass ran — the superseded comparison is gone — and the byte pass
    // did not, over a store that demonstrably had a blob to reclaim. Without the
    // orphan present this would hold over a store where there was nothing to
    // remove, which is the shape this pair exists not to be.
    expect(store.listImmutableKeys()).toEqual([LIVE_PR_KEY, LIVE_LOCAL_KEY])
    expect(result).toEqual({ withheld: 'blob-reclamation-not-enabled' })
    expect(blobRowCount()).toBe(4)
    expect(store.getBlob(ORPHAN_BLOB)).not.toBeNull()
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('the SAME full prune WITH the blob policy removes exactly that blob', () => {
    // The falsification of the half above, and the half of this pair that stops
    // "off by default" from decaying into "the blob pass never worked". The
    // fixture is identical and the only difference is the flag.
    const store = openStore()
    seedSharedBlobs(store)
    expect(blobRowCount()).toBe(4)

    const result = fullPrune(store, createSyncGate(), { reclaimBlobs: true })

    expect(result).toEqual({ count: 1, removed: [ORPHAN_BLOB] })
    expect(blobRowCount()).toBe(3)
    expect(store.getBlob(ORPHAN_BLOB)).toBeNull()
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('an explicit false is the same refusal as an absent policy', () => {
    const store = openStore()
    seedSharedBlobs(store)

    // The default and the written-out position have to mean the same thing, or
    // a caller stating its position explicitly would get behaviour a caller
    // omitting it does not.
    expect(fullPrune(store, createSyncGate(), { reclaimBlobs: false })).toEqual({
      withheld: 'blob-reclamation-not-enabled',
    })
    expect(blobRowCount()).toBe(4)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('the refusal is a named reason rather than a zero count', () => {
    const store = openStore()
    seedSharedBlobs(store)

    const result = pruneBlobs(store, createSyncGate())

    // A zero count would read as "there were no unreferenced bytes", which is a
    // statement about the store — when the truth is that the store was never
    // examined. A caller must be able to tell those apart.
    expect('count' in result).toBe(false)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })

  test('the withheld reason is distinct from the in-flight skip', async () => {
    const store = openStore()
    seedSharedBlobs(store)
    const gate = createSyncGate()
    const parked = deferred()
    const running = withSyncInFlight(gate, () => parked.promise)

    // Two refusals that a caller responds to differently: a sync in flight is
    // temporary and worth retrying past, while a policy that is off persists
    // until a deployment changes its mind. Reported as one value they would be
    // indistinguishable, and a daemon that never reclaims bytes would look like
    // one that is merely busy.
    expect(pruneBlobs(store, gate, { reclaimBlobs: true })).toEqual({
      skipped: 'syncs-in-flight',
      inFlight: 1,
    })

    parked.resolve()
    await running

    expectEveryReferencedBlobStillPresent(store)
    store.close()
  })
})

describe('the blob pass stands aside while a sync is still writing', () => {
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'revu-prune-'))
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  test('a local sync mid-write keeps its fresh bytes, policy on or not', async () => {
    // The window that cannot be recovered from. The local surface writes blob
    // bytes and then reads git three more times before its envelope lands, so on
    // this path it is the BYTES that sit on disk named by nothing — and a local
    // review's bytes came from one clone, with no GitHub tier to fetch them from
    // again once the branch is rewritten and its pins are dropped.
    const store = openStore()
    const localId = seedSharedBlobs(store)

    const arrived = deferred()
    const held = deferred()
    const gate = createSyncGate()
    // The double reproduces the real surface's ORDER, which is the only part of
    // it this leg depends on: bytes down, more git read, envelope last.
    const surface = localSurfaceDouble(async (id: number) => {
      const snapshot = storedSnapshot(id, 'E...F', undefined, {
        'a.ts': { base: null, head: FRESH_BLOB_SHA },
      })
      store.putBlobs([localBlob(FRESH_BLOB_SHA)])
      arrived.resolve()
      await held.promise
      store.putLocalSnapshot(snapshot)
      return snapshot
    })
    // No hosted client and no repository: this daemon reviews local branch pairs
    // and nothing else, which is the deployment where the loss is permanent.
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      store,
      localReviews: surface,
      syncGate: gate,
    })

    const syncing = api.syncPull(localId)
    await arrived.promise

    // The window, measured: the bytes are on disk and no comparison names them,
    // which is exactly why the reference subtraction would propose them.
    expect(store.hasBlob(FRESH_BLOB_SHA)).toBe(true)
    expect(store.listReferencedBlobShas()).not.toContain(FRESH_BLOB_SHA)
    const before = blobRowCount()

    const heldOff = pruneBlobs(store, gate, { reclaimBlobs: true })

    // A value naming the reason and the count, so a caller can log why the store
    // was not reclaimed rather than reading a zero as "nothing to do" — and the
    // gate is consulted BEFORE the policy, so an enabled pass refuses on the
    // same terms a disabled one would never have reached.
    expect(heldOff).toEqual({ skipped: 'syncs-in-flight', inFlight: 1 })
    // Whole, not partial: the orphan's blob it would have removed is still there
    // too, and so are the fresh bytes.
    expect(blobRowCount()).toBe(before)
    expect(store.hasBlob(FRESH_BLOB_SHA)).toBe(true)
    expect(store.getBlob(ORPHAN_BLOB)).not.toBeNull()

    held.resolve()
    await syncing

    // The falsification of the skip: the SAME pass over the SAME store, with the
    // sync finished, runs and removes the bytes the re-sync really did strand —
    // the superseded comparison's blob and the one only it named — while the
    // fresh bytes, now named by the envelope that landed, stay exactly where
    // they are. A guard that skipped forever and a guard that skips only while a
    // sync runs are the same green test without this half.
    sweep(store, gate)
    const swept = sweepBlobs(store, gate)
    expect(swept.removed).toEqual([LOCAL_BLOB, ORPHAN_BLOB])
    expect(store.hasBlob(FRESH_BLOB_SHA)).toBe(true)
    expectEveryReferencedBlobStillPresent(store)
    store.close()
  }, 30_000)
})

describe('the wrapper owns both halves of the count', () => {
  test('a fresh gate has nothing in flight', () => {
    expect(createSyncGate().inFlight).toBe(0)
  })

  test('the count is raised for the duration and lowered after', async () => {
    const gate = createSyncGate()
    const parked = deferred()
    const running = withSyncInFlight(gate, () => parked.promise)

    expect(gate.inFlight).toBe(1)

    parked.resolve()
    await running

    expect(gate.inFlight).toBe(0)
  })

  test('the wrapped value is handed back unchanged', async () => {
    expect(await withSyncInFlight(createSyncGate(), async () => 'the snapshot')).toBe('the snapshot')
  })

  test('a rejected body releases the count and the rejection travels out', async () => {
    const gate = createSyncGate()
    await expect(
      withSyncInFlight(gate, async () => {
        throw new Error('the sync failed')
      }),
    ).rejects.toThrow('the sync failed')
    expect(gate.inFlight).toBe(0)
  })

  test('a body that throws before its first await releases the count too', async () => {
    // A synchronous throw takes a different route out of an async function than
    // a rejection does, and a wrapper that bracketed only the awaited part would
    // pin the count on exactly this shape.
    const gate = createSyncGate()
    await expect(
      withSyncInFlight(gate, () => {
        throw new Error('refused before anything ran')
      }),
    ).rejects.toThrow('refused before anything ran')
    expect(gate.inFlight).toBe(0)
  })

  test('the count returns to zero after a run and a sweep is not skipped', async () => {
    // The pair that makes "released" mean something: after one full run the gate
    // reads zero AND the check built on it answers that a sweep may proceed.
    const gate = createSyncGate()
    await withSyncInFlight(gate, async () => undefined)
    expect(sweepHeldOff(gate)).toBeNull()
  })

  test('the check reports the reason and the count while a sync is in flight', async () => {
    const gate = createSyncGate()
    const parked = deferred()
    const running = withSyncInFlight(gate, () => parked.promise)
    expect(sweepHeldOff(gate)).toEqual({ skipped: 'syncs-in-flight', inFlight: 1 })
    parked.resolve()
    await running
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

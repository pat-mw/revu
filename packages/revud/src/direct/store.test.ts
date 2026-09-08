/**
 * The durable SQLite store. These tests run entirely network-free and disk-local
 * (a temp data dir per test), asserting: persist/read round-trips; a durable
 * write failure surfaces as a typed error (never swallowed); a present-but-
 * unreadable row is distinguished from an absent one; and a store-version bump
 * migrates IN PLACE, preserving drafts. The two-half cache table (`immutables`)
 * is exercised for reuse-across-restart.
 *
 * Concurrency gets its own block: a child process holds the file's write lock
 * across a store call in this one, which is the only way to observe what a second
 * daemon sharing the data directory actually does to a write.
 *
 * The last block installs SQLite tripwires on the three tables whose integer key
 * is a real GitHub pull-request number, and proves they abort a write. That is
 * the negative control every absence-shaped claim about those tables depends on:
 * "nothing wrote `snapshots`" is worth something only while a write that did
 * reach `snapshots` would fail loudly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type {
  FileBlob,
  HumanPreferences,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Snapshot,
  SnapshotImmutable,
} from '@revu/shared'
import { DEFAULT_PREFERENCES, LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import {
  openDirectStore,
  resolveDirectDataDir,
  StoreUnreadableError,
  StoreWriteError,
  STORE_VERSION,
  type AuditEntry,
  type DirectStore,
  type LocalReviewSyncState,
  type NewLocalReview,
} from './store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revu-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function open(): DirectStore {
  return openDirectStore({ dataDir: dir })
}

/**
 * The immutable half of one comparison. `blobIndex` is a parameter because the
 * blob-reference reads are entirely about which SHAs an index names: a fixture
 * that hard-coded one index could not express two comparisons sharing a blob,
 * which is the case those reads exist to get right.
 */
function immutable(
  compareKey: string,
  blobIndex: SnapshotImmutable['blobIndex'] = {
    'a.ts': { base: 'baseblob', head: 'headblob' },
  },
): SnapshotImmutable {
  return {
    compareKey,
    mergeBaseSha: 'base',
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

function snapshot(prNumber: number, compareKey: string): Snapshot {
  return {
    prNumber,
    syncedAt: '2026-01-01T00:00:00.000Z',
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 5 },
    immutable: immutable(compareKey),
    mutable: {
      fetchedAt: '2026-01-01T00:00:00.000Z',
      pull: { number: prNumber } as Snapshot['mutable']['pull'],
      threads: [],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

function auditEntry(over: Partial<AuditEntry>): AuditEntry {
  return {
    githubId: 9001,
    humanId: 'alice@x.io',
    workspace: 'ws-o-r',
    endpoint: 'submitReview',
    pr: 204,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function draft(humanId: string, prNumber: number, body: string): ReviewDraft {
  return {
    humanId,
    prNumber,
    headSha: 'head',
    compareKey: 'base...head',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * A new local review's caller-supplied half. The repository identity and both
 * refs are spelled out rather than defaulted, because every uniqueness claim in
 * this block turns on which of the three differs between two calls.
 */
function newLocalReview(over: Partial<NewLocalReview>): NewLocalReview {
  return {
    repo: 'acme/widgets',
    baseRef: 'refs/heads/main',
    headRef: 'refs/heads/feature/x',
    title: 'feature/x',
    ...over,
  }
}

/** A sync observation with every field populated, for patch assertions. */
function syncState(over: Partial<LocalReviewSyncState> = {}): LocalReviewSyncState {
  return {
    baseSha: 'base-sha',
    mergeBaseSha: 'merge-base-sha',
    headSha: 'head-sha',
    dirty: false,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** How many local reviews the store file holds, read through a raw handle. */
function localReviewCount(): number {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw.query('SELECT COUNT(*) AS n FROM local_reviews').get() as { n: number }
  raw.close()
  return row.n
}

/**
 * Arm a single aborting trigger on `local_reviews` INSERT and return a freshly
 * opened store, so a create fails at exactly the statement that writes the row
 * while everything before it in the same call has already run.
 *
 * A deliberately induced failure is the only way to observe that the mint's
 * read-and-bump and its insert are one unit: nothing a caller can pass makes the
 * insert fail on its own.
 */
function armLocalReviewInsertTripwire(store: DirectStore): DirectStore {
  store.close()
  const raw = new Database(join(dir, 'direct.sqlite'))
  raw.run(
    'CREATE TRIGGER refuse_local_review_insert BEFORE INSERT ON local_reviews ' +
      "BEGIN SELECT RAISE(ABORT, 'refused: INSERT on local_reviews'); END",
  )
  raw.close()
  return open()
}

describe('resolveDirectDataDir', () => {
  test('honors REVU_DATA_DIR over XDG', () => {
    expect(resolveDirectDataDir({ REVU_DATA_DIR: '/tmp/x' })).toBe('/tmp/x')
  })

  test('uses XDG_DATA_HOME/revu when set', () => {
    expect(resolveDirectDataDir({ XDG_DATA_HOME: '/home/u/.data' })).toBe('/home/u/.data/revu')
  })

  test('falls back to ~/.local/share/revu', () => {
    const resolved = resolveDirectDataDir({})
    expect(resolved.endsWith('/.local/share/revu')).toBe(true)
  })
})

describe('persist + read round-trips', () => {
  test('a snapshot persists and reads back intact, immutable half re-attached', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'base...head'))
    const read = store.getSnapshot(204)
    expect(read).not.toBeNull()
    expect(read!.prNumber).toBe(204)
    expect(read!.immutable.compareKey).toBe('base...head')
    expect(read!.immutable.files[0].filename).toBe('a.ts')
    expect(read!.mutable.threads).toEqual([])
    store.close()
  })

  test('getSnapshot is null (not an error) for a never-synced PR', () => {
    const store = open()
    expect(store.getSnapshot(999)).toBeNull()
    store.close()
  })

  test('blobs are content-addressed and append-only (a second put does not overwrite)', () => {
    const store = open()
    const b: FileBlob = { sha: 's1', path: 'a.ts', content: 'v1', size: 2, binary: false }
    store.putBlobs([b])
    store.putBlobs([{ ...b, content: 'v2-should-be-ignored' }])
    expect(store.hasBlob('s1')).toBe(true)
    expect(store.getBlob('s1')!.content).toBe('v1')
    store.close()
  })

  test('preferences default new fields on an old row', () => {
    const store = open()
    // No stored prefs → defaults.
    expect(store.getPreferences('h1').diffMode).toBe('unified')
    const next = store.setPreferences('h1', { diffMode: 'split' })
    expect(next.diffMode).toBe('split')
    expect(store.getPreferences('h1').diffMode).toBe('split')
    store.close()
  })

  test('viewed state round-trips per human + PR', () => {
    const store = open()
    store.setViewed('h1', 204, { 'a.ts': { viewed: true, blobSha: 's', at: 'now' } })
    expect(store.getViewed('h1', 204)['a.ts'].viewed).toBe(true)
    // A different human sees nothing.
    expect(store.getViewed('h2', 204)).toEqual({})
    store.close()
  })

  test('local viewed state round-trips per human + local review id', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.setLocalViewed('h1', id, { 'a.ts': { viewed: true, blobSha: 's', at: 'now' } })
    expect(store.getLocalViewed('h1', id)['a.ts'].viewed).toBe(true)
    store.close()
  })

  test('a second human reads local viewed state back as empty — the answer, not an error', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.setLocalViewed('h1', id, { 'a.ts': { viewed: true, blobSha: 's', at: 'now' } })
    // Empty rather than a throw, and the contrast with a draft is deliberate:
    // "nobody has marked anything viewed" is an ordinary state with a natural
    // empty value, whereas a draft that is absent and a draft that is unreadable
    // are different enough that one must be `null` and the other must be loud.
    expect(store.getLocalViewed('h2', id)).toEqual({})
    store.close()
  })

  test('a present-but-corrupt local viewed row throws rather than reading as empty', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.setLocalViewed('h1', id, { 'a.ts': { viewed: true, blobSha: 's', at: 'now' } })
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE local_viewed SET data = '{not valid json' WHERE local_id = ?", [id])
    raw.close()

    // An empty record here would read as "nothing viewed" and the next write
    // would flatten whatever the row really held. Absent and unreadable are
    // different answers even where the absent one is a value rather than null.
    const reopened = open()
    expect(() => reopened.getLocalViewed('h1', id)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('viewed state under a local review id is invisible to the pull-request table', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.setLocalViewed('h1', id, { 'a.ts': { viewed: true, blobSha: 's', at: 'now' } })

    // Nothing was ever marked viewed on a PULL REQUEST numbered `id`, so the
    // pull-request read must be empty. This is the only case in this block where
    // the pull-request row is absent, which is the one shape a getter that
    // "helpfully" falls back to the other table would slip through.
    expect(store.getViewed('h1', id)).toEqual({})
    store.close()
  })

  test('the two viewed keyspaces hold their own state under one number', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.setViewed('h1', id, { 'pr.ts': { viewed: true, blobSha: 'pr', at: 'now' } })
    store.setLocalViewed('h1', id, { 'local.ts': { viewed: true, blobSha: 'local', at: 'now' } })

    // A local review id and a pull request number are different kinds of number
    // that can coincide. Sharing one table under a wider key would make the
    // second write overwrite the first and hand each side the other's
    // checkmarks — a file marked reviewed in one place, silently marked in the
    // other. Both reads are pinned, so a getter aimed at the wrong table is red
    // even when both rows exist.
    expect(Object.keys(store.getViewed('h1', id))).toEqual(['pr.ts'])
    expect(Object.keys(store.getLocalViewed('h1', id))).toEqual(['local.ts'])
    store.close()
  })
})

describe('the immutable half is a content-addressed cache keyed by compareKey', () => {
  test('putImmutable then getImmutable round-trips; a miss is null', () => {
    const store = open()
    expect(store.getImmutable('nope')).toBeNull()
    store.putImmutable(immutable('base...head'))
    const hit = store.getImmutable('base...head')
    expect(hit?.immutable.headSha).toBe('head')
    // No partial was stored: the half is complete.
    expect(hit?.partial).toBeNull()
    store.close()
  })

  test('an immutable half stored with a partial reads it back (stays honest on reuse)', () => {
    const store = open()
    store.putImmutable(immutable('base...head'), {
      missingBlobShas: [],
      reason: 'capped at N files',
    })
    expect(store.getImmutable('base...head')?.partial?.reason).toBe('capped at N files')
    store.close()
  })

  test('a stored row that predates the partial field reads back as complete (null)', () => {
    const store = open()
    store.putImmutable(immutable('base...head'))
    store.close()
    // Rewrite the row without the `partial` key, as an older build persisted it.
    const raw = new Database(join(dir, 'direct.sqlite'))
    const legacy = JSON.stringify({ compareKey: 'base...head', immutable: immutable('base...head') })
    raw.run('UPDATE immutables SET data = ? WHERE compare_key = ?', [legacy, 'base...head'])
    raw.close()
    const reopened = open()
    const hit = reopened.getImmutable('base...head')
    expect(hit?.immutable.headSha).toBe('head')
    expect(hit?.partial).toBeNull()
    reopened.close()
  })

  test('the immutable half survives a restart (reopen the same data dir)', () => {
    const first = open()
    first.putImmutable(immutable('base...head'))
    first.close()
    const second = open()
    expect(second.getImmutable('base...head')?.immutable.compareKey).toBe('base...head')
    second.close()
  })

  test('a snapshot write over a corrupt immutable row refuses rather than overwriting it', () => {
    const store = open()
    store.putImmutable(immutable('base...head'))
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE immutables SET data = '{not valid json' WHERE compare_key = 'base...head'")
    raw.close()

    // Writing a snapshot has to read the immutable row's own `partial` to carry
    // it forward, and the row it would carry forward is unreadable. Overwriting it
    // would destroy whatever real state is in there, so the write is refused.
    //
    // The type is the point. A corrupt row on disk is NOT the same condition as a
    // mutation that failed to reach disk: the second is retryable and the first is
    // not, and reporting the first as the second would invite a caller to retry
    // forever against a row only a human can repair. The error also names the row
    // that is actually corrupt — the immutable half — rather than the table the
    // caller thought it was writing.
    const reopened = open()
    let thrown: unknown
    try {
      reopened.putSnapshot(snapshot(204, 'base...head'))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(StoreUnreadableError)
    expect((thrown as StoreUnreadableError).table).toBe('immutables')
    expect((thrown as StoreUnreadableError).rowKey).toBe('base...head')
    reopened.close()

    // The transaction aborted, so the corrupt bytes are still there, unmodified —
    // a present row is real state and a failed write must not have consumed it.
    const check = new Database(join(dir, 'direct.sqlite'))
    const row = check
      .query("SELECT data FROM immutables WHERE compare_key = 'base...head'")
      .get() as { data: string }
    check.close()
    expect(row.data).toBe('{not valid json')
  })
})

describe('durability: write failures surface, never swallowed', () => {
  test('a write against a closed database throws StoreWriteError, not a silent success', () => {
    const store = open()
    store.close()
    expect(() => store.putDraft(draft('h1', 204, 'x'))).toThrow(StoreWriteError)
  })

  test('putSnapshot against a closed database throws StoreWriteError, not a raw database error', () => {
    const store = open()
    store.close()
    // Writing a snapshot reads the immutable row's own `partial` before it writes
    // anything, and that read has to sit inside the durability wrapper: a store
    // that cannot be read cannot be written either, and the caller needs the same
    // typed persist failure it gets from every other write rather than whatever
    // the database driver happens to raise. An unreadable ROW is the other
    // condition and keeps its own type; an unusable HANDLE is a write failure.
    expect(() => store.putSnapshot(snapshot(204, 'base...head'))).toThrow(StoreWriteError)
  })
})

describe('absent vs unreadable', () => {
  test('a missing draft reads back as null (absent — safe to treat as no draft)', () => {
    const store = open()
    expect(store.getDraft('h1', 204)).toBeNull()
    store.close()
  })

  test('a present-but-corrupt row throws StoreUnreadableError, never returns null', () => {
    const store = open()
    store.putDraft(draft('h1', 204, 'real work'))
    store.close()
    // Corrupt the stored JSON directly, simulating an I/O fault / partial write.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE drafts SET data = '{not valid json' WHERE human_id = 'h1' AND pr_number = 204")
    raw.close()
    const reopened = open()
    // The row EXISTS, so returning null (absent) would let the next write reseed
    // over real work. It must throw instead.
    expect(() => reopened.getDraft('h1', 204)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('a snapshot referencing a missing immutable half throws (corrupt, not absent)', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'base...head'))
    store.close()
    // Delete the immutable half out from under the snapshot.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("DELETE FROM immutables WHERE compare_key = 'base...head'")
    raw.close()
    const reopened = open()
    expect(() => reopened.getSnapshot(204)).toThrow(StoreUnreadableError)
    reopened.close()
  })
})

describe('STORE_VERSION migrates in place, preserving drafts', () => {
  test('reopening an older-version store keeps drafts and stamps the current version', () => {
    const store = open()
    store.putDraft(draft('h1', 204, 'must survive a version bump'))
    store.close()

    // Simulate an older on-disk version by rewriting the meta row down to 0.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE meta SET value = '0' WHERE key = 'store_version'")
    const before = raw.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    expect(before.value).toBe('0')
    raw.close()

    // Reopening migrates in place: the draft is untouched and the version is
    // stamped forward — never reseeded (which would wipe the draft).
    const reopened = open()
    const survived = reopened.getDraft('h1', 204)
    expect(survived).not.toBeNull()
    expect(survived!.body).toBe('must survive a version bump')
    reopened.close()

    const check = new Database(join(dir, 'direct.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    expect(Number(after.value)).toBe(STORE_VERSION)
    check.close()
  })

  test('a version-1 file gains audit_log in place WITHOUT wiping drafts', () => {
    // Recreate a genuine v1 file: current shape minus the audit_log table, meta
    // stamped at 1 — exactly what a version-1 build left on disk.
    const store = open()
    store.putDraft(draft('h1', 204, 'v1 work that must survive'))
    store.close()
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run('DROP TABLE audit_log')
    raw.run("UPDATE meta SET value = '1' WHERE key = 'store_version'")
    raw.close()

    // Reopening runs the guarded v1 → v2 step: the table is added, nothing is
    // reseeded, and the journal is immediately usable.
    const reopened = open()
    expect(reopened.getDraft('h1', 204)!.body).toBe('v1 work that must survive')
    reopened.appendAudit(auditEntry({ githubId: 1 }))
    expect(reopened.listAudit()).toHaveLength(1)
    reopened.close()

    const check = new Database(join(dir, 'direct.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    expect(Number(after.value)).toBe(STORE_VERSION)
    check.close()
  })

  test('a store from a NEWER build is left untouched, not downgraded or reseeded', () => {
    const store = open()
    store.putDraft(draft('h1', 204, 'from the future'))
    store.close()
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE meta SET value = '999' WHERE key = 'store_version'")
    raw.close()
    const reopened = open()
    // Draft still readable; version not downgraded.
    expect(reopened.getDraft('h1', 204)!.body).toBe('from the future')
    reopened.close()
    const check = new Database(join(dir, 'direct.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    expect(after.value).toBe('999')
    check.close()
  })
})

/**
 * The six tables the local-review keyspace adds, and the eight the versions
 * before it own. Both lists are written out rather than derived from the store
 * module: a list computed from the module under test agrees with that module
 * however wrong it becomes, so a table quietly dropped from the schema would
 * quietly drop out of the list too and every assertion over it would stay green.
 * Alphabetical, so a `sqlite_master` read ordered by name compares directly.
 */
const LOCAL_TABLES = [
  'local_drafts',
  'local_reviews',
  'local_reviews_submitted',
  'local_snapshots',
  'local_threads',
  'local_viewed',
] as const

const PRE_LOCAL_TABLES = [
  'audit_log',
  'blobs',
  'drafts',
  'immutables',
  'pr_author',
  'prefs',
  'snapshots',
  'viewed',
] as const

/**
 * Reduce the current data dir's store file to a genuine file from the build that
 * predates the local keyspace: the six local tables dropped, both local id
 * high-water rows removed, and the recorded version rolled back to the one
 * before them. Reopening the store is then a real in-place upgrade rather than a
 * no-op over a file that already has the shape.
 */
function reduceToPreLocalFile(): void {
  const raw = new Database(join(dir, 'direct.sqlite'))
  for (const table of LOCAL_TABLES) raw.run(`DROP TABLE ${table}`)
  raw.run("DELETE FROM meta WHERE key = 'local_review_id_high_water'")
  raw.run("DELETE FROM meta WHERE key = 'local_entity_id_high_water'")
  raw.run("UPDATE meta SET value = '3' WHERE key = 'store_version'")
  raw.close()
}

/** One `meta` value read through a raw handle, or `null` when the row is absent. */
function metaValue(key: string): string | null {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw.query('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | null
  raw.close()
  return row ? row.value : null
}

/**
 * Overwrite one id high-water mark through a raw handle, modelling a file that
 * was edited outside this store.
 *
 * Raw is the only honest shape available: nothing on the store surface writes a
 * mark to anything but its own successor, so a corrupt one cannot be produced
 * through the API that has to survive it.
 */
function corruptMarkRaw(key: string, value: string): void {
  const raw = new Database(join(dir, 'direct.sqlite'))
  raw.run('UPDATE meta SET value = ? WHERE key = ?', [value, key])
  raw.close()
}

/** Every table name in the store file, alphabetical. */
function tableNames(): string[] {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const rows = raw
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  raw.close()
  return rows.map((r) => r.name)
}

/**
 * One table's declared columns, in declaration order, with the four facts a
 * later edit could silently change: the declared type, whether NULL is refused,
 * the default, and the column's position in the primary key.
 */
function columnShape(
  table: string,
): { name: string; type: string; notnull: number; dflt: unknown; pk: number }[] {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const rows = raw.query(`PRAGMA table_info(${table})`).all() as {
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
  }[]
  raw.close()
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    notnull: r.notnull,
    dflt: r.dflt_value,
    pk: r.pk,
  }))
}

/** The stored DDL of every table the pre-local versions own, keyed by name. */
function preLocalDdl(): { name: string; sql: string }[] {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const rows = raw
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN " +
        "('immutables','snapshots','blobs','drafts','viewed','prefs','audit_log','pr_author') " +
        'ORDER BY name',
    )
    .all() as { name: string; sql: string }[]
  raw.close()
  return rows
}

describe('the local-review keyspace arrives as a purely additive version step', () => {
  test('an older file gains the six local tables and both id high-water rows in place', () => {
    const store = open()
    store.putDraft(draft('h1', 204, 'work that must survive the local keyspace arriving'))
    store.setViewed('h1', 204, { 'a.ts': { viewed: true, blobSha: 's', at: 'now' } })
    store.appendAudit(auditEntry({ githubId: 77, pr: 204 }))
    store.recordPrAuthor(204, 'h-priya')
    store.close()

    // A freshly created file already carries both marks: the fresh-file path
    // seeds them, and asserting it here is what keeps that path guarded too.
    expect(metaValue('local_review_id_high_water')).toBe('999999999')
    expect(metaValue('local_entity_id_high_water')).toBe('8999999999999')

    reduceToPreLocalFile()

    // The rows really are gone before the reopen. Without this the "seeded again"
    // assertions below would also be satisfied by a DELETE that never landed.
    expect(metaValue('local_review_id_high_water')).toBeNull()
    expect(metaValue('local_entity_id_high_water')).toBeNull()

    // Reopening runs the guarded step that introduces the local keyspace: the
    // tables are added and the marks re-seeded, and nothing else is read or
    // rewritten, so every earlier table's rows come back byte-identical.
    const reopened = open()
    expect(reopened.getDraft('h1', 204)!.body).toBe(
      'work that must survive the local keyspace arriving',
    )
    expect(reopened.getViewed('h1', 204)['a.ts'].viewed).toBe(true)
    expect(reopened.listAudit()).toHaveLength(1)
    expect(reopened.getPrAuthor(204)).toBe('h-priya')
    reopened.close()

    expect(Number(metaValue('store_version'))).toBe(STORE_VERSION)
    const names = tableNames()
    for (const table of LOCAL_TABLES) expect(names).toContain(table)

    // Each mark is asserted on its OWN line, and that is not stylistic: one
    // assertion covering "the high-water rows are present" stays green with
    // either row missing, and the two rows are read by different callers — one
    // mints review ids, the other the entity ids that live inside stored
    // documents. Either one absent leaves its minter with nothing to bump, and
    // only in upgraded workspaces, so a freshly created one would look fine.
    expect(metaValue('local_review_id_high_water')).toBe('999999999')
    expect(metaValue('local_entity_id_high_water')).toBe('8999999999999')
    // The literals above are one below each band's first legal value, spelled
    // out so a drift in either the seed or the band itself is loud. These two
    // lines record which relation the literals stand for.
    expect(metaValue('local_review_id_high_water')).toBe(String(LOCAL_REVIEW_ID_BASE - 1))
    expect(metaValue('local_entity_id_high_water')).toBe(String(LOCAL_ENTITY_ID_BASE - 1))
  })

  test('the six local tables carry exactly the expected columns, in declaration order', () => {
    const store = open()
    store.close()

    // `PRAGMA table_info` returns columns in DECLARATION order, so comparing the
    // mapped rows as an array pins the order and not merely the membership: a
    // reordering changes what `SELECT *` yields and what a positional INSERT
    // means, and it lands here as a red rather than as a wrong column later.
    //
    // Four facts in this table are load-bearing beyond the names:
    //   - `id` reports `notnull: 0` because `INTEGER PRIMARY KEY` is the rowid
    //     alias. It cannot actually hold NULL — but omitting it on insert makes
    //     SQLite assign 1, a value squarely inside the pull-request number range
    //     this whole keyspace exists to stay out of, so the id is always supplied.
    //   - `generation` must be present and refuse NULL: it is the fourth column
    //     of the unique key and the only escape hatch from an otherwise
    //     one-way branch-pair identity, and nothing in the current behaviour
    //     touches it, so this is the only assertion that can notice it vanish.
    //   - `dirty` refuses NULL and defaults to 0, so a review created before
    //     anything computes worktree state reads as clean rather than unknown.
    //   - `archived_pr` stays nullable with no default: absent means "no pull
    //     request has superseded this review", which is a real state and not a
    //     missing value.
    expect(columnShape('local_reviews')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0, dflt: null, pk: 1 },
      { name: 'repo', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
      { name: 'base_ref', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
      { name: 'head_ref', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
      { name: 'generation', type: 'INTEGER', notnull: 1, dflt: '0', pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
      { name: 'base_sha', type: 'TEXT', notnull: 0, dflt: null, pk: 0 },
      { name: 'merge_base_sha', type: 'TEXT', notnull: 0, dflt: null, pk: 0 },
      { name: 'head_sha', type: 'TEXT', notnull: 0, dflt: null, pk: 0 },
      { name: 'dirty', type: 'INTEGER', notnull: 1, dflt: '0', pk: 0 },
      { name: 'archived_pr', type: 'INTEGER', notnull: 0, dflt: null, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
      { name: 'last_synced_at', type: 'TEXT', notnull: 0, dflt: null, pk: 0 },
    ])

    expect(columnShape('local_snapshots')).toEqual([
      { name: 'local_id', type: 'INTEGER', notnull: 0, dflt: null, pk: 1 },
      { name: 'data', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    ])

    expect(columnShape('local_threads')).toEqual([
      { name: 'local_id', type: 'INTEGER', notnull: 1, dflt: null, pk: 1 },
      { name: 'thread_id', type: 'TEXT', notnull: 1, dflt: null, pk: 2 },
      { name: 'data', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    ])

    // `review_id` is declared INTEGER, never REAL. The ids stored here come from
    // a band around 9e12 — some three orders of magnitude below the largest
    // integer a double represents exactly — so a REAL column would round-trip
    // today's ids with every digit intact and every value-equality assertion
    // green. The two checks see different things: `typeof` is the only detector
    // of a REAL column, and value equality is the only detector of a lossy write
    // into the key column. What makes INTEGER the requirement is not the current
    // band but the one after it: a float stops being exact somewhere above this
    // range, and nothing in the schema would be left to say where.
    expect(columnShape('local_reviews_submitted')).toEqual([
      { name: 'local_id', type: 'INTEGER', notnull: 1, dflt: null, pk: 1 },
      { name: 'review_id', type: 'INTEGER', notnull: 1, dflt: null, pk: 2 },
      { name: 'data', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    ])

    // Both per-human tables index `human_id` FIRST, mirroring the pull-request
    // keyed pair they copy. That is what makes a read for one human cheap and a
    // sweep of everything belonging to one review a scan.
    expect(columnShape('local_drafts')).toEqual([
      { name: 'human_id', type: 'TEXT', notnull: 1, dflt: null, pk: 1 },
      { name: 'local_id', type: 'INTEGER', notnull: 1, dflt: null, pk: 2 },
      { name: 'data', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    ])

    expect(columnShape('local_viewed')).toEqual([
      { name: 'human_id', type: 'TEXT', notnull: 1, dflt: null, pk: 1 },
      { name: 'local_id', type: 'INTEGER', notnull: 1, dflt: null, pk: 2 },
      { name: 'data', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    ])
  })

  test('the step rebuilds no table the earlier versions own', () => {
    const store = open()
    store.putDraft(draft('h1', 204, 'work in a table that must not be rebuilt'))
    store.close()
    reduceToPreLocalFile()

    const before = preLocalDdl()
    // The scanned set needs its own positive control: a capture that silently
    // matched nothing would compare equal to another empty capture and prove
    // exactly nothing about the tables it was supposed to watch.
    expect(before.map((r) => r.name)).toEqual([...PRE_LOCAL_TABLES])

    const reopened = open()
    reopened.close()

    // Byte-identical stored DDL, table for table: no primary key altered and no
    // table rebuilt. A rebuild is how a migration wipes drafts, and SQLite offers
    // no way to widen a primary key without one — which is why the local keyspace
    // is a parallel set of tables instead of a wider key on the existing ones.
    expect(preLocalDdl()).toEqual(before)
  })

  test('the migration ladder carries a guarded step for every version it claims to reach', () => {
    const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')

    // Structural rather than behavioral, and weaker on purpose: it proves the
    // step is WRITTEN, not that it RUNS. The create-when-absent shape at the top
    // of `migrate` runs on every open and the version stamp moves forward
    // regardless, so a version bump with no matching guarded step behaves
    // identically to one with it — no runtime assertion can tell them apart.
    // What the step buys is the next migration: without it there is no record
    // that the shape changed, and a later reordering of `migrate` has nothing to
    // preserve. Expressed as a loop up to the current version so the next bump
    // inherits the pin instead of needing this test rewritten.
    expect(STORE_VERSION).toBeGreaterThanOrEqual(2)
    for (let n = 2; n <= STORE_VERSION; n += 1) {
      // Anchored on the statement, opening brace included, so a docstring that
      // merely describes the guard shape cannot satisfy the pin.
      expect(source).toContain(`if (current < ${n}) {`)
    }
  })
})

describe('local reviews: mint, read, list', () => {
  test('the first mint takes an id from the reserved band, never an auto-assigned rowid', () => {
    const store = open()
    const created = store.createLocalReview(newLocalReview({}))
    store.close()

    // `id INTEGER PRIMARY KEY` is a rowid alias, so an insert that omits the
    // column makes SQLite assign 1 — a value squarely inside the pull-request
    // number range this entire keyspace exists to stay out of, in the one table
    // whose purpose is to stay out of it. The id is therefore always supplied
    // from the high-water mark, and this is the assertion that notices if it
    // stops being.
    expect(created.id).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)
    // The band's first legal value, spelled out: the mark is seeded one below it
    // so the first read-and-bump yields the base exactly.
    expect(created.id).toBe(LOCAL_REVIEW_ID_BASE)
  })

  test('the created review reads back field for field, defaulted where nothing has synced', () => {
    const store = open()
    const created = store.createLocalReview(
      newLocalReview({ repo: 'acme/widgets', title: 'ship the widget' }),
    )
    const read = store.getLocalReview(created.id)
    store.close()

    expect(read).toEqual(created)
    expect(read).toEqual({
      id: LOCAL_REVIEW_ID_BASE,
      repo: 'acme/widgets',
      baseRef: 'refs/heads/main',
      headRef: 'refs/heads/feature/x',
      title: 'ship the widget',
      // Null before the first sync — a real state ("never synced"), not a
      // missing value — and `dirty` false rather than unknown.
      baseSha: null,
      mergeBaseSha: null,
      headSha: null,
      dirty: false,
      archivedPr: null,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      lastSyncedAt: null,
    })
  })

  test('an id no review carries reads back as null, not an error', () => {
    const store = open()
    const absent = store.getLocalReview(LOCAL_REVIEW_ID_BASE + 41)
    store.close()
    expect(absent).toBeNull()
  })

  test('the same repo and branch pair mints once: a second create returns the first row', () => {
    const store = open()
    const first = store.createLocalReview(newLocalReview({ title: 'first' }))
    const second = store.createLocalReview(newLocalReview({ title: 'second' }))
    store.close()

    expect(second.id).toBe(first.id)
    // The existing row is returned verbatim, so the second call's title never
    // lands: creation is idempotent, not an upsert.
    expect(second.title).toBe('first')
    expect(localReviewCount()).toBe(1)
  })

  test('a superseded branch pair returns the superseded review, minting no successor', () => {
    const store = open()
    const original = store.createLocalReview(newLocalReview({}))
    store.close()

    // Mark the review superseded by a pull request through a raw handle: nothing
    // in the store surface writes this column yet, and the one-way-door rule is
    // exactly what a later writer of it depends on. Without this the column has
    // no behavioral assertion at all.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run('UPDATE local_reviews SET archived_pr = 4242 WHERE id = ?', [original.id])
    raw.close()

    const reopened = open()
    const again = reopened.createLocalReview(newLocalReview({}))
    reopened.close()

    // The branch pair keeps the review it already has. A superseded pair minting
    // a successor would give one pair two reviews and leave every caller to guess
    // which one a branch name means.
    expect(again.id).toBe(original.id)
    expect(again.archivedPr).toBe(4242)
    expect(localReviewCount()).toBe(1)
  })

  test('the same branch pair under two repositories are two distinct reviews', () => {
    const store = open()
    const widgets = store.createLocalReview(newLocalReview({ repo: 'acme/widgets' }))
    const gadgets = store.createLocalReview(newLocalReview({ repo: 'acme/gadgets' }))

    // Branch names collide across repositories far more readily than pull-request
    // numbers do, which is why the repository is part of the key from the first
    // row rather than added once someone hits the collision.
    expect(gadgets.id).not.toBe(widgets.id)
    expect(localReviewCount()).toBe(2)

    // And the listing is scoped, so one repository's reviews never surface under
    // another's identity.
    expect(store.listLocalReviews('acme/widgets').map((r) => r.id)).toEqual([widgets.id])
    expect(store.listLocalReviews('acme/gadgets').map((r) => r.id)).toEqual([gadgets.id])
    store.close()
  })

  test('minted ids and their rows survive a close and reopen of the same data dir', () => {
    const store = open()
    const created = store.createLocalReview(newLocalReview({ title: 'survives a restart' }))
    store.close()

    const reopened = open()
    expect(reopened.getLocalReview(created.id)).toEqual(created)
    // Creating the same pair after the reopen still returns the same review: the
    // uniqueness lives on disk, not in a process's memory.
    expect(reopened.createLocalReview(newLocalReview({})).id).toBe(created.id)
    // And the next id continues past it rather than restarting at the base.
    const next = reopened.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/y' }))
    reopened.close()
    expect(next.id).toBeGreaterThan(created.id)
  })

  test('createLocalReview against a closed database throws StoreWriteError', () => {
    const store = open()
    store.close()
    expect(() => store.createLocalReview(newLocalReview({}))).toThrow(StoreWriteError)
  })

  test('two live stores over one data dir mint one review for one branch pair', () => {
    // Two `openDirectStore` handles, both open at once, is as close as one test
    // process gets to two daemons sharing a data directory. What it proves is
    // that the second handle observes the first's committed row and yields to it
    // rather than minting a second review for the same branch pair — the unique
    // key is the serializer, and the row that won is what both callers get back.
    const first = open()
    const second = open()

    const a = first.createLocalReview(newLocalReview({ title: 'from the first handle' }))
    const b = second.createLocalReview(newLocalReview({ title: 'from the second handle' }))

    expect(b.id).toBe(a.id)
    expect(b.title).toBe('from the first handle')
    expect(localReviewCount()).toBe(1)

    first.close()
    second.close()
  })

  test('the mint is one unit: a refused insert leaves the high-water mark where it was', () => {
    const store = open()
    const armed = armLocalReviewInsertTripwire(store)

    const before = metaValue('local_review_id_high_water')
    expect(() => armed.createLocalReview(newLocalReview({}))).toThrow(StoreWriteError)
    armed.close()

    // The mark is read and bumped BEFORE the row is inserted, so the two steps
    // being one transaction is the only thing that keeps a refused insert from
    // leaving the mark ahead of every id in the table. This is the assertion that
    // notices the transaction being dropped: without it the bump commits on its
    // own and the mark walks forward on every failed create.
    expect(metaValue('local_review_id_high_water')).toBe(before)
    expect(localReviewCount()).toBe(0)
  })

  // The next three tests are the corrupt-mark counterpart of the missing-mark
  // refusal the entity allocator carries, and they exist because the two
  // conditions used to part company here. SQLite casts a non-numeric string to 0,
  // so an increment that trusts the stored text resolves to 1 — a value squarely
  // inside the pull-request number range, in the one table whose whole purpose is
  // to stay out of it — inserts a review under it, and writes the 1 back over the
  // unreadable mark. Measured, not assumed: with the mark set to `not-a-number`
  // the mint returned id 1, left one row behind it, and the mark read back as
  // `"1"` afterwards. The claims are split across three bodies because the runner
  // abandons a test at its first failing assertion, and the mark surviving
  // untouched is the half most likely to come back.

  test('a corrupt review id mark refuses the mint rather than minting inside the pull-request range', () => {
    const store = open()
    store.close()
    corruptMarkRaw('local_review_id_high_water', 'not-a-number')

    const reopened = open()
    // `StoreUnreadableError`, not a write failure, and the distinction is the
    // caller's to act on: a write failure is worth retrying, while a mark that
    // cannot be read re-reads the same bytes forever and only a human can repair
    // it. It is the same class this file already gives every other present-but-
    // unparseable row, and the write wrapper carries it out unchanged.
    expect(() => reopened.createLocalReview(newLocalReview({}))).toThrow(StoreUnreadableError)
    reopened.close()
    expect(localReviewCount()).toBe(0)
  })

  test('the refused mint leaves the corrupt review id mark byte for byte as it was found', () => {
    const store = open()
    store.close()
    corruptMarkRaw('local_review_id_high_water', 'not-a-number')

    const reopened = open()
    try {
      reopened.createLocalReview(newLocalReview({}))
    } catch {
      // The refusal is the previous test's claim. What this one watches is the
      // disk afterwards.
    }
    reopened.close()

    // Never reseeded over. A present-but-unreadable value is real state: the file
    // holds it because something put it there, and overwriting it with a
    // fabricated starting value destroys the only evidence of what went wrong
    // while handing out ids that may already have been issued.
    expect(metaValue('local_review_id_high_water')).toBe('not-a-number')
  })

  test('a review id mark of digits below the reserved band is refused, not incremented into it', () => {
    const store = open()
    store.close()
    // Digits, so the charset half of the guard is satisfied and this case can
    // only be refused by the band floor — which is what makes the floor
    // falsifiable rather than decorative. Incrementing this mark would yield 6.
    corruptMarkRaw('local_review_id_high_water', '5')

    const reopened = open()
    expect(() => reopened.createLocalReview(newLocalReview({}))).toThrow(StoreUnreadableError)
    reopened.close()
    expect(metaValue('local_review_id_high_water')).toBe('5')
    expect(localReviewCount()).toBe(0)
  })

  /**
   * Delete the newest local review through a raw handle and return its id.
   *
   * The store has no delete for this table and must not grow one to satisfy a
   * test. Raw is also the honest shape: what is being modelled is a row that is
   * gone while the counter that issued it is not.
   */
  function deleteNewestLocalReviewRaw(id: number): void {
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run('DELETE FROM local_reviews WHERE id = ?', [id])
    raw.close()
  }

  // The next two tests are one claim in two bodies, and the split is load-bearing
  // rather than stylistic: the runner abandons a test at its first failing
  // assertion, so a bookkeeping check sharing a body with the id claim would
  // shadow it and the id claim would never be observed failing on its own.

  test('a deleted id is never re-issued to a later review', () => {
    const store = open()
    const first = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/a' }))
    const second = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/b' }))
    store.close()
    expect(second.id).toBeGreaterThan(first.id)

    deleteNewestLocalReviewRaw(second.id)

    const reopened = open()
    const third = reopened.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/c' }))
    reopened.close()

    // THE assertion that separates a monotonic high-water mark from
    // `MAX(id) + 1`, and the only behavioral one that does: every other claim
    // about minting in this file passes identically under both. `MAX(id) + 1`
    // hands the deleted id straight to this third review, so any per-human draft
    // or viewed row that outlived the delete would be silently adopted by an
    // unrelated review — same id, different branch pair, and no way for a reader
    // to tell which review the text was written against.
    expect(third.id).toBeGreaterThan(second.id)
    expect(third.id).not.toBe(second.id)
  })

  test('deleting a review does not move the high-water mark backwards', () => {
    const store = open()
    store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/a' }))
    const second = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/b' }))
    store.close()

    expect(metaValue('local_review_id_high_water')).toBe(String(second.id))

    deleteNewestLocalReviewRaw(second.id)

    // The mechanism behind the claim above, read straight off disk: the mark is a
    // high-water mark, so removing the row it was last bumped for does not walk it
    // back. A next-id recomputed from the table's contents would drop here.
    expect(metaValue('local_review_id_high_water')).toBe(String(second.id))
  })

  test('the sync patch writes exactly its named fields', () => {
    const store = open()
    const created = store.createLocalReview(
      newLocalReview({ repo: 'acme/widgets', title: 'identity that must not move' }),
    )

    // Age the row's `updated_at` to a fixed past instant through a raw handle.
    // `created_at` and `updated_at` are stamped from the same clock read at
    // creation, so within one test they are the same string — and "the patch
    // moved `updated_at`" would then be unfalsifiable against a patch that wrote
    // nothing. An explicit older value makes the claim deterministic without
    // making the test depend on how long it takes to run.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE local_reviews SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [
      created.id,
    ])
    raw.close()

    const reopened = open()
    reopened.patchLocalReviewSync(created.id, {
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'm'.repeat(40),
      headSha: 'h'.repeat(40),
      dirty: true,
      lastSyncedAt: '2026-03-04T05:06:07.000Z',
    })
    const patched = reopened.getLocalReview(created.id)!
    reopened.close()
    store.close()

    // The six named fields landed.
    expect(patched.baseSha).toBe('b'.repeat(40))
    expect(patched.mergeBaseSha).toBe('m'.repeat(40))
    expect(patched.headSha).toBe('h'.repeat(40))
    expect(patched.dirty).toBe(true)
    expect(patched.lastSyncedAt).toBe('2026-03-04T05:06:07.000Z')
    expect(patched.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')

    // And nothing else did. A sync observes the two refs; it has no business
    // rewriting what the review IS, and a patch that rewrote the title would
    // rename a review behind the back of whoever named it. Compared field by
    // field against the values the create returned, so a rewrite that happens to
    // land the same shape is still red.
    expect(patched.repo).toBe(created.repo)
    expect(patched.baseRef).toBe(created.baseRef)
    expect(patched.headRef).toBe(created.headRef)
    expect(patched.title).toBe(created.title)
    expect(patched.createdAt).toBe(created.createdAt)
    // `archived_pr` is not a sync field either: a review superseded by a pull
    // request must not un-supersede itself the next time the branch is compared.
    expect(patched.archivedPr).toBeNull()
  })

  test('the sync patch against a closed database throws StoreWriteError', () => {
    const store = open()
    const created = store.createLocalReview(newLocalReview({}))
    store.close()
    expect(() => store.patchLocalReviewSync(created.id, syncState())).toThrow(StoreWriteError)
  })

  test('a sync patch for an id no review carries writes nothing', () => {
    const store = open()
    const created = store.createLocalReview(newLocalReview({}))
    const unknown = created.id + 1000

    store.patchLocalReviewSync(unknown, syncState())

    // The update matched no row, so nothing was written and nothing was created:
    // a patch is not a back door into minting a review with a chosen id.
    expect(store.getLocalReview(unknown)).toBeNull()
    expect(store.getLocalReview(created.id)).toEqual(created)
    store.close()
    expect(localReviewCount()).toBe(1)
  })

  test('listLocalReviews returns each review once, oldest first, across a reopen', () => {
    const store = open()
    const a = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/a' }))
    const b = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/b' }))
    const c = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/c' }))
    // A repeated create must not add a second listing entry for the same review.
    store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/b' }))

    // Ascending id, which is creation order because the ids come from a mark that
    // only moves up. The documented order is what a caller renders in.
    //
    // What this pins, exactly: a reversal or a re-ordering onto another column is
    // red. Dropping the ordering clause outright is NOT — `id` is declared
    // `INTEGER PRIMARY KEY`, which makes it the rowid alias, so a table scan
    // already yields ascending id and no arrangement of rows can separate the two.
    // The clause is therefore a statement of the contract rather than the thing
    // that produces it, and the residual is recorded here rather than left for a
    // reader to assume otherwise.
    expect(store.listLocalReviews('acme/widgets').map((r) => r.id)).toEqual([a.id, b.id, c.id])
    store.close()

    const reopened = open()
    expect(reopened.listLocalReviews('acme/widgets').map((r) => r.id)).toEqual([a.id, b.id, c.id])
    // A repository with no reviews lists nothing rather than everything.
    expect(reopened.listLocalReviews('acme/gadgets')).toEqual([])
    reopened.close()
  })
})

describe('the local entity id allocator', () => {
  test('the first value is at the base of the reserved entity band', () => {
    const store = open()
    const first = store.nextLocalEntityId()
    store.close()
    expect(first).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
    expect(first).toBe(LOCAL_ENTITY_ID_BASE)
  })

  // A thousand durable allocations, each its own `UPDATE ... RETURNING` against a
  // store opened with `synchronous = FULL`, so the wall time is a thousand real
  // fsyncs and is set by the disk rather than by the code under test. On a fast
  // local SSD that is a few hundred milliseconds; on a slower or network-backed
  // volume it is an order of magnitude more, which overruns the default per-test
  // limit while nothing is wrong. The explicit budget is what keeps the failure
  // meaning "the allocator stopped working" instead of "this disk is slow" — it
  // is deliberately far above the observed worst case, because a timeout tuned
  // close to the measurement just moves the flake.
  test('a thousand successive calls are strictly increasing safe integers', () => {
    const store = open()
    const issued: number[] = []
    for (let i = 0; i < 1000; i += 1) issued.push(store.nextLocalEntityId())
    store.close()

    for (const id of issued) {
      // The band sits around 9e12: comfortably inside the exactly representable
      // integers, and this is what says so rather than assuming it.
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
    }
    for (let i = 1; i < issued.length; i += 1) {
      expect(issued[i]).toBeGreaterThan(issued[i - 1]!)
    }
    // No value repeated, stated independently of the ordering above: a generator
    // that returned a constant satisfies neither, but a subtler one might satisfy
    // only one.
    expect(new Set(issued).size).toBe(1000)
  }, 30_000)

  test('a reopen continues above the last issued value rather than restarting at the base', () => {
    const store = open()
    let last = 0
    for (let i = 0; i < 5; i += 1) last = store.nextLocalEntityId()
    store.close()

    // The mark is on disk for exactly this reason: an id re-issued after a restart
    // would attach a new comment to whatever already referenced the old one.
    const reopened = open()
    const afterRestart = reopened.nextLocalEntityId()
    reopened.close()
    expect(afterRestart).toBeGreaterThan(last)
    expect(afterRestart).not.toBe(LOCAL_ENTITY_ID_BASE)
  })

  test('the entity mark and the review mark are separate counters', () => {
    const store = open()
    const review = store.createLocalReview(newLocalReview({}))
    const entity = store.nextLocalEntityId()
    store.close()

    // Allocating a review id must not advance the entity mark, or a review
    // created between two comments would leave a hole in the comment ids — and
    // one shared counter would make each band's argument depend on the other's
    // traffic.
    expect(entity).toBe(LOCAL_ENTITY_ID_BASE)
    expect(review.id).toBe(LOCAL_REVIEW_ID_BASE)
    expect(metaValue('local_entity_id_high_water')).toBe(String(LOCAL_ENTITY_ID_BASE))
  })

  test('nextLocalEntityId against a closed database throws StoreWriteError', () => {
    const store = open()
    store.close()
    expect(() => store.nextLocalEntityId()).toThrow(StoreWriteError)
  })

  test('a missing high-water row refuses to allocate rather than fabricating an id', () => {
    const store = open()
    store.nextLocalEntityId()
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("DELETE FROM meta WHERE key = 'local_entity_id_high_water'")
    raw.close()

    // A file whose mark was removed outside this store cannot be allocated from:
    // restarting at the base would hand back an id that has already been issued.
    // Loud beats a fabricated value that collides months later.
    const reopened = open()
    expect(() => reopened.nextLocalEntityId()).toThrow(StoreWriteError)
    reopened.close()
  })

  // A PRESENT mark that cannot be read is the sibling of the missing one above,
  // and it is the more dangerous of the two: an absent row has nothing to
  // destroy, while a corrupt one is real state that a fabricated restart writes
  // over. Measured before the guard existed: with the mark set to `corrupt` this
  // allocator returned 1 and left the mark reading `"1"`, so a locally minted
  // entity id landed in the pull-request number range and the evidence of the
  // corruption was gone in the same statement.

  test('a corrupt entity id mark refuses to allocate rather than restarting inside the pull-request range', () => {
    const store = open()
    store.nextLocalEntityId()
    store.close()
    corruptMarkRaw('local_entity_id_high_water', 'corrupt')

    const reopened = open()
    // Unreadable, not unwritable — the same class every other present-but-
    // unparseable row in this store surfaces, and a different answer from the
    // retryable write failure the missing-mark case above produces.
    expect(() => reopened.nextLocalEntityId()).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('the refused allocation leaves the corrupt entity id mark byte for byte as it was found', () => {
    const store = open()
    store.nextLocalEntityId()
    store.close()
    corruptMarkRaw('local_entity_id_high_water', 'corrupt')

    const reopened = open()
    try {
      reopened.nextLocalEntityId()
    } catch {
      // The refusal is the previous test's claim. What this one watches is the
      // disk afterwards — and this allocator runs its statement with no
      // surrounding transaction, so nothing would roll a stray write back.
    }
    reopened.close()

    expect(metaValue('local_entity_id_high_water')).toBe('corrupt')
  })

  test('an entity id mark of digits with a trailing non-digit is refused, not truncated to its digits', () => {
    const store = open()
    store.nextLocalEntityId()
    store.close()
    // A mark whose leading digits are already inside the band, so incrementing
    // its cast would clear the band floor and hand back a plausible-looking id
    // built from a value nothing wrote. Only the charset half of the guard
    // refuses this one, which is what makes that half falsifiable on its own.
    corruptMarkRaw('local_entity_id_high_water', `${LOCAL_ENTITY_ID_BASE}junk`)

    const reopened = open()
    expect(() => reopened.nextLocalEntityId()).toThrow(StoreUnreadableError)
    reopened.close()
    expect(metaValue('local_entity_id_high_water')).toBe(`${LOCAL_ENTITY_ID_BASE}junk`)
  })
})

/**
 * How long the lock-holding child keeps its transaction open before committing.
 *
 * Long enough that the parent's synchronous store call reliably begins while the
 * lock is still held: the parent enters SQLite within one poll interval of the
 * readiness file appearing, which leaves two orders of magnitude of margin. Short
 * enough that a round of it stays well inside the runner's per-test budget. It is
 * NOT how the two processes synchronise — the parent never sleeps, it waits for
 * the readiness file — it is only how long the held lock outlives that signal.
 */
const LOCK_HOLD_MS = 500

/**
 * How long the parent waits for the child to report that it holds the write lock.
 * Reaching it is a failure with its own message rather than a silent pass: a
 * child that never took the lock leaves the parent's call uncontended, and an
 * uncontended call proves nothing about waiting.
 */
const LOCK_READY_TIMEOUT_MS = 3000

/** How often the parent checks for the child's readiness file. */
const LOCK_READY_POLL_MS = 5

/** The title the lock holder inserts, so a row it wrote is distinguishable. */
const LOCK_HOLDER_TITLE = 'from the lock holder'

/** The human whose preferences the lock holder and this process both patch. */
const LOCK_HOLDER_HUMAN = 'prefs-racer@x.io'

/**
 * The preferences document the lock holder commits. A WHOLE document, because
 * that is what this store's setter writes — it merges a partial patch and then
 * upserts the merged result — so the holder's row is exactly what a second daemon
 * calling `setPreferences({ theme: 'light' })` would leave behind.
 *
 * `theme` is the field that carries the claim: it differs from the default, so a
 * setter that dropped the holder's document reads back as the default rather than
 * as this value.
 */
const LOCK_HOLDER_PREFS: HumanPreferences = {
  diffMode: 'unified',
  theme: 'light',
  inboxView: 'list',
}

/**
 * The lock-holding child, written into the temp data dir and run as its own
 * process.
 *
 * A second process is the only honest shape available. Every store call is
 * synchronous, so a lock held on this thread could never overlap one of them —
 * whatever holds the lock has to run somewhere the parent's blocked call is not.
 *
 * It takes the write lock with `BEGIN IMMEDIATE`, announces that it holds it by
 * creating the readiness file, keeps it for a bounded hold, then commits and
 * records what it wrote. The readiness file is created AFTER the lock is taken,
 * which is what lets the parent start its own call knowing the lock is already
 * held rather than guessing at it with a sleep.
 *
 * Plain JavaScript and outside the package's sources on purpose: it is a fixture
 * the test writes at run time, so nothing type-checks or lints it, and it is
 * removed with the temp directory.
 */
const LOCK_HOLDER_SOURCE = `
import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'

const [dbPath, readyPath, resultPath, holdMs, mode, repo, baseRef, headRef, humanId, prefsJson] =
  process.argv.slice(2)

const bump = (db, key) =>
  Number(
    db
      .query(
        'UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ? RETURNING value',
      )
      .get(key).value,
  )

const db = new Database(dbPath)
// The holder waits too. Only the PARENT's connection is under test here, and a
// parent that happened to hold the lock first should slow this process down
// rather than fail it and turn a real assertion into a spawn error.
db.run('PRAGMA busy_timeout = 5000')
db.run('BEGIN IMMEDIATE')

writeFileSync(readyPath, 'holding')
await Bun.sleep(Number(holdMs))

const entityId = bump(db, 'local_entity_id_high_water')
let reviewId = null
if (mode === 'review') {
  reviewId = bump(db, 'local_review_id_high_water')
  const at = new Date().toISOString()
  db.run(
    'INSERT INTO local_reviews (id, repo, base_ref, head_ref, generation, title, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
    [reviewId, repo, baseRef, headRef, ${JSON.stringify(LOCK_HOLDER_TITLE)}, at, at],
  )
}
if (mode === 'prefs') {
  db.run(
    'INSERT INTO prefs (human_id, data) VALUES (?, ?) ' +
      'ON CONFLICT(human_id) DO UPDATE SET data = excluded.data',
    [humanId, prefsJson],
  )
}
db.run('COMMIT')
db.close()

writeFileSync(resultPath, JSON.stringify({ entityId, reviewId }))
`

/** What the lock-holding child committed, read back after it has exited. */
interface LockHolderCommit {
  entityId: number
  reviewId: number | null
}

/** A child process that is holding the store file's write lock right now. */
interface HeldWriteLock {
  /** What the child committed, once it has exited cleanly. */
  commit(): Promise<LockHolderCommit>
  /** Stop the child and wait for it to be gone, whether or not it committed. */
  release(): Promise<void>
}

/**
 * Spawn the lock holder and return only once it actually holds the write lock.
 *
 * The wait is on the child's readiness file, never on a duration. A sleep long
 * enough to be reliable would make this the slowest test in the file, and a sleep
 * short enough to be quick silently stops overlapping — leaving the parent's call
 * uncontended and every assertion after it vacuous. A file that only exists once
 * `BEGIN IMMEDIATE` has returned says the thing the test actually depends on.
 *
 * `mode` selects what the holder commits: `'entity'` bumps the entity mark alone,
 * `'review'` also mints a review id and inserts the row for `key`, and `'prefs'`
 * also upserts `LOCK_HOLDER_PREFS` for `LOCK_HOLDER_HUMAN`.
 */
async function holdWriteLock(
  mode: 'entity' | 'review' | 'prefs',
  key: NewLocalReview,
): Promise<HeldWriteLock> {
  const scriptPath = join(dir, 'lock-holder.mjs')
  const readyPath = join(dir, `lock-holder-${mode}.ready`)
  const resultPath = join(dir, `lock-holder-${mode}.json`)
  writeFileSync(scriptPath, LOCK_HOLDER_SOURCE)

  const proc = Bun.spawn(
    [
      'bun',
      'run',
      scriptPath,
      join(dir, 'direct.sqlite'),
      readyPath,
      resultPath,
      String(LOCK_HOLD_MS),
      mode,
      key.repo,
      key.baseRef,
      key.headRef,
      LOCK_HOLDER_HUMAN,
      JSON.stringify(LOCK_HOLDER_PREFS),
    ],
    { stdout: 'ignore', stderr: 'inherit' },
  )

  const release = async (): Promise<void> => {
    proc.kill()
    await proc.exited
  }

  const deadline = Date.now() + LOCK_READY_TIMEOUT_MS
  while (!existsSync(readyPath)) {
    if (Date.now() > deadline) {
      await release()
      throw new Error(
        `the lock holder did not report holding the write lock within ${LOCK_READY_TIMEOUT_MS}ms, ` +
          'so nothing would have been contended and the assertions below would prove nothing',
      )
    }
    await Bun.sleep(LOCK_READY_POLL_MS)
  }

  return {
    async commit(): Promise<LockHolderCommit> {
      const code = await proc.exited
      if (code !== 0) {
        throw new Error(`the lock holder exited with code ${code} rather than committing`)
      }
      return JSON.parse(readFileSync(resultPath, 'utf8')) as LockHolderCommit
    },
    release,
  }
}

/** How many rows the store file holds for one branch pair, read through a raw handle. */
function localReviewCountFor(key: NewLocalReview): number {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw
    .query(
      'SELECT COUNT(*) AS n FROM local_reviews WHERE repo = ? AND base_ref = ? AND head_ref = ?',
    )
    .get(key.repo, key.baseRef, key.headRef) as { n: number }
  raw.close()
  return row.n
}

describe('two connections writing at once: the loser waits and yields, never fails', () => {
  // The sequential two-handle test above is NOT this claim. Two handles used one
  // after the other never interleave, so the second one's write always finds the
  // lock free; what it proves is that the unique key serialises, not that a
  // writer arriving mid-transaction survives. Proving that needs a lock genuinely
  // held across the parent's call, and a file-backed store to hold it on —
  // `:memory:` gives every connection its own private database, so a test written
  // against one could not exercise cross-connection locking at all.

  test('an entity id minted against a held write lock waits for the holder rather than failing', async () => {
    const store = open()
    const holder = await holdWriteLock('entity', newLocalReview({}))
    try {
      // Synchronous, and deliberately called while the child's transaction is
      // still open — the only condition under which the busy handler is reached.
      // The whole mint is one autocommit `UPDATE … RETURNING`, so the contention
      // is plain `SQLITE_BUSY`: a connection with a busy timeout retries until
      // the holder commits, and a connection without one is refused outright.
      const mine = store.nextLocalEntityId()
      const child = await holder.commit()

      // Exactly one above the holder's, which is a claim about ORDER and not only
      // about distinctness. A parent that had somehow written first would read a
      // mark the child then bumped again, landing one BELOW it; a parent that
      // waited reads the child's committed value and continues from it. Equality
      // would be the real disaster — the same id handed out twice — and any
      // spelling of "different" rules that out, but only this one also says the
      // wait happened.
      expect(mine).toBe(child.entityId + 1)
    } finally {
      await holder.release()
      store.close()
    }
  })

  test('a create that arrives while another connection holds the lock resolves to the winner row', async () => {
    const store = open()
    const key = newLocalReview({ title: 'from this process' })
    const holder = await holdWriteLock('review', key)
    try {
      // The transaction behind this call READS (the branch-pair lookup) and only
      // then WRITES, which is why a busy timeout alone would not save it: a
      // deferred transaction takes its read snapshot at the lookup, and a commit
      // that lands before the write makes that snapshot stale — a condition
      // SQLite reports without ever calling the busy handler. Taking the write
      // lock at `BEGIN` moves the waiting somewhere the timeout applies.
      const created = store.createLocalReview(key)
      const child = await holder.commit()

      // The row the child wrote, handed back as this call's success. The title is
      // what distinguishes them: both callers asked for the same branch pair with
      // different titles, so a summary carrying the holder's title can only be
      // the holder's row.
      expect(created.id).toBe(child.reviewId)
      expect(created.title).toBe(LOCK_HOLDER_TITLE)
      expect(localReviewCountFor(key)).toBe(1)
      expect(localReviewCount()).toBe(1)

      // The yielding create consumed no review id, so the mark still reads as the
      // holder left it, and the next entity id continues from the holder's rather
      // than skipping one.
      expect(metaValue('local_review_id_high_water')).toBe(String(child.reviewId))
      expect(store.nextLocalEntityId()).toBe(child.entityId + 1)
    } finally {
      await holder.release()
      store.close()
    }
  })

  test('a snapshot persisted against a held write lock waits for the holder rather than failing', async () => {
    const store = open()
    const compareKey = 'contended...snapshot'
    // Both minted and seeded before the lock is taken, so the ONE call made under
    // contention is the snapshot persist itself and nothing else can account for
    // a failure. The seeded row is what makes the persist's read do work: with an
    // immutable half already on disk carrying a `partial`, the transaction reads
    // a value it must carry forward rather than reading an absent row.
    const localId = store.createLocalReview(newLocalReview({})).id
    store.putImmutable(immutable(compareKey), {
      missingBlobShas: [],
      reason: 'capped at N files',
    })
    const holder = await holdWriteLock('entity', newLocalReview({}))
    try {
      // The transaction behind this call READS the immutable row and only then
      // WRITES its two upserts, which is the shape a busy timeout alone does not
      // rescue: a deferred transaction takes its read snapshot at that SELECT and
      // asks for the write lock afterwards, so the holder's commit lands in
      // between and SQLite refuses the upgrade without ever consulting the busy
      // handler. Taking the write lock at `BEGIN` moves the waiting somewhere the
      // timeout applies, so this returns after the holder commits instead of
      // failing in a millisecond.
      //
      // Succeeding IS the assertion. The defect this covers is a thrown
      // `StoreWriteError` for a write that was in fact fine, and the caller's
      // cost is not a slow persist but a review left with threads and a summary
      // and no envelope to name their authors.
      store.putLocalSnapshot(snapshot(localId, compareKey))
      await holder.commit()

      // The envelope is on disk and re-reads whole, so the persist committed
      // rather than half-landing: `getLocalSnapshot` throws if the envelope
      // references an immutable half that is not there.
      expect(store.getLocalSnapshot(localId)?.immutable.compareKey).toBe(compareKey)

      // The contended read did its work. A snapshot whose own `partial` is null
      // must not erase the one the immutable row already carried, and that value
      // only survives if the SELECT inside the transaction ran and was carried
      // into the upsert.
      expect(store.getImmutable(compareKey)?.partial).toEqual({
        missingBlobShas: [],
        reason: 'capped at N files',
      })
    } finally {
      await holder.release()
      store.close()
    }
  })

  test('a preference patch made against a held write lock keeps the key it never set', async () => {
    const store = open()

    // The two keys are DISJOINT, and that is the entire claim. The holder sets
    // `theme`, this process sets `diffMode`, and the setter's contract is that a
    // caller changing one field never overwrites the others. A merge computed
    // from a read taken before the holder committed still writes a whole
    // document, so it carries `diffMode` and silently reverts `theme` — and
    // NOTHING about that write fails, which is why no error-shaped assertion
    // could ever catch it.
    //
    // The guard below keeps the discrimination honest. `light` is evidence that
    // the holder's document survived only while it is NOT also what an unmerged
    // write would have produced; were the default ever to become `light`, this
    // test would start passing for the wrong reason, and this line is what says
    // so instead of quietly going vacuous.
    expect(DEFAULT_PREFERENCES.theme).not.toBe('light')

    const holder = await holdWriteLock('prefs', newLocalReview({}))
    try {
      // Synchronous, and entered while the holder's transaction is still open.
      // Every store call is synchronous, so no other JavaScript can run between
      // this setter's read and its write — the competing writer HAS to be another
      // process, and the interleave is arranged rather than raced for: the holder
      // is known to hold the lock before this line runs, and known to commit
      // while it is still inside SQLite.
      //
      // With the read outside the transaction there is nothing to wait on: a WAL
      // reader never blocks on a writer, so the SELECT returns the last committed
      // state — which does not yet contain the holder's document — and only the
      // upsert waits, on the connection's busy timeout. By the time it lands, the
      // value it merged onto is already out of date. Taking the write lock at
      // `BEGIN` is what moves the waiting AHEAD of the read, so the merge is
      // computed from state the holder has already committed.
      const returned = store.setPreferences(LOCK_HOLDER_HUMAN, { diffMode: 'split' })
      // Throws if the holder exited without committing, so a pass cannot come
      // from a child that never wrote anything to lose.
      await holder.commit()

      // Both keys: the one this call set, and the one it never touched.
      expect(returned.diffMode).toBe('split')
      expect(returned.theme).toBe('light')

      // And the same document is on disk, not merely in the return value — a
      // setter could compute the right merge and still upsert a stale one.
      const persisted = store.getPreferences(LOCK_HOLDER_HUMAN)
      expect(persisted.diffMode).toBe('split')
      expect(persisted.theme).toBe('light')
    } finally {
      await holder.release()
      store.close()
    }
  })
})

/**
 * A snapshot-scoped incompleteness: blob bytes that never arrived. A retry can
 * fix it, so it is NOT a property of the comparison and must never be written
 * onto the forever-cached immutable row.
 */
const BLOBS_MISSING_PARTIAL = {
  missingBlobShas: ['headblob'],
  reason: 'blobs missing: 1 file has no content',
}

/**
 * An incompleteness of the comparison itself. It is a property of the compareKey,
 * outlives any one sync, and is what the immutable row legitimately carries.
 */
const CAPPED_PARTIAL = { missingBlobShas: [], reason: 'capped at N files' }

/** Row counts across the snapshot tables and the shared immutable cache. */
function snapshotTableCounts(): {
  snapshots: number
  local_snapshots: number
  immutables: number
} {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw
    .query(
      'SELECT (SELECT COUNT(*) FROM snapshots) AS snapshots, ' +
        '(SELECT COUNT(*) FROM local_snapshots) AS local_snapshots, ' +
        '(SELECT COUNT(*) FROM immutables) AS immutables',
    )
    .get() as { snapshots: number; local_snapshots: number; immutables: number }
  raw.close()
  return row
}

describe('local snapshots: an envelope of their own, the immutable half shared', () => {
  test('a local snapshot round-trips with its immutable half re-attached', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // The local review's id travels in `prNumber`: what is stored is an unchanged
    // `Snapshot`, which is why the immutable half is byte-identical to the one a
    // pull request over the same comparison would store.
    store.putLocalSnapshot(snapshot(id, 'base...head'))

    const read = store.getLocalSnapshot(id)
    expect(read).not.toBeNull()
    expect(read!.prNumber).toBe(id)
    expect(read!.immutable.compareKey).toBe('base...head')
    expect(read!.immutable.files[0].filename).toBe('a.ts')
    expect(read!.mutable.threads).toEqual([])
    store.close()
  })

  test('a local snapshot survives a restart (reopen the same data dir)', () => {
    const first = open()
    const id = first.createLocalReview(newLocalReview({})).id
    first.putLocalSnapshot(snapshot(id, 'base...head'))
    first.close()

    const second = open()
    expect(second.getLocalSnapshot(id)!.immutable.compareKey).toBe('base...head')
    second.close()
  })

  test('getLocalSnapshot is null (not an error) for a never-synced local review', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // Absent, and absent is the correct empty answer: a review exists but has
    // never been synced, which is the ordinary state right after creation.
    expect(store.getLocalSnapshot(id)).toBeNull()
    store.close()
  })

  test('a local snapshot referencing a missing immutable half throws (corrupt, not absent)', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'base...head'))
    store.close()

    // Delete the immutable half out from under the envelope.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("DELETE FROM immutables WHERE compare_key = 'base...head'")
    raw.close()

    // A corrupt store stays loud at this layer. Offering a graceful "the objects
    // are gone, re-sync to rebuild" state is a job for a layer that can act on it;
    // softening the error here would hand that layer a snapshot with a fabricated
    // empty immutable half and no way to tell it from a real one.
    const reopened = open()
    expect(() => reopened.getLocalSnapshot(id)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('a present-but-corrupt local snapshot row throws rather than reading as absent', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'base...head'))
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE local_snapshots SET data = '{not valid json' WHERE local_id = ?", [id])
    raw.close()

    const reopened = open()
    expect(() => reopened.getLocalSnapshot(id)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('the immutable row keeps its OWN partial; the envelope carries the merged one', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // The cold path already recorded the immutable half's own incompleteness.
    store.putImmutable(immutable('base...head'), CAPPED_PARTIAL)

    // The snapshot's `partial` is a MERGE: the comparison's own incompleteness
    // plus a snapshot-scoped one. Only the merged value belongs on the envelope.
    store.putLocalSnapshot({ ...snapshot(id, 'base...head'), partial: BLOBS_MISSING_PARTIAL })

    // What the caller sees is the merged value, verbatim.
    expect(store.getLocalSnapshot(id)!.partial).toEqual(BLOBS_MISSING_PARTIAL)

    // The immutable row keeps what it already held. Writing the merged value here
    // would pin a blob-missing reason to a compareKey that is cached forever with
    // no TTL, so the next reader of that key — long after those blobs were
    // provisioned — would resurrect a truncation that stopped being true, and
    // nothing downstream could tell it from a fresh one.
    expect(store.getImmutable('base...head')!.partial).toEqual(CAPPED_PARTIAL)
    store.close()
  })

  test('putLocalSnapshot writes local_snapshots and immutables, and no PR-keyed table', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // Armed BEFORE the write, so a misrouted statement aborts at the statement
    // rather than being counted afterwards. A `COUNT(*) === 0` on its own cannot
    // tell a table nothing wrote from one that was written and then cleaned up,
    // and says nothing at all about a write inside a transaction that rolled back.
    const armed = armPrKeyedTripwires(store)
    armed.putLocalSnapshot(snapshot(id, 'base...head'))
    // The write completed rather than being silently skipped, which is what makes
    // the zero below an absence and not merely an untaken code path.
    expect(armed.getLocalSnapshot(id)!.immutable.compareKey).toBe('base...head')
    armed.close()

    // The envelope is local; the immutable half is shared and stored exactly once.
    expect(snapshotTableCounts()).toEqual({
      snapshots: 0,
      local_snapshots: 1,
      immutables: 1,
    })
  })

  test('a local snapshot and a pull request over one comparison share the stored immutable half', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putSnapshot(snapshot(204, 'base...head'))
    store.putLocalSnapshot(snapshot(id, 'base...head'))

    // The compareKey is the whole key: neither side knows or cares whether the
    // comparison came from a pull request, so the expensive half is stored once
    // and both envelopes reference it.
    expect(store.getSnapshot(204)!.immutable.compareKey).toBe('base...head')
    expect(store.getLocalSnapshot(id)!.immutable.compareKey).toBe('base...head')
    store.close()

    expect(snapshotTableCounts()).toEqual({
      snapshots: 1,
      local_snapshots: 1,
      immutables: 1,
    })
  })

  test('putLocalSnapshot against a closed database throws StoreWriteError', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.close()
    expect(() => store.putLocalSnapshot(snapshot(id, 'base...head'))).toThrow(StoreWriteError)
  })

  test('a local snapshot write over a corrupt immutable row refuses rather than overwriting it', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putImmutable(immutable('base...head'))
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE immutables SET data = '{not valid json' WHERE compare_key = 'base...head'")
    raw.close()

    // The same refusal a pull request's snapshot write gets, because it is the
    // same statement: the local path reuses the shared immutable cache, so it
    // inherits the rule that a present-but-unreadable row is never written over,
    // and it inherits the error type that says so rather than a retryable one.
    const reopened = open()
    expect(() => reopened.putLocalSnapshot(snapshot(id, 'base...head'))).toThrow(
      StoreUnreadableError,
    )
    // Refused whole: the envelope did not land either, so no local snapshot points
    // at an immutable half that was never written.
    expect(reopened.getLocalSnapshot(id)).toBeNull()
    reopened.close()

    // The corrupt bytes are still exactly as they were. This is the claim that
    // matters: a refused write must not have consumed the state it refused to
    // parse, or the row a human still has to repair is gone.
    const check = new Database(join(dir, 'direct.sqlite'))
    const row = check
      .query("SELECT data FROM immutables WHERE compare_key = 'base...head'")
      .get() as { data: string }
    check.close()
    expect(row.data).toBe('{not valid json')
  })
})

/**
 * A review thread as stored: an unchanged contract document. The id and the
 * resolved flag are the two fields every claim below turns on — the id is the
 * key, and the flag is what a resolve rewrites.
 */
function localThread(id: string, over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'a.ts',
    line: 3,
    originalLine: 3,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [],
    ...over,
  }
}

/** A submitted review summary as stored: an unchanged contract document. */
function submittedReview(id: number, over: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    id,
    node_id: `local:review:${id}`,
    user: {
      login: 'alice',
      id: 1,
      node_id: 'U_1',
      avatar_url: '',
      html_url: '',
      type: 'User',
    },
    body: 'looks good',
    state: 'COMMENTED',
    submitted_at: '2026-01-01T00:00:00.000Z',
    commit_id: 'head',
    ...over,
  }
}

/**
 * Three thread ids whose alphabetical order is NOT their insertion order.
 *
 * Load-bearing rather than decorative. The composite primary key indexes
 * `local_id` first and `thread_id` second, so an unordered read already comes
 * back sorted by thread id — with ids that happen to be inserted alphabetically,
 * a list ordered by insertion and a list ordered by nothing at all are the same
 * list, and the order assertion would hold with the ordering clause deleted.
 */
const THREAD_IDS_OUT_OF_ALPHABETICAL_ORDER = ['t-c', 't-a', 't-b']

/**
 * Three submitted-review ids whose ascending-id order is NOT their insertion
 * order, for the same reason the thread ids above are out of alphabetical order.
 */
const SUBMITTED_IDS_OUT_OF_ASCENDING_ORDER = [
  LOCAL_ENTITY_ID_BASE + 9,
  LOCAL_ENTITY_ID_BASE + 3,
  LOCAL_ENTITY_ID_BASE + 5,
]

/** How many rows one local table holds for one local review, read through a raw handle. */
function localRowCount(table: 'local_threads' | 'local_reviews_submitted', localId: number): number {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw
    .query(`SELECT COUNT(*) AS n FROM ${table} WHERE local_id = ?`)
    .get(localId) as { n: number }
  raw.close()
  return row.n
}

describe('local threads: keyed by review and by thread, rewritten in place', () => {
  test('a thread round-trips through the point read and through the list', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    const thread = localThread('t-1', { comments: [] })
    store.putLocalThread(id, thread)

    // The stored document is an unchanged `ReviewThread`, so the whole document
    // is pinned rather than a field or two: a getter that reconstructed a thread
    // from columns instead of returning what was stored would pass a spot check
    // on the id and fail this.
    expect(store.getLocalThread(id, 't-1')).toEqual(thread)
    expect(store.listLocalThreads(id)).toEqual([thread])
    store.close()
  })

  test('a thread survives a restart (reopen the same data dir)', () => {
    const first = open()
    const id = first.createLocalReview(newLocalReview({})).id
    first.putLocalThread(id, localThread('t-1'))
    first.close()

    const second = open()
    expect(second.getLocalThread(id, 't-1')!.path).toBe('a.ts')
    second.close()
  })

  test('getLocalThread is null for a thread that was never stored', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // Absent is the correct empty answer, not an error: a review with no threads
    // on it is the ordinary state right after creation.
    expect(store.getLocalThread(id, 't-missing')).toBeNull()
    store.close()
  })

  test('listLocalThreads is empty for a review with no threads on it', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // Its own test rather than a second assertion beside the point read: the
    // runner stops at the first failed assertion, so two empty-answer claims
    // sharing one body means only the first is ever observed failing.
    expect(store.listLocalThreads(id)).toEqual([])
    store.close()
  })

  test('a second put for the same thread leaves exactly one row', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalThread(id, localThread('t-1'))
    store.putLocalThread(id, localThread('t-1', { isResolved: true, resolvedBy: { login: 'a' } }))

    // Resolving a thread rewrites the same thread. A second row under the same
    // id would render that thread twice, once in each state, and nothing in the
    // read path could tell which of the two is current.
    expect(localRowCount('local_threads', id)).toBe(1)
    store.close()
  })

  test('a second put for the same thread is what the read gives back', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalThread(id, localThread('t-1'))
    store.putLocalThread(id, localThread('t-1', { isResolved: true, resolvedBy: { login: 'a' } }))

    // Split from the row-count claim above deliberately, not stylistically: the
    // runner stops a test at its first failed assertion, so two claims sharing
    // one body means the second is never independently observed failing.
    expect(store.getLocalThread(id, 't-1')!.isResolved).toBe(true)
    expect(store.listLocalThreads(id).map((t) => t.isResolved)).toEqual([true])
    store.close()
  })

  test('rewriting a thread keeps its place in the list rather than moving it to the end', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalThread(id, localThread('t-c'))
    store.putLocalThread(id, localThread('t-a'))
    store.putLocalThread(id, localThread('t-c', { isResolved: true }))

    // A list that reordered on every resolve would move a thread out from under
    // a reader mid-review, which is why the write updates the row in place
    // instead of removing and re-adding it.
    expect(store.listLocalThreads(id).map((t) => t.id)).toEqual(['t-c', 't-a'])
    store.close()
  })

  test('a thread on one local review is invisible to the point read on another', () => {
    const store = open()
    const a = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/a' })).id
    const b = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/b' })).id
    store.putLocalThread(a, localThread('t-1'))

    // A thread id is opaque and nothing parses it, so nothing makes one unique
    // across reviews. A read keyed on the thread id alone would answer this with
    // the other review's thread — the same id, a different review's discussion.
    expect(store.getLocalThread(b, 't-1')).toBeNull()
    store.close()
  })

  test('a thread on one local review is invisible to the list on another', () => {
    const store = open()
    const a = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/a' })).id
    const b = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/b' })).id
    store.putLocalThread(a, localThread('t-1'))

    // Its own test rather than a second assertion beside the point read: the two
    // readers are two statements with two predicates, and one can lose its
    // review-id filter while the other keeps it.
    //
    // The positive control runs FIRST and the absence last, deliberately. An
    // absence assertion passes vacuously when the fixture never stored anything,
    // so the claim that the thread IS on review `a` has to be checked while the
    // runner is still executing assertions.
    expect(store.listLocalThreads(a).map((t) => t.id)).toEqual(['t-1'])
    expect(store.listLocalThreads(b)).toEqual([])
    store.close()
  })

  test('a present-but-corrupt thread row throws rather than reading as absent', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalThread(id, localThread('t-1'))
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE local_threads SET data = '{not valid json' WHERE thread_id = 't-1'")
    raw.close()

    const reopened = open()
    expect(() => reopened.getLocalThread(id, 't-1')).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('a present-but-corrupt thread row throws rather than shortening the list', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalThread(id, localThread('t-1'))
    store.putLocalThread(id, localThread('t-2'))
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE local_threads SET data = '{not valid json' WHERE thread_id = 't-1'")
    raw.close()

    // Skipping the unreadable row would hand back a shorter list that reads as
    // complete — a review with one fewer discussion than it has, and no signal
    // that anything is wrong.
    const reopened = open()
    expect(() => reopened.listLocalThreads(id)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('threads list in insertion order, and that order survives a close and reopen', () => {
    const first = open()
    const id = first.createLocalReview(newLocalReview({})).id
    for (const threadId of THREAD_IDS_OUT_OF_ALPHABETICAL_ORDER) {
      first.putLocalThread(id, localThread(threadId))
    }
    expect(first.listLocalThreads(id).map((t) => t.id)).toEqual(
      THREAD_IDS_OUT_OF_ALPHABETICAL_ORDER,
    )
    first.close()

    // Insertion order is a stored property (the row's position in the table), not
    // a property of the handle that wrote the rows, so a restart must not resort
    // the list into whatever the index happens to yield.
    const second = open()
    expect(second.listLocalThreads(id).map((t) => t.id)).toEqual(
      THREAD_IDS_OUT_OF_ALPHABETICAL_ORDER,
    )
    second.close()
  })

  test('putLocalThread against a closed database throws StoreWriteError', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.close()
    expect(() => store.putLocalThread(id, localThread('t-1'))).toThrow(StoreWriteError)
  })

  test('putLocalThread writes local_threads and no PR-keyed table', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // Armed BEFORE the write, so a misrouted statement aborts at the statement
    // rather than being counted absent afterwards.
    const armed = armPrKeyedTripwires(store)
    armed.putLocalThread(id, localThread('t-1'))
    // The write completed rather than being silently skipped, which is what makes
    // the survived tripwires mean something.
    expect(armed.getLocalThread(id, 't-1')!.id).toBe('t-1')
    armed.close()
  })
})

describe('local submitted reviews: recorded per review, ids kept exact', () => {
  test('a submitted review round-trips through the list', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    const review = submittedReview(LOCAL_ENTITY_ID_BASE + 1)
    store.putLocalSubmittedReview(id, review)

    // The whole document, not a field or two: what is stored is an unchanged
    // `ReviewSummary` and a reader gets back exactly what was written.
    expect(store.listLocalSubmittedReviews(id)).toEqual([review])
    store.close()
  })

  test('a submitted review survives a restart (reopen the same data dir)', () => {
    const first = open()
    const id = first.createLocalReview(newLocalReview({})).id
    first.putLocalSubmittedReview(id, submittedReview(LOCAL_ENTITY_ID_BASE + 1))
    first.close()

    const second = open()
    expect(second.listLocalSubmittedReviews(id).map((r) => r.state)).toEqual(['COMMENTED'])
    second.close()
  })

  test('listLocalSubmittedReviews is empty for a review nobody has submitted against', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    // Empty is the answer, never an error: a local review with no submissions is
    // the ordinary state right after creation.
    expect(store.listLocalSubmittedReviews(id)).toEqual([])
    store.close()
  })

  test('a second put for the same summary id leaves exactly one row', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    const reviewId = LOCAL_ENTITY_ID_BASE + 1
    store.putLocalSubmittedReview(id, submittedReview(reviewId))
    store.putLocalSubmittedReview(id, submittedReview(reviewId, { state: 'APPROVED' }))

    expect(localRowCount('local_reviews_submitted', id)).toBe(1)
    store.close()
  })

  test('a second put for the same summary id is what the read gives back', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    const reviewId = LOCAL_ENTITY_ID_BASE + 1
    store.putLocalSubmittedReview(id, submittedReview(reviewId))
    store.putLocalSubmittedReview(id, submittedReview(reviewId, { state: 'APPROVED' }))

    // Split from the row-count claim for the same reason the thread pair is: the
    // runner stops at the first failed assertion in a body.
    expect(store.listLocalSubmittedReviews(id).map((r) => r.state)).toEqual(['APPROVED'])
    store.close()
  })

  test('submitted reviews on one local review are invisible to another', () => {
    const store = open()
    const a = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/a' })).id
    const b = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/b' })).id
    store.putLocalSubmittedReview(a, submittedReview(LOCAL_ENTITY_ID_BASE + 1))

    // Summary ids come from one allocator shared by every local review, so an id
    // never collides across reviews — but a read that dropped its review filter
    // would still pool every review's submissions into one list.
    //
    // Positive control first, absence last: an empty list proves nothing while
    // the fixture might have stored nothing.
    expect(store.listLocalSubmittedReviews(a)).toHaveLength(1)
    expect(store.listLocalSubmittedReviews(b)).toEqual([])
    store.close()
  })

  test('a present-but-corrupt submitted review row throws rather than reading as absent', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSubmittedReview(id, submittedReview(LOCAL_ENTITY_ID_BASE + 1))
    store.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE local_reviews_submitted SET data = '{not valid json' WHERE local_id = ?", [id])
    raw.close()

    // An empty list here would read as "this human never submitted a review",
    // which is exactly the state a caller would then overwrite.
    const reopened = open()
    expect(() => reopened.listLocalSubmittedReviews(id)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('submitted reviews list in insertion order, and that order survives a close and reopen', () => {
    const first = open()
    const id = first.createLocalReview(newLocalReview({})).id
    for (const reviewId of SUBMITTED_IDS_OUT_OF_ASCENDING_ORDER) {
      first.putLocalSubmittedReview(id, submittedReview(reviewId))
    }
    expect(first.listLocalSubmittedReviews(id).map((r) => r.id)).toEqual(
      SUBMITTED_IDS_OUT_OF_ASCENDING_ORDER,
    )
    first.close()

    const second = open()
    expect(second.listLocalSubmittedReviews(id).map((r) => r.id)).toEqual(
      SUBMITTED_IDS_OUT_OF_ASCENDING_ORDER,
    )
    second.close()
  })

  test('a summary id from the entity band reads back as the exact same number', () => {
    const first = open()
    const id = first.createLocalReview(newLocalReview({})).id
    const reviewId = LOCAL_ENTITY_ID_BASE + 7
    first.putLocalSubmittedReview(id, submittedReview(reviewId))
    first.close()

    // Read after a reopen, so the number crossed the disk rather than being
    // handed back out of the handle that wrote it. Measured as SUBSUMED by the
    // round-trip case above, which pins the whole document: every defect that
    // reaches the id inside the stored JSON turns both red. It is kept because it
    // is the read a caller actually performs, and because the column read below
    // proves nothing about what the caller receives.
    const second = open()
    expect(second.listLocalSubmittedReviews(id)[0].id).toBe(reviewId)
    second.close()

    // The same value read straight out of the key column, not out of the JSON
    // document beside it — and this half is NOT subsumed. The document is text
    // and holds whatever digits were written into it; the column is typed, is
    // what a later lookup keys on, and is where a value that went through a
    // lossy conversion on the way to disk would land short.
    const raw = new Database(join(dir, 'direct.sqlite'))
    const row = raw
      .query('SELECT review_id FROM local_reviews_submitted WHERE local_id = ?')
      .get(id) as { review_id: number }
    raw.close()
    expect(row.review_id).toBe(reviewId)
  })

  test('the key column stores an integer, never a float', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSubmittedReview(id, submittedReview(LOCAL_ENTITY_ID_BASE + 7))
    store.close()

    // The value-equality assertion above CANNOT catch a REAL column at this
    // magnitude: an id near 9e12 is three orders of magnitude below the largest
    // integer a double represents exactly, so it round-trips through a float with
    // every digit intact and every equality check green. What a REAL column
    // changes is the stored type — and it is the stored type that decides what
    // happens when the band, or the arithmetic done on an id, later grows past
    // where doubles stay exact. Only `typeof` can see that today, which is why
    // this assertion is separate from the one above rather than folded into it.
    const raw = new Database(join(dir, 'direct.sqlite'))
    const row = raw
      .query('SELECT typeof(review_id) AS ty FROM local_reviews_submitted WHERE local_id = ?')
      .get(id) as { ty: string }
    raw.close()
    expect(row.ty).toBe('integer')
  })

  test('putLocalSubmittedReview against a closed database throws StoreWriteError', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.close()
    expect(() =>
      store.putLocalSubmittedReview(id, submittedReview(LOCAL_ENTITY_ID_BASE + 1)),
    ).toThrow(StoreWriteError)
  })

  test('putLocalSubmittedReview writes local_reviews_submitted and no PR-keyed table', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    const armed = armPrKeyedTripwires(store)
    armed.putLocalSubmittedReview(id, submittedReview(LOCAL_ENTITY_ID_BASE + 1))
    expect(armed.listLocalSubmittedReviews(id)).toHaveLength(1)
    armed.close()
  })
})

/**
 * The six tables a local review's rows live in, each with the column that names
 * the review, spelled out rather than derived from the store's own statements.
 *
 * A count taken through the same list the delete loops over would agree with the
 * delete however wrong the delete became — a table dropped from both would read
 * as an empty table nobody had to clean. These are literals, so a table the
 * delete stops naming still gets counted here and still has to come back zero.
 */
const LOCAL_TABLES_BY_REVIEW: readonly { table: string; column: string }[] = [
  { table: 'local_reviews', column: 'id' },
  { table: 'local_snapshots', column: 'local_id' },
  { table: 'local_threads', column: 'local_id' },
  { table: 'local_reviews_submitted', column: 'local_id' },
  { table: 'local_drafts', column: 'local_id' },
  { table: 'local_viewed', column: 'local_id' },
]

/**
 * Raw per-table row counts for one local review id, read through a handle of its
 * own rather than through the store.
 *
 * Raw on purpose. Every store read is keyed through the review row, so once that
 * row is gone the store cannot see a leftover envelope or a leftover thread at
 * all — asking it would return the same empty answer whether the rows were
 * removed or merely orphaned. Only a direct count distinguishes the two, and
 * "orphaned" is exactly the failure a single delete statement produces.
 */
function localRowCounts(id: number): Record<string, number> {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const counts: Record<string, number> = {}
  for (const { table, column } of LOCAL_TABLES_BY_REVIEW) {
    const row = raw
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(id) as { n: number }
    counts[table] = row.n
  }
  raw.close()
  return counts
}

/**
 * Populate every one of the six local tables for one branch pair and return the
 * review's id. Two humans hold a draft and viewed state, because the drafts and
 * viewed rows are keyed by the human as well as the review and a delete narrowed
 * to one human would still look complete with only one human present.
 */
function seedEveryLocalTable(store: DirectStore, over: Partial<NewLocalReview> = {}): number {
  const id = store.createLocalReview(newLocalReview(over)).id
  store.putLocalSnapshot(snapshot(id, `base...head-${id}`))
  store.putLocalThread(id, localThread('t-a'))
  store.putLocalThread(id, localThread('t-b'))
  store.putLocalSubmittedReview(id, submittedReview(LOCAL_ENTITY_ID_BASE + id))
  store.putLocalDraft(draft('h1', id, 'unsubmitted text belonging to h1'))
  store.putLocalDraft(draft('h2', id, 'unsubmitted text belonging to h2'))
  store.setLocalViewed('h1', id, { 'a.ts': { viewed: true, blobSha: 'headblob', at: 'now' } })
  store.setLocalViewed('h2', id, { 'a.ts': { viewed: true, blobSha: 'headblob', at: 'now' } })
  return id
}

/**
 * Arm a single aborting trigger on one local table's DELETE and return a freshly
 * opened store, so a removal fails partway through its transaction while the
 * statements before it have already run.
 *
 * This is the negative control for atomicity. "All six tables emptied together"
 * is only worth something while a delete that emptied five of them would be
 * observably rolled back, and nothing a caller can pass makes one of the six
 * statements fail on its own.
 */
function armLocalDeleteTripwire(store: DirectStore, table: string): DirectStore {
  store.close()
  const raw = new Database(join(dir, 'direct.sqlite'))
  raw.run(
    `CREATE TRIGGER refuse_delete_${table} BEFORE DELETE ON ${table} ` +
      `BEGIN SELECT RAISE(ABORT, 'refused: DELETE on ${table}'); END`,
  )
  raw.close()
  return open()
}

describe("listing every human's draft on one local review", () => {
  test('answers both humans, ordered by human id, and nothing from another review', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    const other = seedEveryLocalTable(store, { headRef: 'refs/heads/feature/y', title: 'y' })

    // Two humans, as the seed writes them, and only this review's — the other
    // review's rows are keyed to a different id and must not bleed in.
    expect(store.listLocalDrafts(id).map((d) => [d.humanId, d.prNumber])).toEqual([
      ['h1', id],
      ['h2', id],
    ])
    expect(store.listLocalDrafts(other).map((d) => d.prNumber)).toEqual([other, other])
    store.close()
  })

  test('a review nobody has drafted on, and an id that names no review, both read back empty', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    expect(store.listLocalDrafts(id)).toEqual([])
    expect(store.listLocalDrafts(LOCAL_REVIEW_ID_BASE + 9999)).toEqual([])
    store.close()
  })

  test('a draft row that cannot be parsed fails the whole listing rather than being left out', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    store.close()

    // One of the two rows corrupted in place. A listing that skipped it would
    // report one draft where two exist, and a caller deciding whether the
    // review still holds text would decide on the wrong count.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run('UPDATE local_drafts SET data = ? WHERE human_id = ? AND local_id = ?', [
      'not json',
      'h2',
      id,
    ])
    raw.close()

    const reopened = open()
    expect(() => reopened.listLocalDrafts(id)).toThrow(StoreUnreadableError)
    reopened.close()
  })
})

describe('removing a local review takes all six of its tables, or none of them', () => {
  test('every one of the six local tables gives up its rows for that review', () => {
    const store = open()
    const id = seedEveryLocalTable(store)

    // Pinned before the delete, so the assertion after it is against rows that
    // demonstrably existed rather than against a table that was empty all along.
    expect(localRowCounts(id)).toEqual({
      local_reviews: 1,
      local_snapshots: 1,
      local_threads: 2,
      local_reviews_submitted: 1,
      local_drafts: 2,
      local_viewed: 2,
    })

    store.deleteLocalReview(id)
    store.close()

    expect(localRowCounts(id)).toEqual({
      local_reviews: 0,
      local_snapshots: 0,
      local_threads: 0,
      local_reviews_submitted: 0,
      local_drafts: 0,
      local_viewed: 0,
    })
  })

  test('the returned counts equal the rows that existed', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    const removed = store.deleteLocalReview(id)
    store.close()

    // The counts are the evidence a caller has that the delete reached every
    // table, so they are asserted as an exact record and not merely as
    // "something was removed". Two threads, two humans' drafts and two humans'
    // viewed rows, so a count that silently collapsed to one-per-table is red.
    expect(removed).toEqual({
      reviewsDeleted: 1,
      snapshotsDeleted: 1,
      threadsDeleted: 2,
      submittedReviewsDeleted: 1,
      draftsDeleted: 2,
      viewedDeleted: 2,
    })
  })

  test('every read of the removed review answers empty-or-null, for both humans', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    store.deleteLocalReview(id)

    expect(store.getLocalReview(id)).toBeNull()
    expect(store.getLocalSnapshot(id)).toBeNull()
    expect(store.getLocalDraft('h1', id)).toBeNull()
    expect(store.getLocalDraft('h2', id)).toBeNull()
    expect(store.getLocalViewed('h1', id)).toEqual({})
    expect(store.getLocalViewed('h2', id)).toEqual({})
    expect(store.listLocalThreads(id)).toEqual([])
    expect(store.getLocalThread(id, 't-a')).toBeNull()
    expect(store.listLocalSubmittedReviews(id)).toEqual([])
    expect(store.getLocalCommentAuthors(id)).toEqual({})
    expect(store.listLocalReviews('acme/widgets')).toEqual([])
    store.close()
  })

  test('a second, unrelated local review keeps every one of its rows', () => {
    const store = open()
    const doomed = seedEveryLocalTable(store)
    const kept = seedEveryLocalTable(store, { headRef: 'refs/heads/feature/y', title: 'y' })

    store.deleteLocalReview(doomed)

    expect(localRowCounts(kept)).toEqual({
      local_reviews: 1,
      local_snapshots: 1,
      local_threads: 2,
      local_reviews_submitted: 1,
      local_drafts: 2,
      local_viewed: 2,
    })
    expect(store.getLocalReview(kept)!.headRef).toBe('refs/heads/feature/y')
    expect(store.getLocalDraft('h1', kept)!.body).toBe('unsubmitted text belonging to h1')
    expect(store.getLocalDraft('h2', kept)!.body).toBe('unsubmitted text belonging to h2')
    expect(store.listLocalThreads(kept).map((t) => t.id)).toEqual(['t-a', 't-b'])
    expect(store.listLocalSubmittedReviews(kept)).toHaveLength(1)
    expect(store.getLocalViewed('h1', kept)['a.ts']!.viewed).toBe(true)
    expect(store.listLocalReviews('acme/widgets').map((r) => r.id)).toEqual([kept])
    store.close()
  })

  test('deleting an id that was never created is a no-op returning all-zero counts', () => {
    const store = open()
    const kept = seedEveryLocalTable(store)

    // Never minted, and deliberately inside the reserved local band so the id is
    // the shape a caller would really pass rather than a value the statement
    // could reject on sight.
    const removed = store.deleteLocalReview(LOCAL_REVIEW_ID_BASE + 9999)

    expect(removed).toEqual({
      reviewsDeleted: 0,
      snapshotsDeleted: 0,
      threadsDeleted: 0,
      submittedReviewsDeleted: 0,
      draftsDeleted: 0,
      viewedDeleted: 0,
    })
    // Idempotent rather than an error: a retried removal has to be safe, and
    // "already gone" is the outcome the caller wanted. Nothing else moved.
    expect(store.getLocalReview(kept)!.id).toBe(kept)
    store.close()
  })

  test('deleting the same review twice is safe: the second call removes nothing', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    expect(store.deleteLocalReview(id).reviewsDeleted).toBe(1)
    expect(store.deleteLocalReview(id)).toEqual({
      reviewsDeleted: 0,
      snapshotsDeleted: 0,
      threadsDeleted: 0,
      submittedReviewsDeleted: 0,
      draftsDeleted: 0,
      viewedDeleted: 0,
    })
    store.close()
  })

  test('the removed id is never minted again, so no row can be adopted by a later review', () => {
    const store = open()
    const removed = seedEveryLocalTable(store)
    store.deleteLocalReview(removed)

    // The high-water mark only moves up, so the next review gets a fresh id even
    // though the previous one is free. That is what makes a delete that missed a
    // row a leak rather than a corruption: an orphan can never be adopted.
    const next = store.createLocalReview(newLocalReview({ headRef: 'refs/heads/feature/z' }))
    expect(next.id).toBeGreaterThan(removed)
    store.close()
  })

  test('the shared immutable half and the blobs are left alone: no cascade from a review', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    const compareKey = `base...head-${id}`
    store.putBlobs([{ sha: 'headblob', path: 'a.ts', content: 'v1', size: 2, binary: false }])

    store.deleteLocalReview(id)

    // Content-addressed and shared — the same compare key can back a pull
    // request and other local reviews — so removing one here would be a cascade
    // into storage this review does not own. Whether a cached half is still
    // needed is a question about references across the whole store.
    expect(store.getImmutable(compareKey)).not.toBeNull()
    expect(store.hasBlob('headblob')).toBe(true)
    store.close()
  })

  test('deleteLocalReview against a closed database throws StoreWriteError', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    store.close()
    // A removal that cannot reach disk must surface as a typed persist failure,
    // never as a success reporting counts nothing wrote.
    expect(() => store.deleteLocalReview(id)).toThrow(StoreWriteError)
  })

  test('a refused statement rolls the whole removal back: five tables do not go alone', () => {
    const store = open()
    const id = seedEveryLocalTable(store)
    const before = localRowCounts(id)

    // `local_viewed` is the LAST of the six statements, so every other delete has
    // already run inside the transaction when this one aborts. Anything less than
    // a full rollback leaves five emptied tables behind.
    const armed = armLocalDeleteTripwire(store, 'local_viewed')
    const err = writeErrorFrom(() => {
      armed.deleteLocalReview(id)
    })
    armed.close()

    expect(err.table).toBe('local_reviews+dependents')
    expect(err.message).toContain('refused: DELETE on local_viewed')
    // Byte for byte what it was: a removal that failed removed nothing.
    expect(localRowCounts(id)).toEqual(before)
  })
})

/**
 * Run `fn` and return the `StoreUnreadableError` it threw.
 *
 * The CLASS is the assertion, not the fact of throwing, and the two are easy to
 * confuse here because both failures throw. A row this store cannot read
 * honestly is a `StoreUnreadableError`, which the daemon answers as a failed
 * persist; a raw driver error escaping the same read reaches the router as an
 * unrecognised throw and is reported as something else entirely. Catching the
 * error and checking its type is the only shape that tells those apart —
 * `toThrow(StoreUnreadableError)` would too, but not the row it names, and the
 * error's own message promises a row can be repaired or removed.
 */
function unreadableErrorFrom(fn: () => unknown): StoreUnreadableError {
  try {
    fn()
  } catch (err) {
    if (err instanceof StoreUnreadableError) return err
    throw err
  }
  throw new Error('expected a StoreUnreadableError; the read returned instead')
}

/** Overwrite one snapshot table's stored envelope with arbitrary bytes. */
function corruptEnvelope(table: string, column: string, key: number, data: string): void {
  const raw = new Database(join(dir, 'direct.sqlite'))
  raw.run(`UPDATE ${table} SET data = ? WHERE ${column} = ?`, [data, key])
  raw.close()
}

describe('the live compareKey set, computed fail-closed', () => {
  test('a snapshot whose envelope is not JSON aborts the read as StoreUnreadableError', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.close()

    corruptEnvelope('snapshots', 'pr_number', 204, 'not json')

    // The class carries the whole meaning. An unreadable row is a condition the
    // daemon reports as a failed persist; a driver error leaking out of the same
    // read arrives as an unrecognised throw and is reported as something else. So
    // "it threw" is not the assertion — both do.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listLiveCompareKeys())
    reopened.close()
    expect(err.table).toBe('snapshots')
    // The row, not merely the table. The error tells a human to repair or remove
    // the row, and an error that cannot say which row makes that unactionable.
    expect(err.rowKey).toBe('204')
  })

  test('a local snapshot whose envelope is not JSON aborts the read too', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'local...head'))
    store.close()

    corruptEnvelope('local_snapshots', 'local_id', id, '{not valid json')

    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listLiveCompareKeys())
    reopened.close()
    expect(err.table).toBe('local_snapshots')
    expect(err.rowKey).toBe(String(id))
  })

  test('a valid envelope with no compareKey at all throws rather than returning a short set', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putSnapshot(snapshot(205, 'other...head'))
    store.close()

    // Valid JSON, and every field a snapshot envelope carries except the one
    // that names its immutable half. Nothing about reading it fails; the value
    // is simply not there.
    corruptEnvelope('snapshots', 'pr_number', 204, JSON.stringify({ prNumber: 204, mutable: {} }))

    // Returning `['other...head']` here would be the catastrophe: a shorter set
    // is not a smaller answer, it is a claim that `pr...head` is referenced by
    // nothing — and the caller of this read removes what nothing references.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listLiveCompareKeys())
    reopened.close()
    expect(err.table).toBe('snapshots')
    expect(err.rowKey).toBe('204')
  })

  test('a compareKey of the empty string throws: empty is not a key, it is a missing one', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.close()

    corruptEnvelope(
      'snapshots',
      'pr_number',
      204,
      JSON.stringify({ prNumber: 204, compareKey: '', mutable: {} }),
    )

    // An empty string is present where a key should be, so a check for absence
    // alone waves it through — and it can match no `immutables` row, which makes
    // it exactly as dangerous as a missing one and harder to notice.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listLiveCompareKeys())
    reopened.close()
    expect(err.rowKey).toBe('204')
  })

  test('a compareKey that is not a string throws: it can name no immutables row', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'local...head'))
    store.close()

    corruptEnvelope(
      'local_snapshots',
      'local_id',
      id,
      JSON.stringify({ prNumber: id, compareKey: 17, mutable: {} }),
    )

    // `immutables.compare_key` is TEXT, so a number can match no row there. It
    // is neither absent nor empty, which is precisely why a guard written as two
    // equality checks lets it through and a type check does not.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listLiveCompareKeys())
    reopened.close()
    expect(err.rowKey).toBe(String(id))
  })

  test('one PR snapshot and one local snapshot on distinct compares return both keys', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'local...head'))

    // Both tables, because the immutable half is content-addressed by SHAs git
    // produced and does not know which kind of review asked for it. A set built
    // from one table would report the other's keys as referenced by nothing.
    expect(store.listLiveCompareKeys()).toEqual(['local...head', 'pr...head'])
    store.close()
  })

  test('two snapshots sharing one compareKey return it once', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'shared...head'))
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'shared...head'))

    // One stored copy of the expensive half backs both reviews, so the set is a
    // set: the answer is which halves are needed, not how many times each is
    // asked for.
    expect(store.listLiveCompareKeys()).toEqual(['shared...head'])
    store.close()
  })

  test('an empty store references nothing, and says so without failing', () => {
    const store = open()
    // Empty is an ordinary answer, distinct from the refusal an unreadable row
    // produces — a store nobody has synced yet references no immutable half.
    expect(store.listLiveCompareKeys()).toEqual([])
    expect(store.listImmutableKeys()).toEqual([])
    store.close()
  })

  test('removing a local review drops its compareKey from the live set, not from the cache', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'local...head'))

    store.deleteLocalReview(id)

    // The two reads answer different questions, and this is where that shows.
    // The envelope is gone so nothing references `local...head` any more, while
    // the cached half is still on disk — reclaiming it is a separate decision
    // taken against the whole reference set, never a cascade from one delete.
    expect(store.listLiveCompareKeys()).toEqual(['pr...head'])
    expect(store.listImmutableKeys()).toEqual(['local...head', 'pr...head'])
    store.close()
  })
})

describe('the immutable cache reports everything it holds, orphans included', () => {
  test('listImmutableKeys returns keys no snapshot names', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    // A half cached by a sync whose comparison nothing references any more —
    // exactly what a rebased branch leaves behind on every sync, since a fresh
    // merge base mints a fresh key and the previous one is never named again.
    store.putImmutable(immutable('orphan...head'))

    // The orphans are the point. Without them this read answers with the
    // question: a reclamation decided by comparing the stored set against the
    // referenced set has nothing to compare if the stored set is pre-filtered.
    expect(store.listImmutableKeys()).toEqual(['orphan...head', 'pr...head'])
    expect(store.listLiveCompareKeys()).toEqual(['pr...head'])
    store.close()
  })

  test('the two reads are what an unreferenced half is defined by, and nothing else', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('orphan-a...head'))
    store.putImmutable(immutable('orphan-b...head'))

    const live = new Set(store.listLiveCompareKeys())
    const unreferenced = store.listImmutableKeys().filter((key) => !live.has(key))

    // Reference-based, never age-based. Nothing in the `immutables` schema
    // records when a row was written, so there is no timestamp to sweep on even
    // if one were wanted — the constraint is made physical by the table itself.
    expect(unreferenced).toEqual(['orphan-a...head', 'orphan-b...head'])
    store.close()
  })

  test('neither read is a write: both are refused nothing under the PR-keyed tripwires', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    const armed = armPrKeyedTripwires(store)
    const id = armed.createLocalReview(newLocalReview({})).id
    armed.putLocalSnapshot(snapshot(id, 'local...head'))

    // Reads, and the tripwires guard UPDATE and DELETE as well as INSERT — so a
    // reclamation read that "helpfully" tidied a row as it went would abort here
    // rather than quietly discard a pull request's snapshot.
    expect(armed.listLiveCompareKeys()).toEqual(['local...head', 'pr...head'])
    expect(armed.listImmutableKeys()).toEqual(['local...head', 'pr...head'])
    armed.close()
  })
})

/** How many rows the immutable cache holds, counted through a handle of its own. */
function immutableRowCount(): number {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw.query('SELECT COUNT(*) AS n FROM immutables').get() as { n: number }
  raw.close()
  return row.n
}

describe('removing cached halves removes only what nothing references', () => {
  test('a key no snapshot names gives up its row, and the row is really gone', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('orphan...head'))
    expect(immutableRowCount()).toBe(2)

    expect(store.deleteImmutables(['orphan...head'])).toEqual({
      count: 1,
      removed: ['orphan...head'],
    })

    expect(immutableRowCount()).toBe(1)
    expect(store.getImmutable('orphan...head')).toBeNull()
    store.close()
  })

  test('a key a pull-request snapshot still names is left exactly where it is', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))

    // The caller asked for a live key, which is what a caller that read its two
    // sets before a concurrent sync landed will do. The answer is to leave the
    // row alone, not to remove it and not to refuse the whole call: the race is
    // the ordinary shape of a reclamation, not a mistake to report.
    expect(store.deleteImmutables(['pr...head'])).toEqual({ count: 0, removed: [] })

    expect(immutableRowCount()).toBe(1)
    // The consequence the refusal exists to prevent, asserted as a consequence:
    // the snapshot still opens.
    expect(store.getSnapshot(204)).not.toBeNull()
    store.close()
  })

  test('a key a local snapshot still names is left where it is too', () => {
    const store = open()
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'local...head'))

    // Both tables, because one compare key can back either kind of review and
    // the cached half knows nothing about which asked for it. A recheck reading
    // one table would report the other's live halves as referenced by nothing.
    expect(store.deleteImmutables(['local...head'])).toEqual({ count: 0, removed: [] })

    expect(store.getLocalSnapshot(id)).not.toBeNull()
    store.close()
  })

  test('a live key and an orphan named together: only the orphan goes', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('orphan...head'))

    // The mixed batch is the one that separates "refuses live keys" from
    // "refuses batches containing one" — the orphan still has to go.
    expect(store.deleteImmutables(['pr...head', 'orphan...head'])).toEqual({
      count: 1,
      removed: ['orphan...head'],
    })

    expect(store.listImmutableKeys()).toEqual(['pr...head'])
    store.close()
  })

  test('an unreadable envelope aborts the removal with every row still present', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('orphan...head'))
    store.close()

    corruptEnvelope('snapshots', 'pr_number', 204, 'not json')

    // The recheck runs INSIDE the deleting transaction, so a row it cannot
    // parse aborts the transaction rather than the read that preceded it. A row
    // skipped instead would read as "this snapshot references nothing", and
    // `pr...head` would become a candidate on the strength of it.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.deleteImmutables(['orphan...head']))
    expect(err.table).toBe('snapshots')
    expect(err.rowKey).toBe('204')
    reopened.close()

    // Nothing removed, not even the orphan that really was one: an unknown
    // reference set makes every deletion built on it a guess.
    expect(immutableRowCount()).toBe(2)
  })

  test('a key that names no row removes nothing and does not fail', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))

    // Counted from the statement rather than from the request, so a repeat over
    // an already-reclaimed cache reports zero instead of claiming a removal.
    expect(store.deleteImmutables(['never...stored'])).toEqual({ count: 0, removed: [] })

    expect(immutableRowCount()).toBe(1)
    store.close()
  })

  test('one key named twice is one row and one entry in the report', () => {
    const store = open()
    store.putImmutable(immutable('orphan...head'))

    // A count taken from the request would say two here, over a table that only
    // ever held one matching row.
    expect(store.deleteImmutables(['orphan...head', 'orphan...head'])).toEqual({
      count: 1,
      removed: ['orphan...head'],
    })

    expect(immutableRowCount()).toBe(0)
    store.close()
  })

  test('an empty request is a clean no-op', () => {
    const store = open()
    store.putImmutable(immutable('orphan...head'))
    expect(store.deleteImmutables([])).toEqual({ count: 0, removed: [] })
    // Named nothing, removed nothing: the empty list is not "everything
    // unreferenced", which is the reading that would empty the cache.
    expect(immutableRowCount()).toBe(1)
    store.close()
  })

  test('neither a blob nor a draft is reachable from a cached-half removal', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('orphan...head'))
    store.putBlobs([
      { sha: 'headblob', path: 'a.ts', content: 'text', size: 4, binary: false },
    ])
    store.putDraft(draft('h1', 204, 'unsubmitted text'))

    store.deleteImmutables(['orphan...head'])

    // `blobs` is keyed by git blob SHA and shares no key space with a
    // comparison; a draft is irreplaceable local work. Neither is derivable from
    // a compare key, so neither may travel with one.
    expect(store.getBlob('headblob')).not.toBeNull()
    expect(store.getDraft('h1', 204)?.body).toBe('unsubmitted text')
    store.close()
  })

  test('removing a cached half touches no PR-keyed table', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('orphan...head'))
    const armed = armPrKeyedTripwires(store)

    // The live set is READ from `snapshots`, which is required — and the
    // tripwires guard UPDATE and DELETE as well as INSERT, so a recheck that
    // "helpfully" tidied a row as it went would abort here.
    expect(armed.deleteImmutables(['orphan...head'])).toEqual({
      count: 1,
      removed: ['orphan...head'],
    })
    armed.close()
  })

  test('deleteImmutables against a closed database throws StoreWriteError', () => {
    const store = open()
    store.putImmutable(immutable('orphan...head'))
    store.close()
    // Never a silent success: a reclamation that could not persist must not
    // report rows as removed that are still on disk.
    const err = writeErrorFrom(() => {
      store.deleteImmutables(['orphan...head'])
    })
    expect(err.table).toBe('immutables')
  })
})

/** How many rows the blob table holds, counted through a handle of its own. */
function blobRowCount(): number {
  const raw = new Database(join(dir, 'direct.sqlite'))
  const row = raw.query('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }
  raw.close()
  return row.n
}

/** Overwrite one cached half's stored bytes with arbitrary ones. */
function corruptImmutable(compareKey: string, data: string): void {
  const raw = new Database(join(dir, 'direct.sqlite'))
  raw.run('UPDATE immutables SET data = ? WHERE compare_key = ?', [data, compareKey])
  raw.close()
}

/** One blob row, shaped as the provisioning path writes it. */
function blob(sha: string): FileBlob {
  return { sha, path: 'a.ts', content: `bytes of ${sha}\n`, size: 16, binary: false }
}

describe('the blob table reports everything it holds, unreferenced rows included', () => {
  test('listBlobShas returns SHAs no stored comparison names', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'live' } }))
    store.putBlobs([blob('live'), blob('stranded')])

    // The unreferenced ones are the point. A reclamation decided by comparing
    // the stored set against the referenced set has nothing to compare if the
    // stored set is pre-filtered.
    expect(store.listBlobShas()).toEqual(['live', 'stranded'])
    expect(store.listReferencedBlobShas()).toEqual(['live'])
    store.close()
  })

  test('the two reads are what an unreferenced blob is defined by, and nothing else', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'live' } }))
    store.putBlobs([blob('live'), blob('stranded-a'), blob('stranded-b')])

    const referenced = new Set(store.listReferencedBlobShas())
    const unreferenced = store.listBlobShas().filter((sha) => !referenced.has(sha))

    // Reference-based, never age-based. Nothing in the `blobs` schema records
    // when a row was written, so there is no timestamp to sweep on even if one
    // were wanted — the constraint is made physical by the table itself.
    expect(unreferenced).toEqual(['stranded-a', 'stranded-b'])
    store.close()
  })

  test('neither read is a write: both are refused nothing under the PR-keyed tripwires', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putBlobs([blob('baseblob'), blob('headblob')])
    const armed = armPrKeyedTripwires(store)

    // Reads, and the tripwires guard UPDATE and DELETE as well as INSERT — so a
    // reclamation read that "helpfully" tidied a row as it went would abort here.
    expect(armed.listBlobShas()).toEqual(['baseblob', 'headblob'])
    expect(armed.listReferencedBlobShas()).toEqual(['baseblob', 'headblob'])
    armed.close()
  })
})

describe('the referenced blob set, computed fail-closed', () => {
  test('both sides of a path are referenced, never the head alone', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: 'old', head: 'new' } }))

    // The base side is what a comment anchored to the left of a diff resolves
    // through. A head-only walk reports every unchanged base blob as referenced
    // by nothing, which is a proposal to delete the content half the diff is
    // rendered from.
    expect(store.listReferencedBlobShas()).toEqual(['new', 'old'])
    store.close()
  })

  test('a null side is ordinary and contributes no reference', () => {
    const store = open()
    store.putImmutable(
      immutable('pr...head', {
        'added.ts': { base: null, head: 'fresh' },
        'gone.ts': { base: 'was-there', head: null },
      }),
    )

    // An added file has no base and a removed one has no head. Neither is a
    // malformed row, and neither names a blob.
    expect(store.listReferencedBlobShas()).toEqual(['fresh', 'was-there'])
    store.close()
  })

  test('a SHA carried by two paths is reported once', () => {
    const store = open()
    store.putImmutable(
      immutable('pr...head', {
        'a.ts': { base: null, head: 'same' },
        'copy.ts': { base: null, head: 'same' },
      }),
    )

    // Content-addressed: an unchanged-content rename puts one SHA on two paths,
    // and the question is which bytes are needed rather than how many
    // references each has.
    expect(store.listReferencedBlobShas()).toEqual(['same'])
    store.close()
  })

  test('the set spans every stored comparison, not the ones one kind of review names', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'pr-only' } }))
    const id = store.createLocalReview(newLocalReview({})).id
    store.putLocalSnapshot(snapshot(id, 'local...head'))
    store.putImmutable(
      immutable('local...head', { 'a.ts': { base: null, head: 'local-only' } }),
    )
    // A half no snapshot names any more still holds a claim on its bytes: it is
    // a cache entry a warm re-sync of that comparison reuses.
    store.putImmutable(immutable('old...head', { 'a.ts': { base: null, head: 'cached' } }))

    // A set built from one kind of review's halves proposes every other kind's
    // blobs for deletion — and because the table is content-addressed, those are
    // frequently the same bytes.
    expect(store.listReferencedBlobShas()).toEqual(['cached', 'local-only', 'pr-only'])
    store.close()
  })

  test('a cached half whose stored bytes are not JSON aborts the read, naming the row', () => {
    const store = open()
    store.putImmutable(immutable('pr...head'))
    store.close()

    corruptImmutable('pr...head', 'not json')

    // The class carries the whole meaning: a row that cannot be parsed names no
    // SHAs, and a read that treated it as naming none would turn every blob it
    // really referenced into a candidate.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listReferencedBlobShas())
    expect(err.rowKey).toBe('pr...head')
    reopened.close()
  })

  test('a comparison whose blob index is not an object aborts the read', () => {
    const store = open()
    store.putImmutable(immutable('pr...head'))
    store.close()

    corruptImmutable(
      'pr...head',
      JSON.stringify({ compareKey: 'pr...head', immutable: { blobIndex: 'a.ts' } }),
    )

    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listReferencedBlobShas())
    expect(err.table).toBe('immutables')
    reopened.close()
  })

  test('a side that is neither absent nor a string aborts the read', () => {
    const store = open()
    store.putImmutable(immutable('pr...head'))
    store.close()

    corruptImmutable(
      'pr...head',
      JSON.stringify({
        compareKey: 'pr...head',
        immutable: { blobIndex: { 'a.ts': { base: null, head: 7 } } },
      }),
    )

    // A number can match no row in a TEXT-keyed table, so it is as unusable as
    // an absent SHA and harder to notice — which is why the guard is a type
    // check rather than a pair of equality tests.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listReferencedBlobShas())
    expect(err.rowKey).toBe('pr...head')
    reopened.close()
  })

  test('an empty-string side aborts the read on the same terms', () => {
    const store = open()
    store.putImmutable(immutable('pr...head'))
    store.close()

    corruptImmutable(
      'pr...head',
      JSON.stringify({
        compareKey: 'pr...head',
        immutable: { blobIndex: { 'a.ts': { base: '', head: 'fine' } } },
      }),
    )

    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.listReferencedBlobShas())
    expect(err.rowKey).toBe('pr...head')
    reopened.close()
  })
})

describe('removing blobs removes only what nothing references', () => {
  test('a SHA no comparison names gives up its row, and the row is really gone', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'live' } }))
    store.putBlobs([blob('live'), blob('stranded')])
    expect(blobRowCount()).toBe(2)

    expect(store.deleteBlobs(['stranded'])).toEqual({ count: 1, removed: ['stranded'] })

    expect(blobRowCount()).toBe(1)
    expect(store.getBlob('stranded')).toBeNull()
    store.close()
  })

  test('a SHA a stored comparison still names is left exactly where it is', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'live' } }))
    store.putBlobs([blob('live')])

    // The caller asked for a referenced SHA, which is what a caller that read
    // its two sets before a concurrent sync landed will do. The answer is to
    // leave the row alone, not to remove it and not to refuse the whole call.
    expect(store.deleteBlobs(['live'])).toEqual({ count: 0, removed: [] })

    expect(blobRowCount()).toBe(1)
    // The consequence the refusal exists to prevent, asserted as a consequence:
    // the bytes a pending comment's anchor is resolved through are still there.
    expect(store.getBlob('live')).not.toBeNull()
    store.close()
  })

  test('a SHA named by a half nothing references is still left where it is', () => {
    const store = open()
    // No snapshot names this comparison, so the half is reclaimable — but until
    // it IS reclaimed it is a cache entry a warm re-sync reuses, and a reuse
    // that found its bytes gone would assemble a snapshot with no content.
    store.putImmutable(immutable('orphan...head', { 'a.ts': { base: null, head: 'cached' } }))
    store.putBlobs([blob('cached')])

    expect(store.deleteBlobs(['cached'])).toEqual({ count: 0, removed: [] })

    expect(store.getBlob('cached')).not.toBeNull()
    store.close()
  })

  test('a referenced SHA and an unreferenced one named together: only the loose one goes', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'live' } }))
    store.putBlobs([blob('live'), blob('stranded')])

    // The mixed batch separates "refuses referenced SHAs" from "refuses batches
    // containing one" — the unreferenced row still has to go.
    expect(store.deleteBlobs(['live', 'stranded'])).toEqual({
      count: 1,
      removed: ['stranded'],
    })

    expect(store.listBlobShas()).toEqual(['live'])
    store.close()
  })

  test('a comparison that will not parse aborts the removal with every row present', () => {
    const store = open()
    store.putImmutable(immutable('pr...head', { 'a.ts': { base: null, head: 'live' } }))
    store.putBlobs([blob('live'), blob('stranded')])
    store.close()

    corruptImmutable('pr...head', 'not json')

    // The recheck runs INSIDE the deleting transaction, so a row it cannot parse
    // aborts the transaction rather than the read that preceded it. A row
    // skipped instead would read as "this comparison names no content", and
    // `live` would become a candidate on the strength of it.
    const reopened = open()
    const err = unreadableErrorFrom(() => reopened.deleteBlobs(['stranded']))
    expect(err.rowKey).toBe('pr...head')
    reopened.close()

    // Nothing removed, not even the row that really was loose: an unknown
    // reference set makes every deletion built on it a guess.
    expect(blobRowCount()).toBe(2)
  })

  test('a SHA that names no row removes nothing and does not fail', () => {
    const store = open()
    store.putBlobs([blob('stranded')])

    // Counted from the statement rather than from the request, so a repeat over
    // an already-reclaimed table reports zero instead of claiming a removal.
    expect(store.deleteBlobs(['never...stored'])).toEqual({ count: 0, removed: [] })

    expect(blobRowCount()).toBe(1)
    store.close()
  })

  test('one SHA named twice is one row and one entry in the report', () => {
    const store = open()
    store.putBlobs([blob('stranded')])

    // A count taken from the request would say two here, over a table that only
    // ever held one matching row.
    expect(store.deleteBlobs(['stranded', 'stranded'])).toEqual({
      count: 1,
      removed: ['stranded'],
    })

    expect(blobRowCount()).toBe(0)
    store.close()
  })

  test('an empty request is a clean no-op', () => {
    const store = open()
    store.putBlobs([blob('stranded')])
    expect(store.deleteBlobs([])).toEqual({ count: 0, removed: [] })
    // Named nothing, removed nothing: the empty list is not "everything
    // unreferenced", which is the reading that would empty the table.
    expect(blobRowCount()).toBe(1)
    store.close()
  })

  test('neither a cached half nor a draft is reachable from a blob removal', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putBlobs([blob('stranded')])
    store.putDraft(draft('h1', 204, 'unsubmitted text'))

    store.deleteBlobs(['stranded'])

    // The half is READ to build the reference set and never written; a draft is
    // irreplaceable local work. Neither is derivable from a blob SHA, so neither
    // may travel with one.
    expect(store.getImmutable('pr...head')).not.toBeNull()
    expect(store.getDraft('h1', 204)?.body).toBe('unsubmitted text')
    store.close()
  })

  test('removing a blob touches no PR-keyed table', () => {
    const store = open()
    store.putSnapshot(snapshot(204, 'pr...head'))
    store.putBlobs([blob('stranded')])
    const armed = armPrKeyedTripwires(store)

    // Nothing in the reference set is read from the pull-request keyspace at
    // all, and the tripwires guard UPDATE and DELETE as well as INSERT — so a
    // recheck that reached sideways would abort here.
    expect(armed.deleteBlobs(['stranded'])).toEqual({ count: 1, removed: ['stranded'] })
    armed.close()
  })

  test('deleteBlobs against a closed database throws StoreWriteError', () => {
    const store = open()
    store.putBlobs([blob('stranded')])
    store.close()
    // Never a silent success: a reclamation that could not persist must not
    // report rows as removed that are still on disk.
    const err = writeErrorFrom(() => {
      store.deleteBlobs(['stranded'])
    })
    expect(err.table).toBe('blobs')
  })
})

describe('the append-only audit journal', () => {
  test('appendAudit persists a row that survives a reopen, fields intact', () => {
    const store = open()
    store.appendAudit(auditEntry({ githubId: 4242, endpoint: 'replyToThread', pr: 7 }))
    store.close()
    const reopened = open()
    const entries = reopened.listAudit()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      githubId: 4242,
      humanId: 'alice@x.io',
      workspace: 'ws-o-r',
      endpoint: 'replyToThread',
      pr: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    reopened.close()
  })

  test('listAudit returns entries oldest → newest in insertion order', () => {
    const store = open()
    store.appendAudit(auditEntry({ githubId: 1, createdAt: '2026-01-03T00:00:00.000Z' }))
    store.appendAudit(auditEntry({ githubId: 2, createdAt: '2026-01-01T00:00:00.000Z' }))
    store.appendAudit(auditEntry({ githubId: 3, createdAt: '2026-01-02T00:00:00.000Z' }))
    // Insertion order, NOT timestamp order: the journal reads back as written.
    expect(store.listAudit().map((e) => e.githubId)).toEqual([1, 2, 3])
    store.close()
  })

  test('listAudit filters by pr', () => {
    const store = open()
    store.appendAudit(auditEntry({ githubId: 1, pr: 7 }))
    store.appendAudit(auditEntry({ githubId: 2, pr: 8 }))
    store.appendAudit(auditEntry({ githubId: 3, pr: 7 }))
    expect(store.listAudit({ pr: 7 }).map((e) => e.githubId)).toEqual([1, 3])
    expect(store.listAudit({ pr: 999 })).toEqual([])
    store.close()
  })

  test('listAudit filters by sinceIso (inclusive) and combines with pr', () => {
    const store = open()
    store.appendAudit(auditEntry({ githubId: 1, pr: 7, createdAt: '2026-01-01T00:00:00.000Z' }))
    store.appendAudit(auditEntry({ githubId: 2, pr: 7, createdAt: '2026-01-02T00:00:00.000Z' }))
    store.appendAudit(auditEntry({ githubId: 3, pr: 8, createdAt: '2026-01-03T00:00:00.000Z' }))
    // Inclusive: the entry stamped exactly at sinceIso is returned.
    expect(
      store.listAudit({ sinceIso: '2026-01-02T00:00:00.000Z' }).map((e) => e.githubId),
    ).toEqual([2, 3])
    expect(
      store.listAudit({ pr: 7, sinceIso: '2026-01-02T00:00:00.000Z' }).map((e) => e.githubId),
    ).toEqual([2])
    store.close()
  })

  test('the same github id may journal more than once (an idempotent retry re-records)', () => {
    const store = open()
    store.appendAudit(auditEntry({ githubId: 4242 }))
    store.appendAudit(auditEntry({ githubId: 4242 }))
    expect(store.listAudit()).toHaveLength(2)
    store.close()
  })

  test('the store surface is append-only: no update or delete for audit rows', () => {
    const store = open()
    store.appendAudit(auditEntry({ githubId: 1 }))
    // No method on the surface can mutate or remove a journaled row.
    const auditMethods = Object.keys(store).filter((k) => k.toLowerCase().includes('audit'))
    expect(auditMethods.sort()).toEqual(['appendAudit', 'listAudit'])
    // And nothing that ran so far removed the row.
    expect(store.listAudit()).toHaveLength(1)
    store.close()
  })

  test('a failed append surfaces StoreWriteError, never a silent success', () => {
    const store = open()
    store.close()
    expect(() => store.appendAudit(auditEntry({}))).toThrow(StoreWriteError)
  })
})

describe('the pull-request author attribution seam', () => {
  test('an unrecorded PR reads back undefined (never observed), distinct from a recorded null', () => {
    const store = open()
    // No row: the three-way read reports `undefined`, which the poll loop maps
    // to a `null` authorHumanId but is NOT the same settled fact as a recorded
    // org-member open.
    expect(store.getPrAuthor(347)).toBeUndefined()
    store.recordPrAuthor(347, null)
    // A recorded org-member open is `null`, not `undefined`.
    expect(store.getPrAuthor(347)).toBeNull()
    store.close()
  })

  test('a recorded driver reads back and survives a reopen', () => {
    const store = open()
    store.recordPrAuthor(355, 'h-priya')
    store.close()
    const reopened = open()
    expect(reopened.getPrAuthor(355)).toBe('h-priya')
    reopened.close()
  })

  test('FIRST-WRITE-WINS: a later record never overwrites the original driver', () => {
    const store = open()
    store.recordPrAuthor(360, 'h-priya')
    // A later re-observation (the collector re-seeing the same PR) is a no-op.
    store.recordPrAuthor(360, 'h-marcus')
    expect(store.getPrAuthor(360)).toBe('h-priya')
    // Even a later record that would flip it to org-member (`null`) is ignored:
    // the first write at open time is permanent.
    store.recordPrAuthor(360, null)
    expect(store.getPrAuthor(360)).toBe('h-priya')
    store.close()
  })

  test('FIRST-WRITE-WINS holds when the original record was a null org-member open', () => {
    const store = open()
    store.recordPrAuthor(361, null)
    store.recordPrAuthor(361, 'h-priya')
    // The first write recorded an org-member open; it stays `null`.
    expect(store.getPrAuthor(361)).toBeNull()
    store.close()
  })

  test('a failed record surfaces StoreWriteError, never a silent success', () => {
    const store = open()
    store.close()
    expect(() => store.recordPrAuthor(1, 'h-priya')).toThrow(StoreWriteError)
  })

  test('a version-2 file gains pr_author in place WITHOUT wiping drafts or audit rows', () => {
    // Recreate a genuine v2 file: current shape minus the pr_author table, meta
    // stamped at 2 — exactly what a version-2 build left on disk.
    const store = open()
    store.putDraft(draft('h1', 204, 'v2 work that must survive'))
    store.appendAudit(auditEntry({ githubId: 77, pr: 204 }))
    store.close()
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run('DROP TABLE pr_author')
    raw.run("UPDATE meta SET value = '2' WHERE key = 'store_version'")
    raw.close()

    // Reopening runs the guarded v2 → v3 step: the table is added, nothing is
    // reseeded, and drafts + the audit journal survive untouched.
    const reopened = open()
    expect(reopened.getDraft('h1', 204)!.body).toBe('v2 work that must survive')
    expect(reopened.listAudit()).toHaveLength(1)
    // The new seam is immediately usable.
    reopened.recordPrAuthor(204, 'h-priya')
    expect(reopened.getPrAuthor(204)).toBe('h-priya')
    reopened.close()

    const check = new Database(join(dir, 'direct.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    expect(Number(after.value)).toBe(STORE_VERSION)
    check.close()
  })
})

/**
 * The tables whose integer key is a REAL GitHub pull-request number:
 * `snapshots.pr_number`, `audit_log.pr` and `pr_author.pr`. Their readers — the
 * host-side collector's write reconciler, the poll loop's per-pull annotations,
 * and the out-of-band-write detector — all interpret those columns as pull
 * requests that exist on GitHub. A synthetic identifier written into any of them
 * is not a wrong row that surfaces later; it is a row those readers cannot tell
 * from a real one, so the damage lands as misattributed provenance months away
 * from the statement that caused it.
 */
const PR_KEYED_TABLES = ['snapshots', 'audit_log', 'pr_author'] as const

/** Every statement kind a tripwire has to intercept to guard a whole table. */
const TRIPWIRE_EVENTS = ['INSERT', 'UPDATE', 'DELETE'] as const

/** The trigger name for one (table, statement kind) pair. */
function tripwireName(table: string, event: string): string {
  return `tripwire_${table}_${event.toLowerCase()}`
}

/**
 * The abort message one tripwire raises. It names its own table and its own
 * statement kind, so a failure identifies which statement reached which table —
 * and so a test can tell nine live tripwires apart from one live tripwire and
 * eight that were never installed.
 */
function tripwireMessage(table: string, event: string): string {
  return `tripwire: ${event} on the PR-keyed table ${table}`
}

/**
 * Arm the tripwires on the current data dir's store file: one `BEFORE
 * INSERT|UPDATE|DELETE` trigger per PR-keyed table, each raising `RAISE(ABORT,
 * …)`, which the store's write wrapper turns into a `StoreWriteError`.
 *
 * Closes the store passed in, installs the triggers through a raw handle, and
 * returns a freshly opened store — so every statement the returned store issues
 * was prepared against the armed schema, and the reopen itself is a live check
 * that opening a store touches no guarded table.
 *
 * A trigger is what makes an absence provable. A `COUNT(*) === 0` assertion
 * cannot distinguish a table nothing wrote from one that was written and then
 * cleaned up, and it reports nothing at all about a write that happened inside a
 * transaction which later rolled back. An aborting trigger fires on the
 * statement, so the failure names the write rather than its leftovers.
 */
function armPrKeyedTripwires(store: DirectStore): DirectStore {
  store.close()
  const raw = new Database(join(dir, 'direct.sqlite'))
  for (const table of PR_KEYED_TABLES) {
    for (const event of TRIPWIRE_EVENTS) {
      raw.run(
        `CREATE TRIGGER ${tripwireName(table, event)} BEFORE ${event} ON ${table} ` +
          `BEGIN SELECT RAISE(ABORT, '${tripwireMessage(table, event)}'); END`,
      )
    }
  }
  raw.close()
  return open()
}

/**
 * Run `fn` and return the `StoreWriteError` it threw. Fails loudly when the
 * statement completes instead: "the write was refused" is the assertion, and a
 * silent completion is exactly the outcome that must not read as a pass.
 */
function writeErrorFrom(fn: () => void): StoreWriteError {
  try {
    fn()
  } catch (err) {
    if (err instanceof StoreWriteError) return err
    throw err
  }
  throw new Error('expected a StoreWriteError; the statement completed instead')
}

/**
 * The substring every method of the local keyspace carries in its name. One
 * literal serves two filters — the type below narrows the interface with it, and
 * the sweep narrows its record of driven calls with it — so the two cannot drift
 * into agreeing with each other however wrong either becomes. A marker that
 * stopped matching would empty the type, and the total map below would then
 * refuse its own entries at compile time.
 */
const LOCAL_METHOD_MARKER = 'Local'

/** Every `DirectStore` method that belongs to the local-review keyspace. */
type LocalStoreMethod = Extract<
  keyof DirectStore,
  `${string}${typeof LOCAL_METHOD_MARKER}${string}`
>

/**
 * The local surface the sweep must exercise, written as a TOTAL map over the
 * interface's own local methods rather than as a list kept in step by hand.
 *
 * This is what makes the coverage derived instead of restated. A local method
 * added to `DirectStore` later turns this literal into a missing-property
 * compile error, and a name here the interface does not declare turns it into an
 * excess-property one — so the set cannot silently fall behind the surface it
 * claims to cover. The sweep then compares the methods it ACTUALLY called
 * against these keys, which closes the other half: the type knows what exists
 * but not what ran, and the call record knows what ran but not what exists.
 */
const LOCAL_STORE_METHODS: Record<LocalStoreMethod, true> = {
  createLocalReview: true,
  getLocalReview: true,
  listLocalReviews: true,
  patchLocalReviewSync: true,
  nextLocalEntityId: true,
  getLocalSnapshot: true,
  putLocalSnapshot: true,
  getLocalCommentAuthors: true,
  getLocalDraft: true,
  putLocalDraft: true,
  deleteLocalDraft: true,
  listLocalDrafts: true,
  getLocalViewed: true,
  setLocalViewed: true,
  listLocalThreads: true,
  getLocalThread: true,
  putLocalThread: true,
  listLocalSubmittedReviews: true,
  putLocalSubmittedReview: true,
  deleteLocalReview: true,
}

/** The local method names, sorted, as the interface declares them. */
function declaredLocalMethods(): string[] {
  return Object.keys(LOCAL_STORE_METHODS).sort()
}

/**
 * Wrap a store so that every method call is recorded by name, and hand back both
 * the wrapper and the record.
 *
 * The record is taken from the calls themselves rather than written down beside
 * them: a sweep that stops driving a method loses it from this set, where a
 * hand-kept note of what the sweep "covers" would go on claiming it forever.
 */
function recordingStore(store: DirectStore): { store: DirectStore; driven: Set<string> } {
  const driven = new Set<string>()
  const proxy = new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        driven.add(prop)
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { store: proxy, driven }
}

describe('local writes never touch a PR-keyed table', () => {
  test('the harness arms nine tripwires and nothing else', () => {
    const armed = armPrKeyedTripwires(open())
    armed.close()

    const raw = new Database(join(dir, 'direct.sqlite'))
    const names = (
      raw
        .query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name)
    raw.close()

    // Written out rather than rebuilt from the constants the harness loops over:
    // a membership list derived from the generator agrees with the generator
    // however wrong it becomes, and would stay green if the loop stopped running.
    expect(names).toEqual([
      'tripwire_audit_log_delete',
      'tripwire_audit_log_insert',
      'tripwire_audit_log_update',
      'tripwire_pr_author_delete',
      'tripwire_pr_author_insert',
      'tripwire_pr_author_update',
      'tripwire_snapshots_delete',
      'tripwire_snapshots_insert',
      'tripwire_snapshots_update',
    ])
  })

  test('all nine tripwires fire: every guarded table aborts INSERT, UPDATE and DELETE', () => {
    const store = open()
    // One row per guarded table before arming. SQLite runs a BEFORE UPDATE or
    // BEFORE DELETE trigger once per MATCHED row, so a statement that matches
    // nothing runs no trigger at all — six of the nine would be written down as
    // installed while never having fired once.
    store.putSnapshot(snapshot(204, 'base...head'))
    store.appendAudit(auditEntry({ githubId: 1, pr: 204 }))
    store.recordPrAuthor(204, 'h-priya')
    const armed = armPrKeyedTripwires(store)
    armed.close()

    const probes: { table: string; event: string; sql: string }[] = [
      {
        table: 'snapshots',
        event: 'INSERT',
        sql: "INSERT INTO snapshots (pr_number, data) VALUES (999, '{}')",
      },
      {
        table: 'snapshots',
        event: 'UPDATE',
        sql: "UPDATE snapshots SET data = '{}' WHERE pr_number = 204",
      },
      {
        table: 'snapshots',
        event: 'DELETE',
        sql: 'DELETE FROM snapshots WHERE pr_number = 204',
      },
      {
        table: 'audit_log',
        event: 'INSERT',
        sql:
          'INSERT INTO audit_log (github_id, human_id, workspace, endpoint, pr, created_at) ' +
          "VALUES (2, 'alice@x.io', 'ws-o-r', 'submitReview', 205, '2026-01-01T00:00:00.000Z')",
      },
      {
        table: 'audit_log',
        event: 'UPDATE',
        sql: 'UPDATE audit_log SET pr = 205 WHERE github_id = 1',
      },
      {
        table: 'audit_log',
        event: 'DELETE',
        sql: 'DELETE FROM audit_log WHERE github_id = 1',
      },
      {
        table: 'pr_author',
        event: 'INSERT',
        sql:
          "INSERT INTO pr_author (pr, human_id, recorded_at) VALUES (205, 'h-marcus', " +
          "'2026-01-01T00:00:00.000Z')",
      },
      {
        table: 'pr_author',
        event: 'UPDATE',
        sql: "UPDATE pr_author SET human_id = 'h-marcus' WHERE pr = 204",
      },
      {
        table: 'pr_author',
        event: 'DELETE',
        sql: 'DELETE FROM pr_author WHERE pr = 204',
      },
    ]

    const raw = new Database(join(dir, 'direct.sqlite'))
    const observed: string[] = []
    for (const probe of probes) {
      try {
        raw.run(probe.sql)
        observed.push(`${probe.event} on ${probe.table}: NO ABORT`)
      } catch (err) {
        observed.push(err instanceof Error ? err.message : String(err))
      }
    }
    const counts = raw
      .query(
        'SELECT (SELECT COUNT(*) FROM snapshots) AS snapshots, ' +
          '(SELECT COUNT(*) FROM audit_log) AS audit_log, ' +
          '(SELECT COUNT(*) FROM pr_author) AS pr_author',
      )
      .get() as { snapshots: number; audit_log: number; pr_author: number }
    raw.close()

    // Each abort names its own table and statement kind, so this list falsifies a
    // missing tripwire and a duplicated one alike. The literals are copied out
    // rather than rebuilt from the harness's own generator, for the same reason
    // the membership list above is.
    expect(observed).toEqual([
      'tripwire: INSERT on the PR-keyed table snapshots',
      'tripwire: UPDATE on the PR-keyed table snapshots',
      'tripwire: DELETE on the PR-keyed table snapshots',
      'tripwire: INSERT on the PR-keyed table audit_log',
      'tripwire: UPDATE on the PR-keyed table audit_log',
      'tripwire: DELETE on the PR-keyed table audit_log',
      'tripwire: INSERT on the PR-keyed table pr_author',
      'tripwire: UPDATE on the PR-keyed table pr_author',
      'tripwire: DELETE on the PR-keyed table pr_author',
    ])
    // ABORT rolled every statement back, so refusing the write is what happened
    // rather than raising after it landed: each table still holds its one seed row.
    expect(counts).toEqual({ snapshots: 1, audit_log: 1, pr_author: 1 })
  })

  test('putSnapshot is refused under the tripwires, as a StoreWriteError', () => {
    const armed = armPrKeyedTripwires(open())
    const err = writeErrorFrom(() => armed.putSnapshot(snapshot(204, 'base...head')))
    armed.close()
    expect(err.table).toBe('snapshots')
    expect(err.message).toContain('tripwire: INSERT on the PR-keyed table snapshots')
  })

  test('appendAudit is refused under the tripwires, as a StoreWriteError', () => {
    const armed = armPrKeyedTripwires(open())
    const err = writeErrorFrom(() => armed.appendAudit(auditEntry({ githubId: 4242, pr: 204 })))
    armed.close()
    expect(err.table).toBe('audit_log')
    expect(err.message).toContain('tripwire: INSERT on the PR-keyed table audit_log')
  })

  test('recordPrAuthor is refused under the tripwires, as a StoreWriteError', () => {
    const armed = armPrKeyedTripwires(open())
    const err = writeErrorFrom(() => armed.recordPrAuthor(204, 'h-priya'))
    armed.close()
    expect(err.table).toBe('pr_author')
    expect(err.message).toContain('tripwire: INSERT on the PR-keyed table pr_author')
  })

  test('a store still opens under armed tripwires: migration touches no guarded table', () => {
    const store = open()
    store.putDraft(draft('h1', 204, 'work that must survive a boot under tripwires'))
    store.putSnapshot(snapshot(204, 'base...head'))
    store.appendAudit(auditEntry({ githubId: 1, pr: 204 }))
    const armed = armPrKeyedTripwires(store)
    armed.close()

    // Knock the recorded version back so the reopen runs the guarded ladder and
    // the version stamp, not only the create-when-absent shape. `meta` is not a
    // PR-keyed table, so the stamp itself is never a candidate for interception —
    // and the day a migration step does write one of the three, this boots red,
    // which is the signal wanted rather than a surprise.
    const raw = new Database(join(dir, 'direct.sqlite'))
    raw.run("UPDATE meta SET value = '1' WHERE key = 'store_version'")
    raw.close()

    const reopened = open()
    expect(reopened.getDraft('h1', 204)!.body).toBe(
      'work that must survive a boot under tripwires',
    )
    expect(reopened.getSnapshot(204)!.immutable.compareKey).toBe('base...head')
    expect(reopened.listAudit()).toHaveLength(1)
    // The migration left the tripwires ARMED, not merely present — asserted by
    // taking a real abort out of one, so an absence claimed after a boot still has
    // a working negative control underneath it.
    const stillArmed = writeErrorFrom(() =>
      reopened.appendAudit(auditEntry({ githubId: 2, pr: 204 })),
    )
    expect(stillArmed.message).toContain('tripwire: INSERT on the PR-keyed table audit_log')
    reopened.close()

    const check = new Database(join(dir, 'direct.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    check.close()
    expect(Number(after.value)).toBe(STORE_VERSION)
  })

  /**
   * The containment proof. Every method of the local keyspace runs end to end
   * against a store whose three PR-keyed tables are armed, and the claim is that
   * not one statement any of them issues reaches one of those tables.
   *
   * A fired tripwire aborts the statement and surfaces as a `StoreWriteError`
   * naming the trigger, so the sweep completing IS the assertion — there is no
   * separate "and nothing was written" check to weaken. Deliberately no
   * `COUNT(*) = 0` beside it: a count cannot tell a table nothing wrote from one
   * that was written and then cleaned up, nor see a write inside a transaction
   * that later rolled back, which is precisely the gap the triggers close.
   *
   * It sits in this block on purpose. The armed assertions above prove the
   * tripwires still fire; an absence proved by a harness that quietly stopped
   * arming reads exactly like an absence proved by a working one, so the proof
   * and its control fail in the same run or neither is worth anything.
   */
  test('every local method runs end to end without firing one tripwire', () => {
    const seeded = open()
    // One row per guarded table, stored BEFORE the tripwires go up, keyed to the
    // number the first local review will be minted at.
    //
    // Load-bearing rather than scene-setting. SQLite runs a BEFORE UPDATE or
    // BEFORE DELETE trigger once per MATCHED row, so against empty guarded
    // tables a local statement mis-aimed at `snapshots` would match nothing, fire
    // nothing, and pass — the absence this test asserts would hold for the wrong
    // reason. These rows are what a mis-aimed statement can hit.
    seeded.putSnapshot(snapshot(LOCAL_REVIEW_ID_BASE, 'pr...head'))
    seeded.appendAudit(auditEntry({ githubId: 1, pr: LOCAL_REVIEW_ID_BASE }))
    seeded.recordPrAuthor(LOCAL_REVIEW_ID_BASE, 'h-priya')
    const armed = armPrKeyedTripwires(seeded)
    const { store, driven } = recordingStore(armed)

    const review = store.createLocalReview(newLocalReview({}))
    const id = review.id
    // Pinned to the exact number, not merely to the band: the seeded rows above
    // are keyed to that number, and a mint that started elsewhere would leave
    // them unreachable and the guard decorative.
    expect(id).toBe(LOCAL_REVIEW_ID_BASE)
    expect(store.getLocalReview(id)!.headRef).toBe('refs/heads/feature/x')
    expect(store.listLocalReviews('acme/widgets').map((r) => r.id)).toEqual([id])

    const entityId = store.nextLocalEntityId()
    expect(entityId).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)

    store.putLocalSnapshot(snapshot(id, 'base...head'))
    expect(store.getLocalSnapshot(id)!.immutable.compareKey).toBe('base...head')

    // Reads the envelope alone, so it answers for a review whose immutable half
    // is gone — the state a re-sync is the documented repair for.
    expect(store.getLocalCommentAuthors(id)).toEqual({})

    store.putLocalDraft(draft('h1', id, 'unsubmitted text on a local review'))
    expect(store.getLocalDraft('h1', id)!.body).toBe('unsubmitted text on a local review')
    expect(store.listLocalDrafts(id).map((d) => d.humanId)).toEqual(['h1'])

    store.setLocalViewed('h1', id, { 'a.ts': { viewed: true, blobSha: 'headblob', at: 'now' } })
    expect(store.getLocalViewed('h1', id)['a.ts']!.viewed).toBe(true)

    store.putLocalThread(id, localThread('t-a'))
    expect(store.getLocalThread(id, 't-a')!.id).toBe('t-a')
    expect(store.listLocalThreads(id).map((t) => t.id)).toEqual(['t-a'])

    store.putLocalSubmittedReview(id, submittedReview(entityId))
    expect(store.listLocalSubmittedReviews(id).map((r) => r.id)).toEqual([entityId])

    store.patchLocalReviewSync(id, syncState())
    expect(store.getLocalReview(id)!.headSha).toBe('head-sha')

    store.deleteLocalDraft('h1', id)
    expect(store.getLocalDraft('h1', id)).toBeNull()

    // The keyspace's only multi-table delete, driven LAST because it removes the
    // review everything above was written against. Six DELETE statements in one
    // transaction is the widest reach anything here has, and the tripwires are
    // what say it reaches no further: a DELETE that named `snapshots` instead of
    // `local_snapshots` would abort here rather than quietly discard a pull
    // request's cached snapshot.
    store.putLocalDraft(draft('h2', id, 'a second human, so the delete spans humans'))
    store.setLocalViewed('h2', id, { 'a.ts': { viewed: true, blobSha: 'headblob', at: 'now' } })
    expect(store.deleteLocalReview(id)).toEqual({
      reviewsDeleted: 1,
      snapshotsDeleted: 1,
      threadsDeleted: 1,
      submittedReviewsDeleted: 1,
      draftsDeleted: 1,
      viewedDeleted: 2,
    })
    expect(store.getLocalReview(id)).toBeNull()

    armed.close()

    // Read back out of the calls that actually happened and compared against the
    // interface's own local surface, so a method added to `DirectStore` and left
    // out of the drive above turns this red instead of quietly going unswept.
    expect([...driven].filter((name) => name.includes(LOCAL_METHOD_MARKER)).sort()).toEqual(
      declaredLocalMethods(),
    )
  })

  test('the swept surface is the store\'s own local surface, not a list beside it', () => {
    const store = open()
    const onTheStore = Object.keys(store)
      .filter((name) => name.includes(LOCAL_METHOD_MARKER))
      .sort()
    store.close()
    expect(onTheStore).toEqual(declaredLocalMethods())
  })

  test('the local surface is twenty methods', () => {
    // An independent literal, not another expression over the same map. Every
    // other coverage check here compares two derived sets, and derived sets stay
    // in agreement through a method deleted from the interface, the map and the
    // sweep together — a hardcoded count is the only one of these that notices
    // the swept surface silently shrinking. Changing it is a deliberate act.
    expect(declaredLocalMethods()).toHaveLength(20)
  })
})

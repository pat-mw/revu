/**
 * The durable SQLite store. These tests run entirely network-free and disk-local
 * (a temp data dir per test), asserting: persist/read round-trips; a durable
 * write failure surfaces as a typed error (never swallowed); a present-but-
 * unreadable row is distinguished from an absent one; and a store-version bump
 * migrates IN PLACE, preserving drafts. The two-half cache table (`immutables`)
 * is exercised for reuse-across-restart.
 *
 * The last block installs SQLite tripwires on the three tables whose integer key
 * is a real GitHub pull-request number, and proves they abort a write. That is
 * the negative control every absence-shaped claim about those tables depends on:
 * "nothing wrote `snapshots`" is worth something only while a write that did
 * reach `snapshots` would fail loudly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type {
  FileBlob,
  ReviewDraft,
  Snapshot,
  SnapshotImmutable,
} from '@revu/shared'
import {
  openDirectStore,
  resolveDirectDataDir,
  StoreUnreadableError,
  StoreWriteError,
  STORE_VERSION,
  type AuditEntry,
  type DirectStore,
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

function immutable(compareKey: string): SnapshotImmutable {
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
    blobIndex: { 'a.ts': { base: 'baseblob', head: 'headblob' } },
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
})

describe('durability: write failures surface, never swallowed', () => {
  test('a write against a closed database throws StoreWriteError, not a silent success', () => {
    const store = open()
    store.close()
    expect(() => store.putDraft(draft('h1', 204, 'x'))).toThrow(StoreWriteError)
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
})

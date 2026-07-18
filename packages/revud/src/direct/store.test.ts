/**
 * The durable SQLite store. These tests run entirely network-free and disk-local
 * (a temp data dir per test), asserting: persist/read round-trips; a durable
 * write failure surfaces as a typed error (never swallowed); a present-but-
 * unreadable row is distinguished from an absent one; and a store-version bump
 * migrates IN PLACE, preserving drafts. The two-half cache table (`immutables`)
 * is exercised for reuse-across-restart.
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

/**
 * The host-side durable store. These tests run entirely network-free and
 * disk-local (a temp data dir per test), asserting the security contract:
 * every row is keyed by the resolved `coder.owner` binding, workspace-claimed
 * identity in pulled payloads is discarded on landing, audit landing is
 * idempotent under full-journal re-pulls and validates the attacker-shaped
 * non-identity fields (rejecting rather than silently dropping or blocking),
 * the all-humans audit union is reachable only by calling it by name,
 * offboarding purges working state atomically but never the journal, and the
 * durability discipline (fail-loud writes, absent vs unreadable,
 * migrate-in-place) matches the direct store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { FileViewedState, ReviewDraft } from '@revu/shared'
import { StoreUnreadableError, StoreWriteError, type AuditEntry } from '../direct/store'
import { createMapCoderOwnerResolver } from './identity-binding'
import {
  HOST_STORE_VERSION,
  openHostStore,
  resolveHostDataDir,
  UnboundOwnerError,
  type HostStore,
} from './host-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revu-host-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Bindings for the humans these tests know about; `mallory` is deliberately absent. */
const resolver = createMapCoderOwnerResolver({
  alice: { email: 'alice@corp.com' },
  bob: { email: 'bob@corp.com' },
  victim: { email: 'victim@corp.com' },
})

function open(): HostStore {
  return openHostStore({ resolver, dataDir: dir })
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

function viewedState(): FileViewedState {
  return { 'a.ts': { viewed: true, blobSha: 's1', at: '2026-01-01T00:00:00.000Z' } }
}

function auditEntry(over: Partial<AuditEntry>): AuditEntry {
  return {
    githubId: 9001,
    humanId: 'workspace-claimed@spoof.io',
    workspace: 'workspace-claimed-label',
    endpoint: 'submitReview',
    pr: 204,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('resolveHostDataDir', () => {
  test('honors REVU_HOST_DATA_DIR over XDG', () => {
    expect(resolveHostDataDir({ REVU_HOST_DATA_DIR: '/tmp/h' })).toBe('/tmp/h')
  })

  test('uses XDG_DATA_HOME/revu/host when set', () => {
    expect(resolveHostDataDir({ XDG_DATA_HOME: '/home/u/.data' })).toBe('/home/u/.data/revu/host')
  })

  test('falls back to ~/.local/share/revu/host', () => {
    expect(resolveHostDataDir({}).endsWith('/.local/share/revu/host')).toBe(true)
  })
})

describe('re-keying neutralizes workspace-claimed identity', () => {
  test('a draft with a spoofed embedded humanId lands under the BINDING email', () => {
    const store = open()
    // The workspace claims the draft belongs to the victim; the channel says
    // the container is alice's. The binding wins, the claim is discarded.
    store.landDraft('alice', draft('victim@corp.com', 204, 'spoofed attribution'))

    const read = store.getDraft('alice', 204)
    expect(read).not.toBeNull()
    expect(read!.humanId).toBe('alice@corp.com')
    expect(read!.body).toBe('spoofed attribution')

    // The victim's keyspace is untouched: nothing readable there.
    expect(store.getDraft('victim', 204)).toBeNull()
    store.close()

    // Pin the landing itself (not just the read path): the raw row is keyed by
    // alice's email and the persisted JSON already carries the re-keyed id.
    const raw = new Database(join(dir, 'host.sqlite'))
    const rows = raw.query('SELECT human_id, data FROM drafts').all() as {
      human_id: string
      data: string
    }[]
    raw.close()
    expect(rows).toHaveLength(1)
    expect(rows[0].human_id).toBe('alice@corp.com')
    expect((JSON.parse(rows[0].data) as ReviewDraft).humanId).toBe('alice@corp.com')
  })

  test('getDraft re-stamps humanId from the binding even after an out-of-band edit of the row', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'work'))
    store.close()
    // Simulate an out-of-band edit (or a future migration bug) that rewrites
    // the embedded humanId inside the stored JSON while leaving the row key
    // alone — the exact drift the read-side re-stamp exists to neutralize.
    const raw = new Database(join(dir, 'host.sqlite'))
    const row = raw
      .query("SELECT data FROM drafts WHERE human_id = 'alice@corp.com' AND pr_number = 204")
      .get() as { data: string }
    const tampered = { ...(JSON.parse(row.data) as ReviewDraft), humanId: 'victim@corp.com' }
    raw.run("UPDATE drafts SET data = ? WHERE human_id = 'alice@corp.com' AND pr_number = 204", [
      JSON.stringify(tampered),
    ])
    raw.close()
    // The read boundary enforces key == embedded id regardless of disk state.
    const reopened = open()
    const read = reopened.getDraft('alice', 204)
    expect(read!.humanId).toBe('alice@corp.com')
    expect(read!.body).toBe('work')
    reopened.close()
  })

  test('landViewed keys by the binding email, not anything workspace-claimed', () => {
    const store = open()
    store.landViewed('alice', 204, viewedState())
    expect(store.getViewed('alice', 204)['a.ts'].viewed).toBe(true)
    // A different human's owner reads nothing.
    expect(store.getViewed('bob', 204)).toEqual({})
    store.close()
  })

  test('landAudit rewrites human_id and workspace from the binding, discarding the pulled claims', () => {
    const store = open()
    const spoofed = auditEntry({
      githubId: 4242,
      humanId: 'victim@corp.com',
      workspace: 'not-alices-container',
    })
    store.landAudit('alice', [spoofed])

    const entries = store.listAuditUnion()
    expect(entries).toHaveLength(1)
    // Identity fields come from the channel, non-identity fields from the entry.
    expect(entries[0]).toEqual({
      githubId: 4242,
      humanId: 'alice@corp.com',
      workspace: 'alice',
      endpoint: 'submitReview',
      pr: 204,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Nothing attributed the row to the pulled claims.
    expect(store.listAuditForOwner('victim')).toEqual([])
    store.close()
  })
})

describe('cross-owner refusal: the binding is the only key', () => {
  test('a draft landed under owner A is not readable under owner B', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'private work'))
    expect(store.getDraft('bob', 204)).toBeNull()
    expect(store.getDraft('alice', 204)!.body).toBe('private work')
    store.close()
  })

  test('there is no email path: passing an email where an owner belongs fails loud', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'private work'))
    // The classic hole this store exists to close: reading a human's drafts by
    // supplying their email. An email is not a coder.owner, so it does not
    // resolve — the read throws instead of returning the victim's draft.
    expect(() => store.getDraft('alice@corp.com', 204)).toThrow(UnboundOwnerError)
    store.close()
  })
})

describe('durability across a workspace rebuild', () => {
  test('a landed draft survives close + reopen on the same file', () => {
    const first = open()
    first.landDraft('alice', draft('alice@corp.com', 204, 'must survive the rebuild'))
    first.landViewed('alice', 204, viewedState())
    first.landAudit('alice', [auditEntry({ githubId: 1 })])
    first.close()

    const second = open()
    expect(second.getDraft('alice', 204)!.body).toBe('must survive the rebuild')
    expect(second.getViewed('alice', 204)['a.ts'].viewed).toBe(true)
    expect(second.listAuditUnion()).toHaveLength(1)
    second.close()
  })
})

describe('idempotent audit landing', () => {
  test('re-landing the same journal inserts nothing the second time', () => {
    const store = open()
    const journal = [
      auditEntry({ githubId: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      auditEntry({ githubId: 2, createdAt: '2026-01-02T00:00:00.000Z' }),
    ]
    expect(store.landAudit('alice', journal)).toEqual({ landed: 2, rejected: [] })
    // The collector pulls the FULL journal every tick: a re-pull is a no-op —
    // the ON CONFLICT DO NOTHING dedup reports zero landed, nothing rejected.
    expect(store.landAudit('alice', journal)).toEqual({ landed: 0, rejected: [] })
    expect(store.listAuditUnion()).toHaveLength(2)
    store.close()
  })

  test('genuinely distinct rows are BOTH retained, not collapsed', () => {
    const store = open()
    // An idempotent-retry double-journal: same GitHub id, different createdAt.
    const retryA = auditEntry({ githubId: 4242, createdAt: '2026-01-01T00:00:00.000Z' })
    const retryB = auditEntry({ githubId: 4242, createdAt: '2026-01-01T00:00:05.000Z' })
    // Same id and timestamp but a different endpoint is also a distinct row.
    const otherEndpoint = auditEntry({
      githubId: 4242,
      createdAt: '2026-01-01T00:00:00.000Z',
      endpoint: 'replyToThread',
    })
    expect(store.landAudit('alice', [retryA, retryB, otherEndpoint])).toEqual({
      landed: 3,
      rejected: [],
    })
    expect(store.listAuditUnion()).toHaveLength(3)
    store.close()
  })

  test('the same tuple landed by two DIFFERENT owners stays two rows (per-human identity)', () => {
    const store = open()
    const entry = auditEntry({ githubId: 7 })
    store.landAudit('alice', [entry])
    // Re-keying makes bob's copy a different stored tuple, so it must not be
    // deduped against alice's.
    expect(store.landAudit('bob', [entry])).toEqual({ landed: 1, rejected: [] })
    expect(store.listAuditUnion()).toHaveLength(2)
    store.close()
  })

  test('an empty journal lands zero rows (but still requires a binding)', () => {
    const store = open()
    expect(store.landAudit('alice', [])).toEqual({ landed: 0, rejected: [] })
    expect(() => store.landAudit('mallory', [])).toThrow(UnboundOwnerError)
    store.close()
  })
})

describe('landAudit validation: malformed pulled rows are rejected, never swallowed', () => {
  test('a null githubId is rejected with a field-naming reason while valid rows land', () => {
    const store = open()
    // Valid JSON, hostile shape: the journal is produced inside the
    // contractor's container, so a null here is fully attacker-reachable.
    const poisoned = auditEntry({ githubId: null as unknown as number })
    const good = auditEntry({ githubId: 7 })
    const result = store.landAudit('alice', [poisoned, good])
    // Not silently swallowed (the INSERT OR IGNORE failure mode this pins
    // against), and not a poison pill: the bad row is reported by input
    // index, the good row in the same batch still lands.
    expect(result.landed).toBe(1)
    expect(result.rejected).toEqual([
      { index: 0, reason: 'githubId is not a positive safe integer' },
    ])
    expect(store.listAuditUnion().map((e) => e.githubId)).toEqual([7])
    store.close()
  })

  test('type-lies and oversized fields are rejected before column affinity can store them', () => {
    const store = open()
    const longCreatedAt = 'x'.repeat(41)
    const longEndpoint = 'e'.repeat(65)
    const batch = [
      // A string in the INTEGER column would land as-is under SQLite column
      // affinity with no constraint violation — validation must catch it.
      auditEntry({ githubId: '1 OR 1=1' as unknown as number }),
      auditEntry({ pr: '204' as unknown as number }),
      auditEntry({ createdAt: longCreatedAt }),
      auditEntry({ endpoint: longEndpoint }),
      auditEntry({ endpoint: '' }),
      auditEntry({ githubId: 3 }),
    ]
    const result = store.landAudit('alice', batch)
    expect(result.landed).toBe(1)
    expect(result.rejected).toEqual([
      { index: 0, reason: 'githubId is not a positive safe integer' },
      { index: 1, reason: 'pr is not a positive safe integer' },
      { index: 2, reason: 'createdAt exceeds 40 characters' },
      { index: 3, reason: 'endpoint exceeds 64 characters' },
      { index: 4, reason: 'endpoint is empty' },
    ])
    // Reasons name the field, never the pulled content.
    const reasons = JSON.stringify(result.rejected)
    expect(reasons).not.toContain('1 OR 1=1')
    expect(reasons).not.toContain(longCreatedAt)
    expect(reasons).not.toContain(longEndpoint)
    // The journal holds exactly the valid row — nothing corrupt-typed landed.
    const landed = store.listAuditUnion()
    expect(landed).toHaveLength(1)
    expect(landed[0].githubId).toBe(3)
    store.close()
  })

  test('an all-invalid batch lands nothing and rejects everything, without throwing', () => {
    const store = open()
    const result = store.landAudit('alice', [
      auditEntry({ githubId: 0 }),
      auditEntry({ createdAt: '' }),
    ])
    expect(result.landed).toBe(0)
    expect(result.rejected.map((r) => r.index)).toEqual([0, 1])
    expect(store.listAuditUnion()).toEqual([])
    store.close()
  })

  test('a null journal element is rejected as a row, never a thrown poison pill', () => {
    const store = open()
    // `[null, {...}]` is valid JSON for a pulled journal: the null must land
    // in `rejected` while the real row still lands.
    const result = store.landAudit('alice', [
      null as unknown as AuditEntry,
      auditEntry({ githubId: 11 }),
    ])
    expect(result.landed).toBe(1)
    expect(result.rejected).toEqual([{ index: 0, reason: 'entry is not an object' }])
    expect(store.listAuditUnion().map((e) => e.githubId)).toEqual([11])
    store.close()
  })
})

describe('listAuditForOwner narrows, listAuditUnion is the deliberate cross-human read', () => {
  function seed(store: HostStore): void {
    store.landAudit('alice', [
      auditEntry({ githubId: 1, pr: 7, createdAt: '2026-01-01T00:00:00.000Z' }),
      auditEntry({ githubId: 2, pr: 8, createdAt: '2026-01-02T00:00:00.000Z' }),
    ])
    store.landAudit('bob', [
      auditEntry({ githubId: 3, pr: 7, createdAt: '2026-01-03T00:00:00.000Z' }),
    ])
  }

  test('listAuditUnion returns ALL humans rows for a PR (the out-of-band union)', () => {
    const store = open()
    seed(store)
    const union = store.listAuditUnion({ pr: 7 })
    expect(union.map((e) => e.githubId)).toEqual([1, 3])
    expect(union.map((e) => e.humanId).sort()).toEqual(['alice@corp.com', 'bob@corp.com'])
    store.close()
  })

  test('listAuditForOwner resolves the binding and narrows to that human', () => {
    const store = open()
    seed(store)
    expect(store.listAuditForOwner('alice').map((e) => e.githubId)).toEqual([1, 2])
    expect(store.listAuditForOwner('alice', { pr: 7 }).map((e) => e.githubId)).toEqual([1])
    store.close()
  })

  test('listAuditForOwner fails loud on an unknown, absent, or non-string owner — it can never widen to the union', () => {
    const store = open()
    seed(store)
    expect(() => store.listAuditForOwner('mallory')).toThrow(UnboundOwnerError)
    // The exact bug the method split closes: an absent container label
    // (`container.labels['coder.owner']` returning undefined) reaching the
    // owner-scoped read must throw, never silently return every human's rows.
    expect(() => store.listAuditForOwner(undefined as unknown as string)).toThrow(
      UnboundOwnerError,
    )
    // Nor can a filter object smuggled into the owner slot reach the union.
    expect(() => store.listAuditForOwner({ pr: 7 } as unknown as string)).toThrow(
      UnboundOwnerError,
    )
    store.close()
  })

  test('sinceIso is inclusive and combines on both methods', () => {
    const store = open()
    seed(store)
    expect(
      store.listAuditUnion({ sinceIso: '2026-01-02T00:00:00.000Z' }).map((e) => e.githubId),
    ).toEqual([2, 3])
    expect(
      store
        .listAuditForOwner('alice', { sinceIso: '2026-01-02T00:00:00.000Z' })
        .map((e) => e.githubId),
    ).toEqual([2])
    store.close()
  })

  test('rows come back oldest → newest in insertion order', () => {
    const store = open()
    store.landAudit('alice', [
      auditEntry({ githubId: 1, createdAt: '2026-01-03T00:00:00.000Z' }),
      auditEntry({ githubId: 2, createdAt: '2026-01-01T00:00:00.000Z' }),
    ])
    // Insertion order, NOT timestamp order: the journal reads back as landed.
    expect(store.listAuditUnion().map((e) => e.githubId)).toEqual([1, 2])
    store.close()
  })
})

describe('purgeWorkingState: offboarding removes work, never history', () => {
  test('purges drafts + viewed, retains audit rows, and reports counts', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'work'))
    store.landDraft('alice', draft('alice@corp.com', 205, 'more work'))
    store.landViewed('alice', 204, viewedState())
    store.landAudit('alice', [auditEntry({ githubId: 1 })])
    // Another human's state must be untouched by alice's offboarding.
    store.landDraft('bob', draft('bob@corp.com', 204, 'bobs work'))

    expect(store.purgeWorkingState('alice')).toEqual({ draftsPurged: 2, viewedPurged: 1 })

    expect(store.getDraft('alice', 204)).toBeNull()
    expect(store.getDraft('alice', 205)).toBeNull()
    expect(store.getViewed('alice', 204)).toEqual({})
    // The journal survives: permanent attribution history.
    expect(store.listAuditForOwner('alice')).toHaveLength(1)
    // Bob is untouched.
    expect(store.getDraft('bob', 204)!.body).toBe('bobs work')
    store.close()
  })

  test('a re-onboarded same owner starts clean: no stale drafts, history intact', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'pre-offboarding'))
    store.landAudit('alice', [auditEntry({ githubId: 1 })])
    store.purgeWorkingState('alice')
    store.close()

    const reopened = open()
    expect(reopened.getDraft('alice', 204)).toBeNull()
    expect(reopened.listAuditForOwner('alice')).toHaveLength(1)
    // A second purge finds nothing to remove.
    expect(reopened.purgeWorkingState('alice')).toEqual({ draftsPurged: 0, viewedPurged: 0 })
    reopened.close()
  })
})

describe('UnboundOwnerError: an unknown owner fails loud on every path', () => {
  test('every binding-keyed method throws for an owner the resolver does not know', () => {
    const store = open()
    expect(() => store.landDraft('mallory', draft('x@y.z', 204, 'w'))).toThrow(UnboundOwnerError)
    expect(() => store.landViewed('mallory', 204, viewedState())).toThrow(UnboundOwnerError)
    expect(() => store.landAudit('mallory', [auditEntry({})])).toThrow(UnboundOwnerError)
    expect(() => store.getDraft('mallory', 204)).toThrow(UnboundOwnerError)
    expect(() => store.getViewed('mallory', 204)).toThrow(UnboundOwnerError)
    expect(() => store.purgeWorkingState('mallory')).toThrow(UnboundOwnerError)
    expect(() => store.listAuditForOwner('mallory')).toThrow(UnboundOwnerError)
    store.close()
  })

  test('the error names the owner so the dropped human is visible', () => {
    const store = open()
    try {
      store.getDraft('mallory', 204)
      throw new Error('expected UnboundOwnerError')
    } catch (err) {
      expect(err).toBeInstanceOf(UnboundOwnerError)
      expect((err as UnboundOwnerError).coderOwner).toBe('mallory')
    }
    store.close()
  })
})

describe('durability: write failures surface, never swallowed', () => {
  test('a landing against a closed database throws StoreWriteError, not a silent success', () => {
    const store = open()
    store.close()
    expect(() => store.landDraft('alice', draft('alice@corp.com', 204, 'x'))).toThrow(
      StoreWriteError,
    )
    expect(() => store.landAudit('alice', [auditEntry({})])).toThrow(StoreWriteError)
  })
})

describe('absent vs unreadable', () => {
  test('a missing draft reads back as null; missing viewed as {}', () => {
    const store = open()
    expect(store.getDraft('alice', 999)).toBeNull()
    expect(store.getViewed('alice', 999)).toEqual({})
    store.close()
  })

  test('a present-but-corrupt draft row throws StoreUnreadableError, never returns null', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'real work'))
    store.close()
    // Corrupt the stored JSON directly, simulating an I/O fault / partial write.
    const raw = new Database(join(dir, 'host.sqlite'))
    raw.run(
      "UPDATE drafts SET data = '{not valid json' WHERE human_id = 'alice@corp.com' AND pr_number = 204",
    )
    raw.close()
    const reopened = open()
    expect(() => reopened.getDraft('alice', 204)).toThrow(StoreUnreadableError)
    reopened.close()
  })

  test('a present-but-corrupt viewed row throws StoreUnreadableError', () => {
    const store = open()
    store.landViewed('alice', 204, viewedState())
    store.close()
    const raw = new Database(join(dir, 'host.sqlite'))
    raw.run("UPDATE viewed SET data = 'nope{' WHERE human_id = 'alice@corp.com'")
    raw.close()
    const reopened = open()
    expect(() => reopened.getViewed('alice', 204)).toThrow(StoreUnreadableError)
    reopened.close()
  })
})

describe('HOST_STORE_VERSION migrates in place', () => {
  test('a fresh file is stamped at the current version', () => {
    const store = open()
    store.close()
    const raw = new Database(join(dir, 'host.sqlite'))
    const row = raw.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    raw.close()
    expect(Number(row.value)).toBe(HOST_STORE_VERSION)
  })

  test('an older-version file keeps its rows and stamps forward, never reseeds', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'must survive a version bump'))
    store.landAudit('alice', [auditEntry({ githubId: 1 })])
    store.close()

    const raw = new Database(join(dir, 'host.sqlite'))
    raw.run("UPDATE meta SET value = '0' WHERE key = 'store_version'")
    raw.close()

    const reopened = open()
    expect(reopened.getDraft('alice', 204)!.body).toBe('must survive a version bump')
    expect(reopened.listAuditUnion()).toHaveLength(1)
    reopened.close()

    const check = new Database(join(dir, 'host.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    check.close()
    expect(Number(after.value)).toBe(HOST_STORE_VERSION)
  })

  test('a file from a NEWER build is left untouched, not downgraded or reseeded', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'from the future'))
    store.close()
    const raw = new Database(join(dir, 'host.sqlite'))
    raw.run("UPDATE meta SET value = '999' WHERE key = 'store_version'")
    raw.close()
    const reopened = open()
    expect(reopened.getDraft('alice', 204)!.body).toBe('from the future')
    reopened.close()
    const check = new Database(join(dir, 'host.sqlite'))
    const after = check.query("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string
    }
    check.close()
    expect(after.value).toBe('999')
  })
})

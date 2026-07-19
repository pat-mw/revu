/**
 * Audit-journal integrity + channel-binding verification for the host store.
 *
 * The journal is the compliance record of every mediated write under the
 * shared bot identity, so these tests pin the properties an auditor relies on:
 *
 *   - APPEND-ONLY: neither store exposes (or contains SQL for) any update or
 *     delete path over `audit_log`; offboarding purges working state while
 *     every journal row survives.
 *   - CHANNEL BINDING: every landed row is re-keyed host-side — `human_id`
 *     becomes the `coder.owner` binding's email and `workspace` the
 *     channel-authentic owner label — DISCARDING the workspace-claimed
 *     identity fields of the pulled payload, which a sudo-holding contractor
 *     fully controls.
 *   - IDEMPOTENT LANDING: the dedup is the full-tuple `ON CONFLICT … DO
 *     NOTHING` (never a blanket `INSERT OR IGNORE` that would also swallow
 *     constraint violations), so a full-journal re-pull lands nothing new and
 *     one human's rows can never suppress another's.
 *   - HOST-SIDE VALIDATION: malformed pulled rows are rejected individually,
 *     with reasons that name the field but never echo the hostile value, and
 *     never block the valid rows in the same batch.
 *
 * Everything runs disk-local against per-test temp stores; raw SQLite reads
 * pin what actually landed, independent of the store's own read path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { ReviewDraft } from '@revu/shared'
import { detectOutOfBandWrites, splitJournaledIds } from '../broker/out-of-band-writes'
import type { AuditEntry } from '../direct/store'
import { openDirectStore } from '../direct/store'
import { createMapCoderOwnerResolver } from './identity-binding'
import { offboardHuman } from './offboard'
import { openHostStore, UnboundOwnerError, type HostStore } from './host-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revu-audit-integrity-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Bindings for the known humans; `mallory` is deliberately absent. */
const resolver = createMapCoderOwnerResolver({
  alice: { email: 'alice@corp.com' },
  bob: { email: 'bob@corp.com' },
})

function open(): HostStore {
  return openHostStore({ resolver, dataDir: dir })
}

/** A pulled journal row whose identity fields are workspace-claimed lies. */
function spoofedEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    githubId: 9001,
    humanId: 'victim@corp.com',
    workspace: 'victim',
    endpoint: 'submitReview',
    pr: 204,
    createdAt: '2026-07-01T00:00:00.000Z',
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
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }
}

function rawAuditRows(): {
  github_id: number
  human_id: string
  workspace: string
  endpoint: string
  pr: number
  created_at: string
}[] {
  const raw = new Database(join(dir, 'host.sqlite'))
  const rows = raw
    .query('SELECT github_id, human_id, workspace, endpoint, pr, created_at FROM audit_log ORDER BY rowid')
    .all() as {
    github_id: number
    human_id: string
    workspace: string
    endpoint: string
    pr: number
    created_at: string
  }[]
  raw.close()
  return rows
}

describe('append-only: no update/delete path exists over audit_log', () => {
  const hostStoreSource = readFileSync(new URL('./host-store.ts', import.meta.url), 'utf8')
  const directStoreSource = readFileSync(
    new URL('../direct/store.ts', import.meta.url),
    'utf8',
  )

  test('neither store module contains SQL that rewrites or removes an audit row', () => {
    for (const source of [hostStoreSource, directStoreSource]) {
      expect(source).not.toMatch(/UPDATE\s+audit_log/i)
      expect(source).not.toMatch(/DELETE\s+FROM\s+audit_log/i)
      expect(source).not.toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?audit_log/i)
      // A blanket OR-IGNORE insert would swallow NOT NULL violations too,
      // making a discarded row indistinguishable from a dedup — banned. The
      // statement form (with INTO) is matched so a doc comment naming the
      // banned construct does not trip the scan.
      expect(source).not.toMatch(/INSERT\s+OR\s+IGNORE\s+INTO/i)
    }
    // The host landing targets the FULL stored tuple, so only a byte-identical
    // re-pull dedups; any other conflict still aborts loudly.
    expect(hostStoreSource).toContain(
      'ON CONFLICT(github_id, human_id, workspace, endpoint, pr, created_at) DO NOTHING',
    )
  })

  test('the store surfaces expose append/land + read only — no audit mutation method', () => {
    const host = open()
    const hostAuditMethods = Object.keys(host).filter((k) => /audit/i.test(k)).sort()
    expect(hostAuditMethods).toEqual(['landAudit', 'listAuditForOwner', 'listAuditUnion'])
    host.close()

    const direct = openDirectStore({ dataDir: dir })
    const directAuditMethods = Object.keys(direct).filter((k) => /audit/i.test(k)).sort()
    expect(directAuditMethods).toEqual(['appendAudit', 'listAudit'])
    direct.close()
  })

  test('offboarding purges working state atomically while every audit row survives', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'wip'))
    store.landViewed('alice', 204, { 'a.ts': { viewed: true, blobSha: 's', at: '2026-07-01T00:00:00.000Z' } })
    const landed = store.landAudit('alice', [
      spoofedEntry({ githubId: 1 }),
      spoofedEntry({ githubId: 2, endpoint: 'replyToThread' }),
    ])
    expect(landed.landed).toBe(2)

    const result = offboardHuman(store, 'alice')
    expect(result.draftsPurged).toBe(1)
    expect(result.viewedPurged).toBe(1)
    expect(result.auditRetained).toBe(2)
    // The working state is gone; the journal is byte-for-byte intact.
    expect(store.getDraft('alice', 204)).toBeNull()
    expect(store.getViewed('alice', 204)).toEqual({})
    expect(store.listAuditForOwner('alice')).toHaveLength(2)
    store.close()
    expect(rawAuditRows()).toHaveLength(2)
  })
})

describe('channel binding: every landed row is re-keyed host-side', () => {
  test('a pulled row claiming another identity lands under the BINDING email and channel owner', () => {
    const store = open()
    const { landed } = store.landAudit('alice', [spoofedEntry()])
    expect(landed).toBe(1)
    store.close()

    const rows = rawAuditRows()
    expect(rows).toHaveLength(1)
    // Identity comes from the channel, never the payload: the claimed
    // `victim@corp.com` / `victim` never reach disk.
    expect(rows[0].human_id).toBe('alice@corp.com')
    expect(rows[0].workspace).toBe('alice')
    // Only the validated non-identity fields survive from the pulled entry.
    expect(rows[0].github_id).toBe(9001)
    expect(rows[0].endpoint).toBe('submitReview')
    expect(rows[0].pr).toBe(204)
    expect(rows[0].created_at).toBe('2026-07-01T00:00:00.000Z')
  })

  test('the spoofed identity is unreachable through every read path', () => {
    const store = open()
    store.landAudit('alice', [spoofedEntry()])
    // The claimed identity resolves to no binding, so reading "as the victim"
    // fails loud rather than showing the forged attribution.
    expect(() => store.listAuditForOwner('victim')).toThrow(UnboundOwnerError)
    // Alice's own read shows the row as HERS.
    const rows = store.listAuditForOwner('alice')
    expect(rows).toHaveLength(1)
    expect(rows[0].humanId).toBe('alice@corp.com')
    expect(rows[0].workspace).toBe('alice')
    store.close()
  })

  test('an unbound owner lands NOTHING — fail-loud, never a silent drop or a landing', () => {
    const store = open()
    expect(() => store.landAudit('mallory', [spoofedEntry()])).toThrow(UnboundOwnerError)
    store.close()
    expect(rawAuditRows()).toHaveLength(0)
  })
})

describe('idempotent landing: full-tuple dedup, never cross-human suppression', () => {
  test('a full-journal re-pull lands zero new rows; a genuinely new row still lands', () => {
    const store = open()
    const journal = [
      spoofedEntry({ githubId: 1 }),
      spoofedEntry({ githubId: 2, endpoint: 'replyToThread' }),
      spoofedEntry({ githubId: 3, pr: 205 }),
    ]
    expect(store.landAudit('alice', journal).landed).toBe(3)
    // The collector re-pulls the FULL journal every tick: byte-identical rows
    // insert nothing.
    expect(store.landAudit('alice', journal).landed).toBe(0)
    // A new row appended to the workspace journal lands alongside.
    expect(
      store.landAudit('alice', [...journal, spoofedEntry({ githubId: 4 })]).landed,
    ).toBe(1)
    store.close()
    expect(rawAuditRows()).toHaveLength(4)
  })

  test('an identical payload pulled from ANOTHER human lands separately — dedup cannot erase attribution', () => {
    const store = open()
    const journal = [spoofedEntry({ githubId: 77 })]
    expect(store.landAudit('alice', journal).landed).toBe(1)
    // Bob's container pulls a byte-identical journal row: the stored tuple
    // differs in the host-derived identity columns, so it lands as BOB's row —
    // one human's landing can never suppress or overwrite another's.
    expect(store.landAudit('bob', journal).landed).toBe(1)
    expect(store.listAuditForOwner('alice')).toHaveLength(1)
    expect(store.listAuditForOwner('bob')).toHaveLength(1)
    // The union — reachable only by calling it BY NAME — sees both.
    expect(store.listAuditUnion()).toHaveLength(2)
    store.close()
  })

  test('rows survive a store reopen (landing is durable, not per-handle)', () => {
    let store = open()
    store.landAudit('alice', [spoofedEntry()])
    store.close()
    store = open()
    expect(store.listAuditForOwner('alice')).toHaveLength(1)
    store.close()
  })
})

describe('host-side validation: malformed pulled rows are rejected, not swallowed — and never block good rows', () => {
  test('a hostile batch lands only the valid rows and reports each rejection by index and field', () => {
    const store = open()
    const hostileEndpoint = 'x'.repeat(65)
    const hostileCreatedAt = 'y'.repeat(41)
    const batch = [
      spoofedEntry({ githubId: 1 }), // 0: valid
      null as unknown as AuditEntry, // 1: not an object
      spoofedEntry({ githubId: '123' as unknown as number }), // 2: wrong-typed id
      spoofedEntry({ githubId: 2, endpoint: hostileEndpoint }), // 3: oversized endpoint
      spoofedEntry({ githubId: 3, pr: -1 }), // 4: invalid pr
      spoofedEntry({ githubId: 4, createdAt: hostileCreatedAt }), // 5: oversized timestamp
      spoofedEntry({ githubId: 5, pr: 206 }), // 6: valid
    ]
    const result = store.landAudit('alice', batch)
    expect(result.landed).toBe(2)
    expect(result.rejected.map((r) => r.index).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    for (const rejection of result.rejected) {
      // The reason names the field/rule — it must never echo the hostile value.
      expect(rejection.reason).not.toContain(hostileEndpoint)
      expect(rejection.reason).not.toContain(hostileCreatedAt)
      expect(rejection.reason).not.toContain('123')
    }
    // The valid rows are readable and correctly attributed despite the junk
    // interleaved around them.
    const rows = store.listAuditForOwner('alice')
    expect(rows.map((r) => r.githubId).sort((a, b) => a - b)).toEqual([1, 5])
    store.close()
    // SQLite column affinity never got a chance to store a type-lie.
    const raw = rawAuditRows()
    for (const row of raw) expect(typeof row.github_id).toBe('number')
  })

  test('an all-invalid batch lands nothing and rejects everything — never throws the tick away', () => {
    const store = open()
    const result = store.landAudit('alice', [
      null as unknown as AuditEntry,
      spoofedEntry({ endpoint: '' }),
    ])
    expect(result.landed).toBe(0)
    expect(result.rejected).toHaveLength(2)
    store.close()
    expect(rawAuditRows()).toHaveLength(0)
  })
})

describe('KNOWN LIMIT (surfaced for triage): journal forgery can self-launder a bypass', () => {
  // Deliberately SKIPPED, not asserted green: this demonstrates a DEFEAT of the
  // out-of-band detector, and keeping it in the passing suite would bless the
  // behavior as desired. The workspace's local journal is fully writable by its
  // sudo-holding contractor; host-side landing validates the SHAPE of pulled
  // rows and re-keys their IDENTITY to the coder.owner binding, but the
  // non-identity fields (githubId, endpoint) remain attacker-chosen. A forged
  // `submitReview` row naming the id of a bot artifact the contractor posted
  // directly to GitHub therefore lands in the union journal and absolves that
  // artifact. The forgery is bounded: re-keying forces the forged row under the
  // forger's OWN binding, so the write stays attributed to them — what is lost
  // is the mediated-vs-out-of-band distinction (e.g. an unstamped bot comment
  // dodging the detector), never cross-human attribution. A candidate
  // mitigation is cross-checking absolved artifacts for the mediated author
  // stamp their bodies must carry.
  test.skipIf(true)('a forged submitReview row absolves the same workspace out-of-band bot review', () => {
    const botLogin = 'revu-app[bot]'
    // On GitHub: one bot-authored review the contractor posted with a raw curl.
    const artifacts = {
      reviews: [{ id: 501, author: { login: botLogin, type: 'Bot' } }],
      reviewComments: [],
      issueComments: [],
    }
    // Against an honest journal the bypass is flagged.
    const honest = detectOutOfBandWrites(splitJournaledIds([]), artifacts, { botLogin })
    expect(honest.outOfBand).toHaveLength(1)
    // Against a journal carrying the forged creating row it is absolved.
    const forged = detectOutOfBandWrites(
      splitJournaledIds([
        { githubId: 501, endpoint: 'submitReview', createdAt: '2026-07-01T00:00:00.000Z' },
      ]),
      artifacts,
      { botLogin },
    )
    expect(forged.outOfBand).toHaveLength(0)
  })
})

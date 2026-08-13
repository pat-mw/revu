/**
 * The store's two persistence variants against a failing storage backend.
 *
 * `flush()` SWALLOWS a `setItem` failure — browser semantics, and load-bearing:
 * quota or privacy mode must not break the session, which keeps working in
 * memory. `flushOrThrow()` PROPAGATES the same failure so a durable host (a
 * daemon whose `localStorage` is a disk file) can surface it instead of
 * reporting success for a write that never landed. In-memory state must survive
 * either way — user-written text is never discarded on a persistence failure.
 *
 * The store is a process-wide singleton shared with other suites, so each test
 * resets it and the storage backend is restored after every test.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { ReviewDraft } from '@revu/shared'
import { migrateStoreDocument, store } from './store'

const STORAGE_KEY = 'revu.broker.v1'
const realSetItem = localStorage.setItem.bind(localStorage)

afterEach(() => {
  localStorage.setItem = realSetItem
  // Leave the shared singleton pristine for the other suites in this process.
  store.reset()
})

function draftWith(body: string): ReviewDraft {
  const at = new Date().toISOString()
  return {
    humanId: 'h-test',
    prNumber: 999,
    headSha: 'test-head-sha',
    compareKey: 'base...test-head-sha',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: at,
    updatedAt: at,
  }
}

describe('flush vs flushOrThrow on a failing storage backend', () => {
  test('flush() swallows a setItem failure; the session keeps working in memory', () => {
    store.reset()
    store.putDraft(draftWith('Typed in the browser — quota must not eat this.'))
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }

    expect(() => {
      store.flush()
    }).not.toThrow()
    // The failed persist discarded nothing: the draft is still fully readable.
    expect(store.getDraft('h-test', 999)?.body).toBe(
      'Typed in the browser — quota must not eat this.',
    )
  })

  test('flushOrThrow() propagates the same failure with state intact, and persists after recovery', () => {
    store.reset()
    store.putDraft(draftWith('Written against a broken disk — must not be lost.'))
    localStorage.setItem = () => {
      throw new Error('ENOSPC: no space left on device')
    }

    expect(() => {
      store.flushOrThrow()
    }).toThrow('ENOSPC')
    // The throw reported the failure; it did not roll back the in-memory write.
    expect(store.getDraft('h-test', 999)?.body).toBe(
      'Written against a broken disk — must not be lost.',
    )

    // The backend recovers: the same call now persists the whole document.
    localStorage.setItem = realSetItem
    store.flushOrThrow()
    expect(localStorage.getItem(STORAGE_KEY) ?? '').toContain(
      'Written against a broken disk — must not be lost.',
    )
  })
})

/**
 * A persisted document written by an older build, containing the fields every
 * version has carried. Freshly built per test so mutations never leak between
 * cases (the migration works in place).
 */
function v2Document(draft: ReviewDraft): Record<string, unknown> {
  return {
    v: 2,
    dev: { humanId: 'h-test', latency: 'zero', failureMode: 'none' },
    drafts: { [draft.humanId]: { [draft.prNumber]: draft } },
    viewed: {},
    snapshots: {},
    blobs: {},
    remoteMut: {},
    syncAttempts: {},
    rate: { remaining: 5000, reset: new Date(Date.now() + 3_600_000).toISOString() },
    counter: 0,
  }
}

/** A v3 document: everything a v2 document has, plus per-human preferences. */
function v3Document(draft: ReviewDraft): Record<string, unknown> {
  return {
    ...v2Document(draft),
    v: 3,
    preferences: { 'h-test': { diffMode: 'split', theme: 'dark', inboxView: 'list' } },
  }
}

describe('migrateStoreDocument', () => {
  test('upgrades a structurally sound v2 document in place, keeping its draft', () => {
    const doc = v2Document(draftWith('Written before the upgrade — must survive it.'))
    const migrated = migrateStoreDocument(doc)

    expect(migrated).not.toBeNull()
    // The document is stamped to the current version, new fields defaulted…
    expect(migrated?.v).toBe(4)
    expect(migrated?.preferences).toEqual({})
    expect(migrated?.localReviews).toEqual({})
    expect(migrated?.localCounters).toEqual({ review: 0, entity: 0 })
    // …and the draft — irreplaceable local work — is still fully readable.
    expect(migrated?.drafts['h-test']?.[999]?.body).toBe(
      'Written before the upgrade — must survive it.',
    )
  })

  test('upgrades a v3 document to v4 with its draft intact and the local-review fields defaulted', () => {
    const doc = v3Document(draftWith('A v3 draft the v4 upgrade must not touch.'))
    const migrated = migrateStoreDocument(doc)

    expect(migrated).not.toBeNull()
    expect(migrated?.v).toBe(4)
    expect(migrated?.localReviews).toEqual({})
    expect(migrated?.localCounters).toEqual({ review: 0, entity: 0 })
    // Fields the older document already carried pass through untouched.
    expect(migrated?.preferences).toEqual({
      'h-test': { diffMode: 'split', theme: 'dark', inboxView: 'list' },
    })
    expect(migrated?.drafts['h-test']?.[999]?.body).toBe(
      'A v3 draft the v4 upgrade must not touch.',
    )
  })

  test('still refuses a document missing a core field instead of waving it through', () => {
    // The durable negative control: the migration must stay able to say "this
    // document is corrupt" — a migration that defaults every absence would
    // silently bless genuinely broken documents forever.
    const doc = v3Document(draftWith('irrelevant'))
    delete (doc as { drafts?: unknown }).drafts
    expect(migrateStoreDocument(doc)).toBeNull()
  })

  test('refuses a document from a future version it cannot reason about', () => {
    const doc = v3Document(draftWith('irrelevant'))
    ;(doc as { v: number }).v = 99
    expect(migrateStoreDocument(doc)).toBeNull()
  })
})

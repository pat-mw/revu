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
import { LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE } from '@revu/shared'
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

/**
 * Ids a document already hands out, one per reserved band and one per kind of
 * record that can hold a band id: the review record itself, a submitted review
 * summary, and a materialized thread comment.
 */
const EXISTING_REVIEW_ID = LOCAL_REVIEW_ID_BASE + 3
const EXISTING_SUMMARY_ID = LOCAL_ENTITY_ID_BASE + 7
const EXISTING_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 9

/**
 * A current-version document holding one local review — its record, one
 * submitted review summary, and one materialized thread comment — with the id
 * high-water counters set by the caller, so a test can present counters that
 * disagree with the records beside them.
 */
function documentWithLocalReview(counters: {
  review: number
  entity: number
}): Record<string, unknown> {
  return {
    ...v3Document(draftWith('A draft beside a local review — the repair must not touch it.')),
    v: 4,
    localReviews: {
      [EXISTING_REVIEW_ID]: {
        id: EXISTING_REVIEW_ID,
        repo: 'meridian-labs/atlas',
        baseRef: 'refs/heads/main',
        headRef: 'refs/heads/feature/counters',
        title: 'feature/counters',
        baseSha: null,
        mergeBaseSha: null,
        headSha: null,
        dirty: false,
        archivedPr: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastSyncedAt: null,
        submitted: [{ id: EXISTING_SUMMARY_ID }],
        threads: [
          {
            id: `local:${EXISTING_REVIEW_ID}:${EXISTING_COMMENT_ID}`,
            comments: [{ id: EXISTING_COMMENT_ID }],
          },
        ],
        commentAuthors: { [EXISTING_COMMENT_ID]: 'h-test' },
      },
    },
    localCounters: counters,
  }
}

describe('migrateStoreDocument repairs local id counters against the records present', () => {
  test('counters lost while their records survived are clamped above every id in the document', () => {
    // Counters can go missing without the records going with them — corruption
    // or a hand-edit. Migrating such a document clean would let the next mint
    // reissue an id a record already answers to, and storing a record is a
    // keyed overwrite, so the live record would be silently replaced.
    const migrated = migrateStoreDocument(documentWithLocalReview({ review: 0, entity: 0 }))

    expect(migrated).not.toBeNull()
    if (!migrated) return

    // Minting resumes strictly ABOVE every id the document already holds.
    expect(LOCAL_REVIEW_ID_BASE + migrated.localCounters.review + 1).toBeGreaterThan(
      EXISTING_REVIEW_ID,
    )
    expect(LOCAL_ENTITY_ID_BASE + migrated.localCounters.entity + 1).toBeGreaterThan(
      EXISTING_SUMMARY_ID,
    )
    expect(LOCAL_ENTITY_ID_BASE + migrated.localCounters.entity + 1).toBeGreaterThan(
      EXISTING_COMMENT_ID,
    )

    // The repair touches the counters and nothing else: the record it was
    // derived from is still there, and so is the draft beside it.
    expect(Object.keys(migrated.localReviews)).toEqual([String(EXISTING_REVIEW_ID)])
    expect(migrated.drafts['h-test']?.[999]?.body).toBe(
      'A draft beside a local review — the repair must not touch it.',
    )
  })

  test('a counter already ahead of the live records is left where it is', () => {
    // The counters are high-water marks, not a scan of live rows: deleting a
    // review must never free its id for reuse, or the next review would
    // inherit the dead one's drafts, viewed state, and client caches. A repair
    // that recomputed from the records would drag both counters back down.
    const migrated = migrateStoreDocument(
      documentWithLocalReview({ review: 900, entity: 4000 }),
    )

    expect(migrated).not.toBeNull()
    expect(migrated?.localCounters).toEqual({ review: 900, entity: 4000 })
  })

  test('a document with no local reviews still defaults both counters to zero', () => {
    // Nothing has been minted, so there is no high-water mark to raise them to.
    const doc = documentWithLocalReview({ review: 0, entity: 0 })
    doc.localReviews = {}
    expect(migrateStoreDocument(doc)?.localCounters).toEqual({ review: 0, entity: 0 })
  })
})

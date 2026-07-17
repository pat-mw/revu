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
import { store } from './store'

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

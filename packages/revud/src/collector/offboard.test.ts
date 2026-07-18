/**
 * The offboarding hook. These tests run entirely in-memory and assert the two
 * compliance obligations directly against a real host store + binding: the
 * purge removes ONLY working state (drafts + viewed) and the audit journal is
 * byte-identical before and after — `auditRetained` is the post-purge count
 * that proves it; a re-onboarded same owner starts with a clean keyspace; and
 * an unbound owner fails loud with nothing purged, pinning the ordering
 * constraint that offboarding must run while the binding still exists.
 */
import { describe, expect, test } from 'bun:test'
import type { FileViewedState, ReviewDraft } from '@revu/shared'
import type { AuditEntry } from '../direct/store'
import { openHostStore, UnboundOwnerError, type HostStore } from './host-store'
import { createMapCoderOwnerResolver } from './identity-binding'
import { offboardHuman } from './offboard'

const resolver = createMapCoderOwnerResolver({
  alice: { email: 'alice@corp.com' },
  bob: { email: 'bob@corp.com' },
})

function open(): HostStore {
  return openHostStore({ resolver, dataDir: ':memory:' })
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
    humanId: 'alice@corp.com',
    workspace: 'alice',
    endpoint: 'submitReview',
    pr: 204,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('offboardHuman purges working state, retains the journal', () => {
  test('drafts + viewed are removed and counted; the audit journal is byte-identical', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'work'))
    store.landDraft('alice', draft('alice@corp.com', 205, 'more work'))
    store.landViewed('alice', 204, viewedState())
    store.landAudit('alice', [
      auditEntry({ githubId: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      auditEntry({ githubId: 2, createdAt: '2026-01-02T00:00:00.000Z' }),
      auditEntry({ githubId: 3, createdAt: '2026-01-03T00:00:00.000Z', endpoint: 'replyToThread' }),
    ])

    const before = store.listAuditForOwner('alice')
    expect(before).toHaveLength(3)

    const result = offboardHuman(store, 'alice')
    expect(result).toEqual({
      coderOwner: 'alice',
      draftsPurged: 2,
      viewedPurged: 1,
      auditRetained: 3,
    })

    // Working state is gone.
    expect(store.getDraft('alice', 204)).toBeNull()
    expect(store.getDraft('alice', 205)).toBeNull()
    expect(store.getViewed('alice', 204)).toEqual({})

    // The journal is not merely "the same length": every row is identical to
    // the pre-offboarding read, in the same order. Retention is total.
    const after = store.listAuditForOwner('alice')
    expect(after).toEqual(before)
    expect(result.auditRetained).toBe(after.length)
    store.close()
  })

  test("offboarding one human never touches another human's rows", () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'alices work'))
    store.landDraft('bob', draft('bob@corp.com', 204, 'bobs work'))
    store.landViewed('bob', 204, viewedState())
    store.landAudit('bob', [auditEntry({ githubId: 7 })])

    const result = offboardHuman(store, 'alice')
    expect(result.draftsPurged).toBe(1)
    // Alice had no audit rows: retention is honestly reported as zero.
    expect(result.auditRetained).toBe(0)

    expect(store.getDraft('bob', 204)!.body).toBe('bobs work')
    expect(store.getViewed('bob', 204)['a.ts'].viewed).toBe(true)
    expect(store.listAuditForOwner('bob')).toHaveLength(1)
    store.close()
  })
})

describe('re-onboarding the same owner starts clean', () => {
  test('after offboarding, the same binding reads no stale drafts and can land fresh work', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'pre-departure work'))
    store.landViewed('alice', 204, viewedState())
    store.landAudit('alice', [auditEntry({ githubId: 1 })])
    offboardHuman(store, 'alice')

    // The re-onboarded human (same coder.owner, same binding) sees an empty
    // working keyspace — no stale drafts attributed to the new engagement —
    // while the prior engagement's journal is still there.
    expect(store.getDraft('alice', 204)).toBeNull()
    expect(store.getViewed('alice', 204)).toEqual({})
    expect(store.listAuditForOwner('alice')).toHaveLength(1)

    // Fresh work lands normally on the clean keyspace.
    store.landDraft('alice', draft('alice@corp.com', 204, 'new engagement'))
    expect(store.getDraft('alice', 204)!.body).toBe('new engagement')

    // A second offboarding finds only the fresh draft, and the journal again
    // survives untouched.
    expect(offboardHuman(store, 'alice')).toEqual({
      coderOwner: 'alice',
      draftsPurged: 1,
      viewedPurged: 0,
      auditRetained: 1,
    })
    store.close()
  })
})

describe('unbound owner: fail loud, purge nothing', () => {
  test('offboarding an owner with no binding throws UnboundOwnerError and removes no rows', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'work'))
    store.landAudit('alice', [auditEntry({ githubId: 1 })])

    // The ordering constraint made concrete: once the owner is out of the
    // binding (here: never in it), offboarding cannot resolve them and must
    // throw rather than guess — and nothing anywhere is purged.
    expect(() => offboardHuman(store, 'mallory')).toThrow(UnboundOwnerError)
    expect(store.getDraft('alice', 204)!.body).toBe('work')
    expect(store.listAuditForOwner('alice')).toHaveLength(1)
    store.close()
  })
})

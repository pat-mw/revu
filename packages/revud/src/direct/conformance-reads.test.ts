/**
 * Contract-conformance for the direct-mode READ path, held to the same
 * invariants the shared `RevuApi` conformance suite encodes — but scoped to what
 * the read path owns today (sync + snapshot + the two-half cache), driven by a
 * fake GitHub client so it stays in the network-free gate. The write path,
 * reconcile, threads, and blob bytes are not implemented yet, so the full
 * parameterized suite (which drives all of those) is not runnable against this
 * adapter; the invariants below are the subset that applies.
 *
 * The headline Verify — base-moved cache keying — is asserted here end to end:
 * a re-sync after the base advances under a fixed head produces a NEW compareKey
 * and rebuilds the immutable half, exactly the scenario the shared suite names
 * `baseAdvanced`. A head-SHA match never short-circuits the mutable fetch.
 */
import { describe, expect, test } from 'bun:test'
import type { GithubClient } from './github-client'
import { createDirectApi, type DirectApi } from './direct-api'
import { openDirectStore, type DirectStore } from './store'
import { CONFORMANCE_REPO, CONFORMANCE_SESSION, movingBaseClient } from './conformance-fakes'

function build(client: GithubClient, store: DirectStore): DirectApi {
  return createDirectApi({
    session: CONFORMANCE_SESSION,
    github: client,
    repo: CONFORMANCE_REPO,
    store,
  })
}

describe('direct read path — contract conformance (reads subset)', () => {
  test('getSnapshot is null (not an error) for a never-synced PR', () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const api = build(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    expect(api.getSnapshot(204)).toBeNull()
  })

  test('a cold sync produces a well-formed snapshot with a populated immutable half', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const api = build(movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }), store)
    const snap = await api.syncPull(204)
    expect(snap.prNumber).toBe(204)
    expect(snap.partial).toBeNull()
    expect(snap.immutable.files.length).toBeGreaterThan(0)
    expect(snap.immutable.compareKey).toBe('MB1...HEAD-FIXED')
    // getSnapshot after sync returns the cached snapshot.
    expect(api.getSnapshot(204)?.immutable.compareKey).toBe('MB1...HEAD-FIXED')
  })

  test('base advanced under a fixed head: compareKey moves and the immutable half rebuilds', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 0 }
    const api = build(movingBaseClient(state), store)

    const first = await api.syncPull(204)
    expect(first.immutable.compareKey).toBe('MB1...HEAD-FIXED')

    // The base branch advances — head is unchanged, but the three-dot diff moved.
    state.mergeBaseSha = 'MB2'
    const second = await api.syncPull(204)

    // A head-only cache would have wrongly reused the stale diff. The compareKey
    // is merge_base...head, so it MOVED and the immutable half was rebuilt.
    expect(second.immutable.headSha).toBe('HEAD-FIXED')
    expect(second.immutable.compareKey).toBe('MB2...HEAD-FIXED')
    expect(second.immutable.blobIndex['a.ts'].base).toBe('base-MB2')
  })

  test('head unchanged still refetches the mutable half (a resolved/added comment lands)', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 2 }
    const api = build(movingBaseClient(state), store)

    const first = await api.syncPull(204)
    expect(first.mutable.issueComments).toHaveLength(2)

    // Nothing about the compare changes (same head, same base) — only the mutable
    // half drifts. A head match must NOT short-circuit the mutable fetch.
    state.unresolvedComments = 0
    const second = await api.syncPull(204)
    expect(second.immutable.compareKey).toBe(first.immutable.compareKey)
    expect(second.mutable.issueComments).toHaveLength(0)
  })
})

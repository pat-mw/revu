/**
 * The workspace's seeded local-only review: a review of a branch pair that has
 * no pull request, present before the app ever loads and reachable with no
 * network and no git behind it.
 *
 * What these assertions hold is that seeding cannot drift into a second truth.
 * A local review is a stored record and nothing else — never a fixture remote
 * pull — so the pull list, which is the row source every review is resolved out
 * of, can reach it exactly one way and can never carry it twice. The rest pins
 * the seeded state to what creating and syncing the same branch pair produces,
 * down to the ref tips: a fixture that drifted from that would open as
 * permanently stale and be emptied by the first sync.
 *
 * The mock store is one process-wide document shared across every test file, so
 * the suite resets it before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PullListResponse, Snapshot } from '@revu/shared'
import { isLocalReviewId, validateSnapshot } from '@revu/shared'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { fixtureDB } from '@/fixtures'

const api = createMockApi()
const fixture = fixtureDB.localReviews[0]

beforeAll(() => {
  mockDev.reset()
  // Latency is simulated per call; the zero profile keeps the walk quick.
  mockDev.setLatency('zero')
})

afterAll(() => {
  mockDev.reset()
})

describe('the seeded local review', () => {
  test('is registered as a local review and never as a remote pull', () => {
    expect(fixtureDB.localReviews).toHaveLength(1)
    // A fixture remote pull carrying a local id would be listed by the remote
    // path as well as the local one: one review, two rows, and only one of the
    // two able to carry the local-only annotations.
    expect(fixtureDB.pulls.filter((p) => isLocalReviewId(p.detail.number))).toEqual([])
    expect(fixtureDB.pulls.some((p) => p.detail.number === fixture.id)).toBe(false)
  })

  test('carries a local review id on the record and on its synthesized pull', () => {
    expect(isLocalReviewId(fixture.id)).toBe(true)
    expect(fixture.snapshot.prNumber).toBe(fixture.id)
    expect(isLocalReviewId(fixture.snapshot.mutable.pull.number)).toBe(true)
    expect(fixture.snapshot.mutable.pull.number).toBe(fixture.id)
    expect(fixture.snapshot.mutable.pull.id).toBe(fixture.id)
  })

  test('reviews a fully qualified branch pair of the fixture repository', () => {
    expect(fixture.baseRef.startsWith('refs/')).toBe(true)
    expect(fixture.headRef.startsWith('refs/')).toBe(true)
    expect(fixture.baseRef).not.toBe(fixture.headRef)

    const pull = fixture.snapshot.mutable.pull
    expect(pull.base.repo.full_name).toBe(fixtureDB.repo.full_name)
    expect(pull.head.repo.full_name).toBe(fixtureDB.repo.full_name)
    // The synthesized pull spells the same two refs the short way a branch is
    // displayed, so the record and the review header name one pair.
    expect(fixture.baseRef).toBe(`refs/heads/${pull.base.ref}`)
    expect(fixture.headRef).toBe(`refs/heads/${pull.head.ref}`)
    // The sentinel author carries a display name; an email is a storage key
    // and is never rendered into a user object.
    expect(JSON.stringify(pull.user)).not.toContain('@')
  })

  test('its snapshot survives the wire form a transport would validate', () => {
    const wire = JSON.parse(JSON.stringify(fixture.snapshot)) as unknown
    expect(validateSnapshot(wire)).toStrictEqual(wire as Snapshot)
  })

  test('has no checks, issue comments or submitted reviews', () => {
    // Nothing reports on a branch that was never pushed, there are no issue
    // comments without an issue, and a submitted local verdict is read from
    // the review's own record rather than from its snapshot.
    expect(fixture.snapshot.mutable.checks).toEqual([])
    expect(fixture.snapshot.mutable.issueComments).toEqual([])
    expect(fixture.snapshot.mutable.reviews).toEqual([])
  })
})

describe('the seeded local review in a freshly seeded workspace', () => {
  test('is a stored review whose cached snapshot is the fixture verbatim', async () => {
    expect(await api.getSnapshot(fixture.id)).toStrictEqual(fixture.snapshot)
  })

  test('is listed with the local-only annotations present as keys', async () => {
    const rows = (await api.listLocalReviews()).filter((s) => s.id === fixture.id)
    expect(rows).toHaveLength(1)

    const summary = rows[0]
    expect(summary.repo).toBe(fixtureDB.repo.full_name)
    expect(summary.baseRef).toBe(fixture.baseRef)
    expect(summary.headRef).toBe(fixture.headRef)
    expect(summary.title).toBe(fixture.title)
    expect(summary.headSha).toBe(fixture.snapshot.immutable.headSha)
    expect(summary.mergeBaseSha).toBe(fixture.snapshot.immutable.mergeBaseSha)
    expect(summary.lastSyncedAt).toBe(fixture.snapshot.syncedAt)
    // Both annotations are own keys, not merely falsy readings: a key whose
    // value went missing disappears in serialization, and the surfaces that
    // render them cannot tell an absent key from a genuine `false` / `null`.
    expect(Object.prototype.hasOwnProperty.call(summary, 'dirty')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(summary, 'archivedPr')).toBe(true)
    expect(summary.dirty).toBe(false)
    expect(summary.archivedPr).toBeNull()
  })

  test('appears in the pull list exactly once, and not as a stale row', async () => {
    const list: PullListResponse = await api.listPulls()
    const rows = list.items.filter((i) => i.pull.number === fixture.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].pull.title).toBe(fixture.title)
    // The row reads the ref tips as they are NOW while the snapshot recorded
    // them when it was built. Equal compare keys are what makes the review open
    // as synced on a workspace nobody has touched yet — a fixture whose SHAs
    // were spelled by hand would read as stale from the first render.
    expect(rows[0].broker.compareKey).toBe(fixture.snapshot.immutable.compareKey)
  })

  test('a review created afterwards is minted above every seeded id', async () => {
    // The id counter is a high-water mark seeded above the fixture. One that
    // restarted at the band would hand a newly created review the id a seeded
    // one already answers to, and that review would inherit its snapshot, its
    // drafts and its viewed state.
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/minted-after-the-fixture',
    })
    expect(isLocalReviewId(created.id)).toBe(true)
    expect(created.id).toBeGreaterThan(fixture.id)
    // Never synced, so it inherited no cached snapshot; the seeded review is
    // still there, once.
    expect(await api.getSnapshot(created.id)).toBeNull()
    expect((await api.listLocalReviews()).filter((s) => s.id === fixture.id)).toHaveLength(1)
  })

  test('a sync of the same pair reproduces the seeded immutable half exactly', async () => {
    // Runs last: it writes. The seeded review is one that was created and
    // synced, not a state only a fixture author can reach, so re-syncing it
    // changes nothing the diff surface reads.
    const synced = await api.syncPull(fixture.id)
    expect(synced.immutable).toStrictEqual(fixture.snapshot.immutable)
    expect(synced.mutable.pull.number).toBe(fixture.id)
    expect(synced.mutable.checks).toEqual([])
    expect(synced.mutable.issueComments).toEqual([])
    expect(synced.mutable.reviews).toEqual([])
  })
})

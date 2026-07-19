/**
 * An in-gate performance guard for the sync engine, driven entirely by a fake
 * `GithubClient` over a large-PR fixture — no network, no `gh`, no disk beyond an
 * in-memory SQLite store, and no dependency on the built app. The engine under
 * test is the REAL `syncPull`; only its data source is faked.
 *
 * What is asserted here, and why it is in-gate rather than a micro-benchmark:
 *
 *   1. COLD-SYNC WALL-TIME BUDGET. A cold sync of a 2,000+-changed-line PR (40
 *      files, ~80 blobs, paginated files/commits, a merge-base tree, and a full
 *      mutable half) must finish under a DELIBERATELY GENEROUS budget. The budget
 *      is chosen with wide headroom over the observed local time so it is stable
 *      on a slow CI runner; its job is to catch a GROSS regression (an accidental
 *      per-file O(n^2), a synchronous re-parse of every blob, a lost early-exit),
 *      not to pin a millisecond count. See COLD_BUDGET_MS below for the number
 *      and the reasoning.
 *
 *   2. WARM-CACHE RE-SYNC IS MATERIALLY CHEAPER — proven DETERMINISTICALLY, not
 *      by timing. The two-half cache keys the immutable half (files + base tree +
 *      commits + blob index) by `merge_base...head` with no TTL. A warm re-sync of
 *      the UNCHANGED compare must therefore skip the entire immutable fetch and
 *      re-provision zero blob bytes. The test asserts the fake's per-endpoint call
 *      counters go to zero for files/tree/commits/blob-batch on the warm pass, and
 *      that `syncStats.blobsFetched` drops to 0 — a signal that cannot be flaky.
 *      No wall-time comparison is made: at the single-digit-millisecond scale this
 *      fixture syncs in, scheduler and GC jitter dominate the cold/warm ratio, so a
 *      relative timing check is noise, not proof. The call counters carry the whole
 *      claim on their own.
 *
 * The fixture generation cost is paid once, before any measured window opens, so
 * the timings measure the engine and nothing else.
 */
import { describe, expect, test } from 'bun:test'
import type {
  GhBlobRaw,
  GhCompareRaw,
  GhGraphqlBlobObject,
  GhGraphqlPageInfo,
  GhReviewThreadNode,
  GhTreeRaw,
  GithubClient,
  Page,
  PageParams,
} from './github-client'
import type { RepoRef } from './repo'
import { unusedWriteMethods } from './github-write-stubs'
import { openDirectStore, type DirectStore } from './store'
import { syncPull } from './sync'
import { largePrFixture, type LargePrFixture } from './large-pr-fixture'

const REPO: RepoRef = { owner: 'o', repo: 'r' }
const PR_NUMBER = 500

/**
 * The cold-sync wall-time budget, in milliseconds. This is a MARGIN-GENEROUS,
 * machine-independent ceiling, not a benchmark target. On the development machine
 * a cold sync of this fixture lands in single-digit-to-low-tens of milliseconds;
 * the ceiling is set an order of magnitude above that so a much slower shared CI
 * runner still passes comfortably. It exists to fail loudly on a GROSS regression
 * (e.g. an O(files^2) blowup or a synchronous re-highlight of every blob) while
 * never flaking on ordinary machine-to-machine variance.
 */
const COLD_BUDGET_MS = 750

/** Per-endpoint call counters, so a test can prove exactly which half ran. */
interface Calls {
  pullDetail: number
  compare: number
  files: number
  tree: number
  commits: number
  issueComments: number
  reviews: number
  checkRuns: number
  reviewThreads: number
  blobObjects: number
  blob: number
}

function zeroCalls(): Calls {
  return {
    pullDetail: 0,
    compare: 0,
    files: 0,
    tree: 0,
    commits: 0,
    issueComments: 0,
    reviews: 0,
    checkRuns: 0,
    reviewThreads: 0,
    blobObjects: 0,
    blob: 0,
  }
}

/**
 * A fake `GithubClient` that serves the large-PR fixture. Files and commits are
 * returned as a single page (the fixture is under the per-page cap), which is
 * enough to exercise the engine's map/assemble/provision cost without modelling
 * multi-page pagination — the two-half split and blob provisioning are what this
 * guard measures. Every blob SHA the fixture references resolves to its bytes
 * from the GraphQL object batch, so a cold sync provisions the full blob set and
 * a warm sync reuses every one.
 */
function fakeClient(fx: LargePrFixture): { client: GithubClient; calls: Calls } {
  const calls = zeroCalls()
  const onePage = <T>(items: T[], params: PageParams): Page<T> =>
    params.page === 1 ? { items, hasNext: false } : { items: [], hasNext: false }

  const client: GithubClient = {
    async getViewer() {
      return { login: 'v', id: 1 }
    },
    async getPullDetail() {
      calls.pullDetail += 1
      return {
        number: PR_NUMBER,
        title: 'A large PR',
        state: 'open',
        user: { login: 'author', id: 2, type: 'User' },
        head: { sha: fx.headSha, ref: 'feature' },
        base: { sha: fx.baseSha, ref: 'main' },
        commits: fx.commits.length,
        changed_files: fx.files.length,
      }
    },
    async getCompare(): Promise<GhCompareRaw> {
      calls.compare += 1
      return { merge_base_commit: { sha: fx.mergeBaseSha } }
    },
    async getPullFiles(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.files += 1
      return onePage(fx.files as unknown[], params)
    },
    async getIssueComments(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.issueComments += 1
      return onePage([], params)
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.reviews += 1
      return onePage([], params)
    },
    async getPullCommits(_o, _r, _n, params): Promise<Page<unknown>> {
      calls.commits += 1
      return onePage(fx.commits as unknown[], params)
    },
    async getCheckRuns() {
      calls.checkRuns += 1
      return { check_runs: [] }
    },
    async getTree(): Promise<GhTreeRaw> {
      calls.tree += 1
      return { tree: fx.treeEntries, truncated: false }
    },
    async getBlob(_o, _r, sha): Promise<GhBlobRaw> {
      calls.blob += 1
      const b = fx.blobsBySha[sha]
      const text = b ? b.content : ''
      return {
        content: Buffer.from(text, 'utf8').toString('base64'),
        encoding: 'base64',
        size: Buffer.byteLength(text, 'utf8'),
      }
    },
    async getBlobObjects(_o, _r, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      calls.blobObjects += 1
      const out: Record<string, GhGraphqlBlobObject | null> = {}
      for (const sha of shas) {
        const b = fx.blobsBySha[sha]
        out[sha] = b
          ? { isBinary: false, text: b.content, byteSize: b.size }
          : null
      }
      return out
    },
    async graphql<T>(): Promise<T> {
      throw new Error('graphql not used directly in this fake')
    },
    async getReviewThreads(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }> {
      calls.reviewThreads += 1
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
    async getThreadComments(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: never[] }> {
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
    ...unusedWriteMethods(),
  }
  return { client, calls }
}

/** A fresh in-memory store per test — no file, no dependency on any built dist. */
function store(): DirectStore {
  return openDirectStore({ dataDir: ':memory:' })
}

describe('large-PR fixture', () => {
  test('the diff totals more than 2,000 changed lines across many files', () => {
    const fx = largePrFixture()
    expect(fx.files.length).toBeGreaterThanOrEqual(10)
    expect(fx.totalChangedLines).toBeGreaterThan(2000)
    // Every file carries a real unified patch whose counted changes match.
    for (const f of fx.files) {
      expect(f.patch).toBeDefined()
      expect(f.changes).toBe(f.additions + f.deletions)
    }
    // Base + head sides are distinct content-addressed blobs the engine provisions.
    expect(fx.uniqueBlobShaCount).toBe(fx.files.length * 2)
  })
})

describe('sync engine wall-time budget (in-gate, gross-regression guard)', () => {
  test('a cold sync of the large PR completes under the documented budget', async () => {
    const fx = largePrFixture()
    const { client } = fakeClient(fx)
    const st = store()

    const started = performance.now()
    const snap = await syncPull({ github: client, repo: REPO, store: st }, PR_NUMBER)
    const elapsedMs = performance.now() - started

    // The engine actually did the large-PR work: the whole diff is present.
    expect(snap.immutable.files).toHaveLength(fx.files.length)
    expect(snap.partial).toBeNull()
    expect(snap.syncStats!.blobsFetched).toBe(fx.uniqueBlobShaCount)

    // The budget is generous and documented (COLD_BUDGET_MS). A failure here means
    // a gross regression in the read path, not machine variance.
    expect(elapsedMs).toBeLessThan(COLD_BUDGET_MS)
  })
})

describe('warm-cache re-sync is materially cheaper (two-half cache invariant)', () => {
  test('a warm re-sync of the unchanged compare provisions zero blobs and skips the immutable half', async () => {
    const fx = largePrFixture()
    const st = store()

    // Cold pass — populates the immutable half (keyed by compareKey) and every blob.
    const coldClient = fakeClient(fx)
    const cold = await syncPull(
      { github: coldClient.client, repo: REPO, store: st },
      PR_NUMBER,
    )
    expect(cold.immutable.compareKey).toBe(fx.compareKey)
    // Cold pass fetched the immutable half and provisioned every blob. The blob
    // set exceeds one GraphQL object batch, so it takes more than one blob-batch
    // call — the exact count is a function of the batch size, so only assert the
    // half ran at all; the point of interest is the warm pass driving it to zero.
    expect(coldClient.calls.files).toBeGreaterThan(0)
    expect(coldClient.calls.tree).toBe(1)
    expect(coldClient.calls.commits).toBeGreaterThan(0)
    expect(coldClient.calls.blobObjects).toBeGreaterThan(0)
    expect(cold.syncStats!.blobsFetched).toBe(fx.uniqueBlobShaCount)
    expect(cold.syncStats!.blobsReused).toBe(0)

    // Warm pass — SAME compare, fresh counters, same store.
    const warmClient = fakeClient(fx)
    const warm = await syncPull(
      { github: warmClient.client, repo: REPO, store: st },
      PR_NUMBER,
    )

    // ——— DETERMINISTIC cache-hit signal — the ONLY signal. ———
    // Step 1 (detail + compare) always runs to compute the compareKey.
    expect(warmClient.calls.pullDetail).toBe(1)
    expect(warmClient.calls.compare).toBe(1)
    // Immutable half is a compareKey HIT: files, base tree, and commits are all
    // skipped — the expensive diff work is not repeated.
    expect(warmClient.calls.files).toBe(0)
    expect(warmClient.calls.tree).toBe(0)
    expect(warmClient.calls.commits).toBe(0)
    // Every blob is content-addressed in the store, so the warm pass provisions
    // ZERO blob bytes over the network: no GraphQL blob batch, no REST straggler.
    expect(warmClient.calls.blobObjects).toBe(0)
    expect(warmClient.calls.blob).toBe(0)
    // syncStats reflects the same truth: nothing fetched, everything reused.
    expect(warm.syncStats!.blobsFetched).toBe(0)
    expect(warm.syncStats!.blobsReused).toBe(fx.uniqueBlobShaCount)
    // The mutable half STILL ran (a thread can resolve with no head movement).
    expect(warmClient.calls.issueComments).toBe(1)
    expect(warmClient.calls.reviews).toBe(1)
    expect(warmClient.calls.checkRuns).toBe(1)
    expect(warmClient.calls.reviewThreads).toBe(1)
    // The reused immutable half is intact and identical.
    expect(warm.immutable.compareKey).toBe(fx.compareKey)
    expect(warm.immutable.files).toHaveLength(fx.files.length)
  })
})

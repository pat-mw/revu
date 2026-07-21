/**
 * A `RevuApi`-parameterized conformance suite: the spec's hard invariants
 * expressed once, as `bun:test` assertions, and run against ANY adapter that
 * implements the contract. Each runner supplies a factory that builds the
 * adapter under test, a small map of which fixture pull exercises which
 * scenario, and a `restart` hook that tears the implementation down and brings
 * it back — the durability check drives that hook.
 *
 * This module lives in the shared package on purpose: the assertions are the
 * property of the contract, not of any one transport. Keeping them here means
 * the in-process mock and the daemon-over-HTTP transport are held to exactly
 * the same bar, and there is a single copy to change when the contract does.
 * The suite imports only the shared contract types and `bun:test`; it never
 * reaches into any adapter's internals, so `shared` stays a leaf.
 *
 * The frozen-contract semantics the suite encodes are the point of the whole
 * exercise: `submitReview` returns `head_moved` as a 200-level VALUE and never
 * throws for it; `syncPull` that dies mid-transfer keeps a PARTIAL snapshot and
 * the retry completes with `partial: null`; `getSnapshot` answers `null` (never
 * a thrown 404) for a pull that was never synced. Every adapter must uphold all
 * three.
 *
 * One thing deliberately does NOT live in the shared assertions: HOW a dropped
 * transfer reaches the caller. The contract permits either shape — a raised
 * error or a promise that resolves with `partial` set — and which one a given
 * adapter produces is a property of its transport, not of the contract. So the
 * suite asserts the transport-agnostic OUTCOME itself (a partial snapshot is
 * kept, the retry fetches only the missing blobs, the retry clears the partial)
 * and delegates the surfacing shape to a per-runner hook. See
 * `PartialSyncSurfacing`.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { ApiError, blobContentToLines, classifyPendingComment, selectAnchorBlobSha } from '../src/index.ts'
import type { AnchorResult, ApiErrorCode, PendingComment, RevuApi, Snapshot } from '../src/index.ts'

/**
 * Names the fixture pull that exercises each invariant. Every runner passes the
 * same numbers (they are properties of the shared fixture set), but threading
 * them through config keeps the suite honest about what each scenario needs and
 * makes a future fixture renumbering a one-line change per runner.
 */
export interface ConformanceScenarios {
  /** A never-synced pull: baseline `syncPull` output shape + `getSnapshot` null. */
  baseline: number
  /** Seeded with a snapshot + a one-comment draft; the head-guard target. */
  seededDraft: number
  /** Base advanced under a fixed head: compareKey moves, immutable rebuilt. */
  baseAdvanced: number
  /** Head unchanged, mutable half drifted: re-sync reuses every blob. */
  mutableDrift: number
  /** First sync dies mid-transfer, keeps a partial, retry completes. */
  partialSync: number
  /** Seeded behind remote; reconcile yields clean/drifted/lost. */
  reconcile: number
}

/**
 * What the interrupted first `syncPull` actually did at the call site. Capturing
 * it as a value instead of asserting inline is what lets the outcome checks stay
 * shared while the surfacing check varies per transport.
 */
export type PartialSyncOutcome =
  | { kind: 'threw'; error: unknown }
  | { kind: 'resolved'; snapshot: Snapshot }

/**
 * A runner's expectation about HOW its transport surfaces a sync that dies
 * mid-transfer. The suite drives the scenario and hands the captured outcome
 * here; a failed `expect` inside the hook fails the shared suite exactly as an
 * inline assertion would.
 *
 * This is the seam that keeps the suite runnable against every transport. An
 * in-process adapter and an HTTP client both raise the dropped transfer as an
 * `ApiError` with code `network`, because both own the moment the transfer
 * breaks. An engine driving real GitHub does not: it collects what it managed to
 * transfer and RESOLVES with `snapshot.partial` set. Both are conformant — the
 * contract explicitly allows `syncPull` to resolve partial rather than throw —
 * so pinning one shape in the shared assertions would fail honest adapters on
 * transport shape rather than on behaviour.
 *
 * Use `expectPartialSyncThrows` or `expectPartialSyncResolves` to build one.
 */
export type PartialSyncSurfacing = (outcome: PartialSyncOutcome) => void | Promise<void>

/**
 * Surfacing expectation for a transport that raises the dropped transfer as an
 * `ApiError` carrying `code`, having already persisted the partial snapshot.
 */
export function expectPartialSyncThrows(code: ApiErrorCode): PartialSyncSurfacing {
  return (outcome) => {
    expect(outcome.kind).toBe('threw')
    const error = outcome.kind === 'threw' ? outcome.error : null
    expect(error).toBeInstanceOf(ApiError)
    expect(error instanceof ApiError ? error.code : null).toBe(code)
  }
}

/**
 * Surfacing expectation for a transport that answers a dropped transfer by
 * resolving with the partial snapshot rather than raising. The returned
 * snapshot must name what is missing, or the caller has no way to resume.
 */
export function expectPartialSyncResolves(): PartialSyncSurfacing {
  return (outcome) => {
    expect(outcome.kind).toBe('resolved')
    const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null
    expect(snapshot?.partial ?? null).not.toBeNull()
    expect(snapshot?.partial?.missingBlobShas.length ?? 0).toBeGreaterThan(0)
  }
}

/**
 * The fallback used when a runner supplies no surfacing hook: assert only what
 * the contract itself guarantees, which is that the interruption reached the
 * caller in ONE of the two legal shapes. A sync that quietly reported success,
 * or that raised something outside the error envelope, still fails here — the
 * missing hook loosens the assertion to the contract floor, it never skips it.
 * Runners whose transport pins a shape should say so and get the tighter check.
 */
export const expectPartialSyncSurfacedSomehow: PartialSyncSurfacing = (outcome) => {
  if (outcome.kind === 'threw') {
    expect(outcome.error).toBeInstanceOf(ApiError)
    return
  }
  expect(outcome.snapshot.partial).not.toBeNull()
}

/**
 * Everything a runner hands the suite: how to build the adapter, which pulls to
 * drive, and how to restart the implementation under test for the durability
 * check. `restart` MUST return the adapter to use afterward — the mock keeps
 * its store across a fresh factory call, and the HTTP daemon rebinds to a new
 * port, so the handle can change.
 */
export interface ConformanceConfig {
  /** Human-readable transport name, used only in the top-level describe label. */
  label: string
  /** Build a fresh adapter bound to the implementation under test. */
  makeApi: () => RevuApi | Promise<RevuApi>
  /** Which fixture pull exercises which scenario. */
  scenarios: ConformanceScenarios
  /**
   * Tear the implementation down and bring it back, returning the adapter to
   * use afterward. Broker-side state (drafts) must survive the round trip.
   */
  restart: () => RevuApi | Promise<RevuApi>
  /**
   * How THIS transport surfaces a sync that dies mid-transfer. Omitting it
   * falls back to `expectPartialSyncSurfacedSomehow`, which still asserts the
   * interruption reached the caller in a contract-legal shape.
   */
  partialSyncSurfacing?: PartialSyncSurfacing
}

/**
 * Run one `syncPull` and report what it did without deciding whether that was
 * correct. Nothing is swallowed: a rejection is carried out whole as `error`, so
 * a surfacing hook can inspect the real value rather than a flattened code.
 */
async function captureSyncOutcome(api: RevuApi, prNumber: number): Promise<PartialSyncOutcome> {
  try {
    return { kind: 'resolved', snapshot: await api.syncPull(prNumber) }
  } catch (error) {
    return { kind: 'threw', error }
  }
}

/**
 * Register the conformance suite for one adapter. Call this from a `*.test.ts`
 * runner where the adapter is reachable; the runner is responsible for any
 * process-wide setup (a mock store reset, a daemon spawn) in its own hooks.
 */
export function runConformanceSuite(config: ConformanceConfig): void {
  const { label, scenarios } = config

  describe(`RevuApi conformance — ${label}`, () => {
    let api: RevuApi

    beforeAll(async () => {
      api = await config.makeApi()
    })

    describe('baseline syncPull output shape', () => {
      it('a never-synced pull reads back as null, not a thrown error', async () => {
        const snap = await api.getSnapshot(scenarios.baseline)
        expect(snap).toBeNull()
      })

      it('syncPull returns a well-formed snapshot that fetches blobs', async () => {
        const snap = await api.syncPull(scenarios.baseline)
        expect(snap.prNumber).toBe(scenarios.baseline)
        expect(snap.partial).toBeNull()
        // A first sync of a never-synced pull must transfer at least one blob.
        expect(snap.syncStats?.blobsFetched ?? 0).toBeGreaterThan(0)
        // The immutable half is populated and its blob index resolves.
        expect(snap.immutable.files.length).toBeGreaterThan(0)
        expect(typeof snap.immutable.headSha).toBe('string')
        expect(snap.immutable.headSha.length).toBeGreaterThan(0)
        expect(typeof snap.immutable.compareKey).toBe('string')
      })

      it('a synced blob is readable from the local store', async () => {
        const snap = await api.getSnapshot(scenarios.baseline)
        expect(snap).not.toBeNull()
        const headSha = snap!.immutable.blobIndex[snap!.immutable.files[0].filename]?.head
        expect(typeof headSha).toBe('string')
        const blob = await api.getBlob(headSha as string)
        expect(blob.content.length).toBeGreaterThan(0)
      })

      it('getSnapshot after sync returns the cached snapshot', async () => {
        const cached = await api.getSnapshot(scenarios.baseline)
        expect(cached).not.toBeNull()
        expect(cached?.prNumber).toBe(scenarios.baseline)
      })
    })

    describe('two-half cache keying: base advanced rebuilds the immutable half', () => {
      it('the pull head is unchanged but its compareKey has moved', async () => {
        const snap = await api.getSnapshot(scenarios.baseAdvanced)
        expect(snap).not.toBeNull()
        const li = (await api.listPulls()).items.find(
          (i) => i.pull.number === scenarios.baseAdvanced,
        )
        expect(li).toBeDefined()
        // Head SHA identical, so a head-only cache would wrongly reuse the diff.
        expect(li!.pull.head.sha).toBe(snap!.immutable.headSha)
        // But the diff is keyed by merge_base...head, and the base moved.
        expect(li!.broker.compareKey).not.toBe(snap!.immutable.compareKey)
      })

      it('re-sync rebuilds the immutable half to the new compareKey', async () => {
        const li = (await api.listPulls()).items.find(
          (i) => i.pull.number === scenarios.baseAdvanced,
        )!
        const resync = await api.syncPull(scenarios.baseAdvanced)
        expect(resync.immutable.compareKey).toBe(li.broker.compareKey)
      })
    })

    describe('two-half cache keying: head unchanged still refetches the mutable half', () => {
      it('the broker sees fewer unresolved threads than the stale snapshot', async () => {
        const snap = await api.getSnapshot(scenarios.mutableDrift)
        expect(snap).not.toBeNull()
        const unresolvedBefore = snap!.mutable.threads.filter((t) => !t.isResolved).length
        const li = (await api.listPulls()).items.find(
          (i) => i.pull.number === scenarios.mutableDrift,
        )!
        expect(li.broker.unresolvedThreads).toBeLessThan(unresolvedBefore)
      })

      it('re-sync reuses every blob (immutable half is content-addressed)', async () => {
        // Head unchanged → the compareKey matches → the immutable half is reused
        // untouched, so zero blobs are refetched even though the mutable half is.
        const resync = await api.syncPull(scenarios.mutableDrift)
        expect(resync.syncStats?.blobsFetched).toBe(0)
      })

      it('the mutable half is refreshed to the broker truth, compareKey unchanged', async () => {
        const snapBefore = await api.getSnapshot(scenarios.mutableDrift)
        const li = (await api.listPulls()).items.find(
          (i) => i.pull.number === scenarios.mutableDrift,
        )!
        // Re-fetch the freshest snapshot after the re-sync above landed.
        const resync = await api.getSnapshot(scenarios.mutableDrift)
        expect(resync).not.toBeNull()
        expect(resync!.immutable.compareKey).toBe(snapBefore!.immutable.compareKey)
        const unresolvedNow = resync!.mutable.threads.filter((t) => !t.isResolved).length
        expect(unresolvedNow).toBe(li.broker.unresolvedThreads)
      })
    })

    describe('head_moved is a value, never an error', () => {
      it('submitReview against a stale head returns status head_moved', async () => {
        // A seeded snapshot + draft exists for this pull; submit with a head SHA
        // that cannot match. The frozen contract says this comes back as a
        // 200-level value so the UI can route through reconcile — it must not
        // throw, and it must not touch the draft.
        const draft = await api.getDraft(scenarios.seededDraft)
        const comments: PendingComment[] = draft?.comments ?? []
        const result = await api.submitReview({
          prNumber: scenarios.seededDraft,
          expectedHeadSha: 'not-the-real-head',
          event: 'COMMENT',
          body: '',
          comments,
        })
        expect(result.status).toBe('head_moved')
        // The draft is untouched by a head-guard rejection.
        const after = await api.getDraft(scenarios.seededDraft)
        expect(after?.comments.length ?? 0).toBe(comments.length)
      })
    })

    describe('partial-sync resume fetches only the missing blobs', () => {
      it('the interrupted first sync surfaces the drop the way this transport does', async () => {
        // Drive the scenario once and capture what came back, then let the
        // runner assert the shape its transport produces. Everything the
        // contract actually promises is asserted by the two cases below, which
        // hold for every transport.
        const outcome = await captureSyncOutcome(api, scenarios.partialSync)
        const surfacing = config.partialSyncSurfacing ?? expectPartialSyncSurfacedSomehow
        await surfacing(outcome)
      })

      it('the kept partial snapshot names the missing blobs', async () => {
        const partial = await api.getSnapshot(scenarios.partialSync)
        expect(partial).not.toBeNull()
        expect(partial!.partial).not.toBeNull()
        expect(partial!.partial!.missingBlobShas.length).toBeGreaterThan(0)
      })

      it('the retry fetches exactly the missing blobs and completes with partial null', async () => {
        const partial = await api.getSnapshot(scenarios.partialSync)
        const missingCount = partial!.partial!.missingBlobShas.length
        const retry = await api.syncPull(scenarios.partialSync)
        expect(retry.partial).toBeNull()
        expect(retry.syncStats?.blobsFetched).toBe(missingCount)
      })
    })

    describe('reconcile classifies drift and lost anchors', () => {
      it('the seeded snapshot is behind the remote head', async () => {
        const snap = await api.getSnapshot(scenarios.reconcile)
        const draft = await api.getDraft(scenarios.reconcile)
        expect(snap).not.toBeNull()
        expect(draft).not.toBeNull()
        // The draft was written against the (now stale) snapshot head.
        expect(draft!.headSha).toBe(snap!.immutable.headSha)
        const li = (await api.listPulls()).items.find(
          (i) => i.pull.number === scenarios.reconcile,
        )!
        expect(li.pull.head.sha).not.toBe(snap!.immutable.headSha)
        expect(li.broker.commitCount - snap!.immutable.commits.length).toBe(3)
      })

      it('after re-sync, reconcile yields clean / drifted / lost with the expected deltas', async () => {
        await api.syncPull(scenarios.reconcile)
        const report = await api.reconcileDraft(scenarios.reconcile)
        const kinds = report.results.map((r) => r.kind).sort()
        // A RIGHT-side clean/drifted/lost trio plus a LEFT-side clean anchor:
        // the LEFT note targets a deleted base line whose merge base is
        // unchanged, so it re-anchors cleanly against the base blob.
        expect(kinds).toEqual(['clean', 'clean', 'drifted', 'lost'])
        const drifted = report.results.find((r) => r.kind === 'drifted')
        expect(drifted?.kind).toBe('drifted')
        expect(drifted?.kind === 'drifted' ? drifted.delta : null).toBe(12)
        // The LEFT-side comment classified against BASE content, not head.
        const leftResult = report.results.find((r) => r.comment.side === 'LEFT')
        expect(leftResult?.kind).toBe('clean')
        expect(report.newCommits).toHaveLength(3)
      })

      it('the client-side preview matches the reconcile report for every comment, both sides', async () => {
        // The dialog previews each draft comment by running the SAME shared
        // classifier the adapter's report runs, resolving blob lines from the
        // freshly synced snapshot via getBlob. Recomputing it here through the
        // transport-agnostic contract proves preview and report cannot diverge
        // — the whole point of a single blob-selection + classification rule.
        await api.syncPull(scenarios.reconcile)
        const report = await api.reconcileDraft(scenarios.reconcile)
        const snap = await api.getSnapshot(scenarios.reconcile)
        const draft = await api.getDraft(scenarios.reconcile)
        expect(snap).not.toBeNull()
        expect(draft).not.toBeNull()

        // A blob-line resolver over the contract surface, memoized so each
        // blob is fetched at most once per comment classification.
        const lineCache = new Map<string, string[] | null>()
        const resolveBlobLines = async (sha: string): Promise<string[] | null> => {
          if (lineCache.has(sha)) return lineCache.get(sha) ?? null
          let lines: string[] | null = null
          try {
            const blob = await api.getBlob(sha)
            lines = blob.binary ? null : blobContentToLines(blob.content)
          } catch {
            lines = null
          }
          lineCache.set(sha, lines)
          return lines
        }

        // Both sides must appear, or the parity check is only exercising one.
        const sides = new Set(draft!.comments.map((c) => c.side))
        expect(sides.has('LEFT')).toBe(true)
        expect(sides.has('RIGHT')).toBe(true)

        for (const comment of draft!.comments) {
          // Pre-warm the blob line cache for this comment's anchoring side so
          // the classifier's synchronous resolver is a pure cache read. The
          // side is chosen through the same shared selector the classifier
          // uses, so the parity check cannot accidentally prefetch the wrong
          // blob and mask a divergence.
          const entry = snap!.immutable.blobIndex[comment.path]
          const sha = selectAnchorBlobSha(entry, comment.side)
          if (sha) await resolveBlobLines(sha)

          const preview: AnchorResult = classifyPendingComment({
            comment,
            files: snap!.immutable.files,
            blobIndex: snap!.immutable.blobIndex,
            resolveBlobLines: (s) => lineCache.get(s) ?? null,
          })
          const reported = report.results.find((r) => r.comment.key === comment.key)
          expect(reported).toBeDefined()
          // Preview and report must be byte-identical for this comment.
          expect(preview).toEqual(reported!)
        }
      })
    })

    describe('a draft survives an implementation restart', () => {
      it('a written draft is still readable after the adapter under test restarts', async () => {
        // Write against the never-synced baseline pull so this scenario does not
        // collide with the seeded draft the head_moved case reads. Sync first so
        // a real head SHA and compareKey are available to write against.
        const pr = scenarios.baseline
        const snap = (await api.getSnapshot(pr)) ?? (await api.syncPull(pr))
        const now = new Date().toISOString()
        const draft = {
          humanId: 'h-priya',
          prNumber: pr,
          headSha: snap.immutable.headSha,
          compareKey: snap.immutable.compareKey,
          body: 'Durable conformance draft — must survive a restart.',
          event: 'COMMENT' as const,
          comments: [],
          createdAt: now,
          updatedAt: now,
        }
        const saved = await api.saveDraft(draft)
        expect(saved.body).toContain('must survive a restart')

        // Restart the implementation and re-read through the returned handle.
        api = await config.restart()
        const reloaded = await api.getDraft(pr)
        expect(reloaded).not.toBeNull()
        expect(reloaded!.body).toContain('must survive a restart')
        expect(reloaded!.headSha).toBe(snap.immutable.headSha)

        // Clean up so a re-run against a persistent store starts fresh.
        await api.discardDraft(pr)
      })
    })
  })
}

import type {
  BrokerPullMeta,
  PullListItem,
  PullListResponse,
  PullSummary,
  RateLimitInfo,
} from '@revu/shared'
import type { PullListClient } from '../direct/github-client'
import type { RepoRef } from '../direct/repo'
import { AwaitingCredentialError } from './token-source'

/**
 * The broker's live pulls-list cache, fed by a ~30-second conditional poll.
 *
 * Broker mode serves `GET /v1/pulls` from THIS in-memory cache, not from a per-
 * request GitHub call: every ~30s the loop issues ONE conditional
 * `GET /repos/{o}/{r}/pulls?state=open&per_page=100` carrying the ETag GitHub
 * returned last round. A `304 Not Modified` is free against the shared rate
 * bucket, so an idle hour costs a handful of non-304 requests at most; only a
 * real upstream change spends a 200 and triggers a refresh. The cache holds the
 * mapped list items, GitHub's list ETag, a derived broker-level ETag, and the
 * last-known rate limit — all IN MEMORY (volatile poll metadata; nothing here is
 * persisted, so no schema or migration exists for it).
 *
 * The broker-level ETag is DERIVED from GitHub's list ETag rather than hashed
 * from the item bodies, so it is deterministic across a graceful restart with no
 * upstream change: a fresh process re-fetches the list (its first tick has no
 * stored ETag, so it is a 200), but GitHub returns the SAME entity tag for
 * unchanged content, so the broker ETag it computes is byte-identical to the one
 * the previous process served. The frontend's stored `If-None-Match` therefore
 * still matches and the very first `/v1/pulls` after a restart can 304, instead
 * of a re-hash whose field order or float formatting could drift and force a 200
 * every restart.
 *
 * Single repo/scope only: this cache serves ONE repo. A cross-scope cache is a
 * later concern; this module deliberately holds exactly one scope's list.
 *
 * Credential resilience: a tick whose upstream call throws
 * `AwaitingCredentialError` (the host has not injected / is rotating the
 * credential) is SKIPPED — the loop never crashes and never blanks the served
 * cache, so an already-populated list keeps serving across a brief credential
 * gap. Only after repeated consecutive failures past a threshold does the served
 * list report "live data unavailable" rather than silently serving an
 * indefinitely stale read.
 *
 * Accepted staleness — `unresolvedThreads` follows list-change detection.
 * A pull's facts (unresolved-thread count, commit count, compare key) refresh
 * ONLY when the REST list marks that pull changed: its head SHA, `updated_at`,
 * or base SHA moved (see `changedNumbers`). A pure thread resolve/unresolve on
 * github.com bumps NONE of those REST-list fields, so the list still 304s and
 * `unresolvedThreads` will not refresh within a poll interval — it lags until the
 * next list-changing event (a new commit, a base advance, a title/label edit
 * that bumps `updated_at`) or a full snapshot sync. This is inherent to
 * list-ETag change detection and is accepted: a cross-PR reviewThreads sweep
 * every tick would defeat the idle-cost budget this cache exists to protect.
 */

/** How often the poll loop ticks, in milliseconds (~30 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000

/**
 * Consecutive failing ticks tolerated before the served cache is treated as
 * unavailable. Below this the last-known list keeps serving across a transient
 * credential gap; at or above it the served read surfaces the outage instead of
 * a possibly-hours-stale list.
 */
export const DEFAULT_MAX_STALE_TICKS = 5

/** djb2 string hash, rendered lowercase hex — the same family the mock ETag uses. */
function djb2Hex(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

/**
 * Derive the broker-level ETag from GitHub's list ETag. Deterministic and
 * restart-stable: the same upstream ETag always yields the same broker ETag, and
 * the upstream ETag is a property of GitHub's response, not of this process. An
 * empty upstream ETag (a test double that omits one) still yields a stable value
 * keyed on the empty string, so a 304 loop can still form.
 */
export function brokerEtagFromListEtag(listEtag: string): string {
  return `W/"pulls:${djb2Hex(listEtag)}"`
}

/**
 * The broker's list cache: the served items and the deterministic ETag, plus the
 * upstream ETag the next poll conditions on and the last-known rate limit. `live`
 * is false once the loop has failed too many consecutive ticks; a `null` cache
 * means the loop has not yet observed a first successful list.
 */
interface CacheState {
  items: PullListItem[]
  /** GitHub's REST list ETag — the `If-None-Match` value for the next tick. */
  listEtag: string
  /** The deterministic broker-level ETag served on `/v1/pulls`. */
  brokerEtag: string
  rateLimit: RateLimitInfo
}

/** A `RateLimitInfo` used until a real one is read from the first response headers. */
function unknownRateLimit(): RateLimitInfo {
  return { limit: 0, remaining: 0, used: 0, reset: new Date(0).toISOString() }
}

/**
 * A per-pull broker-meta refresh: the live facts a changed pull needs. The
 * loop composes this into `BrokerPullMeta`. The list-level author/reviewer
 * annotations (`authorHumanId`, `assignedReviewerHumanIds`, `canApprove`) are
 * NOT derived here — a poll with no write-log join has no login→human mapping —
 * so they carry NEUTRAL DEFAULTS that are completed by the BrokerPullMeta
 * author/approve join in the stacked change. A `null` `authorHumanId` here means
 * only "no write-log author join was applied", NOT "an org member opened it".
 */
interface PullMetaFacts {
  unresolvedThreads: number
  commitCount: number
  /** `${mergeBaseSha}...${headSha}` — the same compare key a full sync computes. */
  compareKey: string
}

/**
 * The engine the poll loop needs beyond the list read: the batched per-pull facts
 * (unresolved counts + commit counts) and a merge-base compare for the compare
 * key. Kept narrow so the loop is trivially faked in a test.
 */
export interface PollFactsSource {
  getPullFacts: PullListClient['getPullFacts']
  /** `GET /repos/{o}/{r}/compare/{base}...{head}` — the merge base of a compare. */
  getCompare(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{ merge_base_commit: { sha: string } }>
}

export interface PollLoopDeps {
  client: PullListClient
  facts: PollFactsSource
  repo: RepoRef
  /** Poll cadence; defaults to ~30s. */
  intervalMs?: number
  /** Consecutive-failure tolerance before the cache is treated as unavailable. */
  maxStaleTicks?: number
}

/**
 * A default `BrokerPullMeta` for a pull whose live facts have not (yet) been
 * refreshed — used before the first facts fetch resolves so the list is always
 * well-typed. The counts are zero and the compare key is the base-tip fallback,
 * which is corrected to the true merge base on the next facts refresh.
 *
 * `authorHumanId: null` / `canApprove: true` are NEUTRAL PLACEHOLDERS, completed
 * by the BrokerPullMeta author/approve join in the stacked change (which owns the
 * write-log login→human mapping). A poll with no write-log join carries these
 * neutral defaults; the two fields are type-coupled, so they are populated
 * together there, not partially here.
 */
function defaultMeta(pull: PullSummary): BrokerPullMeta {
  return {
    authorHumanId: null,
    canApprove: true,
    unresolvedThreads: 0,
    assignedReviewerHumanIds: [],
    compareKey: `${pull.base.sha}...${pull.head.sha}`,
    commitCount: 0,
  }
}

/**
 * Compose a full `BrokerPullMeta` from live facts. As in `defaultMeta`,
 * `authorHumanId: null` / `canApprove: true` are neutral placeholders completed
 * by the BrokerPullMeta author/approve join in the stacked change; a poll with no
 * write-log join carries these neutral defaults rather than a partial guess.
 */
function metaFromFacts(facts: PullMetaFacts): BrokerPullMeta {
  return {
    authorHumanId: null,
    canApprove: true,
    unresolvedThreads: facts.unresolvedThreads,
    assignedReviewerHumanIds: [],
    compareKey: facts.compareKey,
    commitCount: facts.commitCount,
  }
}

/**
 * The running poll loop. `snapshot()` returns the current served list (or throws
 * an unavailability signal); `pollOnce()` runs one tick (exposed for tests and
 * called on the interval); `start`/`stop` manage the timer.
 */
export interface PollLoop {
  /**
   * The served `/v1/pulls` payload for a given `If-None-Match`. Returns
   * `notModified: true` (empty items, the broker ETag echoed) when the ETag
   * matches the current cache, else the full list. Throws `PollUnavailableError`
   * when no successful list has ever been observed OR the loop has failed past
   * the stale-tick threshold — the router maps that to `broker_unreachable`.
   */
  listPulls(ifNoneMatch: string | null): PullListResponse
  /** Run exactly one poll tick. Never throws for an awaiting credential. */
  pollOnce(): Promise<void>
  /** Begin ticking on the interval (an immediate first tick, then every `intervalMs`). */
  start(): void
  /** Stop ticking and release the timer. */
  stop(): void
}

/**
 * The served list has no live data to serve: either the loop has not completed a
 * first successful poll, or it has failed past the stale threshold. The router
 * maps this to `broker_unreachable` (502) — a retriable "live data unavailable",
 * never a fabricated empty list the inbox would render as "no open pulls".
 */
export class PollUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PollUnavailableError'
  }
}

/**
 * Build the broker poll loop over a narrow list client + facts source. The loop
 * holds its cache in a closure; nothing is persisted. Call `start()` from broker
 * boot and `stop()` from shutdown.
 */
export function createPollLoop(deps: PollLoopDeps): PollLoop {
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxStaleTicks = deps.maxStaleTicks ?? DEFAULT_MAX_STALE_TICKS
  const { owner, repo } = deps.repo

  let cache: CacheState | null = null
  let consecutiveFailures = 0
  let timer: ReturnType<typeof setInterval> | null = null
  // True while a `pollOnce` is still running, so an overlapping tick is skipped.
  let inFlight = false

  /** Sort newest-updated first, matching the mock oracle's list order. */
  function sortItems(items: PullListItem[]): PullListItem[] {
    return [...items].sort((a, b) => b.pull.updated_at.localeCompare(a.pull.updated_at))
  }

  /**
   * Which pulls changed since the last successful list: a number not previously
   * present, or one whose head SHA, `updated_at`, or BASE SHA moved. The base
   * SHA is checked because a base-branch advance under an UNCHANGED head bumps
   * neither the head nor `updated_at`, yet it moves the three-dot merge base and
   * therefore the `compareKey`; without this check `compareKey` would never
   * refresh on a base advance and the frontend's "base moved" staleness (head
   * unchanged + base advanced) could never fire. Only changed pulls get a facts
   * refresh — an unchanged pull carries its prior broker meta forward untouched,
   * which is what keeps the change-driven refresh cheap.
   */
  function changedNumbers(next: PullSummary[], prior: PullListItem[]): Set<number> {
    const priorByNumber = new Map(prior.map((it) => [it.pull.number, it.pull]))
    const changed = new Set<number>()
    for (const pull of next) {
      const before = priorByNumber.get(pull.number)
      if (
        before === undefined ||
        before.head.sha !== pull.head.sha ||
        before.updated_at !== pull.updated_at ||
        before.base.sha !== pull.base.sha
      ) {
        changed.add(pull.number)
      }
    }
    return changed
  }

  /**
   * Refresh live facts for exactly the changed pulls: one batched GraphQL query
   * for unresolved-thread + commit counts, and one merge-base compare per changed
   * pull for the true `compareKey`. The compare is bounded to changed pulls, so
   * an idle poll (no changes) spends nothing here.
   *
   * A batched-counts failure (the GraphQL query throws — e.g. its SEPARATE rate
   * bucket is exhausted) propagates and fails the whole tick: it is a facts-phase
   * outage, so the caller counts it toward the stale threshold rather than
   * silently serving a list whose facts never refresh. But a SINGLE pull's
   * merge-base compare failing (a persistent 404 on one PR's compare) is isolated
   * HERE: that pull is simply omitted from the returned map, so the caller carries
   * its PRIOR meta forward unchanged and every other changed pull still refreshes.
   * One bad pull must never abort the whole tick.
   */
  async function refreshFacts(
    changed: PullSummary[],
  ): Promise<Map<number, PullMetaFacts>> {
    const out = new Map<number, PullMetaFacts>()
    if (changed.length === 0) return out
    const counts = await deps.facts.getPullFacts(
      owner,
      repo,
      changed.map((p) => p.number),
    )
    for (const pull of changed) {
      const c = counts[pull.number]
      let compare: { merge_base_commit: { sha: string } }
      try {
        compare = await deps.facts.getCompare(owner, repo, pull.base.sha, pull.head.sha)
      } catch {
        // This one pull's compare failed (e.g. a 404): skip it so its prior meta
        // carries forward, and keep refreshing the others. No token/credential
        // content is ever logged; the failure is simply absorbed per pull.
        continue
      }
      out.set(pull.number, {
        unresolvedThreads: c?.unresolvedThreads ?? 0,
        commitCount: c?.commitCount ?? 0,
        compareKey: `${compare.merge_base_commit.sha}...${pull.head.sha}`,
      })
    }
    return out
  }

  async function pollOnce(): Promise<void> {
    // A tick slower than the cadence (a cold warm of N pulls is N serial
    // compares) would otherwise overlap the next: both would condition on the
    // same stale ETag (a double spend) and last-writer-wins could regress the
    // cache to older items. Skip while a tick is still in flight; the flag is
    // cleared in the `finally` so a thrown tick never wedges the loop shut.
    if (inFlight) return
    inFlight = true
    try {
      const page = await deps.client.listOpenPulls(owner, repo, cache?.listEtag ?? null)

      if (page.notModified) {
        if (cache !== null) {
          // Unchanged upstream: refresh only the rate limit (its headers ride the
          // 304); items and both ETags stay exactly as they were. A 304 IS a
          // successful tick, so it clears the failure streak.
          if (page.rateLimit !== null) cache.rateLimit = page.rateLimit
          consecutiveFailures = 0
        }
        // A 304 with NO warm cache is a nonconforming upstream (no If-None-Match
        // was ever sent, so a well-behaved server cannot 304): treat it as a
        // no-op, NOT a first successful list. Falling through would fabricate an
        // empty-list cache and serve it as a fresh 200 "no open pulls". Leave the
        // cache null and let the stale/unready path surface instead.
        return
      }

      const priorItems = cache?.items ?? []
      const changed = changedNumbers(page.items, priorItems)
      const changedPulls = page.items.filter((p) => changed.has(p.number))
      // A facts-phase outage (the batched counts query throws) propagates out of
      // here to the catch below and counts as a failed tick — so a REST list that
      // keeps 200-ing while GraphQL is down cannot masquerade as fresh forever.
      const facts = await refreshFacts(changedPulls)
      const priorMetaByNumber = new Map(
        priorItems.map((it) => [it.pull.number, it.broker]),
      )

      const items: PullListItem[] = page.items.map((pull) => {
        const fresh = facts.get(pull.number)
        if (fresh !== undefined) return { pull, broker: metaFromFacts(fresh) }
        const carried = priorMetaByNumber.get(pull.number)
        return { pull, broker: carried ?? defaultMeta(pull) }
      })

      cache = {
        items: sortItems(items),
        listEtag: page.etag,
        brokerEtag: brokerEtagFromListEtag(page.etag),
        rateLimit: page.rateLimit ?? cache?.rateLimit ?? unknownRateLimit(),
      }
      // ONLY a fully-successful tick — the list read AND the facts phase both
      // resolved AND the cache was assigned — clears the failure streak. Resetting
      // earlier (right after the list read) would let a REST list that keeps
      // succeeding while facts keep failing oscillate the counter 0↔1 forever and
      // never trip the stale tripwire, serving an indefinitely stale list as 200s.
      consecutiveFailures = 0
    } catch (err) {
      if (err instanceof AwaitingCredentialError) {
        // The credential is not present / is rotating: skip this tick, keep the
        // last-known cache, and retry next tick. Never crash the loop.
        consecutiveFailures += 1
        return
      }
      // Any other upstream failure (a GitHub outage, a GraphQL facts-phase error,
      // a total list-read failure) is also survivable per-tick: count it toward
      // the stale threshold and retry.
      consecutiveFailures += 1
    } finally {
      inFlight = false
    }
  }

  function listPulls(ifNoneMatch: string | null): PullListResponse {
    if (cache === null || consecutiveFailures >= maxStaleTicks) {
      throw new PollUnavailableError(
        'The broker has no live pull list yet — the credential poll has not ' +
          'produced a fresh read. Retry shortly.',
      )
    }
    if (ifNoneMatch !== null && ifNoneMatch === cache.brokerEtag) {
      // The client's ETag matches: a 304-equivalent. Items empty by the shared
      // 304 rule (the caller replays its last-known list); the ETag is echoed.
      return {
        items: [],
        etag: cache.brokerEtag,
        notModified: true,
        rateLimit: cache.rateLimit,
      }
    }
    return {
      items: cache.items,
      etag: cache.brokerEtag,
      notModified: false,
      rateLimit: cache.rateLimit,
    }
  }

  function start(): void {
    if (timer !== null) return
    // Fire once immediately so the cache warms without waiting a full interval,
    // then tick on the cadence. A rejected first tick never escapes (pollOnce
    // swallows its own failures), so no unhandled rejection can crash boot.
    void pollOnce()
    timer = setInterval(() => {
      void pollOnce()
    }, intervalMs)
    // Do not keep the process alive solely for the poll timer.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return { listPulls, pollOnce, start, stop }
}

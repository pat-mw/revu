import type {
  BrokerPullMeta,
  ChecksRollup,
  PullListItem,
  PullListResponse,
  PullSummary,
  RateLimitInfo,
} from '@revu/shared'
import type { PullListClient } from '../direct/github-client'
import type { RepoRef } from '../direct/repo'
import type { ReviewerAssignments } from './reviewer-assignment'
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
 * The broker-level ETag is DERIVED from GitHub's list ETag COMPOSED with a hash
 * of the served per-pull meta annotations (author / approvability / assigned
 * reviewers / CI rollup) rather than hashed from the full item bodies. The GitHub
 * pull objects are NOT hashed — their field order or float formatting could drift
 * and force a 200 every restart — only the list ETag (a stable upstream property)
 * and the meta annotations (simple scalars/arrays under this process's control)
 * feed the ETag.
 *
 * This keeps it restart-stable AND meta-sensitive:
 *   - Restart-stable: a fresh process re-fetches the list (its first tick has no
 *     stored ETag, so it is a 200), but GitHub returns the SAME entity tag for
 *     unchanged content and the durable meta inputs (the `pr_author` table, the
 *     reviewers file, `REVU_BOT_LOGIN`) are identical, so the composed ETag is
 *     byte-identical to the one the previous process served — the frontend's
 *     stored `If-None-Match` still 304s. The CI rollup rides the same way: a
 *     fresh process treats every pull as changed and re-observes it, so it lands
 *     back on the same value while CI itself has not moved.
 *   - Meta-sensitive: a reviewers-file edit, a late `pr_author` record, or a CI
 *     run finishing changes the served `assignedReviewerHumanIds` /
 *     `authorHumanId` / `checks` WITHOUT moving the upstream list (the list still
 *     304s). Because the meta hash is folded into the ETag and RECOMPUTED on 304
 *     ticks too, the served ETag flips and the frontend's next conditional GET is
 *     a fresh 200 carrying the new meta, rather than silently keeping the stale
 *     items behind a matching ETag.
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
 *
 * The CI rollup does NOT accept that same staleness, because it would land on
 * exactly the pulls a reviewer is waiting on. A CI run completing moves no head
 * SHA, no base SHA, and no `updated_at`, so it is invisible to `changedNumbers`:
 * a rollup refreshed only through the changed set would sit on `pending` for as
 * long as the pull sits still, and an indicator that says "still running" about a
 * build that failed ten minutes ago is worse than showing nothing at all.
 *
 * So an UNSETTLED rollup is itself a change signal: every tick — including an
 * upstream-304 tick — re-observes the rollup for the pulls whose last-known
 * rollup is `pending`, and only those. The cost is bounded by how much CI is
 * actually in flight, rides the batched facts query the loop already issues (one
 * GraphQL request, never a per-PR REST call against the shared bucket), and
 * decays to nothing the moment every build settles — an idle repo with no CI
 * running issues no sweep at all. Because a swept rollup can move while the
 * upstream list 304s, the served ETag is recomputed after the sweep; without that
 * the frontend's conditional GET would keep matching and the new CI state would
 * never reach it.
 *
 * What remains stale, honestly: a rollup that is ABSENT (no CI has reported)
 * stays absent until the pull next changes, so CI that first registers on a
 * head that has stopped moving is not picked up within the interval — the list
 * shows no indicator, which is the truthful reading of "nothing has reported".
 * And a SETTLED rollup that changes because a job was re-run on an unchanged
 * head is not swept either. Both are bounded, both fail toward silence rather
 * than toward a confident wrong answer, and neither is worth a per-tick sweep of
 * every open pull.
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
 * A DETERMINISTIC serialization of the served per-pull meta annotations — the
 * `pr → {authorHumanId, canApprove, assignedReviewerHumanIds, checks}`
 * projection, sorted by PR number so item order never affects the result. Only
 * these annotation scalars/arrays are serialized (never the GitHub pull objects,
 * whose float/field-order drift is the reason the list ETag — not a body hash —
 * anchors the ETag). The reviewer ids are left in their file order (a lead's list
 * order is a durable property of the file); the object shape is fixed so key
 * order is stable.
 *
 * The CI rollup MUST be in here. It is the one served annotation that can move
 * while every other input — including the upstream list ETag — stands still, so
 * leaving it out would mean a finished build never reaches a client holding a
 * matching ETag: it would get a 304 and keep the stale rollup indefinitely. It is
 * re-projected field by field rather than embedded by reference so its key order
 * is fixed no matter how the rollup object was built, and an ABSENT rollup
 * serializes as `null` — distinct from every present state, so a rollup appearing
 * or disappearing moves the hash too.
 */
function serializeAnnotations(items: PullListItem[]): string {
  const rows = items
    .map((it) => ({
      pr: it.pull.number,
      authorHumanId: it.broker.authorHumanId,
      canApprove: it.broker.canApprove,
      assignedReviewerHumanIds: it.broker.assignedReviewerHumanIds,
      checks:
        it.broker.checks === undefined
          ? null
          : { state: it.broker.checks.state, total: it.broker.checks.total },
    }))
    .sort((a, b) => a.pr - b.pr)
  return JSON.stringify(rows)
}

/**
 * Compose the broker-level ETag from GitHub's list ETag AND a hash of the served
 * meta annotations. Deterministic and restart-stable: the same upstream ETag over
 * the same durable meta always yields the same broker ETag, because every input
 * is durable (the upstream ETag is a property of GitHub's response; the meta comes
 * from the `pr_author` table, the reviewers file, and `REVU_BOT_LOGIN`). It is
 * also meta-sensitive: a reviewers-file / author-record / CI-rollup change moves
 * the meta hash even when the list ETag is unchanged, so the served ETag flips on
 * a meta-only change. An empty upstream ETag (a test double that omits one) still
 * yields a stable value keyed on the empty string, so a 304 loop can still form.
 */
export function brokerEtag(listEtag: string, items: PullListItem[]): string {
  return `W/"pulls:${djb2Hex(listEtag)}:${djb2Hex(serializeAnnotations(items))}"`
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
  /**
   * The deterministic broker-level ETag served on `/v1/pulls`, composed from the
   * list ETag AND a hash of the served meta annotations. Recomputed whenever the
   * served items or their annotations change — including on a meta-only 304 tick —
   * so a reviewers-file / author-record edit or a finished CI run flips it even
   * when upstream 304s.
   */
  brokerEtag: string
  rateLimit: RateLimitInfo
}

/** A `RateLimitInfo` used until a real one is read from the first response headers. */
function unknownRateLimit(): RateLimitInfo {
  return { limit: 0, remaining: 0, used: 0, reset: new Date(0).toISOString() }
}

/**
 * A per-pull broker-meta refresh: the live facts a changed pull needs. The
 * loop composes this into `BrokerPullMeta`, layering in the per-pull author /
 * reviewer / approvability annotations from the annotation resolver and the CI
 * rollup (which is tracked separately, because it refreshes on its own schedule).
 */
interface PullMetaFacts {
  unresolvedThreads: number
  commitCount: number
  /** `${mergeBaseSha}...${headSha}` — the same compare key a full sync computes. */
  compareKey: string
}

/**
 * Everything on a pull's served meta EXCEPT the CI rollup. The rollup is layered
 * on last, from its own source, so the three ways a meta gets built (fresh facts,
 * carried forward, first-seen default) cannot each invent their own rule for it.
 */
type MetaWithoutChecks = Omit<BrokerPullMeta, 'checks'>

/**
 * What one tick learned about a pull's CI rollup.
 *
 * `undefined` — NOT OBSERVED. The batched query did not answer for this pull, or
 * answered without a rollup field. The prior rollup carries forward untouched,
 * which is what keeps one pull's checks failure from blanking its indicator or
 * failing the tick.
 *
 * `null` — OBSERVED, NOTHING REPORTED. The pull resolved and has no CI rollup at
 * all. Any prior rollup is CLEARED: a pull whose head moved to a commit no
 * workflow runs on must stop advertising the old commit's result.
 *
 * A `ChecksRollup` — observed and current.
 */
type ObservedRollup = ChecksRollup | null | undefined

/** What one facts phase learned: full facts for changed pulls, rollups for every pull it asked about. */
interface FactsRefresh {
  /** Keyed by PR number; a pull missing here carries its prior facts forward. */
  facts: Map<number, PullMetaFacts>
  /** Keyed by PR number; a pull missing here carries its prior rollup forward. */
  checks: Map<number, ChecksRollup | null>
}

/**
 * The per-pull author / reviewer / approvability annotations layered onto a
 * pull's meta. Resolved from the two host-side seams (the durable `pr_author`
 * store and the reviewers file) plus the bot login — never derived from the
 * pull's live diff facts, so they attach identically to a freshly-refreshed pull
 * and one carried forward unchanged.
 */
interface PullAnnotations {
  authorHumanId: string | null
  canApprove: boolean
  assignedReviewerHumanIds: string[]
}

/**
 * How the poll loop reads pull-author attribution: the durable `pr_author`
 * store's `getPrAuthor` narrowed to exactly what the loop needs. `undefined`
 * means no attribution row exists yet (the field surfaces as `null`); a recorded
 * `null` means a real org member opened the PR (also surfaces as `null`). Kept a
 * one-method seam so the whole store never has to be handed to the loop.
 */
export interface PrAuthorResolver {
  getPrAuthor(pr: number): string | null | undefined
}

/**
 * One pull's batched facts as the poll loop consumes them.
 *
 * Wider than what the REST/GraphQL client currently returns, by exactly one
 * OPTIONAL field: the head commit's CI rollup. Widening here rather than
 * narrowing at the call site means a facts source that does not report a rollup
 * (every rollup is simply never observed, so the field stays absent on the served
 * meta) and one that does are the same type, and the loop's rollup policy is
 * written once against the richer shape.
 */
export interface PollPullFacts {
  unresolvedThreads: number
  commitCount: number
  /**
   * The head commit's rolled-up CI state, when the batched query returned one.
   * Absent means the query did not answer for this pull's rollup — the loop
   * carries the prior rollup forward rather than blanking it. `null` means the
   * query DID answer and there is no CI to report, which clears any prior rollup.
   */
  checks?: ChecksRollup | null
}

/**
 * The engine the poll loop needs beyond the list read: the batched per-pull facts
 * (unresolved counts + commit counts + the CI rollup) and a merge-base compare for
 * the compare key. Kept narrow so the loop is trivially faked in a test.
 */
export interface PollFactsSource {
  /**
   * One batched query answering for many pulls at once. The loop calls this AT
   * MOST once per tick and never issues a per-PR request of its own: the REST
   * allowance is shared by every reviewer on the installation, so a per-pull CI
   * fetch would multiply the whole installation's idle cost by the size of the
   * review queue.
   */
  getPullFacts(
    owner: string,
    repo: string,
    prNumbers: number[],
  ): Promise<Record<number, PollPullFacts>>
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
  /**
   * A narrow read seam over the durable `pr_author` store. When present, a pull's
   * `authorHumanId` is `getPrAuthor(pr) ?? null`; absent, it is always `null`.
   * Only the resolver is threaded — the loop never holds the whole store.
   */
  prAuthor?: PrAuthorResolver
  /**
   * The reviewers file surface. Re-read (`load()`) at the top of each tick so a
   * lead's edit takes effect without a restart; `assignmentsFor(pr)` fills
   * `assignedReviewerHumanIds`. Absent, every pull's assignment list is `[]`.
   */
  reviewers?: ReviewerAssignments
  /**
   * The configured bot login (the broker session's `viewerLogin`, sourced from
   * `REVU_BOT_LOGIN`). `canApprove` compares `pull.user.login` to `botLogin`
   * case-insensitively (GitHub logins are case-insensitive): a PR the App authored
   * (author login === the bot login) is NOT self-approvable, an org member's PR
   * is. Absent / blank (a reads-only broker with no bot identity), `canApprove`
   * stays `true` — the field is only consequential where writes are enabled, which
   * requires the bot login.
   */
  botLogin?: string | null
}

/**
 * A default `BrokerPullMeta` for a pull whose live facts have not (yet) been
 * refreshed — used before the first facts fetch resolves so the list is always
 * well-typed. The counts are zero and the compare key is the base-tip fallback,
 * which is corrected to the true merge base on the next facts refresh. The
 * author / reviewer / approvability annotations are always current (they come
 * from the host-side seams, not the diff facts), so they are filled here too.
 */
function defaultMeta(
  pull: PullSummary,
  annotations: PullAnnotations,
): MetaWithoutChecks {
  return {
    authorHumanId: annotations.authorHumanId,
    canApprove: annotations.canApprove,
    unresolvedThreads: 0,
    assignedReviewerHumanIds: annotations.assignedReviewerHumanIds,
    compareKey: `${pull.base.sha}...${pull.head.sha}`,
    commitCount: 0,
  }
}

/**
 * Carry a pull's prior diff-derived facts forward under FRESH annotations — what
 * an unchanged pull serves. Written out field by field rather than spread so the
 * CI rollup is deliberately dropped here and re-decided by the rollup layer,
 * instead of surviving by accident whenever the meta happens to be copied.
 */
function carriedMeta(
  prior: BrokerPullMeta,
  annotations: PullAnnotations,
): MetaWithoutChecks {
  return {
    authorHumanId: annotations.authorHumanId,
    canApprove: annotations.canApprove,
    unresolvedThreads: prior.unresolvedThreads,
    assignedReviewerHumanIds: annotations.assignedReviewerHumanIds,
    compareKey: prior.compareKey,
    commitCount: prior.commitCount,
  }
}

/**
 * Settle a pull's CI rollup for this tick: what was observed if anything was,
 * otherwise what was already being served. An observed `null` collapses to
 * absent, which is how a rollup is cleared.
 */
function settleRollup(
  observed: ObservedRollup,
  prior: ChecksRollup | undefined,
): ChecksRollup | undefined {
  if (observed === undefined) return prior
  return observed === null ? undefined : observed
}

/**
 * Attach the settled rollup to a meta, OMITTING the key entirely when there is
 * no rollup. Absence is the contract's way of saying nothing has reported, so the
 * field must be missing rather than present-and-undefined — the two are the same
 * to a reader of the object but not to the serialization the ETag hashes.
 */
function withChecks(
  meta: MetaWithoutChecks,
  rollup: ChecksRollup | undefined,
): BrokerPullMeta {
  return rollup === undefined ? { ...meta } : { ...meta, checks: rollup }
}

/**
 * Compose a `BrokerPullMeta` from live facts plus the current author /
 * reviewer / approvability annotations. The facts drive the diff-derived fields;
 * the annotations drive `authorHumanId`, `canApprove`, and
 * `assignedReviewerHumanIds`. The CI rollup is layered on separately.
 */
function metaFromFacts(
  facts: PullMetaFacts,
  annotations: PullAnnotations,
): MetaWithoutChecks {
  return {
    authorHumanId: annotations.authorHumanId,
    canApprove: annotations.canApprove,
    unresolvedThreads: facts.unresolvedThreads,
    assignedReviewerHumanIds: annotations.assignedReviewerHumanIds,
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
  const botLogin = deps.botLogin ?? null

  /**
   * The current author / reviewer / approvability annotations for a pull, from
   * the host-side seams. Re-evaluated for EVERY pull on every tick (not just
   * changed ones), because a lead's reviewers-file edit or a late author record
   * can change these without moving the pull's diff facts — so they attach to a
   * carried-forward meta just as freshly as to a refreshed one.
   *
   * `authorHumanId` is the recorded driver (`undefined` "never observed", a
   * recorded `null` "org member opened it", AND a recorded empty string all
   * collapse to `null` — an empty id is not a real human, so it must not surface
   * as a non-null author).
   * `canApprove` compares the author login to the bot login CASE-INSENSITIVELY
   * (GitHub logins are case-insensitive) — the App refuses to review its own PR,
   * so a bot-authored PR (author login === bot login) is not self-approvable.
   * With no bot login configured (reads-only broker) it stays `true`, which is
   * inconsequential because writes are disabled there.
   * `assignedReviewerHumanIds` is the reviewers file's list for the PR (`[]`
   * when none).
   */
  function annotationsFor(pull: PullSummary): PullAnnotations {
    const recorded = deps.prAuthor?.getPrAuthor(pull.number)
    return {
      authorHumanId: recorded !== undefined && recorded !== null && recorded.length > 0
        ? recorded
        : null,
      canApprove: botLogin === null || botLogin.length === 0
        ? true
        : pull.user.login.toLowerCase() !== botLogin.toLowerCase(),
      assignedReviewerHumanIds: deps.reviewers?.assignmentsFor(pull.number) ?? [],
    }
  }

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
   * Pulls whose last-served rollup is still in flight, and therefore the only
   * ones whose CI state can move without the upstream list moving with it. A
   * settled rollup does not need re-asking, and a pull with no rollup at all has
   * nothing to go stale — so this set is empty on a queue with no CI running,
   * and the sweep it drives costs nothing at all.
   */
  function unsettledNumbers(items: PullListItem[]): number[] {
    return items
      .filter((it) => it.broker.checks?.state === 'pending')
      .map((it) => it.pull.number)
  }

  /**
   * Run the facts phase: ONE batched GraphQL query covering the changed pulls
   * plus the `alsoWatch` pulls whose rollup is unsettled, then one merge-base
   * compare per CHANGED pull for the true `compareKey`. The compares stay bounded
   * to changed pulls — the watched pulls contribute only their rollup, which the
   * one query already carries, so watching them adds no request. With nothing
   * changed and nothing watched, the phase issues nothing at all.
   *
   * A batched-counts failure (the GraphQL query throws — e.g. its SEPARATE rate
   * bucket is exhausted) propagates and fails the whole tick: it is a facts-phase
   * outage, so the caller counts it toward the stale threshold rather than
   * silently serving a list whose facts never refresh. But a SINGLE pull's
   * merge-base compare failing (a persistent 404 on one PR's compare) is isolated
   * HERE: that pull is simply omitted from the returned facts map, so the caller
   * carries its PRIOR meta forward unchanged and every other changed pull still
   * refreshes. One bad pull must never abort the whole tick. Its rollup, which
   * came from the batched query and not the compare, still applies — a broken
   * compare is no reason to freeze a pull's CI indicator.
   */
  async function refreshFacts(
    changed: PullSummary[],
    alsoWatch: number[],
  ): Promise<FactsRefresh> {
    const out: FactsRefresh = { facts: new Map(), checks: new Map() }
    const numbers = [...changed.map((p) => p.number), ...alsoWatch]
    if (numbers.length === 0) return out
    const counts = await deps.facts.getPullFacts(owner, repo, numbers)
    for (const n of numbers) {
      const c = counts[n]
      // A pull the query could not resolve, or resolved without a rollup field,
      // is left OUT of the map — "not observed", so the caller keeps what it was
      // already serving rather than blanking a perfectly good indicator.
      if (c?.checks !== undefined) out.checks.set(n, c.checks)
    }
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
      out.facts.set(pull.number, {
        unresolvedThreads: c?.unresolvedThreads ?? 0,
        commitCount: c?.commitCount ?? 0,
        compareKey: `${compare.merge_base_commit.sha}...${pull.head.sha}`,
      })
    }
    return out
  }

  /**
   * Re-observe the unsettled rollups on an upstream-304 tick, where no other
   * facts are refreshed.
   *
   * Its failure is ABSORBED rather than counted against the stale threshold, and
   * deliberately so: before this sweep existed a 304 tick made no upstream facts
   * call whatsoever, so letting one fail the tick would make an idle broker more
   * fragile than it was. A failed sweep leaves every rollup exactly as it was —
   * still `pending`, which is the last thing actually observed and remains the
   * honest reading while nothing better is known.
   */
  async function sweepUnsettledChecks(
    items: PullListItem[],
  ): Promise<Map<number, ChecksRollup | null>> {
    const watching = unsettledNumbers(items)
    if (watching.length === 0) return new Map()
    try {
      return (await refreshFacts([], watching)).checks
    } catch {
      return new Map()
    }
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
      // Re-read the reviewers file at the top of every tick so a lead's edit takes
      // effect without a restart — even on an otherwise-idle 304 tick, where the
      // annotations are re-applied to the cached items below. A read/parse failure
      // keeps the last-good map inside `load()`; it is not expected to throw, but
      // it is INSIDE the try so a hostile throw can never wedge `inFlight` true
      // forever nor escape `void pollOnce()` as an unhandled rejection — it counts
      // as a failed tick like any other, and `finally` always clears the flag.
      deps.reviewers?.load()
      const page = await deps.client.listOpenPulls(owner, repo, cache?.listEtag ?? null)

      if (page.notModified) {
        if (cache !== null) {
          // Unchanged upstream: the diff-derived fields (counts, compareKey) stay
          // as they were, but the host-side annotations (author, reviewers,
          // approvability) may have moved independently of the diff — so
          // re-annotate the cached items in place. The CI rollup can move
          // independently too, and unlike the annotations it lives upstream, so
          // the unsettled ones are re-observed here as well. Also refresh the rate
          // limit (its headers ride the 304). A 304 IS a successful tick, so it
          // clears the failure streak.
          const swept = await sweepUnsettledChecks(cache.items)
          cache.items = cache.items.map((it) => ({
            pull: it.pull,
            broker: withChecks(
              carriedMeta(it.broker, annotationsFor(it.pull)),
              settleRollup(swept.get(it.pull.number), it.broker.checks),
            ),
          }))
          // Recompute the broker ETag from the (unchanged) list ETag AND the
          // freshly re-applied annotations and rollups: a meta-only change during
          // an upstream-304 tick MUST flip the served ETag, or the frontend keeps
          // stale items behind a matching ETag and never sees the new meta. An
          // upstream 304 no longer implies the served meta is unchanged, which is
          // precisely why this recompute cannot be skipped as an optimization.
          cache.brokerEtag = brokerEtag(cache.listEtag, cache.items)
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
      // A pull whose rollup is unsettled rides along in the same batched query
      // even though the list says it did not change, because a build finishing
      // is exactly the change the list cannot see. Already-changed pulls are
      // excluded — they are being asked about anyway.
      const watching = unsettledNumbers(priorItems).filter((n) => !changed.has(n))
      // A facts-phase outage (the batched counts query throws) propagates out of
      // here to the catch below and counts as a failed tick — so a REST list that
      // keeps 200-ing while GraphQL is down cannot masquerade as fresh forever.
      const refreshed = await refreshFacts(changedPulls, watching)
      const priorMetaByNumber = new Map(
        priorItems.map((it) => [it.pull.number, it.broker]),
      )

      const items: PullListItem[] = page.items.map((pull) => {
        // The host-side annotations (author, reviewers, approvability) are
        // re-resolved for every pull each tick, so a carried-forward meta picks
        // up a reviewers-file or author-record change even when the diff facts
        // did not move.
        const annotations = annotationsFor(pull)
        const carried = priorMetaByNumber.get(pull.number)
        const fresh = refreshed.facts.get(pull.number)
        const base =
          fresh !== undefined
            ? metaFromFacts(fresh, annotations)
            : carried !== undefined
              ? carriedMeta(carried, annotations)
              : defaultMeta(pull, annotations)
        return {
          pull,
          broker: withChecks(
            base,
            settleRollup(refreshed.checks.get(pull.number), carried?.checks),
          ),
        }
      })

      const sortedItems = sortItems(items)
      cache = {
        items: sortedItems,
        listEtag: page.etag,
        brokerEtag: brokerEtag(page.etag, sortedItems),
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

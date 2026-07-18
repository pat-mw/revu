import type { FileViewedState, ReviewDraft } from '@revu/shared'
import type {
  AuditJournalReader,
  OutOfBandReadClient,
  PullOutOfBandReport,
} from '../broker/out-of-band-writes'
import { reconcilePullOutOfBand } from '../broker/out-of-band-writes'
import type { RepoRef } from '../direct/repo'
import type { AuditEntry } from '../direct/store'
import type { HostStore } from './host-store'
import { UnboundOwnerError } from './host-store'

/**
 * The collector merge core: one host-initiated tick that PULLS each managed
 * workspace container's local state (drafts, per-PR viewed state, the audit
 * journal), lands it into the host store, and then runs the out-of-band-write
 * detector over the merged all-humans union.
 *
 * TRUST BOUNDARY — everything inside a pulled payload is untrusted for
 * identity. A contractor has passwordless sudo inside their own container, so
 * the `humanId` embedded in a pulled draft and the `human_id` / `workspace`
 * fields of pulled journal rows are workspace-claimed and spoofable. The one
 * identity signal that crosses the boundary intact is the container's
 * `coder.owner` label, which the host reads off the container it is pulling
 * from — that is `PulledContainer.coderOwner`, the CHANNEL-AUTHENTIC key. The
 * collector therefore keys every record it lands by that `coderOwner` and by
 * NOTHING inside the payload: it hands the raw pulled records plus the
 * channel-authentic owner to the host store, whose landing methods resolve the
 * owner through the identity binding and re-key each row to the canonical
 * email, discarding any workspace-claimed identity on the way in. The
 * collector performs no re-keying of its own — the store is the single place
 * that maps owner → email, so there is no second code path to get it wrong.
 *
 * ORDER OF OPERATIONS — land EVERYTHING first, detect SECOND, over the UNION.
 * One shared bot identity authors GitHub writes for every human, so a write
 * mediated through container A is a legitimate, journaled write that container
 * B's local journal has never heard of. Running the detector against any one
 * container's journal (or against the store before all containers have
 * landed) would flag other humans' mediated writes as out-of-band. The tick
 * therefore lands every pulled container into the store and only then
 * reconciles, reading the journal through the store's all-humans audit UNION —
 * never a per-owner view.
 *
 * FAILURE ISOLATION — one bad container must not stop the others, and an
 * unbound container must not land anything. The pulled payload is
 * attacker-shaped JSON despite the compile-time types, so even its STRUCTURE
 * is untrusted: a non-array pull result, a `null`/non-object element, a
 * non-string `coderOwner`, and a non-array record list are all absorbed as
 * recorded outcomes (or empty record lists) — never as exceptions that would
 * reject the tick and silence detection for every PR. The store fails loud
 * with `UnboundOwnerError` on the FIRST landing call for an owner the
 * identity binding does not know, so an unbound container lands nothing by
 * construction; the tick records it as `bound: false` and moves on. Any other
 * landing failure is captured as a sanitized error mnemonic (the error's
 * name, never its message — a message could echo pulled row content) and the
 * tick continues with the next container. The detector phase is isolated the
 * same way, per PR: one PR's reconcile failure lands in `reconcileErrors`
 * while every other PR's report and every container outcome stand.
 */

/** One managed container's state as pulled over the host-initiated channel. */
export interface PulledContainer {
  /**
   * The channel-authentic owner: the container's `coder.owner` label as read
   * by the HOST from the container it pulled — never a value the workspace
   * reported about itself. This is the only identity the tick lands under.
   */
  coderOwner: string
  drafts: readonly ReviewDraft[]
  viewed: readonly { prNumber: number; state: FileViewedState }[]
  /**
   * The workspace's LOCAL audit journal. Its `humanId` / `workspace` fields
   * are workspace-claimed (spoofable); the store discards them on landing and
   * reconstructs both from the `coderOwner` binding.
   */
  auditRows: readonly AuditEntry[]
}

/**
 * The injected pull channel. Async because the real source is a
 * host-initiated per-container exec; tests inject an in-memory fake.
 */
export interface CollectorPullSource {
  pull(): Promise<readonly PulledContainer[]>
}

/** What happened to one pulled container during the landing phase. */
export interface CollectorContainerOutcome {
  /**
   * The container's channel-authentic owner label — or the fixed
   * `MALFORMED_CONTAINER_OWNER` sentinel when the pulled element was too
   * broken to carry one (not an object, or a non-string/empty `coderOwner`).
   * The sentinel is a constant, never derived from payload content, so a
   * malformed payload cannot choose what appears here.
   */
  coderOwner: string
  /**
   * `false` when the identity binding does not know this owner: nothing was
   * landed for it (the store refuses the first landing call), and the tick
   * carried on with the other containers. Also `false` for a malformed
   * element, which never reaches the store at all.
   */
  bound: boolean
  draftsLanded: number
  viewedLanded: number
  auditLanded: number
  /** Malformed pulled audit rows the store rejected — surfaced, never silently dropped. */
  auditRejected: readonly { index: number; reason: string }[]
  /**
   * Set when landing failed for a reason other than an unbound owner.
   * Sanitized to the error's name only — never the message, which could
   * carry pulled row content. Fixed mnemonics mark structural junk:
   * `MalformedPull` (the pull result was not an array) and
   * `MalformedContainer` (this element was not a landable container).
   */
  error?: string
}

/** The full outcome of one collector tick. */
export interface CollectorTickReport {
  containers: readonly CollectorContainerOutcome[]
  /** Every PR the detector ATTEMPTED: validated pulled activity plus validated extras. */
  reconciledPrs: readonly number[]
  /** One out-of-band report per successfully reconciled PR, from the merged-union detector run. */
  outOfBand: readonly PullOutOfBandReport[]
  /**
   * PRs whose reconcile threw this tick, with the sanitized error mnemonic
   * (an error's name, never its message). Fail-closed: an error here never
   * absolves a bypass — the PR is merely unreconciled THIS tick and is
   * retried on the next one, while every other PR's report and every
   * container outcome stand.
   */
  reconcileErrors: readonly { pr: number; error: string }[]
}

export interface CollectorTickDeps {
  source: CollectorPullSource
  store: HostStore
  github: OutOfBandReadClient
  repo: RepoRef
  botLogin: string
}

/**
 * The owner label recorded for a pulled element too malformed to carry one:
 * not an object, or without a non-empty-string `coderOwner`. A fixed
 * sentinel — never derived from payload content — and unmistakably not a
 * real owner label (`<`/`>` never appear in one), so it cannot collide with
 * or impersonate an identity binding.
 */
export const MALFORMED_CONTAINER_OWNER = '<malformed>'

/**
 * An error NAME is only safe to surface when it looks like an identifier:
 * short, alphanumeric, no spaces or punctuation. Anything else could be a
 * name that smuggles content (an error type that folds its message into
 * `.name`), so it is collapsed to the fixed mnemonic instead.
 */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * The sanitized form of a failure: the error's NAME, and only when the name
 * matches the safe identifier charset — never the message, which routinely
 * echoes pulled row content, and never a content-bearing name. Everything
 * else (non-Error throws included) becomes the fixed `UnknownError`.
 */
function sanitizeError(err: unknown): string {
  if (err instanceof Error && SAFE_ERROR_NAME.test(err.name)) return err.name
  return 'UnknownError'
}

/** True only for a value usable as a PR number: a positive safe integer. */
function isValidPrNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Collect the distinct PR numbers a container's pulled journal shows activity
 * on. The rows are attacker-shaped JSON despite any compile-time type, so the
 * list, each row, and each `pr` field are all re-checked at runtime: a
 * non-array `rows` contributes no PRs, as does a malformed row (the store
 * independently rejects those from landing). A PR number is an
 * identity-independent reconcile hint — nothing here depends on who pulled
 * the rows or whether they landed.
 */
function collectActivityPrs(rows: unknown, into: Set<number>): void {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const pr = (row as { pr?: unknown }).pr
    if (isValidPrNumber(pr)) into.add(pr)
  }
}

/**
 * The recorded outcome for a pulled element (or a whole pull result) whose
 * structure was too broken to land anything. Every field is a constant:
 * nothing in it derives from the payload, so a malformed payload cannot
 * write into the report through this path.
 */
function malformedOutcome(
  error: 'MalformedContainer' | 'MalformedPull',
): CollectorContainerOutcome {
  return {
    coderOwner: MALFORMED_CONTAINER_OWNER,
    bound: false,
    draftsLanded: 0,
    viewedLanded: 0,
    auditLanded: 0,
    auditRejected: [],
    error,
  }
}

/**
 * Run one collector tick: pull every managed container, land each one's
 * records into the host store under its channel-authentic `coderOwner`, and
 * then — after ALL containers have landed — run the out-of-band detector over
 * the merged union, one PR at a time, for every PR the pulled journals show
 * activity on plus `opts.extraPrNumbers`.
 *
 * COMPLETENESS REQUIREMENT — full out-of-band coverage is the CALLER's
 * obligation: the caller MUST pass the complete set of currently open PRs in
 * `opts.extraPrNumbers` on every tick. The activity-derived PR set is only a
 * safety net — it covers PRs that appear in journals pulled THIS tick, and an
 * out-of-band write leaves no journal row anywhere by definition, so a bypass
 * on a PR with no pulled activity is reconciled ONLY if that PR is in
 * `extraPrNumbers`. This is a documented contract, not an enforced one: the
 * tick cannot enumerate open PRs itself, so whoever wires the real pull
 * source must also feed the open-PR set here.
 *
 * The detector's PR set takes validated activity PRs from EVERY pulled
 * container — bound, unbound, errored, and malformed alike. A PR number is a
 * safe, identity-independent reconcile hint: reconciliation is read-only and
 * compares GitHub against the union journal without trusting who suggested
 * the PR, so acting on a hostile hint can only ADD scrutiny. Coverage must
 * never shrink because an owner was unknown or a landing failed — dropping a
 * hint is the unsafe direction, since a genuine bypass on that PR would then
 * go unchecked this tick.
 *
 * The tick never rejects because of what the pull returned: every element —
 * however malformed — becomes a recorded container outcome, and every
 * reconcile failure becomes a `reconcileErrors` entry, so the report is
 * always produced and the detector phase always runs.
 */
export async function runCollectorTick(
  deps: CollectorTickDeps,
  opts?: {
    /**
     * REQUIRED for full detection coverage in a real deployment: the COMPLETE
     * set of currently open PRs. Only PRs in this set or with pulled journal
     * activity this tick are reconciled — an out-of-band write on any other
     * PR is not seen, because a bypass leaves no journal activity to hint it.
     * Entries are validated (positive safe integers); junk values are dropped
     * rather than turned into nonsense GitHub requests.
     */
    extraPrNumbers?: readonly number[]
  },
): Promise<CollectorTickReport> {
  // The pull result is attacker-shaped despite the compile-time type: treat
  // its STRUCTURE as unknown until each piece is checked. A non-array result
  // lands nothing and is recorded as one `MalformedPull` outcome — but the
  // detector phase still runs (over `extraPrNumbers`), because a broken pull
  // channel must not also suspend bypass detection.
  const pulledRaw: unknown = await deps.source.pull()
  const pulled: readonly unknown[] = Array.isArray(pulledRaw) ? pulledRaw : []

  // ——— Phase 1: land every container, keyed only by its channel-authentic owner.
  const containers: CollectorContainerOutcome[] = []
  const activityPrs = new Set<number>()
  if (!Array.isArray(pulledRaw)) containers.push(malformedOutcome('MalformedPull'))
  for (const element of pulled) {
    if (element === null || typeof element !== 'object') {
      // Not even an object: nothing to land, nothing to read. Record a fully
      // constant outcome and keep going with the other elements.
      containers.push(malformedOutcome('MalformedContainer'))
      continue
    }
    const container = element as {
      coderOwner?: unknown
      drafts?: unknown
      viewed?: unknown
      auditRows?: unknown
    }
    // Activity PR hints are collected before anything below can fail or
    // disqualify the element: PR numbers are identity-independent reconcile
    // hints (see the tick doc), so even an owner-less, unbound, or erroring
    // container still contributes its PRs to detection coverage.
    collectActivityPrs(container.auditRows, activityPrs)
    const coderOwner = container.coderOwner
    if (typeof coderOwner !== 'string' || coderOwner === '') {
      // A non-string (or empty) owner must never reach the store: record the
      // element under the fixed sentinel — never a payload-derived value —
      // and move on.
      containers.push(malformedOutcome('MalformedContainer'))
      continue
    }
    // A non-array record list is treated as empty for that kind: the store is
    // never handed junk in place of a list, and the container's other record
    // kinds still land.
    const drafts: readonly ReviewDraft[] = Array.isArray(container.drafts)
      ? (container.drafts as ReviewDraft[])
      : []
    const viewed: readonly { prNumber: number; state: FileViewedState }[] = Array.isArray(
      container.viewed,
    )
      ? (container.viewed as { prNumber: number; state: FileViewedState }[])
      : []
    const auditRows: readonly AuditEntry[] = Array.isArray(container.auditRows)
      ? (container.auditRows as AuditEntry[])
      : []
    let bound = true
    let draftsLanded = 0
    let viewedLanded = 0
    let auditLanded = 0
    let auditRejected: readonly { index: number; reason: string }[] = []
    let error: string | undefined
    try {
      for (const draft of drafts) {
        deps.store.landDraft(coderOwner, draft)
        draftsLanded += 1
      }
      for (const entry of viewed) {
        deps.store.landViewed(coderOwner, entry.prNumber, entry.state)
        viewedLanded += 1
      }
      // Always called, even with zero rows: the store resolves the binding
      // before touching anything, so this is also what detects an unbound
      // container that happened to pull back empty.
      const audit = deps.store.landAudit(coderOwner, auditRows)
      auditLanded = audit.landed
      auditRejected = audit.rejected
    } catch (err) {
      if (err instanceof UnboundOwnerError) {
        // Unbound: the store refused before landing anything. Record and
        // continue — never land unbound records, never abort the tick.
        bound = false
      } else {
        // Any other failure: keep only the error's NAME. The message could
        // echo pulled row content, which must not leak into the report.
        error = sanitizeError(err)
      }
    }
    containers.push({
      coderOwner,
      bound,
      draftsLanded,
      viewedLanded,
      auditLanded,
      auditRejected,
      ...(error === undefined ? {} : { error }),
    })
  }

  // ——— Phase 2: detect, over the merged union, only after every container landed.
  // Caller-supplied extras get the same PR-number gate as pulled activity:
  // the caller is trusted, but a junk value (NaN, a negative, a float) would
  // still become a nonsense GitHub request downstream, so it is dropped here.
  for (const pr of opts?.extraPrNumbers ?? []) {
    if (isValidPrNumber(pr)) activityPrs.add(pr)
  }
  const reconciledPrs = [...activityPrs].sort((a, b) => a - b)

  // The journal the detector reads is the store's all-humans UNION: one bot
  // authors across every human, so a write mediated by one container must be
  // visible when reconciling on behalf of all of them. A per-owner journal
  // here would flag every other human's mediated writes as out-of-band.
  const journal: AuditJournalReader = {
    listAudit: (filter) => deps.store.listAuditUnion(filter),
  }
  const reconcileDeps = {
    github: deps.github,
    journal,
    repo: deps.repo,
    botLogin: deps.botLogin,
  }

  // One reconcile per PR, isolated: a failure on one PR (a flaky GitHub read,
  // a transient network error) is recorded in `reconcileErrors` and the loop
  // continues, so a single bad PR can never drop every other PR's report —
  // or the container outcomes — with it. Fail-closed by construction: an
  // error never absolves anything, it only marks the PR as unreconciled this
  // tick, to be re-checked on the next one.
  const outOfBand: PullOutOfBandReport[] = []
  const reconcileErrors: { pr: number; error: string }[] = []
  for (const pr of reconciledPrs) {
    try {
      outOfBand.push(await reconcilePullOutOfBand(reconcileDeps, pr))
    } catch (err) {
      reconcileErrors.push({ pr, error: sanitizeError(err) })
    }
  }

  return { containers, reconciledPrs, outOfBand, reconcileErrors }
}

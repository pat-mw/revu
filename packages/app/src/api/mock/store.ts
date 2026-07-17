import type { FileBlob, FileViewedState, HumanPreferences, IssueComment, RateLimitInfo, ReactionKey, ReactionRollup, ReviewComment, ReviewDraft, ReviewSummary, ReviewThread, Snapshot } from '@revu/shared'
import { DEFAULT_PREFERENCES } from '@revu/shared'
import type { FixtureDB, RemotePull } from '@/fixtures/contract'
import { fixtureDB } from '@/fixtures'
import type { DevState } from './devtools'

/**
 * Persistent broker-side state for the mock adapter.
 *
 * Fixtures describe the REMOTE — what GitHub + the broker would answer right
 * now. This store owns everything cached or broker-side:
 *
 * - snapshots and the content-addressed blob store (the local cache),
 * - per-human drafts and per-file viewed state (broker state, keyed by the
 *   Coder identity, never by any GitHub login),
 * - a serialized overlay of every mutation the app pushed at the "remote"
 *   (replies, resolution flips, reaction bumps, submitted reviews and their
 *   new threads). Fixture + overlay = the effective remote, so writes made
 *   through the app survive a reload without editing fixture modules,
 * - dev-panel settings, per-PR sync-attempt counts, and the simulated
 *   shared rate bucket.
 *
 * Everything lives under ONE localStorage key as one JSON document,
 * persisted with a ~1s debounce and flushed when the tab is hidden. A missing
 * or corrupt document reseeds cleanly from fixtures; a structurally sound
 * document from an older version is MIGRATED in place (never reseeded), so a
 * version bump never discards drafts or any local work. Every boundary
 * deep-clones: nothing returned to callers aliases internal state, and nothing
 * stored aliases caller-owned objects.
 */

const STORAGE_KEY = 'revu.broker.v1'
const STORE_VERSION = 2
const RATE_LIMIT = 5000
const HOUR_MS = 3_600_000
/** New comment/review ids start well above any id a fixture author would use. */
const ID_BASE = 700_000_000

const db = fixtureDB as FixtureDB

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Serialized mutations against one PR's remote. Applying these on top of a
 * cloned fixture `RemotePull` yields the effective remote:
 *
 * - `threadReplies` are appended into the matching thread's `comments`
 *   (added threads included — a reply to a thread you created works),
 * - `resolutions` flip `isResolved`/`resolvedBy`,
 * - `reactionBumps` add to per-comment reaction counts (and `total_count`),
 * - `addedThreads`/`addedReviews` (from submitted reviews) are appended,
 * - `touchedAt` floats the PR's `updated_at` so the list re-sorts honestly.
 */
export interface RemoteOverlay {
  threadReplies: Record<string, ReviewComment[]>
  resolutions: Record<
    string,
    { isResolved: boolean; resolvedBy: { login: string } | null }
  >
  /** Keyed by `String(commentId)`; each value maps reaction → increment. */
  reactionBumps: Record<string, Partial<Record<ReactionKey, number>>>
  addedThreads: ReviewThread[]
  addedReviews: ReviewSummary[]
  touchedAt: string | null
}

interface StoreShape {
  v: typeof STORE_VERSION
  dev: DevState
  /** humanId → prNumber → draft. */
  drafts: Record<string, Record<number, ReviewDraft>>
  /** humanId → prNumber → per-file viewed state. */
  viewed: Record<string, Record<number, FileViewedState>>
  /** humanId → per-human workspace preferences (not scoped to any PR). */
  preferences: Record<string, HumanPreferences>
  snapshots: Record<number, Snapshot>
  /** Content-addressed: git blob SHA → blob. Only sync ever adds remote content. */
  blobs: Record<string, FileBlob>
  remoteMut: Record<number, RemoteOverlay>
  /** How many syncs have been attempted per PR — first-attempt-only scenarios key off this. */
  syncAttempts: Record<number, number>
  rate: { remaining: number; reset: string }
  /** Monotonic id counter for comments/reviews created through the app. */
  counter: number
}

function emptyOverlay(): RemoteOverlay {
  return {
    threadReplies: {},
    resolutions: {},
    reactionBumps: {},
    addedThreads: [],
    addedReviews: [],
    touchedAt: null,
  }
}

/**
 * Fresh state from fixtures. Remote blobs do NOT bulk-enter the blob store —
 * they arrive only when a sync fetches them. The exceptions are blobs
 * referenced by seeded snapshots (those PRs were "already synced", so their
 * referenced content must be present): sourced from `seededBlobs` (old-head
 * content absent from any current remote) plus the matching remote's blobs,
 * excluding anything a seeded partial snapshot lists as missing.
 */
function seed(): StoreShape {
  const drafts: StoreShape['drafts'] = {}
  for (const d of db.seededDrafts) {
    ;(drafts[d.humanId] ??= {})[d.prNumber] = clone(d)
  }

  const viewed: StoreShape['viewed'] = {}
  for (const v of db.seededViewed) {
    ;(viewed[v.humanId] ??= {})[v.prNumber] = clone(v.state)
  }

  const snapshots: StoreShape['snapshots'] = {}
  const syncAttempts: StoreShape['syncAttempts'] = {}
  for (const s of db.seededSnapshots) {
    snapshots[s.prNumber] = clone(s)
    // A seeded partial snapshot means a sync already failed once before the
    // app loaded — count that attempt so first-attempt-only failure scenarios
    // don't fire again and the in-app retry succeeds.
    if (s.partial) syncAttempts[s.prNumber] = 1
  }

  const blobs: StoreShape['blobs'] = {}
  for (const b of db.seededBlobs) blobs[b.sha] = clone(b)
  for (const s of db.seededSnapshots) {
    const remote = db.pulls.find((p) => p.detail.number === s.prNumber)
    if (!remote) continue
    const missing = new Set(s.partial?.missingBlobShas ?? [])
    const referenced = new Set<string>()
    for (const sides of Object.values(s.immutable.blobIndex)) {
      if (sides.base && !missing.has(sides.base)) referenced.add(sides.base)
      if (sides.head && !missing.has(sides.head)) referenced.add(sides.head)
    }
    for (const b of remote.blobs) {
      if (referenced.has(b.sha) && !(b.sha in blobs)) blobs[b.sha] = clone(b)
    }
  }

  return {
    v: STORE_VERSION,
    dev: {
      humanId: db.defaultHumanId,
      latency: 'realistic',
      failureMode: 'none',
    },
    drafts,
    viewed,
    preferences: {},
    snapshots,
    blobs,
    remoteMut: {},
    syncAttempts,
    rate: {
      remaining: RATE_LIMIT,
      reset: new Date(Date.now() + HOUR_MS).toISOString(),
    },
    counter: 0,
  }
}

/**
 * Load the persisted document, MIGRATING it in place rather than reseeding when
 * an older-but-valid version is found. Drafts, viewed state, and every overlay
 * are irreplaceable local work — "drafts survive everything" — so a version bump
 * must never discard a structurally sound document; it upgrades it and keeps all
 * of it. Only a genuinely missing, corrupt (a core field absent or wrong-typed),
 * or unknown-version (future, or not a number in [1, current]) document falls
 * through to a full reseed from fixtures.
 *
 * When adding a new field in a future version, bump `STORE_VERSION` and add a
 * migration step below (default the field, then stamp the new version) — DO NOT
 * add the field to the corruption check above, or upgrading an old document
 * would wipe it. Migrate, never reseed, for additive changes.
 */
function load(): StoreShape {
  if (typeof localStorage === 'undefined') return seed()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seed()
    const parsed = JSON.parse(raw) as Partial<StoreShape> | null
    // Fields present since the first version: their absence means the document
    // is genuinely corrupt (not merely old), so reseeding is correct.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.v !== 'number' ||
      !parsed.dev ||
      !parsed.drafts ||
      !parsed.viewed ||
      !parsed.snapshots ||
      !parsed.blobs ||
      !parsed.remoteMut ||
      !parsed.syncAttempts ||
      !parsed.rate ||
      typeof parsed.counter !== 'number'
    ) {
      return seed()
    }
    // An unknown version — a future document this build can't reason about, or a
    // nonsense value — is not safe to migrate blindly, so reseed.
    if (parsed.v < 1 || parsed.v > STORE_VERSION) return seed()

    // Migrations, oldest → newest. v1 documents predate per-human preferences;
    // default the field so the whole document loads intact instead of reseeding.
    if (parsed.preferences === undefined) parsed.preferences = {}

    parsed.v = STORE_VERSION
    return parsed as StoreShape
  } catch {
    return seed()
  }
}

let state: StoreShape = load()

// ————————————————————————————————————————————————————————————————
// Persistence: single key, ~1s debounce, flushed when the tab hides.
// ————————————————————————————————————————————————————————————————

let persistTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota or privacy-mode failure: state keeps working in memory for the session.
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    flush()
  }, 1000)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

// ————————————————————————————————————————————————————————————————
// Rate bucket: restored to the full limit whenever the window passes.
// Per-window spend history is deliberately not modeled.
// ————————————————————————————————————————————————————————————————

function rollRate(): void {
  const now = Date.now()
  let resetMs = Date.parse(state.rate.reset)
  if (Number.isNaN(resetMs)) resetMs = now - 1
  if (resetMs <= now) {
    while (resetMs <= now) resetMs += HOUR_MS
    state.rate.remaining = RATE_LIMIT
    state.rate.reset = new Date(resetMs).toISOString()
    schedulePersist()
  }
}

// ————————————————————————————————————————————————————————————————
// Effective remote = fixture RemotePull + overlay.
// ————————————————————————————————————————————————————————————————

function findReactableIn(
  container: { threads: ReviewThread[]; issueComments: IssueComment[] },
  commentId: number,
): { reactions: ReactionRollup } | null {
  for (const t of container.threads) {
    for (const c of t.comments) {
      if (c.id === commentId) return c
    }
  }
  for (const c of container.issueComments) {
    if (c.id === commentId) return c
  }
  return null
}

function applyOverlay(remote: RemotePull, ov: RemoteOverlay): void {
  for (const t of ov.addedThreads) remote.threads.push(clone(t))
  for (const [threadId, replies] of Object.entries(ov.threadReplies)) {
    const t = remote.threads.find((x) => x.id === threadId)
    if (t) t.comments.push(...replies.map((r) => clone(r)))
  }
  for (const [threadId, res] of Object.entries(ov.resolutions)) {
    const t = remote.threads.find((x) => x.id === threadId)
    if (t) {
      t.isResolved = res.isResolved
      t.resolvedBy = res.resolvedBy ? { ...res.resolvedBy } : null
    }
  }
  for (const [cid, bumps] of Object.entries(ov.reactionBumps)) {
    const target = findReactableIn(remote, Number(cid))
    if (!target) continue
    for (const [key, n] of Object.entries(bumps)) {
      const inc = n ?? 0
      target.reactions[key as ReactionKey] += inc
      target.reactions.total_count += inc
    }
  }
  for (const r of ov.addedReviews) remote.reviews.push(clone(r))

  const addedComments =
    ov.addedThreads.reduce((n, t) => n + t.comments.length, 0) +
    Object.values(ov.threadReplies).reduce((n, arr) => n + arr.length, 0)
  remote.detail.review_comments += addedComments
  if (ov.touchedAt && ov.touchedAt > remote.detail.updated_at) {
    remote.detail.updated_at = ov.touchedAt
  }
}

function effectiveRemote(prNumber: number): RemotePull | null {
  const fixture = db.pulls.find((p) => p.detail.number === prNumber)
  if (!fixture) return null
  const remote = clone(fixture)
  const ov = state.remoteMut[prNumber]
  if (ov) applyOverlay(remote, ov)
  return remote
}

function overlayFor(prNumber: number): RemoteOverlay {
  return (state.remoteMut[prNumber] ??= emptyOverlay())
}

// ————————————————————————————————————————————————————————————————
// Public store surface. Every getter returns a deep clone; every putter
// clones its input and schedules persistence.
// ————————————————————————————————————————————————————————————————

export const store = {
  /**
   * Persist the whole document synchronously, cancelling any pending debounce.
   * The browser already flushes on the ~1s debounce and on visibilitychange;
   * a durable host (a daemon writing to disk through a `localStorage` polyfill)
   * calls this after every mutation and on shutdown so no in-flight write is
   * lost to a crash. Behavior-preserving: in the browser this is exactly the
   * debounced `setItem` run eagerly.
   */
  flush(): void {
    flush()
  },

  // ——— dev panel state ———

  getDev(): DevState {
    return { ...state.dev }
  },

  patchDev(patch: Partial<DevState>): DevState {
    state.dev = { ...state.dev, ...patch }
    schedulePersist()
    return { ...state.dev }
  },

  /** Drop persisted state and reseed from fixtures. */
  reset(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // Removal failing (privacy mode) still leaves a clean in-memory seed.
      }
    }
    state = seed()
  },

  // ——— simulated shared rate bucket ———

  rateInfo(): RateLimitInfo {
    rollRate()
    return {
      limit: RATE_LIMIT,
      remaining: state.rate.remaining,
      used: RATE_LIMIT - state.rate.remaining,
      reset: state.rate.reset,
    }
  },

  spendRate(requests: number): void {
    rollRate()
    state.rate.remaining = Math.max(0, state.rate.remaining - requests)
    schedulePersist()
  },

  // ——— snapshots (the local cache) ———

  getSnapshot(prNumber: number): Snapshot | null {
    const s = state.snapshots[prNumber]
    return s ? clone(s) : null
  },

  putSnapshot(snap: Snapshot): void {
    state.snapshots[snap.prNumber] = clone(snap)
    schedulePersist()
  },

  // ——— content-addressed blob store ———

  hasBlob(sha: string): boolean {
    return sha in state.blobs
  },

  getBlob(sha: string): FileBlob | null {
    const b = state.blobs[sha]
    return b ? clone(b) : null
  },

  putBlobs(blobs: FileBlob[]): void {
    if (blobs.length === 0) return
    for (const b of blobs) state.blobs[b.sha] = clone(b)
    schedulePersist()
  },

  // ——— per-human drafts ———

  getDraft(humanId: string, prNumber: number): ReviewDraft | null {
    const d = state.drafts[humanId]?.[prNumber]
    return d ? clone(d) : null
  },

  putDraft(draft: ReviewDraft): void {
    ;(state.drafts[draft.humanId] ??= {})[draft.prNumber] = clone(draft)
    schedulePersist()
  },

  deleteDraft(humanId: string, prNumber: number): void {
    const perHuman = state.drafts[humanId]
    if (perHuman && prNumber in perHuman) {
      delete perHuman[prNumber]
      schedulePersist()
    }
  },

  // ——— per-human viewed state ———

  getViewed(humanId: string, prNumber: number): FileViewedState {
    const v = state.viewed[humanId]?.[prNumber]
    return v ? clone(v) : {}
  },

  setViewed(humanId: string, prNumber: number, s: FileViewedState): void {
    ;(state.viewed[humanId] ??= {})[prNumber] = clone(s)
    schedulePersist()
  },

  // ——— per-human workspace preferences ———

  getPreferences(humanId: string): HumanPreferences {
    return { ...DEFAULT_PREFERENCES, ...state.preferences[humanId] }
  },

  /** Merge a partial patch over the stored set; returns the full updated set. */
  setPreferences(humanId: string, patch: Partial<HumanPreferences>): HumanPreferences {
    const next = { ...DEFAULT_PREFERENCES, ...state.preferences[humanId], ...patch }
    state.preferences[humanId] = next
    schedulePersist()
    return { ...next }
  },

  // ——— sync attempt tracking ———

  getSyncAttempts(prNumber: number): number {
    return state.syncAttempts[prNumber] ?? 0
  },

  bumpSyncAttempts(prNumber: number): void {
    state.syncAttempts[prNumber] = (state.syncAttempts[prNumber] ?? 0) + 1
    schedulePersist()
  },

  // ——— persistent id counter for comments/reviews created through the app ———

  nextId(): number {
    state.counter += 1
    schedulePersist()
    return ID_BASE + state.counter
  },

  // ——— effective remote (fixture + overlay) ———

  effectiveRemote,

  listEffectiveRemotes(): RemotePull[] {
    const remotes: RemotePull[] = []
    for (const p of db.pulls) {
      const r = effectiveRemote(p.detail.number)
      if (r) remotes.push(r)
    }
    return remotes
  },

  // ——— overlay mutations (writes against the "remote") ———

  appendReply(prNumber: number, threadId: string, comment: ReviewComment): void {
    const ov = overlayFor(prNumber)
    ;(ov.threadReplies[threadId] ??= []).push(clone(comment))
    ov.touchedAt = comment.created_at
    schedulePersist()
  },

  setResolution(
    prNumber: number,
    threadId: string,
    isResolved: boolean,
    resolvedBy: { login: string } | null,
  ): void {
    const ov = overlayFor(prNumber)
    ov.resolutions[threadId] = {
      isResolved,
      resolvedBy: resolvedBy ? { ...resolvedBy } : null,
    }
    ov.touchedAt = new Date().toISOString()
    schedulePersist()
  },

  /** Reactions do not float `updated_at` — GitHub doesn't either. */
  bumpReaction(prNumber: number, commentId: number, key: ReactionKey): void {
    const ov = overlayFor(prNumber)
    const bumps = (ov.reactionBumps[String(commentId)] ??= {})
    bumps[key] = (bumps[key] ?? 0) + 1
    schedulePersist()
  },

  appendReview(
    prNumber: number,
    review: ReviewSummary,
    threads: ReviewThread[],
  ): void {
    const ov = overlayFor(prNumber)
    ov.addedReviews.push(clone(review))
    ov.addedThreads.push(...threads.map((t) => clone(t)))
    ov.touchedAt = review.submitted_at
    schedulePersist()
  },
}

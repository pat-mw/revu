/**
 * Zero-dependency runtime validators for every payload that crosses the HTTP
 * boundary. `@revu/shared` is deliberately dependency-free, so this is a tiny
 * hand-rolled combinator kit rather than a schema library.
 *
 * Each validator RECONSTRUCTS a typed value from unknown input and throws a
 * `ValidationError` on any mismatch. Two properties are load-bearing:
 *
 * - No coercion. A string is not a number; a missing required key is an error.
 * - Losslessness of declared shape. `vObject` copies ONLY declared keys, so a
 *   validator that is missing a field silently drops it — which is exactly what
 *   the fixture round-trip test detects. Absent optionals are omitted from the
 *   output entirely (never set to `undefined`), so a JSON round-trip through a
 *   correct validator is deep-equal to the original value.
 *
 * The per-type validators mirror `./api/types` field for field. When a type and
 * a validator disagree, the type is the source of truth.
 */

import type {
  AnchorResult,
  BrokerPullMeta,
  CheckRun,
  CommitInfo,
  FileBlob,
  FileViewedState,
  GhLabel,
  GhRef,
  GhUser,
  Human,
  HumanPreferences,
  IssueComment,
  PendingComment,
  PullDetail,
  PullFile,
  PullListItem,
  PullListResponse,
  PullSummary,
  RateLimitInfo,
  ReactionKey,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Session,
  Snapshot,
  SnapshotImmutable,
  SnapshotMutable,
  SubmitResult,
  SubmitReviewInput,
} from './api/types'
import type { HttpErrorBody } from './http'

// ————————————————————————————————————————————————————————————————
// Combinator kit
// ————————————————————————————————————————————————————————————————

/** Thrown by any validator on a shape mismatch. `path` locates the failure. */
export class ValidationError extends Error {
  path: string
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'ValidationError'
    this.path = path
  }
}

/**
 * A validator returns a reconstructed, typed value or throws `ValidationError`.
 * `path` is threaded through for error messages; callers pass the root path.
 */
export type Validator<T> = (input: unknown, path?: string) => T

/** Marker on optional-key validators so `vObject` can omit absent keys. */
const OPTIONAL = Symbol('optional')
type OptionalValidator<T> = Validator<T | undefined> & { [OPTIONAL]: true }

function isOptional(v: Validator<unknown>): v is OptionalValidator<unknown> {
  return (v as { [OPTIONAL]?: true })[OPTIONAL] === true
}

export const vString: Validator<string> = (input, path = '') => {
  if (typeof input !== 'string') {
    throw new ValidationError(path, `expected string, got ${describe(input)}`)
  }
  return input
}

export const vNumber: Validator<number> = (input, path = '') => {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new ValidationError(path, `expected finite number, got ${describe(input)}`)
  }
  return input
}

export const vBoolean: Validator<boolean> = (input, path = '') => {
  if (typeof input !== 'boolean') {
    throw new ValidationError(path, `expected boolean, got ${describe(input)}`)
  }
  return input
}

/** One of a fixed set of primitive literals (enum-ish fields). */
export function vLiteral<T extends string | number | boolean>(
  ...allowed: T[]
): Validator<T> {
  return (input, path = '') => {
    if (!allowed.includes(input as T)) {
      throw new ValidationError(
        path,
        `expected one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}, got ${describe(input)}`,
      )
    }
    return input as T
  }
}

/** `null` passes through unchanged; anything else must satisfy `inner`. */
export function vNullable<T>(inner: Validator<T>): Validator<T | null> {
  return (input, path = '') => (input === null ? null : inner(input, path))
}

/**
 * Meaningful only as a value in `vObject`'s shape: when the key is absent from
 * the input, `vObject` omits it from the output; when present, it must satisfy
 * `inner`. (Standalone it accepts `undefined` or an `inner` value.)
 */
export function vOptional<T>(inner: Validator<T>): OptionalValidator<T> {
  const validator: Validator<T | undefined> = (input, path = '') =>
    input === undefined ? undefined : inner(input, path)
  return Object.assign(validator, { [OPTIONAL]: true as const })
}

export function vArray<T>(inner: Validator<T>): Validator<T[]> {
  return (input, path = '') => {
    if (!Array.isArray(input)) {
      throw new ValidationError(path, `expected array, got ${describe(input)}`)
    }
    return input.map((item, i) => inner(item, `${path}[${i}]`))
  }
}

/**
 * A fixed-shape object. The output is reconstructed from DECLARED keys only —
 * extra input keys are dropped. A key whose validator is `vOptional(...)` is
 * omitted from the output when absent from the input; a required key that is
 * absent throws.
 */
export function vObject<S extends Record<string, Validator<unknown>>>(
  shape: S,
): Validator<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (input, path = '') => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ValidationError(path, `expected object, got ${describe(input)}`)
    }
    const source = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) {
      const validator = shape[key]
      const keyPath = path ? `${path}.${key}` : key
      const present = Object.prototype.hasOwnProperty.call(source, key)
      if (isOptional(validator)) {
        if (!present || source[key] === undefined) continue
        out[key] = validator(source[key], keyPath)
      } else {
        if (!present) {
          throw new ValidationError(keyPath, 'required key is missing')
        }
        out[key] = validator(source[key], keyPath)
      }
    }
    return out as { [K in keyof S]: ReturnType<S[K]> }
  }
}

/** An object with arbitrary string keys, every value validated by `inner`. */
export function vRecord<T>(inner: Validator<T>): Validator<Record<string, T>> {
  return (input, path = '') => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ValidationError(path, `expected object, got ${describe(input)}`)
    }
    const source = input as Record<string, unknown>
    const out: Record<string, T> = {}
    for (const key of Object.keys(source)) {
      const value = inner(source[key], path ? `${path}.${key}` : key)
      // `out[key] = value` would set the prototype for a key literally named
      // `__proto__` (a legal git path) instead of an own property, silently
      // dropping it. defineProperty makes ANY key name an own enumerable one.
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
}

/**
 * A tagged union: `tagKey` selects the variant validator. The chosen variant
 * validates the whole object (so it must itself declare `tagKey`).
 */
export function vDiscriminatedUnion<T>(
  tagKey: string,
  variants: Record<string, Validator<T>>,
): Validator<T>
export function vDiscriminatedUnion(
  tagKey: string,
  variants: Record<string, Validator<unknown>>,
): Validator<unknown> {
  return (input, path = '') => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ValidationError(path, `expected object, got ${describe(input)}`)
    }
    const tag = (input as Record<string, unknown>)[tagKey]
    // OWN-key membership only. A plain `tag in variants` walks the prototype
    // chain, so `Object.prototype` names like 'constructor' or 'toString' would
    // spuriously match and bypass validation.
    if (
      typeof tag !== 'string' ||
      !Object.prototype.hasOwnProperty.call(variants, tag)
    ) {
      throw new ValidationError(
        path ? `${path}.${tagKey}` : tagKey,
        `expected one of ${Object.keys(variants).map((k) => JSON.stringify(k)).join(', ')}, got ${describe(tag)}`,
      )
    }
    return variants[tag](input, path)
  }
}

function describe(input: unknown): string {
  if (input === null) return 'null'
  if (Array.isArray(input)) return 'array'
  return typeof input
}

// ————————————————————————————————————————————————————————————————
// Per-type validators — mirror ./api/types exactly
// ————————————————————————————————————————————————————————————————

// GitHub-shaped primitives

export const vGhUser: Validator<GhUser> = vObject({
  login: vString,
  id: vNumber,
  node_id: vString,
  avatar_url: vString,
  html_url: vString,
  type: vLiteral('User', 'Bot', 'Organization'),
})

export const vGhLabel: Validator<GhLabel> = vObject({
  id: vNumber,
  name: vString,
  color: vString,
  description: vNullable(vString),
})

export const vReactionKey: Validator<ReactionKey> = vLiteral(
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
)

export const vReactionRollup: Validator<ReactionRollup> = vObject({
  url: vString,
  total_count: vNumber,
  '+1': vNumber,
  '-1': vNumber,
  laugh: vNumber,
  hooray: vNumber,
  confused: vNumber,
  heart: vNumber,
  rocket: vNumber,
  eyes: vNumber,
})

export const vGhRef: Validator<GhRef> = vObject({
  ref: vString,
  sha: vString,
  label: vString,
  repo: vObject({ full_name: vString, default_branch: vString }),
})

export const vPullSummary: Validator<PullSummary> = vObject({
  id: vNumber,
  node_id: vString,
  number: vNumber,
  state: vLiteral('open', 'closed'),
  draft: vBoolean,
  merged_at: vNullable(vString),
  title: vString,
  body: vNullable(vString),
  user: vGhUser,
  labels: vArray(vGhLabel),
  requested_reviewers: vArray(vGhUser),
  head: vGhRef,
  base: vGhRef,
  created_at: vString,
  updated_at: vString,
})

export const vPullDetail: Validator<PullDetail> = vObject({
  // PullSummary fields
  id: vNumber,
  node_id: vString,
  number: vNumber,
  state: vLiteral('open', 'closed'),
  draft: vBoolean,
  merged_at: vNullable(vString),
  title: vString,
  body: vNullable(vString),
  user: vGhUser,
  labels: vArray(vGhLabel),
  requested_reviewers: vArray(vGhUser),
  head: vGhRef,
  base: vGhRef,
  created_at: vString,
  updated_at: vString,
  // PullDetail additions
  merged: vBoolean,
  mergeable: vNullable(vBoolean),
  mergeable_state: vLiteral('clean', 'dirty', 'unstable', 'blocked', 'unknown'),
  merge_base_sha: vString,
  comments: vNumber,
  review_comments: vNumber,
  commits: vNumber,
  additions: vNumber,
  deletions: vNumber,
  changed_files: vNumber,
})

export const vPullFile: Validator<PullFile> = vObject({
  sha: vString,
  filename: vString,
  previous_filename: vOptional(vString),
  status: vLiteral('added', 'modified', 'removed', 'renamed'),
  additions: vNumber,
  deletions: vNumber,
  changes: vNumber,
  patch: vOptional(vString),
})

export const vReviewComment: Validator<ReviewComment> = vObject({
  id: vNumber,
  node_id: vString,
  pull_request_review_id: vNullable(vNumber),
  in_reply_to_id: vOptional(vNumber),
  path: vString,
  diff_hunk: vString,
  commit_id: vString,
  original_commit_id: vString,
  line: vNullable(vNumber),
  original_line: vNullable(vNumber),
  start_line: vNullable(vNumber),
  original_start_line: vNullable(vNumber),
  side: vLiteral('LEFT', 'RIGHT'),
  start_side: vNullable(vLiteral('LEFT', 'RIGHT')),
  subject_type: vLiteral('line', 'file'),
  user: vGhUser,
  body: vString,
  created_at: vString,
  updated_at: vString,
  reactions: vReactionRollup,
  html_url: vString,
})

export const vReviewThread: Validator<ReviewThread> = vObject({
  id: vString,
  isResolved: vBoolean,
  isOutdated: vBoolean,
  path: vString,
  line: vNullable(vNumber),
  originalLine: vNullable(vNumber),
  startLine: vNullable(vNumber),
  originalStartLine: vNullable(vNumber),
  diffSide: vLiteral('LEFT', 'RIGHT'),
  startDiffSide: vNullable(vLiteral('LEFT', 'RIGHT')),
  subjectType: vLiteral('LINE', 'FILE'),
  resolvedBy: vNullable(vObject({ login: vString })),
  comments: vArray(vReviewComment),
})

export const vIssueComment: Validator<IssueComment> = vObject({
  id: vNumber,
  node_id: vString,
  user: vGhUser,
  body: vString,
  created_at: vString,
  updated_at: vString,
  reactions: vReactionRollup,
})

export const vReviewSummary: Validator<ReviewSummary> = vObject({
  id: vNumber,
  node_id: vString,
  user: vGhUser,
  body: vString,
  state: vLiteral('COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING'),
  submitted_at: vString,
  commit_id: vString,
})

export const vCommitInfo: Validator<CommitInfo> = vObject({
  sha: vString,
  commit: vObject({
    message: vString,
    author: vObject({ name: vString, email: vString, date: vString }),
  }),
  author: vNullable(vGhUser),
  parents: vArray(vObject({ sha: vString })),
})

export const vCheckRun: Validator<CheckRun> = vObject({
  id: vNumber,
  name: vString,
  status: vLiteral('queued', 'in_progress', 'completed'),
  conclusion: vNullable(
    vLiteral(
      'success',
      'failure',
      'neutral',
      'cancelled',
      'timed_out',
      'skipped',
    ),
  ),
  started_at: vString,
  completed_at: vNullable(vString),
  details_url: vString,
  output: vObject({
    title: vNullable(vString),
    summary: vNullable(vString),
    text: vOptional(vNullable(vString)),
  }),
})

export const vRateLimitInfo: Validator<RateLimitInfo> = vObject({
  limit: vNumber,
  remaining: vNumber,
  used: vNumber,
  reset: vString,
})

// Broker-shaped: identity

export const vHuman: Validator<Human> = vObject({
  id: vString,
  name: vString,
  role: vLiteral('contractor', 'lead'),
  email: vString,
})

export const vSession: Validator<Session> = vObject({
  human: vHuman,
  brokerLogin: vString,
  workspace: vString,
  viewerLogin: vOptional(vString),
})

export const vBrokerPullMeta: Validator<BrokerPullMeta> = vObject({
  authorHumanId: vNullable(vString),
  canApprove: vBoolean,
  unresolvedThreads: vNumber,
  assignedReviewerHumanIds: vArray(vString),
  compareKey: vString,
  commitCount: vNumber,
})

export const vPullListItem: Validator<PullListItem> = vObject({
  pull: vPullSummary,
  broker: vBrokerPullMeta,
})

export const vPullListResponse: Validator<PullListResponse> = vObject({
  items: vArray(vPullListItem),
  etag: vString,
  notModified: vBoolean,
  rateLimit: vRateLimitInfo,
})

// Broker-shaped: the snapshot

export const vFileBlob: Validator<FileBlob> = vObject({
  sha: vString,
  path: vString,
  content: vString,
  size: vNumber,
  binary: vBoolean,
})

export const vSnapshotImmutable: Validator<SnapshotImmutable> = vObject({
  compareKey: vString,
  mergeBaseSha: vString,
  headSha: vString,
  files: vArray(vPullFile),
  blobIndex: vRecord(vObject({ base: vNullable(vString), head: vNullable(vString) })),
  commits: vArray(vCommitInfo),
})

export const vSnapshotMutable: Validator<SnapshotMutable> = vObject({
  fetchedAt: vString,
  pull: vPullDetail,
  threads: vArray(vReviewThread),
  issueComments: vArray(vIssueComment),
  reviews: vArray(vReviewSummary),
  checks: vArray(vCheckRun),
  // Keys are comment ids. JSON object keys are always strings, so the wire
  // record is `Record<string, string>`; the declared type indexes by number
  // (the id) but the runtime keys are the string form of those ids.
  commentAuthors: vOptional(vRecord(vString)) as Validator<
    Record<number, string> | undefined
  >,
})

export const vSnapshot: Validator<Snapshot> = vObject({
  prNumber: vNumber,
  syncedAt: vString,
  partial: vNullable(
    vObject({ missingBlobShas: vArray(vString), reason: vString }),
  ),
  syncStats: vNullable(
    vObject({ blobsFetched: vNumber, blobsReused: vNumber, requests: vNumber }),
  ),
  immutable: vSnapshotImmutable,
  mutable: vSnapshotMutable,
})

// Broker-shaped: the draft

export const vPendingComment: Validator<PendingComment> = vObject({
  key: vString,
  path: vString,
  side: vLiteral('LEFT', 'RIGHT'),
  start_side: vNullable(vLiteral('LEFT', 'RIGHT')),
  line: vNumber,
  start_line: vNullable(vNumber),
  body: vString,
  createdAt: vString,
  updatedAt: vString,
  anchor: vObject({
    lineText: vString,
    contextBefore: vArray(vString),
    contextAfter: vArray(vString),
    startLineText: vOptional(vNullable(vString)),
  }),
})

export const vReviewDraft: Validator<ReviewDraft> = vObject({
  humanId: vString,
  prNumber: vNumber,
  headSha: vString,
  compareKey: vString,
  body: vString,
  event: vLiteral('COMMENT', 'APPROVE', 'REQUEST_CHANGES'),
  comments: vArray(vPendingComment),
  createdAt: vString,
  updatedAt: vString,
})

export const vFileViewedState: Validator<FileViewedState> = vRecord(
  vObject({ viewed: vBoolean, blobSha: vNullable(vString), at: vString }),
)

export const vHumanPreferences: Validator<HumanPreferences> = vObject({
  diffMode: vLiteral('unified', 'split'),
})

// Submit & reconcile

export const vSubmitReviewInput: Validator<SubmitReviewInput> = vObject({
  prNumber: vNumber,
  expectedHeadSha: vString,
  event: vLiteral('COMMENT', 'APPROVE', 'REQUEST_CHANGES'),
  body: vString,
  comments: vArray(vPendingComment),
})

export const vSubmitResult: Validator<SubmitResult> = vDiscriminatedUnion<SubmitResult>(
  'status',
  {
    ok: vObject({ status: vLiteral('ok'), review: vReviewSummary }),
    head_moved: vObject({
      status: vLiteral('head_moved'),
      currentHeadSha: vString,
      newCommits: vNumber,
    }),
    forbidden: vObject({ status: vLiteral('forbidden'), reason: vString }),
  },
)

export const vAnchorResult: Validator<AnchorResult> = vDiscriminatedUnion<AnchorResult>(
  'kind',
  {
    clean: vObject({ kind: vLiteral('clean'), comment: vPendingComment }),
    drifted: vObject({
      kind: vLiteral('drifted'),
      comment: vPendingComment,
      newLine: vNumber,
      newStartLine: vNullable(vNumber),
      delta: vNumber,
      startLineUncertain: vOptional(vBoolean),
    }),
    lost: vObject({
      kind: vLiteral('lost'),
      comment: vPendingComment,
      reason: vLiteral('line-deleted', 'file-deleted', 'file-renamed', 'file-added'),
    }),
  },
)

export const vReconcileReport: Validator<ReconcileReport> = vObject({
  prNumber: vNumber,
  draftHeadSha: vString,
  currentHeadSha: vString,
  newCommits: vArray(vCommitInfo),
  results: vArray(vAnchorResult),
})

// ————————————————————————————————————————————————————————————————
// Transport-level validators, keyed to the routes
// ————————————————————————————————————————————————————————————————

/** `syncPull` response body, and the seeded-snapshot fixtures. */
export const validateSnapshot: Validator<Snapshot> = vSnapshot

/** `getSnapshot` response body: a Snapshot, or JSON `null` for a never-synced PR. */
export const validateSnapshotResponse: Validator<Snapshot | null> = vNullable(vSnapshot)

/** `submitReview` response body — a tagged union, `head_moved` included. */
export const validateSubmitResult: Validator<SubmitResult> = vSubmitResult

/** `listPulls` response body. */
export const validatePullListResponse: Validator<PullListResponse> = vPullListResponse

/** `getSession` response body. */
export const validateSession: Validator<Session> = vSession

/** `listReviewThreads` response body. */
export const validateReviewThreads: Validator<ReviewThread[]> = vArray(vReviewThread)

/** `replyToThread` response body. */
export const validateReviewComment: Validator<ReviewComment> = vReviewComment

/** `addReaction` response body. */
export const validateReactionRollup: Validator<ReactionRollup> = vReactionRollup

/** `getBlob` response body. */
export const validateFileBlob: Validator<FileBlob> = vFileBlob

/**
 * A non-null draft body — the `saveDraft` request/response body and the payload
 * inside a non-null `getDraft` response. Never null; use `validateDraftResponse`
 * for the nullable `getDraft` response envelope.
 */
export const validateReviewDraft: Validator<ReviewDraft> = vReviewDraft

/**
 * `getDraft` response body: a `ReviewDraft`, or JSON `null` when the human has
 * no saved draft for this PR. Mirrors how `validateSnapshotResponse` wraps
 * `getSnapshot`'s null.
 */
export const validateDraftResponse: Validator<ReviewDraft | null> =
  vNullable(vReviewDraft)

/** `getFileViewed` / `setFileViewed` response body. */
export const validateFileViewedState: Validator<FileViewedState> = vFileViewedState

/** `getPreferences` / `setPreferences` response body. */
export const validateHumanPreferences: Validator<HumanPreferences> = vHumanPreferences

/** `reconcileDraft` response body. */
export const validateReconcileReport: Validator<ReconcileReport> = vReconcileReport

/** `getRateLimit` response body. */
export const validateRateLimitInfo: Validator<RateLimitInfo> = vRateLimitInfo

/** `resolveThread` response body. */
export const validateReviewThread: Validator<ReviewThread> = vReviewThread

// Request-body validators

/** `submitReview` request body. */
export const validateSubmitReviewInput: Validator<SubmitReviewInput> = vSubmitReviewInput

/** `replyToThread` request body. */
export const validateReplyBody: Validator<{ body: string }> = vObject({ body: vString })

/** `resolveThread` request body. */
export const validateResolveBody: Validator<{ resolved: boolean }> = vObject({
  resolved: vBoolean,
})

/** `addReaction` request body. */
export const validateReactionBody: Validator<{ reaction: ReactionKey }> = vObject({
  reaction: vReactionKey,
})

/** `setFileViewed` request body. */
export const validateSetViewedBody: Validator<{
  path: string
  viewed: boolean
  blobSha: string | null
}> = vObject({ path: vString, viewed: vBoolean, blobSha: vNullable(vString) })

/**
 * `setPreferences` request body — a partial `HumanPreferences` patch. Every
 * field is optional (the adapter merges the patch over the stored set), but any
 * field that IS present must satisfy its type.
 */
export const validateSetPreferencesBody: Validator<Partial<HumanPreferences>> =
  vObject({ diffMode: vOptional(vLiteral('unified', 'split')) })

// Error envelope validator

/**
 * The JSON body of an error response, mirroring `HttpErrorBody` exactly. Lets
 * the fetch adapter validate a `{ code, message, resetAt? }` body before handing
 * it to `apiErrorFromHttp`. Every `ApiErrorCode` value is accepted so the
 * validator mirrors the type; the "`network` never rides the wire" invariant is
 * enforced separately by `statusForApiError`.
 */
export const validateHttpErrorBody: Validator<HttpErrorBody> = vObject({
  code: vLiteral(
    'network',
    'rate_limited',
    'not_found',
    'forbidden',
    'conflict',
    'broker_unreachable',
    'persist_failed',
  ),
  message: vString,
  resetAt: vOptional(vString),
})

import type {
  CheckRun,
  CommitInfo,
  GhUser,
  IssueComment,
  PullDetail,
  PullFile,
  ReactionRollup,
  ReviewComment,
  ReviewSummary,
} from '@revu/shared'

/**
 * Mapping raw GitHub REST payloads onto the contract's GitHub-shaped types.
 *
 * The contract types were chosen to match real REST field names, so most of the
 * mapping is a structural narrowing: read the fields the app consumes, coerce the
 * few that need it, and drop the rest. Each mapper is total and defensive — a
 * missing optional field defaults to the contract's documented empty value rather
 * than throwing — so a slightly-lean response still produces a contract-valid
 * object. `patch` presence is preserved exactly: a file with no `patch`
 * (binary/oversize) is represented honestly with the field absent, never faked.
 */

/** A GitHub user object, narrowed to the fields the contract carries. Null when absent. */
export function mapUser(raw: unknown): GhUser | null {
  if (raw === null || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  if (typeof u.login !== 'string') return null
  const type = u.type
  const userType: GhUser['type'] =
    type === 'Bot' || type === 'Organization' ? type : 'User'
  return {
    login: u.login,
    id: typeof u.id === 'number' ? u.id : 0,
    node_id: typeof u.node_id === 'string' ? u.node_id : '',
    avatar_url: typeof u.avatar_url === 'string' ? u.avatar_url : '',
    html_url: typeof u.html_url === 'string' ? u.html_url : '',
    type: userType,
  }
}

/** A user that must be present (defaults to a blank `User` rather than null). */
function requireUser(raw: unknown): GhUser {
  return (
    mapUser(raw) ?? {
      login: '',
      id: 0,
      node_id: '',
      avatar_url: '',
      html_url: '',
      type: 'User',
    }
  )
}

/** A reaction rollup, defaulting every counter to zero when the field is absent. */
export function mapReactions(raw: unknown): ReactionRollup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0)
  return {
    url: typeof r.url === 'string' ? r.url : '',
    total_count: n('total_count'),
    '+1': n('+1'),
    '-1': n('-1'),
    laugh: n('laugh'),
    hooray: n('hooray'),
    confused: n('confused'),
    heart: n('heart'),
    rocket: n('rocket'),
    eyes: n('eyes'),
  }
}

/** Map raw `GET /pulls/{n}` onto `PullDetail`, folding in the derived `merge_base_sha`. */
export function mapPullDetail(raw: unknown, mergeBaseSha: string): PullDetail {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const ref = (side: 'head' | 'base'): PullDetail['head'] => {
    const s = (p[side] && typeof p[side] === 'object' ? p[side] : {}) as Record<string, unknown>
    const repo = (s.repo && typeof s.repo === 'object' ? s.repo : {}) as Record<string, unknown>
    return {
      ref: typeof s.ref === 'string' ? s.ref : '',
      sha: typeof s.sha === 'string' ? s.sha : '',
      label: typeof s.label === 'string' ? s.label : '',
      repo: {
        full_name: typeof repo.full_name === 'string' ? repo.full_name : '',
        default_branch:
          typeof repo.default_branch === 'string' ? repo.default_branch : '',
      },
    }
  }
  const state: PullDetail['state'] = p.state === 'closed' ? 'closed' : 'open'
  const mergeableState = p.mergeable_state
  const validMergeStates = ['clean', 'dirty', 'unstable', 'blocked', 'unknown'] as const
  const ms = validMergeStates.includes(mergeableState as (typeof validMergeStates)[number])
    ? (mergeableState as PullDetail['mergeable_state'])
    : 'unknown'
  const num = (k: string): number => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '')
  return {
    id: num('id'),
    node_id: str('node_id'),
    number: num('number'),
    state,
    draft: p.draft === true,
    merged_at: typeof p.merged_at === 'string' ? p.merged_at : null,
    title: str('title'),
    body: typeof p.body === 'string' ? p.body : null,
    user: requireUser(p.user),
    labels: Array.isArray(p.labels)
      ? (p.labels as unknown[]).map(mapLabel).filter((l): l is NonNullable<typeof l> => l !== null)
      : [],
    requested_reviewers: Array.isArray(p.requested_reviewers)
      ? (p.requested_reviewers as unknown[])
          .map(mapUser)
          .filter((u): u is GhUser => u !== null)
      : [],
    head: ref('head'),
    base: ref('base'),
    created_at: str('created_at'),
    updated_at: str('updated_at'),
    merged: p.merged === true,
    mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
    mergeable_state: ms,
    merge_base_sha: mergeBaseSha,
    comments: num('comments'),
    review_comments: num('review_comments'),
    commits: num('commits'),
    additions: num('additions'),
    deletions: num('deletions'),
    changed_files: num('changed_files'),
  }
}

function mapLabel(raw: unknown): PullDetail['labels'][number] | null {
  if (raw === null || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  if (typeof l.name !== 'string') return null
  return {
    id: typeof l.id === 'number' ? l.id : 0,
    name: l.name,
    color: typeof l.color === 'string' ? l.color : '',
    description: typeof l.description === 'string' ? l.description : null,
  }
}

/** Map one raw file entry from `GET /pulls/{n}/files` onto `PullFile`. */
export function mapPullFile(raw: unknown): PullFile {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const validStatus = ['added', 'modified', 'removed', 'renamed'] as const
  const status = validStatus.includes(f.status as (typeof validStatus)[number])
    ? (f.status as PullFile['status'])
    : 'modified'
  const file: PullFile = {
    sha: typeof f.sha === 'string' ? f.sha : '',
    filename: typeof f.filename === 'string' ? f.filename : '',
    status,
    additions: typeof f.additions === 'number' ? f.additions : 0,
    deletions: typeof f.deletions === 'number' ? f.deletions : 0,
    changes: typeof f.changes === 'number' ? f.changes : 0,
  }
  // `previous_filename` is present only for renames.
  if (typeof f.previous_filename === 'string') file.previous_filename = f.previous_filename
  // `patch` is ABSENT for binary/oversize files. Carry it only when GitHub sent
  // it, so "no patch" stays an honest signal of a binary/oversize file.
  if (typeof f.patch === 'string') file.patch = f.patch
  return file
}

/** Map one raw issue comment onto `IssueComment`. */
export function mapIssueComment(raw: unknown): IssueComment {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    id: typeof c.id === 'number' ? c.id : 0,
    node_id: typeof c.node_id === 'string' ? c.node_id : '',
    user: requireUser(c.user),
    body: typeof c.body === 'string' ? c.body : '',
    created_at: typeof c.created_at === 'string' ? c.created_at : '',
    updated_at: typeof c.updated_at === 'string' ? c.updated_at : '',
    reactions: mapReactions(c.reactions),
  }
}

/**
 * Map one raw REST review comment (`POST …/comments/{id}/replies`, `GET
 * …/pulls/comments/{id}`) onto the contract's `ReviewComment`. The reply and
 * single-comment REST endpoints already return the REST shape (unlike the
 * threads read, which comes from GraphQL and is normalized separately), so this
 * is a structural narrowing: read the fields the app consumes, coerce the enums,
 * default the rest. `in_reply_to_id` is carried ONLY when present, so a root
 * comment stays honestly without the field.
 */
export function mapReviewComment(raw: unknown): ReviewComment {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (k: string): number => (typeof c[k] === 'number' ? (c[k] as number) : 0)
  const str = (k: string): string => (typeof c[k] === 'string' ? (c[k] as string) : '')
  const nullableNum = (k: string): number | null =>
    typeof c[k] === 'number' ? (c[k] as number) : null
  const side: ReviewComment['side'] = c.side === 'LEFT' ? 'LEFT' : 'RIGHT'
  const startSide: ReviewComment['start_side'] =
    c.start_side === 'LEFT' || c.start_side === 'RIGHT' ? c.start_side : null
  const subjectType: ReviewComment['subject_type'] = c.subject_type === 'file' ? 'file' : 'line'
  const comment: ReviewComment = {
    id: num('id'),
    node_id: str('node_id'),
    pull_request_review_id:
      typeof c.pull_request_review_id === 'number' ? c.pull_request_review_id : null,
    path: str('path'),
    diff_hunk: str('diff_hunk'),
    commit_id: str('commit_id'),
    original_commit_id: str('original_commit_id'),
    line: nullableNum('line'),
    original_line: nullableNum('original_line'),
    start_line: nullableNum('start_line'),
    original_start_line: nullableNum('original_start_line'),
    side,
    start_side: startSide,
    subject_type: subjectType,
    user: requireUser(c.user),
    body: str('body'),
    created_at: str('created_at'),
    updated_at: str('updated_at'),
    reactions: mapReactions(c.reactions),
    html_url: str('html_url'),
  }
  if (typeof c.in_reply_to_id === 'number') comment.in_reply_to_id = c.in_reply_to_id
  return comment
}

/** Map one raw review onto `ReviewSummary`. */
export function mapReview(raw: unknown): ReviewSummary {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const validStates = [
    'COMMENTED',
    'APPROVED',
    'CHANGES_REQUESTED',
    'DISMISSED',
    'PENDING',
  ] as const
  const state = validStates.includes(r.state as (typeof validStates)[number])
    ? (r.state as ReviewSummary['state'])
    : 'COMMENTED'
  return {
    id: typeof r.id === 'number' ? r.id : 0,
    node_id: typeof r.node_id === 'string' ? r.node_id : '',
    user: requireUser(r.user),
    body: typeof r.body === 'string' ? r.body : '',
    state,
    submitted_at: typeof r.submitted_at === 'string' ? r.submitted_at : '',
    commit_id: typeof r.commit_id === 'string' ? r.commit_id : '',
  }
}

/** Map one raw commit onto `CommitInfo`. */
export function mapCommit(raw: unknown): CommitInfo {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const commit = (c.commit && typeof c.commit === 'object' ? c.commit : {}) as Record<
    string,
    unknown
  >
  const author = (commit.author && typeof commit.author === 'object'
    ? commit.author
    : {}) as Record<string, unknown>
  const parents = Array.isArray(c.parents) ? (c.parents as unknown[]) : []
  return {
    sha: typeof c.sha === 'string' ? c.sha : '',
    commit: {
      message: typeof commit.message === 'string' ? commit.message : '',
      author: {
        name: typeof author.name === 'string' ? author.name : '',
        email: typeof author.email === 'string' ? author.email : '',
        date: typeof author.date === 'string' ? author.date : '',
      },
    },
    author: mapUser(c.author),
    parents: parents.map((p) => {
      const parent = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
      return { sha: typeof parent.sha === 'string' ? parent.sha : '' }
    }),
  }
}

/** Map the `check_runs` array of `GET /commits/{sha}/check-runs` onto `CheckRun[]`. */
export function mapCheckRuns(raw: unknown): CheckRun[] {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const runs = Array.isArray(body.check_runs) ? (body.check_runs as unknown[]) : []
  return runs.map(mapCheckRun)
}

function mapCheckRun(raw: unknown): CheckRun {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const validStatus = ['queued', 'in_progress', 'completed'] as const
  const status = validStatus.includes(c.status as (typeof validStatus)[number])
    ? (c.status as CheckRun['status'])
    : 'completed'
  const validConclusions = [
    'success',
    'failure',
    'neutral',
    'cancelled',
    'timed_out',
    'skipped',
  ] as const
  const conclusion = validConclusions.includes(
    c.conclusion as (typeof validConclusions)[number],
  )
    ? (c.conclusion as CheckRun['conclusion'])
    : null
  const output = (c.output && typeof c.output === 'object' ? c.output : {}) as Record<
    string,
    unknown
  >
  return {
    id: typeof c.id === 'number' ? c.id : 0,
    name: typeof c.name === 'string' ? c.name : '',
    status,
    conclusion,
    started_at: typeof c.started_at === 'string' ? c.started_at : '',
    completed_at: typeof c.completed_at === 'string' ? c.completed_at : null,
    details_url: typeof c.details_url === 'string' ? c.details_url : '',
    output: {
      title: typeof output.title === 'string' ? output.title : null,
      summary: typeof output.summary === 'string' ? output.summary : null,
      ...(typeof output.text === 'string' ? { text: output.text } : {}),
    },
  }
}

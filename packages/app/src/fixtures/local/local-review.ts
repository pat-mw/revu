import type { PullDetail } from '@revu/shared'
import { LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import type { LocalReviewFixture, RemotePull } from '../contract'
import { DEFAULT_HUMAN_ID, HUMANS, REPO } from '../cast'
import { buildSnapshot, fakeSha, hoursAgo } from '../helpers'

/**
 * A local-only review the workspace already holds: `main ← release/0.41`,
 * reviewed before the release is tagged. It has no pull request, nothing about
 * it was ever pushed, and it is reachable with no network and no git — the
 * whole point of the feature, visible the moment the app loads.
 *
 * It is deliberately the state a review reaches by being CREATED and then
 * SYNCED, and nothing more exotic, because a fixture that describes a state
 * the workspace itself cannot produce is a second truth waiting to contradict
 * the first:
 *
 * - The ref tips are read the same deterministic way the workspace reads them,
 *   so the row derived from the live tips and this snapshot agree on the
 *   compare key. Hand-spelled SHAs would make the review open as permanently
 *   stale and be emptied by the first re-sync.
 * - The compare is empty — merge base IS the head tip, no files, no commits.
 *   No git objects stand behind a branch pair here, and "head has no commits
 *   ahead of base" is an already-legal review that renders as an empty one.
 * - Checks, issue comments and submitted reviews are all empty: nothing
 *   reports on an unpushed branch, there are no issue comments without an
 *   issue, and a submitted local verdict is kept on the review's own record.
 * - The author is the sentinel local reviewer — a display NAME, `type: 'Bot'`,
 *   no avatar or profile to link to, and never an email. There is no GitHub
 *   account behind a local review to attribute anything to.
 */

const ID = LOCAL_REVIEW_ID_BASE + 1

const BASE_NAME = REPO.default_branch
const HEAD_NAME = 'release/0.41'
const BASE_REF = `refs/heads/${BASE_NAME}`
const HEAD_REF = `refs/heads/${HEAD_NAME}`
const TITLE = 'Pre-tag review of release/0.41'

const CREATED_AT = hoursAgo(6)
const SYNCED_AT = hoursAgo(5)

/**
 * The tip of a ref, as this repository's stand-in for `git rev-parse`:
 * deterministic per `(repo, ref)`, so the tip a snapshot recorded is the tip
 * read back later and the content-addressed compare key stays stable.
 */
function refTip(ref: string): string {
  return fakeSha(`local:${REPO.full_name}:${ref}`)
}

const HEAD_SHA = refTip(HEAD_REF)
const BASE_SHA = refTip(BASE_REF)
const MERGE_BASE_SHA = HEAD_SHA

const REVIEWER_NAME = (HUMANS.find((h) => h.id === DEFAULT_HUMAN_ID) ?? HUMANS[0]).name

/**
 * The GitHub-shaped pull a local review presents so every surface downstream
 * of a snapshot works unchanged. Identity is the local id throughout, the
 * branch pair carries the real names and tips, mergeability is unknown because
 * nothing computes it locally, and every count is derived from what the review
 * actually holds.
 */
const detail: PullDetail = {
  id: ID,
  node_id: `local:${ID}`,
  number: ID,
  state: 'open',
  draft: false,
  merged_at: null,
  title: TITLE,
  body: null,
  user: {
    login: REVIEWER_NAME,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  },
  labels: [],
  requested_reviewers: [],
  head: {
    ref: HEAD_NAME,
    sha: HEAD_SHA,
    // No fork namespace exists locally, so the label is just the branch name.
    label: HEAD_NAME,
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  base: {
    ref: BASE_NAME,
    sha: BASE_SHA,
    label: BASE_NAME,
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  created_at: CREATED_AT,
  updated_at: SYNCED_AT,
  merged: false,
  mergeable: null,
  mergeable_state: 'unknown',
  merge_base_sha: MERGE_BASE_SHA,
  comments: 0,
  review_comments: 0,
  commits: 0,
  additions: 0,
  deletions: 0,
  changed_files: 0,
}

/**
 * The review's content in the vocabulary the snapshot assembler reads. That
 * vocabulary is named for the remote side because every other fixture has one;
 * this review does not, and nothing here claims otherwise — it is assembled by
 * the same helper so a local snapshot and a pull's snapshot are the same kind
 * of object rather than two hand-rolled shapes that drift.
 */
const source: RemotePull = {
  detail,
  files: [],
  blobs: [],
  blobIndex: {},
  threads: [],
  issueComments: [],
  reviews: [],
  checks: [],
  commits: [],
  broker: {
    // No pull request was opened, so no human drove an App identity to open
    // one; every verdict stays available because GitHub's refusal to let an
    // App review its own pull request has no local counterpart.
    authorHumanId: null,
    canApprove: true,
    unresolvedThreads: 0,
    assignedReviewerHumanIds: [],
    compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    commitCount: 0,
  },
}

export const localReview: LocalReviewFixture = {
  id: ID,
  baseRef: BASE_REF,
  headRef: HEAD_REF,
  title: TITLE,
  createdAt: CREATED_AT,
  updatedAt: SYNCED_AT,
  snapshot: buildSnapshot(source, SYNCED_AT, {
    // A local sync reads the workspace's own refs: nothing transferred,
    // nothing requested of anything, nothing charged to any budget.
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 0 },
  }),
}

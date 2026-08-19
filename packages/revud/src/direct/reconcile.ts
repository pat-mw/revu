import type {
  AnchorResult,
  CommitInfo,
  FileBlob,
  ReconcileReport,
  ReviewDraft,
  Snapshot,
} from '@revu/shared'
import { ApiError, blobContentToLines, classifyPendingComment } from '@revu/shared'

/**
 * Draft reconcile — the crown-jewel read path. After a force-push (or a base
 * advance) moves the compare and the client re-syncs, this classifies every
 * pending comment in the draft against the FRESH snapshot: `clean`, `drifted`,
 * or `lost`. It is a PURE READ of snapshot + draft state — nothing is written,
 * the draft is untouched — so a human can run it repeatedly to preview where
 * their comments landed before committing to a resubmit.
 *
 * The classification is NOT written here. It is the shared `classifyPendingComment`
 * from `@revu/shared`, the IDENTICAL function the reconcile dialog previews with.
 * The side-aware blob selection (base blob for a LEFT anchor, head blob for a
 * RIGHT anchor) and the `clean` fast-path context-score floor both live inside
 * that shared function; this module only supplies the freshly-synced files,
 * `blobIndex`, and a blob-line resolver over the content-addressed store. Sharing
 * the one classifier is what makes a divergence between the preview and this
 * report structurally impossible.
 */

/**
 * The three reads reconcile makes, and nothing wider.
 *
 * Stated as its own interface rather than as the whole durable store because
 * this is a PURE READ path: a surface that cannot write cannot be the thing that
 * mutates a draft while classifying it. It is also what lets a caller whose
 * documents live in a different keyspace — a review of a local branch pair,
 * whose drafts and snapshots are keyed in tables of their own — reach the same
 * classifier through an adapter, so the one classification stays shared instead
 * of being reimplemented per keyspace. The durable store satisfies this
 * structurally, so nothing that passes it today has to change.
 *
 * The number identifying a review is whatever the calling keyspace uses for it,
 * and it is passed through unread: nothing here parses or compares it.
 */
export interface ReconcileStore {
  /** One human's draft on one review, or `null` when they have none on it. */
  getDraft(humanId: string, prNumber: number): ReviewDraft | null
  /** The stored snapshot of one review, or `null` when it has never been synced. */
  getSnapshot(prNumber: number): Snapshot | null
  /** One blob from the content-addressed cache, or `null` when it is absent. */
  getBlob(sha: string): FileBlob | null
}

/** Everything reconcile reads from, injected so the core is unit-testable with fakes. */
export interface ReconcileDeps {
  store: ReconcileStore
  /** The session's human id — the draft is read for THIS human, never a client-supplied id. */
  humanId: string
}

/**
 * Classify a draft's pending comments against the freshly-synced snapshot.
 *
 * Preconditions, surfaced as typed `not_found` errors (matching the mock oracle
 * so both transports answer identically):
 *   - No draft for this human + PR: there is nothing to reconcile.
 *   - No local snapshot: the PR must be synced before its draft can be reconciled
 *     against the current diff.
 *
 * Each comment is classified through the shared `classifyPendingComment`, which
 * selects the anchoring side's blob (base for LEFT, head for RIGHT) and resolves
 * its lines through the callback below. A blob that is absent from the store or
 * binary resolves to `null`, which the classifier reads as "no content to match".
 */
export function reconcileDraft(deps: ReconcileDeps, prNumber: number): ReconcileReport {
  const { store, humanId } = deps

  const draft = store.getDraft(humanId, prNumber)
  if (!draft) {
    throw new ApiError(
      'not_found',
      `No draft exists for pull #${prNumber} — there is nothing to reconcile.`,
    )
  }
  const snap = store.getSnapshot(prNumber)
  if (!snap) {
    throw new ApiError(
      'not_found',
      `Pull #${prNumber} has no local snapshot — sync it before reconciling.`,
    )
  }
  const { files, blobIndex, commits, headSha } = snap.immutable

  // Each comment is classified against the side its anchor lives on (base for
  // LEFT, head for RIGHT), resolving blob lines from the content-addressed
  // store. This is the SAME shared decision the reconcile dialog previews with,
  // so a preview and this report can never disagree — the blob-side selection
  // and the clean-path context floor both live inside `classifyPendingComment`,
  // and this path never re-implements or bypasses either.
  const results: AnchorResult[] = draft.comments.map((c) =>
    classifyPendingComment({
      comment: c,
      files,
      blobIndex,
      resolveBlobLines: (sha) => {
        const blob = store.getBlob(sha)
        return blob && !blob.binary ? blobContentToLines(blob.content) : null
      },
    }),
  )

  // Commits that landed after the draft was written — the ones a force-push or a
  // base advance added.
  //
  // When the draft's head is still in the fresh base→head list, the answer is
  // exact: slice everything after it.
  //
  // When it is absent, the branch was rewritten and the head this draft was
  // written against exists nowhere in the compare any more. Every commit now in
  // the range is new relative to a head that is gone, so the whole list is the
  // answer. The alternative — keeping commits whose author date postdates the
  // draft — under-reports by construction, because a rebase rewrites committer
  // dates and PRESERVES author dates: every rewritten commit keeps a date older
  // than the draft, and the filter yields nothing on precisely the rewrite that
  // moved the most work. The count is what the UI communicates as "N new
  // commits", and zero is the one answer a rewrite must never produce.
  const draftHeadIndex = commits.findIndex((c) => c.sha === draft.headSha)
  const newCommits: CommitInfo[] =
    draftHeadIndex >= 0 ? commits.slice(draftHeadIndex + 1) : [...commits]

  return {
    prNumber,
    draftHeadSha: draft.headSha,
    currentHeadSha: headSha,
    newCommits,
    results,
  }
}

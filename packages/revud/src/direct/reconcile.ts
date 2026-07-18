import type {
  AnchorResult,
  CommitInfo,
  ReconcileReport,
} from '@revu/shared'
import { ApiError, blobContentToLines, classifyPendingComment } from '@revu/shared'
import type { DirectStore } from './store'

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

/** Everything reconcile reads from, injected so the core is unit-testable with fakes. */
export interface ReconcileDeps {
  store: DirectStore
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

  // Commits that landed after the draft was written — the ones the force-push /
  // base-advance added. Preferred: find the draft's head in the fresh snapshot's
  // base→head commit list and slice everything after it. When the draft's head
  // predates the whole list (it fell out of the rewritten compare entirely),
  // approximate by author date newer than the draft's creation. Matches the mock
  // oracle's semantics exactly (`src/api/mock/adapter.ts` reconcileDraft); the
  // count is what the UI communicates as "N new commits".
  const draftHeadIndex = commits.findIndex((c) => c.sha === draft.headSha)
  const newCommits: CommitInfo[] =
    draftHeadIndex >= 0
      ? commits.slice(draftHeadIndex + 1)
      : commits.filter((c) => c.commit.author.date > draft.createdAt)

  return {
    prNumber,
    draftHeadSha: draft.headSha,
    currentHeadSha: headSha,
    newCommits,
    results,
  }
}

import type { AnchorResult, PendingComment, ReviewDraft } from '@revu/shared'
import { selectAnchorBlobSha } from '@revu/shared'
import type { DraftHead } from '@/state/drafts'

/**
 * What applying a reconcile does to a draft, computed as a value before
 * anything is written.
 *
 * The reconcile dialog's Apply used to do this inline: walk the draft's
 * comments, consult each row's decision, re-capture the anchors that moved, and
 * mutate the draft as it went. That shape has two problems. It is unreachable
 * from a test — the loop closes over a query client, two mutations and a toast,
 * and this package has no DOM runner to stand those up in. And it writes as it
 * computes, so a blob that fails to load halfway through leaves a draft with
 * some comments re-anchored against the new head and the rest still describing
 * the old one.
 *
 * Both go away by separating the two jobs. Everything here is a pure function
 * of its inputs: the decisions, the report's classifications, and a callback
 * that hands back a blob's lines. Nothing is written, nothing is deleted, and
 * the whole plan — including the head the draft must move to — exists before
 * the first mutation. A resolver that throws therefore leaves the draft exactly
 * as it was rather than half-converted.
 */

/**
 * The per-comment verdict a human hands down in the reconcile dialog. Every
 * comment in the report must carry one before Apply enables:
 *
 * - `keep`     — clean rows, pre-decided: the anchor line is untouched.
 * - `accept`   — take the drifted anchor's suggested new line.
 * - `reanchor` — pin the comment to an explicitly chosen line on the new head.
 * - `drop`     — remove the comment from the draft (reversible until Apply).
 */
export type ReconcileDecision =
  | { kind: 'keep' }
  | { kind: 'accept' }
  | { kind: 'reanchor'; line: number }
  | { kind: 'drop' }

/**
 * The separator joining the two halves of a compare key. One spelling,
 * everywhere: content is cached under the whole string, so a two-dot or
 * hyphenated variant would fork the cache invisibly.
 */
const COMPARE_SEPARATOR = '...'

/**
 * The head pair to move a draft onto, or `null` when the two halves on hand do
 * not describe the same commit.
 *
 * The hazard this exists for: the head SHA and the compare key reach the
 * reconcile dialog from two different places. The SHA is the reconcile report's
 * `currentHeadSha`, produced by the classification pass. The compare key comes
 * off the loaded snapshot, which is a query result that is simply absent while
 * it settles — and which, on the tick after a sync, can still be the previous
 * compare. There is no third source to fall back on: a compare key is
 * `mergeBaseSha...headSha`, the report carries no merge base, and inventing one
 * from the head alone would produce a key that indexes nothing.
 *
 * So the two are checked against each other rather than trusted: a key whose
 * right-hand side is not exactly this head is not a pair, and the answer is
 * "no pair" rather than a document stitched from two different compares. That
 * refusal is the conservative one. Declining to move the head leaves a draft
 * whose recorded head is behind its comments — the state this module exists to
 * prevent, and a loud one, because a head absent from the compare makes the
 * next reconcile report the entire branch as new. Writing a MISMATCHED pair is
 * worse and quieter: the two fields then disagree with each other permanently,
 * every consumer that reads one contradicts every consumer that reads the
 * other, and no later sync repairs it because nothing knows it is wrong.
 */
export function coherentDraftHead(
  headSha: string,
  compareKey: string | null | undefined,
): DraftHead | null {
  if (headSha.length === 0) return null
  if (compareKey === null || compareKey === undefined || compareKey.length === 0) return null
  if (!compareKey.endsWith(`${COMPARE_SEPARATOR}${headSha}`)) return null
  return { headSha, compareKey }
}

/**
 * Re-capture an anchor at `line` (1-based) from blob content: the exact line
 * text plus up to three neighbors each side, in file order — the last element
 * of `contextBefore` is the line immediately above, the first element of
 * `contextAfter` is the line immediately below. When the comment spans a range,
 * `startLine` re-captures the range's START line text so the next reconcile can
 * validate the start independently; it stays null for a single-line comment.
 */
function captureAnchor(
  lines: string[],
  line: number,
  startLine: number | null,
): PendingComment['anchor'] {
  return {
    lineText: lines[line - 1] ?? '',
    contextBefore: lines.slice(Math.max(0, line - 4), Math.max(0, line - 1)),
    contextAfter: lines.slice(line, line + 3),
    startLineText: startLine !== null ? (lines[startLine - 1] ?? '') : null,
  }
}

/** Everything the plan reads. Nothing here is written to. */
export interface ReconcilePlanInput {
  /** The draft as it stands — the comment list this plan is computed over. */
  draft: ReviewDraft
  /** The report's classifications, matched to comments by their local key. */
  results: AnchorResult[]
  /** One verdict per comment key; a key with no verdict is carried untouched. */
  decisions: Record<string, ReconcileDecision | undefined>
  /**
   * The freshly synced compare's per-path blob SHAs, used through the shared
   * side selector so a re-captured anchor reads the SAME content the report
   * classified against. Undefined while the snapshot is unread, which yields
   * empty lines and therefore an empty re-captured anchor — the same
   * degradation the dialog's own rows show.
   */
  blobIndex: Record<string, { base: string | null; head: string | null }> | undefined
  /** The head the branch is on now, per the reconcile report. */
  currentHeadSha: string
  /** The freshly synced compare key, or absent while the snapshot is unread. */
  currentCompareKey: string | null | undefined
  /**
   * Lines of the blob at `blobSha`, or `null` when it is missing or binary —
   * the same resolver shape the classification pass takes. Injected so this
   * function needs no cache, no query client and no network: a caller in a test
   * hands over a map, and the dialog hands over its blob fetch.
   */
  resolveLines: (blobSha: string) => string[] | null | Promise<string[] | null>
}

/** Everything applying the decisions will do, as data. */
export interface ReconcilePlan {
  /**
   * The full comment list to submit: every comment that survives, in the
   * draft's original order, with re-anchored ones already rewritten.
   */
  updated: PendingComment[]
  /**
   * The subset of `updated` this plan actually rewrote — exactly the comments
   * to write back to the draft.
   *
   * Carried separately rather than left to the caller to re-derive, because the
   * only cheap way to re-derive it is to write back all of `updated`, and doing
   * that stamps a fresh `updatedAt` on comments nothing touched. A comment the
   * human decided to keep unchanged must not come out of a reconcile looking
   * edited.
   */
  reanchored: PendingComment[]
  /** The local keys of the comments to remove — the dropped ones, and only those. */
  removedKeys: string[]
  /** How many comments survive. Reported to the human after the submit lands. */
  kept: number
  /** How many were dropped. Reported alongside `kept`. */
  dropped: number
  /**
   * The head to move the draft onto — the FRESHLY SYNCED pair, never the
   * draft's own, because the comments in `updated` were re-anchored against
   * that compare and the draft's recorded head must describe the same one.
   *
   * `null` when the pair could not be formed coherently; the caller then leaves
   * the draft's head alone rather than writing halves of two different
   * compares. See `coherentDraftHead`.
   */
  nextHead: DraftHead | null
}

/**
 * Work out what applying the reconcile decisions does, without doing any of it.
 *
 * Per comment, in the draft's own order:
 *
 * - No decision and no classification — the comment was written after the
 *   report was generated. It is carried along untouched: it anchors against
 *   content this reconcile never looked at, and silently dropping or rewriting
 *   it would lose text the human is still holding.
 * - `drop` — its key joins `removedKeys` and it leaves `updated`.
 * - `keep` — carried across byte for byte, including its captured anchor.
 * - `accept` — takes the drifted classification's suggested line and start
 *   line. A row that is not drifted has nothing to suggest, so the comment's
 *   own position stands.
 * - `reanchor` — moves to the chosen line, and a ranged comment's start line
 *   moves by the same delta (floored at line 1) so the span keeps its length.
 *
 * Both moving decisions then re-capture the anchor from the NEW head's content,
 * so the stored anchor describes where the comment now sits rather than where
 * it used to. A blob that cannot be resolved yields no lines and therefore an
 * empty anchor rather than a failure: the comment's text is never at risk, and
 * the next reconcile re-classifies it from scratch.
 */
export async function planReconcileApply(
  input: ReconcilePlanInput,
): Promise<ReconcilePlan> {
  const {
    draft,
    results,
    decisions,
    blobIndex,
    currentHeadSha,
    currentCompareKey,
    resolveLines,
  } = input

  const updated: PendingComment[] = []
  const reanchored: PendingComment[] = []
  const removedKeys: string[] = []

  for (const comment of draft.comments) {
    const decision = decisions[comment.key]
    const result = results.find((r) => r.comment.key === comment.key)
    if (!decision || !result) {
      // Written after this report was generated — carried along untouched.
      updated.push(comment)
      continue
    }
    if (decision.kind === 'drop') {
      removedKeys.push(comment.key)
      continue
    }
    if (decision.kind === 'keep') {
      updated.push(comment)
      continue
    }
    const newLine =
      decision.kind === 'accept'
        ? result.kind === 'drifted'
          ? result.newLine
          : comment.line
        : decision.line
    const newStartLine =
      decision.kind === 'accept'
        ? result.kind === 'drifted'
          ? result.newStartLine
          : comment.start_line
        : comment.start_line !== null
          ? Math.max(1, comment.start_line + (decision.line - comment.line))
          : null
    const sha = selectAnchorBlobSha(blobIndex?.[comment.path], comment.side)
    const lines = sha !== null ? ((await resolveLines(sha)) ?? []) : []
    const next: PendingComment = {
      ...comment,
      line: newLine,
      start_line: newStartLine,
      anchor: captureAnchor(lines, newLine, newStartLine),
      updatedAt: new Date().toISOString(),
    }
    reanchored.push(next)
    updated.push(next)
  }

  return {
    updated,
    reanchored,
    removedKeys,
    kept: updated.length,
    dropped: removedKeys.length,
    nextHead: coherentDraftHead(currentHeadSha, currentCompareKey),
  }
}

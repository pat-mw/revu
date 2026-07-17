/**
 * Draft-comment re-anchoring. When the PR head moves after a draft comment
 * was written, the comment's captured anchor (its line's text plus up to
 * three context lines on each side) is matched against the fresh head blob
 * to decide whether the comment is still `clean`, has `drifted` to a new
 * line, or is `lost`. Pure functions, no I/O.
 *
 * All line-text comparisons tolerate trailing-whitespace-only differences
 * (`trimEnd`) so a formatter pass that strips trailing spaces does not orphan
 * a draft.
 */

import type { AnchorResult, PendingComment } from '@/api/types'

/** Whether the file the comment targets still exists under its original path. */
export type FilePresence = 'present' | 'deleted' | 'renamed'

/** How far (in lines, each direction) a drifted anchor is searched for. */
const SEARCH_RADIUS = 400

/** Context lines consulted on each side when scoring drift candidates. */
const CONTEXT_DEPTH = 3

/** Trailing-whitespace-tolerant equality; undefined never matches. */
function lineEq(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return a.trimEnd() === b.trimEnd()
}

/**
 * Scores how well the file neighborhood around `idx` (0-based) matches the
 * comment's captured context. Anchor context is stored in file order:
 * `contextBefore`'s LAST element is the line immediately above the anchor,
 * `contextAfter`'s FIRST element is the line immediately below. Closer lines
 * weigh more (adjacent 3, next 2, outermost 1; max score 12 with full
 * three-line context on both sides). A mismatch at one offset does not stop
 * scoring farther offsets — an inserted line near the anchor should not
 * erase the credit from the rest of the neighborhood.
 */
function contextScore(
  anchor: PendingComment['anchor'],
  lines: string[],
  idx: number,
): number {
  let score = 0
  const before = anchor.contextBefore
  const after = anchor.contextAfter
  for (let j = 1; j <= CONTEXT_DEPTH; j++) {
    const weight = CONTEXT_DEPTH + 1 - j
    const expectedBefore = before[before.length - j]
    if (expectedBefore !== undefined && lineEq(lines[idx - j], expectedBefore)) {
      score += weight
    }
    const expectedAfter = after[j - 1]
    if (expectedAfter !== undefined && lineEq(lines[idx + j], expectedAfter)) {
      score += weight
    }
  }
  return score
}

/**
 * Classifies one pending comment against the current head content of its
 * file:
 *
 * - `filePresence` of 'deleted' / 'renamed' is terminal: the anchor's line
 *   numbers are meaningless under a missing or moved path, so the comment is
 *   `lost` with the corresponding reason before any text matching runs.
 * - If the line at the comment's original position (`comment.line`, 1-based)
 *   still equals `anchor.lineText`, the comment is `clean`.
 * - Otherwise every line within ±400 of the original position that equals
 *   `anchor.lineText` is a drift candidate. Candidates are ranked by context
 *   score (see `contextScore`); ties break toward the smallest |delta|, and
 *   a full tie keeps the earliest (lowest line number) candidate. The winner
 *   yields `drifted` with `newLine`, a shifted `newStartLine` when the
 *   comment spans a range, and the signed `delta`.
 * - No candidate in the window — including the cases where the head content
 *   is unavailable (`newHeadLines` null) or the file is now empty — means
 *   `lost` with reason 'line-deleted'.
 */
export function classifyAnchor(args: {
  comment: PendingComment
  newHeadLines: string[] | null
  filePresence: FilePresence
}): AnchorResult {
  const { comment, newHeadLines, filePresence } = args

  if (filePresence === 'deleted') {
    return { kind: 'lost', comment, reason: 'file-deleted' }
  }
  if (filePresence === 'renamed') {
    return { kind: 'lost', comment, reason: 'file-renamed' }
  }
  if (newHeadLines === null || newHeadLines.length === 0) {
    return { kind: 'lost', comment, reason: 'line-deleted' }
  }

  const target = comment.anchor.lineText
  const originalIdx = comment.line - 1

  if (lineEq(newHeadLines[originalIdx], target)) {
    return { kind: 'clean', comment }
  }

  const lo = Math.max(0, originalIdx - SEARCH_RADIUS)
  const hi = Math.min(newHeadLines.length - 1, originalIdx + SEARCH_RADIUS)
  let best: { idx: number; score: number; absDelta: number } | null = null
  for (let i = lo; i <= hi; i++) {
    if (!lineEq(newHeadLines[i], target)) continue
    const score = contextScore(comment.anchor, newHeadLines, i)
    const absDelta = Math.abs(i - originalIdx)
    if (
      best === null ||
      score > best.score ||
      (score === best.score && absDelta < best.absDelta)
    ) {
      best = { idx: i, score, absDelta }
    }
  }

  if (best === null) {
    return { kind: 'lost', comment, reason: 'line-deleted' }
  }

  const newLine = best.idx + 1
  const delta = newLine - comment.line
  return {
    kind: 'drifted',
    comment,
    newLine,
    newStartLine: comment.start_line !== null ? comment.start_line + delta : null,
    delta,
  }
}

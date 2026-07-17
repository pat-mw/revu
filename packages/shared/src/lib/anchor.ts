/**
 * Draft-comment re-anchoring. When the PR head moves after a draft comment
 * was written, the comment's captured anchor (its line's text plus up to
 * three context lines on each side) is matched against the fresh blob on the
 * side the comment lives on to decide whether the comment is still `clean`,
 * has `drifted` to a new line, or is `lost`. Pure functions, no I/O.
 *
 * A comment's `side` picks which blob its anchor text lives in: RIGHT-side
 * comments annotate added/context lines in the head blob; LEFT-side comments
 * annotate deleted lines whose text lives only in the base blob. The rule
 * "LEFT reads base, RIGHT reads head" is encoded ONCE here (`anchorSideKey`)
 * and consumed everywhere a blob must be chosen for a comment, so a preview
 * and a server-side report can never disagree about which content to match.
 *
 * All line-text comparisons tolerate trailing-whitespace-only differences
 * (`trimEnd`) so a formatter pass that strips trailing spaces does not orphan
 * a draft.
 */

import type { AnchorResult, PendingComment, PullFile } from '../api/types'

/**
 * The fate of the file a comment targets, on the side its anchor lives on:
 *
 * - `present`  — the anchoring side still holds the file; run text matching.
 * - `deleted`  — the file is gone from the anchoring side (a removed file on
 *   the RIGHT/head side, or an absent path with no blob on the anchoring
 *   side): the anchor's line numbers are meaningless.
 * - `renamed`  — the path moved; the old line numbers do not carry across.
 * - `added`    — the file did not exist on this side yet (a LEFT/base anchor
 *   into a file first introduced by the PR): there is no base content to
 *   match, distinct from a deletion so the human sees a truthful reason.
 */
export type FilePresence = 'present' | 'deleted' | 'renamed' | 'added'

/** How far (in lines, each direction) a drifted anchor is searched for. */
const SEARCH_RADIUS = 400

/** Context lines consulted on each side when scoring drift candidates. */
const CONTEXT_DEPTH = 3

/**
 * Minimum surrounding-context agreement the original index must show before a
 * comment is trusted as `clean` without a drift search. `contextScore` awards
 * 3/2/1 for the nearest/next/outermost neighbor on each side (max 12); this
 * floor of 2 is met by a single adjacent neighbor matching, or by the two
 * next-out neighbors. The floor exists because an unmoved line and a
 * coincidentally-identical line at the same index are indistinguishable from
 * the anchor text alone: on a repeated token (`}`, a blank line, `return
 * null`, a bare import) code can shift underneath the anchor while an
 * unrelated identical line occupies the old index, and a text-only `clean`
 * would silently re-point the comment at that unrelated code with no human in
 * the loop. Below the floor the comment is demoted to the drift search, where
 * every occurrence in the window is ranked by context and the distance
 * tie-break favors the original position — so a genuinely-unmoved line with
 * intact context still resolves to `drifted` at `delta: 0` and reads as
 * unmoved, while a line whose neighborhood changed is offered to the human
 * for confirmation. A single-occurrence anchor with weak context still
 * short-circuits cheaply below, before any scoring runs.
 */
const CLEAN_CONTEXT_FLOOR = 2

/** Trailing-whitespace-tolerant equality; undefined never matches. */
function lineEq(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return a.trimEnd() === b.trimEnd()
}

/**
 * The `blobIndex` side a comment's anchor text lives on: LEFT-side comments
 * annotate deleted lines held only in the base blob; RIGHT-side comments
 * annotate lines present in the head blob. This is the single definition of
 * that mapping — resolve every anchor blob through it so a client preview and
 * a server report choose the same content.
 */
export function anchorSideKey(side: PendingComment['side']): 'base' | 'head' {
  return side === 'LEFT' ? 'base' : 'head'
}

/**
 * The blob SHA a comment's anchor text lives in, given the `blobIndex` entry
 * for its path (SHAs on each side, `null` when the file is absent on that
 * side). Returns `null` when there is no entry or no blob on the chosen side.
 */
export function selectAnchorBlobSha(
  entry: { base: string | null; head: string | null } | undefined,
  side: PendingComment['side'],
): string | null {
  if (!entry) return null
  return entry[anchorSideKey(side)]
}

/**
 * Splits blob content into lines the way git counts them: a trailing newline
 * terminates the last line rather than opening a phantom empty one, so
 * `"a\nb\n"` → `['a', 'b']` and `""` → `[]` (a zero-line file). Anchor line
 * numbers are 1-based into this array, so a preview and a report MUST split
 * the same way or their indices diverge by one on any newline-terminated file.
 */
export function blobContentToLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
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

/** Whether `lineText` occurs more than once within the drift search window. */
function isDuplicatedInWindow(
  lines: string[],
  target: string,
  originalIdx: number,
): boolean {
  const lo = Math.max(0, originalIdx - SEARCH_RADIUS)
  const hi = Math.min(lines.length - 1, originalIdx + SEARCH_RADIUS)
  let seen = 0
  for (let i = lo; i <= hi; i++) {
    if (lineEq(lines[i], target)) {
      seen++
      if (seen > 1) return true
    }
  }
  return false
}

/**
 * Classifies one pending comment against the current content of the side its
 * anchor lives on (`newAnchorLines` — head lines for a RIGHT-side comment,
 * base lines for a LEFT-side comment; the caller is responsible for having
 * chosen the correct side, which the parameter name enforces):
 *
 * - `filePresence` of 'deleted' / 'renamed' / 'added' is terminal: the
 *   anchor's line numbers are meaningless under a missing, moved, or
 *   not-yet-existing path, so the comment is `lost` with the corresponding
 *   reason before any text matching runs.
 * - If the line at the comment's original position (`comment.line`, 1-based)
 *   still equals `anchor.lineText` AND its surrounding context clears
 *   `CLEAN_CONTEXT_FLOOR` (or the anchor text is unique in the search window,
 *   so no other line could be confused for it), the comment is `clean`.
 * - Otherwise every line within ±400 of the original position that equals
 *   `anchor.lineText` is a drift candidate. Candidates are ranked by context
 *   score (see `contextScore`); ties break toward the smallest |delta|, and
 *   a full tie keeps the earliest (lowest line number) candidate. The winner
 *   yields `drifted` with `newLine`, a shifted `newStartLine` when the
 *   comment spans a range, and the signed `delta`. A genuinely-unmoved line
 *   that failed the clean floor only because its neighborhood also changed
 *   wins its own comparison at `delta: 0`.
 * - No candidate in the window — including the cases where the anchor content
 *   is unavailable (`newAnchorLines` null) or the file is now empty — means
 *   `lost` with reason 'line-deleted'.
 */
export function classifyAnchor(args: {
  comment: PendingComment
  newAnchorLines: string[] | null
  filePresence: FilePresence
}): AnchorResult {
  const { comment, newAnchorLines, filePresence } = args

  if (filePresence === 'deleted') {
    return { kind: 'lost', comment, reason: 'file-deleted' }
  }
  if (filePresence === 'renamed') {
    return { kind: 'lost', comment, reason: 'file-renamed' }
  }
  if (filePresence === 'added') {
    return { kind: 'lost', comment, reason: 'file-added' }
  }
  if (newAnchorLines === null || newAnchorLines.length === 0) {
    return { kind: 'lost', comment, reason: 'line-deleted' }
  }

  const target = comment.anchor.lineText
  const originalIdx = comment.line - 1

  if (lineEq(newAnchorLines[originalIdx], target)) {
    // A unique anchor cannot be confused with any other line, so it stays
    // clean cheaply — no scoring, no regression for the common unmoved case.
    // A repeated anchor must additionally prove intact surrounding context;
    // without it, a coincidental identical line at the old index could pass
    // for the original, so demote to the ranked drift search below.
    if (
      contextScore(comment.anchor, newAnchorLines, originalIdx) >= CLEAN_CONTEXT_FLOOR ||
      !isDuplicatedInWindow(newAnchorLines, target, originalIdx)
    ) {
      return { kind: 'clean', comment }
    }
  }

  const lo = Math.max(0, originalIdx - SEARCH_RADIUS)
  const hi = Math.min(newAnchorLines.length - 1, originalIdx + SEARCH_RADIUS)
  let best: { idx: number; score: number; absDelta: number } | null = null
  for (let i = lo; i <= hi; i++) {
    if (!lineEq(newAnchorLines[i], target)) continue
    const score = contextScore(comment.anchor, newAnchorLines, i)
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

/**
 * Side-aware file presence for one comment against the fresh compare. A
 * comment anchors into the base blob when LEFT and the head blob when RIGHT,
 * so a path's fate is read from the side that holds the anchor text:
 *
 * - RIGHT: a file `removed` in the compare has no head content left to anchor
 *   to → `deleted`; a `renamed` path (old name absent, matched by
 *   `previous_filename`) → `renamed`; anything else with head content →
 *   `present`.
 * - LEFT: the anchor targets base content, which a `removed` file still holds
 *   in full — so a removal is NOT terminal and the comment can still anchor
 *   `clean`/`drifted` against the base blob. An `added` file, however, never
 *   existed on the base side, so a LEFT anchor into it is `added` (there is no
 *   base blob to match). A `renamed` path still reports `renamed`.
 *
 * When the path is absent from the compare entirely, presence follows whether
 * a blob exists on the anchoring side (the base for LEFT, the head for RIGHT).
 */
export function resolveFilePresence(args: {
  path: string
  side: PendingComment['side']
  file: PullFile | undefined
  files: PullFile[]
  entry: { base: string | null; head: string | null } | undefined
}): FilePresence {
  const { path, side, file, files, entry } = args

  if (file) {
    if (file.status === 'renamed') return 'renamed'
    if (side === 'RIGHT') {
      return file.status === 'removed' ? 'deleted' : 'present'
    }
    // LEFT: base content survives a removal but never existed for an addition.
    return file.status === 'added' ? 'added' : 'present'
  }

  if (files.some((f) => f.status === 'renamed' && f.previous_filename === path)) {
    return 'renamed'
  }

  // Absent from the compare: present only if the anchoring side has a blob.
  return entry?.[anchorSideKey(side)] ? 'present' : 'deleted'
}

/**
 * The single per-comment reconcile decision every consumer runs. Given the
 * comment, the fresh compare's files and `blobIndex`, and a blob-line resolver
 * that returns the (git-counted) lines for a blob SHA or `null` when the blob
 * is unavailable/binary, it selects the correct side's blob, computes
 * side-aware presence, and classifies. The mock adapter resolves lines from
 * its blob store; the reconcile dialog resolves them from its loaded snapshot;
 * the conformance suite resolves them via `getBlob`. Routing all three through
 * this one function is what guarantees a preview and a report never disagree.
 */
export function classifyPendingComment(args: {
  comment: PendingComment
  files: PullFile[]
  blobIndex: Record<string, { base: string | null; head: string | null }>
  /** Lines of the blob at `sha`, or `null` when it is missing or binary. */
  resolveBlobLines: (sha: string) => string[] | null
}): AnchorResult {
  const { comment, files, blobIndex, resolveBlobLines } = args
  const entry = blobIndex[comment.path]
  const file = files.find((f) => f.filename === comment.path)
  const filePresence = resolveFilePresence({
    path: comment.path,
    side: comment.side,
    file,
    files,
    entry,
  })
  const sha = selectAnchorBlobSha(entry, comment.side)
  const newAnchorLines = sha ? resolveBlobLines(sha) : null
  return classifyAnchor({ comment, newAnchorLines, filePresence })
}

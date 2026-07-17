/**
 * Unit suite for the pure re-anchoring module. Every case pins one branch of
 * `classifyAnchor` so that deleting any single branch in `anchor.ts` makes at
 * least one assertion here fail. Inputs are built directly (no fixtures) and
 * kept minimal: only the fields `classifyAnchor` reads are populated with
 * meaningful values.
 */

import { describe, it, expect } from 'bun:test'
import { classifyAnchor } from '@/lib/anchor'
import type { PendingComment } from '@/api/types'

/**
 * Builds a PendingComment carrying only the anchoring-relevant fields. `line`
 * is 1-based (the diff line the draft was written against); `start_line` is
 * null unless a ranged comment is wanted; the anchor captures the target line
 * text plus its surrounding context in file order.
 */
function makeComment(overrides: {
  line: number
  start_line?: number | null
  lineText: string
  contextBefore?: string[]
  contextAfter?: string[]
}): PendingComment {
  return {
    key: 'k',
    path: 'src/file.ts',
    side: 'RIGHT',
    start_side: null,
    line: overrides.line,
    start_line: overrides.start_line ?? null,
    body: 'a note',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    anchor: {
      lineText: overrides.lineText,
      contextBefore: overrides.contextBefore ?? [],
      contextAfter: overrides.contextAfter ?? [],
    },
  }
}

describe('classifyAnchor — terminal file-presence branches', () => {
  it('reports lost/file-deleted when the file is gone, before any text match', () => {
    // Head content still contains the exact anchor text; presence must win
    // so the line-number-based match never runs.
    const comment = makeComment({ line: 1, lineText: 'const x = 1' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['const x = 1'],
      filePresence: 'deleted',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'file-deleted' })
  })

  it('reports lost/file-renamed when the file moved paths', () => {
    const comment = makeComment({ line: 1, lineText: 'const x = 1' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['const x = 1'],
      filePresence: 'renamed',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'file-renamed' })
  })
})

describe('classifyAnchor — unavailable or empty head content', () => {
  it('reports lost/line-deleted when the head content is null', () => {
    const comment = makeComment({ line: 3, lineText: 'anything' })
    const result = classifyAnchor({
      comment,
      newHeadLines: null,
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'line-deleted' })
  })

  it('reports lost/line-deleted when the head file is now empty', () => {
    const comment = makeComment({ line: 3, lineText: 'anything' })
    const result = classifyAnchor({
      comment,
      newHeadLines: [],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'line-deleted' })
  })
})

describe('classifyAnchor — clean (line held its position)', () => {
  it('reports clean when the original position still holds the anchor text', () => {
    // comment.line 2 => 0-based index 1.
    const comment = makeComment({ line: 2, lineText: 'target line' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['first', 'target line', 'third'],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })

  it('stays clean when the head line only gained trailing whitespace', () => {
    // lineEq uses trimEnd, so trailing spaces/tabs must not orphan the draft.
    const comment = makeComment({ line: 2, lineText: 'target line' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['first', 'target line   \t', 'third'],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })
})

describe('classifyAnchor — drifted', () => {
  it('drifts DOWN with a positive delta when the anchor text moved later', () => {
    // Draft targeted line 2 (index 1); two lines were inserted above so the
    // anchor text now sits at index 3 => line 4, delta = +2.
    const comment = makeComment({ line: 2, lineText: 'anchor' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
      filePresence: 'present',
    })
    expect(result).toMatchObject({ kind: 'drifted', newLine: 4, delta: 2 })
  })

  it('drifts UP with a negative delta when the anchor text moved earlier', () => {
    // Draft targeted line 4 (index 3); the anchor text now lives at index 1
    // => line 2, delta = -2.
    const comment = makeComment({ line: 4, lineText: 'anchor' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['head', 'anchor', 'x', 'y', 'z'],
      filePresence: 'present',
    })
    expect(result).toMatchObject({ kind: 'drifted', newLine: 2, delta: -2 })
  })

  it('shifts newStartLine by delta for a ranged comment', () => {
    // start_line 1, line 2 (index 1); anchor moved to index 3 => delta +2, so
    // newStartLine = 1 + 2 = 3.
    const comment = makeComment({ line: 2, start_line: 1, lineText: 'anchor' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
      filePresence: 'present',
    })
    expect(result).toMatchObject({
      kind: 'drifted',
      newLine: 4,
      delta: 2,
      newStartLine: 3,
    })
  })

  it('leaves newStartLine null for a single-line (unranged) comment', () => {
    const comment = makeComment({ line: 2, start_line: null, lineText: 'anchor' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
      filePresence: 'present',
    })
    expect(result).toMatchObject({
      kind: 'drifted',
      newLine: 4,
      delta: 2,
      newStartLine: null,
    })
  })
})

describe('classifyAnchor — lost (line-deleted despite present file)', () => {
  it('reports lost/line-deleted when the anchor text is nowhere in the window', () => {
    const comment = makeComment({ line: 2, lineText: 'gone forever' })
    const result = classifyAnchor({
      comment,
      newHeadLines: ['alpha', 'beta', 'gamma'],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'line-deleted' })
  })
})

describe('classifyAnchor — tie-break by context score', () => {
  it('prefers the farther candidate that has matching surrounding context', () => {
    // Draft targeted line 6 (index 5). Two lines equal the anchor text:
    //   - index 4 (line 5, |delta| 1) with NO surrounding context match.
    //   - index 8 (line 9, |delta| 3) sandwiched by the captured context.
    // contextBefore is file-ordered: its LAST element is the line directly
    // above the anchor; contextAfter's FIRST element is directly below. The
    // higher context score must win even though it is farther away.
    const comment = makeComment({
      line: 6,
      lineText: 'dup',
      contextBefore: ['ctx-above'],
      contextAfter: ['ctx-below'],
    })
    const newHeadLines = [
      'l0', // 0
      'l1', // 1
      'l2', // 2
      'noise-above', // 3  (above the near dup, deliberately not ctx-above)
      'dup', // 4  near candidate, no context match
      'noise-below', // 5  (this is the original index; not the anchor text)
      'l6', // 6
      'ctx-above', // 7  matches contextBefore last element
      'dup', // 8  far candidate, fully surrounded by captured context
      'ctx-below', // 9  matches contextAfter first element
      'l10', // 10
    ]
    const result = classifyAnchor({ comment, newHeadLines, filePresence: 'present' })
    // Far candidate at index 8 => line 9, delta = 9 - 6 = 3.
    expect(result).toMatchObject({ kind: 'drifted', newLine: 9, delta: 3 })
  })
})

describe('classifyAnchor — tie-break by distance then position', () => {
  it('prefers the smaller |delta| when context scores are equal', () => {
    // No context captured, so every candidate scores 0. Draft targeted line 6
    // (index 5). Candidates at index 3 (|delta| 2) and index 4 (|delta| 1);
    // the nearer one (index 4 => line 5) must win.
    const comment = makeComment({ line: 6, lineText: 'dup' })
    const newHeadLines = [
      'a', // 0
      'b', // 1
      'c', // 2
      'dup', // 3  |delta| 2
      'dup', // 4  |delta| 1  <- winner
      'x', // 5  original index
      'y', // 6
    ]
    const result = classifyAnchor({ comment, newHeadLines, filePresence: 'present' })
    // index 4 => line 5, delta = 5 - 6 = -1.
    expect(result).toMatchObject({ kind: 'drifted', newLine: 5, delta: -1 })
  })

  it('keeps the lowest line number on a full context+distance tie', () => {
    // No context, so all scores 0. Draft targeted line 4 (index 3). Two
    // candidates are equidistant: index 1 (|delta| 2, above) and index 5
    // (|delta| 2, below). The earliest-scanned, lowest-line-number candidate
    // (index 1) is retained because neither a higher score nor a smaller
    // |delta| ever displaces it.
    const comment = makeComment({ line: 4, lineText: 'dup' })
    const newHeadLines = [
      'a', // 0
      'dup', // 1  |delta| 2, above  <- winner (lowest line number)
      'c', // 2
      'x', // 3  original index
      'e', // 4
      'dup', // 5  |delta| 2, below
      'g', // 6
    ]
    const result = classifyAnchor({ comment, newHeadLines, filePresence: 'present' })
    // index 1 => line 2, delta = 2 - 4 = -2.
    expect(result).toMatchObject({ kind: 'drifted', newLine: 2, delta: -2 })
  })
})

describe('classifyAnchor — search radius', () => {
  it('ignores a match beyond +400 of the original index but finds one within', () => {
    // Original index 0 (line 1). A window of 402 lines: the anchor text sits
    // only at index 401, which is 401 away — one past the ±400 radius — so no
    // candidate is found and the comment is lost.
    const comment = makeComment({ line: 1, lineText: 'far-anchor' })
    const beyond: string[] = Array.from({ length: 402 }, (_, i) =>
      i === 401 ? 'far-anchor' : `filler-${i}`,
    )
    const outOfRange = classifyAnchor({
      comment,
      newHeadLines: beyond,
      filePresence: 'present',
    })
    expect(outOfRange).toEqual({ kind: 'lost', comment, reason: 'line-deleted' })

    // The exact same content with the anchor pulled one line closer (index
    // 400, exactly on the radius boundary) IS found.
    const within: string[] = Array.from({ length: 402 }, (_, i) =>
      i === 400 ? 'far-anchor' : `filler-${i}`,
    )
    const inRange = classifyAnchor({
      comment,
      newHeadLines: within,
      filePresence: 'present',
    })
    // index 400 => line 401, delta = 401 - 1 = 400.
    expect(inRange).toMatchObject({ kind: 'drifted', newLine: 401, delta: 400 })
  })
})

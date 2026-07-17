/**
 * Unit suite for the pure re-anchoring module. Every case pins one branch of
 * `classifyAnchor` so that deleting any single branch in `anchor.ts` makes at
 * least one assertion here fail. Inputs are built directly (no fixtures) and
 * kept minimal: only the fields `classifyAnchor` reads are populated with
 * meaningful values.
 */

import { describe, it, expect } from 'bun:test'
import {
  anchorSideKey,
  blobContentToLines,
  classifyAnchor,
  classifyPendingComment,
  resolveFilePresence,
  selectAnchorBlobSha,
} from './anchor'
import type { PendingComment, PullFile } from '../api/types'

/**
 * Builds a PendingComment carrying only the anchoring-relevant fields. `line`
 * is 1-based (the diff line the draft was written against); `start_line` is
 * null unless a ranged comment is wanted; the anchor captures the target line
 * text plus its surrounding context in file order.
 */
function makeComment(overrides: {
  line: number
  side?: 'LEFT' | 'RIGHT'
  start_line?: number | null
  lineText: string
  contextBefore?: string[]
  contextAfter?: string[]
  startLineText?: string | null
}): PendingComment {
  return {
    key: 'k',
    path: 'src/file.ts',
    side: overrides.side ?? 'RIGHT',
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
      ...(overrides.startLineText !== undefined
        ? { startLineText: overrides.startLineText }
        : {}),
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
      newAnchorLines: ['const x = 1'],
      filePresence: 'deleted',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'file-deleted' })
  })

  it('reports lost/file-renamed when the file moved paths', () => {
    const comment = makeComment({ line: 1, lineText: 'const x = 1' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['const x = 1'],
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
      newAnchorLines: null,
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'line-deleted' })
  })

  it('reports lost/line-deleted when the head file is now empty', () => {
    const comment = makeComment({ line: 3, lineText: 'anything' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: [],
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
      newAnchorLines: ['first', 'target line', 'third'],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })

  it('stays clean when the head line only gained trailing whitespace', () => {
    // lineEq uses trimEnd, so trailing spaces/tabs must not orphan the draft.
    const comment = makeComment({ line: 2, lineText: 'target line' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['first', 'target line   \t', 'third'],
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
      newAnchorLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
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
      newAnchorLines: ['head', 'anchor', 'x', 'y', 'z'],
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
      newAnchorLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
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
      newAnchorLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
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

describe('classifyAnchor — ranged start validated against startLineText', () => {
  it('re-finds the true start when a line is inserted INSIDE the span', () => {
    // A ranged comment covered start (line 2) through end (line 4). Two edits
    // land: one line inserted ABOVE the range (shifts the whole span down by 1)
    // and one line inserted INSIDE the range between the start and end (shifts
    // only the END down by a further 1). The end anchor drifts by delta +2, but
    // the START only moved by +1. A rigid `start_line + delta` = 2 + 2 = 4 would
    // land on the inserted-inside line — mis-covering the block. Validation
    // against the captured start text re-finds the true start at line 3.
    const comment = makeComment({
      line: 4,
      start_line: 2,
      lineText: 'end-anchor',
      startLineText: 'start-anchor',
    })
    const newAnchorLines = [
      'inserted-above', // 0  line 1 (new)
      'pad', // 1  line 2 (was line 1)
      'start-anchor', // 2  line 3  <- true start, moved +1
      'middle', // 3  line 4
      'inserted-inside', // 4  line 5 (new, INSIDE the range)
      'end-anchor', // 5  line 6  <- end, moved +2
      'tail', // 6  line 7
    ]
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
    expect(result).toMatchObject({
      kind: 'drifted',
      newLine: 6,
      delta: 2,
      newStartLine: 3,
    })
    // The start was confirmed by re-finding its text, so no uncertainty flag.
    if (result.kind === 'drifted') {
      expect(result.startLineUncertain).toBeUndefined()
    }
  })

  it('flags startLineUncertain when the start text vanished near the shift', () => {
    // The end anchor drifts, but the captured start text is nowhere near where
    // the rigid shift would place it (it was edited away). The rigid shift is
    // returned as a best effort but flagged so the dialog asks the human to
    // confirm the span rather than attaching silently to the wrong block.
    const comment = makeComment({
      line: 3,
      start_line: 1,
      lineText: 'end-anchor',
      startLineText: 'start-anchor',
    })
    const newAnchorLines = [
      'ins-a', // 0
      'ins-b', // 1
      'was-start-now-different', // 2  line 3: rigid start would land here
      'noise', // 3
      'end-anchor', // 4  line 5  <- end drifted, delta +2
      'tail', // 5
    ]
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
    expect(result).toMatchObject({
      kind: 'drifted',
      newLine: 5,
      delta: 2,
      startLineUncertain: true,
    })
  })

  it('applies the rigid shift silently when it lands on the start text', () => {
    // The whole span moved as one block: the rigid `start_line + delta` lands
    // exactly on the captured start text, so the span is confirmed and applied
    // with no uncertainty flag — the common, correct case.
    const comment = makeComment({
      line: 4,
      start_line: 2,
      lineText: 'end-anchor',
      startLineText: 'start-anchor',
    })
    const newAnchorLines = [
      'ins-a', // 0  line 1 (new)
      'ins-b', // 1  line 2 (new)
      'pad', // 2  line 3 (was line 1)
      'start-anchor', // 3  line 4  <- start, moved +2
      'middle', // 4  line 5
      'end-anchor', // 5  line 6  <- end, moved +2
      'tail', // 6
    ]
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
    expect(result).toMatchObject({
      kind: 'drifted',
      newLine: 6,
      delta: 2,
      newStartLine: 4,
    })
    if (result.kind === 'drifted') {
      expect(result.startLineUncertain).toBeUndefined()
    }
  })

  it('falls back to the rigid shift, unflagged, when no startLineText was captured', () => {
    // An older draft (written before startLineText existed) has no captured
    // start text: reconcile must behave exactly as before — a rigid delta shift
    // with no uncertainty flag, no re-search.
    const comment = makeComment({ line: 2, start_line: 1, lineText: 'anchor' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['ins-a', 'ins-b', 'other', 'anchor', 'tail'],
      filePresence: 'present',
    })
    expect(result).toMatchObject({
      kind: 'drifted',
      newLine: 4,
      delta: 2,
      newStartLine: 3,
    })
    if (result.kind === 'drifted') {
      expect(result.startLineUncertain).toBeUndefined()
    }
  })
})

describe('classifyAnchor — lost (line-deleted despite present file)', () => {
  it('reports lost/line-deleted when the anchor text is nowhere in the window', () => {
    const comment = makeComment({ line: 2, lineText: 'gone forever' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['alpha', 'beta', 'gamma'],
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
    const newAnchorLines = [
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
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
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
    const newAnchorLines = [
      'a', // 0
      'b', // 1
      'c', // 2
      'dup', // 3  |delta| 2
      'dup', // 4  |delta| 1  <- winner
      'x', // 5  original index
      'y', // 6
    ]
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
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
    const newAnchorLines = [
      'a', // 0
      'dup', // 1  |delta| 2, above  <- winner (lowest line number)
      'c', // 2
      'x', // 3  original index
      'e', // 4
      'dup', // 5  |delta| 2, below
      'g', // 6
    ]
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
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
      newAnchorLines: beyond,
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
      newAnchorLines: within,
      filePresence: 'present',
    })
    // index 400 => line 401, delta = 401 - 1 = 400.
    expect(inRange).toMatchObject({ kind: 'drifted', newLine: 401, delta: 400 })
  })
})

describe('classifyAnchor — lost/file-added (base side never held the file)', () => {
  it('reports lost/file-added before any text match', () => {
    // Anchor text is present in the supplied lines; presence must win so the
    // human sees "the file is new" rather than a bogus clean/drifted anchor.
    const comment = makeComment({ line: 1, side: 'LEFT', lineText: 'const x = 1' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['const x = 1'],
      filePresence: 'added',
    })
    expect(result).toEqual({ kind: 'lost', comment, reason: 'file-added' })
  })
})

describe('classifyAnchor — clean requires context on a repeated line', () => {
  it('keeps clean cheaply for a unique unmoved line with no context', () => {
    // Single occurrence of the anchor text in the window: nothing else could
    // be confused for it, so it short-circuits clean without any context.
    const comment = makeComment({ line: 2, lineText: 'unique-anchor' })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['a', 'unique-anchor', 'b'],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })

  it('stays clean for an unmoved line whose surrounding context is intact', () => {
    // The line repeats (a bare `}`), but its captured neighbors still sit
    // around the original index, clearing the clean context floor.
    const comment = makeComment({
      line: 4,
      lineText: '}',
      contextBefore: ['  doThing()'],
      contextAfter: ['const next = 1'],
    })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['function f() {', '}', '  doThing()', '}', 'const next = 1'],
      filePresence: 'present',
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })

  it('does NOT report clean when a duplicate line shifted under the anchor', () => {
    // A `}` was captured at line 4 with distinctive context. After a large
    // insertion above, a DIFFERENT `}` now occupies index 3 (line 4) while the
    // originally-commented block moved far down with its context intact. A
    // text-only clean would silently re-point the comment at the wrong brace;
    // the context floor forces the ranked drift search, which follows the
    // captured neighborhood to the moved block instead.
    const comment = makeComment({
      line: 4,
      lineText: '}',
      contextBefore: ['    return cached'],
      contextAfter: ['export function next() {'],
    })
    const inserted = Array.from({ length: 24 }, () => 'const pad = 0')
    const newAnchorLines = [
      'function first() {', // 0
      '  const a = 1', // 1
      '  if (a) {', // 2
      '}', // 3  <- original index (line 4): a coincidental brace
      ...inserted, // 4..27
      '    return cached', // 28  captured context-before
      '}', // 29  the ORIGINAL commented brace, moved down
      'export function next() {', // 30 captured context-after
    ]
    const result = classifyAnchor({ comment, newAnchorLines, filePresence: 'present' })
    // The moved brace at index 29 => line 30 wins on context; NOT clean.
    expect(result).toMatchObject({ kind: 'drifted', newLine: 30 })
    expect(result.kind).not.toBe('clean')
  })

  it('resolves an unmoved-but-repeated line to drifted delta 0, never lost', () => {
    // The anchor text repeats and its context also changed, so the clean
    // fast-path is skipped — but the original position still holds the text
    // and (with no better-scoring candidate) wins the search at delta 0, so a
    // genuinely-unmoved line is never wrongly reported lost.
    const comment = makeComment({
      line: 2,
      lineText: 'return',
      contextBefore: ['gone-context'],
      contextAfter: ['also-gone'],
    })
    const result = classifyAnchor({
      comment,
      newAnchorLines: ['return', 'return', 'return'],
      filePresence: 'present',
    })
    expect(result).toMatchObject({ kind: 'drifted', newLine: 2, delta: 0 })
  })
})

describe('shared side selectors', () => {
  it('maps LEFT to base and RIGHT to head exactly once', () => {
    expect(anchorSideKey('LEFT')).toBe('base')
    expect(anchorSideKey('RIGHT')).toBe('head')
  })

  it('selectAnchorBlobSha reads the side the anchor lives on', () => {
    const entry = { base: 'base-sha', head: 'head-sha' }
    expect(selectAnchorBlobSha(entry, 'LEFT')).toBe('base-sha')
    expect(selectAnchorBlobSha(entry, 'RIGHT')).toBe('head-sha')
    expect(selectAnchorBlobSha(undefined, 'LEFT')).toBeNull()
    expect(selectAnchorBlobSha({ base: null, head: 'h' }, 'LEFT')).toBeNull()
  })

  it('blobContentToLines counts a trailing newline as a terminator', () => {
    expect(blobContentToLines('a\nb\n')).toEqual(['a', 'b'])
    expect(blobContentToLines('a\nb')).toEqual(['a', 'b'])
    expect(blobContentToLines('')).toEqual([])
  })
})

describe('resolveFilePresence — side-aware file fate', () => {
  const modified: PullFile = {
    sha: 's',
    filename: 'f.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
  }
  const removed: PullFile = { ...modified, status: 'removed' }
  const added: PullFile = { ...modified, status: 'added' }
  const renamed: PullFile = {
    ...modified,
    status: 'renamed',
    filename: 'new.ts',
    previous_filename: 'old.ts',
  }
  const entry = { base: 'b', head: 'h' }

  it('RIGHT: removed is deleted, modified is present', () => {
    expect(
      resolveFilePresence({ path: 'f.ts', side: 'RIGHT', file: removed, files: [removed], entry }),
    ).toBe('deleted')
    expect(
      resolveFilePresence({ path: 'f.ts', side: 'RIGHT', file: modified, files: [modified], entry }),
    ).toBe('present')
  })

  it('LEFT: a removed file is still present (base content survives)', () => {
    expect(
      resolveFilePresence({ path: 'f.ts', side: 'LEFT', file: removed, files: [removed], entry }),
    ).toBe('present')
  })

  it('LEFT: an added file is `added` (no base version existed)', () => {
    expect(
      resolveFilePresence({ path: 'f.ts', side: 'LEFT', file: added, files: [added], entry }),
    ).toBe('added')
  })

  it('RIGHT: an added file is present (head content exists)', () => {
    expect(
      resolveFilePresence({ path: 'f.ts', side: 'RIGHT', file: added, files: [added], entry }),
    ).toBe('present')
  })

  it('a renamed path reports renamed on either side', () => {
    expect(
      resolveFilePresence({
        path: 'old.ts',
        side: 'RIGHT',
        file: undefined,
        files: [renamed],
        entry: undefined,
      }),
    ).toBe('renamed')
    expect(
      resolveFilePresence({
        path: 'old.ts',
        side: 'LEFT',
        file: undefined,
        files: [renamed],
        entry: undefined,
      }),
    ).toBe('renamed')
  })

  it('absent from the compare: present iff the anchoring side has a blob', () => {
    expect(
      resolveFilePresence({
        path: 'gone.ts',
        side: 'LEFT',
        file: undefined,
        files: [],
        entry: { base: 'b', head: null },
      }),
    ).toBe('present')
    expect(
      resolveFilePresence({
        path: 'gone.ts',
        side: 'LEFT',
        file: undefined,
        files: [],
        entry: { base: null, head: 'h' },
      }),
    ).toBe('deleted')
  })
})

describe('classifyPendingComment — end-to-end side-aware classification', () => {
  const files: PullFile[] = [
    {
      sha: 'head-sha',
      filename: 'src/file.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
    },
  ]
  const blobIndex = { 'src/file.ts': { base: 'base-sha', head: 'head-sha' } }

  it('LEFT anchors against BASE content, ignoring head entirely', () => {
    // The deleted line lives only in base; head has unrelated content. A
    // head-only classifier would call this lost — the base read finds it clean.
    const comment = makeComment({
      line: 2,
      side: 'LEFT',
      lineText: 'const legacy = true',
    })
    const result = classifyPendingComment({
      comment,
      files,
      blobIndex,
      resolveBlobLines: (sha) =>
        sha === 'base-sha'
          ? ['top', 'const legacy = true', 'bottom']
          : ['totally', 'different', 'head'],
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })

  it('RIGHT anchors against HEAD content', () => {
    const comment = makeComment({ line: 2, side: 'RIGHT', lineText: 'const fresh = 1' })
    const result = classifyPendingComment({
      comment,
      files,
      blobIndex,
      resolveBlobLines: (sha) =>
        sha === 'head-sha' ? ['a', 'const fresh = 1', 'b'] : ['base', 'only'],
    })
    expect(result).toEqual({ kind: 'clean', comment })
  })

  it('LEFT drifts against the base side when the base blob moved', () => {
    const comment = makeComment({ line: 2, side: 'LEFT', lineText: 'moved-line' })
    const result = classifyPendingComment({
      comment,
      files,
      blobIndex,
      resolveBlobLines: (sha) =>
        sha === 'base-sha' ? ['pad', 'pad', 'moved-line', 'tail'] : ['head'],
    })
    expect(result).toMatchObject({ kind: 'drifted', newLine: 3, delta: 1 })
  })
})

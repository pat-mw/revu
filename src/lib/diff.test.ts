/**
 * Unit suite for the pure diff engine (./diff). Every case builds minimal
 * `PullFile` objects and unified-diff patch strings by hand and asserts on the
 * structured model, intraline spans, blob splitting, expansion merging, and
 * the flattened viewer rows. Line numbers are 1-based; `WordSpan` offsets are
 * 0-based half-open `[start, end)` indices into `DiffLine.text`.
 */

import { describe, it, expect } from 'bun:test'
import {
  parsePatch,
  intralineDiff,
  blobLines,
  mergeExpanded,
  buildRows,
} from './diff'
import type {
  FileDiffModel,
  DiffRow,
  ExpandedRange,
  WordSpan,
} from './diff'
import type { PullFile } from '../api/types'

// ————————————————————————————————————————————————————————————————
// Builders
// ————————————————————————————————————————————————————————————————

/** Minimal PullFile with sensible defaults; override any field per case. */
function makeFile(overrides: Partial<PullFile>): PullFile {
  return {
    sha: 'blobsha',
    filename: 'src/example.ts',
    status: 'modified',
    additions: 0,
    deletions: 0,
    changes: 0,
    ...overrides,
  }
}

/** Joins patch body lines into a single string (no terminal newline). */
function patch(...lines: string[]): string {
  return lines.join('\n')
}

/** Numbered head-file content `line1\nline2\n…lineN\n` with a terminal newline. */
function headBlob(n: number): string {
  return Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n') + '\n'
}

/** Compact projection of a row for readable structural assertions. */
type RowShape =
  | { t: 'gap'; id: string }
  | { t: 'hunk-header'; id: string }
  | { t: 'line'; id: string }
  | { t: 'pair'; id: string }

function shapes(rows: DiffRow[]): RowShape[] {
  return rows.map((r) => ({ t: r.type, id: r.id }) as RowShape)
}

/** True when no two spans in the array touch or overlap (fully coalesced). */
function isCoalesced(spans: WordSpan[]): boolean {
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start <= spans[i - 1].end) return false
  }
  return true
}

// ————————————————————————————————————————————————————————————————
// parsePatch
// ————————————————————————————————————————————————————————————————

describe('parsePatch', () => {
  it('flags a known binary extension as binary when the patch is absent', () => {
    for (const ext of ['png', 'jpg', 'gif', 'woff2', 'ico', 'pdf', 'zip']) {
      const model = parsePatch(
        makeFile({ filename: `asset.${ext}`, patch: undefined }),
      )
      expect(model.binary).toBe(true)
      expect(model.tooLarge).toBe(false)
      expect(model.hunks).toEqual([])
    }
  })

  it('is case-insensitive about the binary extension', () => {
    const model = parsePatch(makeFile({ filename: 'PHOTO.PNG', patch: undefined }))
    expect(model.binary).toBe(true)
    expect(model.tooLarge).toBe(false)
  })

  it('flags a non-binary extension with an absent patch as tooLarge', () => {
    const model = parsePatch(makeFile({ filename: 'huge.ts', patch: undefined }))
    expect(model.tooLarge).toBe(true)
    expect(model.binary).toBe(false)
    expect(model.hunks).toEqual([])
  })

  it('treats an extensionless absent-patch file as tooLarge, not binary', () => {
    const model = parsePatch(makeFile({ filename: 'Makefile', patch: undefined }))
    expect(model.tooLarge).toBe(true)
    expect(model.binary).toBe(false)
  })

  it('treats a trailing-dot filename as non-binary (no extension)', () => {
    const model = parsePatch(makeFile({ filename: 'weird.', patch: undefined }))
    expect(model.tooLarge).toBe(true)
    expect(model.binary).toBe(false)
  })

  it('parses hunks and carries file metadata through when a patch is present', () => {
    const model = parsePatch(
      makeFile({
        filename: 'src/renamed.ts',
        previous_filename: 'src/old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        patch: patch('@@ -1,2 +1,2 @@', ' keep', '-was', '+now'),
      }),
    )
    expect(model.binary).toBe(false)
    expect(model.tooLarge).toBe(false)
    expect(model.path).toBe('src/renamed.ts')
    expect(model.previousPath).toBe('src/old.ts')
    expect(model.status).toBe('renamed')
    expect(model.additions).toBe(1)
    expect(model.deletions).toBe(1)
    expect(model.hunks).toHaveLength(1)
  })

  it('leaves previousPath undefined when the file has no previous_filename', () => {
    const model = parsePatch(makeFile({ patch: patch('@@ -1 +1 @@', ' x') }))
    expect(model.previousPath).toBeUndefined()
  })
})

// ————————————————————————————————————————————————————————————————
// parseHunks (through parsePatch)
// ————————————————————————————————————————————————————————————————

describe('parseHunks (via parsePatch)', () => {
  function hunksOf(...lines: string[]): FileDiffModel['hunks'] {
    return parsePatch(makeFile({ patch: patch(...lines) })).hunks
  }

  it('defaults omitted header counts to 1', () => {
    const [hunk] = hunksOf('@@ -5 +9 @@', ' only')
    expect(hunk.oldStart).toBe(5)
    expect(hunk.oldLines).toBe(1)
    expect(hunk.newStart).toBe(9)
    expect(hunk.newLines).toBe(1)
    expect(hunk.header).toBe('@@ -5 +9 @@')
  })

  it('honors explicit header counts', () => {
    const [hunk] = hunksOf('@@ -10,3 +20,4 @@', ' a', ' b', ' c')
    expect(hunk.oldStart).toBe(10)
    expect(hunk.oldLines).toBe(3)
    expect(hunk.newStart).toBe(20)
    expect(hunk.newLines).toBe(4)
  })

  it('numbers context/add/del lines with correct 1-based cursors', () => {
    const [hunk] = hunksOf(
      '@@ -10,3 +10,4 @@',
      ' ctx10',
      '-del11',
      '+add11',
      '+add12',
      ' ctx13',
    )
    expect(hunk.lines).toEqual([
      { kind: 'context', oldLine: 10, newLine: 10, text: 'ctx10' },
      { kind: 'del', oldLine: 11, newLine: null, text: 'del11' },
      { kind: 'add', oldLine: null, newLine: 11, text: 'add11' },
      { kind: 'add', oldLine: null, newLine: 12, text: 'add12' },
      // One net deletion so far, so the trailing context sits at old line 12
      // while its new line is 13 — the old cursor lags the new cursor by one.
      { kind: 'context', oldLine: 12, newLine: 13, text: 'ctx13' },
    ])
  })

  it('drops a "\\ No newline at end of file" marker line', () => {
    const [hunk] = hunksOf(
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    )
    expect(hunk.lines).toEqual([
      { kind: 'del', oldLine: 1, newLine: null, text: 'old' },
      { kind: 'add', oldLine: null, newLine: 1, text: 'new' },
    ])
  })

  it('treats a completely empty raw line as an empty context line', () => {
    // The middle raw line here is "" (no marker) — an empty context line.
    const [hunk] = hunksOf('@@ -1,3 +1,3 @@', ' a', '', ' c')
    expect(hunk.lines).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'context', oldLine: 2, newLine: 2, text: '' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'c' },
    ])
  })

  it('ignores content before the first @@ header', () => {
    const [hunk, ...rest] = hunksOf(
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      ' body',
    )
    expect(rest).toHaveLength(0)
    expect(hunk.lines).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'body' },
    ])
  })

  it('drops the trailing "" produced by a terminal newline in the patch', () => {
    // Terminal '\n' → split yields a trailing '' that is NOT an extra line.
    const model = parsePatch(makeFile({ patch: '@@ -1 +1 @@\n only\n' }))
    expect(model.hunks[0].lines).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'only' },
    ])
  })

  it('returns no hunks for an empty patch string', () => {
    expect(hunksOf('')).toEqual([])
  })

  it('splits multiple @@ headers into separate hunks and resets cursors', () => {
    const hunks = hunksOf(
      '@@ -1,1 +1,1 @@',
      ' first',
      '@@ -50,1 +60,1 @@',
      ' second',
    )
    expect(hunks).toHaveLength(2)
    expect(hunks[0].lines[0]).toEqual({
      kind: 'context',
      oldLine: 1,
      newLine: 1,
      text: 'first',
    })
    expect(hunks[1].lines[0]).toEqual({
      kind: 'context',
      oldLine: 50,
      newLine: 60,
      text: 'second',
    })
  })
})

// ————————————————————————————————————————————————————————————————
// intralineDiff
// ————————————————————————————————————————————————————————————————

describe('intralineDiff', () => {
  it('returns empty span arrays for identical strings', () => {
    expect(intralineDiff('same', 'same')).toEqual({ del: [], add: [] })
  })

  it('returns null when either line is pathologically long (> 10000 chars)', () => {
    const long = 'a'.repeat(10001)
    expect(intralineDiff(long, 'b')).toBeNull()
    expect(intralineDiff('b', long)).toBeNull()
  })

  it('returns null for a whole-line rewrite exceeding ~70% changed', () => {
    // Every character changes: ratio 1.0 on both sides.
    expect(intralineDiff('abc', 'xyz')).toBeNull()
  })

  it('produces correct 0-based [start,end) spans for a small edit', () => {
    // 'const x = 1' → 'const x = 2': only the final char differs at index 10.
    const result = intralineDiff('const x = 1', 'const x = 2')
    expect(result).toEqual({
      del: [{ start: 10, end: 11 }],
      add: [{ start: 10, end: 11 }],
    })
  })

  it('spans point at the changed substring, not the shared prefix', () => {
    const result = intralineDiff('foo bar baz', 'foo qux baz')
    expect(result).not.toBeNull()
    const del = result!.del
    const add = result!.add
    expect('foo bar baz'.slice(del[0].start, del[0].end)).toBe('bar')
    expect('foo qux baz'.slice(add[0].start, add[0].end)).toBe('qux')
  })

  it('keeps output spans coalesced (no two touching spans in either array)', () => {
    // Two separated single-word edits: each array holds distinct, non-adjacent
    // spans. The engine's pushSpan invariant guarantees no touching spans ever
    // survive as two entries.
    const result = intralineDiff('aa bb cc dd', 'aa XX cc YY')
    expect(result).not.toBeNull()
    expect(result!.del.length).toBeGreaterThan(1)
    expect(isCoalesced(result!.del)).toBe(true)
    expect(isCoalesced(result!.add)).toBe(true)
    // Spans still index the actual changed words.
    expect('aa bb cc dd'.slice(result!.del[0].start, result!.del[0].end)).toBe('bb')
    expect('aa bb cc dd'.slice(result!.del[1].start, result!.del[1].end)).toBe('dd')
  })
})

// ————————————————————————————————————————————————————————————————
// blobLines
// ————————————————————————————————————————————————————————————————

describe('blobLines', () => {
  it('returns [] for empty content (a zero-line file)', () => {
    expect(blobLines('')).toEqual([])
  })

  it('drops the phantom last line from a terminal newline', () => {
    expect(blobLines('a\nb\n')).toEqual(['a', 'b'])
  })

  it('keeps the final line when there is no terminal newline', () => {
    expect(blobLines('a\nb')).toEqual(['a', 'b'])
  })

  it('preserves an interior blank line', () => {
    expect(blobLines('a\n\nb')).toEqual(['a', '', 'b'])
  })
})

// ————————————————————————————————————————————————————————————————
// mergeExpanded
// ————————————————————————————————————————————————————————————————

describe('mergeExpanded', () => {
  it('merges overlapping ranges into one', () => {
    const out = mergeExpanded([{ fromNew: 1, toNew: 5 }], { fromNew: 3, toNew: 8 })
    expect(out).toEqual([{ fromNew: 1, toNew: 8 }])
  })

  it('merges merely-touching ranges (toNew + 1 === fromNew)', () => {
    const out = mergeExpanded([{ fromNew: 1, toNew: 5 }], { fromNew: 6, toNew: 9 })
    expect(out).toEqual([{ fromNew: 1, toNew: 9 }])
  })

  it('normalizes an inverted input range', () => {
    const out = mergeExpanded([], { fromNew: 9, toNew: 4 })
    expect(out).toEqual([{ fromNew: 4, toNew: 9 }])
  })

  it('keeps a one-line gap between ranges as two separate ranges', () => {
    // 5 and 7 leave line 6 collapsed, so they must not merge.
    const out = mergeExpanded([{ fromNew: 1, toNew: 5 }], { fromNew: 7, toNew: 9 })
    expect(out).toEqual([
      { fromNew: 1, toNew: 5 },
      { fromNew: 7, toNew: 9 },
    ])
  })

  it('returns a sorted, non-overlapping result regardless of input order', () => {
    const out = mergeExpanded(
      [
        { fromNew: 20, toNew: 25 },
        { fromNew: 1, toNew: 3 },
      ],
      { fromNew: 10, toNew: 12 },
    )
    expect(out).toEqual([
      { fromNew: 1, toNew: 3 },
      { fromNew: 10, toNew: 12 },
      { fromNew: 20, toNew: 25 },
    ])
  })

  it('does not mutate the input arrays and returns a fresh array', () => {
    const ranges: ExpandedRange[] = [{ fromNew: 1, toNew: 3 }]
    const add: ExpandedRange = { fromNew: 4, toNew: 6 }
    const snapshot = JSON.stringify(ranges)
    const out = mergeExpanded(ranges, add)
    expect(JSON.stringify(ranges)).toBe(snapshot)
    expect(out).not.toBe(ranges)
    // Elements are copies, not shared references with the input.
    expect(out[0]).not.toBe(ranges[0])
  })
})

// ————————————————————————————————————————————————————————————————
// buildRows
// ————————————————————————————————————————————————————————————————

describe('buildRows', () => {
  const noBlobs = { headBlobContent: null, baseBlobContent: null } as const

  function build(
    model: FileDiffModel,
    opts: Partial<Parameters<typeof buildRows>[1]> = {},
  ): DiffRow[] {
    return buildRows(model, {
      mode: 'unified',
      expanded: [],
      headBlobContent: null,
      baseBlobContent: null,
      ...opts,
    })
  }

  it('produces no rows for a binary model', () => {
    const model = parsePatch(makeFile({ filename: 'a.png', patch: undefined }))
    expect(build(model)).toEqual([])
  })

  it('produces no rows for a too-large model', () => {
    const model = parsePatch(makeFile({ filename: 'a.ts', patch: undefined }))
    expect(build(model)).toEqual([])
  })

  it('emits no gap rows for an added file — every line is new', () => {
    const model = parsePatch(
      makeFile({
        status: 'added',
        additions: 2,
        patch: patch('@@ -0,0 +1,2 @@', '+one', '+two'),
      }),
    )
    const rows = build(model, { headBlobContent: headBlob(2) })
    expect(rows.some((r) => r.type === 'gap')).toBe(false)
    expect(shapes(rows)).toEqual([
      { t: 'hunk-header', id: 'hunk:0' },
      { t: 'line', id: 'L1' },
      { t: 'line', id: 'L2' },
    ])
  })

  it('unified mode emits line rows keyed L{newLine}, or O{oldLine} for del-only', () => {
    const model = parsePatch(
      makeFile({
        patch: patch('@@ -10,3 +10,4 @@', ' ctx10', '-del11', '+add11', '+add12', ' ctx13'),
      }),
    )
    const rows = build(model)
    // Leading gap 1..9 is derived purely from hunk coordinates, no blob needed.
    expect(shapes(rows)).toEqual([
      { t: 'gap', id: 'gap:1' },
      { t: 'hunk-header', id: 'hunk:0' },
      { t: 'line', id: 'L10' },
      { t: 'line', id: 'O11' },
      { t: 'line', id: 'L11' },
      { t: 'line', id: 'L12' },
      { t: 'line', id: 'L13' },
    ])
    const gap = rows[0]
    if (gap.type !== 'gap') throw new Error('expected leading gap')
    expect(gap.gap).toEqual({
      oldStart: 1,
      oldEnd: 9,
      newStart: 1,
      newEnd: 9,
      count: 9,
    })
  })

  it('split mode emits pair rows keyed R{newLine}, or O{oldLine} for unpaired del', () => {
    const model = parsePatch(
      makeFile({
        patch: patch('@@ -1,3 +1,2 @@', ' ctx1', '-del2', '-del3', '+add2'),
      }),
    )
    const rows = build(model, { mode: 'split' })
    // ctx pair, then del2↔add2 pair (R2), then leftover del3 alone (O3).
    expect(shapes(rows)).toEqual([
      { t: 'hunk-header', id: 'hunk:0' },
      { t: 'pair', id: 'R1' },
      { t: 'pair', id: 'R2' },
      { t: 'pair', id: 'O3' },
    ])
    const ctxPair = rows[1]
    if (ctxPair.type !== 'pair') throw new Error('expected context pair')
    // Context mirrors to both sides — the same DiffLine object.
    expect(ctxPair.left).toBe(ctxPair.right)
    const leftover = rows[3]
    if (leftover.type !== 'pair') throw new Error('expected leftover pair')
    expect(leftover.right).toBeNull()
    expect(leftover.left).not.toBeNull()
  })

  it('derives the between-hunks gap purely from coordinates even with a null head blob', () => {
    const model = parsePatch(
      makeFile({
        patch: patch('@@ -1,1 +1,1 @@', ' a', '@@ -10,1 +10,1 @@', ' b'),
      }),
    )
    const rows = build(model, noBlobs)
    // Gap between line 1 and hunk-2 start (2..9), no trailing gap without a blob.
    expect(shapes(rows)).toEqual([
      { t: 'hunk-header', id: 'hunk:0' },
      { t: 'line', id: 'L1' },
      { t: 'gap', id: 'gap:2' },
      { t: 'hunk-header', id: 'hunk:1' },
      { t: 'line', id: 'L10' },
    ])
    const gap = rows[2]
    if (gap.type !== 'gap') throw new Error('expected between-hunks gap')
    expect(gap.gap).toEqual({
      oldStart: 2,
      oldEnd: 9,
      newStart: 2,
      newEnd: 9,
      count: 8,
    })
  })

  it('emits a trailing gap only when a long-enough head blob is provided', () => {
    const model = parsePatch(
      makeFile({ patch: patch('@@ -10,1 +10,1 @@', ' ctx10') }),
    )
    const withoutBlob = build(model, noBlobs)
    expect(withoutBlob.some((r) => r.type === 'gap' && r.id !== 'gap:1')).toBe(false)

    const withBlob = build(model, { headBlobContent: headBlob(20) })
    const trailing = withBlob[withBlob.length - 1]
    if (trailing.type !== 'gap') throw new Error('expected a trailing gap')
    // The single context line aligns both sides at 10, so delta is 0 after the
    // hunk and the trailing gap's old/new ranges coincide (11..20).
    expect(trailing.gap).toEqual({
      oldStart: 11,
      oldEnd: 20,
      newStart: 11,
      newEnd: 20,
      count: 10,
    })
  })

  it('omits the trailing gap when the head blob ends at the last hunk line', () => {
    const model = parsePatch(
      makeFile({ patch: patch('@@ -1,2 +1,2 @@', ' a', ' b') }),
    )
    // Head blob has exactly 2 lines, so newNext (3) > headLines.length (2).
    const rows = build(model, { headBlobContent: headBlob(2) })
    expect(rows.some((r) => r.type === 'gap')).toBe(false)
  })

  it('renders a zero-hunk model with a head blob as one whole-file gap', () => {
    const model = parsePatch(
      makeFile({ status: 'renamed', previous_filename: 'old.ts', patch: '' }),
    )
    expect(model.hunks).toEqual([])
    const rows = build(model, { headBlobContent: headBlob(4) })
    expect(shapes(rows)).toEqual([{ t: 'gap', id: 'gap:1' }])
    const gap = rows[0]
    if (gap.type !== 'gap') throw new Error('expected whole-file gap')
    expect(gap.gap).toEqual({
      oldStart: 1,
      oldEnd: 4,
      newStart: 1,
      newEnd: 4,
      count: 4,
    })
  })

  it('produces no rows for a zero-hunk model when no head blob is provided', () => {
    const model = parsePatch(makeFile({ status: 'renamed', patch: '' }))
    expect(build(model, noBlobs)).toEqual([])
  })

  it('expands the covered span of a gap into context rows and leaves the remainder a gap', () => {
    const model = parsePatch(
      makeFile({ patch: patch('@@ -10,1 +10,1 @@', ' ctx10') }),
    )
    const rows = build(model, {
      headBlobContent: headBlob(20),
      expanded: [{ fromNew: 3, toNew: 5 }],
    })
    // Leading gap 1..9 splits into: gap 1..2, synthesized lines 3..5, gap 6..9.
    expect(shapes(rows).slice(0, 5)).toEqual([
      { t: 'gap', id: 'gap:1' },
      { t: 'line', id: 'L3' },
      { t: 'line', id: 'L4' },
      { t: 'line', id: 'L5' },
      { t: 'gap', id: 'gap:6' },
    ])
    const synthesized = rows[1]
    if (synthesized.type !== 'line') throw new Error('expected synthesized line')
    expect(synthesized.line).toEqual({
      kind: 'context',
      oldLine: 3,
      newLine: 3,
      text: 'line3',
    })
    expect(synthesized.wordSpans).toBeNull()
  })

  it('synthesizes split-mode expansion as mirrored context pairs', () => {
    const model = parsePatch(
      makeFile({ patch: patch('@@ -10,1 +10,1 @@', ' ctx10') }),
    )
    const rows = build(model, {
      mode: 'split',
      headBlobContent: headBlob(20),
      expanded: [{ fromNew: 3, toNew: 4 }],
    })
    const pair = rows.find((r) => r.type === 'pair' && r.id === 'R3')
    if (pair === undefined || pair.type !== 'pair') {
      throw new Error('expected synthesized R3 pair')
    }
    expect(pair.left).toBe(pair.right)
    expect(pair.left).toEqual({
      kind: 'context',
      oldLine: 3,
      newLine: 3,
      text: 'line3',
    })
    expect(pair.wordSpansLeft).toBeNull()
    expect(pair.wordSpansRight).toBeNull()
  })

  it('ignores expansion entirely when the head blob is null', () => {
    const model = parsePatch(
      makeFile({ patch: patch('@@ -10,1 +10,1 @@', ' ctx10') }),
    )
    const rows = build(model, {
      headBlobContent: null,
      expanded: [{ fromNew: 3, toNew: 5 }],
    })
    // Whole leading region stays one gap; no synthesized lines appear.
    expect(shapes(rows)).toEqual([
      { t: 'gap', id: 'gap:1' },
      { t: 'hunk-header', id: 'hunk:0' },
      { t: 'line', id: 'L10' },
    ])
  })

  it('pairs the k-th del with the k-th add and attaches word spans to a matched pair', () => {
    const model = parsePatch(
      makeFile({
        patch: patch('@@ -1,1 +1,1 @@', '-const x = 1', '+const x = 2'),
      }),
    )
    const rows = build(model)
    const delRow = rows.find((r) => r.type === 'line' && r.id === 'O1')
    const addRow = rows.find((r) => r.type === 'line' && r.id === 'L1')
    if (
      delRow === undefined || delRow.type !== 'line' ||
      addRow === undefined || addRow.type !== 'line'
    ) {
      throw new Error('expected a paired del/add')
    }
    expect(delRow.wordSpans).toEqual([{ start: 10, end: 11 }])
    expect(addRow.wordSpans).toEqual([{ start: 10, end: 11 }])
  })

  it('leaves the leftover of an unequal run with null spans in unified mode', () => {
    const model = parsePatch(
      makeFile({
        patch: patch('@@ -1,2 +1,1 @@', '-const x = 1', '-extra line', '+const x = 2'),
      }),
    )
    const rows = build(model)
    // del1 pairs with add1 (both get spans); del2 is a leftover (null spans).
    const lines = rows.filter((r): r is Extract<DiffRow, { type: 'line' }> => r.type === 'line')
    const leftover = lines.find((r) => r.line.text === 'extra line')
    if (leftover === undefined) throw new Error('expected leftover del row')
    expect(leftover.wordSpans).toBeNull()
    expect(leftover.id).toBe('O2')
  })

  it('gives a whole-line rewrite pair null word spans on both sides', () => {
    const model = parsePatch(
      makeFile({ patch: patch('@@ -1,1 +1,1 @@', '-abc', '+xyz') }),
    )
    const rows = build(model)
    const lines = rows.filter((r): r is Extract<DiffRow, { type: 'line' }> => r.type === 'line')
    for (const row of lines) {
      expect(row.wordSpans).toBeNull()
    }
  })

  it('leaves the leftover add of an unequal run with a null opposite side in split mode', () => {
    const model = parsePatch(
      makeFile({
        patch: patch('@@ -1,1 +1,2 @@', '-const x = 1', '+const x = 2', '+brand new'),
      }),
    )
    const rows = build(model, { mode: 'split' })
    // del1↔add1 pair (R1), then leftover add2 with no left side (R2).
    const leftover = rows.find((r) => r.type === 'pair' && r.id === 'R2')
    if (leftover === undefined || leftover.type !== 'pair') {
      throw new Error('expected leftover add pair R2')
    }
    expect(leftover.left).toBeNull()
    expect(leftover.right).not.toBeNull()
    expect(leftover.wordSpansLeft).toBeNull()
    expect(leftover.wordSpansRight).toBeNull()
  })

  it('does not synthesize a trailing gap for a removed file', () => {
    const model = parsePatch(
      makeFile({
        status: 'removed',
        deletions: 1,
        patch: patch('@@ -1,1 +0,0 @@', '-gone'),
      }),
    )
    const rows = build(model, { headBlobContent: headBlob(20) })
    expect(rows.some((r) => r.type === 'gap')).toBe(false)
  })
})

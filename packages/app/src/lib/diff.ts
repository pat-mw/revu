/**
 * Pure diff engine for the review surface. Three responsibilities:
 *
 *  1. `parsePatch` — turn a GitHub `PullFile` (unified-diff `patch` string)
 *     into a structured `FileDiffModel` of hunks and marker-stripped lines.
 *  2. `intralineDiff` — word-level emphasis spans for a paired del/add line.
 *  3. `buildRows` — flatten a model into the exact row list the virtualized
 *     viewer renders, in unified or split mode, with collapsed-context gaps
 *     and caller-supplied expansion ranges honored.
 *
 * Everything here is deterministic, side-effect-free TypeScript with no React
 * or DOM dependency. Line numbers are 1-based throughout; `WordSpan` offsets
 * are 0-based character indices into `DiffLine.text`.
 */

import { diffWordsWithSpace } from 'diff'
import type { PullFile } from '@revu/shared'
// ————————————————————————————————————————————————————————————————
// Model types
// ————————————————————————————————————————————————————————————————

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  /** 1-based line number in the base (old) file; null for added lines. */
  oldLine: number | null
  /** 1-based line number in the head (new) file; null for deleted lines. */
  newLine: number | null
  /** Line content WITHOUT the leading `+`/`-`/space marker and no newline. */
  text: string
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The raw `@@ -a,b +c,d @@ …` line, including any trailing section heading. */
  header: string
  lines: DiffLine[]
}

export interface FileDiffModel {
  path: string
  previousPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  binary: boolean
  tooLarge: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

// ————————————————————————————————————————————————————————————————
// Patch parsing
// ————————————————————————————————————————————————————————————————

/**
 * Extensions treated as binary when GitHub omits the patch. GitHub also omits
 * patches for oversized text files, so absence alone is ambiguous — the
 * extension disambiguates.
 */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'gif',
  'woff2',
  'ico',
  'pdf',
  'zip',
])

function hasBinaryExtension(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return false
  return BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** Matches `@@ -a[,b] +c[,d] @@` at line start; omitted counts default to 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses the hunk body of a `PullFile.patch`. GitHub file patches carry only
 * hunks (no `---`/`+++` headers), so no wrapping is needed. Rules:
 *
 * - `@@` headers open a new hunk and reset both line cursors.
 * - `\ No newline at end of file` markers are dropped: they annotate the
 *   previous line's (absent) terminator, and `DiffLine.text` never includes a
 *   newline, so the model loses nothing.
 * - A completely empty raw line is an empty context line — GitHub sometimes
 *   serializes those as `""` instead of `" "`.
 * - Anything before the first `@@` header is ignored, which also makes the
 *   parser tolerant of full git patches with file headers.
 */
function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  if (patch === '') return hunks
  const rawLines = patch.split('\n')
  // A trailing '' comes from a terminal '\n' in the patch string, not from an
  // empty context line (those keep their ' ' marker) — drop it.
  if (rawLines[rawLines.length - 1] === '') rawLines.pop()

  let current: DiffHunk | null = null
  let oldCursor = 0
  let newCursor = 0
  for (const raw of rawLines) {
    const m = HUNK_HEADER.exec(raw)
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: raw,
        lines: [],
      }
      oldCursor = current.oldStart
      newCursor = current.newStart
      hunks.push(current)
      continue
    }
    if (current === null) continue
    const marker = raw[0]
    if (marker === '\\') continue
    if (marker === '+') {
      current.lines.push({
        kind: 'add',
        oldLine: null,
        newLine: newCursor++,
        text: raw.slice(1),
      })
    } else if (marker === '-') {
      current.lines.push({
        kind: 'del',
        oldLine: oldCursor++,
        newLine: null,
        text: raw.slice(1),
      })
    } else {
      current.lines.push({
        kind: 'context',
        oldLine: oldCursor++,
        newLine: newCursor++,
        text: marker === ' ' ? raw.slice(1) : raw,
      })
    }
  }
  return hunks
}

/**
 * Structured model from one GitHub pull file. A missing `patch` means GitHub
 * declined to inline the diff: known binary extensions are flagged `binary`,
 * everything else is flagged `tooLarge`. Both flags leave `hunks` empty.
 */
export function parsePatch(file: PullFile): FileDiffModel {
  const model: FileDiffModel = {
    path: file.filename,
    previousPath: file.previous_filename,
    status: file.status,
    binary: false,
    tooLarge: false,
    hunks: [],
    additions: file.additions,
    deletions: file.deletions,
  }
  if (file.patch === undefined) {
    if (hasBinaryExtension(file.filename)) model.binary = true
    else model.tooLarge = true
    return model
  }
  model.hunks = parseHunks(file.patch)
  return model
}

// ————————————————————————————————————————————————————————————————
// Intraline (word-level) diff
// ————————————————————————————————————————————————————————————————

/** Half-open character range [start, end) into `DiffLine.text`. */
export interface WordSpan {
  start: number
  end: number
}

/**
 * When the changed portion of either line exceeds this fraction of the line,
 * the pair is treated as a whole-line rewrite and no spans are produced —
 * highlighting nearly everything communicates nothing.
 */
const INTRALINE_NOISE_RATIO = 0.7

/**
 * Lines longer than this skip word diffing entirely (minified bundles,
 * embedded data). Treated the same as a whole-line rewrite.
 */
const INTRALINE_MAX_LENGTH = 10000

/**
 * Word-level emphasis spans for a del line paired with an add line, computed
 * with `diffWordsWithSpace` so whitespace changes are visible. Returns null
 * when the pair reads as a whole-line rewrite (changed characters exceed
 * ~70% of either line, or either line is pathologically long) — callers
 * render null as "tint the whole line, emphasize nothing".
 *
 * Identical lines return empty span arrays (a valid, empty highlight set).
 * Adjacent changed chunks coalesce into single spans.
 */
export function intralineDiff(
  delText: string,
  addText: string,
): { del: WordSpan[]; add: WordSpan[] } | null {
  if (delText === addText) return { del: [], add: [] }
  if (
    delText.length > INTRALINE_MAX_LENGTH ||
    addText.length > INTRALINE_MAX_LENGTH
  ) {
    return null
  }
  const changes = diffWordsWithSpace(delText, addText)
  const del: WordSpan[] = []
  const add: WordSpan[] = []
  let delPos = 0
  let addPos = 0
  let delChanged = 0
  let addChanged = 0
  for (const change of changes) {
    const len = change.value.length
    if (change.removed) {
      if (len > 0) pushSpan(del, delPos, delPos + len)
      delPos += len
      delChanged += len
    } else if (change.added) {
      if (len > 0) pushSpan(add, addPos, addPos + len)
      addPos += len
      addChanged += len
    } else {
      delPos += len
      addPos += len
    }
  }
  const delRatio = delText.length === 0 ? 0 : delChanged / delText.length
  const addRatio = addText.length === 0 ? 0 : addChanged / addText.length
  if (delRatio > INTRALINE_NOISE_RATIO || addRatio > INTRALINE_NOISE_RATIO) {
    return null
  }
  return { del, add }
}

/** Appends a span, coalescing with the previous span when they touch. */
function pushSpan(spans: WordSpan[], start: number, end: number): void {
  const last = spans[spans.length - 1]
  if (last !== undefined && last.end === start) last.end = end
  else spans.push({ start, end })
}

// ————————————————————————————————————————————————————————————————
// Row building (viewer input)
// ————————————————————————————————————————————————————————————————

/** A still-collapsed run of pure context. Both ranges are inclusive. */
export interface GapInfo {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  count: number
}

/** Inclusive range of new-file line numbers the user has expanded. */
export interface ExpandedRange {
  fromNew: number
  toNew: number
}

/**
 * One renderable row. Row id scheme — stable across rebuilds, so virtualizer
 * keys and deep links survive mode toggles, expansion, and blob arrival:
 *
 * - `L{newLine}` — unified-mode line row addressed by its new-file number
 *   (context lines, add lines, and synthesized expanded context).
 * - `R{newLine}` — split-mode pair row addressed by its right side's new-file
 *   number (context pairs, add pairs, paired del/add, synthesized context).
 * - `O{oldLine}` — a row that exists only on the old side: a del line in
 *   unified mode, or an unpaired del in split mode. Keyed by old-file number
 *   because no new-file number exists.
 * - `gap:{newStart}` — collapsed context keyed by its first collapsed
 *   new-file line. When expansion splits a gap, each remaining sub-gap is
 *   keyed by its own new start, so untouched regions keep their ids.
 * - `hunk:{index}` — the file's i-th hunk header, 0-based.
 *
 * Within one mode ids are unique: new-file numbers are unique across
 * context/add/synthesized rows, old-file numbers are unique across del-only
 * rows, and the prefixes separate the two numbering spaces.
 */
export type DiffRow =
  | { type: 'gap'; id: string; gap: GapInfo }
  | { type: 'hunk-header'; id: string; header: string }
  | { type: 'line'; id: string; line: DiffLine; wordSpans: WordSpan[] | null }
  | {
      type: 'pair'
      id: string
      left: DiffLine | null
      right: DiffLine | null
      wordSpansLeft: WordSpan[] | null
      wordSpansRight: WordSpan[] | null
    }

/**
 * Splits `content` into lines the way git counts them: a trailing newline
 * terminates the last line rather than opening a phantom empty one, so
 * `"a\nb\n"` → `['a', 'b']` and `""` → `[]` (a zero-line file).
 */
export function blobLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Merges `add` into an existing set of expanded ranges. The result is sorted,
 * non-overlapping, and coalesced: ranges that overlap or merely touch
 * (`toNew + 1 === fromNew`) become one, so repeated "expand 20 more" clicks
 * grow a single contiguous range. Inverted input ranges are normalized.
 * Returns a new array; inputs are not mutated.
 */
export function mergeExpanded(
  ranges: ExpandedRange[],
  add: ExpandedRange,
): ExpandedRange[] {
  const incoming: ExpandedRange =
    add.fromNew <= add.toNew
      ? { fromNew: add.fromNew, toNew: add.toNew }
      : { fromNew: add.toNew, toNew: add.fromNew }
  const sorted = [...ranges.map((r) => ({ ...r })), incoming].sort(
    (a, b) => a.fromNew - b.fromNew || a.toNew - b.toNew,
  )
  const out: ExpandedRange[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && range.fromNew <= last.toNew + 1) {
      if (range.toNew > last.toNew) last.toNew = range.toNew
    } else {
      out.push(range)
    }
  }
  return out
}

/**
 * A contiguous collapsed-context region in new-file coordinates. Within a gap
 * the old/new offset is constant: `oldLine = newLine + delta`, with `delta`
 * fixed by the hunks that bound the gap.
 */
interface GapRegion {
  newStart: number
  newEnd: number
  delta: number
}

/**
 * Flattens a file model into viewer rows.
 *
 * Mode: unified emits `line` rows; split emits `pair` rows. Gap and
 * hunk-header rows are full-width in both modes.
 *
 * Pairing rule (both modes): within each maximal run of non-context lines in
 * a hunk, the k-th del pairs with the k-th add. Paired lines get word spans
 * from `intralineDiff` (null when it reports a whole-line rewrite); leftovers
 * from unequal runs get null spans and, in split mode, a null opposite side.
 * Context lines mirror to both sides of a split pair (same `DiffLine` object
 * on the left and right).
 *
 * Gaps: collapsed context before the first hunk and between hunks is derived
 * purely from hunk coordinates, so those gaps exist even with no blobs. The
 * trailing gap needs the head file's total line count, so it is emitted only
 * when `headBlobContent` is provided. Added files have no base side and thus
 * no gaps; binary/too-large models produce no rows. A model with zero hunks
 * (e.g. a rename with no content edits) renders as one whole-file gap when
 * the head blob is known.
 *
 * Expansion: each `ExpandedRange` (new-file numbers, pre-merged via
 * `mergeExpanded`; overlapping input is re-normalized here) converts the
 * intersecting part of a gap into synthesized context rows — text from
 * `headBlobContent`, both line numbers set using the gap's constant delta —
 * and the uncovered remainder stays a gap with recomputed `GapInfo`. With no
 * head blob, expansion is ignored (there is no text to synthesize).
 *
 * `baseBlobContent` is accepted for signature completeness but adds no
 * information: every gap is pure context (identical on both sides), so gap
 * geometry and expanded text derive entirely from hunk coordinates plus the
 * head blob.
 */
export function buildRows(
  model: FileDiffModel,
  opts: {
    mode: 'unified' | 'split'
    expanded: ExpandedRange[]
    headBlobContent: string | null
    baseBlobContent: string | null
  },
): DiffRow[] {
  const rows: DiffRow[] = []
  if (model.binary || model.tooLarge) return rows

  const split = opts.mode === 'split'
  const headLines =
    opts.headBlobContent === null ? null : blobLines(opts.headBlobContent)
  const expanded = normalizeExpanded(opts.expanded)
  // Added files have no old side: every hunk line is new, nothing is collapsed.
  const hasGaps = model.status !== 'added'

  if (model.hunks.length === 0) {
    if (hasGaps && model.status !== 'removed' && headLines !== null && headLines.length > 0) {
      emitGapRegion(
        rows,
        { newStart: 1, newEnd: headLines.length, delta: 0 },
        expanded,
        headLines,
        split,
      )
    }
    return rows
  }

  // Next unconsumed line on each side, tracked across hunks. A zero-count
  // side (`@@ -5,0 …` / `… +3,0 @@`) starts at the line BEFORE the change, so
  // its cursor advances past start + 1 instead of start + count.
  let oldNext = 1
  let newNext = 1

  model.hunks.forEach((hunk, index) => {
    if (hasGaps) {
      const gapNewEnd =
        hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart
      emitGapRegion(
        rows,
        { newStart: newNext, newEnd: gapNewEnd, delta: oldNext - newNext },
        expanded,
        headLines,
        split,
      )
    }

    rows.push({ type: 'hunk-header', id: `hunk:${index}`, header: hunk.header })

    const spans = computeIntralineSpans(hunk.lines)
    if (split) emitSplitLines(rows, hunk.lines, spans)
    else emitUnifiedLines(rows, hunk.lines, spans)

    oldNext =
      hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines : hunk.oldStart + 1
    newNext =
      hunk.newLines > 0 ? hunk.newStart + hunk.newLines : hunk.newStart + 1
  })

  if (
    hasGaps &&
    model.status !== 'removed' &&
    headLines !== null &&
    headLines.length >= newNext
  ) {
    emitGapRegion(
      rows,
      { newStart: newNext, newEnd: headLines.length, delta: oldNext - newNext },
      expanded,
      headLines,
      split,
    )
  }

  return rows
}

/** Re-normalizes caller-supplied ranges (sorts, merges overlap/adjacency). */
function normalizeExpanded(ranges: ExpandedRange[]): ExpandedRange[] {
  let merged: ExpandedRange[] = []
  for (const range of ranges) merged = mergeExpanded(merged, range)
  return merged
}

/**
 * Emits one collapsed region as gap rows, converting any parts covered by
 * expanded ranges into synthesized context rows. Without head-blob text the
 * whole region stays one gap regardless of expansion.
 */
function emitGapRegion(
  rows: DiffRow[],
  region: GapRegion,
  expanded: ExpandedRange[],
  headLines: string[] | null,
  split: boolean,
): void {
  if (region.newEnd < region.newStart) return
  if (headLines === null) {
    pushGap(rows, region.newStart, region.newEnd, region.delta)
    return
  }
  let cursor = region.newStart
  for (const range of expanded) {
    if (range.toNew < cursor) continue
    if (range.fromNew > region.newEnd) break
    const from = Math.max(range.fromNew, cursor)
    const to = Math.min(range.toNew, region.newEnd)
    if (to < from) continue
    if (from > cursor) pushGap(rows, cursor, from - 1, region.delta)
    for (let n = from; n <= to; n++) {
      const line: DiffLine = {
        kind: 'context',
        oldLine: n + region.delta,
        newLine: n,
        text: headLines[n - 1] ?? '',
      }
      if (split) {
        rows.push({
          type: 'pair',
          id: `R${n}`,
          left: line,
          right: line,
          wordSpansLeft: null,
          wordSpansRight: null,
        })
      } else {
        rows.push({ type: 'line', id: `L${n}`, line, wordSpans: null })
      }
    }
    cursor = to + 1
  }
  if (cursor <= region.newEnd) pushGap(rows, cursor, region.newEnd, region.delta)
}

function pushGap(
  rows: DiffRow[],
  newStart: number,
  newEnd: number,
  delta: number,
): void {
  rows.push({
    type: 'gap',
    id: `gap:${newStart}`,
    gap: {
      oldStart: newStart + delta,
      oldEnd: newEnd + delta,
      newStart,
      newEnd,
      count: newEnd - newStart + 1,
    },
  })
}

/**
 * Word spans for every paired line in a hunk, keyed by `DiffLine` identity.
 * Runs of non-context lines are paired k-th del ↔ k-th add; lines absent from
 * the map (context, unpaired leftovers) have no spans.
 */
function computeIntralineSpans(
  lines: DiffLine[],
): Map<DiffLine, WordSpan[] | null> {
  const map = new Map<DiffLine, WordSpan[] | null>()
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    const pairs = Math.min(dels.length, adds.length)
    for (let k = 0; k < pairs; k++) {
      const delLine = dels[k]
      const addLine = adds[k]
      const result = intralineDiff(delLine.text, addLine.text)
      map.set(delLine, result === null ? null : result.del)
      map.set(addLine, result === null ? null : result.add)
    }
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.kind === 'context') flush()
    else if (line.kind === 'del') dels.push(line)
    else adds.push(line)
  }
  flush()
  return map
}

/**
 * Unified rows in patch order (each del run precedes its add run). Spans on a
 * del or add row come from its k-th pairing; context rows carry null.
 */
function emitUnifiedLines(
  rows: DiffRow[],
  lines: DiffLine[],
  spans: Map<DiffLine, WordSpan[] | null>,
): void {
  for (const line of lines) {
    rows.push({
      type: 'line',
      id: line.newLine !== null ? `L${line.newLine}` : `O${line.oldLine}`,
      line,
      wordSpans: spans.get(line) ?? null,
    })
  }
}

/**
 * Split rows: context mirrors to both sides; within each del/add run the k-th
 * del sits left of the k-th add, and unequal runs leave the shorter side null.
 */
function emitSplitLines(
  rows: DiffRow[],
  lines: DiffLine[],
  spans: Map<DiffLine, WordSpan[] | null>,
): void {
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    const count = Math.max(dels.length, adds.length)
    for (let k = 0; k < count; k++) {
      const left = k < dels.length ? dels[k] : null
      const right = k < adds.length ? adds[k] : null
      if (right !== null) {
        rows.push({
          type: 'pair',
          id: `R${right.newLine}`,
          left,
          right,
          wordSpansLeft: left !== null ? (spans.get(left) ?? null) : null,
          wordSpansRight: spans.get(right) ?? null,
        })
      } else if (left !== null) {
        rows.push({
          type: 'pair',
          id: `O${left.oldLine}`,
          left,
          right: null,
          wordSpansLeft: spans.get(left) ?? null,
          wordSpansRight: null,
        })
      }
    }
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.kind === 'context') {
      flush()
      rows.push({
        type: 'pair',
        id: `R${line.newLine}`,
        left: line,
        right: line,
        wordSpansLeft: null,
        wordSpansRight: null,
      })
    } else if (line.kind === 'del') {
      dels.push(line)
    } else {
      adds.push(line)
    }
  }
  flush()
}

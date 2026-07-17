import type { MouseEvent, ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { DiffLine, DiffRow, WordSpan } from '@/lib/diff'
import type { CodeToken } from '@/lib/highlight'
import type { GutterSelection } from './use-flat-rows'
import { cn } from '@/lib/cn'

/**
 * The three code-shaped diff rows: a unified `line`, a split `pair`, and a
 * `hunk-header`. Everything visual leans on the `.diff-line` base class and
 * the `data-kind` tints from globals.css so diff color stays one system.
 *
 * Gutter interactions start comment selections. The gutter targets carry
 * `tabIndex={-1}`: with thousands of virtualized rows they would destroy tab
 * order, and the same action is keyboard-reachable through the `c` shortcut.
 * A row being inside the current selection paints the draft tint inline
 * (violet = pending work) so it wins over the add/del attribute tints.
 */

export interface GutterHandlers {
  onGutterDown(path: string, side: 'LEFT' | 'RIGHT', line: number, shiftKey: boolean): void
  onGutterEnter(path: string, side: 'LEFT' | 'RIGHT', line: number): void
}

export interface CodeRowProps extends GutterHandlers {
  path: string
  row: DiffRow
  /** Per-line tokens for the head blob (context/add sides), or null = plain. */
  headTokens: CodeToken[][] | null
  /** Per-line tokens for the base blob (del side), or null = plain. */
  baseTokens: CodeToken[][] | null
  selection: GutterSelection | null
}

// ————————————————————————————————————————————————————————————————
// Content rendering — token runs sliced at word-diff span boundaries
// ————————————————————————————————————————————————————————————————

/**
 * Renders one line of code. Tokens (when present) concatenate exactly to the
 * line text, so slicing them at word-span character offsets is safe; changed
 * slices wrap in the add/del word-emphasis class. No tokens → plain text,
 * still split at span boundaries.
 */
function renderContent(
  text: string,
  tokens: CodeToken[] | null,
  spans: WordSpan[] | null,
  wordClass: string,
): ReactNode {
  const runs: CodeToken[] = tokens ?? (text.length > 0 ? [{ content: text }] : [])
  if (runs.length === 0) return null
  if (!spans || spans.length === 0) {
    return runs.map((t, i) => (
      <span key={i} style={t.color ? { color: t.color } : undefined}>
        {t.content}
      </span>
    ))
  }
  const out: ReactNode[] = []
  let pos = 0
  let spanIdx = 0
  let piece = 0
  for (const t of runs) {
    const len = t.content.length
    let s = 0
    while (s < len) {
      const abs = pos + s
      while (spanIdx < spans.length && spans[spanIdx].end <= abs) spanIdx++
      const span: WordSpan | undefined = spans[spanIdx]
      let sliceEnd = len
      let inSpan = false
      if (span !== undefined) {
        if (abs >= span.start) {
          inSpan = true
          sliceEnd = Math.min(len, span.end - pos)
        } else {
          sliceEnd = Math.min(len, span.start - pos)
        }
      }
      out.push(
        <span
          key={piece++}
          className={inSpan ? wordClass : undefined}
          style={t.color ? { color: t.color } : undefined}
        >
          {t.content.slice(s, sliceEnd)}
        </span>,
      )
      s = sliceEnd
    }
    pos += len
  }
  return out
}

function tokensForLine(
  line: DiffLine,
  headTokens: CodeToken[][] | null,
  baseTokens: CodeToken[][] | null,
): CodeToken[] | null {
  if (line.kind === 'del') {
    return line.oldLine !== null ? (baseTokens?.[line.oldLine - 1] ?? null) : null
  }
  return line.newLine !== null ? (headTokens?.[line.newLine - 1] ?? null) : null
}

/** Which side (and line number) a gutter gesture on this line selects. */
function selectionTarget(line: DiffLine): { side: 'LEFT' | 'RIGHT'; line: number } | null {
  if (line.kind === 'del') {
    return line.oldLine !== null ? { side: 'LEFT', line: line.oldLine } : null
  }
  return line.newLine !== null ? { side: 'RIGHT', line: line.newLine } : null
}

function isSelected(
  selection: GutterSelection | null,
  path: string,
  side: 'LEFT' | 'RIGHT',
  line: number,
): boolean {
  if (!selection || selection.path !== path || selection.side !== side) return false
  const lo = Math.min(selection.anchor, selection.head)
  const hi = Math.max(selection.anchor, selection.head)
  return line >= lo && line <= hi
}

const MARKER: Record<DiffLine['kind'], { glyph: string; cls: string }> = {
  add: { glyph: '+', cls: 'text-add' },
  del: { glyph: '−', cls: 'text-del' },
  context: { glyph: '', cls: 'text-ink-faint' },
}

const WORD_CLASS: Record<DiffLine['kind'], string> = {
  add: 'diff-word-add',
  del: 'diff-word-del',
  context: '',
}

/** The hover-revealed "start a comment" affordance inside a gutter target. */
function PlusHint({ group }: { group: 'row' | 'half' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-0 left-0.5 hidden items-center',
        group === 'row' ? 'group-hover/row:flex' : 'group-hover/half:flex',
      )}
    >
      <span className="flex size-3.5 items-center justify-center rounded-(--radius-xs) bg-draft text-canvas">
        <Plus size={11} strokeWidth={2} />
      </span>
    </span>
  )
}

// ————————————————————————————————————————————————————————————————
// Unified line row
// ————————————————————————————————————————————————————————————————

function UnifiedLine({
  path,
  line,
  wordSpans,
  headTokens,
  baseTokens,
  selection,
  onGutterDown,
  onGutterEnter,
}: {
  path: string
  line: DiffLine
  wordSpans: WordSpan[] | null
  headTokens: CodeToken[][] | null
  baseTokens: CodeToken[][] | null
  selection: GutterSelection | null
} & GutterHandlers) {
  const target = selectionTarget(line)
  const selected = target !== null && isSelected(selection, path, target.side, target.line)
  const marker = MARKER[line.kind]
  const tokens = tokensForLine(line, headTokens, baseTokens)

  const down = (e: MouseEvent) => {
    if (target === null) return
    e.preventDefault()
    onGutterDown(path, target.side, target.line, e.shiftKey)
  }
  const enter = () => {
    if (target !== null) onGutterEnter(path, target.side, target.line)
  }

  return (
    <div
      className={cn('diff-line group/row flex w-full', selected && 'draft-marker')}
      data-kind={line.kind}
      style={selected ? { background: 'var(--draft-tint)' } : undefined}
      onMouseEnter={enter}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={
          target !== null
            ? `Select line ${target.line} (${target.side === 'LEFT' ? 'old' : 'new'} side) to comment`
            : 'Line numbers'
        }
        className="relative flex w-[88px] flex-none select-none items-center font-mono text-2xs text-ink-faint"
        onMouseDown={down}
      >
        <PlusHint group="row" />
        <span className={cn('w-1/2 pr-1 text-right', selected && 'text-ink')}>
          {line.oldLine ?? ''}
        </span>
        <span className={cn('w-1/2 pr-2 text-right', selected && 'text-ink')}>
          {line.newLine ?? ''}
        </span>
      </button>
      <span className={cn('w-4 flex-none select-none text-center', marker.cls)} aria-hidden>
        {marker.glyph}
      </span>
      <span className="min-w-0 flex-1 overflow-x-hidden whitespace-pre pr-2">
        {renderContent(line.text, tokens, wordSpans, WORD_CLASS[line.kind])}
      </span>
    </div>
  )
}

// ————————————————————————————————————————————————————————————————
// Split pair row
// ————————————————————————————————————————————————————————————————

function SplitHalf({
  path,
  side,
  line,
  wordSpans,
  headTokens,
  baseTokens,
  selection,
  onGutterDown,
  onGutterEnter,
}: {
  path: string
  side: 'LEFT' | 'RIGHT'
  line: DiffLine | null
  wordSpans: WordSpan[] | null
  headTokens: CodeToken[][] | null
  baseTokens: CodeToken[][] | null
  selection: GutterSelection | null
} & GutterHandlers) {
  if (line === null) {
    return (
      <div className="diff-line w-1/2 min-w-0 bg-canvas" aria-hidden>
        <span className="inline-block w-11">&nbsp;</span>
      </div>
    )
  }
  const num = side === 'LEFT' ? line.oldLine : line.newLine
  const selected = num !== null && isSelected(selection, path, side, num)
  // A context line mirrored to the left half still selects/tokenizes by its
  // head-side number: the text is identical and RIGHT is the side GitHub
  // accepts for unchanged lines.
  const effSide: 'LEFT' | 'RIGHT' = line.kind === 'del' ? 'LEFT' : 'RIGHT'
  const effLine = effSide === 'LEFT' ? line.oldLine : line.newLine
  const marker = MARKER[line.kind]
  const tokens = tokensForLine(line, headTokens, baseTokens)
  const kindAttr = line.kind === 'context' ? undefined : line.kind

  const down = (e: MouseEvent) => {
    if (effLine === null) return
    e.preventDefault()
    onGutterDown(path, effSide, effLine, e.shiftKey)
  }
  const enter = () => {
    if (effLine !== null) onGutterEnter(path, effSide, effLine)
  }

  return (
    <div
      className={cn('diff-line group/half flex w-1/2 min-w-0', selected && 'draft-marker')}
      data-kind={kindAttr}
      style={selected ? { background: 'var(--draft-tint)' } : undefined}
      onMouseEnter={enter}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={
          effLine !== null
            ? `Select line ${effLine} (${effSide === 'LEFT' ? 'old' : 'new'} side) to comment`
            : 'Line number'
        }
        className="relative w-11 flex-none select-none pr-2 text-right font-mono text-2xs text-ink-faint"
        onMouseDown={down}
      >
        <PlusHint group="half" />
        <span className={cn(selected && 'text-ink')}>{num ?? ''}</span>
      </button>
      <span className={cn('w-4 flex-none select-none text-center', marker.cls)} aria-hidden>
        {marker.glyph}
      </span>
      <span className="min-w-0 flex-1 overflow-x-hidden whitespace-pre pr-2">
        {renderContent(line.text, tokens, wordSpans, WORD_CLASS[line.kind])}
      </span>
    </div>
  )
}

// ————————————————————————————————————————————————————————————————
// Public row component
// ————————————————————————————————————————————————————————————————

export function CodeRow(props: CodeRowProps) {
  const { row } = props

  if (row.type === 'hunk-header') {
    return (
      <div className="diff-line w-full overflow-x-hidden bg-(--diff-hunk-bg) px-2 text-2xs leading-5 text-ink-faint">
        {row.header}
      </div>
    )
  }

  if (row.type === 'line') {
    return (
      <UnifiedLine
        path={props.path}
        line={row.line}
        wordSpans={row.wordSpans}
        headTokens={props.headTokens}
        baseTokens={props.baseTokens}
        selection={props.selection}
        onGutterDown={props.onGutterDown}
        onGutterEnter={props.onGutterEnter}
      />
    )
  }

  if (row.type === 'pair') {
    return (
      <div className="flex w-full">
        <SplitHalf
          path={props.path}
          side="LEFT"
          line={row.left}
          wordSpans={row.wordSpansLeft}
          headTokens={props.headTokens}
          baseTokens={props.baseTokens}
          selection={props.selection}
          onGutterDown={props.onGutterDown}
          onGutterEnter={props.onGutterEnter}
        />
        <div className="w-px flex-none bg-line" aria-hidden />
        <SplitHalf
          path={props.path}
          side="RIGHT"
          line={row.right}
          wordSpans={row.wordSpansRight}
          headTokens={props.headTokens}
          baseTokens={props.baseTokens}
          selection={props.selection}
          onGutterDown={props.onGutterDown}
          onGutterEnter={props.onGutterEnter}
        />
      </div>
    )
  }

  // Gap rows are rendered by GapRow; reaching here means a new row type was
  // added to the diff engine without a renderer. Render nothing rather than lie.
  return null
}
CodeRow.displayName = 'CodeRow'

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, FileWarning } from 'lucide-react'
import type { ExpandedRange, FileDiffModel } from '@/lib/diff'
import { useFileTokens } from '@/lib/highlight'
import type { CodeToken } from '@/lib/highlight'
import type { FileViewedState } from '@/api/types'
import { ThreadCard } from '@/components/threads/thread-card'
import { CommentComposer } from '@/components/threads/composer'
import { PendingCommentCard } from '@/components/review/pending-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CodeRow } from './code-row'
import type { GutterHandlers } from './code-row'
import { FileHeaderRow } from './file-header-row'
import { GapRow } from './gap-row'
import type { ComposerAnchor, FlatRow, GutterSelection } from './use-flat-rows'
import { cn } from '@/lib/cn'

/**
 * The virtualized diff stream: one `useVirtualizer` over the whole flat row
 * array (every file's headers, code, threads, drafts, notices). Rows are
 * absolutely positioned and re-measured on mount, so estimates only steer
 * initial scrollbar math; `estimateRowSize` keys off row kind.
 *
 * Syntax tokens load through invisible per-file `TokenLoader`s — exactly one
 * `useFileTokens` subscription per (file, side), never one per row, so a file
 * is tokenized once no matter how many of its rows are on screen.
 */

export interface DiffViewerHandle {
  scrollToIndex(index: number, align?: 'start' | 'center' | 'auto'): void
}

/** The composer's live editing state, owned by the page. */
export interface ComposerState {
  anchor: ComposerAnchor
  text: string
  /** Selected head-side text, seeding a ```suggestion block. Null on LEFT. */
  seed: string | null
}

export interface DiffViewerProps extends GutterHandlers {
  prNumber: number
  rows: FlatRow[]
  focusedThreadId: string | null
  showResolved: boolean
  /** threadId → commits landed since the thread's first comment. */
  commitsSince: ReadonlyMap<string, number>
  /** path → blob text for each side (null until loaded / when absent). */
  contents: Record<string, { head: string | null; base: string | null }>
  viewed: FileViewedState
  selection: GutterSelection | null
  composer: ComposerState | null
  onToggleCollapse(path: string): void
  onToggleViewed(path: string, viewed: boolean): void
  onExpandContext(path: string): void
  onLoadAnyway(path: string): void
  onToggleOutdated(path: string): void
  onExpandRange(path: string, range: ExpandedRange): void
  onComposerChange(text: string): void
  onComposerSubmit(): void
  onComposerCancel(): void
}

function estimateRowSize(row: FlatRow): number {
  switch (row.kind) {
    case 'file-header':
      return 36
    case 'outdated-group':
      return 28
    case 'notice':
      return 56
    case 'diff':
      if (row.row.type === 'gap') return 24
      return 20
    case 'thread':
    case 'outdated-thread':
    case 'pending':
    case 'composer':
      return 180
  }
}

/**
 * Invisible bridge from the `useFileTokens` hook to the viewer's token map.
 * One instance per (path, side-content) pair keeps worker requests deduped.
 */
function TokenLoader({
  mapKey,
  path,
  content,
  onTokens,
}: {
  mapKey: string
  path: string
  content: string
  onTokens(key: string, tokens: CodeToken[][] | null): void
}) {
  const tokens = useFileTokens(path, content)
  useEffect(() => {
    onTokens(mapKey, tokens)
  }, [mapKey, tokens, onTokens])
  return null
}

export const DiffViewer = forwardRef<DiffViewerHandle, DiffViewerProps>(function DiffViewer(
  props,
  ref,
) {
  const { rows, prNumber } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowSize(rows[index]),
    getItemKey: (index) => rows[index].key,
    overscan: 16,
  })

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, align = 'auto') {
        virtualizer.scrollToIndex(index, { align })
      },
    }),
    [virtualizer],
  )

  // ——— per-file syntax tokens ———

  const [tokensByKey, setTokensByKey] = useState<Record<string, CodeToken[][] | null>>({})
  const handleTokens = useCallback((key: string, tokens: CodeToken[][] | null) => {
    setTokensByKey((prev) => (prev[key] === tokens ? prev : { ...prev, [key]: tokens }))
  }, [])

  /** Files that currently have code rows on the page, with the sides they need. */
  const loaders = useMemo(() => {
    const models = new Map<string, FileDiffModel>()
    const codePaths = new Set<string>()
    for (const row of rows) {
      if (row.kind === 'file-header') models.set(row.path, row.model)
      else if (row.kind === 'diff' && (row.row.type === 'line' || row.row.type === 'pair')) {
        codePaths.add(row.path)
      }
    }
    const list: { mapKey: string; path: string; content: string }[] = []
    for (const path of codePaths) {
      const content = props.contents[path]
      if (!content) continue
      if (content.head !== null) list.push({ mapKey: `h:${path}`, path, content: content.head })
      const model = models.get(path)
      if (content.base !== null && model !== undefined && model.deletions > 0) {
        list.push({ mapKey: `b:${path}`, path, content: content.base })
      }
    }
    return list
  }, [rows, props.contents])

  // ——— row rendering ———

  const renderRow = (row: FlatRow) => {
    switch (row.kind) {
      case 'file-header':
        return (
          <FileHeaderRow
            file={row.file}
            model={row.model}
            collapsed={row.collapsed}
            collapseReason={row.collapseReason}
            viewed={props.viewed[row.path]?.viewed === true}
            canExpandContext={(props.contents[row.path]?.head ?? null) !== null}
            onToggleCollapse={props.onToggleCollapse}
            onToggleViewed={props.onToggleViewed}
            onExpandContext={props.onExpandContext}
          />
        )
      case 'outdated-group':
        return (
          <div className="flex h-7 w-full items-center bg-(--stale-tint) px-2">
            <button
              type="button"
              className="flex items-center gap-1.5 text-2xs text-stale hover:brightness-110"
              onClick={() => props.onToggleOutdated(row.path)}
              aria-expanded={row.expanded}
            >
              <ChevronRight
                size={12}
                strokeWidth={1.5}
                className={cn('transition-transform', row.expanded && 'rotate-90')}
                aria-hidden
              />
              <Badge variant="stale" className="font-mono">
                {row.count}
              </Badge>
              outdated {row.count === 1 ? 'thread' : 'threads'} — anchored to an earlier
              version of this file
            </button>
          </div>
        )
      case 'outdated-thread':
        return (
          <div className="w-full px-2 py-1.5">
            <ThreadCard
              prNumber={prNumber}
              thread={row.thread}
              variant="inline"
              defaultCollapsed
              focused={props.focusedThreadId === row.thread.id}
              commitsSince={props.commitsSince.get(row.thread.id) ?? 0}
            />
          </div>
        )
      case 'thread': {
        const hideResolved = row.thread.isResolved && !props.showResolved
        return (
          <div className="w-full px-2 py-1.5">
            <ThreadCard
              // Remounting when the resolved-visibility toggle flips lets
              // `defaultCollapsed` actually re-apply on already-mounted cards.
              key={`${row.thread.id}:${hideResolved}`}
              prNumber={prNumber}
              thread={row.thread}
              variant="inline"
              defaultCollapsed={hideResolved}
              focused={props.focusedThreadId === row.thread.id}
              commitsSince={props.commitsSince.get(row.thread.id) ?? 0}
            />
          </div>
        )
      }
      case 'pending':
        return (
          <div className="w-full px-2 py-1.5">
            <PendingCommentCard prNumber={prNumber} comment={row.comment} />
          </div>
        )
      case 'composer': {
        const state = props.composer
        if (!state) return null
        return (
          <div className="draft-marker w-full px-2 py-1.5">
            <CommentComposer
              value={state.text}
              onChange={props.onComposerChange}
              onSubmit={props.onComposerSubmit}
              onCancel={props.onComposerCancel}
              submitLabel="Add to review"
              placeholder={
                state.anchor.startLine !== null
                  ? `Comment on lines ${state.anchor.startLine}–${state.anchor.line}…`
                  : `Comment on line ${state.anchor.line}…`
              }
              autoFocus
              suggestionSeed={state.seed}
            />
          </div>
        )
      }
      case 'notice':
        return (
          <div className="w-full px-2 py-1.5">
            <div className="flex items-center gap-2 rounded-(--radius-sm) border border-line bg-panel px-3 py-2">
              <FileWarning size={14} strokeWidth={1.5} className="flex-none text-ink-faint" aria-hidden />
              <span className="min-w-0 flex-1 text-xs text-ink-mut">{row.text}</span>
              {row.action === 'load-anyway' && (
                <Button variant="outline" size="sm" onClick={() => props.onLoadAnyway(row.path)}>
                  Load anyway
                </Button>
              )}
            </div>
          </div>
        )
      case 'diff':
        if (row.row.type === 'gap') {
          return (
            <GapRow
              gap={row.row.gap}
              canExpand={(props.contents[row.path]?.head ?? null) !== null}
              onExpand={(range) => props.onExpandRange(row.path, range)}
            />
          )
        }
        return (
          <CodeRow
            path={row.path}
            row={row.row}
            headTokens={tokensByKey[`h:${row.path}`] ?? null}
            baseTokens={tokensByKey[`b:${row.path}`] ?? null}
            selection={props.selection}
            onGutterDown={props.onGutterDown}
            onGutterEnter={props.onGutterEnter}
          />
        )
    }
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      {loaders.map((l) => (
        <TokenLoader
          key={l.mapKey}
          mapKey={l.mapKey}
          path={l.path}
          content={l.content}
          onTokens={handleTokens}
        />
      ))}
      <div
        style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]
          return (
            <div
              key={row.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderRow(row)}
            </div>
          )
        })}
      </div>
    </div>
  )
})

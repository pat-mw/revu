import type { MouseEvent } from 'react'
import { ChevronDown, ChevronRight, UnfoldVertical } from 'lucide-react'
import type { FileDiffModel } from '@/lib/diff'
import type { PullFile } from '@/api/types'
import type { CollapseReason } from './use-flat-rows'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/cn'

/**
 * One file's header row in the diff stream: status, path (with rename
 * history), +/− counts, expand-context, the viewed checkbox, and the collapse
 * chevron. Clicking the row body toggles manual collapse; the inner controls
 * stop propagation so they never double-fire the toggle.
 */

const STATUS: Record<
  PullFile['status'],
  { letter: string; word: string; variant: 'add' | 'del' | 'stale' | 'outline' }
> = {
  added: { letter: 'A', word: 'Added', variant: 'add' },
  modified: { letter: 'M', word: 'Modified', variant: 'outline' },
  removed: { letter: 'D', word: 'Deleted', variant: 'del' },
  renamed: { letter: 'R', word: 'Renamed', variant: 'stale' },
}

export interface FileHeaderRowProps {
  file: PullFile
  model: FileDiffModel
  collapsed: boolean
  collapseReason: CollapseReason
  viewed: boolean
  /** False while the head blob is still resolving — expansion has no text yet. */
  canExpandContext: boolean
  onToggleCollapse(path: string): void
  onToggleViewed(path: string, viewed: boolean): void
  onExpandContext(path: string): void
}

export function FileHeaderRow({
  file,
  model,
  collapsed,
  collapseReason,
  viewed,
  canExpandContext,
  onToggleCollapse,
  onToggleViewed,
  onExpandContext,
}: FileHeaderRowProps) {
  const path = file.filename
  const status = STATUS[file.status]
  const stop = (e: MouseEvent) => e.stopPropagation()
  const expandable = !model.binary && !model.tooLarge

  return (
    <div
      className="hairline-t hairline-b flex h-9 w-full cursor-pointer items-center gap-2 bg-panel px-2"
      onClick={() => {
        if (expandable) onToggleCollapse(path)
      }}
      title={collapsed ? `Expand ${path}` : `Collapse ${path}`}
    >
      <Badge variant={status.variant} title={status.word} className="w-5 justify-center font-mono">
        {status.letter}
      </Badge>
      <span className="min-w-0 truncate font-mono text-xs text-ink" title={path}>
        {file.previous_filename !== undefined && (
          <>
            <span className="text-ink-faint line-through">{file.previous_filename}</span>
            <span className="text-ink-faint"> → </span>
          </>
        )}
        {path}
      </span>
      <span className="flex-none select-none font-mono text-2xs">
        <span className="text-add">+{file.additions}</span>{' '}
        <span className="text-del">−{file.deletions}</span>
      </span>
      <span className="flex-1" />
      {collapseReason !== null && collapseReason !== 'manual' && (
        <span className="hidden flex-none text-2xs text-ink-faint sm:inline">
          {collapseReason}
        </span>
      )}
      {expandable && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={`Expand all context in ${path}`}
          title="Expand all context (e)"
          disabled={!canExpandContext || collapsed}
          onClick={(e) => {
            stop(e)
            onExpandContext(path)
          }}
        >
          <UnfoldVertical size={14} strokeWidth={1.5} />
        </Button>
      )}
      <label
        className="flex flex-none cursor-pointer items-center gap-1 text-2xs text-ink-mut"
        onClick={stop}
      >
        <Checkbox
          checked={viewed}
          onCheckedChange={(checked) => onToggleViewed(path, checked === true)}
          aria-label={`Mark ${path} as viewed`}
        />
        viewed
      </label>
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-6 w-6', !expandable && 'invisible')}
        aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
        onClick={(e) => {
          stop(e)
          if (expandable) onToggleCollapse(path)
        }}
      >
        {collapsed ? (
          <ChevronRight size={14} strokeWidth={1.5} />
        ) : (
          <ChevronDown size={14} strokeWidth={1.5} />
        )}
      </Button>
    </div>
  )
}
FileHeaderRow.displayName = 'FileHeaderRow'

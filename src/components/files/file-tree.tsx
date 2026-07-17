import { useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { ChevronRight, List, Paperclip, PanelLeft } from 'lucide-react'
import type { FileDiffModel } from '@/lib/diff'
import type { FileViewedState, PullFile, SnapshotImmutable } from '@/api/types'
import { isLockfilePath } from './use-flat-rows'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'

/**
 * The left file-tree panel: viewed progress, a filter, and the changed files
 * grouped by directory. Directories with a single child directory chain into
 * one row ("a/b/c") so deep monorepo paths stay one glance wide. Selection
 * jumps the diff viewer; the viewed checkbox writes broker state keyed to the
 * file's head blob SHA so a later commit visibly invalidates the checkmark.
 */

interface FileEntry {
  file: PullFile
  model: FileDiffModel
}

interface DirNode {
  /** Display name; after chaining this may span segments ("src/lib"). */
  name: string
  /** Full path prefix of this directory (no trailing slash). */
  path: string
  dirs: DirNode[]
  files: FileEntry[]
}

function buildTree(entries: FileEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] }
  const dirFor = (segments: string[]): DirNode => {
    let node = root
    let prefix = ''
    for (const seg of segments) {
      prefix = prefix === '' ? seg : `${prefix}/${seg}`
      let next = node.dirs.find((d) => d.path === prefix)
      if (!next) {
        next = { name: seg, path: prefix, dirs: [], files: [] }
        node.dirs.push(next)
      }
      node = next
    }
    return node
  }
  for (const entry of entries) {
    const segments = entry.file.filename.split('/')
    const dir = dirFor(segments.slice(0, -1))
    dir.files.push(entry)
  }
  sortNode(root)
  chainSingleChildDirs(root)
  return root
}

function sortNode(node: DirNode): void {
  node.dirs.sort((a, b) => a.name.localeCompare(b.name))
  node.files.sort((a, b) => a.file.filename.localeCompare(b.file.filename))
  for (const d of node.dirs) sortNode(d)
}

/** Collapse chains like a → b → c (single child, no files) into one "a/b/c" row. */
function chainSingleChildDirs(node: DirNode): void {
  for (let i = 0; i < node.dirs.length; i++) {
    let dir = node.dirs[i]
    while (dir.dirs.length === 1 && dir.files.length === 0) {
      const only = dir.dirs[0]
      dir = { name: `${dir.name}/${only.name}`, path: only.path, dirs: only.dirs, files: only.files }
      node.dirs[i] = dir
    }
    chainSingleChildDirs(dir)
  }
}

const STATUS_GLYPH: Record<PullFile['status'], { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'text-add' },
  modified: { letter: 'M', cls: 'text-ink-mut' },
  removed: { letter: 'D', cls: 'text-del' },
  renamed: { letter: 'R', cls: 'text-stale' },
}

function fileBasename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

export interface FileTreeProps {
  immutable: SnapshotImmutable
  models: FileDiffModel[]
  viewed: FileViewedState
  focusedPath: string | null
  onSelect(path: string): void
  onToggleViewed(path: string, viewed: boolean): void
  onCollapsePanel(): void
}

export function FileTree({
  immutable,
  models,
  viewed,
  focusedPath,
  onSelect,
  onToggleViewed,
  onCollapsePanel,
}: FileTreeProps) {
  const [filter, setFilter] = useState('')
  const [closedDirs, setClosedDirs] = useState<ReadonlySet<string>>(new Set())

  const entries = useMemo<FileEntry[]>(
    () => immutable.files.map((file, i) => ({ file, model: models[i] })),
    [immutable.files, models],
  )

  const query = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      query === ''
        ? entries
        : entries.filter((e) => e.file.filename.toLowerCase().includes(query)),
    [entries, query],
  )
  const tree = useMemo(() => buildTree(visible), [visible])

  const total = entries.length
  const viewedCount = entries.filter((e) => viewed[e.file.filename]?.viewed === true).length
  const pct = total === 0 ? 0 : Math.round((viewedCount / total) * 100)

  const toggleDir = (path: string) => {
    setClosedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderFile = (entry: FileEntry, depth: number) => {
    const path = entry.file.filename
    const status = STATUS_GLYPH[entry.file.status]
    const isViewed = viewed[path]?.viewed === true
    const noCounts = entry.model.binary || isLockfilePath(path)
    const stop = (e: MouseEvent) => e.stopPropagation()
    return (
      <div
        key={path}
        className={cn(
          'flex h-6 w-full items-center gap-1.5 pr-2',
          focusedPath === path && 'bg-raised',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onSelect(path)}
          title={path}
        >
          <span className={cn('w-3 flex-none font-mono text-2xs', status.cls)} aria-hidden>
            {status.letter}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              isViewed ? 'text-ink-faint' : 'text-ink',
            )}
          >
            {fileBasename(path)}
          </span>
          {noCounts ? (
            entry.model.binary ? (
              <Paperclip
                size={12}
                strokeWidth={1.5}
                className="flex-none text-ink-faint"
                aria-label="Binary file"
              />
            ) : (
              <List
                size={12}
                strokeWidth={1.5}
                className="flex-none text-ink-faint"
                aria-label="Lockfile"
              />
            )
          ) : (
            <span className="flex-none select-none font-mono text-2xs">
              <span className="text-add">+{entry.file.additions}</span>{' '}
              <span className="text-del">−{entry.file.deletions}</span>
            </span>
          )}
        </button>
        <span onClick={stop} className="flex flex-none items-center">
          <Checkbox
            checked={isViewed}
            onCheckedChange={(checked) => onToggleViewed(path, checked === true)}
            aria-label={`Mark ${path} as viewed`}
          />
        </span>
      </div>
    )
  }

  const renderDir = (dir: DirNode, depth: number) => {
    // While filtering, every matching branch stays open for scannability.
    const closed = query === '' && closedDirs.has(dir.path)
    return (
      <div key={dir.path}>
        <button
          type="button"
          className="flex h-6 w-full items-center gap-1 pr-2 text-left text-xs text-ink-mut hover:text-ink"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => toggleDir(dir.path)}
          aria-expanded={!closed}
          title={dir.path}
        >
          <ChevronRight
            size={12}
            strokeWidth={1.5}
            className={cn('flex-none transition-transform', !closed && 'rotate-90')}
            aria-hidden
          />
          <span className="min-w-0 truncate">{dir.name}</span>
        </button>
        {!closed && (
          <>
            {dir.dirs.map((d) => renderDir(d, depth + 1))}
            {dir.files.map((f) => renderFile(f, depth + 1))}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="hairline-r flex w-60 flex-none flex-col bg-panel">
      <div className="hairline-b flex flex-col gap-1.5 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="flex-1 text-2xs text-ink-mut">
            {viewedCount} of {total} viewed
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            aria-label="Collapse file tree"
            onClick={onCollapsePanel}
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </Button>
        </div>
        <div
          className="h-0.5 w-full rounded-full bg-raised"
          role="progressbar"
          aria-valuenow={viewedCount}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Files viewed"
        >
          <div className="h-full rounded-full bg-ink-mut" style={{ width: `${pct}%` }} />
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter files…"
          className="h-6 text-xs"
          aria-label="Filter files"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-faint">No files match “{filter.trim()}”.</p>
        ) : (
          <>
            {tree.dirs.map((d) => renderDir(d, 0))}
            {tree.files.map((f) => renderFile(f, 0))}
          </>
        )}
      </div>
    </div>
  )
}
FileTree.displayName = 'FileTree'

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

/**
 * Cross-screen surface of the Files page. Any tab or dock that wants to point
 * the diff viewer somewhere (a thread, a pending comment, a file, a line) goes
 * through this API instead of reaching into the viewer's internals.
 *
 * The context is provided only while the Files page is mounted; everywhere
 * else `useFilesView()` returns `null` and callers fall back to navigation
 * with a location hash (`#thread-{id}` · `#comment-{pendingKey}` ·
 * `#file-{encodeURIComponent(path)}`), which the Files page resolves on mount.
 */

export interface JumpTarget {
  path: string
  line?: number
  side?: 'LEFT' | 'RIGHT'
  threadId?: string
  pendingKey?: string
}

export interface FilesViewApi {
  /** Scroll the viewer to a target, expanding its file (and gaps) as needed. */
  jumpTo(t: JumpTarget): void
  /** The file the viewer currently considers focused (j/k, tree selection). */
  focusedPath: string | null
  mode: 'unified' | 'split'
  setMode(m: 'unified' | 'split'): void
  /** Open the inline comment composer anchored at a specific diff line. */
  openComposerAt(t: {
    path: string
    line: number
    side: 'LEFT' | 'RIGHT'
    startLine?: number | null
  }): void
  /** Whether the author queue dock is open on the right edge of the viewer. */
  queueOpen: boolean
  setQueueOpen(open: boolean): void
}

const FilesViewContext = createContext<FilesViewApi | null>(null)

/**
 * Mounted by the Files page around its workbench; the page constructs the api
 * object (it owns the virtualizer the jumps land in).
 */
export function FilesViewProvider({
  value,
  children,
}: {
  value: FilesViewApi
  children: ReactNode
}) {
  return <FilesViewContext.Provider value={value}>{children}</FilesViewContext.Provider>
}

/** The Files page api, or `null` anywhere outside the Files page. */
export function useFilesView(): FilesViewApi | null {
  return useContext(FilesViewContext)
}

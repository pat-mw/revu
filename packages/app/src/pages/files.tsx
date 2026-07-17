import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router'
import { useQueries } from '@tanstack/react-query'
import { AlertTriangle, CloudDownload, PanelLeft } from 'lucide-react'

import { api } from '@/api'
import type { ApiError, FileBlob, FileViewedState, PendingComment, ReviewThread, Snapshot } from '@revu/shared'
import { blobLines, mergeExpanded } from '@/lib/diff'
import type { ExpandedRange } from '@/lib/diff'
import { formatKeys, useShortcut } from '@/lib/keyboard'
import { minutesUntil } from '@/lib/time'
import { qk, usePullItem, useSnapshot, useSyncPull } from '@/state/queries'
import { makePendingComment, useDraft, useDraftActions } from '@/state/drafts'
import { useThreads } from '@/state/threads'
import { useFileViewed, useSetFileViewed } from '@/state/viewed'
import { usePreferences, useSetPreferences } from '@/state/preferences'
import { FilesViewProvider } from '@/state/files-view'
import type { FilesViewApi, JumpTarget } from '@/state/files-view'

import { AuthorQueue } from '@/components/author/queue'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { DiffViewer } from '@/components/files/diff-viewer'
import type { ComposerState, DiffViewerHandle } from '@/components/files/diff-viewer'
import { FileTree } from '@/components/files/file-tree'
import {
  diffRowMatchesLine,
  firstChangedLine,
  gapRangesForPath,
  lineTextFromModel,
  useFileContents,
  useFileModels,
  useFlatRows,
} from '@/components/files/use-flat-rows'
import type { ComposerAnchor, DiffMode, GutterSelection } from '@/components/files/use-flat-rows'
import { cn } from '@/lib/cn'

/**
 * The Files tab — where review actually happens. Everything renders from the
 * local snapshot; the only network moment on this screen is the explicit sync
 * (first sync from the empty state, retry from the partial banner).
 */

/** Stable empties so "no data yet" never churns the flat-row memo. */
const EMPTY_VIEWED: FileViewedState = {}
const EMPTY_PENDING: PendingComment[] = []
const EMPTY_THREADS: ReviewThread[] = []

// ————————————————————————————————————————————————————————————————
// Entry: route param → snapshot state machine
// ————————————————————————————————————————————————————————————————

export function FilesPage() {
  const params = useParams()
  const prNumber = Number(params.n)
  const snapshotQ = useSnapshot(prNumber)

  if (snapshotQ.isPending) return <FilesSkeleton />
  if (snapshotQ.isError) {
    return (
      <div className="flex h-full items-start justify-center p-6">
        <ErrorState
          className="w-full max-w-md"
          title="Couldn't read the local snapshot"
          detail={snapshotQ.error.message}
          retry={() => void snapshotQ.refetch()}
        />
      </div>
    )
  }
  if (snapshotQ.data === null) return <NeverSynced prNumber={prNumber} />
  return <FilesWorkbench prNumber={prNumber} snapshot={snapshotQ.data} />
}

// ————————————————————————————————————————————————————————————————
// Loading skeleton — tree panel + 30 diff-line placeholders
// ————————————————————————————————————————————————————————————————

function FilesSkeleton() {
  return (
    <div className="flex h-full min-h-0">
      <div className="hairline-r hidden w-60 flex-none flex-col gap-2 bg-panel p-2 md:flex">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-0.5 w-full" />
        <Skeleton className="h-6 w-full" />
        {Array.from({ length: 14 }, (_, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 29) % 40)}%` }} />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="hairline-b flex h-8 flex-none items-center gap-2 px-2">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-40" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Skeleton className="h-9 w-full rounded-none" />
          {Array.from({ length: 30 }, (_, i) => (
            <div key={i} className="flex h-5 items-center gap-3 px-2">
              <Skeleton className="h-3 w-16 flex-none" />
              <Skeleton className="h-3" style={{ width: `${20 + ((i * 37) % 55)}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ————————————————————————————————————————————————————————————————
// Never-synced empty state
// ————————————————————————————————————————————————————————————————

/**
 * Coarse pre-sync request estimate: three metadata calls plus a couple of
 * blob fetches per commit's worth of touched files. Honest as an order of
 * magnitude — the exact count exists only after the sync reports its stats.
 */
function estimateSyncRequests(commitCount: number | undefined): number {
  if (commitCount === undefined) return 25
  return 3 + Math.max(8, commitCount * 3)
}

function syncErrorCopy(error: ApiError): { title: string; detail: string } {
  if (error.code === 'rate_limited') {
    const minutes = error.resetAt !== undefined ? minutesUntil(error.resetAt) : null
    return {
      title: 'Sync failed',
      detail:
        minutes !== null
          ? `Rate limit exhausted. Resets in ${minutes} minutes.`
          : 'Rate limit exhausted on the shared bucket.',
    }
  }
  if (error.code === 'network') {
    // The transport's message names what was kept (e.g. a partial snapshot).
    return { title: 'Sync interrupted', detail: error.message }
  }
  return { title: "Couldn't sync this pull request", detail: error.message }
}

function NeverSynced({ prNumber }: { prNumber: number }) {
  const item = usePullItem(prNumber)
  const sync = useSyncPull(prNumber)
  const est = estimateSyncRequests(item?.broker.commitCount)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6">
      <EmptyState
        icon={<CloudDownload size={20} strokeWidth={1.5} />}
        title="This PR was never synced"
        hint={`One sync pulls the diff, every thread, and enough blob context to expand any hunk (~${est} requests from the shared 5,000/hr bucket). After that, review is entirely local — it works with the network gone.`}
        action={
          <Button variant="primary" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? (
              <>
                <Spinner size={12} label="Syncing" className="border-canvas/40 border-t-canvas" />
                Syncing…
              </>
            ) : (
              'Sync now'
            )}
          </Button>
        }
      />
      {sync.isError && (
        <ErrorState
          className="w-full max-w-md"
          {...syncErrorCopy(sync.error)}
          retry={() => sync.mutate()}
          retryLabel="Retry sync"
        />
      )}
    </div>
  )
}

// ————————————————————————————————————————————————————————————————
// Blob loading — every SHA the snapshot references, content-addressed
// ————————————————————————————————————————————————————————————————

/** Module-level so `useQueries` can memoize the combined map between renders. */
function combineBlobResults(results: { data: FileBlob | undefined }[]): Record<string, FileBlob> {
  const map: Record<string, FileBlob> = {}
  for (const r of results) {
    const blob = r.data
    if (blob !== undefined) map[blob.sha] = blob
  }
  return map
}

function useSnapshotBlobs(snapshot: Snapshot): Record<string, FileBlob> {
  const shas = useMemo(() => {
    const wanted = new Set<string>()
    for (const entry of Object.values(snapshot.immutable.blobIndex)) {
      if (entry.base !== null) wanted.add(entry.base)
      if (entry.head !== null) wanted.add(entry.head)
    }
    // A partial snapshot names blobs the store does not have; querying them
    // would only error. The flat-row build already treats those as missing.
    for (const missing of snapshot.partial?.missingBlobShas ?? []) wanted.delete(missing)
    return [...wanted]
  }, [snapshot])

  return useQueries({
    queries: shas.map((sha) => ({
      queryKey: qk.blob(sha),
      queryFn: () => api.getBlob(sha),
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
    combine: combineBlobResults,
  })
}

// ————————————————————————————————————————————————————————————————
// Hash grammar — #thread-{id} · #comment-{pendingKey} · #file-{encodedPath}
// ————————————————————————————————————————————————————————————————

function parseFilesHash(hash: string): JumpTarget | null {
  if (hash.startsWith('#thread-')) return { path: '', threadId: hash.slice('#thread-'.length) }
  if (hash.startsWith('#comment-')) return { path: '', pendingKey: hash.slice('#comment-'.length) }
  if (hash.startsWith('#file-')) {
    try {
      return { path: decodeURIComponent(hash.slice('#file-'.length)) }
    } catch {
      return null
    }
  }
  return null
}

/** A jump waiting for the flat rows that can satisfy it. */
type InternalJump =
  | { kind: 'target'; target: JumpTarget; stage: 0 | 1 }
  | { kind: 'composer'; path: string }

function anchorKey(a: ComposerAnchor): string {
  return `${a.path}|${a.side}|${a.line}|${a.startLine ?? ''}`
}

// ————————————————————————————————————————————————————————————————
// The workbench — tree | virtualized diff | (author queue dock)
// ————————————————————————————————————————————————————————————————

function FilesWorkbench({ prNumber, snapshot }: { prNumber: number; snapshot: Snapshot }) {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  // ——— view state ———
  // The diff layout is a per-human preference persisted behind the adapter, so
  // it survives a reload and a workspace rebuild. Until the query resolves it
  // reads as the default; a toggle writes through the store optimistically.
  const setPreferences = useSetPreferences()
  const setPreferencesMutate = setPreferences.mutate
  const mode: DiffMode = usePreferences().data?.diffMode ?? 'unified'
  const setMode = useCallback(
    (m: DiffMode) => {
      if (m !== mode) setPreferencesMutate({ diffMode: m })
    },
    // `mutate` is stable across renders; depending on it (not the whole mutation
    // object, which churns with mutation state) keeps this memo from recreating.
    [mode, setPreferencesMutate],
  )

  const [treeOpen, setTreeOpen] = useState<boolean>(
    () => !window.matchMedia('(max-width: 1100px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)')
    const onChange = (e: MediaQueryListEvent) => setTreeOpen(!e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const [queueOpen, setQueueOpen] = useState<boolean>(() => searchParams.get('queue') === '1')
  // `?queue=1` can also arrive while already mounted (the author banner and
  // command palette navigate to it from this same page) — honor it, then own
  // the state locally again.
  useEffect(() => {
    if (searchParams.get('queue') === '1') {
      setQueueOpen(true)
      const next = new URLSearchParams(searchParams)
      next.delete('queue')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])
  const [expandedByPath, setExpandedByPath] = useState<Record<string, ExpandedRange[]>>({})
  const [collapseOverride, setCollapseOverride] = useState<Record<string, boolean>>({})
  const [outdatedOpenByPath, setOutdatedOpenByPath] = useState<Record<string, boolean>>({})
  const [showResolved, setShowResolved] = useState(false)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null)
  const [selection, setSelection] = useState<GutterSelection | null>(null)
  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [pendingJump, setPendingJump] = useState<InternalJump | null>(null)

  /** Text of canceled composers, restored when the same anchor reopens. */
  const canceledTextRef = useRef(new Map<string, string>())
  const draggingRef = useRef(false)
  const viewerRef = useRef<DiffViewerHandle | null>(null)

  // ——— data ———
  const sync = useSyncPull(prNumber)
  const threads = useThreads(prNumber) ?? EMPTY_THREADS
  const draft = useDraft(prNumber).data ?? null
  const draftActions = useDraftActions(prNumber)
  const viewed = useFileViewed(prNumber).data ?? EMPTY_VIEWED
  const setViewed = useSetFileViewed(prNumber)

  const blobsBySha = useSnapshotBlobs(snapshot)
  const models = useFileModels(snapshot)
  const contents = useFileContents(snapshot, blobsBySha)
  const pendingComments = draft?.comments ?? EMPTY_PENDING

  const composerAnchor = composer?.anchor ?? null
  const flatRows = useFlatRows({
    snapshot,
    models,
    contents,
    mode,
    expandedByPath,
    collapseOverride,
    outdatedOpenByPath,
    viewed,
    threads,
    pendingComments,
    composer: composerAnchor,
  })

  const filePaths = useMemo(
    () => snapshot.immutable.files.map((f) => f.filename),
    [snapshot.immutable.files],
  )
  const modelByPath = useMemo(() => {
    const map = new Map<string, (typeof models)[number]>()
    snapshot.immutable.files.forEach((f, i) => map.set(f.filename, models[i]))
    return map
  }, [snapshot.immutable.files, models])

  const commitsSince = useMemo(() => {
    const map = new Map<string, number>()
    const commits = snapshot.immutable.commits
    for (const t of threads) {
      const first = t.comments[0]
      map.set(
        t.id,
        first === undefined
          ? 0
          : commits.filter((c) => c.commit.author.date > first.created_at).length,
      )
    }
    return map
  }, [snapshot.immutable.commits, threads])

  const resolvedCount = useMemo(
    () => threads.filter((t) => t.isResolved && !t.isOutdated).length,
    [threads],
  )
  const outdatedPaths = useMemo(() => {
    const set = new Set<string>()
    for (const t of threads) if (t.isOutdated) set.add(t.path)
    return [...set]
  }, [threads])
  const outdatedCount = useMemo(() => threads.filter((t) => t.isOutdated).length, [threads])
  const anyOutdatedOpen = outdatedPaths.some((p) => outdatedOpenByPath[p] === true)

  // ——— file-level actions ———

  const expandFile = useCallback((path: string) => {
    setCollapseOverride((prev) => (prev[path] === false ? prev : { ...prev, [path]: false }))
  }, [])

  const toggleCollapse = useCallback(
    (path: string) => {
      const header = flatRows.find((r) => r.kind === 'file-header' && r.path === path)
      const collapsed = header !== undefined && header.kind === 'file-header' && header.collapsed
      setCollapseOverride((prev) => ({ ...prev, [path]: !collapsed }))
    },
    [flatRows],
  )

  const expandAllGaps = useCallback(
    (path: string) => {
      const ranges = gapRangesForPath(flatRows, path)
      if (ranges.length === 0) return
      setExpandedByPath((prev) => {
        let merged = prev[path] ?? []
        for (const r of ranges) merged = mergeExpanded(merged, r)
        return { ...prev, [path]: merged }
      })
    },
    [flatRows],
  )

  const expandRange = useCallback((path: string, range: ExpandedRange) => {
    setExpandedByPath((prev) => ({ ...prev, [path]: mergeExpanded(prev[path] ?? [], range) }))
  }, [])

  const toggleViewed = useCallback(
    (path: string, next: boolean) => {
      setViewed.mutate({
        path,
        viewed: next,
        blobSha: snapshot.immutable.blobIndex[path]?.head ?? null,
      })
    },
    [setViewed, snapshot.immutable.blobIndex],
  )

  const toggleOutdated = useCallback((path: string) => {
    setOutdatedOpenByPath((prev) => ({ ...prev, [path]: prev[path] !== true }))
  }, [])

  const toggleAllOutdated = useCallback(() => {
    const open = !anyOutdatedOpen
    setOutdatedOpenByPath(() => {
      const next: Record<string, boolean> = {}
      for (const p of outdatedPaths) next[p] = open
      return next
    })
  }, [anyOutdatedOpen, outdatedPaths])

  // ——— composer & selection ———

  const openComposer = useCallback(
    (anchor: ComposerAnchor) => {
      // A composer displaced by a new anchor keeps its text for later.
      if (
        composer !== null &&
        composer.text.trim() !== '' &&
        anchorKey(composer.anchor) !== anchorKey(anchor)
      ) {
        canceledTextRef.current.set(anchorKey(composer.anchor), composer.text)
      }
      const fc = contents[anchor.path]
      const headLines = fc !== undefined && fc.head !== null ? blobLines(fc.head) : null
      const seed =
        anchor.side === 'RIGHT' && headLines !== null
          ? headLines.slice((anchor.startLine ?? anchor.line) - 1, anchor.line).join('\n')
          : null
      setComposer({
        anchor,
        text: canceledTextRef.current.get(anchorKey(anchor)) ?? '',
        seed,
      })
      setSelection({
        path: anchor.path,
        side: anchor.side,
        anchor: anchor.startLine ?? anchor.line,
        head: anchor.line,
      })
      expandFile(anchor.path)
      setPendingJump({ kind: 'composer', path: anchor.path })
    },
    [composer, contents, expandFile],
  )

  const closeComposer = useCallback(
    (preserveText: boolean) => {
      if (composer !== null) {
        const key = anchorKey(composer.anchor)
        if (preserveText && composer.text.trim() !== '') {
          canceledTextRef.current.set(key, composer.text)
        } else if (!preserveText) {
          canceledTextRef.current.delete(key)
        }
      }
      setComposer(null)
      setSelection(null)
    },
    [composer],
  )

  const submitComposer = useCallback(() => {
    if (composer === null || composer.text.trim() === '') return
    const { anchor } = composer
    const fc = contents[anchor.path]
    const sideContent = anchor.side === 'RIGHT' ? (fc?.head ?? null) : (fc?.base ?? null)
    const lines = sideContent !== null ? blobLines(sideContent) : null
    const model = modelByPath.get(anchor.path)
    const lineText =
      lines?.[anchor.line - 1] ??
      (model !== undefined ? lineTextFromModel(model, anchor.side, anchor.line) : null) ??
      ''
    const contextBefore = lines !== null ? lines.slice(Math.max(0, anchor.line - 4), anchor.line - 1) : []
    const contextAfter = lines !== null ? lines.slice(anchor.line, anchor.line + 3) : []
    draftActions.ensureDraft({
      headSha: snapshot.immutable.headSha,
      compareKey: snapshot.immutable.compareKey,
    })
    draftActions.upsertComment(
      makePendingComment({
        path: anchor.path,
        side: anchor.side,
        line: anchor.line,
        start_line: anchor.startLine,
        start_side: anchor.startLine !== null ? anchor.side : null,
        body: composer.text,
        anchor: { lineText, contextBefore, contextAfter },
      }),
    )
    canceledTextRef.current.delete(anchorKey(anchor))
    setComposer(null)
    setSelection(null)
    // The PendingCommentCard appearing inline at the anchor IS the feedback.
  }, [composer, contents, modelByPath, draftActions, snapshot])

  const commitSelection = useCallback(
    (sel: GutterSelection) => {
      const start = Math.min(sel.anchor, sel.head)
      const end = Math.max(sel.anchor, sel.head)
      openComposer({
        path: sel.path,
        side: sel.side,
        line: end,
        startLine: start === end ? null : start,
      })
    },
    [openComposer],
  )
  const commitSelectionRef = useRef(commitSelection)
  commitSelectionRef.current = commitSelection

  const onGutterDown = useCallback(
    (path: string, side: 'LEFT' | 'RIGHT', line: number, shiftKey: boolean) => {
      if (shiftKey && selection !== null && selection.path === path && selection.side === side) {
        const next = { ...selection, head: line }
        setSelection(next)
        commitSelectionRef.current(next)
        return
      }
      draggingRef.current = true
      setSelection({ path, side, anchor: line, head: line })
    },
    [selection],
  )

  const onGutterEnter = useCallback((path: string, side: 'LEFT' | 'RIGHT', line: number) => {
    if (!draggingRef.current) return
    setSelection((prev) =>
      prev !== null && prev.path === path && prev.side === side && prev.head !== line
        ? { ...prev, head: line }
        : prev,
    )
  }, [])

  const selectionRef = useRef(selection)
  selectionRef.current = selection
  useEffect(() => {
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      const sel = selectionRef.current
      if (sel !== null) commitSelectionRef.current(sel)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  // ——— jumps (tree clicks, deep links, cross-tab api) ———

  const jumpTo = useCallback(
    (t: JumpTarget) => {
      let path = t.path
      if (t.threadId !== undefined) {
        const thread = threads.find((x) => x.id === t.threadId)
        if (thread !== undefined) {
          path = thread.path
          if (thread.isOutdated) {
            const p = thread.path
            setOutdatedOpenByPath((prev) => (prev[p] === true ? prev : { ...prev, [p]: true }))
          }
        }
      } else if (t.pendingKey !== undefined) {
        const pc = draft?.comments.find((c) => c.key === t.pendingKey)
        if (pc !== undefined) path = pc.path
      }
      if (path !== '') {
        setFocusedPath(path)
        expandFile(path)
      }
      setPendingJump({ kind: 'target', target: { ...t, path }, stage: 0 })
    },
    [threads, draft, expandFile],
  )
  const jumpToRef = useRef(jumpTo)
  jumpToRef.current = jumpTo

  // Resolve a queued jump once the flat rows contain its row (a jump can
  // require expanding a file or its gaps first, which lands a render later).
  useEffect(() => {
    if (pendingJump === null) return
    if (pendingJump.kind === 'composer') {
      const idx = flatRows.findIndex((r) => r.kind === 'composer' && r.path === pendingJump.path)
      if (idx !== -1) viewerRef.current?.scrollToIndex(idx, 'center')
      setPendingJump(null)
      return
    }
    const { target, stage } = pendingJump
    let idx = -1
    let align: 'start' | 'center' = 'center'
    if (target.threadId !== undefined) {
      idx = flatRows.findIndex(
        (r) => (r.kind === 'thread' || r.kind === 'outdated-thread') && r.thread.id === target.threadId,
      )
      if (idx !== -1) {
        setFocusedThreadId(target.threadId)
        setFocusedPath(flatRows[idx].path)
      }
    } else if (target.pendingKey !== undefined) {
      idx = flatRows.findIndex((r) => r.kind === 'pending' && r.comment.key === target.pendingKey)
    } else if (target.line !== undefined) {
      const line = target.line
      const side = target.side ?? 'RIGHT'
      idx = flatRows.findIndex(
        (r) => r.kind === 'diff' && r.path === target.path && diffRowMatchesLine(r.row, side, line),
      )
    } else if (target.path !== '') {
      idx = flatRows.findIndex((r) => r.kind === 'file-header' && r.path === target.path)
      align = 'start'
    }
    if (idx !== -1) {
      viewerRef.current?.scrollToIndex(idx, align)
      setPendingJump(null)
      return
    }
    if (stage === 0 && target.line !== undefined && target.path !== '') {
      // The line may sit inside a still-collapsed gap: expand once, retry.
      expandAllGaps(target.path)
      setPendingJump({ kind: 'target', target, stage: 1 })
      return
    }
    if (target.path !== '') {
      const headerIdx = flatRows.findIndex((r) => r.kind === 'file-header' && r.path === target.path)
      if (headerIdx !== -1) viewerRef.current?.scrollToIndex(headerIdx, 'start')
    }
    setPendingJump(null)
  }, [pendingJump, flatRows, expandAllGaps])

  // Deep links: resolve the location hash on mount and on every hash change.
  useEffect(() => {
    const target = parseFilesHash(location.hash)
    if (target !== null) jumpToRef.current(target)
  }, [location.key, location.hash])

  // ——— the cross-screen api ———

  const filesViewApi = useMemo<FilesViewApi>(
    () => ({
      jumpTo,
      focusedPath,
      mode,
      setMode,
      openComposerAt: (t) =>
        openComposer({ path: t.path, line: t.line, side: t.side, startLine: t.startLine ?? null }),
      queueOpen,
      setQueueOpen,
    }),
    [jumpTo, focusedPath, mode, setMode, openComposer, queueOpen],
  )

  // ——— keyboard (all yield to the author queue while it is open) ———

  const kb = !queueOpen

  const stepFile = useCallback(
    (delta: number) => {
      if (filePaths.length === 0) return
      const cur = focusedPath !== null ? filePaths.indexOf(focusedPath) : -1
      const next =
        cur === -1
          ? delta > 0
            ? 0
            : filePaths.length - 1
          : Math.min(filePaths.length - 1, Math.max(0, cur + delta))
      const path = filePaths[next]
      setFocusedPath(path)
      const idx = flatRows.findIndex((r) => r.kind === 'file-header' && r.path === path)
      if (idx !== -1) viewerRef.current?.scrollToIndex(idx, 'start')
    },
    [filePaths, focusedPath, flatRows],
  )

  const stepThread = useCallback(
    (delta: number) => {
      const threadRows: { idx: number; id: string; path: string }[] = []
      flatRows.forEach((r, i) => {
        if (r.kind === 'thread' || r.kind === 'outdated-thread') {
          threadRows.push({ idx: i, id: r.thread.id, path: r.path })
        }
      })
      if (threadRows.length === 0) return
      const cur =
        focusedThreadId !== null ? threadRows.findIndex((t) => t.id === focusedThreadId) : -1
      const next =
        cur === -1
          ? delta > 0
            ? 0
            : threadRows.length - 1
          : (cur + delta + threadRows.length) % threadRows.length
      const t = threadRows[next]
      setFocusedThreadId(t.id)
      setFocusedPath(t.path)
      viewerRef.current?.scrollToIndex(t.idx, 'center')
    },
    [flatRows, focusedThreadId],
  )

  useShortcut('j', () => stepFile(1), { enabled: kb })
  useShortcut('k', () => stepFile(-1), { enabled: kb })
  useShortcut('n', () => stepThread(1), { enabled: kb })
  useShortcut('p', () => stepThread(-1), { enabled: kb })
  useShortcut(
    'c',
    () => {
      if (selection !== null) {
        commitSelectionRef.current(selection)
        return
      }
      const path = focusedPath ?? filePaths[0]
      if (path === undefined) return
      const model = modelByPath.get(path)
      if (model === undefined) return
      const first = firstChangedLine(model)
      if (first === null) return
      openComposer({ path, side: first.side, line: first.line, startLine: null })
    },
    { enabled: kb },
  )
  useShortcut(
    'v',
    () => {
      if (focusedPath !== null) {
        toggleViewed(focusedPath, viewed[focusedPath]?.viewed !== true)
      }
    },
    { enabled: kb },
  )
  useShortcut('u', () => setMode(mode === 'unified' ? 'split' : 'unified'), { enabled: kb })
  useShortcut(
    'e',
    () => {
      if (focusedPath !== null) expandAllGaps(focusedPath)
    },
    { enabled: kb },
  )
  useShortcut(
    '[',
    () => {
      const p = focusedPath
      if (p !== null) setCollapseOverride((prev) => ({ ...prev, [p]: true }))
    },
    { enabled: kb },
  )
  useShortcut(
    ']',
    () => {
      const p = focusedPath
      if (p !== null) setCollapseOverride((prev) => ({ ...prev, [p]: false }))
    },
    { enabled: kb },
  )
  useShortcut('o', toggleAllOutdated, { enabled: kb })
  useShortcut('h', () => setShowResolved((v) => !v), { enabled: kb })
  useShortcut('escape', () => closeComposer(true), {
    enabled: composer !== null || selection !== null,
    allowInInput: true,
  })

  // ——— render ———

  const pull = snapshot.mutable.pull

  return (
    <FilesViewProvider value={filesViewApi}>
      <div className="flex h-full min-h-0">
        {treeOpen && (
          <FileTree
            immutable={snapshot.immutable}
            models={models}
            viewed={viewed}
            focusedPath={focusedPath}
            onSelect={(path) => jumpTo({ path })}
            onToggleViewed={toggleViewed}
            onCollapsePanel={() => setTreeOpen(false)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {snapshot.partial !== null && (
            <div className="hairline-b flex items-center gap-2 border-l-2 border-l-danger bg-danger/8 px-2 py-1.5">
              <AlertTriangle size={14} strokeWidth={1.5} className="flex-none text-danger" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-ink" title={snapshot.partial.reason}>
                Partial snapshot — {snapshot.partial.reason}.{' '}
                {snapshot.partial.missingBlobShas.length} blobs missing.
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending ? 'Syncing…' : 'Retry sync'}
              </Button>
            </div>
          )}

          <div className="hairline-b flex h-8 flex-none items-center gap-2 px-2">
            {!treeOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label="Show file tree"
                onClick={() => setTreeOpen(true)}
              >
                <PanelLeft size={14} strokeWidth={1.5} />
              </Button>
            )}
            <span className="flex-none font-mono text-2xs text-ink-mut">
              {filePaths.length} files
            </span>
            <span className="flex-none select-none font-mono text-2xs">
              <span className="text-add">+{pull.additions}</span>{' '}
              <span className="text-del">−{pull.deletions}</span>
            </span>
            <div
              className="flex flex-none items-center rounded-(--radius-sm) border border-line p-px"
              role="group"
              aria-label="Diff layout"
            >
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-5 px-1.5 text-2xs', mode === 'unified' && 'bg-raised text-ink')}
                aria-pressed={mode === 'unified'}
                title="Unified layout (u toggles)"
                onClick={() => setMode('unified')}
              >
                Unified
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-5 px-1.5 text-2xs', mode === 'split' && 'bg-raised text-ink')}
                aria-pressed={mode === 'split'}
                title="Split layout (u toggles)"
                onClick={() => setMode('split')}
              >
                Split
              </Button>
            </div>
            <Kbd keys={formatKeys('u')} className="hidden lg:inline-flex" />
            <button
              type="button"
              aria-pressed={showResolved}
              title="Show resolved threads expanded (h)"
              onClick={() => setShowResolved((v) => !v)}
              className={cn(
                'inline-flex h-6 flex-none items-center gap-1 rounded-(--radius-sm) border border-line px-1.5 text-2xs',
                showResolved ? 'bg-raised text-ink' : 'text-ink-mut hover:text-ink',
              )}
            >
              resolved <span className="font-mono">{resolvedCount}</span>
            </button>
            <button
              type="button"
              aria-pressed={anyOutdatedOpen}
              title="Expand outdated thread groups (o)"
              onClick={toggleAllOutdated}
              className={cn(
                'inline-flex h-6 flex-none items-center gap-1 rounded-(--radius-sm) border border-line px-1.5 text-2xs',
                anyOutdatedOpen ? 'bg-raised text-ink' : 'text-ink-mut hover:text-ink',
              )}
            >
              outdated <span className="font-mono">{outdatedCount}</span>
            </button>
            <span className="flex-1" />
            {focusedPath !== null && (
              <span
                className="min-w-0 truncate font-mono text-2xs text-ink-faint"
                title={focusedPath}
              >
                {focusedPath}
              </span>
            )}
          </div>

          <DiffViewer
            ref={viewerRef}
            prNumber={prNumber}
            rows={flatRows}
            focusedThreadId={focusedThreadId}
            showResolved={showResolved}
            commitsSince={commitsSince}
            contents={contents}
            viewed={viewed}
            selection={selection}
            composer={composer}
            onToggleCollapse={toggleCollapse}
            onToggleViewed={toggleViewed}
            onExpandContext={expandAllGaps}
            onLoadAnyway={expandFile}
            onToggleOutdated={toggleOutdated}
            onExpandRange={expandRange}
            onGutterDown={onGutterDown}
            onGutterEnter={onGutterEnter}
            onComposerChange={(text) =>
              setComposer((prev) => (prev !== null ? { ...prev, text } : prev))
            }
            onComposerSubmit={submitComposer}
            onComposerCancel={() => closeComposer(true)}
          />
        </div>

        {queueOpen && (
          <div className="flex min-h-0 w-96 max-w-[40vw] min-w-0 flex-none flex-col overflow-hidden">
            <AuthorQueue prNumber={prNumber} />
          </div>
        )}
      </div>
    </FilesViewProvider>
  )
}

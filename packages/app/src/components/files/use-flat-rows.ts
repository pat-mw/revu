import { useMemo } from 'react'
import { buildRows, parsePatch } from '@/lib/diff'
import type { DiffRow, ExpandedRange, FileDiffModel } from '@/lib/diff'
import { languageForPath } from '@/lib/highlight'
import type { FileBlob, FileViewedState, PendingComment, PullFile, ReviewThread, Snapshot } from '@revu/shared'
/**
 * The flat row model: every file's header, diff rows, threads, pending
 * comments, notices, and the one open composer, flattened into a single array
 * the virtualizer renders. Built as one memo so scrolling never recomputes
 * anything — only the inputs listed in `useFlatRows` deps can change it.
 *
 * Row keys are stable across mode toggles, gap expansion, and blob arrival
 * (diff row ids are stable by design — see `DiffRow` in lib/diff). Scheme:
 *
 *   - `f:{path}`            file header
 *   - `og:{path}`           outdated-thread group header
 *   - `ot:{threadId}`       one outdated thread
 *   - `d:{path}:{rowId}`    diff row (`rowId` = L{n} / R{n} / O{n} / gap:{n} / hunk:{i})
 *   - `t:{threadId}`        current thread card
 *   - `pc:{pendingKey}`     pending (draft) comment card
 *   - `cx:{path}`           the open composer (at most one exists)
 *   - `n:{path}:{slug}`     notice (`binary` / `lockfile` / `big` / `toolarge` / `missing`)
 */

export type DiffMode = 'unified' | 'split'

/** Why a file renders collapsed. `binary` is the only reason that never expands. */
export type CollapseReason = 'viewed' | 'big' | 'lockfile' | 'binary' | 'manual' | null

/** An in-progress gutter selection; `anchor`/`head` are same-side line numbers. */
export interface GutterSelection {
  path: string
  side: 'LEFT' | 'RIGHT'
  anchor: number
  head: number
}

/** Where the open composer is anchored. `line` is the range end (GitHub shape). */
export interface ComposerAnchor {
  path: string
  side: 'LEFT' | 'RIGHT'
  line: number
  startLine: number | null
}

export type FlatRow = { key: string; fileIdx: number; path: string } & (
  | {
      kind: 'file-header'
      file: PullFile
      model: FileDiffModel
      collapsed: boolean
      collapseReason: CollapseReason
    }
  | { kind: 'outdated-group'; count: number; expanded: boolean }
  | { kind: 'outdated-thread'; thread: ReviewThread }
  | { kind: 'diff'; row: DiffRow }
  | { kind: 'thread'; thread: ReviewThread }
  | { kind: 'pending'; comment: PendingComment }
  | { kind: 'composer'; anchor: { line: number; side: 'LEFT' | 'RIGHT'; startLine: number | null } }
  | { kind: 'notice'; text: string; action: 'load-anyway' | null }
)

/** Per-file blob contents resolved from the content-addressed store. */
export interface FileContents {
  head: string | null
  base: string | null
  /** Size of whichever side exists, for the binary notice. Null until loaded. */
  size: number | null
}

/** Files whose diff defaults to collapsed once they exceed this many changed lines. */
const BIG_FILE_CHANGED_LINES = 500

/** How many lines one "20 more" click reveals at a gap edge. */
export const GAP_STEP = 20

// ————————————————————————————————————————————————————————————————
// Small pure helpers shared with the page (jump resolution, anchors)
// ————————————————————————————————————————————————————————————————

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/** Machine-generated lockfiles: unhighlightable AND "lock" in the filename. */
export function isLockfilePath(path: string): boolean {
  return languageForPath(path) === null && /lock/i.test(basename(path))
}

/**
 * Whether a line/pair diff row carries the given side+line. Used both for
 * inserting thread/pending/composer rows under their anchor and for resolving
 * deep-linked lines; id matching tries the L and R prefixes (mode-dependent)
 * before falling back to the row's actual line numbers, so LEFT anchors on
 * context lines (whose row id lives in new-file numbering) still resolve.
 */
export function diffRowMatchesLine(
  row: DiffRow,
  side: 'LEFT' | 'RIGHT',
  line: number,
): boolean {
  if (row.type === 'line') {
    return side === 'RIGHT' ? row.line.newLine === line : row.line.oldLine === line
  }
  if (row.type === 'pair') {
    return side === 'RIGHT'
      ? row.right !== null && row.right.newLine === line
      : row.left !== null && row.left.oldLine === line
  }
  return false
}

/**
 * Index of the diff row a side+line anchors to, or -1. Tries stable row ids
 * first — `L{n}` then `R{n}` for RIGHT anchors, `O{n}` for LEFT — then scans
 * by line number.
 */
export function findAnchorRowIndex(
  rows: DiffRow[],
  side: 'LEFT' | 'RIGHT',
  line: number,
): number {
  const ids = side === 'RIGHT' ? [`L${line}`, `R${line}`] : [`O${line}`]
  for (const id of ids) {
    const i = rows.findIndex((r) => (r.type === 'line' || r.type === 'pair') && r.id === id)
    if (i !== -1) return i
  }
  for (let i = 0; i < rows.length; i++) {
    if (diffRowMatchesLine(rows[i], side, line)) return i
  }
  return -1
}

/**
 * Text of a diff line straight from the parsed patch — the anchor-capture
 * fallback when the blob for a side has not arrived (partial snapshot).
 */
export function lineTextFromModel(
  model: FileDiffModel,
  side: 'LEFT' | 'RIGHT',
  line: number,
): string | null {
  for (const hunk of model.hunks) {
    for (const l of hunk.lines) {
      if (side === 'RIGHT' ? l.newLine === line : l.oldLine === line) return l.text
    }
  }
  return null
}

/** Every still-collapsed gap in one file's current rows, as expandable ranges. */
export function gapRangesForPath(rows: FlatRow[], path: string): ExpandedRange[] {
  const out: ExpandedRange[] = []
  for (const r of rows) {
    if (r.kind === 'diff' && r.path === path && r.row.type === 'gap') {
      out.push({ fromNew: r.row.gap.newStart, toNew: r.row.gap.newEnd })
    }
  }
  return out
}

/** First changed line of a file — where `c` opens a composer with no selection. */
export function firstChangedLine(
  model: FileDiffModel,
): { side: 'LEFT' | 'RIGHT'; line: number } | null {
  for (const hunk of model.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add' && l.newLine !== null) return { side: 'RIGHT', line: l.newLine }
      if (l.kind === 'del' && l.oldLine !== null) return { side: 'LEFT', line: l.oldLine }
    }
  }
  return null
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function sortByFirstComment(threads: ReviewThread[]): ReviewThread[] {
  return [...threads].sort((a, b) => {
    const da = a.comments[0]?.created_at ?? ''
    const db = b.comments[0]?.created_at ?? ''
    return da < db ? -1 : da > db ? 1 : 0
  })
}

// ————————————————————————————————————————————————————————————————
// Model + contents derivation (memoized per snapshot)
// ————————————————————————————————————————————————————————————————

/** Parse every file's patch exactly once per snapshot. */
export function useFileModels(snapshot: Snapshot): FileDiffModel[] {
  const files = snapshot.immutable.files
  return useMemo(() => files.map((f) => parsePatch(f)), [files])
}

/** Resolve each path's head/base blob content from the content-addressed map. */
export function useFileContents(
  snapshot: Snapshot,
  blobsBySha: Record<string, FileBlob>,
): Record<string, FileContents> {
  const files = snapshot.immutable.files
  const blobIndex = snapshot.immutable.blobIndex
  return useMemo(() => {
    const out: Record<string, FileContents> = {}
    for (const f of files) {
      const idx = blobIndex[f.filename]
      const head = idx?.head ? blobsBySha[idx.head] : undefined
      const base = idx?.base ? blobsBySha[idx.base] : undefined
      out[f.filename] = {
        head: head && !head.binary ? head.content : null,
        base: base && !base.binary ? base.content : null,
        size: head?.size ?? base?.size ?? null,
      }
    }
    return out
  }, [files, blobIndex, blobsBySha])
}

// ————————————————————————————————————————————————————————————————
// The flat row build
// ————————————————————————————————————————————————————————————————

export interface UseFlatRowsInput {
  snapshot: Snapshot
  models: FileDiffModel[]
  contents: Record<string, FileContents>
  mode: DiffMode
  /** Per-path user-expanded context ranges (new-file line numbers). */
  expandedByPath: Record<string, ExpandedRange[]>
  /**
   * Explicit collapse overrides: `true` = manually collapsed, `false` =
   * manually expanded (also how "Load anyway" defeats big/lockfile defaults).
   * Absent = defaults apply (viewed / big / lockfile).
   */
  collapseOverride: Record<string, boolean>
  /** Per-path outdated-group expansion; absent = collapsed. */
  outdatedOpenByPath: Record<string, boolean>
  viewed: FileViewedState
  threads: ReviewThread[]
  pendingComments: PendingComment[]
  composer: ComposerAnchor | null
}

export function useFlatRows(input: UseFlatRowsInput): FlatRow[] {
  const {
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
    composer,
  } = input
  return useMemo(
    () =>
      buildFlatRows({
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
        composer,
      }),
    [
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
      composer,
    ],
  )
}

function classifyCollapse(args: {
  file: PullFile
  model: FileDiffModel
  override: boolean | undefined
  isViewed: boolean
}): { collapsed: boolean; reason: CollapseReason } {
  const { file, model, override, isViewed } = args
  // Binary (and patch-omitted-for-size) files have no rows to expand into —
  // the notice is their whole body, regardless of any override.
  if (model.binary) return { collapsed: true, reason: 'binary' }
  if (model.tooLarge) return { collapsed: true, reason: 'big' }
  if (override === true) return { collapsed: true, reason: 'manual' }
  if (override === false) return { collapsed: false, reason: null }
  if (isViewed) return { collapsed: true, reason: 'viewed' }
  if (isLockfilePath(file.filename)) return { collapsed: true, reason: 'lockfile' }
  if (file.changes > BIG_FILE_CHANGED_LINES) return { collapsed: true, reason: 'big' }
  return { collapsed: false, reason: null }
}

function buildFlatRows(input: UseFlatRowsInput): FlatRow[] {
  const { snapshot, models, contents, mode, composer } = input
  const files = snapshot.immutable.files
  const missingShas = new Set(snapshot.partial?.missingBlobShas ?? [])
  const out: FlatRow[] = []

  files.forEach((file, fileIdx) => {
    const path = file.filename
    const model = models[fileIdx]
    const fileContents = contents[path] ?? { head: null, base: null, size: null }
    const headSha = snapshot.immutable.blobIndex[path]?.head ?? null
    const headMissing = headSha !== null && missingShas.has(headSha)

    const { collapsed, reason } = classifyCollapse({
      file,
      model,
      override: input.collapseOverride[path],
      isViewed: input.viewed[path]?.viewed === true,
    })

    out.push({
      key: `f:${path}`,
      fileIdx,
      path,
      kind: 'file-header',
      file,
      model,
      collapsed,
      collapseReason: reason,
    })

    if (collapsed) {
      if (reason === 'binary') {
        const size = fileContents.size
        out.push({
          key: `n:${path}:binary`,
          fileIdx,
          path,
          kind: 'notice',
          text: `Binary file${size !== null ? ` · ${formatBytes(size)}` : ''} — no text diff`,
          action: null,
        })
      } else if (model.tooLarge) {
        out.push({
          key: `n:${path}:toolarge`,
          fileIdx,
          path,
          kind: 'notice',
          text: 'GitHub did not inline this diff (file too large) — no text patch to render',
          action: null,
        })
      } else if (reason === 'lockfile') {
        out.push({
          key: `n:${path}:lockfile`,
          fileIdx,
          path,
          kind: 'notice',
          text: `Lockfile — ${file.changes} changed lines collapsed`,
          action: 'load-anyway',
        })
      } else if (reason === 'big') {
        out.push({
          key: `n:${path}:big`,
          fileIdx,
          path,
          kind: 'notice',
          text: `Large diff — ${file.changes} changed lines collapsed`,
          action: 'load-anyway',
        })
      }
      return
    }

    const fileThreads = input.threads.filter((t) => t.path === path)
    const outdated = sortByFirstComment(fileThreads.filter((t) => t.isOutdated))
    const current = sortByFirstComment(fileThreads.filter((t) => !t.isOutdated))

    if (outdated.length > 0) {
      const expanded = input.outdatedOpenByPath[path] === true
      out.push({
        key: `og:${path}`,
        fileIdx,
        path,
        kind: 'outdated-group',
        count: outdated.length,
        expanded,
      })
      if (expanded) {
        for (const t of outdated) {
          out.push({ key: `ot:${t.id}`, fileIdx, path, kind: 'outdated-thread', thread: t })
        }
      }
    }

    // File-level threads have no line anchor: they sit directly under the header.
    for (const t of current.filter((x) => x.subjectType === 'FILE')) {
      out.push({ key: `t:${t.id}`, fileIdx, path, kind: 'thread', thread: t })
    }

    if (headMissing) {
      out.push({
        key: `n:${path}:missing`,
        fileIdx,
        path,
        kind: 'notice',
        text: 'Head blob missing from the partial snapshot — hunks below render from the patch; context expansion and highlighting need a re-sync.',
        action: null,
      })
    }

    const diffRows = buildRows(model, {
      mode,
      expanded: input.expandedByPath[path] ?? [],
      headBlobContent: fileContents.head,
      baseBlobContent: fileContents.base,
    })

    // Attachments (threads / pending / composer) keyed by the index of the
    // diff row they trail. Insertion order inside a bucket is deliberate:
    // published threads, then draft comments, then the live composer.
    const attachments = new Map<number, FlatRow[]>()
    const lastIdx = diffRows.length - 1
    const attach = (idx: number, row: FlatRow): void => {
      const at = idx >= 0 ? idx : lastIdx
      const bucket = attachments.get(at)
      if (bucket) bucket.push(row)
      else attachments.set(at, [row])
    }

    for (const t of current.filter((x) => x.subjectType !== 'FILE')) {
      const idx = t.line === null ? lastIdx : findAnchorRowIndex(diffRows, t.diffSide, t.line)
      attach(idx, { key: `t:${t.id}`, fileIdx, path, kind: 'thread', thread: t })
    }
    for (const c of input.pendingComments.filter((x) => x.path === path)) {
      const idx = findAnchorRowIndex(diffRows, c.side, c.line)
      attach(idx, { key: `pc:${c.key}`, fileIdx, path, kind: 'pending', comment: c })
    }
    if (composer !== null && composer.path === path) {
      const idx = findAnchorRowIndex(diffRows, composer.side, composer.line)
      attach(idx, {
        key: `cx:${path}`,
        fileIdx,
        path,
        kind: 'composer',
        anchor: { line: composer.line, side: composer.side, startLine: composer.startLine },
      })
    }

    if (diffRows.length === 0) {
      // No renderable diff (e.g. a rename with no edits before its blob loads):
      // anchored rows still need somewhere to live — directly under the header.
      const orphans = attachments.get(lastIdx)
      if (orphans) out.push(...orphans)
      return
    }

    diffRows.forEach((row, i) => {
      out.push({ key: `d:${path}:${row.id}`, fileIdx, path, kind: 'diff', row })
      const extra = attachments.get(i)
      if (extra) out.push(...extra)
    })
  })

  return out
}

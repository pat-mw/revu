import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { api } from '@/api'
import type {
  ApiError,
  PendingComment,
  ReconcileReport,
  ReviewDraft,
  SubmitResult,
  SubmitReviewInput,
} from '@/api/types'
import { qk } from './queries'
import { useCurrentHuman } from './session'

/**
 * Draft state: the query cache is the editing surface (every mutator writes
 * it synchronously, so typing never waits on the network) and the broker is
 * the durable copy (debounced saves, because it must survive a page reload
 * and a workspace rebuild).
 *
 * Persistence discipline per PR: one debounce timer (600ms), a flush on tab
 * hide and on unmount, and on failure exactly one retry after 2s — after
 * which a `dirty` flag (readable via `useDraftDirty`) tells the review bar to
 * show "not saved". The editable text itself is never at risk: it lives in
 * the cache regardless of what the broker answered.
 */

const SAVE_DEBOUNCE_MS = 600
const RETRY_DELAY_MS = 2_000

interface PersistEntry {
  /** Debounce timer for the next save; null when nothing is scheduled. */
  saveTimer: number | null
  /** Single-retry timer armed after a failed save. */
  retryTimer: number | null
  /** Most recent draft awaiting persistence; null when the broker is caught up. */
  pending: ReviewDraft | null
  /** True once a save and its one retry both failed — the broker copy is behind. */
  dirty: boolean
}

const persistEntries = new Map<number, PersistEntry>()
const dirtyListeners = new Set<() => void>()

function entryFor(prNumber: number): PersistEntry {
  let entry = persistEntries.get(prNumber)
  if (!entry) {
    entry = { saveTimer: null, retryTimer: null, pending: null, dirty: false }
    persistEntries.set(prNumber, entry)
  }
  return entry
}

function setDirty(entry: PersistEntry, dirty: boolean): void {
  if (entry.dirty === dirty) return
  entry.dirty = dirty
  for (const listener of dirtyListeners) listener()
}

function clearTimers(entry: PersistEntry): void {
  if (entry.saveTimer !== null) {
    window.clearTimeout(entry.saveTimer)
    entry.saveTimer = null
  }
  if (entry.retryTimer !== null) {
    window.clearTimeout(entry.retryTimer)
    entry.retryTimer = null
  }
}

async function attemptSave(prNumber: number, isRetry: boolean): Promise<void> {
  const entry = entryFor(prNumber)
  const draft = entry.pending
  if (!draft) return
  try {
    await api.saveDraft(draft)
    // Mark clean only if no newer edit arrived while the save was in flight —
    // a newer edit has its own debounce timer and will save itself.
    if (entry.pending === draft) {
      entry.pending = null
      setDirty(entry, false)
    }
  } catch {
    if (entry.pending !== draft) return
    if (!isRetry) {
      if (entry.retryTimer !== null) window.clearTimeout(entry.retryTimer)
      entry.retryTimer = window.setTimeout(() => {
        entry.retryTimer = null
        void attemptSave(prNumber, true)
      }, RETRY_DELAY_MS)
    } else {
      setDirty(entry, true)
    }
  }
}

/** Schedule a debounced save; every newer edit resets the single timer. */
function scheduleSave(prNumber: number, draft: ReviewDraft): void {
  const entry = entryFor(prNumber)
  entry.pending = draft
  clearTimers(entry)
  entry.saveTimer = window.setTimeout(() => {
    entry.saveTimer = null
    void attemptSave(prNumber, false)
  }, SAVE_DEBOUNCE_MS)
}

/** Persist whatever is pending right now, skipping the debounce. */
async function flushSave(prNumber: number): Promise<void> {
  const entry = persistEntries.get(prNumber)
  if (!entry || !entry.pending) return
  clearTimers(entry)
  await attemptSave(prNumber, false)
}

/**
 * Forget everything pending for a PR. Used when the draft ceases to exist
 * (submit consumed it, or the user discarded it) so a stale debounce timer
 * cannot resurrect a deleted draft in the broker store.
 */
function dropPersistState(prNumber: number): void {
  const entry = persistEntries.get(prNumber)
  if (!entry) return
  clearTimers(entry)
  entry.pending = null
  setDirty(entry, false)
}

// ————————————————————————————————————————————————————————————————
// Hooks
// ————————————————————————————————————————————————————————————————

/**
 * The current human's draft for a PR; null when none exists. Only this client
 * ever mutates a draft, so the cache is authoritative: never stale by time,
 * invalidated only by sync (anchors may need reconciling) and identity switch.
 */
export function useDraft(prNumber: number): UseQueryResult<ReviewDraft | null, ApiError> {
  return useQuery<ReviewDraft | null, ApiError>({
    queryKey: qk.draft(prNumber),
    queryFn: () => api.getDraft(prNumber),
    staleTime: Infinity,
  })
}

/** True when a draft save (and its retry) failed — the broker copy is behind. */
export function useDraftDirty(prNumber: number): boolean {
  return useSyncExternalStore(
    (onChange) => {
      dirtyListeners.add(onChange)
      return () => {
        dirtyListeners.delete(onChange)
      }
    },
    () => persistEntries.get(prNumber)?.dirty ?? false,
  )
}

export interface DraftActions {
  /** Returns the existing draft, or creates + caches an empty one to edit into. */
  ensureDraft(init: { headSha: string; compareKey: string }): ReviewDraft
  /** Insert or replace a pending comment by its stable local key. */
  upsertComment(c: PendingComment): void
  removeComment(key: string): void
  setBody(body: string): void
  setEvent(event: ReviewDraft['event']): void
  /** Delete the draft broker-side and locally. Rejects if the broker refused. */
  discard(): Promise<void>
  /** Persist any pending edits immediately, skipping the debounce. */
  flush(): Promise<void>
}

/**
 * Mutators for the current human's draft on one PR. Every mutator updates the
 * draft cache synchronously (the UI never waits) and schedules the debounced
 * broker save.
 */
export function useDraftActions(prNumber: number): DraftActions {
  const qc = useQueryClient()
  const humanId = useCurrentHuman().id

  // Unsaved edits must survive a tab close and a route change: flush when the
  // tab hides and when the editing surface unmounts.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushSave(prNumber)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      void flushSave(prNumber)
    }
  }, [prNumber])

  return useMemo<DraftActions>(() => {
    const read = (): ReviewDraft | null =>
      qc.getQueryData<ReviewDraft | null>(qk.draft(prNumber)) ?? null
    const write = (next: ReviewDraft): void => {
      qc.setQueryData<ReviewDraft | null>(qk.draft(prNumber), next)
      scheduleSave(prNumber, next)
    }
    const mutate = (fn: (d: ReviewDraft) => ReviewDraft): void => {
      const current = read()
      if (!current) return
      write({ ...fn(current), updatedAt: new Date().toISOString() })
    }

    return {
      ensureDraft(init) {
        const existing = read()
        if (existing) return existing
        const at = new Date().toISOString()
        const draft: ReviewDraft = {
          humanId,
          prNumber,
          headSha: init.headSha,
          compareKey: init.compareKey,
          body: '',
          event: 'COMMENT',
          comments: [],
          createdAt: at,
          updatedAt: at,
        }
        // Cached but not persisted: an empty draft only becomes worth broker
        // storage once the first real edit lands (which schedules the save).
        qc.setQueryData<ReviewDraft | null>(qk.draft(prNumber), draft)
        return draft
      },
      upsertComment(c) {
        mutate((d) => {
          const existing = d.comments.find((x) => x.key === c.key)
          return {
            ...d,
            comments: existing
              ? d.comments.map((x) =>
                  x.key === c.key
                    ? { ...c, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }
                    : x,
                )
              : [...d.comments, c],
          }
        })
      },
      removeComment(key) {
        mutate((d) => ({ ...d, comments: d.comments.filter((x) => x.key !== key) }))
      },
      setBody(body) {
        mutate((d) => ({ ...d, body }))
      },
      setEvent(event) {
        mutate((d) => ({ ...d, event }))
      },
      async discard() {
        // Cancel pending saves first so a timer can't re-create the draft
        // broker-side mid-deletion. If the delete fails, the cache still
        // holds the draft and any future edit re-persists it.
        dropPersistState(prNumber)
        await api.discardDraft(prNumber)
        qc.setQueryData<ReviewDraft | null>(qk.draft(prNumber), null)
      },
      flush() {
        return flushSave(prNumber)
      },
    }
  }, [qc, humanId, prNumber])
}

/**
 * The atomic submit. Deliberately NOT optimistic: it is the one momentous,
 * all-or-nothing write in the app. `head_moved` and `forbidden` come back as
 * SUCCESSFUL results — the UI routes on them (reconcile flow, comment-instead
 * guidance); only transport failures reject.
 */
export function useSubmitReview(
  prNumber: number,
): UseMutationResult<SubmitResult, ApiError, SubmitReviewInput> {
  const qc = useQueryClient()
  return useMutation<SubmitResult, ApiError, SubmitReviewInput>({
    mutationFn: (input) => api.submitReview(input),
    onSuccess: (result) => {
      if (result.status !== 'ok') return
      // The broker consumed the draft and appended the new review + threads
      // to the snapshot's mutable half; drop stale save timers, clear the
      // draft, and refetch the snapshot so the threads appear.
      dropPersistState(prNumber)
      qc.setQueryData<ReviewDraft | null>(qk.draft(prNumber), null)
      void qc.invalidateQueries({ queryKey: qk.snapshot(prNumber) })
      void qc.invalidateQueries({ queryKey: qk.rate })
    },
  })
}

/** Classify every pending comment against the freshly synced snapshot. */
export function useReconcile(
  prNumber: number,
): UseMutationResult<ReconcileReport, ApiError, void> {
  return useMutation<ReconcileReport, ApiError, void>({
    mutationFn: () => api.reconcileDraft(prNumber),
  })
}

/** Construct a pending comment with a fresh local key and timestamps. */
export function makePendingComment(args: {
  path: string
  side: 'LEFT' | 'RIGHT'
  line: number
  start_line: number | null
  start_side: 'LEFT' | 'RIGHT' | null
  body: string
  anchor: PendingComment['anchor']
}): PendingComment {
  const at = new Date().toISOString()
  return {
    key: crypto.randomUUID(),
    path: args.path,
    side: args.side,
    start_side: args.start_side,
    line: args.line,
    start_line: args.start_line,
    body: args.body,
    createdAt: at,
    updatedAt: at,
    anchor: args.anchor,
  }
}

import { useMemo, useRef } from 'react'
import {
  QueryClient,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { api } from '@/api'
import { ApiError } from '@/api/types'
import type {
  FileBlob,
  PullListItem,
  PullListResponse,
  RateLimitInfo,
  Snapshot,
  StalenessInfo,
} from '@/api/types'

/**
 * The query layer encodes the app's cache economics:
 *
 * - The PR list is the only polling surface (ETag makes a poll free).
 * - Snapshots change only through an explicit sync — never by TTL.
 * - Blobs are content-addressed; a SHA can never go stale.
 * - Drafts and viewed state are per-human broker state that only this client
 *   mutates, so the cache is authoritative between explicit invalidations.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
})

/** Query keys. Every cache interaction goes through these — never inline keys. */
export const qk = {
  pulls: ['pulls'] as const,
  snapshot: (n: number) => ['snapshot', n] as const,
  blob: (sha: string) => ['blob', sha] as const,
  draft: (n: number) => ['draft', n] as const,
  viewed: (n: number) => ['viewed', n] as const,
  rate: ['rate'] as const,
}

/**
 * The live PR list — the one genuinely live surface. Polls every 15s and on
 * focus; the previous ETag rides along so the transport can answer 304, which
 * costs nothing against the shared rate bucket. Previous data is kept while a
 * refetch is in flight so the inbox never flashes empty.
 */
export function usePullList(): UseQueryResult<PullListResponse, ApiError> {
  const qc = useQueryClient()
  const etagRef = useRef<string | undefined>(undefined)
  return useQuery<PullListResponse, ApiError>({
    queryKey: qk.pulls,
    queryFn: async () => {
      // The ref survives re-renders; the cache fallback covers a freshly
      // mounted observer joining a query another component already ran.
      const etag = etagRef.current ?? qc.getQueryData<PullListResponse>(qk.pulls)?.etag
      const res = await api.listPulls(etag ? { etag } : undefined)
      etagRef.current = res.etag
      if (res.notModified) {
        // A 304 carries no meaningful body on a real transport — keep the
        // cached items (preserving references) and take only the fresh
        // rate-limit reading.
        const prev = qc.getQueryData<PullListResponse>(qk.pulls)
        if (prev) {
          return { ...prev, etag: res.etag, notModified: true, rateLimit: res.rateLimit }
        }
      }
      return res
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  })
}

/**
 * The cached snapshot for a PR — a local read that never touches the network.
 * `staleTime: Infinity` is the product contract: a snapshot changes only when
 * the user syncs, never behind their back. `null` means never synced.
 */
export function useSnapshot(prNumber: number): UseQueryResult<Snapshot | null, ApiError> {
  return useQuery<Snapshot | null, ApiError>({
    queryKey: qk.snapshot(prNumber),
    queryFn: () => api.getSnapshot(prNumber),
    staleTime: Infinity,
    retry: false,
  })
}

/**
 * The sync burst — the one expensive read. On success the fresh snapshot is
 * written straight into the cache, and the per-PR caches whose meaning depends
 * on the snapshot (draft anchors, viewed-blob SHAs, the spent rate budget) are
 * invalidated. On a network failure the broker may still hold a PARTIAL
 * snapshot (it names its missing blobs), so the snapshot query is invalidated
 * anyway: rendering the partial honestly beats pretending the sync never ran.
 */
export function useSyncPull(prNumber: number): UseMutationResult<Snapshot, ApiError, void> {
  const qc = useQueryClient()
  return useMutation<Snapshot, ApiError, void>({
    mutationFn: () => api.syncPull(prNumber),
    onSuccess: (snapshot) => {
      qc.setQueryData<Snapshot | null>(qk.snapshot(prNumber), snapshot)
      void qc.invalidateQueries({ queryKey: qk.draft(prNumber) })
      void qc.invalidateQueries({ queryKey: qk.viewed(prNumber) })
      void qc.invalidateQueries({ queryKey: qk.rate })
    },
    onError: (error) => {
      if (error.code === 'network') {
        void qc.invalidateQueries({ queryKey: qk.snapshot(prNumber) })
      }
      void qc.invalidateQueries({ queryKey: qk.rate })
    },
  })
}

/**
 * A content-addressed file blob. Identical SHA ⇒ identical bytes, so the entry
 * is immortal: never stale, never garbage-collected, never retried (a missing
 * blob means "re-sync", not "try again").
 */
export function useBlob(sha: string | null): UseQueryResult<FileBlob, ApiError> {
  return useQuery<FileBlob, ApiError>({
    queryKey: qk.blob(sha ?? ''),
    queryFn: () => {
      if (!sha) throw new ApiError('not_found', 'No blob SHA was provided.')
      return api.getBlob(sha)
    },
    enabled: sha !== null && sha.length > 0,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
}

/**
 * Staleness = live list vs. local snapshot, computed client-side without
 * spending a sync. `null` until both sides have loaded. `baseMoved` catches
 * the sneaky case: head unchanged but the base branch advanced, so the
 * three-dot compare (and therefore the diff) changed anyway.
 */
export function useStaleness(prNumber: number): StalenessInfo | null {
  const item = usePullItem(prNumber)
  const snapshot = useSnapshot(prNumber).data
  return useMemo(() => {
    if (!item || !snapshot) return null
    const stale = item.broker.compareKey !== snapshot.immutable.compareKey
    return {
      stale,
      newCommits: Math.max(0, item.broker.commitCount - snapshot.immutable.commits.length),
      baseMoved: stale && item.pull.head.sha === snapshot.immutable.headSha,
      snapshotHeadSha: snapshot.immutable.headSha,
      currentHeadSha: item.pull.head.sha,
      syncedAt: snapshot.syncedAt,
    }
  }, [item, snapshot])
}

/** Shared-bucket status for honest error copy. Fresh-ish, refreshed on focus. */
export function useRateLimit(): UseQueryResult<RateLimitInfo, ApiError> {
  return useQuery<RateLimitInfo, ApiError>({
    queryKey: qk.rate,
    queryFn: () => api.getRateLimit(),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

/** One PR's row from the live list — a selector over the shared list query. */
export function usePullItem(prNumber: number): PullListItem | undefined {
  const list = usePullList()
  return useMemo(
    () => list.data?.items.find((i) => i.pull.number === prNumber),
    [list.data, prNumber],
  )
}

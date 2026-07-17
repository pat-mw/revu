import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { api } from '@/api'
import type { ApiError, FileViewedState } from '@revu/shared'
import { qk } from './queries'

/**
 * Per-human, per-PR "viewed" checkmarks. Broker-side (they must survive a
 * workspace rebuild) but only this client mutates them, so the cache is
 * authoritative: never stale by time, invalidated only by sync — a new blob
 * SHA is what makes a checkmark worth re-examining — and by identity switch.
 */
export function useFileViewed(prNumber: number): UseQueryResult<FileViewedState, ApiError> {
  return useQuery<FileViewedState, ApiError>({
    queryKey: qk.viewed(prNumber),
    queryFn: () => api.getFileViewed(prNumber),
    staleTime: Infinity,
  })
}

export interface SetViewedVariables {
  path: string
  viewed: boolean
  /** Blob SHA of the version being marked, so staleness of the mark is detectable. */
  blobSha: string | null
}

interface SetViewedContext {
  previous: FileViewedState | undefined
}

/**
 * Toggle a file's viewed mark — optimistic cache write (the checkbox must
 * feel instant mid-review) with rollback to the pre-toggle state on failure.
 */
export function useSetFileViewed(
  prNumber: number,
): UseMutationResult<FileViewedState, ApiError, SetViewedVariables, SetViewedContext> {
  const qc = useQueryClient()
  return useMutation<FileViewedState, ApiError, SetViewedVariables, SetViewedContext>({
    mutationFn: ({ path, viewed, blobSha }) =>
      api.setFileViewed(prNumber, path, viewed, blobSha),
    onMutate: async ({ path, viewed, blobSha }) => {
      await qc.cancelQueries({ queryKey: qk.viewed(prNumber) })
      const previous = qc.getQueryData<FileViewedState>(qk.viewed(prNumber))
      qc.setQueryData<FileViewedState>(qk.viewed(prNumber), {
        ...(previous ?? {}),
        [path]: { viewed, blobSha, at: new Date().toISOString() },
      })
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (!context) return
      if (context.previous !== undefined) {
        qc.setQueryData(qk.viewed(prNumber), context.previous)
      } else {
        void qc.invalidateQueries({ queryKey: qk.viewed(prNumber) })
      }
    },
    onSuccess: (server) => {
      // The broker returns the whole map — take it as truth.
      qc.setQueryData(qk.viewed(prNumber), server)
    },
  })
}

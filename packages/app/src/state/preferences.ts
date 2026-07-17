import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { api } from '@/api'
import type { ApiError, HumanPreferences } from '@revu/shared'
import { DEFAULT_PREFERENCES } from '@revu/shared'
import { qk } from './queries'

/**
 * Per-human workspace preferences (diff layout, …). Broker-side, so they survive
 * a page reload and a workspace rebuild; only this client mutates them, so the
 * cache is authoritative — never stale by time, invalidated only by an identity
 * switch (which clears the whole cache).
 */
export function usePreferences(): UseQueryResult<HumanPreferences, ApiError> {
  return useQuery<HumanPreferences, ApiError>({
    queryKey: qk.preferences,
    queryFn: () => api.getPreferences(),
    staleTime: Infinity,
  })
}

interface SetPreferencesContext {
  previous: HumanPreferences | undefined
}

/**
 * Merge a partial preferences patch — optimistic cache write (a toggle must feel
 * instant) with rollback to the pre-patch value on failure. The broker returns
 * the whole merged set, taken as truth on success.
 */
export function useSetPreferences(): UseMutationResult<
  HumanPreferences,
  ApiError,
  Partial<HumanPreferences>,
  SetPreferencesContext
> {
  const qc = useQueryClient()
  return useMutation<HumanPreferences, ApiError, Partial<HumanPreferences>, SetPreferencesContext>({
    mutationFn: (patch) => api.setPreferences(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.preferences })
      const previous = qc.getQueryData<HumanPreferences>(qk.preferences)
      qc.setQueryData<HumanPreferences>(qk.preferences, {
        ...DEFAULT_PREFERENCES,
        ...(previous ?? {}),
        ...patch,
      })
      return { previous }
    },
    onError: (_error, _patch, context) => {
      if (!context) return
      if (context.previous !== undefined) {
        qc.setQueryData(qk.preferences, context.previous)
      } else {
        void qc.invalidateQueries({ queryKey: qk.preferences })
      }
    },
    onSuccess: (server) => {
      qc.setQueryData(qk.preferences, server)
    },
  })
}

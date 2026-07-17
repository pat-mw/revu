import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/api'
import type { Human, Session } from '@revu/shared'
import { ErrorState } from '@/components/ui/error-state'
import { qk } from './queries'

/**
 * Dispatched on `window` by the dev panel whenever identity, latency, or
 * failure mode changes. Identity is the reason it matters here: a different
 * human driving the shared bot means every per-human cache is wrong.
 */
const DEV_EVENT = 'revu:dev'

const SessionContext = createContext<Session | null>(null)

/**
 * Gates the app on the broker session. Children render only once the session
 * is loaded — there is no skeleton state, because nothing below can render
 * meaningfully without knowing which human is driving the workspace.
 *
 * On a dev-panel change the entire query cache is cleared before the session
 * refetches: an identity switch means a different human, and drafts, viewed
 * state, and anything derived from "who am I" would otherwise leak across
 * identities. During the reload the previous session keeps rendering (no
 * flash); it is dropped only if the refetch fails.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Monotonic fetch counter: a stale response never overwrites a newer one.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const gen = ++generation.current
    setError(null)
    // Warm the per-human diff-layout preference alongside the session so the
    // Files tab renders in the stored layout on first paint — without it, a
    // split-preference user sees a unified→split re-layout while the query
    // resolves. Prefetch (not blocking): the session gate is what actually
    // holds children back, and the preference has the same lifetime as it.
    void queryClient.prefetchQuery({
      queryKey: qk.preferences,
      queryFn: () => api.getPreferences(),
      staleTime: Infinity,
    })
    try {
      const next = await api.getSession()
      if (gen === generation.current) setSession(next)
    } catch (e) {
      if (gen !== generation.current) return
      setSession(null)
      setError(e instanceof Error ? e.message : 'The broker did not respond.')
    }
  }, [queryClient])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onDevChange = () => {
      queryClient.clear()
      void queryClient.invalidateQueries()
      void load()
    }
    window.addEventListener(DEV_EVENT, onDevChange)
    return () => window.removeEventListener(DEV_EVENT, onDevChange)
  }, [queryClient, load])

  if (error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState
          className="w-full max-w-md"
          title="Couldn't load your session"
          detail={error}
          retry={() => void load()}
        />
      </div>
    )
  }
  if (!session) return null
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

/** The broker session. Throws when used outside `<SessionProvider>`. */
export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) {
    throw new Error('useSession must be used inside <SessionProvider>.')
  }
  return session
}

/** The human currently driving the shared bot identity. */
export function useCurrentHuman(): Human {
  return useSession().human
}

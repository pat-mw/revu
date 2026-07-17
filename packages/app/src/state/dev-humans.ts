import { useEffect, useState } from 'react'
import type { Human } from '@revu/shared'
import { devControls, DEV_EVENT } from '@/api/dev'

/**
 * The roster of humans who can drive the shared bot identity, fetched through
 * the mode-neutral `devControls`. Loads on mount and re-loads on every
 * `DEV_EVENT` (the roster is stable, but a reset re-seeds it). Starts empty and
 * populates once the first fetch resolves, so the identity switchers render an
 * empty list until then rather than blocking.
 */
export function useHumans(): Human[] {
  const [humans, setHumans] = useState<Human[]>([])
  useEffect(() => {
    let live = true
    const refresh = () => {
      void devControls.get().then((snap) => {
        if (live) setHumans(snap.humans)
      })
    }
    refresh()
    window.addEventListener(DEV_EVENT, refresh)
    return () => {
      live = false
      window.removeEventListener(DEV_EVENT, refresh)
    }
  }, [])
  return humans
}

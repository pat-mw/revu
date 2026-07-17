import { useCallback, useEffect, useRef, useState } from 'react'

export interface TwoStepConfirm {
  /** True while the control is inside its "click again to confirm" window. */
  armed: boolean
  /**
   * First call arms the control for the window; a second call inside the
   * window performs `action` and disarms.
   */
  trigger: (action: () => void) => void
  /** Return to the unarmed state immediately. */
  disarm: () => void
}

/**
 * Two-step destructive confirmation without a dialog: the first activation
 * arms the control (the caller restyles it as danger and rewords its label),
 * and only a second activation within the window runs the destructive action.
 * The window expiring silently disarms — a stale armed button must never
 * linger waiting to destroy something. Used by the review bar's Discard and
 * the pending card's delete icon.
 */
export function useTwoStepConfirm(windowMs = 3000): TwoStepConfirm {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const disarm = useCallback(() => {
    clearTimer()
    setArmed(false)
  }, [clearTimer])

  const trigger = useCallback(
    (action: () => void) => {
      if (armed) {
        disarm()
        action()
        return
      }
      clearTimer()
      setArmed(true)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setArmed(false)
      }, windowMs)
    },
    [armed, clearTimer, disarm, windowMs],
  )

  return { armed, trigger, disarm }
}

import { useEffect } from 'react'
import { setHighlightTheme } from '@/lib/highlight'
import { usePreferences, useSetPreferences } from './preferences'

/**
 * Color-scheme application — the bridge from the stored `theme` preference to the
 * live DOM and the syntax highlighter.
 *
 * The scheme is carried by a single `light` class on `<html>` (dark is its
 * absence): the token system in the global stylesheet re-binds every custom
 * property under `.light`, so toggling the class re-skins the whole app. A tiny
 * inline boot script (in the page `<head>`) applies the class from the persisted
 * choice before first paint, so there is no dark flash; this module keeps the
 * class in sync with the preference for the rest of the session and mirrors the
 * scheme into the off-thread highlighter, which owns a light and a dark syntax
 * theme.
 *
 * The `localStorage` key here is a pre-paint cache of the same choice the broker
 * stores per human — it exists only so the boot script and this module can read
 * the scheme synchronously (a network round-trip cannot beat first paint). The
 * broker preference remains authoritative; this cache follows it.
 */

export type Theme = 'dark' | 'light'

/** Where the boot script and this module cache the last-applied scheme. */
export const THEME_STORAGE_KEY = 'revu.theme'

/** Narrow an unknown value to a valid theme, defaulting to the app's dark heritage. */
function coerceTheme(value: unknown): Theme {
  return value === 'light' ? 'light' : 'dark'
}

/** Read the pre-paint cached scheme; dark when unset or unreadable. */
export function readStoredTheme(): Theme {
  try {
    return coerceTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'dark'
  }
}

/**
 * Apply a scheme to the document and the highlighter, and refresh the pre-paint
 * cache so the next load boots into the same scheme without a flash. Idempotent
 * and safe to call on every preference change.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('light', theme === 'light')
  setHighlightTheme(theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // A blocked storage (private mode, quota) only costs the no-flash cache on
    // the next load; the applied class and highlighter are already correct.
  }
}

/**
 * The active scheme and a setter, sourced from the per-human preference. Reading
 * falls back to whatever the boot script applied until the preference query
 * resolves, so the hook never disagrees with the painted scheme. Setting writes
 * through the preferences store (optimistic) — the effect below reacts to the
 * resulting cache value, so the DOM follows the store, not the click.
 */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const prefs = usePreferences()
  const setPreferences = useSetPreferences()
  const setPreferencesMutate = setPreferences.mutate

  const theme: Theme = prefs.data ? coerceTheme(prefs.data.theme) : readStoredTheme()

  // Keep the document and highlighter aligned with the stored preference. When
  // the preference query resolves (or a toggle writes through), this re-applies;
  // a no-op if the boot script already matched.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const setTheme = (next: Theme) => {
    if (next !== theme) setPreferencesMutate({ theme: next })
  }

  return { theme, setTheme }
}

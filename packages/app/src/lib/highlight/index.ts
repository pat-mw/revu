/**
 * Lazy, off-main-thread syntax highlighting for the diff viewer.
 *
 * Tokenization runs in a module Web Worker (see `worker.ts`) so grammar work
 * never blocks diff scrolling. `useFileTokens` is the only entry point a
 * component needs: give it a path and file content, get back per-line tokens
 * once the worker replies, or `null` to render plain text.
 *
 * Guarantees the diff viewer depends on:
 *   - The concatenation of `token.content` across a line equals that line of
 *     `content` exactly. Word-level overlays slice tokens by character offset;
 *     a mismatch would misalign every span, so the worker maps Shiki tokens
 *     without touching their content.
 *   - Highlighting never breaks the app. No worker, an unhighlightable path, a
 *     grammar error, or a tokenizer throw all resolve to `null` (plain text),
 *     with at most one `console.warn` per session.
 *   - Results are cached across unmounts, keyed by content hash + language +
 *     active theme, so revisiting a file is instant and the light/dark token
 *     sets never collide. The cache is bounded (least-recently-used eviction)
 *     to keep memory flat over a long review.
 *   - Switching the app color scheme re-tokenizes visible files against the
 *     matching syntax theme: `setHighlightTheme` records the new scheme and
 *     bumps a generation counter the hook depends on, so every mounted
 *     `useFileTokens` re-requests (from cache when warm) under the new theme.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { languageForPath } from './languages'
import type { HighlightTheme } from './theme'

/** One highlighted token: its text and, when the theme colors it, a hex string. */
export interface CodeToken {
  content: string
  color?: string
}

/** Request sent to the worker. */
interface HighlightRequest {
  id: number
  lang: string
  content: string
  theme: HighlightTheme
}

// ————————————————————————————————————————————————————————————————
// Active syntax theme — mirrors the app color scheme.
// ————————————————————————————————————————————————————————————————

/**
 * The scheme the diff viewer highlights under. Initialized from the `<html>`
 * class the no-flash boot script applied, so first-paint tokens already match
 * the scheme; `setHighlightTheme` moves it when the user toggles.
 */
function initialTheme(): HighlightTheme {
  if (typeof document === 'undefined') return 'revu-dark'
  return document.documentElement.classList.contains('light') ? 'revu-light' : 'revu-dark'
}

let activeTheme: HighlightTheme = initialTheme()

/**
 * A version counter that changes whenever the active theme changes. `useFileTokens`
 * subscribes to it so a scheme switch forces every mounted hook to re-request
 * tokens under the new theme (served from cache once warm).
 */
let themeGeneration = 0
const themeListeners = new Set<() => void>()

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

function getThemeGeneration(): number {
  return themeGeneration
}

/**
 * Point syntax highlighting at a color scheme. No-op if unchanged; otherwise it
 * bumps the generation so mounted diff views re-tokenize under the new theme.
 * Call this from wherever the theme preference is applied to `<html>`.
 */
export function setHighlightTheme(theme: 'dark' | 'light'): void {
  const next: HighlightTheme = theme === 'light' ? 'revu-light' : 'revu-dark'
  if (next === activeTheme) return
  activeTheme = next
  themeGeneration += 1
  for (const listener of themeListeners) listener()
}

/** Response from the worker: tokens on success, an error string on failure. */
type HighlightResponse =
  | { id: number; lines: CodeToken[][] }
  | { id: number; error: string }

// ————————————————————————————————————————————————————————————————
// Content hashing — djb2 over the source, combined with the language id.
// ————————————————————————————————————————————————————————————————

/**
 * djb2 string hash, returned as an unsigned 32-bit hex string. Fast and good
 * enough to key a per-session token cache; collisions only cost a re-tokenize.
 */
function djb2(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

/** Cache key for a (theme, language, content) triple. */
function cacheKey(theme: HighlightTheme, lang: string, content: string): string {
  return `${theme}:${lang}:${djb2(content)}`
}

// ————————————————————————————————————————————————————————————————
// Module-level token cache — survives unmount, bounded LRU.
// ————————————————————————————————————————————————————————————————

const CACHE_LIMIT = 50

/**
 * Insertion order in a Map is iteration order; re-inserting on read moves an
 * entry to the newest position, so the oldest key is always `keys().next()`.
 * That gives least-recently-used eviction without a separate ordering list.
 */
const tokenCache = new Map<string, CodeToken[][]>()

function cacheGet(key: string): CodeToken[][] | undefined {
  const hit = tokenCache.get(key)
  if (hit === undefined) return undefined
  // Touch: refresh recency by reinserting at the tail.
  tokenCache.delete(key)
  tokenCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: CodeToken[][]): void {
  if (tokenCache.has(key)) tokenCache.delete(key)
  tokenCache.set(key, value)
  while (tokenCache.size > CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    tokenCache.delete(oldest)
  }
}

// ————————————————————————————————————————————————————————————————
// Worker singleton + pending-request routing.
// ————————————————————————————————————————————————————————————————

/** Resolvers waiting on a worker reply, keyed by request id. */
const pending = new Map<number, (tokens: CodeToken[][] | null) => void>()

let worker: Worker | null = null
/** `true` once we've tried and failed to create a worker — stops retrying. */
let workerUnavailable = false
let nextRequestId = 1
/** Guards the single console.warn: highlighting failures are logged once. */
let warnedOnce = false

/** Emit a one-time warning; further highlight failures stay silent. */
function warnOnce(message: string, detail?: unknown): void {
  if (warnedOnce) return
  warnedOnce = true
  if (detail === undefined) console.warn(message)
  else console.warn(message, detail)
}

/**
 * Lazily create the worker on first use. Returns `null` in environments without
 * `Worker` (SSR, some test runners) or if construction throws, so callers fall
 * back to plain text instead of crashing.
 */
function getWorker(): Worker | null {
  if (worker) return worker
  if (workerUnavailable) return null
  if (typeof Worker === 'undefined') {
    workerUnavailable = true
    return null
  }
  try {
    const created = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    })
    created.addEventListener('message', handleWorkerMessage)
    created.addEventListener('error', handleWorkerError)
    worker = created
    return created
  } catch (error) {
    workerUnavailable = true
    warnOnce('revu: syntax highlighting worker unavailable, rendering plain text', error)
    return null
  }
}

function handleWorkerMessage(event: MessageEvent<HighlightResponse>): void {
  const data = event.data
  const resolve = pending.get(data.id)
  if (!resolve) return
  pending.delete(data.id)
  if ('error' in data) {
    warnOnce('revu: syntax highlighting failed, rendering plain text', data.error)
    resolve(null)
  } else {
    resolve(data.lines)
  }
}

/**
 * A worker-level error (uncaught throw during tokenization, module load
 * failure) can't be attributed to one request, so every in-flight request
 * resolves to plain text and the worker is discarded. A later request will
 * recreate it; if creation keeps failing, `workerUnavailable` latches.
 */
function handleWorkerError(event: ErrorEvent): void {
  warnOnce('revu: syntax highlighting worker error, rendering plain text', event.message)
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
  if (worker) {
    worker.removeEventListener('message', handleWorkerMessage)
    worker.removeEventListener('error', handleWorkerError)
    worker.terminate()
    worker = null
  }
}

/**
 * Send one tokenization request to the worker. Resolves with per-line tokens,
 * or `null` if the worker is unavailable. Errors surface through the worker's
 * message/error handlers as `null`.
 */
function requestTokens(
  theme: HighlightTheme,
  lang: string,
  content: string,
): Promise<CodeToken[][] | null> {
  const active = getWorker()
  if (!active) return Promise.resolve(null)
  const id = nextRequestId++
  const request: HighlightRequest = { id, lang, content, theme }
  return new Promise<CodeToken[][] | null>((resolve) => {
    pending.set(id, resolve)
    try {
      active.postMessage(request)
    } catch (error) {
      pending.delete(id)
      warnOnce('revu: could not post to highlighting worker, rendering plain text', error)
      resolve(null)
    }
  })
}

// ————————————————————————————————————————————————————————————————
// Public API.
// ————————————————————————————————————————————————————————————————

export { languageForPath } from './languages'

/**
 * Tokenize a file for the diff viewer, off the main thread.
 *
 * Returns `null` while `content` is null, when the path is unhighlightable, or
 * until the worker replies — the caller renders plain text in every one of
 * those cases. On success returns one `CodeToken[]` per line whose concatenated
 * `content` equals that line exactly.
 *
 * Kicks the worker at most once per (theme, path-language, content) triple and
 * caches the result module-side, so the same file re-renders synchronously from
 * cache after a remount or a scheme switch back. State updates after unmount are
 * dropped. Switching the app color scheme re-runs this effect (via the theme
 * generation) so the diff re-highlights under the light or dark syntax palette.
 */
export function useFileTokens(path: string, content: string | null): CodeToken[][] | null {
  // Re-render this hook whenever the active syntax theme changes.
  useSyncExternalStore(subscribeTheme, getThemeGeneration, getThemeGeneration)

  const lang = content === null ? null : languageForPath(path)
  const key = lang === null || content === null ? null : cacheKey(activeTheme, lang, content)
  const cached = key === null ? null : (cacheGet(key) ?? null)

  const [tokens, setTokens] = useState<CodeToken[][] | null>(cached)

  useEffect(() => {
    if (lang === null || content === null || key === null) {
      setTokens(null)
      return
    }

    const hit = cacheGet(key)
    if (hit !== undefined) {
      setTokens(hit)
      return
    }

    // Nothing cached yet: show plain text until the worker replies.
    setTokens(null)

    const theme = activeTheme
    let active = true
    requestTokens(theme, lang, content).then((lines) => {
      if (lines !== null) cacheSet(key, lines)
      if (active) setTokens(lines)
    })

    return () => {
      active = false
    }
  }, [lang, content, key])

  return tokens
}

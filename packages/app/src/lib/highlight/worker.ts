/**
 * Syntax-highlighting worker. Runs Shiki's tokenizer off the main thread so
 * diff scrolling never blocks on grammar work.
 *
 * Protocol:
 *   in : { id, lang, content }
 *   out: { id, lines } on success | { id, error } on any failure
 *
 * The highlighter core is created once with the pure-JavaScript regex engine
 * (no WASM fetch) and the `revu-dark` theme. Languages are loaded lazily: each
 * distinct `lang` is dynamically imported and registered on first use, then
 * reused. Any failure — unknown language, grammar error, tokenizer throw — is
 * reported as `{ id, error }`; the main thread renders that request as plain
 * text. Highlighting is best-effort and must never take the app down with it.
 */

import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { revuDarkTheme } from './theme'

/** One highlighted token: its text and (when the theme assigns one) a hex color. */
interface CodeToken {
  content: string
  color?: string
}

/** Request from the main thread. `lang` is a Shiki language id known to LANG_LOADERS. */
interface HighlightRequest {
  id: number
  lang: string
  content: string
}

/** Successful response: one token array per line of the input. */
interface HighlightSuccess {
  id: number
  lines: CodeToken[][]
}

/** Failure response: the request should fall back to plain text. */
interface HighlightFailure {
  id: number
  error: string
}

/**
 * Dynamic-import table for every language the app registers. Keyed by the exact
 * ids `languageForPath` returns. Each import yields the language module's
 * default export (an array of TextMate grammar registrations Shiki accepts).
 */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  sql: () => import('@shikijs/langs/sql'),
  markdown: () => import('@shikijs/langs/markdown'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  bash: () => import('@shikijs/langs/bash'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  toml: () => import('@shikijs/langs/toml'),
}

/** Languages already registered on the highlighter, so each loads at most once. */
const loadedLangs = new Set<string>()

/** Highlighter singleton, created on first request. */
let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [revuDarkTheme],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
  }
  return highlighterPromise
}

/** Ensure `lang`'s grammar is registered on the highlighter before tokenizing. */
async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return
  const loader = LANG_LOADERS[lang]
  if (!loader) throw new Error(`unsupported language: ${lang}`)
  const mod = (await loader()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }
  await highlighter.loadLanguage(mod.default)
  loadedLangs.add(lang)
}

/**
 * Tokenize `content` as `lang` under `revu-dark`, flattening Shiki's themed
 * tokens to plain `{ content, color }`. The concatenation of `content` across a
 * line's tokens is byte-for-byte identical to that source line, which the diff
 * viewer relies on to slice tokens by character offset for word-level overlays.
 */
async function tokenize(lang: string, content: string): Promise<CodeToken[][]> {
  const highlighter = await getHighlighter()
  await ensureLanguage(highlighter, lang)
  const themed = highlighter.codeToTokensBase(content, {
    lang,
    theme: 'revu-dark',
  })
  return themed.map((line) =>
    line.map((token) =>
      token.color ? { content: token.content, color: token.color } : { content: token.content },
    ),
  )
}

self.addEventListener('message', (event: MessageEvent<HighlightRequest>) => {
  const { id, lang, content } = event.data
  tokenize(lang, content).then(
    (lines) => {
      const message: HighlightSuccess = { id, lines }
      ;(self as unknown as Worker).postMessage(message)
    },
    (error: unknown) => {
      const message: HighlightFailure = {
        id,
        error: error instanceof Error ? error.message : String(error),
      }
      ;(self as unknown as Worker).postMessage(message)
    },
  )
})

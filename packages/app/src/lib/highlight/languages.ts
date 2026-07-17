/**
 * Path → Shiki language id resolution for the diff viewer.
 *
 * Returns the fine-grained language id that the highlight worker knows how to
 * load, or `null` when a path should render as plain text. The worker's
 * dynamic-import table is keyed by the exact ids returned here, so these strings
 * must match the language module names under `@shikijs/langs`.
 *
 * Lockfiles are deliberately unhighlightable: they are machine-generated, huge,
 * and syntax color adds nothing but tokenization cost. Unknown extensions fall
 * through to plain text rather than guessing.
 */

/** Shiki language ids this project registers, one per supported file kind. */
export type HighlightLang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'yaml'
  | 'sql'
  | 'markdown'
  | 'css'
  | 'html'
  | 'bash'
  | 'dockerfile'
  | 'toml'

/** Filenames (case-insensitive) that map directly to a language, extension aside. */
const FILENAME_LANG: Record<string, HighlightLang> = {
  dockerfile: 'dockerfile',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
}

/** Filenames (case-insensitive) that are explicitly not highlightable. */
const LOCKFILE_NAMES = new Set<string>([
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
])

/** File extension → language. Keys are lowercase, no leading dot. */
const EXT_LANG: Record<string, HighlightLang> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  html: 'html',
  htm: 'html',
  sh: 'bash',
  bash: 'bash',
  toml: 'toml',
}

/** The trailing path segment, lowercased, with any directory prefix stripped. */
function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase()
}

/**
 * Resolve a file path to a Shiki language id, or `null` for plain text.
 *
 * Lockfiles (`bun.lock`, any `*.lock`, `pnpm-lock.yaml`, `package-lock.json`)
 * and unknown extensions return `null`; the caller renders those verbatim.
 */
export function languageForPath(path: string): HighlightLang | null {
  const name = basename(path)
  if (name.length === 0) return null

  if (LOCKFILE_NAMES.has(name)) return null
  // Any `*.lock` is a generated lockfile regardless of the tool that wrote it.
  if (name.endsWith('.lock')) return null

  const byName = FILENAME_LANG[name]
  if (byName) return byName

  // `Dockerfile.prod`, `dev.dockerfile`, etc. still read as Dockerfiles.
  if (name === 'dockerfile' || name.endsWith('.dockerfile') || name.startsWith('dockerfile.')) {
    return 'dockerfile'
  }

  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1)
  return EXT_LANG[ext] ?? null
}

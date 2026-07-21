/**
 * The view model behind a pull request row's hover card.
 *
 * A row is one dense line — a truncated title, an author, a branch, a time —
 * and it deliberately leaves out everything needed to decide whether a pull
 * request is worth opening. The hover card answers exactly that: the full
 * title, what the description actually says, whether CI is happy, and where
 * the work is going. Every field it reads is already carried on the list
 * payload, so the card costs no request.
 *
 * The hard part is the body. Pull request bodies are frequently not prose:
 * they open with an HTML comment a template author left behind, or they are
 * nothing but a checklist, or a bot emitted a code fence. Showing the first
 * 160 raw characters of that is worse than showing nothing — the reader gets
 * markup where they expected a sentence. So the snippet is assembled from the
 * lines that carry prose and comes back null when there are none, and the card
 * simply omits the line rather than displaying an apology.
 *
 * The checks rollup is optional in the same spirit: absent means nothing has
 * reported, which is not a failure and must not be rendered as one. Absent
 * yields null and the card omits the CI line entirely.
 */
import type { ChecksRollup, PullListItem, PullSummary } from '@revu/shared'

/** Longest snippet rendered. Past this the text is cut and marked with an ellipsis. */
export const SNIPPET_MAX_LENGTH = 160

/**
 * Shortest prefix worth keeping when cutting on a word boundary. Below it the
 * cut lands hard mid-word instead, so a body whose first space falls far past
 * the cap does not collapse to one or two letters.
 */
const SNIPPET_MIN_WORD_CUT = 80

/** Where the work lives and where it is going, ready to render. */
export interface PullBranchPair {
  /** Branch the work is on, qualified with its repository when that is a different one. */
  head: string
  /** Branch the work targets. */
  base: string
  /** True when head and base live in different repositories — the change comes from a fork. */
  crossRepo: boolean
}

/** A one-line reading of the CI rollup, coarse by design. */
export interface PullChecksSummary {
  state: ChecksRollup['state']
  text: string
}

export interface PullTooltip {
  /** The full title, whitespace-normalised — the row shows a truncated one. */
  title: string
  /** A prose extract from the body, or null when the body carries no prose. */
  snippet: string | null
  branches: PullBranchPair
  /** Null when nothing has reported; the card then shows no CI line at all. */
  checks: PullChecksSummary | null
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g
/** An opened-but-never-closed comment swallows the rest of the body, as a renderer would. */
const UNCLOSED_HTML_COMMENT = /<!--[\s\S]*$/
const FENCE = /^\s*(?:```|~~~)/
const HEADING = /^#{1,6}\s/
const TASK_ITEM = /^[-*+]\s+\[[ xX]\]/
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/
const QUOTE_MARKER = /^\s*>+\s?/
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const INLINE_LINK = /\[([^\]]*)\]\([^)]*\)/g
const REFERENCE_LINK = /\[([^\]]*)\]\[[^\]]*\]/g
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g
const BOLD = /\*\*([^*]+)\*\*/g
const STRIKE = /~~([^~]+)~~/g
const EMPHASIS = /\*([^*\s][^*]*)\*/g
const BACKTICKS = /`+/g
/** Something a reader would recognise as words rather than punctuation scaffolding. */
const HAS_WORD = /[\p{L}\p{N}]/u

/**
 * Reduce one line to the words inside it: unwrap links, drop images and raw
 * tags, and remove the emphasis punctuation that only means something to a
 * markdown renderer. Underscores are left alone — stripping them would mangle
 * every snake_case identifier a description mentions.
 */
function cleanInline(line: string): string {
  return line
    .replace(IMAGE, ' ')
    .replace(INLINE_LINK, '$1')
    .replace(REFERENCE_LINK, '$1')
    .replace(HTML_TAG, ' ')
    .replace(BOLD, '$1')
    .replace(STRIKE, '$1')
    .replace(EMPHASIS, '$1')
    .replace(BACKTICKS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut on a word boundary where one is close enough, otherwise mid-word. */
function truncateOnWord(text: string): string {
  if (text.length <= SNIPPET_MAX_LENGTH) return text
  const candidate = text.slice(0, SNIPPET_MAX_LENGTH + 1)
  const lastSpace = candidate.lastIndexOf(' ')
  const cut =
    lastSpace >= SNIPPET_MIN_WORD_CUT
      ? candidate.slice(0, lastSpace)
      : candidate.slice(0, SNIPPET_MAX_LENGTH)
  const trimmed = cut.replace(/[\s,;:—–-]+$/, '')
  return `${trimmed === '' ? cut : trimmed}…`
}

/**
 * Extract a readable snippet from a pull request body, or null when the body
 * has nothing a reader would call a description.
 *
 * Headings, task-list items, fenced code and anything that survives as bare
 * punctuation are dropped: a template's "## Checklist" and its unticked boxes
 * describe the repository's process, not this change.
 */
export function bodySnippet(body: string | null): string | null {
  if (body === null) return null

  const withoutComments = body
    .replace(HTML_COMMENT, ' ')
    .replace(UNCLOSED_HTML_COMMENT, ' ')

  const prose: string[] = []
  let inFence = false
  for (const rawLine of withoutComments.split(/\r?\n/)) {
    if (FENCE.test(rawLine)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const line = rawLine.replace(QUOTE_MARKER, '').trim()
    if (line === '') continue
    if (HEADING.test(line)) continue
    if (TASK_ITEM.test(line)) continue

    const text = cleanInline(line.replace(LIST_MARKER, ''))
    if (HAS_WORD.test(text)) prose.push(text)
  }

  const collapsed = prose.join(' ').replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  return truncateOnWord(collapsed)
}

/**
 * Name both ends of the change. A fork's head branch is ambiguous on its own —
 * half the open pull requests in a busy repository are called `main` — so it is
 * qualified with its repository whenever that differs from the target's.
 */
export function branchPair(pull: PullSummary): PullBranchPair {
  const crossRepo = pull.head.repo.full_name !== pull.base.repo.full_name
  return {
    head: crossRepo ? `${pull.head.repo.full_name}:${pull.head.ref}` : pull.head.ref,
    base: pull.base.ref,
    crossRepo,
  }
}

/**
 * Phrase the CI rollup. The rollup carries a state and how many checks it
 * summarises but no per-state counts, so a failing rollup says some checks are
 * failing rather than inventing a number. A rollup that summarises no checks
 * drops the count instead of announcing "0 checks".
 */
export function checksSummary(
  checks: ChecksRollup | undefined,
): PullChecksSummary | null {
  if (checks === undefined) return null

  const { state, total } = checks
  if (total <= 0) {
    const countless = { success: 'Checks passed', failure: 'Checks failing', pending: 'Checks running' }
    return { state, text: countless[state] }
  }

  const noun = total === 1 ? 'check' : 'checks'
  if (state === 'success') return { state, text: `${total} ${noun} passed` }
  if (state === 'pending') return { state, text: `${total} ${noun} running` }
  return {
    state,
    text: total === 1 ? '1 check failing' : `${total} checks, some failing`,
  }
}

/** Everything the hover card renders, derived from the list item already in hand. */
export function buildPullTooltip(item: PullListItem): PullTooltip {
  return {
    title: item.pull.title.replace(/\s+/g, ' ').trim(),
    snippet: bodySnippet(item.pull.body),
    branches: branchPair(item.pull),
    checks: checksSummary(item.broker.checks),
  }
}

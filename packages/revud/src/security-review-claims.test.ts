/**
 * Every file the security review points at by path — a directory and an
 * extension, the form a reader can open — is a file that exists.
 *
 * The review is written to one rule: each claim names the code that enforces
 * it, so a reader can go and check rather than take the sentence on trust. That
 * rule is only worth anything while the names still resolve. A module renamed
 * or moved leaves the prose intact and silently unfalsifiable — the claim reads
 * exactly as it did, and the one reader who tries to verify it finds nothing
 * and cannot tell whether the guarantee moved or evaporated. Prose has no
 * compiler, so this is the compiler.
 *
 * ## What counts as a path
 *
 * Only text inside a backtick span is considered, and inside a span, only a
 * token that has BOTH a directory separator and an extension:
 *
 *     <segment>/<segment>...  /  <name>.<ext>
 *
 * The two requirements are each load-bearing. Without the separator, the review
 * is full of bare symbol references — `store.ts:1621`, `index.ts:mainBroker` —
 * which name a location inside a file the surrounding sentence has already
 * identified, not a file to resolve on its own; treating one as a path would
 * demand a `store.ts` in the repository root. Without the extension, ordinary
 * prose in backticks would be swept up as well.
 *
 * A trailing anchor is not part of the path and is dropped by the shape of the
 * match rather than by a second pass: the extension ends the token, so anything
 * after it — a line number as `:1621` or `:1600-1621`, a symbol name as
 * `:appendAudit` — is simply outside the match. Both anchor styles appear in
 * the review and both are handled the same way.
 *
 * ## How a path is resolved
 *
 * The review names files at whatever depth reads best in its own sentence, so
 * one root is not enough. Each candidate is tried against an ordered, written
 * out list: the repository root (`packages/revud/src/broker/token-custody.test.ts`),
 * the packages directory (`shared/src/http.ts`), and the daemon's own source
 * root (`collector/host-store.ts`), which is the vantage point most of the
 * review is written from. A candidate resolving under none of them fails and is
 * reported by name.
 *
 * Widening this list is how a genuinely new shorthand gets admitted, and it is
 * deliberately a decision rather than a default: a resolver that fell back to
 * searching the tree would find a same-named file anywhere and turn a wrong
 * path into a passing one.
 *
 * ## Why the extractor is itself tested
 *
 * An extractor that quietly stops matching finds no paths, and no paths means
 * no failures — the file would go green having checked nothing. So the count is
 * held against a literal floor chosen independently of what the document
 * currently says, and the extractor is additionally run over a fixture whose
 * correct verdict is known here rather than read out of the document.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const REVIEW_PATH = join(REPO_ROOT, 'docs', 'security-review.md')

/**
 * Where a name in the review may be rooted, in the order tried.
 *
 * Written out rather than derived, so admitting a new shorthand is an edit
 * somebody makes on purpose.
 */
const ROOTS = [REPO_ROOT, join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'packages', 'revud', 'src')]

/**
 * A token with at least one directory separator and an extension.
 *
 * The extension closes the match, which is what drops a `:line` or `:symbol`
 * anchor without a second pass over the result.
 */
const PATH_PATTERN = /[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+/g

/** Every backtick span's contents, in document order. */
function backtickSpans(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '')
}

/** Every distinct path named inside a backtick span, sorted for stable naming. */
function namedPaths(markdown: string): string[] {
  const found = new Set<string>()
  for (const span of backtickSpans(markdown)) {
    for (const match of span.matchAll(PATH_PATTERN)) found.add(match[0])
  }
  return [...found].sort()
}

/** The root a path resolves under, or null when it resolves under none. */
function resolveNamedPath(path: string): string | null {
  return ROOTS.find((root) => existsSync(join(root, path))) ?? null
}

/**
 * The floor on how many paths the review names, chosen as a round number well
 * under what it actually carries and never recomputed from the document.
 *
 * Its whole job is to fail when the extraction breaks rather than to track the
 * document's growth: a floor derived from the document would move with it and
 * would be satisfied by finding nothing.
 */
const MINIMUM_PATHS = 12

const review = readFileSync(REVIEW_PATH, 'utf8')
const paths = namedPaths(review)

describe('security review claims', () => {
  test('the review was read', () => {
    expect(review.length).toBeGreaterThan(1000)
  })

  test('the extractor finds paths and rejects what is not one', () => {
    const fixture = [
      'Named at the repository root in `packages/revud/src/direct/store.ts`,',
      'with a line anchor in `direct/store.ts:1621` and a symbol anchor in',
      '`collector/host-store.ts:landAudit`. Not paths: `index.ts:mainBroker`',
      'with no directory, `pull_requests: write` with no extension, and the',
      'sanitized errno shape `^[A-Z][A-Z0-9_]{0,31}$`.',
    ].join(' ')
    expect(namedPaths(fixture)).toEqual([
      'collector/host-store.ts',
      'direct/store.ts',
      'packages/revud/src/direct/store.ts',
    ])
  })

  test('the review names a substantial number of files', () => {
    expect(paths.length).toBeGreaterThanOrEqual(MINIMUM_PATHS)
  })

  test('every named file exists', () => {
    const missing = paths.filter((path) => resolveNamedPath(path) === null)
    expect(missing).toEqual([])
  })
})

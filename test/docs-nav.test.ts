/**
 * The documentation navigation and the documentation files describe the same
 * set of pages.
 *
 * The site's sidebar is not derived from the filesystem: each directory of
 * content carries a `meta.json` whose `pages` array lists, in render order,
 * what that level of the tree offers. Nothing reconciles the two. A page can
 * therefore be written, committed and published while being reachable only by
 * typing its URL — the failure is silent, and the author is the least likely
 * person to notice, because they arrived at their new page by following their
 * own link. The mirror failure is a `pages` entry naming a file that was
 * renamed or deleted, which builds a sidebar link to nothing.
 *
 * So the two are compared here, exactly, in both directions and for every
 * directory that declares a navigation at all.
 *
 * ## What an entry is allowed to be
 *
 * Two forms are in use, and the comparison admits exactly those:
 *
 *   - the basename of an `.mdx` file in the same directory, without its
 *     extension (`"quickstart"` for `quickstart.mdx`); and
 *   - the name of an immediate subdirectory, which folds that subdirectory's
 *     own navigation in at that position (`"guides"` for `guides/`).
 *
 * The sidebar generator understands further forms — a separator, a rest
 * wildcard standing for "everything not named above", an external link, an
 * exclusion. None is used here, and the comparison is written as plain set
 * equality rather than as a parser tolerant of forms nobody writes: a wildcard
 * would make the assertion vacuous for the directory holding it, since it
 * matches whatever is there. Introducing one of those forms is therefore
 * expected to fail this test, which is the point at which the decision to
 * weaken the guarantee gets made deliberately rather than inherited.
 *
 * Order and duplicates are compared too, in the sense that both sides are
 * sorted first and then compared as sequences: sorting makes render order
 * irrelevant, which it should be here, while comparing sequences rather than
 * sets keeps a name listed twice from passing as a name listed once.
 *
 * ## Why the walk asserts that it walked
 *
 * A recursive walk that resolves to nothing finds no discrepancies and reports
 * success, so a mistyped root — or a content tree moved elsewhere — would turn
 * this file into a recorded green that checks nothing. The directories it
 * expects to have visited are therefore written out and required, alongside
 * the weaker requirement that it visited any at all.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DOCS_ROOT = join(REPO_ROOT, 'packages', 'docs', 'content', 'docs')

/** The name a navigation file goes by inside each content directory. */
const META_FILE = 'meta.json'

/**
 * Directories the walk must reach, named relative to the content root with the
 * root itself as `.`.
 *
 * Written out rather than counted so that a tree which lost a whole section
 * fails here instead of quietly checking one level less than it used to.
 */
const EXPECTED_DIRECTORIES = ['.', 'concepts', 'guides', 'reference', 'run-modes']

/** One content directory that declares its own navigation. */
interface NavDirectory {
  /** Path relative to the content root, with the root itself as `.`. */
  label: string
  /** The `pages` array exactly as written — order and repeats preserved. */
  pages: readonly string[]
  /** Basenames of the `.mdx` files here, without the extension. */
  mdx: readonly string[]
  /** Names of the immediate subdirectories. */
  subdirectories: readonly string[]
}

/**
 * The `pages` array out of one navigation file.
 *
 * Throws rather than returning an empty list on anything unexpected: a
 * navigation file that is not an object with a string array under `pages` is a
 * broken file, and reading it as "no pages declared" would report it as a
 * directory whose every page is unreachable — a confusing way to say the JSON
 * is wrong.
 */
function readPages(file: string): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file}: expected a JSON object`)
  }
  const pages: unknown = (parsed as Record<string, unknown>).pages
  if (!Array.isArray(pages) || pages.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${file}: expected "pages" to be an array of strings`)
  }
  return pages as readonly string[]
}

/**
 * Every navigation-declaring directory at or below `dir`, depth first.
 *
 * Recursion is not conditional on finding a navigation file: a directory
 * without one contributes nothing itself but is still descended into, so a
 * plain grouping folder cannot hide the levels beneath it.
 */
function collectNavDirectories(dir: string): NavDirectory[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const subdirectories = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const found: NavDirectory[] = []

  if (entries.some((e) => e.isFile() && e.name === META_FILE)) {
    const relativePath = relative(DOCS_ROOT, dir)
    found.push({
      label: relativePath === '' ? '.' : relativePath,
      pages: readPages(join(dir, META_FILE)),
      mdx: entries
        .filter((e) => e.isFile() && e.name.endsWith('.mdx'))
        .map((e) => e.name.slice(0, -'.mdx'.length)),
      subdirectories,
    })
  }

  for (const name of subdirectories) {
    found.push(...collectNavDirectories(join(dir, name)))
  }
  return found
}

const directories = collectNavDirectories(DOCS_ROOT)

describe('documentation navigation', () => {
  test('the walk found navigation to check', () => {
    expect(directories.length).toBeGreaterThanOrEqual(1)
    expect(directories.map((d) => d.label).sort()).toEqual(
      [...EXPECTED_DIRECTORIES].sort(),
    )
  })

  for (const directory of directories) {
    test(`${directory.label} lists exactly the pages it holds`, () => {
      const declared = [...directory.pages].sort()
      const present = [...directory.mdx, ...directory.subdirectories].sort()
      expect(declared).toEqual(present)
    })
  }
})

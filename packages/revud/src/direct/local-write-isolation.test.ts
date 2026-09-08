/**
 * The local write path cannot reach GitHub, and that is enforced structurally.
 *
 * A local review lives and is answered entirely on this machine: none of its
 * comments, verdicts, resolves or reactions is ever posted anywhere. The
 * property holds because the local write modules have no GitHub client, no
 * body-stamping/journalling decorator and no subprocess runner in scope at all
 * — not because a branch decides not to call one. This file is what makes that
 * claim checkable: it scans the local write-path source and fails if any of
 * those seams, or any network/subprocess vocabulary, appears in it — at import
 * depth zero or at any depth below.
 *
 * Why the scan reads IMPORT SPECIFIERS instead of whole-file text. The local
 * write module documents the seams it deliberately omits, so its own docstring
 * names the GitHub client in prose. A `not.toMatch(/github/i)` sweep over the
 * whole file would fail on that sentence, and the only way to green it again
 * would be to delete the explanation. Extracting the specifiers out of the
 * statement forms keeps the ban precise enough that documentation cannot trip
 * it, while a real import of any banned module still fails. The two statement
 * forms are anchored to the start of a line, so a comment quoting an import
 * statement is not a hit; the dynamic-import form cannot be line-anchored, so
 * prose may name a module freely but may not write a quoted dynamic import of
 * one.
 *
 * Why the scanned file set is a written-out literal. A scan that reads nothing
 * passes everything, so a renamed or mistyped path would otherwise turn every
 * assertion below into a recorded green that asserts nothing. The set is
 * therefore pinned here, and each member is separately required to exist and
 * to read non-empty. For the same reason the specifier extractor, the ban list
 * and the import-graph walk are each exercised against fixture sources whose
 * verdict is known independently: a regex that stops matching, or a ban member
 * that can never fire, fails in this file rather than silently permitting
 * everything.
 *
 * The test-support files are in the scanned set on purpose. The local write
 * tests construct no GitHub client at all — unlike the GitHub write tests,
 * which spread a throwing client to prove nothing unexpected reached it — and
 * that absence is itself part of what is asserted.
 *
 * Why a RELATIVE specifier is checked against an ALLOWLIST rather than against
 * a list of bad names. The import-graph walk below resolves a relative
 * specifier by appending exactly one extension, so a helper landed beside these
 * files under any other resolvable extension — or as a directory with an index
 * — would be an invisible node in that graph: the walk reads nothing there, and
 * because such a file belongs to neither pinned set, its own imports and its
 * own egress vocabulary are never scanned either. A client reached through one
 * would be genuinely loaded at runtime with every assertion here still green.
 * Enumerating the extensions the walk should also try would answer that with a
 * ban list, and a ban list is only ever as complete as the next extension
 * somebody remembers. The rule is therefore stated from the other side,
 * mirroring what the bare-specifier vocabulary ban already does: every relative
 * specifier a scanned file writes must resolve to a MEMBER of the scanned set,
 * compared against the written-out path including its extension. Anything else
 * — a different extension, a directory index, a sibling module, a path that
 * resolves to nothing at all — is a violation rather than a branch the walk
 * quietly stops following. The scanned set is closed under relative imports by
 * construction, which is what makes "at any depth" true independently of how
 * many extensions the walk happens to know about.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const DIRECT_DIR = import.meta.dir

/**
 * The local write path, written out rather than globbed. A glob would grow and
 * shrink with the directory, so a deleted or renamed module would silently
 * leave the scan with less to read instead of failing.
 */
const LOCAL_MODULE_FILES = [
  'local-ids.test.ts',
  'local-ids.ts',
  'local-write-fakes.ts',
  'local-writes.test.ts',
  'local-writes.ts',
] as const

/**
 * The same set as absolute paths, which is the form a resolved specifier can be
 * compared against. The extension is part of each member on purpose: a
 * comparison that dropped it would accept a same-named file landed under a
 * different extension, which is exactly the hole the allowlist exists to close.
 */
const LOCAL_MODULE_PATHS: readonly string[] = LOCAL_MODULE_FILES.map((file) =>
  join(DIRECT_DIR, file),
)

/**
 * Egress vocabulary is scanned over the modules only, not over the test file.
 * A test fixture may legitimately carry a URL-shaped string inside a stored
 * document, whereas none of the three modules has any reason to name a host, a
 * transport or a subprocess — head resolution arrives as an injected function,
 * so the write module spawns nothing.
 */
const EGRESS_SCANNED_FILES = ['local-writes.ts', 'local-ids.ts', 'local-write-fakes.ts'] as const

const EGRESS_BANS = ['fetch(', 'https://', 'api.github.com', 'Bun.spawn'] as const

const BASENAME_BAN_LABEL = 'a module whose basename contains "github"'
const VOCABULARY_BAN_LABEL = 'a specifier outside { @revu/shared, bun:test }'
const SCANNED_SET_BAN_LABEL = 'a relative specifier resolving outside the scanned file set'

/** Sibling modules the local write path must never pull in, by resolved path. */
const BANNED_SIBLINGS = ['./github-client', './write-decorator', './command-runner'] as const

const MODULE_EXTENSION = /\.(?:ts|tsx|mts|js|mjs)$/

/**
 * The statement and expression forms that can pull a module into a file.
 * Capture group 2 is the specifier in every one of them.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // `import … from '<spec>'` and `export … from '<spec>'`. The clause may span
  // several lines (a multi-line named list) but can never contain a quote,
  // which is what makes the lazy span safe. Line-anchored so a comment that
  // quotes an import statement is not read as one.
  /^[ \t]*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/gm,
  // A side-effect import: `import '<spec>'`.
  /^[ \t]*import\s*(['"])([^'"]+)\1/gm,
  // A dynamic `import('<spec>')` or `require('<spec>')`. This one appears
  // mid-expression, so it cannot be line-anchored.
  /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1/g,
]

/** Every module specifier a source pulls in, in first-seen order, deduplicated. */
function importSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[2]
      if (spec !== undefined && !found.includes(spec)) found.push(spec)
    }
  }
  return found
}

/**
 * The absolute, extension-free path a relative specifier resolves to, or null
 * when the specifier names a package rather than a file. Resolving rather than
 * string-matching means `../direct/github-client` is caught exactly as
 * `./github-client` is.
 */
function resolveRelative(spec: string, fromDir: string): string | null {
  if (!isRelativeSpecifier(spec)) return null
  return resolve(fromDir, spec).replace(MODULE_EXTENSION, '')
}

/** Whether a specifier names a path rather than a package. */
function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../')
}

/**
 * Whether a relative specifier names a member of the scanned set — the only
 * place a scanned file is allowed to import from.
 *
 * The comparison is against the members' WRITTEN-OUT paths, extension included,
 * and it accepts the two spellings that reach one: the path as written, and the
 * extensionless form these files actually use. That is deliberately stricter
 * than the extension-stripping resolution the sibling bans do. Stripping the
 * extension would read a specifier naming a same-named neighbour under a
 * different one as if it named the scanned member itself, which would hand back
 * the hole this allowlist exists to close.
 */
function resolvesIntoScannedSet(spec: string, fromDir: string): boolean {
  const target = resolve(fromDir, spec)
  return LOCAL_MODULE_PATHS.includes(target) || LOCAL_MODULE_PATHS.includes(`${target}.ts`)
}

/**
 * The specifiers the local write path is allowed to reach for. Stating the
 * whole legitimate vocabulary, rather than only banning known-bad names,
 * closes the case a name-based ban cannot see: a client published under a
 * package whose name contains neither "github" nor a host, and a builtin that
 * could open a socket or spawn a process.
 */
function isAllowedVocabulary(spec: string): boolean {
  return spec === '@revu/shared' || spec.startsWith('@revu/shared/') || spec === 'bun:test'
}

interface SpecifierBan {
  readonly label: string
  readonly hit: (spec: string, fromDir: string) => boolean
}

const SPECIFIER_BANS: readonly SpecifierBan[] = [
  ...BANNED_SIBLINGS.map((member) => ({
    label: member,
    hit: (spec: string, fromDir: string) =>
      resolveRelative(spec, fromDir) === resolveRelative(member, DIRECT_DIR),
  })),
  { label: BASENAME_BAN_LABEL, hit: (spec: string) => /github/i.test(basename(spec)) },
  {
    label: VOCABULARY_BAN_LABEL,
    hit: (spec: string, fromDir: string) =>
      resolveRelative(spec, fromDir) === null && !isAllowedVocabulary(spec),
  },
  {
    label: SCANNED_SET_BAN_LABEL,
    hit: (spec: string, fromDir: string) =>
      isRelativeSpecifier(spec) && !resolvesIntoScannedSet(spec, fromDir),
  },
]

/** Every ban a single specifier trips, by label. */
function bansHitBy(spec: string, fromDir: string = DIRECT_DIR): string[] {
  return SPECIFIER_BANS.filter((ban) => ban.hit(spec, fromDir)).map((ban) => ban.label)
}

/** One human-readable line per banned specifier found, naming the specifier and the ban. */
function specifierViolations(file: string, source: string): string[] {
  const violations: string[] = []
  for (const spec of importSpecifiers(source)) {
    for (const label of bansHitBy(spec)) {
      violations.push(`${file} imports '${spec}' — banned: ${label}`)
    }
  }
  return violations
}

/**
 * Read a scanned file, failing loudly when it is absent. Every assertion below
 * that reads a source goes red on a missing path rather than scanning an empty
 * string and passing.
 */
function readScanned(file: string): string {
  return readFileSync(join(DIRECT_DIR, file), 'utf8')
}

/** Source for an absolute module path, or null when nothing is there to read. */
type ReadModule = (absolutePath: string) => string | null

const readFromDisk: ReadModule = (absolutePath) =>
  existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null

/**
 * Every module reachable from an entry by following relative imports, at any
 * depth. Bare specifiers end a branch: they name a package, not a file in this
 * graph. An unreadable module also ends a branch, which is why the callers
 * assert separately that the entry itself was readable.
 *
 * A relative target is resolved by appending ONE extension, so this walk sees a
 * graph of `.ts` files and nothing else — a limitation it cannot detect from
 * the inside, since a target it fails to resolve is indistinguishable from a
 * branch that ends. Over the scanned set that limitation is unreachable rather
 * than merely unlikely: the allowlist above requires every relative specifier
 * there to name a scanned member, and every scanned member is a `.ts` file. The
 * two layers are therefore not redundant statements of one rule — the allowlist
 * is what makes the closure hold, and this walk is what reads the closure back
 * out and reports what is in it.
 */
function reachableModules(entryPath: string, read: ReadModule): string[] {
  const visited: string[] = []
  const queue: string[] = [entryPath]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || visited.includes(current)) continue
    visited.push(current)
    const source = read(current)
    if (source === null) continue
    for (const spec of importSpecifiers(source)) {
      const target = resolveRelative(spec, dirname(current))
      if (target !== null) queue.push(`${target}.ts`)
    }
  }
  return visited
}

/** Reachable modules whose own filename names a GitHub client. */
function githubModulesAmong(paths: readonly string[]): string[] {
  return paths.filter((path) => /github/i.test(basename(path)))
}

describe('the scanners cannot pass by reading nothing', () => {
  test('the scanned file set is exactly the five local write-path files', () => {
    // The expectation is written out independently of the constant, so a
    // rename or a typo in one has to be repeated in the other to stay green.
    //
    // Both test files are in the set on purpose. The local tests construct no
    // GitHub client, and that absence is as load-bearing as the modules' own:
    // a test that reached for one would prove the path can be reached, whatever
    // the modules say. Leaving either test file out would make the scan's
    // coverage depend on which file a future import happened to land in.
    expect([...LOCAL_MODULE_FILES].sort()).toEqual([
      'local-ids.test.ts',
      'local-ids.ts',
      'local-write-fakes.ts',
      'local-writes.test.ts',
      'local-writes.ts',
    ])
    // The egress scan reads a subset of the same set, so its scope is pinned to
    // the set rather than drifting into files nothing else covers.
    for (const file of EGRESS_SCANNED_FILES) expect(LOCAL_MODULE_FILES).toContain(file)
  })

  test('every scanned file exists on disk', () => {
    const missing = LOCAL_MODULE_FILES.filter((file) => !existsSync(join(DIRECT_DIR, file)))
    expect(missing).toEqual([])
  })

  test('every scanned file reads non-empty', () => {
    const empty = LOCAL_MODULE_FILES.filter((file) => readScanned(file).trim().length === 0)
    expect(empty).toEqual([])
  })
})

describe('the specifier extractor is proven to see what it is meant to ban', () => {
  const FIXTURE_WITH_A_CLIENT_IMPORT = [
    '/**',
    ' * A docstring may explain the absence of the github client in prose,',
    " * including by quoting the statement `import type { GithubClient } from './github-client'`",
    ' * that must never appear, without that explanation counting as an import.',
    ' */',
    "import type { Session } from '@revu/shared'",
    "import type { GithubClient } from './github-client'",
    '',
    'export const dead = (s: Session, c: GithubClient) => [s, c]',
  ].join('\n')

  test('a fixture source importing the client reports that specifier', () => {
    expect(importSpecifiers(FIXTURE_WITH_A_CLIENT_IMPORT)).toEqual([
      '@revu/shared',
      './github-client',
    ])
  })

  test('the same fixture is reported as a violation naming the specifier', () => {
    const violations = specifierViolations('fixture.ts', FIXTURE_WITH_A_CLIENT_IMPORT)
    expect(violations).toEqual([
      "fixture.ts imports './github-client' — banned: ./github-client",
      `fixture.ts imports './github-client' — banned: ${BASENAME_BAN_LABEL}`,
      `fixture.ts imports './github-client' — banned: ${SCANNED_SET_BAN_LABEL}`,
    ])
  })

  test('prose quoting an import statement inside a comment is not an import', () => {
    const prose = [
      '/**',
      " * Never: import type { GithubClient } from './github-client'",
      ' */',
      'export const note = 1',
    ].join('\n')
    expect(importSpecifiers(prose)).toEqual([])
  })

  const FORM_FIXTURES: readonly (readonly [string, string])[] = [
    ['a multi-line named import', "import type {\n  A,\n  B,\n} from './wanted'\n"],
    ['a re-export', "export type { A } from './wanted'\n"],
    ['a side-effect import', "import './wanted'\n"],
    ['a dynamic import', "export const load = async () => await import('./wanted')\n"],
    ['a require call', "export const load = () => require('./wanted')\n"],
  ]

  for (const [form, source] of FORM_FIXTURES) {
    test(`${form} is extracted`, () => {
      expect(importSpecifiers(source)).toEqual(['./wanted'])
    })
  }
})

describe('every banned specifier is proven able to fire', () => {
  const SPECIFIER_FIXTURES: readonly (readonly [string, readonly string[]])[] = [
    // Every named sibling ban is subsumed by the allowlist, which is what the
    // second label on each of these rows records: a relative specifier naming
    // any of them resolves outside the scanned set, so none of the three can
    // be the sole cause of a red any more. They are kept because they name the
    // modules the GitHub write core really imports, and a violation line that
    // names the module is a better report than one that only says "outside the
    // set". The exact-path ban on the client is subsumed twice over, by the
    // basename ban as well — pinned here so the subsumptions stay known rather
    // than assumed.
    ['./write-decorator', ['./write-decorator', SCANNED_SET_BAN_LABEL]],
    ['./command-runner', ['./command-runner', SCANNED_SET_BAN_LABEL]],
    ['./github-client', ['./github-client', BASENAME_BAN_LABEL, SCANNED_SET_BAN_LABEL]],
    [
      '../direct/github-client.ts',
      ['./github-client', BASENAME_BAN_LABEL, SCANNED_SET_BAN_LABEL],
    ],
    ['./legacy-github-transport', [BASENAME_BAN_LABEL, SCANNED_SET_BAN_LABEL]],
    ['@octokit/rest', [VOCABULARY_BAN_LABEL]],
    ['node:https', [VOCABULARY_BAN_LABEL]],
    ['@revu/app/mock', [VOCABULARY_BAN_LABEL]],
    // A helper landed beside these files under every extension a runtime or a
    // bundler will load, plus a directory with an index. None of them names a
    // banned module and none has "github" in its basename, so the allowlist is
    // the only rule that can see any of them — and it sees all of them for one
    // reason rather than eight, because the rule is what a specifier may
    // resolve TO and not what it may be spelled as.
    ['./local-smuggle.ts', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.mts', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.cts', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.tsx', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.js', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.mjs', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.cjs', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle.json', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle/index.ts', [SCANNED_SET_BAN_LABEL]],
    ['./local-smuggle', [SCANNED_SET_BAN_LABEL]],
    // The same shapes wearing a scanned member's NAME, which is the case an
    // extension-stripping comparison would wave through: neither of these is
    // the file the scanned set pins, and both must still be violations.
    ['./local-ids.mts', [SCANNED_SET_BAN_LABEL]],
    ['./local-ids/index.ts', [SCANNED_SET_BAN_LABEL]],
    // The legitimate vocabulary, so the bans are shown to be specific rather
    // than universally red — including both spellings of a scanned member.
    ['@revu/shared', []],
    ['bun:test', []],
    ['./local-ids', []],
    ['./local-ids.ts', []],
    ['./local-writes', []],
    ['./local-write-fakes', []],
  ]

  for (const [spec, labels] of SPECIFIER_FIXTURES) {
    test(`'${spec}' trips exactly ${labels.length === 0 ? 'nothing' : labels.join(' + ')}`, () => {
      expect(bansHitBy(spec)).toEqual([...labels])
    })
  }
})

describe('every banned egress term is proven able to fire, and none implies another', () => {
  const EGRESS_FIXTURES: readonly (readonly [string, string])[] = [
    ['fetch(', 'export const read = (u: string) => fetch(u)\n'],
    ['https://', "export const base = 'https://example.test/v1'\n"],
    ['api.github.com', "export const host = 'api.github.com'\n"],
    ['Bun.spawn', "export const run = () => Bun.spawn(['git', 'rev-parse', 'HEAD'])\n"],
  ]

  for (const [needle, source] of EGRESS_FIXTURES) {
    test(`a source containing ${needle} trips that term and no other`, () => {
      expect(EGRESS_BANS.filter((ban) => source.includes(ban))).toEqual([needle])
    })
  }
})

describe('the import-graph walk is proven to reach a client at depth', () => {
  const FIXTURE_GRAPH: Record<string, string> = {
    '/fixture/entry.ts': "import { one } from './helpers/one'\nexport const entry = one\n",
    '/fixture/helpers/one.ts': "export { two as one } from '../deep/two'\n",
    '/fixture/deep/two.ts': "import './github-client'\nexport const two = 2\n",
    '/fixture/deep/github-client.ts': 'export const client = 1\n',
  }
  const readFixture: ReadModule = (path) => FIXTURE_GRAPH[path] ?? null

  test('a client three modules below the entry is reported', () => {
    const visited = reachableModules('/fixture/entry.ts', readFixture)
    expect(visited).toEqual([
      '/fixture/entry.ts',
      '/fixture/helpers/one.ts',
      '/fixture/deep/two.ts',
      '/fixture/deep/github-client.ts',
    ])
  })

  test('the client is what the reachability filter names', () => {
    const visited = reachableModules('/fixture/entry.ts', readFixture)
    expect(githubModulesAmong(visited)).toEqual(['/fixture/deep/github-client.ts'])
  })

  test('an unreadable entry visits only itself, which is why existence is asserted separately', () => {
    expect(reachableModules('/fixture/absent.ts', readFixture)).toEqual(['/fixture/absent.ts'])
  })

  test('the walk finds the client the GitHub write core really does import', () => {
    // Run against the shipped GitHub write path, whose graph genuinely reaches
    // a client: a walk that stopped resolving would report nothing here and
    // would then report nothing over the local path either.
    const visited = reachableModules(join(DIRECT_DIR, 'writes.ts'), readFromDisk)
    expect(githubModulesAmong(visited)).toEqual([join(DIRECT_DIR, 'github-client.ts')])
  })
})

describe('a client reached through another extension is caught, and only by the allowlist', () => {
  // The shape this pair exists for: a helper landed beside the write module
  // under an extension the walk does not append, importing the client itself.
  // Both halves are asserted, because the interesting fact is not that the
  // violation is reported — it is that the walk reports NOTHING while a client
  // really is reachable, so a suite holding only the walk would record a green
  // over a live import. That makes the allowlist load-bearing rather than a
  // second opinion, and it is why the two are measured separately here.
  const SMUGGLING_ENTRY = [
    "import { mintLocalEntityId } from './local-ids'",
    "import './local-smuggle.mts'",
    '',
    'export const mint = mintLocalEntityId',
    '',
  ].join('\n')

  const SMUGGLING_GRAPH: Record<string, string> = {
    [join(DIRECT_DIR, 'local-writes.ts')]: SMUGGLING_ENTRY,
    [join(DIRECT_DIR, 'local-ids.ts')]: 'export const mintLocalEntityId = () => 1\n',
    [join(DIRECT_DIR, 'local-smuggle.mts')]:
      "export { createGithubClient } from './github-client'\n",
    [join(DIRECT_DIR, 'github-client.ts')]: 'export const createGithubClient = () => 1\n',
  }
  const readSmuggling: ReadModule = (path) => SMUGGLING_GRAPH[path] ?? null

  test('the walk resolves one extension, so it reports no client at all here', () => {
    const visited = reachableModules(join(DIRECT_DIR, 'local-writes.ts'), readSmuggling)
    expect(githubModulesAmong(visited)).toEqual([])
  })

  test('the walk does not even visit the smuggling module, which is why it sees nothing', () => {
    const visited = reachableModules(join(DIRECT_DIR, 'local-writes.ts'), readSmuggling)
    expect(visited).not.toContain(join(DIRECT_DIR, 'local-smuggle.mts'))
  })

  test('the allowlist reports the specifier that reaches it', () => {
    expect(specifierViolations('local-writes.ts', SMUGGLING_ENTRY)).toEqual([
      `local-writes.ts imports './local-smuggle.mts' — banned: ${SCANNED_SET_BAN_LABEL}`,
    ])
  })
})

describe('the local write path imports no GitHub client', () => {
  test('no scanned file imports a banned specifier', () => {
    const violations = LOCAL_MODULE_FILES.flatMap((file) =>
      specifierViolations(file, readScanned(file)),
    )
    expect(violations).toEqual([])
  })

  // The write module is the entry this closure exists for; the other three are
  // walked on the same terms, so a helper reached only from a test or a fake
  // cannot smuggle a client in either.
  for (const file of LOCAL_MODULE_FILES) {
    test(`no GitHub client is reachable from ${file} at any depth`, () => {
      const entry = join(DIRECT_DIR, file)
      // A walk from a path that does not exist visits only that path and finds
      // nothing, so readability is a precondition of the same test body rather
      // than a separate one that could be green while this walk reads nothing.
      expect(readFromDisk(entry)).not.toBeNull()
      expect(githubModulesAmong(reachableModules(entry, readFromDisk))).toEqual([])
    })
  }
})

describe('the local write modules contain no network or subprocess vocabulary', () => {
  for (const needle of EGRESS_BANS) {
    test(`no scanned module contains ${needle}`, () => {
      const offenders = EGRESS_SCANNED_FILES.filter((file) => readScanned(file).includes(needle))
      expect(offenders).toEqual([])
    })
  }
})

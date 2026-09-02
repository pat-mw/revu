/**
 * Contract for the local-review archive detector.
 *
 * The detector answers one question after a local review syncs: has a pull
 * request appeared for this branch pair, and if so which. It reads GitHub
 * through an injected one-method seam and writes only to the local store.
 *
 * Every harness here carries a `throwingGithubClient()` it never passes to the
 * detector. The detector takes no client and has no way to build one, so a
 * client sitting unused beside it is the assertion: if the detector ever grew a
 * path to GitHub of its own, these tests would still pass — which is why the
 * import-purity scan at the bottom of this file, not the harness, is what pins
 * the structural absence. The client is here so that a future edit adding a
 * `github` dep has to delete a line rather than add one.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import type { GhUser, LocalReviewSummary, PullSummary } from '@revu/shared'
import { throwingGithubClient } from './github-write-stubs'
import type { ArchiveStore, SupersedingPullSource } from './local-archive'
import { createLocalArchiveDetector } from './local-archive'

const ACTOR: GhUser = {
  login: 'octocat',
  id: 1,
  node_id: 'U_1',
  avatar_url: '',
  html_url: '',
  type: 'User',
}

const REVIEW_ID = 1_000_000_001

/** A local review row, defaulted to the live (unarchived) case. */
function review(over: Partial<LocalReviewSummary> = {}): LocalReviewSummary {
  return {
    id: REVIEW_ID,
    repo: 'acme/widgets',
    baseRef: 'refs/heads/main',
    headRef: 'refs/heads/feature/x',
    title: 'feature/x',
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'm'.repeat(40),
    headSha: 'h'.repeat(40),
    dirty: false,
    archivedPr: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastSyncedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  }
}

/** A pull request over the review's branch pair, unless overridden. */
function pull(over: { number?: number; headRef?: string } = {}): PullSummary {
  const headRef = over.headRef ?? 'feature/x'
  return {
    id: 900,
    node_id: 'PR_900',
    number: over.number ?? 12,
    state: 'open',
    draft: false,
    merged_at: null,
    title: 'A pull request',
    body: null,
    user: ACTOR,
    labels: [],
    requested_reviewers: [],
    head: {
      ref: headRef,
      sha: 'a'.repeat(40),
      label: `acme/widgets:${headRef}`,
      repo: { full_name: 'acme/widgets', default_branch: 'main' },
    },
    base: {
      ref: 'main',
      sha: 'b'.repeat(40),
      label: 'acme/widgets:main',
      repo: { full_name: 'acme/widgets', default_branch: 'main' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }
}

/** A store recording every archive write, reading back what it recorded. */
function recordingStore(seeded: number | null = null): ArchiveStore & {
  readonly writes: { localId: number; prNumber: number }[]
} {
  const writes: { localId: number; prNumber: number }[] = []
  let standing = seeded
  return {
    writes,
    markLocalReviewArchived(localId, prNumber) {
      writes.push({ localId, prNumber })
      // Write-once, as the store's own column is: an earlier number stands.
      if (standing === null) standing = prNumber
    },
    getLocalReview: (localId) =>
      localId === REVIEW_ID ? review({ archivedPr: standing }) : null,
  }
}

/** A store no test expects to be written to or read from. */
function untouchedStore(): ArchiveStore {
  return {
    markLocalReviewArchived: () => {
      throw new Error('the detector archived a review it should have left alone')
    },
    getLocalReview: () => {
      throw new Error('the detector read a review it should have left alone')
    },
  }
}

/** A seam recording each pair it was asked about, answering with `pulls`. */
function recordingSource(pulls: PullSummary[]): SupersedingPullSource & {
  readonly asked: { headRef: string; baseRef: string }[]
} {
  const asked: { headRef: string; baseRef: string }[] = []
  return {
    asked,
    async listOpenPullsForPair(pair) {
      asked.push(pair)
      return pulls
    },
  }
}

/** A seam that must never be consulted. */
function forbiddenSource(): SupersedingPullSource & {
  readonly asked: { headRef: string; baseRef: string }[]
} {
  const asked: { headRef: string; baseRef: string }[] = []
  return {
    asked,
    async listOpenPullsForPair(pair) {
      asked.push(pair)
      throw new Error('the detector consulted the seam when it must not have')
    },
  }
}

describe('a detector with no listing seam', () => {
  test('answers not-archived and issues no request at all', async () => {
    const realFetch = globalThis.fetch
    const attempted: string[] = []
    globalThis.fetch = ((input: unknown): never => {
      attempted.push(String(input))
      throw new Error('the archive detector must not reach the network')
    }) as unknown as typeof fetch
    try {
      // The positive control: the double IS installed, so a sibling call under
      // it throws. Without this line, "zero requests" would pass just as well
      // on a test that never installed the double at all.
      expect(() => fetch('https://api.github.com/x')).toThrow(
        'the archive detector must not reach the network',
      )
      expect(attempted).toEqual(['https://api.github.com/x'])

      const unusedClient = throwingGithubClient()
      expect(typeof unusedClient.getViewer).toBe('function')

      const detector = createLocalArchiveDetector({ store: untouchedStore() })
      const verdict = await detector.detect(review())

      expect(verdict).toEqual({ archivedPr: null, requested: false })
      expect(attempted).toEqual(['https://api.github.com/x'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('the cases that must not reach the seam', () => {
  test('a review already archived reports its standing number without asking', async () => {
    const source = forbiddenSource()
    const detector = createLocalArchiveDetector({ source, store: untouchedStore() })
    const verdict = await detector.detect(review({ archivedPr: 41 }))
    expect(verdict).toEqual({ archivedPr: 41, requested: false })
    expect(source.asked).toEqual([])
  })

  test('a path-shaped repository identity is never asked about', async () => {
    const source = forbiddenSource()
    const detector = createLocalArchiveDetector({ source, store: untouchedStore() })
    const verdict = await detector.detect(
      review({ repo: '/Users/dev/checkouts/widgets' }),
    )
    expect(verdict).toEqual({ archivedPr: null, requested: false })
    expect(source.asked).toEqual([])
  })

  test('a blank repository identity is never asked about', async () => {
    const source = forbiddenSource()
    const detector = createLocalArchiveDetector({ source, store: untouchedStore() })
    const verdict = await detector.detect(review({ repo: '' }))
    expect(verdict).toEqual({ archivedPr: null, requested: false })
    expect(source.asked).toEqual([])
  })
})

describe('the seam is asked about bare branch names', () => {
  test('a fully qualified pair is asked about as two bare branch names', async () => {
    const source = recordingSource([])
    const detector = createLocalArchiveDetector({ source, store: untouchedStore() })
    await detector.detect(
      review({ baseRef: 'refs/remotes/origin/main', headRef: 'refs/heads/feature/x' }),
    )
    expect(source.asked).toEqual([{ headRef: 'feature/x', baseRef: 'main' }])
  })

  test('no match leaves the review live, with the request recorded as made', async () => {
    const source = recordingSource([pull({ headRef: 'someone/else' })])
    const detector = createLocalArchiveDetector({ source, store: untouchedStore() })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: null, requested: true })
    expect(source.asked).toHaveLength(1)
  })
})

describe('a failing listing never fails the sync', () => {
  const SENTINEL = 'https://api.github.test/repos/acme/widgets/pulls?token=hunter2'

  function failingSource(): SupersedingPullSource {
    return {
      async listOpenPullsForPair() {
        const err = new Error(`request to ${SENTINEL} failed`)
        err.name = 'GithubRequestError'
        throw err
      },
    }
  }

  test('answers not-archived, warning exactly once', async () => {
    const lines: string[] = []
    const detector = createLocalArchiveDetector({
      source: failingSource(),
      store: untouchedStore(),
      warn: (line) => lines.push(line),
    })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: null, requested: true })
    expect(lines).toHaveLength(1)
  })

  test('the warning names the error kind', async () => {
    const lines: string[] = []
    const detector = createLocalArchiveDetector({
      source: failingSource(),
      store: untouchedStore(),
      warn: (line) => lines.push(line),
    })
    await detector.detect(review())
    expect(lines[0]).toContain('GithubRequestError')
  })

  test('the warning carries nothing from the error message', async () => {
    const lines: string[] = []
    const detector = createLocalArchiveDetector({
      source: failingSource(),
      store: untouchedStore(),
      warn: (line) => lines.push(line),
    })
    await detector.detect(review())
    expect(lines[0]).not.toContain('hunter2')
  })

  test('the warning carries no URL from the error message', async () => {
    const lines: string[] = []
    const detector = createLocalArchiveDetector({
      source: failingSource(),
      store: untouchedStore(),
      warn: (line) => lines.push(line),
    })
    await detector.detect(review())
    expect(lines[0]).not.toContain('https://')
  })

  test('a rejection that is not an Error still warns without its content', async () => {
    const lines: string[] = []
    const detector = createLocalArchiveDetector({
      source: {
        listOpenPullsForPair: () => Promise.reject('hunter2 leaked as a bare string'),
      },
      store: untouchedStore(),
      warn: (line) => lines.push(line),
    })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: null, requested: true })
    expect(lines[0]).not.toContain('hunter2')
  })
})

describe('a matching pull request archives the review', () => {
  test('the store is written once with the review id and the pull number', async () => {
    const store = recordingStore()
    const detector = createLocalArchiveDetector({ source: recordingSource([pull()]), store })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: 12, requested: true })
    expect(store.writes).toEqual([{ localId: REVIEW_ID, prNumber: 12 }])
  })

  test('several matches archive against the lowest number', async () => {
    const store = recordingStore()
    const detector = createLocalArchiveDetector({
      source: recordingSource([pull({ number: 12 }), pull({ number: 7 })]),
      store,
    })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: 7, requested: true })
    expect(store.writes).toEqual([{ localId: REVIEW_ID, prNumber: 7 }])
  })

  test('a write-once store that already holds an earlier number reports that one', async () => {
    const store = recordingStore(5)
    const detector = createLocalArchiveDetector({ source: recordingSource([pull()]), store })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: 5, requested: true })
    expect(store.writes).toEqual([{ localId: REVIEW_ID, prNumber: 12 }])
  })

  test('a store that reports no row after the write answers null rather than guessing', async () => {
    const detector = createLocalArchiveDetector({
      source: recordingSource([pull()]),
      store: { markLocalReviewArchived: () => {}, getLocalReview: () => null },
    })
    const verdict = await detector.detect(review())
    expect(verdict).toEqual({ archivedPr: null, requested: true })
  })
})

// ————————————————————————————————————————————————————————————————
// The module imports only the shared package — a structural absence
// ————————————————————————————————————————————————————————————————

const MODULE_PATH = new URL('./local-archive.ts', import.meta.url).pathname

/**
 * The statement and expression forms that can pull a module into a file.
 * Capture group 2 is the specifier in every one of them.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^[ \t]*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/gm,
  /^[ \t]*import\s*(['"])([^'"]+)\1/gm,
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

const FIXTURE_WITH_A_CLIENT_IMPORT = [
  '/**',
  ' * A docstring may explain the absence of a github client in prose, including',
  " * by quoting the statement `import type { GithubClient } from './github-client'`",
  ' * that must never appear, without the explanation counting as an import.',
  ' */',
  "import type { LocalReviewSummary } from '@revu/shared'",
  "import type { GithubClient } from './github-client'",
  "import type { DirectStore } from './store'",
  '',
  'export const dead = (s: LocalReviewSummary, c: GithubClient, d: DirectStore) => [s, c, d]',
].join('\n')

describe('the import scan cannot pass by reading nothing', () => {
  test('the module source reads non-empty', () => {
    expect(readFileSync(MODULE_PATH, 'utf8').trim().length).toBeGreaterThan(0)
  })

  test('the extractor reports the banned specifiers in a fixture that has them', () => {
    expect(importSpecifiers(FIXTURE_WITH_A_CLIENT_IMPORT)).toEqual([
      '@revu/shared',
      './github-client',
      './store',
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
})

describe('the detector module imports only the shared package', () => {
  test('it imports no sibling module at all', () => {
    const relative = importSpecifiers(readFileSync(MODULE_PATH, 'utf8')).filter(
      (spec) => spec.startsWith('.') || spec.startsWith('/'),
    )
    expect(relative).toEqual([])
  })

  test('every specifier it does carry is the shared package', () => {
    const specifiers = importSpecifiers(readFileSync(MODULE_PATH, 'utf8'))
    expect([...new Set(specifiers)]).toEqual(['@revu/shared'])
  })
})

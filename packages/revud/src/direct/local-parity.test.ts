/**
 * Structural parity between the two producers of a snapshot's immutable half:
 * the API-shaped one that reads a hosted pull request, and the git-only one that
 * reads two local branches.
 *
 * Both are run over one change set and compared on the rules they must share,
 * never on the bytes they emit. A byte comparison would be the wrong assertion
 * even where it is available: git pairs a rename by a similarity score whose
 * threshold a forge has no obligation to match, so two correct producers can
 * legitimately disagree about whether one pair of paths is a rename or a removal
 * beside an addition. What may never differ is the shape — the field set, the key
 * a blob index entry lives under, the spelling of the cache key, the meaning of
 * an absent patch, and the vocabulary a status is drawn from. Those five are what
 * this file asserts.
 *
 * ## Where each side's input comes from
 *
 * One seeded repository feeds both. The API-shaped side is driven through the
 * shared fake client, whose file list, merge-base tree and commits are derived
 * from that repository's own `--raw` and `--numstat` output, so the two producers
 * see the same change set by construction rather than through a second,
 * hand-written copy of it that would drift away from the first.
 *
 * The derivation uses only the functions that read git's output formats. The
 * three that build the contract shape are deliberately not among them: deriving
 * one side's input from the other side's shape builder would make every
 * comparison below hold because the two halves moved together, which is the one
 * failure a parity test exists to rule out.
 *
 * ## Why the private producer is reached through the public one
 *
 * The API-shaped producer is module-private. It is driven here through the sync
 * entry point that already calls it, and its output is read off the snapshot that
 * comes back. Exporting it to make this file shorter would mean asserting parity
 * against an interface no other caller has.
 *
 * ## Why the seeded range's contents are asserted before anything is compared
 *
 * Three of the five comparisons are over sets that can be empty: a rename, a
 * binary path and a path whose object is not file content. A change set carrying
 * none of them would let all three compare nothing against nothing and pass
 * forever. The first group below therefore pins what the range actually contains,
 * reading git's records rather than either producer's output, so those pins stay
 * standing when a producer is wrong.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PullFile, Snapshot, SnapshotImmutable } from '@revu/shared'
import { createBunCommandRunner } from './command-runner'
import { CONFORMANCE_REPO, MOVING_BASE_PR, movingBaseClient } from './conformance-fakes'
import type {
  GhCompareRaw,
  GhTreeEntry,
  GhTreeRaw,
  GithubClient,
  Page,
  PageParams,
} from './github-client'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import {
  parseNumstatZ,
  parseRawZ,
  patchHunks,
  patchSectionCount,
  readLocalSnapshotImmutable,
  resolveLocalRange,
  splitPatchSections,
  type LocalSnapshot,
  type NumstatRecord,
  type RawDiffRecord,
} from './local-sync'
import { openDirectStore, type DirectStore } from './store'
import { syncPull } from './sync'

/**
 * The four statuses the wire shape declares, spelled as a total record over the
 * union so a fifth member added to the contract is a compile error here rather
 * than a silently unchecked value. Only the keys are read.
 */
const CONTRACT_STATUSES: Readonly<Record<PullFile['status'], true>> = {
  added: true,
  modified: true,
  removed: true,
  renamed: true,
}

/**
 * The status letters the seeded range produces, onto the wire vocabulary — the
 * forge's own mapping, written here rather than borrowed from the git-only
 * producer, so a regression in that producer's mapping moves one side only.
 * A letter with no entry throws where it is read: a range that grew a case this
 * does not cover must be looked at, not quietly mapped to something near it.
 */
const FORGE_STATUS: Readonly<Partial<Record<RawDiffRecord['status'], PullFile['status']>>> = {
  A: 'added',
  D: 'removed',
  M: 'modified',
  R: 'renamed',
  // A forge has no notion of a file's object class, so a path that stopped being
  // a link and became a file is reported to it as what it looks like from the
  // outside: the same path, holding different content.
  T: 'modified',
}

/** A raw changed-file entry as the forge's files endpoint spells one. */
interface ForgeFileRaw {
  sha: string
  filename: string
  status: PullFile['status']
  additions: number
  deletions: number
  changes: number
  previous_filename?: string
  patch?: string
}

/** How many times the fake answered each read the immutable half is built from. */
interface ForgeCalls {
  pullDetail: number
  compare: number
  files: number
  tree: number
  commits: number
}

/** One page of items, with every page after the first empty. */
function onePage<T>(items: readonly T[], params: PageParams): Page<T> {
  return params.page === 1 ? { items: [...items], hasNext: false } : { items: [], hasNext: false }
}

/**
 * Runs one git command directly against the seeded repository and returns its
 * stdout untouched. Untrimmed, because `-z` output ends in a terminator that is
 * part of the format and trimming it would change what the parsers are handed.
 */
async function gitRaw(dir: string, args: readonly string[]): Promise<string> {
  const result = await createBunCommandRunner().run(['git', ...args], { cwd: dir })
  if (!result.ok) {
    throw new Error(`\`git ${args.join(' ')}\` exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/**
 * Turns git's records into the file list the forge's files endpoint would return.
 *
 * The records and the counts are one entry per changed path; the patch sections
 * are not, because a type change is emitted as a deletion followed by a creation.
 * The section cursor therefore advances by each record's own span, read from the
 * function that describes git's output format rather than from either producer's
 * shape builder.
 */
function forgeFiles(
  records: readonly RawDiffRecord[],
  counts: readonly NumstatRecord[],
  sections: readonly string[],
): ForgeFileRaw[] {
  const spans = records.map((record) => patchSectionCount(record.status))
  const expectedSections = spans.reduce((total, span) => total + span, 0)
  if (counts.length !== records.length || sections.length !== expectedSections) {
    throw new Error(
      `the three reads of one range disagree: ${records.length} record(s), ${counts.length} count(s), ${sections.length} section(s) where ${expectedSections} were expected`,
    )
  }
  let cursor = 0
  return records.map((record, index) => {
    const status = FORGE_STATUS[record.status]
    if (status === undefined) {
      throw new Error(`no wire status for a ${record.status} record at ${record.path}`)
    }
    const count = counts[index]
    const span = sections.slice(cursor, cursor + spans[index])
    cursor += spans[index]
    const file: ForgeFileRaw = {
      // A removal has no head-side object, and the forge reports the pre-image
      // object name in this field — the only name that identifies the file.
      sha: record.status === 'D' ? record.srcSha : record.dstSha,
      filename: record.path,
      status,
      additions: count.additions,
      deletions: count.deletions,
      changes: count.additions + count.deletions,
    }
    if (record.previousPath !== undefined) file.previous_filename = record.previousPath
    // The key is assigned only where git reported line counts. Its absence is the
    // forge's own notation for a file it will not diff, and reproducing that
    // absence — rather than an empty string — is the whole of the convention.
    if (!count.binary) {
      const hunks = span.map(patchHunks)
      if (hunks.some((text) => text === undefined)) {
        throw new Error(`${record.path} has line counts but no hunks to go with them`)
      }
      file.patch = hunks.join('\n')
    }
    return file
  })
}

/** Turns git's records into the merge-base tree listing the forge would return. */
function forgeTree(records: readonly RawDiffRecord[]): GhTreeEntry[] {
  const entries: GhTreeEntry[] = []
  for (const record of records) {
    // An addition has no base side, so the merge base's tree holds nothing for it.
    if (record.status === 'A') continue
    // A tree lists both regular files and symlinks as `blob` — the mode tells
    // them apart and a tree listing does not carry one. A submodule would be
    // typed `commit`; the range has none on that side, and a branch for a case
    // the repository cannot produce is a branch nothing reaches.
    entries.push({ path: record.previousPath ?? record.path, type: 'blob', sha: record.srcSha })
  }
  return entries
}

/**
 * The commits the forge would report for the range. Only the object names are
 * carried over: nothing below reads a commit's message, author or parents, and
 * inventing values for them would suggest they were compared.
 */
function forgeCommits(shas: readonly string[]): unknown[] {
  return shas.map((sha) => ({ sha, commit: { message: '', author: { date: '' } }, parents: [] }))
}

/**
 * The shared fake, answering for the seeded repository: the pair of commits it
 * really has, and the change set really read out of it. Everything else — the
 * conversation, the reviews, the checks, the write methods — is the fake's own,
 * so parity is asserted against the same client the rest of the suite trusts.
 */
function forgeClient(
  fixture: FixtureRepo,
  files: readonly ForgeFileRaw[],
  tree: readonly GhTreeEntry[],
  calls: ForgeCalls,
): GithubClient {
  const fake = movingBaseClient({ mergeBaseSha: fixture.mergeBaseSha, unresolvedComments: 0 })
  return {
    ...fake,
    async getPullDetail(owner: string, repo: string, prNumber: number): Promise<unknown> {
      calls.pullDetail += 1
      const detail = (await fake.getPullDetail(owner, repo, prNumber)) as Record<string, unknown>
      // The two tips the seeded repository actually has. Parity on a compare key
      // is only a claim about one pair of commits if both sides read that pair.
      return { ...detail, head: { sha: fixture.headSha }, base: { sha: fixture.baseSha } }
    },
    async getCompare(
      owner: string,
      repo: string,
      base: string,
      head: string,
    ): Promise<GhCompareRaw> {
      calls.compare += 1
      return fake.getCompare(owner, repo, base, head)
    },
    async getPullFiles(
      _owner: string,
      _repo: string,
      _prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      calls.files += 1
      return onePage(files, params)
    },
    async getTree(): Promise<GhTreeRaw> {
      calls.tree += 1
      return { tree: [...tree], truncated: false }
    },
    async getPullCommits(
      _owner: string,
      _repo: string,
      _prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      calls.commits += 1
      return onePage(forgeCommits(fixture.headCommitShas), params)
    },
  }
}

// ————————————————————————————————————————————————————————————————————————————
// One seeded range, read by both producers.
// ————————————————————————————————————————————————————————————————————————————

let fixture: FixtureRepo
let records: readonly RawDiffRecord[]
let counts: readonly NumstatRecord[]
let derivedFiles: readonly ForgeFileRaw[]
let derivedTree: readonly GhTreeEntry[]
let local: LocalSnapshot
let forged: Snapshot
let store: DirectStore
let cachedBeforeSync: ReturnType<DirectStore['getImmutable']>
const calls: ForgeCalls = { pullDetail: 0, compare: 0, files: 0, tree: 0, commits: 0 }

/** Both producers' output, named the way the comparisons below read them. */
function immutables(): { git: SnapshotImmutable; forge: SnapshotImmutable } {
  return { git: local.immutable, forge: forged.immutable }
}

beforeAll(async () => {
  fixture = await createFixtureRepo()
  const runner = createBunCommandRunner()

  // ——— The git-only producer, from the branch pair, so the range and the key
  // it is cached under are both built by the code under test.
  const resolved = await resolveLocalRange(runner, fixture.dir, {
    baseRef: `refs/heads/${fixture.baseBranch}`,
    headRef: `refs/heads/${fixture.headBranch}`,
  })
  if (!resolved.ok) throw new Error(`the seeded pair must resolve, got ${resolved.reason}`)
  const read = await readLocalSnapshotImmutable(runner, fixture.dir, resolved.range)
  if (!read.ok) throw new Error(`the seeded range must read, got ${read.reason}`)
  local = read.snapshot

  // ——— The same range, read again outside both producers, and reshaped into
  // what the forge's endpoints would have answered for it.
  const range = [resolved.range.mergeBaseSha, resolved.range.headSha]
  const raw = parseRawZ(
    await gitRaw(fixture.dir, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--raw',
      '--no-abbrev',
      '-M',
      '-z',
      ...range,
    ]),
  )
  if (!raw.ok) throw new Error(`the seeded range's records must parse, got ${raw.detail}`)
  const numstat = parseNumstatZ(
    await gitRaw(fixture.dir, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--numstat',
      '-M',
      '-z',
      ...range,
    ]),
  )
  if (!numstat.ok) throw new Error(`the seeded range's counts must parse, got ${numstat.detail}`)
  const sections = splitPatchSections(
    await gitRaw(fixture.dir, ['-c', 'core.quotePath=false', 'diff', '-M', '--unified=3', ...range]),
  )
  records = raw.records
  counts = numstat.records
  derivedFiles = forgeFiles(records, counts, sections)
  derivedTree = forgeTree(records)

  // ——— The API-shaped producer, reached through the entry point that calls it.
  store = openDirectStore({ dataDir: ':memory:' })
  cachedBeforeSync = store.getImmutable(resolved.range.compareKey)
  forged = await syncPull(
    {
      github: forgeClient(fixture, derivedFiles, derivedTree, calls),
      repo: CONFORMANCE_REPO,
      store,
    },
    MOVING_BASE_PR,
  )
})

afterAll(() => {
  fixture.dispose()
})

// ————————————————————————————————————————————————————————————————————————————
// What the range contains, so the comparisons below are over non-empty sets.
// Read from git's own records, never from either producer's output.
// ————————————————————————————————————————————————————————————————————————————

describe('the seeded range carries every case the comparisons depend on', () => {
  test('it contains exactly one rename, between the two paths the repository seeded', () => {
    const renames = records.filter((record) => record.status === 'R')
    expect(renames.map((record) => [record.previousPath, record.path])).toEqual([
      [fixture.paths.renamedFrom, fixture.paths.renamedTo],
    ])
  })

  test('it contains exactly one path git reports as binary', () => {
    const binaries = counts.filter((count) => count.binary).map((count) => count.path)
    expect(binaries).toEqual([fixture.paths.binary])
  })

  test('it contains three paths whose object is not file content', () => {
    // Read off the file modes rather than off the skip decision, so this stays
    // standing when the code that makes that decision is wrong. Both sides are
    // read: the type-changed path holds an ordinary blob on the head side and is
    // unreadable only because of what it stopped being.
    const unreadable = records
      .filter((record) =>
        [record.srcMode, record.dstMode].some((mode) => mode === '120000' || mode === '160000'),
      )
      .map((record) => record.path)
    expect(unreadable.sort()).toEqual(
      [fixture.paths.symlink, fixture.paths.gitlink, fixture.paths.typechanged].sort(),
    )
  })

  test('it spans five distinct status letters, so a vocabulary claim over it is not trivial', () => {
    const letters = [...new Set(records.map((record) => record.status))].sort()
    expect(letters).toEqual(['A', 'D', 'M', 'R', 'T'])
  })

  test('the letter that has no wire member of its own is one of them', () => {
    // `T` is the case the two producers cannot both reach by the same route: git
    // names it, and a forge has no vocabulary for it at all. Pinned separately so
    // that removing it from the range breaks a named assertion rather than only
    // shortening a list.
    expect(records.filter((record) => record.status === 'T').map((record) => record.path)).toEqual([
      fixture.paths.typechanged,
    ])
  })

  test('the pair both producers read is the one the repository seeded', () => {
    const { git, forge } = immutables()
    expect([git.mergeBaseSha, git.headSha]).toEqual([fixture.mergeBaseSha, fixture.headSha])
    expect([forge.mergeBaseSha, forge.headSha]).toEqual([fixture.mergeBaseSha, fixture.headSha])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The API-shaped producer ran, and produced what it was handed. A sync that
// failed, or one answered out of the cache, would make agreement meaningless.
// ————————————————————————————————————————————————————————————————————————————

describe('the API-shaped producer really ran over the derived change set', () => {
  test('every read the immutable half is assembled from was answered', () => {
    expect(calls).toEqual({ pullDetail: 1, compare: 1, files: 1, tree: 1, commits: 1 })
  })

  test('the half was built on this sync, not reused from the store', () => {
    // Nothing was under the key before, and the built half was written under it —
    // so the shape compared below came from the producer and not from a cache.
    expect(cachedBeforeSync).toBeNull()
    const cached = store.getImmutable(forged.immutable.compareKey)
    expect(cached?.immutable.compareKey).toBe(forged.immutable.compareKey)
  })

  test('it carries the derived file list, in the order it was handed', () => {
    expect(forged.immutable.files.map((file) => file.filename)).toEqual(
      derivedFiles.map((file) => file.filename),
    )
    expect(derivedFiles.length).toBe(records.length)
  })

  test('the derived merge-base tree reached the blob index', () => {
    // An empty or ignored tree would leave every base side null and still pass
    // the keying comparison, which reads keys only.
    const modified = records.find((record) => record.path === fixture.paths.modified)
    expect(forged.immutable.blobIndex[fixture.paths.modified]?.base).toBe(modified?.srcSha)
    expect(derivedTree.map((entry) => entry.path)).toContain(fixture.paths.modified)
  })

  test('both producers report the same commits, oldest first', () => {
    const { git, forge } = immutables()
    expect(git.commits.map((commit) => commit.sha)).toEqual([...fixture.headCommitShas])
    expect(forge.commits.map((commit) => commit.sha)).toEqual([...fixture.headCommitShas])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The five shape rules.
// ————————————————————————————————————————————————————————————————————————————

describe('the two producers agree on the field set', () => {
  test('neither carries a field the other does not', () => {
    const { git, forge } = immutables()
    expect(Object.keys(git).sort()).toEqual(Object.keys(forge).sort())
  })

  test('what they agree on is the six fields the contract declares', () => {
    // Pinned as its own literal rather than left to the comparison above: two
    // producers that dropped the same field would agree with each other and say
    // nothing about the shape they are both supposed to be producing.
    const { git } = immutables()
    expect(Object.keys(git).sort()).toEqual([
      'blobIndex',
      'commits',
      'compareKey',
      'files',
      'headSha',
      'mergeBaseSha',
    ])
  })
})

describe('the two producers key the blob index the same way', () => {
  test('the same paths carry an entry, once the unreadable objects are set aside', () => {
    const { git, forge } = immutables()
    const skipped = Object.keys(local.skippedBlobPaths)
    const comparable = Object.keys(forge.blobIndex).filter((path) => !skipped.includes(path))
    expect(Object.keys(git.blobIndex).sort()).toEqual(comparable.sort())
  })

  test('setting those aside removed something, so the comparison is over a real difference', () => {
    // Without this the comparison above could be between two identical lists for
    // the trivial reason that nothing was ever filtered out of either.
    const { git, forge } = immutables()
    expect(Object.keys(local.skippedBlobPaths).sort()).toEqual(
      [fixture.paths.symlink, fixture.paths.gitlink, fixture.paths.typechanged].sort(),
    )
    expect(Object.keys(forge.blobIndex).length).toBeGreaterThan(Object.keys(git.blobIndex).length)
  })

  test('the rename lives under the new path on both sides', () => {
    const { git, forge } = immutables()
    expect(Object.keys(git.blobIndex)).toContain(fixture.paths.renamedTo)
    expect(Object.keys(forge.blobIndex)).toContain(fixture.paths.renamedTo)
  })

  test('and under the new path only', () => {
    const { git, forge } = immutables()
    expect(Object.keys(git.blobIndex)).not.toContain(fixture.paths.renamedFrom)
    expect(Object.keys(forge.blobIndex)).not.toContain(fixture.paths.renamedFrom)
  })
})

describe('the two producers spell the cache key identically', () => {
  test('the two keys are the same string', () => {
    // The single comparison that makes a forked two-half cache impossible to
    // introduce quietly: content stored by one producer is found by the other
    // only while this holds.
    const { git, forge } = immutables()
    expect(git.compareKey).toBe(forge.compareKey)
  })

  test('the string they share joins the merge base to the head with three dots', () => {
    const { git } = immutables()
    expect(git.compareKey).toBe(`${fixture.mergeBaseSha}...${fixture.headSha}`)
  })
})

describe('an absent patch means the same thing to both producers', () => {
  test('the binary path carries no patch key on either side', () => {
    const { git, forge } = immutables()
    const fromGit = git.files.find((file) => file.filename === fixture.paths.binary)
    const fromForge = forge.files.find((file) => file.filename === fixture.paths.binary)
    expect([fromGit === undefined, fromForge === undefined]).toEqual([false, false])
    expect(['patch' in (fromGit ?? {}), 'patch' in (fromForge ?? {})]).toEqual([false, false])
  })

  test('a text path carries one on both sides, so the absence is a fact about the file', () => {
    // The control. Without it the assertion above would hold just as well over a
    // producer that never emits a patch key at all.
    const { git, forge } = immutables()
    const fromGit = git.files.find((file) => file.filename === fixture.paths.modified)
    const fromForge = forge.files.find((file) => file.filename === fixture.paths.modified)
    expect(['patch' in (fromGit ?? {}), 'patch' in (fromForge ?? {})]).toEqual([true, true])
  })
})

describe('the git-only producer draws its statuses from the contract vocabulary', () => {
  test('every status it emits is one of the four', () => {
    // Stated as containment rather than as an expected list so it also covers a
    // letter the seeded range does not carry: a copy or a type change mapped to
    // a word the wire shape has no member for fails here without `-C` ever
    // having to be passed.
    const { git } = immutables()
    const emitted = [...new Set(git.files.map((file) => file.status))].sort()
    const declared = Object.keys(CONTRACT_STATUSES).sort()
    expect(emitted.filter((status) => !declared.includes(status))).toEqual([])
  })

  test('the four it draws from are the four the contract declares', () => {
    expect(Object.keys(CONTRACT_STATUSES).sort()).toEqual([
      'added',
      'modified',
      'removed',
      'renamed',
    ])
  })
})

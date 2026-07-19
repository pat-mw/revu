import type { CommitInfo, PullFile } from '@revu/shared'

/**
 * A synthetic large pull request: a diff whose changed lines total well past two
 * thousand, spread across dozens of source files. It exists to give the sync
 * engine a realistically heavy payload to paginate, map, and blob-provision in
 * one burst — the kind of PR that would expose a gross performance regression in
 * the read path if one were introduced.
 *
 * The fixture describes the REMOTE side in the same vocabulary GitHub returns:
 * per-file unified `patch` hunks that are consistent with the base/head blob
 * bodies, a base/head blob pair per path, and a merge-base tree that carries the
 * base-side blob SHA for every changed path. A fake `GithubClient` serves these
 * verbatim so the ACTUAL `syncPull` engine runs over them unchanged; nothing here
 * runs in a live daemon, and no network, `gh`, or disk beyond an in-memory store
 * is touched.
 *
 * Everything is generated deterministically from a per-file seed, so the diff is
 * byte-stable across runs — a timing measurement over it is comparing like with
 * like every time, and the blob SHAs are content-addressed exactly as the engine
 * expects (identical bytes ⇒ identical SHA ⇒ a store hit on the warm pass).
 */

/**
 * A deterministic fake git blob SHA from a label — a 40-hex-char string that is
 * stable across reloads. Content-addressing only needs a stable, collision-free
 * mapping from a label to a hex string; this FNV-style mix provides one without a
 * crypto dependency.
 */
function fakeSha(label: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < label.length; i++) {
    h1 = ((h1 ^ label.charCodeAt(i)) * 0x01000193) >>> 0
    h2 = ((h2 + label.charCodeAt(i)) * 0x85ebca6b) >>> 0
  }
  const hex = (n: number): string => n.toString(16).padStart(8, '0')
  return (hex(h1) + hex(h2) + hex((h1 ^ h2) >>> 0) + hex((h1 + h2) >>> 0)).slice(0, 40)
}

/** Count real additions/deletions from a unified patch so file numbers never drift from the hunk. */
function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

/** A base/head blob pair the fake client can hand back on demand. */
export interface FixtureBlob {
  sha: string
  path: string
  content: string
  size: number
  binary: boolean
}

/** The fully assembled large-PR fixture the fake `GithubClient` serves. */
export interface LargePrFixture {
  headSha: string
  baseSha: string
  mergeBaseSha: string
  compareKey: string
  /** Every changed file, GitHub `pulls/{n}/files` shape (with a real `patch`). */
  files: PullFile[]
  /** path → { base, head } blob SHA, exactly what `syncPull` writes into blobIndex. */
  blobIndex: Record<string, { base: string | null; head: string | null }>
  /** SHA → blob bytes, both sides, keyed for the fake client's blob endpoints. */
  blobsBySha: Record<string, FixtureBlob>
  /** Merge-base recursive tree entries — the base-side blob SHA per changed path. */
  treeEntries: { path: string; type: 'blob'; sha: string }[]
  commits: CommitInfo[]
  /** How many distinct git blob SHAs the sync must provision (base + head, deduped). */
  uniqueBlobShaCount: number
  /** additions + deletions across every file — the "size" the budget test documents. */
  totalChangedLines: number
}

/** Number of changed source files in the fixture. */
const FILE_COUNT = 40

/** Roughly how many lines each generated file body carries (base and head both). */
const LINES_PER_FILE = 60

/**
 * Build one file's base and head bodies plus the unified patch between them. The
 * head rewrites a contiguous band of lines in the middle of the file and appends
 * a few, producing a mix of deletions, additions, and unchanged context — the
 * shape a real feature diff has, not a trivial one-liner.
 */
function buildFile(index: number): {
  file: PullFile
  base: FixtureBlob
  head: FixtureBlob
} {
  const path = `src/module_${String(index).padStart(2, '0')}/handler.ts`

  // A stable per-file body: `LINES_PER_FILE` lines of plausible source.
  const baseLines: string[] = []
  for (let i = 0; i < LINES_PER_FILE; i++) {
    baseLines.push(`  const step_${index}_${i} = compute(input, ${i}) // base revision`)
  }

  // The head rewrites a band of lines [start, start+span) and appends a tail, so
  // the diff carries both deletions (old band) and additions (new band + tail).
  const bandStart = 20
  const bandSpan = 24
  const headLines = baseLines.slice()
  for (let i = bandStart; i < bandStart + bandSpan; i++) {
    headLines[i] = `  const step_${index}_${i} = compute(input, ${i}) // head revision, reworked`
  }
  const tail: string[] = []
  for (let i = 0; i < 16; i++) {
    tail.push(`  audit.record('module_${index}', ${i}) // appended in head`)
  }
  headLines.push(...tail)

  const baseContent = baseLines.join('\n') + '\n'
  const headContent = headLines.join('\n') + '\n'

  // One unified hunk covering the reworked band, plus a hunk for the appended
  // tail. Line numbers are 1-based; the hunk header math mirrors a real diff.
  const contextBefore = baseLines[bandStart - 1]
  const contextAfter = baseLines[bandStart + bandSpan]
  const removed = baseLines
    .slice(bandStart, bandStart + bandSpan)
    .map((l) => `-${l}`)
    .join('\n')
  const added = headLines
    .slice(bandStart, bandStart + bandSpan)
    .map((l) => `+${l}`)
    .join('\n')
  const appended = tail.map((l) => `+${l}`).join('\n')

  const bandHunk =
    `@@ -${bandStart},${bandSpan + 2} +${bandStart},${bandSpan + 2} @@\n` +
    ` ${contextBefore}\n${removed}\n${added}\n ${contextAfter}`
  const tailHunk =
    `@@ -${LINES_PER_FILE},1 +${LINES_PER_FILE},${1 + tail.length} @@\n` +
    ` ${baseLines[LINES_PER_FILE - 1]}\n${appended}`
  const patch = `${bandHunk}\n${tailHunk}`

  const base: FixtureBlob = {
    sha: fakeSha(`large-pr:base:${path}`),
    path,
    content: baseContent,
    size: baseContent.length,
    binary: false,
  }
  const head: FixtureBlob = {
    sha: fakeSha(`large-pr:head:${path}`),
    path,
    content: headContent,
    size: headContent.length,
    binary: false,
  }

  const { additions, deletions } = countPatch(patch)
  const file: PullFile = {
    sha: head.sha,
    filename: path,
    status: 'modified',
    additions,
    deletions,
    changes: additions + deletions,
    patch,
  }
  return { file, base, head }
}

/**
 * Assemble the large-PR fixture once, deterministically. Memoized so repeated
 * calls in a test file share the same object (and the same generation cost is
 * paid once, outside any measured window).
 */
let cached: LargePrFixture | null = null

export function largePrFixture(): LargePrFixture {
  if (cached !== null) return cached

  const headSha = fakeSha('large-pr/head')
  const baseSha = fakeSha('large-pr/base-branch')
  const mergeBaseSha = fakeSha('large-pr/merge-base')

  const files: PullFile[] = []
  const blobIndex: Record<string, { base: string | null; head: string | null }> = {}
  const blobsBySha: Record<string, FixtureBlob> = {}
  const treeEntries: { path: string; type: 'blob'; sha: string }[] = []

  for (let i = 0; i < FILE_COUNT; i++) {
    const { file, base, head } = buildFile(i)
    files.push(file)
    blobIndex[file.filename] = { base: base.sha, head: head.sha }
    blobsBySha[base.sha] = base
    blobsBySha[head.sha] = head
    treeEntries.push({ path: file.filename, type: 'blob', sha: base.sha })
  }

  const totalChangedLines = files.reduce((n, f) => n + f.changes, 0)
  const uniqueBlobShaCount = Object.keys(blobsBySha).length

  const commits: CommitInfo[] = []
  for (let i = 0; i < 12; i++) {
    commits.push({
      sha: fakeSha(`large-pr/commit/${i}`),
      commit: {
        message: `refactor: rework module band ${i}`,
        author: {
          name: 'Author',
          email: 'author@example.dev',
          date: `2026-05-${String(1 + i).padStart(2, '0')}T00:00:00.000Z`,
        },
      },
      author: null,
      parents: [{ sha: fakeSha(`large-pr/commit/${i - 1}`) }],
    })
  }

  cached = {
    headSha,
    baseSha,
    mergeBaseSha,
    compareKey: `${mergeBaseSha}...${headSha}`,
    files,
    blobIndex,
    blobsBySha,
    treeEntries,
    commits,
    uniqueBlobShaCount,
    totalChangedLines,
  }
  return cached
}

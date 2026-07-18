/**
 * The local-first blob provider, driven entirely by fakes — no real git, no `gh`,
 * no network, no disk beyond an in-memory SQLite store. The tests pin the cost
 * ladder and the `syncStats` honesty it exists to guarantee:
 *
 *   - Tier order: content-addressed store hit → local `git cat-file` (zero API
 *     cost) → the GitHub API (GraphQL `object()` batch, then a REST straggler).
 *   - `syncStats` honesty: a store hit is `blobsReused`; a local-git read costs
 *     NOTHING and is not a fetch; only an actual API transfer is `blobsFetched`.
 *   - The binary heuristic: a NUL byte in the first 8000 bytes marks a blob
 *     binary, `size` is populated, and a binary is COLLAPSED (empty content).
 *   - The base64 REST decode and the `object()` batch shape.
 *   - A blob no tier can produce is reported `missing`, never fabricated.
 */
import { describe, expect, test } from 'bun:test'
import type { SnapshotImmutable } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import type {
  GhBlobRaw,
  GhGraphqlBlobObject,
  GhGraphqlPageInfo,
  GhReviewThreadNode,
  GithubClient,
} from './github-client'
import type { RepoRef } from './repo'
import { openDirectStore, type DirectStore } from './store'
import { isBinaryContent, provisionBlobs } from './blobs'

const REPO: RepoRef = { owner: 'o', repo: 'r' }

function memStore(): DirectStore {
  return openDirectStore({ dataDir: ':memory:' })
}

/** A blob index with a single path carrying a base and head SHA. */
function indexOf(
  entries: Record<string, { base: string | null; head: string | null }>,
): SnapshotImmutable['blobIndex'] {
  return entries
}

/** A fake `git cat-file`: `objects` maps SHA → its raw bytes; absent SHAs report "not found". */
function fakeGitRunner(objects: Record<string, Uint8Array>): {
  runner: CommandRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const runner: CommandRunner = {
    async run(args: string[]): Promise<CommandResult> {
      calls.push(args)
      const [, sub, flagOrType, sha] = args
      if (sub !== 'cat-file') {
        return { ok: false, code: -1, stdout: '', stderr: 'unexpected command' }
      }
      // `-e {sha}` existence probe.
      if (flagOrType === '-e') {
        const present = objects[sha] !== undefined
        return { ok: present, code: present ? 0 : 1, stdout: '', stderr: '' }
      }
      // `-s {sha}` size.
      if (flagOrType === '-s') {
        const bytes = objects[sha]
        if (bytes === undefined) return { ok: false, code: 1, stdout: '', stderr: '' }
        return { ok: true, code: 0, stdout: `${bytes.length}\n`, stderr: '' }
      }
      // `blob {sha}` read.
      if (flagOrType === 'blob') {
        const bytes = objects[sha]
        if (bytes === undefined) return { ok: false, code: 1, stdout: '', stderr: '' }
        return { ok: true, code: 0, stdout: new TextDecoder().decode(bytes), stderr: '' }
      }
      return { ok: false, code: -1, stdout: '', stderr: 'unexpected cat-file args' }
    },
  }
  return { runner, calls }
}

/** A runner where git is entirely absent — every invocation fails (offline, no repo). */
const NO_GIT: CommandRunner = {
  async run(): Promise<CommandResult> {
    return { ok: false, code: -1, stdout: '', stderr: 'git: command not found' }
  },
}

interface ApiCalls {
  blobObjects: number
  blob: number
  blobObjectShas: string[][]
}

/**
 * A fake GitHub client for the blob API tiers. `objects` supplies GraphQL
 * `object()` results (null = unresolvable); `restBlobs` supplies single-blob REST
 * results. Everything else throws — the provider must never call the sync reads.
 */
function fakeApi(opts: {
  objects?: Record<string, GhGraphqlBlobObject | null>
  restBlobs?: Record<string, GhBlobRaw>
}): { client: GithubClient; calls: ApiCalls } {
  const calls: ApiCalls = { blobObjects: 0, blob: 0, blobObjectShas: [] }
  const notUsed = (): never => {
    throw new Error('the blob provider must not call this method')
  }
  const client: GithubClient = {
    getViewer: notUsed,
    getPullDetail: notUsed,
    getCompare: notUsed,
    getPullFiles: notUsed as unknown as GithubClient['getPullFiles'],
    getIssueComments: notUsed as unknown as GithubClient['getIssueComments'],
    getPullReviews: notUsed as unknown as GithubClient['getPullReviews'],
    getPullCommits: notUsed as unknown as GithubClient['getPullCommits'],
    getCheckRuns: notUsed,
    getTree: notUsed,
    async getBlob(_o, _r, sha): Promise<GhBlobRaw> {
      calls.blob += 1
      const raw = opts.restBlobs?.[sha]
      if (raw === undefined) {
        // A REST 404 surfaces as a thrown error the provider catches → missing.
        throw new Error(`no rest blob for ${sha}`)
      }
      return raw
    },
    async getBlobObjects(_o, _r, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      calls.blobObjects += 1
      calls.blobObjectShas.push([...shas])
      const out: Record<string, GhGraphqlBlobObject | null> = {}
      for (const sha of shas) out[sha] = opts.objects?.[sha] ?? null
      return out
    },
    graphql: notUsed as unknown as GithubClient['graphql'],
    async getReviewThreads(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }> {
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
    async getThreadComments(): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: never[] }> {
      return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
    },
  }
  return { client, calls }
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Bytes with a NUL — git's binary marker. */
function binaryBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
}

describe('isBinaryContent — git NUL-in-first-8000-bytes heuristic', () => {
  test('a NUL byte within the window marks binary', () => {
    expect(isBinaryContent(binaryBytes())).toBe(true)
  })
  test('pure text is not binary', () => {
    expect(isBinaryContent(utf8('export const x = 1\n'))).toBe(false)
  })
  test('a NUL only past 8000 bytes is NOT binary (window bounded like git)', () => {
    const bytes = new Uint8Array(9000)
    bytes.fill(0x41) // 'A'
    bytes[8500] = 0 // NUL past the sniff window
    expect(isBinaryContent(bytes)).toBe(false)
  })
  test('the window boundary is exact: a NUL at index 7999 is binary, at 8000 is not', () => {
    const inWindow = new Uint8Array(9000).fill(0x41)
    inWindow[7999] = 0 // the 8000th byte — the last one inside git's window
    expect(isBinaryContent(inWindow)).toBe(true)
    const pastWindow = new Uint8Array(9000).fill(0x41)
    pastWindow[8000] = 0 // the 8001st byte — the first one outside
    expect(isBinaryContent(pastWindow)).toBe(false)
  })
  test('an empty blob is not binary', () => {
    expect(isBinaryContent(new Uint8Array(0))).toBe(false)
  })
})

describe('provisionBlobs — the cost ladder', () => {
  test('a store hit is reused (blobsReused), never a git or API call', async () => {
    const store = memStore()
    store.putBlobs([{ sha: 'S1', path: 'a.ts', content: 'x', size: 1, binary: false }])
    const git = fakeGitRunner({}) // git would find nothing
    const api = fakeApi({})
    const { stats, missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'a.ts': { base: null, head: 'S1' } }),
    )
    expect(stats.blobsReused).toBe(1)
    expect(stats.blobsFetched).toBe(0)
    expect(missing).toEqual([])
    // No cat-file probe and no API call for a SHA already in the store.
    expect(git.calls).toHaveLength(0)
    expect(api.calls.blobObjects).toBe(0)
  })

  test('local git supplies bytes at ZERO API cost (blobsFetched stays 0)', async () => {
    const store = memStore()
    const git = fakeGitRunner({
      BASE: utf8('base line\n'),
      HEAD: utf8('head line\n'),
    })
    const api = fakeApi({})
    const counterBumps: number[] = []
    const { stats, missing } = await provisionBlobs(
      {
        github: api.client,
        repo: REPO,
        store,
        runner: git.runner,
        cwd: '/repo',
        counter: { bump: () => counterBumps.push(1) },
      },
      indexOf({ 'a.ts': { base: 'BASE', head: 'HEAD' } }),
    )
    // Both sides came from local git: nothing reused, nothing fetched.
    expect(stats.blobsReused).toBe(0)
    expect(stats.blobsFetched).toBe(0)
    expect(missing).toEqual([])
    // The API was never touched, so the request counter never bumped.
    expect(api.calls.blobObjects).toBe(0)
    expect(counterBumps).toHaveLength(0)
    // The bytes landed in the store, readable as FileBlobs.
    expect(store.getBlob('BASE')?.content).toBe('base line\n')
    expect(store.getBlob('HEAD')?.content).toBe('head line\n')
  })

  test('a local-git binary is flagged binary, collapsed, with a real size', async () => {
    const store = memStore()
    const bin = binaryBytes()
    const git = fakeGitRunner({ IMG: bin })
    const api = fakeApi({})
    await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'logo.png': { base: null, head: 'IMG' } }),
    )
    const blob = store.getBlob('IMG')
    expect(blob?.binary).toBe(true)
    // Collapsed: no text content carried for a binary.
    expect(blob?.content).toBe('')
    // Size is git's authoritative byte length (from `cat-file -s`).
    expect(blob?.size).toBe(bin.length)
  })

  test('SHAs local git lacks fall to ONE GraphQL object() batch (blobsFetched counts them)', async () => {
    const store = memStore()
    const git = fakeGitRunner({}) // git has nothing
    const api = fakeApi({
      objects: {
        C1: { isBinary: false, text: 'one\n', byteSize: 4 },
        C2: { isBinary: false, text: 'two\n', byteSize: 4 },
      },
    })
    const counterBumps: number[] = []
    const { stats, missing } = await provisionBlobs(
      {
        github: api.client,
        repo: REPO,
        store,
        runner: git.runner,
        cwd: '/repo',
        counter: { bump: () => counterBumps.push(1) },
      },
      indexOf({ 'a.ts': { base: 'C1', head: 'C2' } }),
    )
    expect(stats.blobsFetched).toBe(2)
    expect(stats.blobsReused).toBe(0)
    expect(missing).toEqual([])
    // ONE batch request for both cold SHAs — the ~30/query economy.
    expect(api.calls.blobObjects).toBe(1)
    expect(api.calls.blobObjectShas[0].sort()).toEqual(['C1', 'C2'])
    // The batch counted as exactly one API request against the budget.
    expect(counterBumps).toHaveLength(1)
    expect(store.getBlob('C1')?.content).toBe('one\n')
  })

  test('an API-returned binary (text null / isBinary) is collapsed with byteSize as size', async () => {
    const store = memStore()
    const git = fakeGitRunner({})
    const api = fakeApi({
      objects: { PNG: { isBinary: true, text: null, byteSize: 2048 } },
    })
    await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'logo.png': { base: null, head: 'PNG' } }),
    )
    const blob = store.getBlob('PNG')
    expect(blob?.binary).toBe(true)
    expect(blob?.content).toBe('')
    expect(blob?.size).toBe(2048)
  })

  test('an oid the batch cannot resolve falls back to the single-blob REST endpoint (base64 decode)', async () => {
    const store = memStore()
    const git = fakeGitRunner({})
    const text = 'from rest\n'
    const api = fakeApi({
      objects: { ODD: null }, // GraphQL could not resolve it
      restBlobs: {
        ODD: {
          content: Buffer.from(text, 'utf8').toString('base64'),
          encoding: 'base64',
          size: Buffer.byteLength(text, 'utf8'),
        },
      },
    })
    const { stats, missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'a.ts': { base: null, head: 'ODD' } }),
    )
    expect(missing).toEqual([])
    expect(stats.blobsFetched).toBe(1)
    expect(api.calls.blob).toBe(1)
    // Base64 decoded back to the original text.
    expect(store.getBlob('ODD')?.content).toBe(text)
  })

  test('a blob no tier can produce is reported missing, never fabricated', async () => {
    const store = memStore()
    const git = fakeGitRunner({}) // not local
    const api = fakeApi({ objects: { GONE: null } }) // batch null, no REST fallback
    const { stats, missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'a.ts': { base: null, head: 'GONE' } }),
    )
    expect(missing).toEqual(['GONE'])
    expect(stats.blobsFetched).toBe(0)
    // Nothing was written for the unresolvable SHA.
    expect(store.getBlob('GONE')).toBeNull()
  })

  test('offline (git absent) with an unreachable API leaves the blob missing, does not throw', async () => {
    const store = memStore()
    const api = fakeApi({}) // getBlobObjects returns null for everything
    const { missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: NO_GIT, cwd: '/repo' },
      indexOf({ 'a.ts': { base: null, head: 'X' } }),
    )
    expect(missing).toEqual(['X'])
  })

  test('offline with a warm local git provisions both sides at zero API cost', async () => {
    const store = memStore()
    const git = fakeGitRunner({ B: utf8('b\n'), H: utf8('h\n') })
    // The API client throws on any blob call — proving the network is not touched.
    const throwing = fakeApi({})
    throwing.client.getBlobObjects = async () => {
      throw new Error('network blackholed')
    }
    const { stats, missing } = await provisionBlobs(
      { github: throwing.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'a.ts': { base: 'B', head: 'H' } }),
    )
    expect(missing).toEqual([])
    expect(stats.blobsFetched).toBe(0)
    expect(store.getBlob('B')?.content).toBe('b\n')
    expect(store.getBlob('H')?.content).toBe('h\n')
  })

  test('a local-git binary with a lossily-decoded prefix is still caught by the NUL sniff', async () => {
    // The runner decodes git's raw bytes as UTF-8, so each invalid byte becomes
    // one U+FFFD replacement CHAR but would re-encode to THREE bytes. A NUL that
    // sits inside git's first-8000-BYTES window must still be seen even when the
    // lossy prefix would inflate its re-encoded byte position past the window.
    const store = memStore()
    const original = new Uint8Array(9000)
    original.fill(0x89, 0, 4000) // 4000 invalid-UTF-8 bytes (each re-encodes to 3)
    original.fill(0x41, 4000) // then 'A's
    original[4000] = 0 // the NUL — at byte 4000, well inside git's window
    const git = fakeGitRunner({ RAW: original })
    const api = fakeApi({})
    await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'blob.bin': { base: null, head: 'RAW' } }),
    )
    const blob = store.getBlob('RAW')
    expect(blob?.binary).toBe(true)
    expect(blob?.content).toBe('')
    // Size is still git's authoritative byte length, not a re-encoded count.
    expect(blob?.size).toBe(original.length)
  })

  test('a runner that REJECTS (git unspawnable) skips tier 2 and falls to the API, never throws', async () => {
    // The CommandRunner contract allows a rejected promise when the executable
    // cannot be spawned at all; that must degrade exactly like a non-zero exit.
    const store = memStore()
    const rejecting: CommandRunner = {
      async run(): Promise<CommandResult> {
        throw new Error('spawn git: no such file or directory')
      },
    }
    const api = fakeApi({
      objects: { S: { isBinary: false, text: 'via api\n', byteSize: 8 } },
    })
    const { stats, missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: rejecting, cwd: '/repo' },
      indexOf({ 'a.ts': { base: null, head: 'S' } }),
    )
    expect(missing).toEqual([])
    expect(stats.blobsFetched).toBe(1)
    expect(store.getBlob('S')?.content).toBe('via api\n')
  })

  test('a THROWN GraphQL batch degrades to the REST straggler / missing — never throws the sync', async () => {
    const store = memStore()
    const git = fakeGitRunner({}) // both SHAs are cold
    const text = 'rescued by rest\n'
    const api = fakeApi({
      restBlobs: {
        R1: {
          content: Buffer.from(text, 'utf8').toString('base64'),
          encoding: 'base64',
          size: Buffer.byteLength(text, 'utf8'),
        },
        // R2 has no REST answer either → missing.
      },
    })
    api.client.getBlobObjects = async () => {
      throw new Error('graphql endpoint down')
    }
    const counterBumps: number[] = []
    const { stats, missing } = await provisionBlobs(
      {
        github: api.client,
        repo: REPO,
        store,
        runner: git.runner,
        cwd: '/repo',
        counter: { bump: () => counterBumps.push(1) },
      },
      indexOf({ 'a.ts': { base: 'R1', head: 'R2' } }),
    )
    // R1 was rescued by the single-blob REST endpoint; R2 is honestly missing.
    expect(stats.blobsFetched).toBe(1)
    expect(missing).toEqual(['R2'])
    expect(store.getBlob('R1')?.content).toBe(text)
    expect(store.getBlob('R2')).toBeNull()
    // The failed batch attempt still cost one request, plus one per REST try.
    expect(counterBumps).toHaveLength(3)
  })

  test('a TRUNCATED GraphQL text is never stored clipped — it re-fetches via REST', async () => {
    const store = memStore()
    const git = fakeGitRunner({})
    const full = 'the whole file body\n'
    const api = fakeApi({
      objects: {
        BIG: { isBinary: false, text: 'the whole f', byteSize: full.length, isTruncated: true },
      },
      restBlobs: {
        BIG: {
          content: Buffer.from(full, 'utf8').toString('base64'),
          encoding: 'base64',
          size: Buffer.byteLength(full, 'utf8'),
        },
      },
    })
    const { stats, missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'big.ts': { base: null, head: 'BIG' } }),
    )
    expect(missing).toEqual([])
    expect(stats.blobsFetched).toBe(1)
    expect(api.calls.blob).toBe(1)
    expect(store.getBlob('BIG')?.content).toBe(full)
    expect(store.getBlob('BIG')?.binary).toBe(false)
  })

  test('an INDECISIVE object (text null without isBinary true) is not minted as a collapsed binary', async () => {
    // GitHub nulls `text` both for binaries AND for blobs it cannot classify or
    // render (isBinary can itself be null); only an explicit isBinary=true may
    // collapse. Anything else must resolve real bytes via REST.
    const store = memStore()
    const git = fakeGitRunner({})
    const text = 'actually a text file\n'
    const api = fakeApi({
      objects: { ODD: { isBinary: null, text: null, byteSize: text.length } },
      restBlobs: {
        ODD: {
          content: Buffer.from(text, 'utf8').toString('base64'),
          encoding: 'base64',
          size: Buffer.byteLength(text, 'utf8'),
        },
      },
    })
    const { missing } = await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({ 'a.ts': { base: null, head: 'ODD' } }),
    )
    expect(missing).toEqual([])
    const blob = store.getBlob('ODD')
    expect(blob?.binary).toBe(false)
    expect(blob?.content).toBe(text)
  })

  test('a SHA shared across sides is provisioned once (content-addressed)', async () => {
    const store = memStore()
    const git = fakeGitRunner({ SAME: utf8('same\n') })
    const api = fakeApi({})
    await provisionBlobs(
      { github: api.client, repo: REPO, store, runner: git.runner, cwd: '/repo' },
      indexOf({
        'a.ts': { base: 'SAME', head: 'SAME' },
        'b.ts': { base: 'SAME', head: null },
      }),
    )
    // One cat-file probe for the single unique SHA (not four).
    const probes = git.calls.filter((c) => c[2] === '-e')
    expect(probes).toHaveLength(1)
    expect(store.getBlob('SAME')?.content).toBe('same\n')
  })
})

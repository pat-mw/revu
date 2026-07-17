import type { FileBlob, SnapshotImmutable } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GhGraphqlBlobObject, GithubClient } from './github-client'
import type { RepoRef } from './repo'
import type { DirectStore } from './store'

/**
 * Provisioning blob BYTES for a snapshot's blob index — the content behind the
 * `{base, head}` SHAs the sync engine already recorded per path.
 *
 * The order is a strict cost ladder, cheapest first:
 *
 *   1. The content-addressed STORE. A SHA already persisted is identical bytes
 *      forever (git SHAs are content addresses), so it is reused untouched and
 *      costs nothing — neither a subprocess nor an API request.
 *   2. LOCAL GIT. Contractors have the repo cloned; after a `git fetch` both the
 *      merge base and head are almost always present locally, so every needed
 *      blob is a `git cat-file blob {sha}` away. This costs ZERO API requests and
 *      works with the network blackholed — the whole point of doing blob reads in
 *      the daemon rather than delegating them.
 *   3. The GitHub API, only for SHAs local git could not produce. A cold clone
 *      that is missing objects falls back to the API; many cold SHAs are batched
 *      through one GraphQL `object(oid:)` query (~30 per request) so a large cold
 *      sync stays cheap, and a lone straggler uses the single-blob REST endpoint.
 *
 * Honesty of `syncStats` is a hard rule and lives here: only step 3 is an API
 * fetch. Store reuse (step 1) increments `blobsReused`; local-git reads (step 2)
 * cost nothing and are NOT counted as fetches; only actual API transfers (step 3)
 * increment `blobsFetched`. So a cold sync whose clone has every object reports
 * `blobsFetched: 0` — the free lunch made visible.
 *
 * Binary handling matches git and the prototype: a blob is binary when a NUL byte
 * appears in its first 8000 bytes, `size` is always the true byte length, and a
 * binary is COLLAPSED — its text content is dropped (empty string) rather than
 * carried, exactly as the mock/prototype does, since the diff UI never renders
 * binary bytes.
 */

/** Git's binary sniff window: a NUL in the first this-many bytes marks a blob binary. */
const BINARY_SNIFF_BYTES = 8000

/**
 * The GraphQL `object()` batch size. GitHub's node-count limits and query size
 * both favor keeping this modest; ~30 aliases per query is the documented sweet
 * spot for cold-blob provisioning.
 */
const GRAPHQL_BATCH_SIZE = 30

/** A sink for counting API requests, so the provider can fold its cost into `syncStats.requests`. */
export interface RequestBump {
  bump(by?: number): void
}

/** How blob bytes are provisioned, injectable so the whole path is unit-testable with fakes. */
export interface BlobProviderDeps {
  github: GithubClient
  repo: RepoRef
  store: DirectStore
  runner: CommandRunner
  /** The git clone directory `git cat-file` runs in (the repo being reviewed). */
  cwd: string
  /**
   * Counts every GitHub API request the provider spends (only the cold-cache
   * fallback tier does), so `syncStats.requests` stays honest. Local-git reads
   * and store hits never bump it. Optional so tests can omit it.
   */
  counter?: RequestBump
}

/** The honest blob accounting a sync folds into `syncStats`. */
export interface BlobProvisionStats {
  /** SHAs already in the content-addressed store — reused, zero cost. */
  blobsReused: number
  /** SHAs actually transferred from the GitHub API (0 when local git had them all). */
  blobsFetched: number
}

/**
 * True when the bytes look binary by git's own rule: a NUL byte within the first
 * 8000 bytes. The same heuristic GitHub, git, and the prototype apply, so a file
 * flagged here is flagged the same way everywhere else in the pipeline.
 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

/**
 * Assemble a `FileBlob` from raw bytes for a SHA/path. `size` is the true byte
 * length; a binary blob is COLLAPSED (empty `content`) to match the prototype —
 * the diff UI never renders binary bytes, so carrying them would only bloat the
 * store. A text blob decodes its bytes as UTF-8.
 */
function buildFileBlob(sha: string, path: string, bytes: Uint8Array): FileBlob {
  const binary = isBinaryContent(bytes)
  const size = bytes.length
  if (binary) {
    return { sha, path, content: '', size, binary: true }
  }
  return { sha, path, content: new TextDecoder().decode(bytes), size, binary: false }
}

/**
 * Read one blob from the local git clone, or `null` when the object cannot be
 * produced locally. It first probes existence with `git cat-file -e {sha}`
 * (exit 0 iff the object exists), asks for the authoritative byte size with
 * `-s`, then reads the body with `git cat-file blob {sha}` (which also guards
 * against handing a tree/commit oid: git errors rather than returning a
 * surprising body). Any failure — a non-zero exit, git absent, not a repo, or
 * the runner REJECTING outright (its contract allows a rejection when the
 * executable cannot be spawned at all) — degrades to `null` so the caller falls
 * back to the API; a broken local git never fails a sync, it only forgoes the
 * free lunch.
 *
 * The injected `CommandRunner` decodes stdout as UTF-8, which is lossy for
 * binary bodies. That is acceptable because a binary is collapsed to empty
 * content anyway: only the NUL sniff and the byte length matter for it. The
 * size comes from `cat-file -s` (exact regardless of the decode), and the sniff
 * runs over the decoded TEXT in `localFileBlob` below, where the window stays
 * sound under the lossy decode.
 */
async function readLocalBlob(
  runner: CommandRunner,
  cwd: string,
  sha: string,
): Promise<{ content: string; size: number } | null> {
  try {
    const exists = await runner.run(['git', 'cat-file', '-e', sha], { cwd })
    if (!exists.ok) return null
    const meta = await runner.run(['git', 'cat-file', '-s', sha], { cwd })
    if (!meta.ok) return null
    const size = Number(meta.stdout.trim())
    const read = await runner.run(['git', 'cat-file', 'blob', sha], { cwd })
    if (!read.ok) return null
    return {
      content: read.stdout,
      size: Number.isFinite(size) ? size : new TextEncoder().encode(read.stdout).length,
    }
  } catch {
    // A rejected runner (git unspawnable) is the same outcome as a non-zero
    // exit: no local object — the API tier takes over.
    return null
  }
}

/**
 * Build a `FileBlob` from a local-git read. `size` is git's authoritative byte
 * count (exact even when a UTF-8 round trip of a binary body would not be), and
 * a binary is collapsed.
 *
 * The NUL sniff runs over the DECODED text, not a re-encoded byte buffer:
 * every UTF-16 unit of the decoded string consumed at least one original byte,
 * so a NUL inside git's first-8000-BYTES window sits at a string index below
 * 8000 and is always seen. Re-encoding would inflate each lossy U+FFFD
 * replacement to three bytes and could push a genuinely in-window NUL past the
 * sniff boundary, mislabeling a binary as text.
 */
function localFileBlob(
  sha: string,
  path: string,
  read: { content: string; size: number },
): FileBlob {
  const nul = read.content.indexOf('\u0000')
  const binary = nul !== -1 && nul < BINARY_SNIFF_BYTES
  if (binary) return { sha, path, content: '', size: read.size, binary: true }
  return { sha, path, content: read.content, size: read.size, binary: false }
}

/** Decode a base64 string to bytes (the encoding GitHub's single-blob REST uses). */
function base64ToBytes(b64: string): Uint8Array {
  // GitHub wraps the base64 with newlines; atob rejects those, so strip them.
  const clean = b64.replace(/\s+/g, '')
  const binaryStr = atob(clean)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
  return bytes
}

/**
 * Collect the unique, non-null SHAs a blob index references (both sides), each
 * paired with a representative path for the resulting `FileBlob`. A SHA can
 * appear on multiple paths (an unchanged-content rename); the first path wins,
 * since the blob is content-addressed and the path is only a display hint.
 */
function collectShas(
  blobIndex: SnapshotImmutable['blobIndex'],
): Map<string, string> {
  const shaToPath = new Map<string, string>()
  for (const [path, sides] of Object.entries(blobIndex)) {
    if (sides.base && !shaToPath.has(sides.base)) shaToPath.set(sides.base, path)
    if (sides.head && !shaToPath.has(sides.head)) shaToPath.set(sides.head, path)
  }
  return shaToPath
}

/**
 * Provision every blob SHA in a snapshot's blob index (base + head), writing the
 * bytes into the content-addressed store and returning honest `syncStats`
 * accounting. The cost ladder — store reuse, then local git (free), then the
 * GitHub API (batched) — is applied per SHA; only API transfers count as
 * `blobsFetched`.
 *
 * Returns the SHAs that could NOT be provisioned by any tier (local git missing
 * AND the API failed/omitted them) so the caller can mark the snapshot `partial`
 * rather than pretend a blob is present. In the common case this list is empty.
 */
export async function provisionBlobs(
  deps: BlobProviderDeps,
  blobIndex: SnapshotImmutable['blobIndex'],
): Promise<{ stats: BlobProvisionStats; missing: string[] }> {
  const { github, repo, store, runner, cwd, counter } = deps
  const shaToPath = collectShas(blobIndex)

  let blobsReused = 0
  let blobsFetched = 0
  const missing: string[] = []
  const provisioned: FileBlob[] = []

  // The SHAs local git could not produce, batched for the API fallback.
  const coldPaths = new Map<string, string>()

  for (const [sha, path] of shaToPath) {
    // Tier 1 — content-addressed store hit. Identical SHA ⇒ identical bytes; the
    // blob is already durable, so it is reused at zero cost.
    if (store.hasBlob(sha)) {
      blobsReused += 1
      continue
    }
    // Tier 2 — local git. A cat-file read costs no API request and works offline.
    const local = await readLocalBlob(runner, cwd, sha)
    if (local !== null) {
      provisioned.push(localFileBlob(sha, path, local))
      continue
    }
    // Tier 3 candidate — the API fallback, deferred so cold SHAs batch together.
    coldPaths.set(sha, path)
  }

  // Tier 3 — the GitHub API, only for what local git and the store both lacked.
  // Batch through GraphQL `object()` aliases (~30/query); each batch is ONE API
  // request regardless of how many blobs it carries, and every blob it returns
  // is an honest fetch.
  const coldShas = [...coldPaths.keys()]
  for (let i = 0; i < coldShas.length; i += GRAPHQL_BATCH_SIZE) {
    const batch = coldShas.slice(i, i + GRAPHQL_BATCH_SIZE)
    // A THROWN batch request (endpoint down, network gone) is a provisioning
    // miss, not a sync failure: everything else in the snapshot is already
    // fetched, and a missing blob is exactly what `partial` exists to name. So
    // a failed batch leaves every SHA unresolved — each falls to the REST
    // straggler below, which itself degrades to `missing` — rather than
    // throwing away the whole sync. The attempt still cost one API request.
    let objects: Record<string, GhGraphqlBlobObject | null> = {}
    try {
      objects = await github.getBlobObjects(repo.owner, repo.repo, batch)
    } catch {
      // Fall through with the empty map: every SHA in this batch is unresolved.
    }
    counter?.bump()
    for (const sha of batch) {
      const obj = objects[sha]
      const path = coldPaths.get(sha) ?? ''
      // The batch answer is trusted only when it is DECISIVE: an explicit
      // `isBinary: true` (collapse it), or full untruncated text. GitHub nulls
      // `text` both for binaries AND for blobs it cannot classify or render
      // (`isBinary` itself can be null), and `isTruncated` marks text it
      // clipped — minting a FileBlob from either would fabricate a collapsed
      // "binary" out of a text file or store silently clipped content. Every
      // indecisive answer falls to the single-blob REST endpoint, which
      // returns the real bytes.
      const indecisive =
        obj === null ||
        obj === undefined ||
        (obj.isBinary !== true && (obj.text === null || obj.isTruncated === true))
      if (indecisive) {
        const rest = await fetchBlobViaRest(github, repo, sha, path)
        counter?.bump()
        if (rest !== null) {
          provisioned.push(rest)
          blobsFetched += 1
        } else {
          missing.push(sha)
        }
        continue
      }
      const binary = obj.isBinary === true
      const text = binary ? '' : (obj.text ?? '')
      const size =
        typeof obj.byteSize === 'number'
          ? obj.byteSize
          : new TextEncoder().encode(text).length
      provisioned.push({ sha, path, content: text, size, binary })
      blobsFetched += 1
    }
  }

  if (provisioned.length > 0) store.putBlobs(provisioned)
  return { stats: { blobsReused, blobsFetched }, missing }
}

/**
 * Fetch a single blob via the REST `git/blobs/{sha}` endpoint (base64-decoded),
 * or `null` when the request fails. The single-blob straggler path: used when
 * the GraphQL batch could not resolve an oid. `size` prefers GitHub's reported
 * byte length; a binary is collapsed like everywhere else.
 */
async function fetchBlobViaRest(
  github: GithubClient,
  repo: RepoRef,
  sha: string,
  path: string,
): Promise<FileBlob | null> {
  try {
    const raw = await github.getBlob(repo.owner, repo.repo, sha)
    if (raw.encoding !== 'base64') {
      // GitHub always base64-encodes git blobs; an unexpected encoding is not
      // something to guess at, so treat it as a miss and let the caller mark it.
      return null
    }
    const bytes = base64ToBytes(raw.content)
    const blob = buildFileBlob(sha, path, bytes)
    // Prefer GitHub's authoritative size when present.
    if (raw.size > 0) blob.size = raw.size
    return blob
  } catch {
    return null
  }
}

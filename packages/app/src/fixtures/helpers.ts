import type { FileBlob, PullFile, ReactionRollup, ReviewThread, Snapshot } from '@revu/shared'
import { parseCommentIdentity } from '@revu/shared'
import type { RemotePull } from './contract'
import { BROKER_BOT, HUMANS } from './cast'

/**
 * Fixture timestamps are offsets from load time so relative labels
 * ("synced 1d ago") stay truthful whenever the demo runs.
 */
export function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString()
}
export function hoursAgo(h: number): string {
  return minutesAgo(h * 60)
}
export function daysAgo(d: number): string {
  return minutesAgo(d * 24 * 60)
}

/** Zeroed reaction rollup in the exact REST shape. */
export function emptyReactions(commentId: number): ReactionRollup {
  return {
    url: `https://api.github.com/repos/meridian-labs/atlas/pulls/comments/${commentId}/reactions`,
    total_count: 0,
    '+1': 0,
    '-1': 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  }
}

export function reactions(
  commentId: number,
  counts: Partial<Omit<ReactionRollup, 'url' | 'total_count'>>,
): ReactionRollup {
  const base = emptyReactions(commentId)
  let total = 0
  for (const [k, v] of Object.entries(counts)) {
    ;(base as unknown as Record<string, number>)[k] = v as number
    total += v as number
  }
  base.total_count = total
  return base
}

/** Fake-but-plausible GraphQL node ids (`PRRT_`, `PRRC_`, `PR_`, …). */
export function nodeId(prefix: string, n: number): string {
  return `${prefix}_kwDOJk${n.toString(36).padStart(10, '0')}`
}

/** Deterministic fake git SHA from a label — stable across reloads. */
export function fakeSha(label: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < label.length; i++) {
    h1 = ((h1 ^ label.charCodeAt(i)) * 0x01000193) >>> 0
    h2 = ((h2 + label.charCodeAt(i)) * 0x85ebca6b) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0')
  return (hex(h1) + hex(h2) + hex((h1 ^ h2) >>> 0) + hex((h1 + h2) >>> 0)).slice(0, 40)
}

export function blob(path: string, content: string, shaLabel?: string): FileBlob {
  return {
    sha: fakeSha(shaLabel ?? `${path}:${content.length}:${content.slice(0, 64)}`),
    path,
    content,
    size: content.length,
    binary: false,
  }
}

export function binaryBlob(path: string, size: number, shaLabel: string): FileBlob {
  return { sha: fakeSha(shaLabel), path, content: '', size, binary: true }
}

/**
 * Count additions/deletions from a unified patch so `PullFile` numbers never
 * drift from the hunks the viewer actually renders.
 */
export function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

export function pullFile(
  args: Omit<PullFile, 'additions' | 'deletions' | 'changes'> & {
    additions?: number
    deletions?: number
  },
): PullFile {
  const counted = args.patch ? countPatch(args.patch) : { additions: 0, deletions: 0 }
  const additions = args.additions ?? counted.additions
  const deletions = args.deletions ?? counted.deletions
  return { ...args, additions, deletions, changes: additions + deletions }
}

/**
 * Reconstruct the broker's write log for a set of threads: comment id → the id
 * of the human who authored it. A real broker records this at write time; the
 * mock has no separate log, so it recovers the same mapping from the identity
 * the broker smuggled into each body — the stamp IS the record. Only comments
 * the broker bot authored (and whose smuggled name resolves to a known human)
 * are listed; org-member comments and unparseable bot bodies are omitted, so
 * the map covers exactly the broker-authored comments and nothing else.
 *
 * Keyed on `Human.id`, the stable identity — so a later display-name change on
 * that human leaves this map pointing at the same person.
 */
function deriveCommentAuthors(threads: ReviewThread[]): Record<number, string> {
  const byName = new Map(HUMANS.map((h) => [h.name, h.id]))
  const authors: Record<number, string> = {}
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const { identity } = parseCommentIdentity(comment, BROKER_BOT.login)
      if (identity.kind !== 'human') continue
      const humanId = byName.get(identity.name)
      if (humanId !== undefined) authors[comment.id] = humanId
    }
  }
  return authors
}

/**
 * Assemble a Snapshot from a remote-shaped description — used both for seeding
 * pre-synced fixtures and (by the mock sync engine) as the canonical
 * remote → cache copy. Deep-clones so later remote mutation can't leak into a
 * snapshot that is supposed to be a point-in-time copy.
 *
 * `commentAuthors` carries the broker's write log alongside the threads, so
 * own-comment detection resolves by author id instead of by the smuggled
 * display name — correct across a Coder username rename.
 */
export function buildSnapshot(
  remote: RemotePull,
  syncedAt: string,
  opts?: {
    partial?: Snapshot['partial']
    syncStats?: Snapshot['syncStats']
  },
): Snapshot {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
  return {
    prNumber: remote.detail.number,
    syncedAt,
    partial: opts?.partial ?? null,
    syncStats: opts?.syncStats ?? null,
    immutable: {
      compareKey: `${remote.detail.merge_base_sha}...${remote.detail.head.sha}`,
      mergeBaseSha: remote.detail.merge_base_sha,
      headSha: remote.detail.head.sha,
      files: clone(remote.files),
      blobIndex: clone(remote.blobIndex),
      commits: clone(remote.commits),
    },
    mutable: {
      fetchedAt: syncedAt,
      pull: clone(remote.detail),
      threads: clone(remote.threads),
      issueComments: clone(remote.issueComments),
      reviews: clone(remote.reviews),
      checks: clone(remote.checks),
      commentAuthors: deriveCommentAuthors(remote.threads),
    },
  }
}

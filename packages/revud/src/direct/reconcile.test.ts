/**
 * Unit + parity suite for the crown-jewel reconcile read path. Every case is
 * driven by an INJECTED fake store (no network, no disk) over fixture snapshots
 * and blobs, so it stays in the network-free gate.
 *
 * Two things are proven here, and they are the whole point of this read path:
 *
 *   1. Wiring — `reconcileDraft` selects the anchoring side's blob (BASE for a
 *      LEFT anchor, HEAD for a RIGHT anchor), resolves its lines from the store,
 *      and classifies through the shared `classifyPendingComment`, so drift /
 *      lost / clean (including a LEFT-side anchor and the clean-path context
 *      floor) land exactly as the shared scorer decides. It also derives
 *      `newCommits` by slicing the fresh commit list after the draft's head.
 *
 *   2. Parity — for the SAME inputs, this module and the mock oracle's reconcile
 *      body produce structurally IDENTICAL `AnchorResult`s. Both call the same
 *      `classifyPendingComment` with the same resolver, so they cannot diverge;
 *      the assertion pins that invariant rather than trusting it. A byte-for-byte
 *      preview parity check (the reconcile dialog runs the same classifier over a
 *      loaded snapshot) is asserted too — preview and report must be equal.
 */
import { describe, expect, test } from 'bun:test'
import type {
  AnchorResult,
  CommitInfo,
  FileBlob,
  PendingComment,
  PullFile,
  ReviewDraft,
  Snapshot,
  SnapshotImmutable,
} from '@revu/shared'
import {
  ApiError,
  blobContentToLines,
  classifyPendingComment,
  selectAnchorBlobSha,
} from '@revu/shared'
import type { DirectStore } from './store'
import { reconcileDraft } from './reconcile'

/** Join lines into blob content the way `blobContentToLines` splits it back. */
function blobOf(sha: string, path: string, lines: string[]): FileBlob {
  const content = lines.length === 0 ? '' : lines.join('\n') + '\n'
  return { sha, path, content, size: content.length, binary: false }
}

/** A commit whose sha and author date are the only fields reconcile reads. */
function commit(sha: string, date: string): CommitInfo {
  return {
    sha,
    commit: { message: `commit ${sha}`, author: { name: 'A', email: 'a@x.io', date } },
    author: null,
    parents: [],
  }
}

/** A PendingComment carrying only the anchoring-relevant fields. */
function makeComment(o: {
  key: string
  path: string
  side?: 'LEFT' | 'RIGHT'
  line: number
  start_line?: number | null
  lineText: string
  contextBefore?: string[]
  contextAfter?: string[]
}): PendingComment {
  return {
    key: o.key,
    path: o.path,
    side: o.side ?? 'RIGHT',
    start_side: null,
    line: o.line,
    start_line: o.start_line ?? null,
    body: 'a note',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    anchor: {
      lineText: o.lineText,
      contextBefore: o.contextBefore ?? [],
      contextAfter: o.contextAfter ?? [],
    },
  }
}

/**
 * A read-only fake store exposing only the three surfaces reconcile reads —
 * `getDraft`, `getSnapshot`, `getBlob`. Every other `DirectStore` method throws
 * if reconcile ever touches it, which would be a bug: reconcile is a PURE READ
 * and must never write.
 */
function fakeStore(opts: {
  draft: ReviewDraft | null
  snapshot: Snapshot | null
  blobs: Record<string, FileBlob>
}): DirectStore {
  const unexpected = (name: string) => (): never => {
    throw new Error(`reconcile must not call store.${name} — it is a pure read`)
  }
  return {
    getDraft: () => opts.draft,
    getSnapshot: () => opts.snapshot,
    getBlob: (sha: string) => opts.blobs[sha] ?? null,
    // Everything below is off-limits to reconcile; touching it is a bug.
    getImmutable: unexpected('getImmutable'),
    putImmutable: unexpected('putImmutable'),
    putSnapshot: unexpected('putSnapshot'),
    hasBlob: unexpected('hasBlob'),
    putBlobs: unexpected('putBlobs'),
    putDraft: unexpected('putDraft'),
    deleteDraft: unexpected('deleteDraft'),
    getViewed: unexpected('getViewed'),
    setViewed: unexpected('setViewed'),
    getPreferences: unexpected('getPreferences'),
    setPreferences: unexpected('setPreferences'),
    appendAudit: unexpected('appendAudit'),
    listAudit: unexpected('listAudit'),
    close: () => {},
  }
}

const HUMAN = 'h@x.io'

/**
 * Build a snapshot whose immutable half carries the given files, blobIndex, and
 * commits. Only the fields reconcile reads are populated with real values.
 */
function snapshotOf(o: {
  headSha: string
  files: PullFile[]
  blobIndex: SnapshotImmutable['blobIndex']
  commits: CommitInfo[]
}): Snapshot {
  return {
    prNumber: 5,
    syncedAt: '2026-02-01T00:00:00.000Z',
    partial: null,
    syncStats: null,
    immutable: {
      compareKey: `MB...${o.headSha}`,
      mergeBaseSha: 'MB',
      headSha: o.headSha,
      files: o.files,
      blobIndex: o.blobIndex,
      commits: o.commits,
    },
    mutable: {
      fetchedAt: '2026-02-01T00:00:00.000Z',
      pull: {} as Snapshot['mutable']['pull'],
      threads: [],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

/** A `PullFile` with just the fields presence resolution reads. */
function file(filename: string, status: PullFile['status']): PullFile {
  return {
    sha: `head-${filename}`,
    filename,
    status,
    additions: 0,
    deletions: 0,
    changes: 0,
    patch: '',
  }
}

/**
 * A realistic force-push scenario mirroring the shared conformance `reconcile`
 * fixture: a RIGHT-side clean / drifted / lost trio plus a LEFT-side clean
 * anchor. The head blob was rewritten (two lines inserted above the drifted
 * anchor; the lost anchor's line deleted); the base blob is unchanged, so the
 * LEFT note re-anchors cleanly against it.
 */
function forcePushFixture(): {
  draft: ReviewDraft
  snapshot: Snapshot
  blobs: Record<string, FileBlob>
} {
  // ——— the fresh HEAD blob (after the rewrite) ———
  // Original head had: cleanLine at 1, driftLine at 2, lostLine at 3.
  // The rewrite inserts two lines above driftLine and deletes lostLine.
  const headLines = [
    'clean anchor',   // 1 — clean comment stays here
    'inserted A',     // 2
    'inserted B',     // 3
    'drift anchor',   // 4 — drifted from original line 2 → +2 delta
    'tail one',       // 5
    'tail two',       // 6
  ]
  // ——— the BASE blob (unchanged by the force-push) ———
  const baseLines = [
    'base head',
    'deleted base line', // 2 — a LEFT anchor against a deleted base line
    'base tail',
  ]
  const headBlob = blobOf('sha-head', 'src/a.ts', headLines)
  const baseBlob = blobOf('sha-base', 'src/a.ts', baseLines)

  const comments: PendingComment[] = [
    // RIGHT clean — sits at its original head line 1, unchanged.
    makeComment({
      key: 'c-clean',
      path: 'src/a.ts',
      side: 'RIGHT',
      line: 1,
      lineText: 'clean anchor',
      contextAfter: ['inserted A'],
    }),
    // RIGHT drifted — originally head line 2, now at line 4 (delta +2).
    makeComment({
      key: 'c-drift',
      path: 'src/a.ts',
      side: 'RIGHT',
      line: 2,
      lineText: 'drift anchor',
      contextBefore: ['clean anchor'],
      contextAfter: ['tail one'],
    }),
    // RIGHT lost — its head line was deleted and its text is gone.
    makeComment({
      key: 'c-lost',
      path: 'src/a.ts',
      side: 'RIGHT',
      line: 3,
      lineText: 'this line no longer exists anywhere',
    }),
    // LEFT clean — anchors into the UNCHANGED base blob, not head.
    makeComment({
      key: 'c-left',
      path: 'src/a.ts',
      side: 'LEFT',
      line: 2,
      lineText: 'deleted base line',
      contextBefore: ['base head'],
      contextAfter: ['base tail'],
    }),
  ]

  const draft: ReviewDraft = {
    humanId: HUMAN,
    prNumber: 5,
    headSha: 'OLD-HEAD',
    compareKey: 'MB...OLD-HEAD',
    body: 'review body',
    event: 'COMMENT',
    comments,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  }

  // Fresh commit list: the draft's head (OLD-HEAD) is still present, followed by
  // the three commits the force-push added.
  const commits = [
    commit('C0', '2026-01-10T00:00:00.000Z'),
    commit('OLD-HEAD', '2026-01-14T00:00:00.000Z'),
    commit('C2', '2026-01-16T00:00:00.000Z'),
    commit('C3', '2026-01-17T00:00:00.000Z'),
    commit('NEW-HEAD', '2026-01-18T00:00:00.000Z'),
  ]

  const snapshot = snapshotOf({
    headSha: 'NEW-HEAD',
    files: [file('src/a.ts', 'modified')],
    blobIndex: { 'src/a.ts': { base: 'sha-base', head: 'sha-head' } },
    commits,
  })

  return {
    draft,
    snapshot,
    blobs: { 'sha-head': headBlob, 'sha-base': baseBlob },
  }
}

/**
 * The mock oracle's reconcile body, replayed here verbatim over the SAME store
 * surface (`getBlob`) so parity is asserted against the exact classification the
 * mock produces. This mirrors `packages/app/src/api/mock/adapter.ts`
 * `reconcileDraft` — the same shared `classifyPendingComment` and the same blob
 * resolver.
 */
function oracleResults(store: DirectStore, draft: ReviewDraft, snap: Snapshot): AnchorResult[] {
  const { files, blobIndex } = snap.immutable
  return draft.comments.map((c) =>
    classifyPendingComment({
      comment: c,
      files,
      blobIndex,
      resolveBlobLines: (sha) => {
        const blob = store.getBlob(sha)
        return blob && !blob.binary ? blobContentToLines(blob.content) : null
      },
    }),
  )
}

describe('reconcileDraft — preconditions', () => {
  test('a missing draft is a typed not_found (nothing to reconcile)', () => {
    const store = fakeStore({ draft: null, snapshot: snapshotOf({ headSha: 'H', files: [], blobIndex: {}, commits: [] }), blobs: {} })
    expect(() => reconcileDraft({ store, humanId: HUMAN }, 5)).toThrow(ApiError)
    try {
      reconcileDraft({ store, humanId: HUMAN }, 5)
    } catch (err) {
      expect((err as ApiError).code).toBe('not_found')
    }
  })

  test('a never-synced PR (no snapshot) is a typed not_found (sync first)', () => {
    const { draft } = forcePushFixture()
    const store = fakeStore({ draft, snapshot: null, blobs: {} })
    try {
      reconcileDraft({ store, humanId: HUMAN }, 5)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('not_found')
    }
  })
})

describe('reconcileDraft — classification against the fresh snapshot', () => {
  test('clean / drifted / lost (RIGHT) plus a LEFT-side clean anchor', () => {
    const { draft, snapshot, blobs } = forcePushFixture()
    const store = fakeStore({ draft, snapshot, blobs })
    const report = reconcileDraft({ store, humanId: HUMAN }, 5)

    const byKey = new Map(report.results.map((r) => [r.comment.key, r]))

    expect(byKey.get('c-clean')?.kind).toBe('clean')

    const drift = byKey.get('c-drift')
    expect(drift?.kind).toBe('drifted')
    expect(drift?.kind === 'drifted' ? drift.newLine : null).toBe(4)
    expect(drift?.kind === 'drifted' ? drift.delta : null).toBe(2)

    const lost = byKey.get('c-lost')
    expect(lost?.kind).toBe('lost')
    expect(lost?.kind === 'lost' ? lost.reason : null).toBe('line-deleted')

    // The LEFT note classified against the UNCHANGED base blob — proving the
    // side-aware selection (LEFT = base). Had it read the head blob, its text
    // ('deleted base line') is absent there and it would be lost.
    const left = byKey.get('c-left')
    expect(left?.comment.side).toBe('LEFT')
    expect(left?.kind).toBe('clean')
  })

  test('the LEFT comment resolves through the BASE blob sha, not the head sha', () => {
    const { draft, snapshot } = forcePushFixture()
    const entry = snapshot.immutable.blobIndex['src/a.ts']
    // The shared selector is the ONE definition of the side→blob mapping.
    expect(selectAnchorBlobSha(entry, 'LEFT')).toBe('sha-base')
    expect(selectAnchorBlobSha(entry, 'RIGHT')).toBe('sha-head')
    void draft
  })

  test('the clean fast-path context floor is not bypassed: a repeated anchor with broken context is demoted to the drift search', () => {
    // The anchor text is a repeated token ('}') that also occupies the original
    // index. Without intact context the clean fast path must NOT fire — the line
    // is demoted to the ranked drift search, which re-points it (with real
    // context) to the moved occurrence. This pins that the shared floor rides
    // through reconcile untouched.
    const headLines = [
      'function a() {',
      '  return 1',
      '}',            // 3 — a coincidental identical brace at the OLD index
      'function b() {',
      '  return 2',
      '}',            // 6 — the anchor's real, moved home (intact context)
    ]
    const headBlob = blobOf('sha-h', 'src/b.ts', headLines)
    const comment = makeComment({
      key: 'c-brace',
      path: 'src/b.ts',
      side: 'RIGHT',
      line: 3,
      lineText: '}',
      // Context captured at write time pointed at function b's body.
      contextBefore: ['function b() {', '  return 2'],
      contextAfter: [],
    })
    const draft: ReviewDraft = {
      humanId: HUMAN,
      prNumber: 5,
      headSha: 'OLD',
      compareKey: 'MB...OLD',
      body: '',
      event: 'COMMENT',
      comments: [comment],
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    }
    const snapshot = snapshotOf({
      headSha: 'NEW',
      files: [file('src/b.ts', 'modified')],
      blobIndex: { 'src/b.ts': { base: null, head: 'sha-h' } },
      commits: [commit('OLD', '2026-01-14T00:00:00.000Z')],
    })
    const store = fakeStore({ draft, snapshot, blobs: { 'sha-h': headBlob } })
    const report = reconcileDraft({ store, humanId: HUMAN }, 5)
    const only = report.results[0]
    // Had the clean floor been bypassed, this would have reported `clean` at the
    // coincidental brace (index 2 / line 3). The floor demotes it and the drift
    // search re-points it to line 6 with its real context.
    expect(only.kind).toBe('drifted')
    expect(only.kind === 'drifted' ? only.newLine : null).toBe(6)
  })
})

describe('reconcileDraft — newCommits from the snapshot delta', () => {
  test('slices the commits after the draft head when it is still in the list', () => {
    const { draft, snapshot, blobs } = forcePushFixture()
    const store = fakeStore({ draft, snapshot, blobs })
    const report = reconcileDraft({ store, humanId: HUMAN }, 5)
    // OLD-HEAD is at index 1 of the 5-commit list; the three after it are new.
    expect(report.newCommits.map((c) => c.sha)).toEqual(['C2', 'C3', 'NEW-HEAD'])
    expect(report.draftHeadSha).toBe('OLD-HEAD')
    expect(report.currentHeadSha).toBe('NEW-HEAD')
  })

  test('falls back to author-date when the draft head fell out of the rewritten compare', () => {
    const { draft, snapshot, blobs } = forcePushFixture()
    // A hard force-push that dropped OLD-HEAD entirely from the fresh list.
    snapshot.immutable.commits = [
      commit('X0', '2026-01-10T00:00:00.000Z'), // before the draft was written
      commit('X1', '2026-01-16T00:00:00.000Z'), // after → counts as new
      commit('X2', '2026-01-17T00:00:00.000Z'), // after → counts as new
    ]
    const store = fakeStore({ draft, snapshot, blobs })
    const report = reconcileDraft({ store, humanId: HUMAN }, 5)
    // draft.createdAt is 2026-01-15; only X1 and X2 postdate it.
    expect(report.newCommits.map((c) => c.sha)).toEqual(['X1', 'X2'])
  })
})

describe('reconcileDraft — parity with the mock oracle', () => {
  test('results are structurally identical to the mock oracle for the same inputs', () => {
    const { draft, snapshot, blobs } = forcePushFixture()
    const store = fakeStore({ draft, snapshot, blobs })

    const report = reconcileDraft({ store, humanId: HUMAN }, 5)
    const oracle = oracleResults(store, draft, snapshot)

    // Same module, same resolver — but assert it anyway: divergence between the
    // report and the preview is the worst kind of bug in this flow.
    expect(report.results).toEqual(oracle)
  })

  test('the client-side preview matches the report for every comment, both sides', () => {
    const { draft, snapshot, blobs } = forcePushFixture()
    const store = fakeStore({ draft, snapshot, blobs })
    const report = reconcileDraft({ store, humanId: HUMAN }, 5)

    // Both sides must appear or the parity check only exercises one.
    const sides = new Set(draft.comments.map((c) => c.side))
    expect(sides.has('LEFT')).toBe(true)
    expect(sides.has('RIGHT')).toBe(true)

    for (const comment of draft.comments) {
      // The dialog previews by running the SAME shared classifier over the
      // loaded snapshot, selecting the anchoring side through the SAME shared
      // selector — so the preview cannot prefetch the wrong blob and mask a
      // divergence.
      const preview: AnchorResult = classifyPendingComment({
        comment,
        files: snapshot.immutable.files,
        blobIndex: snapshot.immutable.blobIndex,
        resolveBlobLines: (sha) => {
          const blob = store.getBlob(sha)
          return blob && !blob.binary ? blobContentToLines(blob.content) : null
        },
      })
      const reported = report.results.find((r) => r.comment.key === comment.key)
      expect(reported).toBeDefined()
      expect(preview).toEqual(reported!)
    }
  })
})

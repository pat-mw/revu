/**
 * Contract-conformance for the direct-mode RECONCILE path — the crown-jewel
 * flow — driven end to end against the REAL direct adapter (`createDirectApi`)
 * with a fake GitHub client, so it stays in the network-free gate. This is the
 * direct-adapter analog of the shared `RevuApi` conformance suite's reconcile
 * block (`packages/shared/conformance/suite.ts`): sync a snapshot, write a draft
 * against that head, force-push (head + head blob rewritten, three commits
 * added), re-sync, then reconcile and assert the classifications, `newCommits`,
 * and — critically — that the client-side PREVIEW matches the report for every
 * comment on both sides.
 *
 * The whole point: the report and the preview both run the SAME shared
 * `classifyPendingComment` with the SAME side-aware blob selection (base for a
 * LEFT anchor, head for a RIGHT anchor), so they cannot diverge. The suite pins
 * that rather than trusting it.
 */
import { describe, expect, test } from 'bun:test'
import type { AnchorResult } from '@revu/shared'
import {
  blobContentToLines,
  classifyPendingComment,
  selectAnchorBlobSha,
} from '@revu/shared'
import type { GithubClient } from './github-client'
import { createDirectApi, type DirectApi } from './direct-api'
import { openDirectStore, type DirectStore } from './store'
import {
  CONFORMANCE_REPO,
  CONFORMANCE_SESSION,
  forcePush,
  initialReconcileState,
  movingHeadClient,
  RECONCILE_PR,
  seedForcePushed,
} from './conformance-fakes'

const SESSION = CONFORMANCE_SESSION
const PR = RECONCILE_PR
const initialState = initialReconcileState

function build(client: GithubClient, store: DirectStore): DirectApi {
  return createDirectApi({
    session: CONFORMANCE_SESSION,
    github: client,
    repo: CONFORMANCE_REPO,
    store,
  })
}

describe('direct reconcile path — contract conformance', () => {
  test('the seeded snapshot is behind the remote head after the force-push', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialState()
    const api = build(movingHeadClient(state), store)
    const first = await api.syncPull(PR)
    const draft = api.saveDraft({
      humanId: SESSION.human.id,
      prNumber: PR,
      headSha: first.immutable.headSha,
      compareKey: first.immutable.compareKey,
      body: '',
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    })
    // The draft was written against the (now stale) snapshot head.
    expect(draft.headSha).toBe(first.immutable.headSha)
    forcePush(state)
    const detail = await api.syncPull(PR)
    expect(detail.immutable.headSha).not.toBe(draft.headSha)
    store.close()
  })

  test('after re-sync, reconcile yields clean / clean / drifted / lost with the expected delta and newCommits', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialState()
    const api = build(movingHeadClient(state), store)
    await seedForcePushed(api, state)

    const report = api.reconcileDraft(PR)
    const kinds = report.results.map((r) => r.kind).sort()
    // A RIGHT clean/drifted/lost trio plus a LEFT-side clean anchor: the LEFT
    // note targets a deleted base line whose merge base is unchanged, so it
    // re-anchors cleanly against the base blob.
    expect(kinds).toEqual(['clean', 'clean', 'drifted', 'lost'])

    const drifted = report.results.find((r) => r.kind === 'drifted')
    expect(drifted?.kind).toBe('drifted')
    expect(drifted?.kind === 'drifted' ? drifted.delta : null).toBe(2)

    // The LEFT-side comment classified against BASE content, not head.
    const leftResult = report.results.find((r) => r.comment.side === 'LEFT')
    expect(leftResult?.kind).toBe('clean')

    // Three commits landed after the draft's head (still in the fresh list).
    expect(report.newCommits.map((c) => c.sha)).toEqual(['C2', 'C3', 'HEAD-NEW'])
    expect(report.draftHeadSha).toBe('HEAD-OLD')
    expect(report.currentHeadSha).toBe('HEAD-NEW')

    store.close()
  })

  test('the client-side preview matches the reconcile report for every comment, both sides', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialState()
    const api = build(movingHeadClient(state), store)
    await seedForcePushed(api, state)

    const report = api.reconcileDraft(PR)
    const snap = api.getSnapshot(PR)
    const draft = api.getDraft(PR)
    expect(snap).not.toBeNull()
    expect(draft).not.toBeNull()

    // Resolve blob lines through the contract's getBlob, exactly as the dialog does.
    const resolveBlobLines = (sha: string): string[] | null => {
      const blob = api.getBlob(sha)
      return blob.binary ? null : blobContentToLines(blob.content)
    }

    const sides = new Set(draft!.comments.map((c) => c.side))
    expect(sides.has('LEFT')).toBe(true)
    expect(sides.has('RIGHT')).toBe(true)

    for (const comment of draft!.comments) {
      // Side chosen through the SAME shared selector the classifier uses, so the
      // parity check cannot prefetch the wrong blob and mask a divergence.
      const entry = snap!.immutable.blobIndex[comment.path]
      const sha = selectAnchorBlobSha(entry, comment.side)
      const preview: AnchorResult = classifyPendingComment({
        comment,
        files: snap!.immutable.files,
        blobIndex: snap!.immutable.blobIndex,
        resolveBlobLines: (s) => (s === sha ? resolveBlobLines(s) : null),
      })
      const reported = report.results.find((r) => r.comment.key === comment.key)
      expect(reported).toBeDefined()
      // Preview and report must be byte-identical for this comment.
      expect(preview).toEqual(reported!)
    }

    store.close()
  })
})

/**
 * Live direct-mode sync smoke check against a seeded scratch sandbox. Name the
 * target with `REVU_SMOKE_REPO` (there is no default — this script writes to the
 * repository it is pointed at) and run it with an authenticated `gh` (or
 * GH_TOKEN set):
 *
 *   REVU_SMOKE_REPO=owner/name bun run scripts/smoke-direct.ts
 *
 * This is NOT part of the `bun test` gate: it makes real GitHub REST calls, so a
 * `*.test.ts` would red CI (the gate runs with no network). It exercises the REST
 * read path end to end and reports:
 *
 *   - the cold-sync REST request count for the large PR (#2),
 *   - that a warm re-sync of an unchanged PR skips the immutable half
 *     (the request count drops by the immutable-half calls),
 *   - that a base-advance PR (#4) is keyed by merge_base…head (reported cold; the
 *     live base-advance move — the compareKey shifting under a fixed head when the
 *     base fast-forwards onto a head ancestor — is proven in Section E),
 *   - that a mid-review PR (#3) normalizes its GraphQL review threads onto the
 *     REST shape: the `PRRT_` thread ids, `isResolved`/`isOutdated`, `side` from
 *     the thread `diffSide`, `diff_hunk` present, and REST-numeric comment ids
 *     from `fullDatabaseId`,
 *   - that the store persists across a simulated revud restart (reopen the same
 *     data dir and the snapshot + a saved draft are still there).
 *
 * Blob CONTENT bytes are now provisioned by the local-first provider: a cold
 * sync run against a fresh clone (with `git fetch origin` so both the merge base
 * and head are local) reads every blob via `git cat-file` at ZERO API cost, so
 * `blobsFetched` is ~0 and the ≤12-request budget holds with room to spare. The
 * live blob section below (Section B) proves the free lunch, the binary flagging
 * of `assets/logo.png`, and that a network-blackholed sync still succeeds when
 * local git has both SHAs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewDraft, Session } from '@revu/shared'
import { blobContentToLines, classifyPendingComment, selectAnchorBlobSha } from '@revu/shared'
import { createDirectTokenSource } from '../packages/revud/src/direct/token-source'
import { createBunCommandRunner } from '../packages/revud/src/direct/command-runner'
import type { GithubClient } from '../packages/revud/src/direct/github-client'
import { createGithubClient } from '../packages/revud/src/direct/github-client'
import { createDirectApi } from '../packages/revud/src/direct/direct-api'
import { openDirectStore } from '../packages/revud/src/direct/store'
import type { DirectStore } from '../packages/revud/src/direct/store'
import { syncPull } from '../packages/revud/src/direct/sync'
import type { CommandRunner } from '../packages/revud/src/direct/command-runner'
import type { RepoRef } from '../packages/revud/src/direct/repo'
import { resolveSmokeRepo } from './smoke-target'

const REPO: RepoRef = resolveSmokeRepo()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`FAIL   ${label}`, detail ?? '')
  }
}

async function main(): Promise<void> {
  const runner = createBunCommandRunner()
  const tokenSource = createDirectTokenSource(runner)
  // Fail fast with a clear message if there is no token, rather than a 401 later.
  try {
    await tokenSource.getToken()
  } catch (err) {
    console.error('No GitHub token available — run `gh auth login` or set GH_TOKEN.')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  const github = createGithubClient({ tokenSource })

  const dataDir = mkdtempSync(join(tmpdir(), 'revu-smoke-'))
  try {
    const store = openDirectStore({ dataDir })

    // ——— PR #1: clean small — a baseline cold sync. ———
    const p1 = await syncPull({ github, repo: REPO, store }, 1)
    console.log(
      `\nPR #1 (clean small): requests=${p1.syncStats?.requests}, ` +
        `files=${p1.immutable.files.length}, compareKey=${p1.immutable.compareKey}`,
    )
    check('PR #1 cold sync produced a snapshot', p1.immutable.files.length >= 0)
    check('PR #1 compareKey is merge_base...head', p1.immutable.compareKey.includes('...'))

    // ——— PR #2: large (16 files + binary + rename) — the headline request count. ———
    const p2cold = await syncPull({ github, repo: REPO, store }, 2)
    const coldRequests = p2cold.syncStats?.requests ?? -1
    console.log(
      `\nPR #2 (large) COLD: requests=${coldRequests}, files=${p2cold.immutable.files.length}, ` +
        `blobsFetched=${p2cold.syncStats?.blobsFetched}, blobsReused=${p2cold.syncStats?.blobsReused}`,
    )
    // Report a binary file (no patch) is represented honestly.
    const binary = p2cold.immutable.files.filter((f) => f.patch === undefined)
    console.log(`  PR #2 files with no patch (binary/oversize): ${binary.length}`)
    check('PR #2 cold sync REST request count is within the ≤12 (REST-only) budget', coldRequests <= 12, coldRequests)

    // ——— Warm re-sync of PR #2 (unchanged): the immutable half must be skipped. ———
    const p2warm = await syncPull({ github, repo: REPO, store }, 2)
    const warmRequests = p2warm.syncStats?.requests ?? -1
    console.log(
      `\nPR #2 (large) WARM: requests=${warmRequests}, ` +
        `blobsFetched=${p2warm.syncStats?.blobsFetched}, blobsReused=${p2warm.syncStats?.blobsReused}`,
    )
    check(
      'PR #2 warm re-sync skips the immutable half (fewer requests than cold)',
      warmRequests < coldRequests,
      { cold: coldRequests, warm: warmRequests },
    )
    check(
      'PR #2 warm re-sync keeps the same compareKey (immutable reused)',
      p2warm.immutable.compareKey === p2cold.immutable.compareKey,
    )

    // ——— PR #4: base-advances — report its compareKey (the base-moved keying). ———
    const p4 = await syncPull({ github, repo: REPO, store }, 4)
    console.log(
      `\nPR #4 (base-advances): compareKey=${p4.immutable.compareKey}, ` +
        `head=${p4.immutable.headSha.slice(0, 8)}, mergeBase=${p4.immutable.mergeBaseSha.slice(0, 8)}`,
    )
    check('PR #4 keyed by merge_base...head (base-moved keying)', p4.immutable.compareKey === `${p4.immutable.mergeBaseSha}...${p4.immutable.headSha}`)

    // ——— PR #3: mid-review (1 resolved + 1 outdated thread) — the GraphQL
    // thread normalizer end to end. Report the normalized threads and confirm
    // `fullDatabaseId` resolved to REST-numeric comment ids. ———
    const p3 = await syncPull({ github, repo: REPO, store }, 3)
    const threads = p3.mutable.threads
    console.log(`\nPR #3 (mid-review): ${threads.length} normalized thread(s)`)
    for (const t of threads) {
      const c0 = t.comments[0]
      console.log(
        `  ${t.id}  isResolved=${t.isResolved} isOutdated=${t.isOutdated} ` +
          `side=${c0?.side} resolvedBy=${t.resolvedBy?.login ?? 'null'}`,
      )
      console.log(
        `    comment[0] id=${c0?.id} (numeric=${typeof c0?.id === 'number'}) ` +
          `diff_hunk=${c0 && c0.diff_hunk.length > 0 ? 'present' : 'MISSING'}`,
      )
    }
    check('PR #3 has at least one review thread', threads.length >= 1, threads.length)
    check(
      'PR #3 thread ids are GraphQL PRRT_ node ids',
      threads.every((t) => t.id.startsWith('PRRT_')),
    )
    check(
      'PR #3 comment ids are REST-numeric (from fullDatabaseId), non-zero',
      threads.every((t) => t.comments.every((c) => typeof c.id === 'number' && c.id > 0)),
    )
    check(
      'PR #3 comments carry a diff_hunk and a LEFT/RIGHT side',
      threads.every((t) =>
        t.comments.every((c) => c.diff_hunk.length > 0 && (c.side === 'LEFT' || c.side === 'RIGHT')),
      ),
    )
    check(
      'PR #3 has one resolved and one outdated thread (the mid-review shape)',
      threads.some((t) => t.isResolved) && threads.some((t) => t.isOutdated),
      threads.map((t) => ({ resolved: t.isResolved, outdated: t.isOutdated })),
    )

    // ——— Persistence across a simulated revud restart. ———
    // Save a draft, close the store, reopen the SAME data dir, and re-read.
    const now = new Date().toISOString()
    store.putDraft({
      humanId: 'smoke@local',
      prNumber: 1,
      headSha: p1.immutable.headSha,
      compareKey: p1.immutable.compareKey,
      body: 'smoke draft — must survive a restart',
      event: 'COMMENT',
      comments: [],
      createdAt: now,
      updatedAt: now,
    })
    store.close()

    const reopened = openDirectStore({ dataDir })
    const draft = reopened.getDraft('smoke@local', 1)
    const snapAfter = reopened.getSnapshot(2)
    console.log('\nRestart persistence:')
    check('draft survives a store reopen (restart)', draft?.body?.includes('must survive') === true)
    check('snapshot survives a store reopen (restart)', snapAfter?.immutable.compareKey === p2cold.immutable.compareKey)
    // A warm re-sync after restart still skips the immutable half.
    const p2afterRestart = await syncPull({ github, repo: REPO, store: reopened }, 2)
    console.log(`  PR #2 warm after restart: requests=${p2afterRestart.syncStats?.requests}`)
    check(
      'PR #2 warm after restart still skips the immutable half',
      (p2afterRestart.syncStats?.requests ?? 99) < coldRequests,
    )
    reopened.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }

  // ——————————————————————————————————————————————————————————————
  // Section B — the local-first blob provider against a REAL clone.
  // ——————————————————————————————————————————————————————————————
  await blobSection(github, runner)

  // ——————————————————————————————————————————————————————————————
  // Section C — the full manual review loop, LIVE, against sandbox PR #1.
  // ——————————————————————————————————————————————————————————————
  await writeSection(github)

  // ——————————————————————————————————————————————————————————————
  // Section D — reconcile after a force-push, LIVE, against sandbox PR #5.
  // ——————————————————————————————————————————————————————————————
  await reconcileSection(github)

  // ——————————————————————————————————————————————————————————————
  // Section E — a base advance moves the compareKey under a FIXED head, LIVE,
  // against sandbox PR #4. Mutates the sandbox base branch, then resets it.
  // ——————————————————————————————————————————————————————————————
  await baseAdvanceSection(github, runner)

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * Reconcile after a force-push, LIVE, against sandbox PR #5 (the force-push PR:
 * the head was rewritten so a commented line moved/deleted). The crown-jewel flow
 * end to end against real GitHub:
 *
 *   1. Sync PR #5 — the fresh snapshot already reflects the REWRITTEN head, so the
 *      head blob no longer holds the pre-rewrite lines.
 *   2. Build a draft whose comments are anchored to lines as they were BEFORE the
 *      rewrite — the anchor text of a line that SURVIVED the rewrite (moved) and a
 *      line that was DELETED — and save it with the draft's `headSha` set to the
 *      pre-rewrite first parent (so `newCommits` has a real split point when it is
 *      still in the fresh commit list; otherwise it falls back to author date).
 *   3. reconcileDraft against the fresh snapshot and REPORT the classifications
 *      (a surviving line drifts; a deleted line is lost) and the `newCommits`.
 *   4. Assert the report matches the client-side PREVIEW for every comment — the
 *      same shared `classifyPendingComment` both ends run, so they cannot diverge.
 *
 * The draft is never submitted; reconcile is a pure read. The section leaves no
 * write on github.com.
 */
async function reconcileSection(github: GithubClient): Promise<void> {
  console.log('\n=== Section D: reconcile after force-push (LIVE, sandbox PR #5) ===')
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-reconcile-'))
  try {
    const viewer = await github.getViewer()
    const session: Session = {
      human: {
        id: `${viewer.login}@smoke.local`,
        name: viewer.login,
        role: 'contractor',
        email: `${viewer.login}@smoke.local`,
      },
      brokerLogin: '',
      workspace: 'direct-smoke',
      viewerLogin: viewer.login,
    }
    const store: DirectStore = openDirectStore({ dataDir })
    const api = createDirectApi({ session, github, repo: REPO, store })

    // 1. Sync PR #5 — the REWRITTEN head is what the snapshot now carries.
    const snap = await api.syncPull(5)
    const headSha = snap.immutable.headSha
    const file = snap.immutable.files[0]
    console.log(`  step 1 — synced PR #5: head=${headSha.slice(0, 8)}, file=${file?.filename}`)
    check('step 1: PR #5 synced with a head SHA', headSha.length > 0)
    check('step 1: PR #5 has a changed file', file !== undefined)
    if (file === undefined) return

    // Read the CURRENT (rewritten) head blob lines so the drift anchor targets a
    // line that genuinely survived the rewrite, and log them for the record.
    const headBlobSha = snap.immutable.blobIndex[file.filename]?.head
    const headBlob = headBlobSha ? store.getBlob(headBlobSha) : null
    const headLines = headBlob && !headBlob.binary ? blobContentToLines(headBlob.content) : []
    console.log(`  step 1 — rewritten head has ${headLines.length} line(s) in ${file.filename}`)

    // A line that SURVIVED the rewrite (the exported function signature) — its text
    // still exists in the fresh head but at a different line number (drift). And a
    // line that was DELETED by the rewrite (the pre-rewrite return) — gone (lost).
    const survivor = headLines.find((l) => l.includes('export function handle'))
    const survivorLine = survivor ? headLines.indexOf(survivor) + 1 : -1
    check('step 1: a surviving line is present in the rewritten head', survivor !== undefined, headLines)
    if (survivor === undefined) return

    // The draft was written against the PRE-rewrite head, which the force-push
    // orphaned — so it is no longer in the fresh commit list. reconcile then
    // derives newCommits by the author-date fallback: every fresh commit authored
    // after the draft was created is a "new commit" the rewrite added. Pin the
    // draft's creation well before the PR so the rewrite commit surfaces as new.
    const preRewriteHead = 'pre-rewrite-orphaned-head-sha'
    const draftCreatedAt = '2000-01-01T00:00:00.000Z'

    // 2. Build the draft. The drift comment claims the survivor was originally on
    //    line 1 (its pre-rewrite position at the top of the v1 handler); it now
    //    sits at `survivorLine`, so reconcile must drift it by (survivorLine - 1).
    //    The lost comment anchors to the deleted pre-rewrite return line.
    const stamp = new Date().toISOString()
    const draft: ReviewDraft = {
      humanId: session.human.id,
      prNumber: 5,
      // The pre-rewrite head the draft was written against — orphaned by the
      // force-push, so it is absent from the fresh commit list and newCommits
      // falls back to the author-date split.
      headSha: preRewriteHead,
      compareKey: snap.immutable.compareKey,
      body: `Reconcile smoke ${stamp}`,
      event: 'COMMENT',
      createdAt: draftCreatedAt,
      updatedAt: draftCreatedAt,
      comments: [
        {
          key: 'drift-1',
          path: file.filename,
          side: 'RIGHT',
          start_side: null,
          // Pre-rewrite the handler signature was the FIRST line of the file.
          line: 1,
          start_line: null,
          body: `Drift anchor (${stamp}).`,
          createdAt: stamp,
          updatedAt: stamp,
          anchor: { lineText: survivor, contextBefore: [], contextAfter: [] },
        },
        {
          key: 'lost-1',
          path: file.filename,
          side: 'RIGHT',
          start_side: null,
          line: 3,
          start_line: null,
          body: `Lost anchor (${stamp}).`,
          createdAt: stamp,
          updatedAt: stamp,
          // The pre-rewrite `return 'starting'` line was deleted by the refactor.
          anchor: { lineText: "    return 'starting'", contextBefore: [], contextAfter: [] },
        },
      ],
    }
    api.saveDraft(draft)
    console.log(`  step 2 — saved a draft with ${draft.comments.length} anchored comments`)

    // 3. Reconcile against the fresh snapshot — a PURE read; the draft is untouched.
    const report = api.reconcileDraft(5)
    console.log('  step 3 — reconcile classifications:')
    for (const r of report.results) {
      if (r.kind === 'drifted') {
        console.log(`    ${r.comment.key}: DRIFTED newLine=${r.newLine} delta=${r.delta}`)
      } else if (r.kind === 'lost') {
        console.log(`    ${r.comment.key}: LOST reason=${r.reason}`)
      } else {
        console.log(`    ${r.comment.key}: CLEAN`)
      }
    }
    console.log(
      `  step 3 — newCommits=${report.newCommits.length} ` +
        `(${report.newCommits.map((c) => c.sha.slice(0, 7)).join(', ') || 'none'}), ` +
        `draftHead=${report.draftHeadSha.slice(0, 8)} currentHead=${report.currentHeadSha.slice(0, 8)}`,
    )
    check('step 3: the draft is untouched by reconcile (pure read)', store.getDraft(session.human.id, 5) !== null)

    const drift = report.results.find((r) => r.comment.key === 'drift-1')
    check(
      'step 3: the surviving line is DRIFTED to its new position',
      drift?.kind === 'drifted' && drift.newLine === survivorLine,
      { kind: drift?.kind, newLine: drift?.kind === 'drifted' ? drift.newLine : null, expected: survivorLine },
    )
    const lost = report.results.find((r) => r.comment.key === 'lost-1')
    check(
      'step 3: the deleted line is LOST (line-deleted)',
      lost?.kind === 'lost' && lost.reason === 'line-deleted',
      { kind: lost?.kind, reason: lost?.kind === 'lost' ? lost.reason : null },
    )
    check(
      'step 3: newCommits surfaces the rewrite commit the force-push added (author-date fallback)',
      report.newCommits.length >= 1,
      report.newCommits.map((c) => c.sha.slice(0, 7)),
    )
    check(
      'step 3: the report names the current head as distinct from the orphaned draft head',
      report.currentHeadSha === headSha && report.draftHeadSha === preRewriteHead,
      { current: report.currentHeadSha, draft: report.draftHeadSha },
    )

    // 4. Preview parity — recompute each classification client-side through the
    //    SAME shared classifier and selector, resolving blob lines through getBlob.
    let parity = true
    for (const comment of draft.comments) {
      const entry = snap.immutable.blobIndex[comment.path]
      const sha = selectAnchorBlobSha(entry, comment.side)
      const preview = classifyPendingComment({
        comment,
        files: snap.immutable.files,
        blobIndex: snap.immutable.blobIndex,
        resolveBlobLines: (s) => {
          if (s !== sha) return null
          const blob = api.getBlob(s)
          return blob.binary ? null : blobContentToLines(blob.content)
        },
      })
      const reported = report.results.find((r) => r.comment.key === comment.key)
      if (JSON.stringify(preview) !== JSON.stringify(reported)) parity = false
    }
    check('step 4: the client-side preview matches the reconcile report for every comment', parity)

    store.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** The base-advance fixture's branches and the commit the base advances onto. */
const BASE_ADVANCE = {
  prNumber: 4,
  baseBranch: 'fixture/base-advances-target',
  headBranch: 'fixture/base-advances',
} as const

/**
 * Move a branch ref to `sha`. `force` allows a non-fast-forward reset (used to
 * put the base branch back at the fork after the advance). Returns the tip.
 */
async function moveBranch(
  runner: CommandRunner,
  branch: string,
  sha: string,
  force: boolean,
): Promise<string> {
  const res = await runner.run([
    'gh',
    'api',
    '-X',
    'PATCH',
    `repos/${REPO.owner}/${REPO.repo}/git/refs/heads/${branch}`,
    '-f',
    `sha=${sha}`,
    '-F',
    `force=${force}`,
    '--jq',
    '.object.sha',
  ])
  if (!res.ok) throw new Error(`move ${branch} -> ${sha.slice(0, 8)} failed: ${res.stderr.trim()}`)
  return res.stdout.trim()
}

/**
 * Nudge a pull request so its stored `base.sha` recomputes from the live base
 * branch tip. GitHub does NOT refresh a pull's `base.sha` when the base ref is
 * moved by a bare ref update — it snapshots that field and only recomputes it on
 * a pull "synchronize". Re-setting the base to the SAME branch forces the
 * recompute, so a subsequent sync (which keys off `pull.base.sha`) sees the
 * moved base. Without this, the sync would keep reading the pre-advance base.
 */
async function refreshPullBase(runner: CommandRunner, prNumber: number, branch: string): Promise<void> {
  const res = await runner.run([
    'gh',
    'pr',
    'edit',
    '-R',
    `${REPO.owner}/${REPO.repo}`,
    String(prNumber),
    '--base',
    branch,
  ])
  if (!res.ok) throw new Error(`refresh pull #${prNumber} base failed: ${res.stderr.trim()}`)
}

/**
 * A base advance moves the compareKey under a FIXED head, LIVE, against sandbox
 * PR #4 (base-advances). The head branch is fork+h1+h2; the base branch sits at
 * the fork. Advancing the base onto h1 — a commit the head already contains —
 * moves the three-dot merge base from fork to h1 while the head SHA stays fixed,
 * so the diff shrinks to h2's file alone. This is the two-half cache-keying
 * regression: a head-only cache would wrongly reuse the pre-advance diff.
 *
 *   1. Sync PR #4 — record compareKey_A (fork…head) and the head SHA, and the
 *      pre-advance file set.
 *   2. Advance the base branch onto h1 (the head's first commit off the fork,
 *      read live from the compare of head against the fork) and refresh the
 *      pull's base.sha so the sync sees the moved base.
 *   3. Re-sync PR #4 into the SAME store — record compareKey_B (h1…head). Assert
 *      compareKey_B differs, the head SHA is UNCHANGED, the merge base moved to
 *      h1, and the immutable half was REBUILT (not served from compareKey_A: the
 *      files diff shrank to h2's file alone).
 *   4. Reset the base branch back to the fork and refresh the pull, so the
 *      fixture is re-runnable from the pre-advance state.
 *
 * The head is never touched; only the base branch moves and is put back.
 */
async function baseAdvanceSection(github: GithubClient, runner: CommandRunner): Promise<void> {
  console.log('\n=== Section E: base advance moves the compareKey (LIVE, sandbox PR #4) ===')
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-base-advance-'))

  // The fork the base branch must be restored to (its pre-advance tip).
  const forkTip = (
    await ghApi(runner, `repos/${REPO.owner}/${REPO.repo}/git/ref/heads/${BASE_ADVANCE.baseBranch}`)
  ) as { object: { sha: string } }
  const forkSha = forkTip.object.sha

  try {
    const store = openDirectStore({ dataDir })

    // 1. Sync PR #4 at the pre-advance state — compareKey_A = fork…head.
    const before = await syncPull({ github, repo: REPO, store }, BASE_ADVANCE.prNumber)
    const compareKeyA = before.immutable.compareKey
    const headA = before.immutable.headSha
    const filesA = before.immutable.files.map((f) => f.filename).sort()
    console.log(
      `  step 1 — synced PR #4: compareKey_A=${compareKeyA}, ` +
        `head=${headA.slice(0, 8)}, mergeBase=${before.immutable.mergeBaseSha.slice(0, 8)}, ` +
        `files=[${filesA.join(', ')}]`,
    )
    check('step 1: compareKey_A is merge_base(fork)…head', compareKeyA === `${forkSha}...${headA}`)

    // h1 — the head's FIRST commit off the fork — read live from the compare of
    // the head branch against the fork. Advancing the base onto it moves the
    // merge base while the head stays fixed.
    const headVsFork = (await ghApi(
      runner,
      `repos/${REPO.owner}/${REPO.repo}/compare/${forkSha}...${BASE_ADVANCE.headBranch}`,
    )) as { commits: Array<{ sha: string }> }
    const h1Sha = headVsFork.commits[0]?.sha
    check('step 1: the head has a first commit off the fork (h1)', typeof h1Sha === 'string' && h1Sha.length > 0, h1Sha)
    if (h1Sha === undefined) return

    // 2. Advance the base branch onto h1 (a real fast-forward onto a head
    //    ancestor) and refresh the pull so its base.sha catches up.
    const advancedTip = await moveBranch(runner, BASE_ADVANCE.baseBranch, h1Sha, false)
    await refreshPullBase(runner, BASE_ADVANCE.prNumber, BASE_ADVANCE.baseBranch)
    console.log(`  step 2 — advanced base ${BASE_ADVANCE.baseBranch} onto h1=${advancedTip.slice(0, 8)}`)

    try {
      // 3. Re-sync into the SAME store — compareKey_B = h1…head. A moved compare
      //    key forces the immutable half to be rebuilt (no compareKey_A reuse).
      const after = await syncPull({ github, repo: REPO, store }, BASE_ADVANCE.prNumber)
      const compareKeyB = after.immutable.compareKey
      const headB = after.immutable.headSha
      const filesB = after.immutable.files.map((f) => f.filename).sort()
      console.log(
        `  step 3 — re-synced PR #4: compareKey_B=${compareKeyB}, ` +
          `head=${headB.slice(0, 8)}, mergeBase=${after.immutable.mergeBaseSha.slice(0, 8)}, ` +
          `files=[${filesB.join(', ')}]`,
      )
      check('step 3: the compareKey MOVED (compareKey_B !== compareKey_A)', compareKeyB !== compareKeyA, {
        a: compareKeyA,
        b: compareKeyB,
      })
      check('step 3: the head SHA is UNCHANGED across the advance', headB === headA, { a: headA, b: headB })
      check('step 3: compareKey_B is merge_base(h1)…head', compareKeyB === `${h1Sha}...${headB}`)
      check('step 3: the merge base moved to h1', after.immutable.mergeBaseSha === h1Sha, {
        was: before.immutable.mergeBaseSha,
        now: after.immutable.mergeBaseSha,
      })
      // The immutable half was rebuilt, NOT served from the compareKey_A cache:
      // the three-dot diff shrank to h2's file alone (h1's file left the diff).
      check(
        'step 3: the immutable half was REBUILT (files diff changed, not reused from compareKey_A cache)',
        JSON.stringify(filesB) !== JSON.stringify(filesA) && filesB.length < filesA.length,
        { before: filesA, after: filesB },
      )
    } finally {
      // 4. Reset the base branch to the fork and refresh the pull, so the
      //    fixture is back at the pre-advance state for the next run.
      await moveBranch(runner, BASE_ADVANCE.baseBranch, forkSha, true)
      await refreshPullBase(runner, BASE_ADVANCE.prNumber, BASE_ADVANCE.baseBranch)
      console.log(`  step 4 — reset base ${BASE_ADVANCE.baseBranch} back to fork=${forkSha.slice(0, 8)}`)
    }

    store.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/**
 * Run one `gh api` call as the authenticated `gh` user and parse the JSON.
 * Used to VERIFY, from GitHub's own side, that what the write path posted is
 * actually visible on github.com (not just what revud believes it posted).
 */
async function ghApi(runner: CommandRunner, path: string): Promise<unknown> {
  const result = await runner.run(['gh', 'api', path])
  if (!result.ok) {
    throw new Error(`gh api ${path} failed: ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout) as unknown
}

/**
 * The full manual review loop, LIVE, against sandbox PR #1 (clean-small,
 * self-authored so APPROVE is out of scope — a COMMENT review):
 *
 *   1. Sync PR #1.
 *   2. Build a draft with an inline comment INCLUDING a multi-line comment and a
 *      ```suggestion``` block, save it to the store.
 *   3. Submit a COMMENT review through the real write path — the draft is deleted
 *      only on confirmed success.
 *   4. VERIFY via `gh api` that the review and its inline comments are visible on
 *      github.com.
 *   5. Post a reply to the new thread's first comment (as the gh user — this
 *      stands in for a github.com-side reply).
 *   6. Resolve one of the threads.
 *   7. Re-sync and confirm the thread now carries the reply and reads resolved,
 *      with genuine identity (the gh user's real login, no bot, no smuggled name).
 *
 * Every posted id is logged. The loop is re-runnable: each run posts a fresh
 * review/reply and the draft is rebuilt from scratch, so nothing accumulates in
 * a way that breaks a later run (GitHub simply gains more review comments, which
 * is the honest record of repeated smoke runs).
 */
async function writeSection(github: GithubClient): Promise<void> {
  console.log('\n=== Section C: full manual review loop (LIVE, sandbox PR #1) ===')
  const runner = createBunCommandRunner()
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-write-'))
  try {
    const viewer = await github.getViewer()
    const session: Session = {
      human: {
        id: `${viewer.login}@smoke.local`,
        name: viewer.login,
        role: 'contractor',
        email: `${viewer.login}@smoke.local`,
      },
      brokerLogin: '',
      workspace: 'direct-smoke',
      viewerLogin: viewer.login,
    }
    const store: DirectStore = openDirectStore({ dataDir })
    const api = createDirectApi({ session, github, repo: REPO, store })

    // 1. Sync PR #1 — establishes the snapshot the reply lookup reads from.
    const snap = await api.syncPull(1)
    const headSha = snap.immutable.headSha
    const file = snap.immutable.files[0]
    console.log(`  step 1 — synced PR #1: head=${headSha.slice(0, 8)}, file=${file?.filename}`)
    check('step 1: PR #1 synced with a head SHA', headSha.length > 0)
    check('step 1: PR #1 has a changed file to anchor a comment on', file !== undefined)
    if (file === undefined) return

    // 2. Build a draft: one multi-line comment (RIGHT side, lines 5–9 — inside the
    //    added titleCase function) plus a single-line ```suggestion``` on line 6.
    const stamp = new Date().toISOString()
    const draft: ReviewDraft = {
      humanId: session.human.id,
      prNumber: 1,
      headSha,
      compareKey: snap.immutable.compareKey,
      body: `Smoke review ${stamp} — direct-mode write path.`,
      event: 'COMMENT',
      comments: [
        {
          key: 'multi-1',
          path: file.filename,
          side: 'RIGHT',
          start_side: 'RIGHT',
          line: 9,
          start_line: 5,
          body: `Multi-line note (${stamp}): this block spans several lines.`,
          createdAt: stamp,
          updatedAt: stamp,
          anchor: { lineText: '', contextBefore: [], contextAfter: [] },
        },
        {
          key: 'suggest-1',
          path: file.filename,
          side: 'RIGHT',
          start_side: null,
          line: 6,
          start_line: null,
          body: 'A suggestion:\n```suggestion\n    .split(\' \')\n```',
          createdAt: stamp,
          updatedAt: stamp,
          anchor: { lineText: '', contextBefore: [], contextAfter: [] },
        },
      ],
    }
    api.saveDraft(draft)
    console.log(`  step 2 — saved a draft with ${draft.comments.length} inline comments (1 multi-line, 1 suggestion)`)
    check('step 2: the draft is in the store before submit', store.getDraft(session.human.id, 1) !== null)

    // 3. Submit the COMMENT review through the real write path.
    const result = await api.submitReview({
      prNumber: 1,
      expectedHeadSha: headSha,
      event: 'COMMENT',
      body: draft.body,
      comments: draft.comments,
    })
    console.log(`  step 3 — submitReview → status=${result.status}`)
    if (result.status !== 'ok') {
      check('step 3: submitReview succeeded', false, result)
      return
    }
    const reviewId = result.review.id
    console.log(`    review id=${reviewId}, state=${result.review.state}, commit=${result.review.commit_id.slice(0, 8)}`)
    check('step 3: submit returned a COMMENTED review', result.review.state === 'COMMENTED')
    check('step 3: the draft was deleted ONLY after a confirmed submit', store.getDraft(session.human.id, 1) === null)

    // 4. VERIFY on github.com via gh api — the review and its comments are real.
    const ghReviews = (await ghApi(runner, `repos/${REPO.owner}/${REPO.repo}/pulls/1/reviews`)) as {
      id: number
      user: { login: string }
      state: string
    }[]
    const seenReview = ghReviews.find((r) => r.id === reviewId)
    console.log(`  step 4 — gh api sees ${ghReviews.length} review(s); this one present=${seenReview !== undefined}`)
    check('step 4: the review is visible on github.com via gh api', seenReview !== undefined)
    check('step 4: the review is authored by the real gh user (no bot, genuine identity)', seenReview?.user.login === viewer.login)

    const ghComments = (await ghApi(runner, `repos/${REPO.owner}/${REPO.repo}/pulls/1/comments?per_page=100`)) as {
      id: number
      pull_request_review_id: number | null
      body: string
      line: number | null
      start_line: number | null
    }[]
    const mine = ghComments.filter((c) => c.pull_request_review_id === reviewId)
    console.log(`  step 4 — this review has ${mine.length} inline comment(s) on github.com`)
    check('step 4: both inline comments landed on github.com', mine.length === 2, mine.map((c) => ({ line: c.line, start_line: c.start_line })))
    check('step 4: the multi-line comment carries a start_line on github.com', mine.some((c) => c.start_line !== null))
    check('step 4: the single-line comment carries NO start_line on github.com', mine.some((c) => c.start_line === null))
    check('step 4: no email leaked into any comment body', mine.every((c) => !c.body.includes('@smoke.local')))

    // 5. Reply to the new thread's first comment (stands in for a github.com reply).
    //    Re-sync so the snapshot carries the freshly-created threads to reply into.
    const synced2 = await api.syncPull(1)
    const myThread = synced2.mutable.threads.find((t) =>
      t.comments.some((c) => mine.some((m) => m.id === c.id)),
    )
    check('step 5: the new thread is in the re-synced snapshot', myThread !== undefined, synced2.mutable.threads.length)
    if (myThread === undefined) return
    const reply = await api.replyToThread(1, myThread.id, `Reply from the smoke loop (${stamp}).`)
    console.log(`  step 5 — replied to thread ${myThread.id} (first comment id=${myThread.comments[0].id}) → new comment id=${reply.id}`)
    check('step 5: the reply is attached to the thread root (in_reply_to_id set)', reply.in_reply_to_id !== undefined)
    check('step 5: the reply is authored by the real gh user', reply.user.login === viewer.login)

    // 6. Resolve the thread.
    const resolved = await api.resolveThread(1, myThread.id, true)
    console.log(`  step 6 — resolved thread ${myThread.id} → isResolved=${resolved.isResolved}, resolvedBy=${resolved.resolvedBy?.login}`)
    check('step 6: the thread reads resolved after the mutation', resolved.isResolved === true)

    // 7. Re-sync: the thread now carries the reply AND reads resolved, with genuine identity.
    const synced3 = await api.syncPull(1)
    const finalThread = synced3.mutable.threads.find((t) => t.id === myThread.id)
    const carriesReply = finalThread?.comments.some((c) => c.id === reply.id) === true
    console.log(
      `  step 7 — re-sync: thread ${myThread.id} isResolved=${finalThread?.isResolved}, ` +
        `comments=${finalThread?.comments.length}, carriesReply=${carriesReply}`,
    )
    check('step 7: the re-synced thread reads resolved', finalThread?.isResolved === true)
    check('step 7: the re-synced thread carries the reply', carriesReply)
    check(
      'step 7: every comment renders with a genuine login (no bot, no smuggled name prefix)',
      finalThread?.comments.every((c) => c.user.login.length > 0 && !c.body.startsWith('**')) === true,
    )

    store.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/**
 * Prove the free lunch end to end: clone the target repository, `git fetch
 * origin` so both the merge base and head SHAs are local, then run a cold sync of
 * the large PR (#2) with the local-first blob provider pointed at the clone. It
 * reports the total API request count (≤12 with local-git blobs), that
 * `blobsFetched` is ~0 (the clone had the objects), that the binary asset is
 * flagged `binary` with a `size`, and that with the network blackholed the sync
 * still succeeds because local git has both SHAs.
 */
async function blobSection(github: GithubClient, runner: CommandRunner): Promise<void> {
  console.log('\n=== Section B: local-first blob provider (real clone) ===')
  const cloneParent = mkdtempSync(join(tmpdir(), 'revu-clone-'))
  const cwd = join(cloneParent, REPO.repo)
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-blob-'))
  try {
    // Clone and fetch so both merge_base and head are present locally.
    const cloneUrl = `https://github.com/${REPO.owner}/${REPO.repo}.git`
    const cloned = await runner.run(['git', 'clone', '--quiet', cloneUrl, cwd])
    if (!cloned.ok) {
      check('clone the sandbox for local-git blobs', false, cloned.stderr.trim())
      return
    }
    await runner.run(['git', 'fetch', '--quiet', 'origin'], { cwd })

    // Cold sync of PR #2 with the local-first provider pointed at the clone.
    const store = openDirectStore({ dataDir })
    const p2 = await syncPull({ github, repo: REPO, store, runner, cwd }, 2)
    const requests = p2.syncStats?.requests ?? -1
    const fetched = p2.syncStats?.blobsFetched ?? -1
    const reused = p2.syncStats?.blobsReused ?? -1
    console.log(
      `\nPR #2 COLD with local-git blobs: requests=${requests}, ` +
        `blobsFetched=${fetched}, blobsReused=${reused}, partial=${p2.partial ? 'yes' : 'no'}`,
    )
    check('PR #2 cold sync with local git stays within the ≤12 request budget', requests <= 12, requests)
    check('PR #2 blobsFetched is ~0 (blobs came from the local clone, not the API)', fetched === 0, fetched)
    check('PR #2 cold sync is complete (no missing-blob partial)', p2.partial === null, p2.partial)

    // The binary asset (assets/logo.png) is flagged binary with a real size.
    const binPath = 'assets/logo.png'
    const binSha = p2.immutable.blobIndex[binPath]?.head ?? p2.immutable.blobIndex[binPath]?.base
    const binBlob = binSha ? store.getBlob(binSha) : null
    console.log(
      `  ${binPath}: sha=${binSha?.slice(0, 8) ?? 'absent'} ` +
        `binary=${binBlob?.binary} size=${binBlob?.size} contentLen=${binBlob?.content.length}`,
    )
    check(`${binPath} is present in the blob index`, binSha !== undefined && binSha !== null, binSha)
    check(`${binPath} is flagged binary with a size and collapsed content`,
      binBlob?.binary === true && (binBlob?.size ?? 0) > 0 && binBlob?.content === '',
      { binary: binBlob?.binary, size: binBlob?.size, contentLen: binBlob?.content.length },
    )
    store.close()

    // Offline: the network is blackholed (getBlobObjects/getBlob throw), but a
    // fresh cold sync into a NEW store still completes because local git supplies
    // every blob. Only the blob API is blackholed; the sync REST reads still run
    // (blobs are the offline-capable path this proves).
    const offlineStore = openDirectStore({ dataDir: mkdtempSync(join(tmpdir(), 'revu-offline-')) })
    const blackholed: GithubClient = {
      ...github,
      async getBlobObjects() {
        throw new Error('network blackholed (blob API)')
      },
      async getBlob() {
        throw new Error('network blackholed (blob API)')
      },
    }
    const offline = await syncPull({ github: blackholed, repo: REPO, store: offlineStore, runner, cwd }, 2)
    console.log(
      `\nPR #2 with blob API blackholed: blobsFetched=${offline.syncStats?.blobsFetched}, ` +
        `partial=${offline.partial ? 'yes' : 'no'}`,
    )
    check(
      'PR #2 sync succeeds with the blob API blackholed (local git had both SHAs)',
      offline.partial === null && (offline.syncStats?.blobsFetched ?? -1) === 0,
      { partial: offline.partial, blobsFetched: offline.syncStats?.blobsFetched },
    )
    offlineStore.close()
  } finally {
    rmSync(cloneParent, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})

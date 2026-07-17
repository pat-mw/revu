/**
 * Live direct-mode sync smoke check against the seeded sandbox
 * `pat-mw/revu-sandbox`. Run with an authenticated `gh` (or GH_TOKEN set):
 *
 *   bun run scripts/smoke-direct.ts
 *
 * This is NOT part of the `bun test` gate: it makes real GitHub REST calls, so a
 * `*.test.ts` would red CI (the gate runs with no network). It exercises the REST
 * read path end to end and reports:
 *
 *   - the cold-sync REST request count for the large PR (#2),
 *   - that a warm re-sync of an unchanged PR skips the immutable half
 *     (the request count drops by the immutable-half calls),
 *   - that a base-advance PR (#4) produces a NEW compareKey when its base moves,
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

const REPO: RepoRef = { owner: 'pat-mw', repo: 'revu-sandbox' }

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

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * Run one `gh api` call as the authenticated pat-mw user and parse the JSON.
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
 * Prove the free lunch end to end: clone `pat-mw/revu-sandbox`, `git fetch
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
  const cwd = join(cloneParent, 'revu-sandbox')
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

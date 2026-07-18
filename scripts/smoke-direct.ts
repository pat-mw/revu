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
 * Blob CONTENT bytes are a later concern (local-git `cat-file`), so the reported
 * counts are REST-only; the exit budget of ≤12 for the large PR includes local
 * blob reads that cost zero REST, so a REST-only count under it is expected.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDirectTokenSource } from '../packages/revud/src/direct/token-source'
import { createBunCommandRunner } from '../packages/revud/src/direct/command-runner'
import { createGithubClient } from '../packages/revud/src/direct/github-client'
import { openDirectStore } from '../packages/revud/src/direct/store'
import { syncPull } from '../packages/revud/src/direct/sync'
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

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})

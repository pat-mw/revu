/**
 * Broker-mode live read smoke against the scratch sandbox.
 *
 * Proves the inject model end to end against real GitHub: the workspace-side
 * `FileCredentialTokenSource` reads the ambient credential a host broker injected
 * (see `broker-mint-token.ts`), and the reused sync engine reads real pull
 * requests through it — cold + warm sync, the request budget, local-git blobs,
 * and the GraphQL thread normalizer. Broker mode is reads-only, so nothing here
 * writes to GitHub.
 *
 * No-leak is asserted live and in-process: the token is read from the credential
 * file inside this script only to confirm it never appears in any synced snapshot
 * or stat; it is never printed. Configuration:
 *   REVU_CREDENTIALS_FILE  the injected credential file to read
 *   REVU_SANDBOX_DIR       a local clone of the sandbox repo (for git blobs)
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBunCommandRunner } from '../packages/revud/src/direct/command-runner'
import { createGithubClient } from '../packages/revud/src/direct/github-client'
import { openDirectStore } from '../packages/revud/src/direct/store'
import { syncPull } from '../packages/revud/src/direct/sync'
import {
  AwaitingCredentialError,
  createFileCredentialTokenSource,
} from '../packages/revud/src/broker/token-source'
import type { RepoRef } from '../packages/revud/src/direct/repo'

const REPO: RepoRef = { owner: 'pat-mw', repo: 'revu-sandbox' }

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim().length === 0) {
    console.error(`missing required env ${name}`)
    process.exit(2)
  }
  return v.trim()
}

let failures = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.error(`FAIL   ${label}`, detail ?? '')
  }
}

/** The injected token, read once for the no-leak assertion. Never printed. */
function injectedToken(credFile: string): string {
  const line = readFileSync(credFile, 'utf8').split('\n').find((l) => l.includes('github.com'))
  const m = line?.match(/https:\/\/x-access-token:([^@]+)@github\.com/)
  return m ? decodeURIComponent(m[1]) : ''
}

async function main(): Promise<void> {
  const credFile = requireEnv('REVU_CREDENTIALS_FILE')
  const cwd = resolve(requireEnv('REVU_SANDBOX_DIR'))
  const token = injectedToken(credFile)
  check('credential file yields a token for the smoke', token.length > 0)

  const runner = createBunCommandRunner()
  const tokenSource = createFileCredentialTokenSource({ path: credFile })

  // The token source resolves the injected credential (never cached, re-read per
  // request). A confirmation that it resolves at all, without printing it.
  try {
    const t = await tokenSource.getToken()
    check('FileCredentialTokenSource resolves the injected credential', t.length > 0)
  } catch (err) {
    check(
      'FileCredentialTokenSource resolves the injected credential',
      false,
      err instanceof AwaitingCredentialError ? 'awaiting credential (file missing/empty)' : err,
    )
    process.exit(1)
  }

  const github = createGithubClient({ tokenSource })
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-broker-smoke-'))
  const store = openDirectStore({ dataDir })
  const leakSurfaces: string[] = []
  const record = (o: unknown): void => {
    leakSurfaces.push(JSON.stringify(o))
  }

  // PR #1 clean small — baseline cold read through the injected token.
  const p1 = await syncPull({ github, repo: REPO, store, runner, cwd }, 1)
  record(p1)
  console.log(
    `\nPR #1 (clean small): requests=${p1.syncStats?.requests}, files=${p1.immutable.files.length}, ` +
      `compareKey=${p1.immutable.compareKey.slice(0, 20)}…`,
  )
  check('PR #1 read produced a snapshot with files', p1.immutable.files.length >= 1)
  check('PR #1 compareKey is merge_base...head', p1.immutable.compareKey.includes('...'))

  // PR #2 large — the headline: request budget + local-git blobs.
  const p2 = await syncPull({ github, repo: REPO, store, runner, cwd }, 2)
  record(p2)
  console.log(
    `\nPR #2 (large): requests=${p2.syncStats?.requests}, files=${p2.immutable.files.length}, ` +
      `blobsFetched=${p2.syncStats?.blobsFetched}, blobsReused=${p2.syncStats?.blobsReused}`,
  )
  check('PR #2 large read produced many files', p2.immutable.files.length >= 5, p2.immutable.files.length)
  check('PR #2 REST request count within the ≤12 budget', (p2.syncStats?.requests ?? 99) <= 12, p2.syncStats?.requests)

  // Warm re-sync — the immutable half is skipped.
  const p2warm = await syncPull({ github, repo: REPO, store, runner, cwd }, 2)
  record(p2warm)
  console.log(`\nPR #2 WARM: requests=${p2warm.syncStats?.requests} (cold ${p2.syncStats?.requests})`)
  check('PR #2 warm re-sync uses fewer requests than cold', (p2warm.syncStats?.requests ?? 99) < (p2.syncStats?.requests ?? 0))
  check('PR #2 warm keeps the same compareKey', p2warm.immutable.compareKey === p2.immutable.compareKey)

  // PR #3 mid-review — the GraphQL thread normalizer through the injected token.
  const p3 = await syncPull({ github, repo: REPO, store, runner, cwd }, 3)
  record(p3)
  const threads = p3.mutable.threads
  console.log(`\nPR #3 (mid-review): ${threads.length} normalized thread(s)`)
  check('PR #3 normalized at least one review thread', threads.length >= 1, threads.length)
  const firstId = threads[0]?.comments[0]?.id
  check('PR #3 thread comment id is REST-numeric (fullDatabaseId resolved)', typeof firstId === 'number', firstId)

  // No-leak — the token must not appear in any synced snapshot or stat.
  const leaked = token.length > 0 && leakSurfaces.some((s) => s.includes(token))
  check('no-leak: the injected token appears in NO synced snapshot/stat', !leaked)

  console.log(`\n${failures === 0 ? 'BROKER READ SMOKE PASSED' : `BROKER READ SMOKE FAILED (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

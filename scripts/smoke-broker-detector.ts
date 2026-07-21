/**
 * Out-of-band-write detector live smoke against the scratch sandbox.
 *
 * Simulates a contractor bypassing revu: it posts a PR conversation (issue)
 * comment DIRECTLY as the App bot on the ambient token — no revu, no audit
 * journal row — then runs the host-side reconcile against an empty journal and
 * asserts the detector flags that comment as an out-of-band write. It deletes
 * the comment afterward so the sandbox is left clean. A bot-authored issue
 * comment is out-of-band by construction: revu never creates one.
 *
 * The token is used in-process only and never printed. Configuration:
 *   REVU_SMOKE_REPO        the scratch repository to write to, as owner/name
 *   REVU_CREDENTIALS_FILE  the injected credential file
 *   REVU_BOT_LOGIN         the App bot login (e.g. my-review-app[bot])
 */
import { createGithubClient } from '../packages/revud/src/direct/github-client'
import { createFileCredentialTokenSource } from '../packages/revud/src/broker/token-source'
import { reconcilePullOutOfBand } from '../packages/revud/src/broker/out-of-band-writes'
import type { RepoRef } from '../packages/revud/src/direct/repo'
import { resolveSmokeRepo } from './smoke-target'

const REPO: RepoRef = resolveSmokeRepo()
const PR = 1

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

async function gh(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'revu-broker-detector-smoke',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await resp.text()
  return { status: resp.status, json: text.length > 0 ? JSON.parse(text) : null }
}

async function main(): Promise<void> {
  const credFile = requireEnv('REVU_CREDENTIALS_FILE')
  const botLogin = requireEnv('REVU_BOT_LOGIN')
  const tokenSource = createFileCredentialTokenSource({ path: credFile })
  const token = await tokenSource.getToken() // in-process only, never printed

  console.log('=== out-of-band detector live smoke (sandbox PR #1) ===')

  // 1. Post a bot issue comment DIRECTLY — bypassing revu entirely (no journal).
  const marker = `revu-detector-smoke ${new Date().toISOString()}`
  const posted = (await gh('POST', `/repos/${REPO.owner}/${REPO.repo}/issues/${PR}/comments`, token, {
    body: `${marker} — out-of-band (posted directly as the bot; auto-deleted).`,
  })).json as { id: number; user: { login: string } }
  check('posted a direct bot issue comment (the bypass)', typeof posted?.id === 'number')
  check('the bypass comment is authored by the bot', posted?.user?.login === botLogin, posted?.user?.login)
  console.log(`  bypass comment id=${posted.id}`)

  // 2. Reconcile against an EMPTY journal — revu mediated nothing, so this write
  //    must be flagged. The journal reader returns no rows.
  const report = await reconcilePullOutOfBand(
    { github: createGithubClient({ tokenSource }), journal: { listAudit: () => [] }, repo: REPO, botLogin },
    PR,
  )
  const flagged = report.outOfBand.find((w) => w.id === posted.id)
  check('the detector flags the bypass comment as out-of-band', flagged !== undefined)
  check('it is flagged as an issue_comment authored by the bot', flagged?.kind === 'issue_comment' && flagged?.authorLogin === botLogin, flagged)
  console.log(`  detector flagged ${report.outOfBand.length} out-of-band bot artifact(s) on PR ${PR}`)

  // 3. Cleanup — delete the bypass comment.
  const del = await gh('DELETE', `/repos/${REPO.owner}/${REPO.repo}/issues/comments/${posted.id}`, token)
  check('the bypass comment was deleted (cleanup)', del.status === 204, del.status)

  console.log(`\n${failures === 0 ? 'DETECTOR SMOKE PASSED' : `DETECTOR SMOKE FAILED (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

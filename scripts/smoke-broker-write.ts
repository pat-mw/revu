/**
 * Broker-mode live WRITE smoke against the scratch sandbox.
 *
 * Proves the broker write path end to end against real GitHub: the broker write
 * decorator stamps the human's `**name** (role)` prefix onto a mediated comment,
 * posts it as the shared App bot on the ambient injected token, and journals one
 * durable audit_log row. It then reads the comment back from GitHub to confirm
 * the stamp round-trips, checks the audit row, and DELETES the comment so the
 * sandbox is left clean.
 *
 * Nothing is printed that could leak the token; the injected credential is used
 * in-process only. Configuration:
 *   REVU_SMOKE_REPO        the scratch repository to write to, as owner/name
 *   REVU_CREDENTIALS_FILE  the injected credential file
 *   REVU_SANDBOX_DIR       a local clone of the sandbox repo (for git blobs)
 *   REVU_BOT_LOGIN         the App bot login (e.g. my-review-app[bot])
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Human, ReviewDraft, Session } from '@revu/shared'
import { parsePrefixedBody, prefixBody } from '@revu/shared'
import { createBunCommandRunner } from '../packages/revud/src/direct/command-runner'
import { createGithubClient } from '../packages/revud/src/direct/github-client'
import { openDirectStore } from '../packages/revud/src/direct/store'
import { createDirectApi } from '../packages/revud/src/direct/direct-api'
import { createBrokerWriteDecorator } from '../packages/revud/src/direct/write-decorator'
import { createFileCredentialTokenSource } from '../packages/revud/src/broker/token-source'
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

/** The first added ('+') line's new-file line number in a unified diff patch. */
function firstAddedLine(patch: string): number | null {
  let newLine = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) {
      const m = l.match(/\+(\d+)/)
      newLine = m ? parseInt(m[1], 10) : newLine
      continue
    }
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) return newLine
    if (l.startsWith('-')) continue
    newLine += 1
  }
  return null
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
      'User-Agent': 'revu-broker-write-smoke',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await resp.text()
  return { status: resp.status, json: text.length > 0 ? JSON.parse(text) : null }
}

async function main(): Promise<void> {
  const credFile = requireEnv('REVU_CREDENTIALS_FILE')
  const cwd = resolve(requireEnv('REVU_SANDBOX_DIR'))
  const botLogin = requireEnv('REVU_BOT_LOGIN')

  const human: Human = {
    id: 'broker-smoke@revu.local',
    name: 'Broker Smoke',
    role: 'contractor',
    email: 'broker-smoke@revu.local',
  }
  // Broker session: the bot login is BOTH brokerLogin (stamped bot comments route
  // to the prefix parser) and viewerLogin (the write self-guards identify the bot).
  const session: Session = {
    human,
    brokerLogin: botLogin,
    workspace: 'broker-smoke',
    viewerLogin: botLogin,
  }

  const tokenSource = createFileCredentialTokenSource({ path: credFile })
  const token = await tokenSource.getToken() // in-process only, never printed
  const github = createGithubClient({ tokenSource })
  const runner = createBunCommandRunner()
  const store = openDirectStore({ dataDir: mkdtempSync(join(tmpdir(), 'revu-bw-')) })
  const writeDecorator = createBrokerWriteDecorator(session, store)
  const api = createDirectApi({ session, github, repo: REPO, store, writeDecorator, runner, cwd })

  console.log('=== broker live WRITE smoke (sandbox PR #1) ===')

  // 1. Sync to establish the snapshot the submit head-guards against.
  const snap = await api.syncPull(PR)
  const headSha = snap.immutable.headSha
  const file = snap.immutable.files.find((f) => f.patch !== undefined)
  check('synced PR #1 with a head SHA and a patchable file', headSha.length > 0 && file !== undefined)
  if (file === undefined) {
    process.exit(1)
  }
  const line = firstAddedLine(file.patch ?? '') ?? 1
  console.log(`  head=${headSha.slice(0, 8)} file=${file.filename} line=${line}`)

  // 2. Submit a COMMENT review with ONE stamped inline comment. The summary body
  //    is empty (not stamped); the inline comment is non-empty (stamped).
  const marker = `revu-broker-write-smoke ${headSha.slice(0, 8)} ${new Date().toISOString()}`
  const commentBody = `${marker} — please ignore (auto-deleted by the smoke).`
  const draft: ReviewDraft = {
    humanId: human.id,
    prNumber: PR,
    headSha,
    compareKey: snap.immutable.compareKey,
    body: '',
    event: 'COMMENT',
    comments: [
      {
        key: 'bw-1',
        path: file.filename,
        side: 'RIGHT',
        start_side: null,
        line,
        start_line: null,
        body: commentBody,
        createdAt: marker,
        updatedAt: marker,
        anchor: { lineText: '', contextBefore: [], contextAfter: [] },
      },
    ],
  }
  const result = await api.submitReview({
    prNumber: PR,
    expectedHeadSha: headSha,
    event: 'COMMENT',
    body: draft.body,
    comments: draft.comments,
  })
  check('submitReview returned ok', result.status === 'ok', result.status)
  if (result.status !== 'ok') process.exit(1)
  console.log(`  posted review id=${result.review.id} as the bot`)

  // 3. Audit row landed for the mediated write.
  const audit = store.listAudit({ pr: PR })
  const auditRow = audit.find((a) => a.endpoint === 'submitReview')
  check('an audit_log row was journaled for the submit', auditRow !== undefined)
  check('the audit row keys on the human email, not the bot', auditRow?.humanId === human.id, auditRow?.humanId)
  console.log(`  audit rows for PR ${PR}: ${audit.length}`)

  // 4. Read the comment back from GitHub — it is authored by the bot and its body
  //    carries the human's stamped prefix, which round-trips to the human.
  const listed = (await gh('GET', `/repos/${REPO.owner}/${REPO.repo}/pulls/${PR}/comments?per_page=100`, token))
    .json as Array<{ id: number; body: string; user: { login: string } }>
  const posted = listed.find((c) => c.body.includes(marker))
  check('the posted comment is visible on GitHub', posted !== undefined)
  if (posted === undefined) process.exit(1)
  check('the comment is authored by the shared bot', posted.user.login === botLogin, posted.user.login)
  check('the comment body carries the stamped prefix', posted.body.startsWith(prefixBody(human, '').trimEnd().split('\n')[0]))
  const parsed = parsePrefixedBody(posted.body)
  check('the stamp round-trips to the human name+role', parsed?.name === human.name && parsed?.role === human.role, parsed)
  check('the human email is NOT in the posted body', !posted.body.includes(human.email))

  // 5. Cleanup — delete the comment so the sandbox is left clean.
  const del = await gh('DELETE', `/repos/${REPO.owner}/${REPO.repo}/pulls/comments/${posted.id}`, token)
  check('the smoke comment was deleted (cleanup)', del.status === 204, del.status)

  // No-leak: the token appears in no printed surface (nothing above prints it).
  console.log(`\n${failures === 0 ? 'BROKER WRITE SMOKE PASSED' : `BROKER WRITE SMOKE FAILED (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

/**
 * Host-broker simulator for the broker-mode live smoke.
 *
 * In the real deployment a host-side token broker mints a short-lived GitHub App
 * installation token and pushes it into each workspace container's
 * `~/.git-credentials` over `docker exec`; revu never mints and only reads that
 * file (`createFileCredentialTokenSource`). This script plays the host-broker
 * role for a local smoke: it signs an App JWT with the App private key, exchanges
 * it for an installation token, and writes the token into a credential file in
 * the git-credential-store format the reader expects.
 *
 * The private key and the minted token are treated as secrets: the key is read
 * from a path (never printed), and the token is written only to the target file —
 * standard output carries a redacted prefix, the expiry, the granted permissions,
 * and the App bot login (needed to self-identify the App's own writes), never the
 * token itself.
 *
 * Configuration is by environment so no secret or account coordinate is baked in:
 *   REVU_APP_PEM           path to the App private key (PEM)
 *   REVU_APP_ID            numeric App id
 *   REVU_INSTALLATION_ID   numeric installation id
 *   REVU_CREDENTIALS_FILE  output credential file (created with 0600)
 *   REVU_TOKEN_REPOS       optional comma list to scope the token to (owner/repo)
 */
import { createSign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const API = 'https://api.github.com'
const UA = 'revu-broker-smoke'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim().length === 0) {
    console.error(`missing required env ${name}`)
    process.exit(2)
  }
  return v.trim()
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function signAppJwt(pem: string, appId: string): string {
  const now = Math.floor(Date.now() / 1000)
  // `iat` is backdated 60s for clock skew; `exp` is well under GitHub's 10-minute
  // ceiling. The JWT is itself a short-lived secret and is never printed.
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))
  const signingInput = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(pem).toString('base64url')
  return `${signingInput}.${signature}`
}

async function ghJson(
  path: string,
  jwt: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const resp = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!resp.ok) {
    // Surface status + GitHub's message, which never contains the token; do not
    // echo request headers.
    const text = await resp.text()
    console.error(`GitHub ${init?.method ?? 'GET'} ${path} -> ${resp.status}: ${text.slice(0, 300)}`)
    process.exit(1)
  }
  return resp.json()
}

async function main(): Promise<void> {
  const pemPath = requireEnv('REVU_APP_PEM')
  const appId = requireEnv('REVU_APP_ID')
  const installationId = requireEnv('REVU_INSTALLATION_ID')
  const credFile = requireEnv('REVU_CREDENTIALS_FILE')
  const repos = process.env.REVU_TOKEN_REPOS?.trim()

  const pem = readFileSync(pemPath, 'utf8')
  const jwt = signAppJwt(pem, appId)

  // The App's own identity — the bot login is `<slug>[bot]`, the author GitHub
  // attributes App-authored comments/reviews to. Read via the JWT (`GET /app`).
  const app = (await ghJson('/app', jwt)) as { slug?: string; name?: string; id?: number }
  const botLogin = app.slug !== undefined ? `${app.slug}[bot]` : '(unknown)'

  const body: Record<string, unknown> = {}
  if (repos !== undefined && repos.length > 0) {
    body.repositories = repos.split(',').map((r) => r.split('/')[1] ?? r)
  }
  const tok = (await ghJson(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: 'POST',
    ...(Object.keys(body).length > 0 ? { body } : {}),
  })) as { token?: string; expires_at?: string; permissions?: Record<string, string> }

  if (typeof tok.token !== 'string' || tok.token.length === 0) {
    console.error('installation token response had no token')
    process.exit(1)
  }

  mkdirSync(dirname(credFile), { recursive: true })
  writeFileSync(credFile, `https://x-access-token:${tok.token}@github.com\n`, { mode: 0o600 })

  // Redacted report only — never the token itself.
  console.log(`app: id=${app.id} slug=${app.slug} name=${app.name}`)
  console.log(`bot login: ${botLogin}`)
  console.log(`token: ${tok.token.slice(0, 4)}**** (redacted) expires_at=${tok.expires_at}`)
  console.log(`permissions: ${JSON.stringify(tok.permissions)}`)
  console.log(`wrote credential file: ${credFile} (0600)`)
}

await main()

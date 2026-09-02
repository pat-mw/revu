/**
 * Reviews of local branches, driven end to end over real HTTP against a real
 * daemon in a real repository that has no remote at all.
 *
 * Every other suite that covers this capability drives it in-process, with a
 * fake command runner or a fake store standing where a subprocess or a file
 * would be. That leaves one whole layer unasserted: the boot that assembles the
 * surface, the router that dispatches an id from the reserved local band, the
 * status codes and headers that reach a client, and the durability of all of it
 * across a restart. This suite is that layer, and nothing in it is faked — the
 * daemon is a child process, the repository is a seeded git repository on disk,
 * and every claim is made through `fetch`.
 *
 * ## The three transport semantics, on the local leg
 *
 * The contract's three non-error semantics are asserted for pull requests
 * elsewhere and for local reviews nowhere: a never-synced review's snapshot is a
 * JSON `null` at 200 rather than a 404, a sync carries `partial` as a body field
 * rather than as an error status, and a submit whose head guard fails is a 200
 * carrying `status: 'head_moved'`. The third one stays live locally for a reason
 * that has no pull-request equivalent: amending the head commit moves the head
 * with no pull-request event to announce it, so the only thing standing between
 * a reviewer and a submit against a commit that no longer exists is the guard.
 *
 * ## Degradation, not a network error
 *
 * A daemon with no repository must answer every GitHub-bound route with a typed
 * 501 naming what is missing. The discriminator between "answered honestly" and
 * "tried GitHub and failed" is `broker_unreachable`, the code every real network
 * failure maps to — so every answer this suite receives is inspected for it, and
 * the ledger of any that carried it is asserted empty at the end of the file.
 *
 * ## Why the tests run in one order
 *
 * The flow is sequential by nature: an id has to exist before it can be synced,
 * a draft has to exist before it can survive a restart, and a submit consumes
 * the draft it submits. The head-moved case comes last of all because amending
 * the head commit invalidates the head SHA every earlier case is written
 * against.
 *
 * ## Isolation of the git the daemon runs
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are pointed at paths that are
 * never created, in the child's environment as well as the fixture's. This is
 * the one suite where the daemon's own git subprocesses run outside a harness
 * that already pins them, and ambient configuration reaches every one of them:
 * a global `diff.external` replaces the diff machinery wholesale, and a review
 * built on its output is then unbuildable on that machine and fine on every
 * other. A missing config file is an empty one, so absent paths are the "no
 * ambient configuration" state. Identity is the deliberate exception: it is set
 * in the fixture repository's own config, because the daemon refuses to start
 * without a `user.email` to key drafts under.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type {
  LocalReviewSummary,
  PullListResponse,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  Session,
  Snapshot,
  SubmitResult,
} from '@revu/shared'
import { LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import { createFixtureRepo, type FixtureRepo } from './direct/local-fixture-repo'

/** The daemon entry point, started as a child process. */
const ENTRY = join(import.meta.dir, 'index.ts')

/** The `--preload` module that makes "no outbound request" a process property. */
const PRELOAD = join(import.meta.dir, 'no-network-preload.ts')

/**
 * The git identity the fixture repositories carry, and the human id the daemon
 * derives from it. Mixed case on purpose: the id is the lowercased email, so a
 * response echoing the address verbatim would not match.
 */
const SESSION_EMAIL = 'Local.Reviewer@revu.invalid'
const SESSION_NAME = 'Local Reviewer'
const SESSION_HUMAN_ID = 'local.reviewer@revu.invalid'

/**
 * The identity a hostile request body claims for its draft. It must never key a
 * stored row, and must never come back in a response.
 */
const FOREIGN_HUMAN_ID = 'victim@corp.com'

/** A pull request number, used only to probe the GitHub-bound routes. */
const PULL_REQUEST_NUMBER = 204

// ————————————————————————————————————————————————————————————————————————————
// The HTTP seam, and the broker-outage ledger.
// ————————————————————————————————————————————————————————————————————————————

/** One answer, read to completion so its body can be asserted more than once. */
interface Answer {
  readonly status: number
  readonly etag: string | null
  readonly text: string
}

/**
 * Every answer in this suite whose envelope carried `broker_unreachable`,
 * described well enough to act on.
 *
 * `broker_unreachable` is what a real network failure maps to, and the whole
 * premise of this deployment is that there is no network to fail. An entry here
 * therefore means one of two things, both of which matter: a GitHub-bound route
 * lost its degradation branch and fell through to the router's terminal
 * catch-all, or something on the local path genuinely tried to reach out. The
 * ledger is asserted empty in the last test of the file.
 */
const brokerOutageAnswers: string[] = []

/** The `code` an envelope carried, or `null` for a body that is not one. */
function envelopeCode(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text)
    if (body === null || typeof body !== 'object') return null
    const code = (body as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  } catch {
    // A 304 carries no body and the SPA fallback serves HTML; neither is an
    // envelope, and neither is a failure.
    return null
  }
}

/** Issue one request, read the body, and record a broker-outage envelope. */
async function call(base: string, path: string, init?: RequestInit): Promise<Answer> {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  if (envelopeCode(text) === 'broker_unreachable') {
    brokerOutageAnswers.push(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text}`)
  }
  return { status: res.status, etag: res.headers.get('etag'), text }
}

/** Parse an answer's body. Throws on a body that is not JSON, which is the point. */
function bodyOf<T>(answer: Answer): T {
  return JSON.parse(answer.text) as T
}

/** A JSON request body under a method, in the shape `fetch` takes. */
function sending(method: 'POST' | 'PUT', body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

// ————————————————————————————————————————————————————————————————————————————
// The child daemon.
// ————————————————————————————————————————————————————————————————————————————

const STUB_INDEX_HTML =
  '<!doctype html><html><head><title>revud stub</title></head>' +
  '<body><div id="root"></div></body></html>'

interface Daemon {
  readonly proc: Subprocess
  readonly base: string
  /** Everything the child wrote to stderr, resolved once it exits. */
  readonly stderr: Promise<string>
}

interface DaemonOptions {
  /** The directory the daemon starts in — the repository it will discover. */
  readonly cwd: string
  readonly dataDir: string
  readonly distDir: string
}

/**
 * The environment knobs that would change what the daemon boots into. Cleared
 * rather than trusted: a developer's shell that happens to carry one of these
 * would otherwise decide what this suite is testing.
 */
const CLEARED_ENV_KEYS = [
  'REVU_MODE',
  'REVU_REPO',
  'REVU_ROLE',
  'REVU_BOT_LOGIN',
  'REVU_LOCAL_ONLY',
  'REVU_CREDENTIALS_FILE',
] as const

/**
 * The startup line reports the bound port; a fixed port would collide with
 * whatever else is listening, and with a second copy of this suite.
 */
const PORT_FROM_STARTUP_LINE = /http:\/\/localhost:(\d+)/

/**
 * Start a daemon that serves local reviews only, on an ephemeral port.
 *
 * It is started through the no-network preload, so an outbound `fetch` from any
 * code path it evaluates fails immediately and names the URL it was handed.
 *
 * The startup handshake — read the bound port out of the startup line, then
 * poll until the session answers — is the same one the mock-mode integration
 * suite performs, deliberately re-stated rather than imported: importing a
 * `*.test.ts` for its helpers registers that file's whole suite a second time.
 */
async function startLocalDaemon(opts: DaemonOptions): Promise<Daemon> {
  const env: Record<string, string | undefined> = { ...process.env }
  env.REVU_PORT = '0'
  env.REVU_DATA_DIR = opts.dataDir
  env.REVU_DIST_DIR = opts.distDir
  // Inside the data directory and never created. See this file's header for why
  // the daemon's own git subprocesses must read no ambient configuration.
  env.GIT_CONFIG_GLOBAL = join(opts.dataDir, 'absent-global-gitconfig')
  env.GIT_CONFIG_SYSTEM = join(opts.dataDir, 'absent-system-gitconfig')
  for (const key of CLEARED_ENV_KEYS) delete env[key]

  const proc = Bun.spawn(['bun', '--preload', PRELOAD, ENTRY, '--direct', '--local-only'], {
    cwd: opts.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Consumed continuously so a child that logs cannot block on a full pipe, and
  // awaited only after it exits — which is when it is worth reading.
  const stderr = new Response(proc.stderr).text()

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let port = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value)
    const match = PORT_FROM_STARTUP_LINE.exec(buffer)
    if (match) {
      port = Number(match[1])
      break
    }
    if (done) break
  }
  // Keep draining for the same reason stderr is drained.
  void (async (): Promise<void> => {
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    } catch {
      // The child went away; there is nothing left to drain.
    }
  })()

  if (port === 0) {
    proc.kill('SIGKILL')
    throw new Error(
      `revud reported no port from ${opts.cwd}.\nstdout: ${buffer}\nstderr: ${await stderr}`,
    )
  }

  const base = `http://localhost:${port}`
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const res = await fetch(`${base}/api/session`)
      await res.body?.cancel()
      if (res.ok) return { proc, base, stderr }
    } catch {
      // Not listening yet — the loop is the readiness signal, not a delay.
    }
    await Bun.sleep(25)
  }
  proc.kill('SIGKILL')
  throw new Error(`revud never became ready at ${base}.\nstderr: ${await stderr}`)
}

/** Stop a daemon and wait for it to exit, so its data directory is quiescent. */
async function stopDaemon(daemon: Daemon): Promise<void> {
  daemon.proc.kill('SIGTERM')
  await daemon.proc.exited
}

// ————————————————————————————————————————————————————————————————————————————
// Git, and the fixture repositories.
// ————————————————————————————————————————————————————————————————————————————

/** Run one git command in a directory, throwing on a non-zero exit. */
async function git(
  dir: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<string> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`\`git ${args.join(' ')}\` in ${dir} exited ${code}: ${stderr.trim()}`)
  }
  return stdout
}

/**
 * Give a fixture repository the git identity the daemon reads at boot.
 *
 * The fixture passes identity per commit and sets none in its config, and the
 * ambient config the daemon would otherwise inherit is pinned absent — so
 * without this the daemon refuses to start, which is the correct behaviour for
 * an unset `user.email`: it is the key every draft and viewed mark is filed
 * under, and a blank one would collapse every human onto one row.
 */
async function giveIdentity(fixture: FixtureRepo): Promise<void> {
  await git(fixture.dir, fixture.env, ['config', 'user.email', SESSION_EMAIL])
  await git(fixture.dir, fixture.env, ['config', 'user.name', SESSION_NAME])
}

/**
 * Everything this file created, unwound after the last test whether or not the
 * assertions passed. A child process that outlives its suite holds a port and a
 * data directory; a temp directory that outlives it accumulates silently.
 */
const cleanups: (() => void | Promise<void>)[] = []

afterAll(async () => {
  for (const cleanup of cleanups.slice().reverse()) {
    try {
      await cleanup()
    } catch {
      // Best effort: one failed teardown must not hide the others.
    }
  }
}, 60_000)

/** Register a daemon for teardown and return it. */
function tracked(daemon: Daemon): Daemon {
  cleanups.push(() => stopDaemon(daemon))
  return daemon
}

/** Make a temp directory that is removed after the last test. */
function trackedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * A temp `dist/` holding the one file the daemon needs in order to start.
 *
 * The daemon validates its static root at boot, and the app is built AFTER the
 * tests run, so pointing at the real build output would make this suite pass
 * only on a tree that had already been built once. A stub keeps it hermetic.
 */
function trackedStubDist(): string {
  const dir = trackedTempDir('revu-local-serve-dist-')
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  return dir
}

// ————————————————————————————————————————————————————————————————————————————
// The flow, in the order it reaches each claim.
// ————————————————————————————————————————————————————————————————————————————

let fixture: FixtureRepo
let dataDir: string
let distDir: string
let daemon: Daemon

/** The review created below, and the snapshot the flow is written against. */
let localId = 0
let syncedHeadSha = ''
let syncedCompareKey = ''

/** The body of the draft that must survive a restart, and then be submitted. */
const DRAFT_BODY = 'Unsubmitted review text that must survive a restart.'

/** One answer, refreshed by each step, so a later test can read the last one. */
let threadId = ''

beforeAll(async () => {
  fixture = await createFixtureRepo()
  cleanups.push(() => {
    fixture.dispose()
  })
  await giveIdentity(fixture)
  distDir = trackedStubDist()
  dataDir = trackedTempDir('revu-local-serve-data-')
  daemon = tracked(await startLocalDaemon({ cwd: fixture.dir, dataDir, distDir }))
}, 120_000)

describe('a daemon in a repository with no remote starts and serves a real session', () => {
  test('the session identity comes from git config, and no viewer was probed', async () => {
    const answer = await call(daemon.base, '/api/session')
    expect(answer.status).toBe(200)
    const session = bodyOf<Session>(answer)
    expect(session.human.id).toBe(SESSION_HUMAN_ID)
    expect(session.human.name).toBe(SESSION_NAME)
    // A local-only boot issues no GitHub request at all, so there is no login to
    // report. A present one would mean the boot probed a viewer it has no
    // credential for.
    expect(session.viewerLogin).toBeUndefined()
  })

  test('the branches of the repository are read from git, not from a store', async () => {
    const answer = await call(daemon.base, '/api/branches')
    expect(answer.status).toBe(200)
    const refs = bodyOf<{ ref: string }[]>(answer).map((branch) => branch.ref)
    expect(refs).toContain(`refs/heads/${fixture.baseBranch}`)
    expect(refs).toContain(`refs/heads/${fixture.headBranch}`)
  })

  test('the list is served, and is empty before anything is recorded', async () => {
    const answer = await call(daemon.base, '/api/pulls')
    expect(answer.status).toBe(200)
    expect(bodyOf<PullListResponse>(answer).items).toHaveLength(0)
  })

  test('a review of two local branches is recorded under the repository toplevel', async () => {
    const answer = await call(
      daemon.base,
      '/api/local-reviews',
      sending('POST', { baseRef: fixture.baseBranch, headRef: fixture.headBranch }),
    )
    expect(answer.status).toBe(200)
    const summary = bodyOf<LocalReviewSummary>(answer)
    localId = summary.id
    expect(localId).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)
    // No origin remote parses, so the repository is identified by its toplevel.
    expect(summary.repo).toBe(fixture.dir)
    expect(summary.baseRef).toBe(`refs/heads/${fixture.baseBranch}`)
    expect(summary.headRef).toBe(`refs/heads/${fixture.headBranch}`)
  }, 30_000)
})

describe('the three transport semantics, on the local leg', () => {
  test('a never-synced review answers a JSON null snapshot at 200, never a 404', async () => {
    const answer = await call(daemon.base, `/api/pulls/${localId}/snapshot`)
    // Pinned as literals on both halves. A 404 here is indistinguishable from
    // "no such review" and would push a client into re-creating the review it
    // already has; a `null` body at 200 says "recorded, never synced".
    expect(answer.status).toBe(200)
    expect(answer.text).toBe('null')
  })

  test('sync answers 200 and carries `partial` as a body field, not as a status', async () => {
    const answer = await call(daemon.base, `/api/pulls/${localId}/sync`, sending('POST'))
    expect(answer.status).toBe(200)
    const snapshot = bodyOf<Snapshot>(answer)
    // The field is present as a KEY, which is the transport claim: an
    // incomplete sync is reported inside a 200 body, and there is no status
    // this route answers a partial with. Its value is null here because this
    // clone can produce every object the range names — the populated case needs
    // a git that cannot, which is asserted where a runner can be substituted.
    expect(Object.hasOwn(snapshot, 'partial')).toBe(true)
    expect(snapshot.partial).toBeNull()
    expect(envelopeCode(answer.text)).toBeNull()
    expect(snapshot.prNumber).toBe(localId)
    // Not one request was spent: the whole snapshot came out of local git.
    expect(snapshot.syncStats?.requests).toBe(0)
    syncedHeadSha = snapshot.immutable.headSha
    syncedCompareKey = snapshot.immutable.compareKey
    expect(syncedHeadSha).toBe(fixture.headSha)
  }, 30_000)

  test('the synced snapshot reads back at 200 with the range the fixture seeded', async () => {
    const answer = await call(daemon.base, `/api/pulls/${localId}/snapshot`)
    expect(answer.status).toBe(200)
    const snapshot = bodyOf<Snapshot | null>(answer)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.immutable.headSha).toBe(fixture.headSha)
    expect(snapshot?.immutable.commits).toHaveLength(fixture.headCommitShas.length)
  })
})

describe('the list carries the review, and a replayed etag costs nothing', () => {
  test('GET /api/pulls lists the created review and emits an ETag', async () => {
    const answer = await call(daemon.base, '/api/pulls')
    expect(answer.status).toBe(200)
    expect(answer.etag).toBeTruthy()
    const numbers = bodyOf<PullListResponse>(answer).items.map((item) => item.pull.number)
    expect(numbers).toContain(localId)
  })

  test('a matching If-None-Match is a 304 whose body is empty', async () => {
    const first = await call(daemon.base, '/api/pulls')
    const etag = first.etag as string
    const second = await call(daemon.base, '/api/pulls', { headers: { 'if-none-match': etag } })
    expect(second.status).toBe(304)
    expect(second.etag).toBe(etag)
    // The status alone would pass against a 304 that still carried the list —
    // which costs the client exactly what conditioning was meant to save.
    expect(second.text).toBe('')
  })
})

describe('a draft on a local review is keyed by the session, never by the body', () => {
  test('a spoofed humanId is overwritten before the store is touched', async () => {
    const now = new Date().toISOString()
    const spoofed: ReviewDraft = {
      humanId: FOREIGN_HUMAN_ID,
      prNumber: localId,
      headSha: syncedHeadSha,
      compareKey: syncedCompareKey,
      body: DRAFT_BODY,
      event: 'COMMENT',
      comments: [],
      createdAt: now,
      updatedAt: now,
    }
    const saved = await call(
      daemon.base,
      `/api/pulls/${localId}/draft`,
      sending('PUT', spoofed),
    )
    expect(saved.status).toBe(200)
    expect(bodyOf<ReviewDraft>(saved).humanId).toBe(SESSION_HUMAN_ID)
    expect(saved.text).not.toContain(FOREIGN_HUMAN_ID)
  })

  test('the draft reads back over HTTP under the session identity', async () => {
    const answer = await call(daemon.base, `/api/pulls/${localId}/draft`)
    expect(answer.status).toBe(200)
    const draft = bodyOf<ReviewDraft | null>(answer)
    expect(draft?.body).toBe(DRAFT_BODY)
    expect(draft?.humanId).toBe(SESSION_HUMAN_ID)
  })

  test('nothing at all is stored under the claimed identity', async () => {
    // Read raw, past every getter: a getter that filters correctly can sit on
    // top of a row written to the wrong key, and the leak stays invisible until
    // something else reads the table. There is deliberately no HTTP route that
    // could answer this question — that absence is the isolation.
    const raw = new Database(join(dataDir, 'direct.sqlite'))
    const rows = raw.query('SELECT human_id FROM local_drafts').all() as {
      human_id: string
    }[]
    raw.close()
    expect(rows.map((row) => row.human_id)).toEqual([SESSION_HUMAN_ID])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Degradation: an honest 501 everywhere GitHub would be needed.
// ————————————————————————————————————————————————————————————————————————————

/**
 * Every route only GitHub can answer, addressed with a PULL REQUEST id so the
 * refusal is the one under test. The same routes addressed with an id from the
 * local band are served throughout the rest of this file, which is what makes
 * the refusal a per-review decision rather than a per-route one.
 */
const GITHUB_BOUND_PROBES: readonly { method: 'GET' | 'POST'; path: string }[] = [
  { method: 'GET', path: '/api/rate-limit' },
  { method: 'POST', path: `/api/pulls/${PULL_REQUEST_NUMBER}/sync` },
  { method: 'GET', path: `/api/pulls/${PULL_REQUEST_NUMBER}/snapshot` },
  { method: 'POST', path: `/api/pulls/${PULL_REQUEST_NUMBER}/review` },
  { method: 'POST', path: `/api/pulls/${PULL_REQUEST_NUMBER}/threads/t-1/reply` },
  { method: 'POST', path: `/api/pulls/${PULL_REQUEST_NUMBER}/threads/t-1/resolve` },
  { method: 'POST', path: `/api/comments/12345/reactions?pr=${PULL_REQUEST_NUMBER}` },
]

describe('every GitHub-bound route degrades to a typed 501 naming what is missing', () => {
  for (const probe of GITHUB_BOUND_PROBES) {
    test(`${probe.method} ${probe.path} answers 501 not_implemented`, async () => {
      const answer = await call(
        daemon.base,
        probe.path,
        probe.method === 'GET' ? undefined : sending('POST'),
      )
      expect(answer.status).toBe(501)
      const envelope = bodyOf<{ code: string; message: string }>(answer)
      expect(envelope.code).toBe('not_implemented')
      // The message has to say what this daemon IS, or its reader spends the
      // next hour looking for an outage that never happened.
      expect(envelope.message).toContain('no GitHub repository')
    })
  }
})

describe('the daemon restarts onto the same review and the same draft', () => {
  test('a restart against the same data directory keeps both', async () => {
    await stopDaemon(daemon)
    daemon = tracked(await startLocalDaemon({ cwd: fixture.dir, dataDir, distDir }))

    const listed = await call(daemon.base, '/api/local-reviews')
    expect(listed.status).toBe(200)
    const summaries = bodyOf<LocalReviewSummary[]>(listed)
    expect(summaries.map((summary) => summary.id)).toEqual([localId])

    const draft = await call(daemon.base, `/api/pulls/${localId}/draft`)
    expect(draft.status).toBe(200)
    expect(bodyOf<ReviewDraft | null>(draft)?.body).toBe(DRAFT_BODY)
  }, 120_000)
})

describe('the full loop: submit, reply, resolve — all of it local', () => {
  test('submitting the draft against the current head lands a review', async () => {
    const now = new Date().toISOString()
    const answer = await call(
      daemon.base,
      `/api/pulls/${localId}/review`,
      sending('POST', {
        prNumber: localId,
        expectedHeadSha: syncedHeadSha,
        event: 'COMMENT',
        body: 'Submitted with no forge involved.',
        comments: [
          {
            key: 'the-one-inline-comment',
            path: fixture.paths.modified,
            side: 'RIGHT',
            start_side: null,
            line: 2,
            start_line: null,
            body: 'An inline comment on a local review.',
            createdAt: now,
            updatedAt: now,
            anchor: { lineText: 'BRAVO-CHANGED', contextBefore: [], contextAfter: [] },
          },
        ],
      }),
    )
    expect(answer.status).toBe(200)
    const result = bodyOf<SubmitResult>(answer)
    expect(result.status).toBe('ok')
  }, 30_000)

  test('the submitted comment is a thread on the snapshot', async () => {
    const answer = await call(daemon.base, `/api/pulls/${localId}/snapshot`)
    expect(answer.status).toBe(200)
    const threads = bodyOf<Snapshot>(answer).mutable.threads
    expect(threads).toHaveLength(1)
    threadId = threads[0].id
    expect(threads[0].path).toBe(fixture.paths.modified)
  })

  test('a reply appends to the thread', async () => {
    const answer = await call(
      daemon.base,
      `/api/pulls/${localId}/threads/${encodeURIComponent(threadId)}/reply`,
      sending('POST', { body: 'A reply that never leaves this machine.' }),
    )
    expect(answer.status).toBe(200)
    expect(bodyOf<ReviewComment>(answer).body).toBe('A reply that never leaves this machine.')
  })

  test('resolving the thread flips it, and the flip is readable', async () => {
    const answer = await call(
      daemon.base,
      `/api/pulls/${localId}/threads/${encodeURIComponent(threadId)}/resolve`,
      sending('POST', { resolved: true }),
    )
    expect(answer.status).toBe(200)
    expect(bodyOf<ReviewThread>(answer).isResolved).toBe(true)

    const snapshot = await call(daemon.base, `/api/pulls/${localId}/snapshot`)
    const threads = bodyOf<Snapshot>(snapshot).mutable.threads
    expect(threads.find((thread) => thread.id === threadId)?.isResolved).toBe(true)
  })
})

describe('an amended head is a 200 head_moved, never an error status', () => {
  test('submitting against the pre-amend head reports the move as a value', async () => {
    // An amend rewrites the head commit in place. There is no pull request to
    // raise an event about it and nothing polls the branch, so the head guard is
    // the only thing between a reviewer and a submit against a commit that no
    // longer exists — which is why this case stays live locally.
    await git(fixture.dir, fixture.env, ['checkout', '-q', fixture.headBranch])
    await git(fixture.dir, fixture.env, [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--amend',
      '--no-edit',
    ])
    const amended = (await git(fixture.dir, fixture.env, ['rev-parse', 'HEAD'])).trim()
    expect(amended).not.toBe(syncedHeadSha)

    const now = new Date().toISOString()
    const draft: ReviewDraft = {
      humanId: SESSION_HUMAN_ID,
      prNumber: localId,
      headSha: syncedHeadSha,
      compareKey: syncedCompareKey,
      body: 'Written against the head that was just amended away.',
      event: 'COMMENT',
      comments: [],
      createdAt: now,
      updatedAt: now,
    }
    const saved = await call(daemon.base, `/api/pulls/${localId}/draft`, sending('PUT', draft))
    expect(saved.status).toBe(200)

    const submitted = await call(
      daemon.base,
      `/api/pulls/${localId}/review`,
      sending('POST', {
        prNumber: localId,
        expectedHeadSha: syncedHeadSha,
        event: 'COMMENT',
        body: draft.body,
        comments: [],
      }),
    )
    expect(submitted.status).toBe(200)
    const result = bodyOf<SubmitResult>(submitted)
    expect(result.status).toBe('head_moved')
    expect(result.status === 'head_moved' ? result.currentHeadSha : '').toBe(amended)

    // Refused, so nothing was consumed: the draft is exactly where it was.
    const kept = await call(daemon.base, `/api/pulls/${localId}/draft`)
    expect(bodyOf<ReviewDraft | null>(kept)?.body).toBe(draft.body)
  }, 60_000)
})

// ————————————————————————————————————————————————————————————————————————————
// Discovery: the repository is found, never assumed to be the working directory.
// ————————————————————————————————————————————————————————————————————————————

describe('the repository is discovered from wherever the daemon was started', () => {
  let discovery: FixtureRepo
  let discoveryDist: string

  beforeAll(async () => {
    discovery = await createFixtureRepo()
    cleanups.push(() => {
      discovery.dispose()
    })
    await giveIdentity(discovery)
    discoveryDist = trackedStubDist()
  }, 120_000)

  /**
   * Create and sync a review from a daemon started in `cwd`, and hand back the
   * summary. The whole flow runs, because a review recorded under the right
   * identity but synced in the wrong directory is still wrong.
   */
  async function reviewFrom(
    cwd: string,
    headRef: string,
  ): Promise<{ summary: LocalReviewSummary; snapshot: Snapshot }> {
    const dir = trackedTempDir('revu-local-serve-data-')
    const started = tracked(
      await startLocalDaemon({ cwd, dataDir: dir, distDir: discoveryDist }),
    )
    const created = await call(
      started.base,
      '/api/local-reviews',
      sending('POST', { baseRef: discovery.baseBranch, headRef }),
    )
    expect(created.status).toBe(200)
    const summary = bodyOf<LocalReviewSummary>(created)

    const synced = await call(started.base, `/api/pulls/${summary.id}/sync`, sending('POST'))
    expect(synced.status).toBe(200)
    const snapshot = bodyOf<Snapshot>(synced)

    const now = new Date().toISOString()
    const draft: ReviewDraft = {
      humanId: SESSION_HUMAN_ID,
      prNumber: summary.id,
      headSha: snapshot.immutable.headSha,
      compareKey: snapshot.immutable.compareKey,
      body: `A draft written from ${cwd}.`,
      event: 'COMMENT',
      comments: [],
      createdAt: now,
      updatedAt: now,
    }
    const saved = await call(
      started.base,
      `/api/pulls/${summary.id}/draft`,
      sending('PUT', draft),
    )
    expect(saved.status).toBe(200)
    const read = await call(started.base, `/api/pulls/${summary.id}/draft`)
    expect(bodyOf<ReviewDraft | null>(read)?.body).toBe(draft.body)

    await stopDaemon(started)
    return { summary, snapshot }
  }

  test('started in a subdirectory, the review is recorded under the toplevel', async () => {
    const subdirectory = join(discovery.dir, 'src')
    const { summary, snapshot } = await reviewFrom(subdirectory, discovery.headBranch)

    // The claim, and the only assertion that fails when the daemon threads its
    // own working directory through instead of discovering the repository: the
    // identity is the toplevel, and the toplevel is not where it started.
    expect(summary.repo).toBe(discovery.dir)
    expect(summary.repo).not.toBe(subdirectory)
    // And the git the sync ran was the repository's, not the subdirectory's.
    expect(snapshot.immutable.headSha).toBe(discovery.headSha)
  }, 120_000)

  test('started in a linked worktree, the review is recorded under that worktree', async () => {
    const linked = join(trackedTempDir('revu-local-serve-worktree-'), 'linked')
    await git(discovery.dir, discovery.env, [
      'worktree',
      'add',
      '-b',
      'worktree/head',
      linked,
      discovery.headBranch,
    ])
    cleanups.push(async () => {
      await git(discovery.dir, discovery.env, ['worktree', 'remove', '--force', linked]).catch(
        () => {
          // The fixture directory may already be gone; nothing to detach from.
        },
      )
    })
    const resolvedLinked = realpathSync(linked)

    const { summary, snapshot } = await reviewFrom(join(linked, 'src'), 'worktree/head')

    // A linked worktree IS the repository the daemon sits in: its toplevel is
    // the worktree path, not the directory the worktree was created from.
    expect(summary.repo).toBe(resolvedLinked)
    expect(summary.repo).not.toBe(discovery.dir)
    expect(snapshot.immutable.headSha).toBe(discovery.headSha)
  }, 120_000)
})

// ————————————————————————————————————————————————————————————————————————————
// The discriminator, asserted over everything above.
// ————————————————————————————————————————————————————————————————————————————

describe('nothing in this suite reported a broker outage', () => {
  test('no answer anywhere carried broker_unreachable', () => {
    // `broker_unreachable` is the code every real network failure maps to, and
    // this deployment has no network to fail. Its absence across every answer
    // above is what separates "answered honestly with no GitHub configured"
    // from "tried GitHub and failed" — the two are otherwise indistinguishable
    // from the outside, and only one of them is the feature.
    expect(brokerOutageAnswers).toEqual([])
  })
})

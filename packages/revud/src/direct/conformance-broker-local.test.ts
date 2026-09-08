/**
 * Contract-conformance for the whole local-review loop — create, sync, draft,
 * submit, reply, resolve, react, restart, archive, delete — on the BROKER
 * assembly, driven against a real store on disk, the real local-review surface,
 * the real hardened git seam and a seeded repository. The assertions themselves
 * live in `@revu/shared/conformance` and are run identically against the
 * in-process mock, the daemon over HTTP and the direct assembly by their own
 * runners, so every one of them is held to one bar from one source of truth.
 *
 * ## Why the api under test is assembled by the BOOT assembler
 *
 * Every api here comes out of `createBootApi`, never out of `createDirectApi`,
 * and that substitution is the whole reason this runner exists beside the
 * direct one. Reviews of local branch pairs are a capability that rides inside
 * a mode rather than a mode of its own, so the thing that has to be true is
 * that EVERY boot assembles the surface — and while each boot wired it for
 * itself, one of them did not: a broker daemon answered a typed `not_found` for
 * every id in the reserved local band while a direct daemon over the same
 * workspace served the whole loop. A suite that assembled its own adapter
 * could never have caught that, because the defect was in the assembly and not
 * in anything the adapter does once assembled. So this leg builds a
 * broker-shaped context and broker-shaped parts, hands them to the shared
 * assembler, and runs the contract against whatever comes back. A future boot
 * path that forgets the local surface fails here rather than in a workspace.
 *
 * The parts are the ones broker mode genuinely brings and direct mode does not:
 * a live pull list served from a poll cache, and the stamping + journaling
 * write decorator that a deployment with a configured bot identity injects. The
 * branch-pair listing the archive check reads is deliberately NOT passed as a
 * part, so the assembler binds it from the context's own client and repository
 * — the binding is then under test too, and every question the check asks
 * carries the owner and name the assembler chose.
 *
 * ## Why this fixture repository HAS an origin remote
 *
 * Two reasons, and both would silently hollow out this file without one.
 *
 * A broker workspace is an ordinary clone. The whole premise of the mode is a
 * disposable container holding a checkout of the repository the daemon mediates,
 * so a fixture with no remote would be conformance evidence about a workspace
 * shape broker mode never has.
 *
 * And the archive half would assert nothing. `createBootApi` DISCOVERS the
 * repository identity rather than being handed one: with an origin it is the
 * `owner/name` the remote parses to, and with none it falls back to the
 * repository's toplevel path. The archive detector skips any review whose
 * identity is not `owner/name` shaped, because a path can never equal a pull
 * request's `full_name` and asking about one would spend a request guaranteed
 * to match nothing. So over a remote-less fixture the detector would return
 * before asking anything at all, the fake listing would record no question,
 * and the archive block would walk a review that could not archive for a reason
 * having nothing to do with the code under test. The remote is what makes the
 * DISCOVERED identity `acme/served`, which is why the archive block's fake pull
 * requests name that same `full_name` on both sides.
 *
 * ## The two things that keep "no network" honest
 *
 * **A `fetch` tripwire**, armed before the fixture is seeded and restored
 * afterwards, which records every attempt and throws SYNCHRONOUSLY — a rejected
 * promise could be swallowed by a caller's own error handling and surface as a
 * plausible-looking empty result, whereas a synchronous throw propagates out of
 * whatever called it. It carries a positive control, because "nothing called
 * the stub" is worthless evidence when the stub was never installed: an unarmed
 * tripwire and a clean walk are indistinguishable from the assertion's side.
 *
 * **A recording subprocess runner**, because the tripwire covers only what goes
 * through this process's `fetch`, and this fixture — unlike a remote-less one —
 * DOES have a URL a git subprocess could reach. Nothing in the walk runs `git
 * fetch`, `git push`, `git pull`, `git clone` or `git ls-remote`: every read the
 * surface makes is of the object database on this filesystem. That claim is
 * proven rather than asserted from how the code was written — the real
 * `createBunCommandRunner` is wrapped in a recorder that keeps every argv, and
 * the argv record is checked against the set of subcommands that contact a
 * remote. The check carries its own control: the predicate is shown to match a
 * synthetic `git fetch origin`, so an empty result is evidence about the walk
 * rather than about a predicate that matches nothing.
 *
 * A throwing GitHub client is injected alongside, so a GitHub touch that
 * somehow reached the client interface fails naming the method it called
 * instead of quietly returning nothing, and the token source throws too — a
 * broker daemon's credential is the one thing a local review must never need,
 * and asking for it is a breach worth failing on rather than a cost worth
 * saving.
 *
 * ## Why the store is a directory and never `:memory:`
 *
 * The durability block writes a draft, tears the implementation down and reads
 * it back through a fresh handle. An in-memory database is destroyed with the
 * connection that opened it, so a restart over one would hand back an empty
 * store and the block would assert nothing at all. Reopening the same file on
 * disk is what makes "survived a restart" a claim about persistence — and it is
 * also what gives the delete block a SECOND handle to count rows off, so
 * "every row intact" is a claim about rows rather than about what the adapter
 * under test chose to report.
 *
 * ## Why three branch pairs
 *
 * Creation is idempotent per branch pair, so three blocks sharing one pair
 * would be three blocks driving one review — and the delete block would remove
 * the review the other two are asserting about. The fixture ships exactly one
 * pair, so this file adds two more BASE branches at the base tip: each
 * alternate pair therefore resolves to the same range as the seeded one and
 * differs from it in nothing but its name. All three live in the same
 * repository and the same store, which is what the blocks are entitled to
 * share: their reviews are distinct rows under distinct ids.
 *
 * ## What this leg asserts that the direct one cannot
 *
 * The direct assembly has no write decorator, no poll cache and no bot
 * identity, so four claims are only reachable from here: that the assembled api
 * reports broker writes ENABLED (without which the claim below would be true of
 * a write path that could not have stamped anything anyway), that the local
 * walk never once consults that decorator and no body it stored carries the
 * shared-account stamp, that the served review list is the MERGE of the poll
 * cache's pull requests with this workspace's local reviews, and that the
 * repository identity the assembler discovered came from the origin remote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  GhUser,
  Human,
  PullListItem,
  PullListResponse,
  PullSummary,
  RateLimitInfo,
  Session,
} from '@revu/shared'
import { isLocalReviewId } from '@revu/shared'
import {
  runLocalReviewArchiveConformance,
  runLocalReviewConformanceSuite,
  runLocalReviewDeleteConformance,
} from '@revu/shared/conformance'
import { createBootApi } from '../index'
import type { CommandOptions, CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import type { GithubDirectContext } from './context'
import type { DirectApi, PullListSource } from './direct-api'
import type { SupersedingPullClient } from './github-client'
import { throwingGithubClient } from './github-write-stubs'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { repoIdentity, runGit } from './local-git'
import { openDirectStore, type DirectStore } from './store'
import type { TokenSource } from './token-source'
import type { WriteDecorator } from './write-decorator'
import { createBrokerWriteDecorator } from './write-decorator'

/** The repository the workspace's `origin` remote names, split as the context carries it. */
const SERVED_OWNER = 'acme'
const SERVED_NAME = 'served'

/** The identity the assembler must DISCOVER from that remote, as one string. */
const SERVED_REPO = `${SERVED_OWNER}/${SERVED_NAME}`

/**
 * The URL the fixture's `origin` points at. An https github.com URL, because
 * that is the only form repository resolution recognizes and the form a broker
 * workspace's clone carries. Nothing ever contacts it.
 */
const ORIGIN_URL = `https://github.com/${SERVED_OWNER}/${SERVED_NAME}.git`

/** A second base branch at the base tip, so the archive block reviews its own pair. */
const ARCHIVE_BASE = 'release/broker-archive-conformance'

/** A third, so the delete block's review is not one of the other blocks'. */
const DELETE_BASE = 'release/broker-delete-conformance'

/** The pull request the fake seam produces for the archive block's pair. */
const ARCHIVE_PR_NUMBER = 5150

/**
 * The number the poll cache's one pull request carries — an independent literal
 * the merged-list assertion pins, so "the list carries both halves" cannot pass
 * against a poll half that served nothing.
 */
const POLL_PR_NUMBER = 7315

/** The GitHub login a write-enabled broker deployment posts as. */
const BOT_LOGIN = 'acme-review-bot[bot]'

/** The human whose drafts, viewed marks and audit rows this session keys. */
const BROKER_HUMAN: Human = {
  id: 'h@x.io',
  name: 'H',
  role: 'contractor',
  email: 'h@x.io',
}

/**
 * A bot-identified broker session: `brokerLogin` and `viewerLogin` are the same
 * bot login, which is what a deployment that configured a write identity
 * produces. Both are set because the write-enabled shape is the one that makes
 * the "the decorator was never consulted" claim meaningful — a reads-only
 * broker has no decorator to consult in the first place.
 */
const BROKER_SESSION: Session = {
  human: BROKER_HUMAN,
  brokerLogin: BOT_LOGIN,
  workspace: 'broker-acme-served',
  viewerLogin: BOT_LOGIN,
}

/**
 * The author stamp a locally stored body must NOT carry: `**Name** (role)` at
 * the very start. It is prepended only where many humans write through one
 * shared GitHub account; a local review has exactly one author, recorded beside
 * the comment, so a stamp here would render as literal text in the body.
 */
const STAMP = /^\*\*[^*]+\*\* \(/

// ————————————————————————————————————————————————————————————————
// The network tripwire
// ————————————————————————————————————————————————————————————————

const realFetch = globalThis.fetch

/** Every request the walk attempted through `fetch`. Any entry at all is a failure. */
const attempted: { method: string; url: string }[] = []

/**
 * Replace `fetch` with a stub that records the attempt and throws
 * SYNCHRONOUSLY, so a caller's own error handling cannot turn a network reach
 * into a plausible-looking empty answer.
 */
function armFetchTripwire(): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): never => {
    const request = input instanceof Request ? input : null
    const url = request === null ? String(input) : request.url
    const method = init?.method ?? request?.method ?? 'GET'
    attempted.push({ method, url })
    throw new Error(
      `a local review reached the network: ${method} ${url} — nothing on this path may leave the workspace`,
    )
  }) as unknown as typeof fetch
}

// ————————————————————————————————————————————————————————————————
// The subprocess record — the half a wrapped `fetch` cannot see
// ————————————————————————————————————————————————————————————————

/**
 * The git subcommands that contact a remote. A repository with an `origin` URL
 * is one of these away from the network, and none of them belongs anywhere in a
 * review of two local branches: every byte the surface reads comes out of the
 * object database already on this filesystem.
 */
const NETWORK_SUBCOMMANDS: readonly string[] = [
  'clone',
  'fetch',
  'ls-remote',
  'pull',
  'push',
  'submodule',
]

/** Whether one recorded argv names a subcommand that would reach the remote. */
function namesNetworkSubcommand(argv: readonly string[]): boolean {
  return argv.some((word) => NETWORK_SUBCOMMANDS.includes(word))
}

/** A runner that keeps every argv it was handed, then really runs it. */
interface RecordingRunner extends CommandRunner {
  /** Every command spawned through this runner, in order, copied on the way in. */
  readonly argvs: string[][]
}

/**
 * Wrap the production runner so the commands the walk spawns can be read back.
 * The wrapper delegates every call, so the git under test is the real program
 * against the real repository — the record is evidence beside the work, never a
 * substitute for it.
 */
function recordingRunner(inner: CommandRunner): RecordingRunner {
  const argvs: string[][] = []
  return {
    argvs,
    run(args: string[], opts?: CommandOptions): Promise<CommandResult> {
      argvs.push([...args])
      return inner.run([...args], opts)
    },
  }
}

// ————————————————————————————————————————————————————————————————
// The pull requests the archive block's seam lists
// ————————————————————————————————————————————————————————————————

const PULL_AUTHOR: GhUser = {
  login: 'octocat',
  id: 1,
  node_id: 'U_1',
  avatar_url: '',
  html_url: '',
  type: 'User',
}

/**
 * An open pull request over the archive block's pair, as the hosted repository
 * would list it: bare branch names on both sides, the DISCOVERED identity on
 * both sides, and SHAs that match nothing — the comparison that decides an
 * archive is over repository and branch names, never over a SHA.
 */
function pullOverArchivePair(number: number): PullSummary {
  const headRef = fixture.headBranch
  return {
    id: 1000 + number,
    node_id: `PR_${number}`,
    number,
    state: 'open',
    draft: false,
    merged_at: null,
    title: `pull ${number}`,
    body: null,
    user: PULL_AUTHOR,
    labels: [],
    requested_reviewers: [],
    head: {
      ref: headRef,
      sha: 'a'.repeat(40),
      label: `${SERVED_REPO}:${headRef}`,
      repo: { full_name: SERVED_REPO, default_branch: 'main' },
    },
    base: {
      ref: ARCHIVE_BASE,
      sha: 'b'.repeat(40),
      label: `${SERVED_REPO}:${ARCHIVE_BASE}`,
      repo: { full_name: SERVED_REPO, default_branch: 'main' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }
}

/**
 * The branch-pair listing client the CONTEXT carries, with the questions it was
 * asked and the answer it gives.
 *
 * A client rather than a bound source, because the assembler is what binds it:
 * broker boot hands the archive check a listing already closed over one
 * repository, and here that binding is the thing under test — so the owner and
 * name reach this fake as arguments and are recorded beside the pair.
 */
interface RecordingPullClient extends SupersedingPullClient {
  readonly asked: { owner: string; repo: string; headRef: string; baseRef: string }[]
  pulls: PullSummary[]
}

/**
 * ONE instance, shared by every api this file assembles — the ones the blocks
 * start with and the ones their restarts return — so a question asked before a
 * restart and a question asked after it land in the same record. Nothing here
 * touches `fetch`, so the tripwire stays armed while every block runs.
 */
const supersedingPulls: RecordingPullClient = {
  asked: [],
  pulls: [],
  listOpenPullsForPair(
    owner: string,
    repo: string,
    pair: { headRef: string; baseRef: string },
  ): Promise<PullSummary[]> {
    supersedingPulls.asked.push({
      owner,
      repo,
      headRef: pair.headRef,
      baseRef: pair.baseRef,
    })
    return Promise.resolve(supersedingPulls.pulls)
  },
}

// ————————————————————————————————————————————————————————————————
// The poll cache the pull list is served from
// ————————————————————————————————————————————————————————————————

/** The ETag the fake poll cache serves. Fixed, so only the local half moves the merged one. */
const POLL_ETAG = 'W/"poll-cache-of-one-open-pull"'

/** The allowance the poll half reports, as a live GitHub-backed list would. */
const POLL_RATE_LIMIT: RateLimitInfo = {
  limit: 5000,
  remaining: 4999,
  used: 1,
  reset: '2026-01-01T01:00:00.000Z',
}

/** The one pull request the poll cache holds, as the broker's loop would serve it. */
function pollRow(): PullListItem {
  return {
    pull: {
      id: POLL_PR_NUMBER,
      node_id: `PR_${POLL_PR_NUMBER}`,
      number: POLL_PR_NUMBER,
      state: 'open',
      draft: false,
      merged_at: null,
      title: 'A pull request the poll cache already holds',
      body: null,
      user: PULL_AUTHOR,
      labels: [],
      requested_reviewers: [],
      head: {
        ref: 'feature/polled',
        sha: 'c'.repeat(40),
        label: `${SERVED_REPO}:feature/polled`,
        repo: { full_name: SERVED_REPO, default_branch: 'main' },
      },
      base: {
        ref: 'main',
        sha: 'd'.repeat(40),
        label: `${SERVED_REPO}:main`,
        repo: { full_name: SERVED_REPO, default_branch: 'main' },
      },
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-04T00:00:00.000Z',
    },
    broker: {
      authorHumanId: null,
      canApprove: true,
      unresolvedThreads: 2,
      assignedReviewerHumanIds: [],
      compareKey: `${'e'.repeat(40)}...${'c'.repeat(40)}`,
      commitCount: 3,
    },
  }
}

/** The poll cache, with the conditional reads the merged list made of it. */
interface RecordingPollCache extends PullListSource {
  /** One entry per read, carrying the `If-None-Match` the list forwarded (or did not). */
  readonly reads: (string | null)[]
}

/**
 * A stand-in for the running poll loop: a fixed list, a fixed ETag, and no
 * network. Its content never moves, so every change in the merged ETag comes
 * from the local half — which is what lets the archive block's "the frozen sync
 * did not churn the list ETag" mean what it says.
 *
 * `notModified` is always false because the merged list never forwards a
 * client's ETag to this source: the client conditions on the MERGED value,
 * which this source has never issued and could only fail to match. The reads
 * are recorded so that assertion can be made rather than assumed.
 */
const pollCache: RecordingPollCache = {
  reads: [],
  listPulls(ifNoneMatch: string | null): PullListResponse {
    pollCache.reads.push(ifNoneMatch)
    return {
      items: [pollRow()],
      etag: POLL_ETAG,
      notModified: false,
      rateLimit: POLL_RATE_LIMIT,
    }
  },
}

// ————————————————————————————————————————————————————————————————
// The write decorator, and the record of whether anything reached it
// ————————————————————————————————————————————————————————————————

/** The broker decorator with a count of how often each half was consulted. */
interface RecordingWriteDecorator extends WriteDecorator {
  readonly calls: { decorateBody: number; recordWrite: number }
}

/**
 * Wrap the real broker decorator so the local walk's use of it can be counted.
 *
 * Counting rather than replacing: the wrapper delegates both halves, so a body
 * that DID reach it would come back genuinely stamped and a write that did
 * would land a genuine audit row. That is what makes the counters evidence —
 * they are attached to the decorator the api actually holds, not to a double
 * standing beside one.
 */
function recordingWriteDecorator(inner: WriteDecorator): RecordingWriteDecorator {
  const calls = { decorateBody: 0, recordWrite: 0 }
  return {
    calls,
    decorateBody(body: string): string {
      calls.decorateBody += 1
      return inner.decorateBody(body)
    },
    recordWrite(githubId: number, meta: { endpoint: string; pr: number }): void {
      calls.recordWrite += 1
      inner.recordWrite(githubId, meta)
    },
    // Carried through rather than restated: the capability belongs to the
    // decorator being wrapped, and a wrapper that declared its own could make a
    // passthrough look write-enabled.
    brokerWritesEnabled: inner.brokerWritesEnabled ?? false,
  }
}

// ————————————————————————————————————————————————————————————————
// The implementation under test
// ————————————————————————————————————————————————————————————————

/**
 * The six tables a local review has rows in, with the column each keys the
 * review by. `local_reviews` is keyed by `id` and the other five by `local_id`,
 * and both are spelled here so a count cannot quietly match nothing and report
 * a table as empty.
 */
const LOCAL_TABLES: readonly { table: string; column: string }[] = [
  { table: 'local_reviews', column: 'id' },
  { table: 'local_snapshots', column: 'local_id' },
  { table: 'local_threads', column: 'local_id' },
  { table: 'local_reviews_submitted', column: 'local_id' },
  { table: 'local_drafts', column: 'local_id' },
  { table: 'local_viewed', column: 'local_id' },
]

let fixture: FixtureRepo
let storeDir: string
let store: DirectStore
let runner: RecordingRunner
/** `git remote -v`'s output in the fixture, captured before any review exists. */
let remotesOutput = ''
/** What the boot assembler's discovery reports for the fixture: the identity, and where from. */
let discovered: { ok: boolean; identity?: string; source?: string } = { ok: false }
/** The handle the archive block's conditional list reads go through. */
let archiveHandle: DirectApi | null = null

/**
 * The audit journal the broker decorator appends through, resolved to whichever
 * store handle is open at the moment of the call.
 *
 * An indirection rather than the handle itself, because two blocks here tear
 * the store down and reopen the same file: a decorator holding the handle it
 * was built over would journal into a closed database the moment a restart had
 * run. Broker boot has the same property for the same reason — the decorator is
 * bound to the store the daemon serves, not to one connection's lifetime.
 */
const journal: Pick<DirectStore, 'appendAudit'> = {
  appendAudit(row) {
    store.appendAudit(row)
  },
}

/**
 * The stamping + journaling decorator a bot-identified broker deployment
 * injects, wrapped in the recorder that counts what reaches it. ONE instance
 * for the whole file, shared by every api assembled below, so a call made
 * through any of them lands in the same count.
 */
const writeDecorator: RecordingWriteDecorator = recordingWriteDecorator(
  createBrokerWriteDecorator(BROKER_SESSION, journal),
)

/**
 * A credential source that refuses. A review of two local branches reads a git
 * object database and writes a SQLite file; it has nothing to authenticate to,
 * so a request for the workspace's injected credential is a breach worth
 * failing loudly on rather than a cost worth quietly saving.
 */
const refusingTokenSource: TokenSource = {
  getToken: (): Promise<string> => {
    throw new Error(
      'the local-review walk asked for a GitHub credential — nothing on this path may need one',
    )
  },
}

/**
 * The api one boot serves, assembled by the SHARED boot assembler over one
 * store handle.
 *
 * The context is the broker-shaped one: the real subprocess runner (recorded),
 * the fixture as the working directory the repository is discovered FROM, a
 * bot-identified session, the repository the origin remote names, a GitHub
 * client every method of which throws, a token source that refuses, and the
 * recording branch-pair listing client. The parts are what broker mode brings
 * and direct mode does not: the poll cache the review list is merged with, and
 * the stamping + journaling write decorator a configured bot identity injects.
 *
 * Nothing here builds a local-review surface. That is the point: the surface,
 * the repository it acts on and the identity its rows are keyed under are all
 * the assembler's work, so a boot path that stopped doing it fails every block
 * below.
 */
function apiOver(handle: DirectStore): Promise<DirectApi> {
  const context: GithubDirectContext = {
    session: BROKER_SESSION,
    tokenSource: refusingTokenSource,
    runner,
    // A bare working directory nothing resolved, exactly as a boot holds it.
    cwd: fixture.dir,
    repo: { owner: SERVED_OWNER, repo: SERVED_NAME },
    github: throwingGithubClient(),
    supersedingPulls,
  }
  return createBootApi({
    context,
    store: handle,
    pullList: pollCache,
    writeDecorator,
  })
}

/** The archive block's api, rebuilt over the current store handle. */
async function archiveApiOver(handle: DirectStore): Promise<DirectApi> {
  archiveHandle = await apiOver(handle)
  return archiveHandle
}

/** The rows every local table holds for one review, read off a second handle. */
function rowsOf(reviewId: number): Record<string, number> {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const counts: Record<string, number> = {}
  for (const { table, column } of LOCAL_TABLES) {
    const row = raw
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(reviewId) as { n: number }
    counts[table] = row.n
  }
  raw.close()
  return counts
}

beforeAll(async () => {
  // Armed first: seeding the fixture and opening the store are part of the
  // no-network claim, not a preamble exempt from it.
  armFetchTripwire()
  fixture = await createFixtureRepo()
  storeDir = mkdtempSync(join(tmpdir(), 'revu-broker-local-conformance-'))
  store = openDirectStore({ dataDir: storeDir })
  runner = recordingRunner(createBunCommandRunner())

  // The alternate bases sit at the base tip, so each block's pair resolves
  // exactly as the seeded one does and differs from it only in name. Spawned
  // through the raw runner rather than the hardened seam: that seam exists to
  // keep caller-supplied values out of git's option parser on the production
  // path, and this is fixture setup with literals.
  for (const branch of [ARCHIVE_BASE, DELETE_BASE]) {
    const made = await runner.run(['git', 'branch', branch, fixture.baseSha], {
      cwd: fixture.dir,
    })
    if (!made.ok) {
      throw new Error(`could not create the fixture branch ${branch}: ${made.stderr.trim()}`)
    }
  }

  // The remote a broker workspace's clone carries, and the only reason the
  // discovered identity is `owner/name` shaped rather than a filesystem path.
  // `remote add` writes a config line; it contacts nothing.
  const added = await runner.run(['git', 'remote', 'add', 'origin', ORIGIN_URL], {
    cwd: fixture.dir,
  })
  if (!added.ok) {
    throw new Error(`could not add the fixture's origin remote: ${added.stderr.trim()}`)
  }

  const remotes = await runGit(runner, fixture.dir, { args: ['remote', '-v'] })
  if (!remotes.ok) {
    throw new Error(
      `could not read the fixture's remotes (exit ${remotes.code}): ${remotes.stderr.trim()}`,
    )
  }
  remotesOutput = remotes.stdout.trim()

  // The discovery the assembler makes for itself, made once here so the archive
  // half's precondition is asserted rather than assumed. Thrown rather than
  // merely asserted below, because every archive assertion in this file is
  // vacuous against a path-shaped identity and no later expectation could take
  // a whole block's silence back.
  const identity = await repoIdentity(runner, fixture.dir)
  discovered = identity.ok
    ? { ok: true, identity: identity.identity, source: identity.source }
    : { ok: false }
  if (!identity.ok || identity.identity !== SERVED_REPO || identity.source !== 'origin') {
    throw new Error(
      `the fixture's discovered identity is ${JSON.stringify(discovered)}, not ` +
        `${SERVED_REPO} from its origin remote; the archive check would skip every review`,
    )
  }
}, 120_000)

afterAll(() => {
  globalThis.fetch = realFetch
  // Each step runs even when an earlier one has nothing to do or throws: a
  // setup that failed before the store opened must still remove the fixture.
  try {
    if (store !== undefined) store.close()
  } finally {
    if (storeDir !== undefined) rmSync(storeDir, { recursive: true, force: true })
    if (fixture !== undefined) fixture.dispose()
  }
})

describe('the workspace is an ordinary clone whose identity comes from its remote', () => {
  test('origin names the served repository, and discovery reads the identity off it', () => {
    // The remote exists, which is the shape broker mode actually runs in — and
    // the reason the archive half of this file can assert anything at all.
    expect(remotesOutput).toContain('origin')
    expect(remotesOutput).toContain(ORIGIN_URL)

    // `origin` rather than `root`: the identity the assembler hands the local
    // surface is the one a pull request's `full_name` can equal. Read off the
    // toplevel path instead it could never match, and every archive assertion
    // below would pass by never asking.
    expect(discovered).toEqual({ ok: true, identity: SERVED_REPO, source: 'origin' })
  })
})

describe('broker local review — contract conformance', () => {
  runLocalReviewConformanceSuite({
    label: 'broker boot assembly in-process',
    makeApi: () => apiOver(store),
    humanId: BROKER_SESSION.human.id,
    pair: () => ({ baseRef: fixture.baseBranch, headRef: fixture.headBranch }),
    // The head side of the seeded modification: the base branch carries
    // `alpha / bravo / charlie` at this path and the head branch's first commit
    // rewrites the middle line, so line 2 reads `BRAVO-CHANGED` on the head
    // side and on no other side of the compare.
    anchor: () => ({ path: fixture.paths.modified, line: 2, lineText: 'BRAVO-CHANGED' }),
    // A real repository stands behind this pair, so the compare carries commits,
    // files and blobs — not the legal empty compare a store with no git objects
    // behind it produces.
    compare: 'changes',
    restart: () => {
      // The same SQLite file, reopened, and the api rebuilt through the SAME
      // assembler. Anything less — a second directory, an in-memory database,
      // an adapter assembled by hand — would leave the durability block reading
      // a store nothing was ever written to, or reading it through a surface
      // this file is not here to test.
      store.close()
      store = openDirectStore({ dataDir: storeDir })
      return apiOver(store)
    },
  })
})

describe('broker local review — archive on pull-request appearance', () => {
  runLocalReviewArchiveConformance({
    label: 'broker boot assembly in-process',
    makeApi: () => archiveApiOver(store),
    humanId: BROKER_SESSION.human.id,
    superseded: () => ({
      pair: { baseRef: ARCHIVE_BASE, headRef: fixture.headBranch },
      prNumber: ARCHIVE_PR_NUMBER,
      // The hosted repository gains a pull request over the pair. Nothing is
      // asked of the seam until the next sync, so this is the whole of it.
      appear: () => {
        supersedingPulls.pulls = [pullOverArchivePair(ARCHIVE_PR_NUMBER)]
      },
    }),
    listPulls: (etag): PullListResponse => {
      if (archiveHandle === null) throw new Error('the list handle was read before it was built')
      return archiveHandle.listPulls(etag)
    },
    restart: () => {
      // The same SQLite file, reopened — and the same seam instance, so the
      // record of what was asked spans the restart.
      store.close()
      store = openDirectStore({ dataDir: storeDir })
      return archiveApiOver(store)
    },
  })
})

describe('broker local-review delete — contract conformance', () => {
  runLocalReviewDeleteConformance({
    label: 'broker boot assembly in-process',
    makeApi: () => apiOver(store),
    humanId: BROKER_SESSION.human.id,
    // Its own pair, because a delete removes the review it is given and
    // creation is idempotent per pair: sharing one would take another block's
    // review out from under it.
    pair: () => ({ baseRef: DELETE_BASE, headRef: fixture.headBranch }),
    anchor: () => ({ path: fixture.paths.modified, line: 2, lineText: 'BRAVO-CHANGED' }),
    rowsOf,
  })
})

describe('the archive check asked the repository the assembler discovered', () => {
  test('every question named acme/served, and the archived pair was asked exactly once', () => {
    // The listing was never passed as a part, so the owner and name on every
    // question are the ones `createBootApi` bound from the context's repository.
    // A binding that took them from anywhere else shows up here.
    const repos = new Set(supersedingPulls.asked.map((q) => `${q.owner}/${q.repo}`))
    expect([...repos]).toEqual([SERVED_REPO])

    // Exactly one question about the archive block's pair, because detection
    // never runs again on a review that already carries a number — every sync
    // after the archiving one is frozen and asks nothing. Bare on both sides:
    // the store holds `refs/heads/…`, and a pull request names branches with no
    // namespace at all, so the qualification stops at the seam.
    const archivePairQuestions = supersedingPulls.asked.filter(
      (q) => q.baseRef === ARCHIVE_BASE && q.headRef === fixture.headBranch,
    )
    expect(archivePairQuestions).toHaveLength(1)

    // The control for that count: the seam is live for EVERY local review this
    // assembly serves, not only the archived one, so a lone question would be a
    // seam nobody else could reach rather than a check that ran once.
    const otherPairQuestions = supersedingPulls.asked.filter((q) => q.baseRef !== ARCHIVE_BASE)
    expect(otherPairQuestions.length).toBeGreaterThan(0)
  })
})

describe('the assembled api is a WRITE-ENABLED broker surface', () => {
  test('it reports broker writes enabled, a review list, and a GitHub repository', async () => {
    const api = await apiOver(store)

    // The independent literal the next block rests on. A disabled broker write
    // path could not have stamped anything whatever the walk did, so "nothing
    // was stamped" would be true of it for the wrong reason entirely.
    expect(api.brokerWritesEnabled).toBe(true)
    expect(api.pullListEnabled).toBe(true)
    expect(api.githubEnabled).toBe(true)
  })
})

describe('the broker write decorator was never consulted by the local walk', () => {
  test('neither half was called, no stored body is stamped — and the recorder does move', async () => {
    // Read BEFORE the control fires, so the control's own calls cannot be
    // mistaken for calls the walk made.
    expect(writeDecorator.calls).toEqual({ decorateBody: 0, recordWrite: 0 })

    // The other half of the same claim, read off what was actually stored: a
    // decorator reached by some path this counter does not cover would have
    // left the stamp in a body.
    const api = await apiOver(store)
    const bodies: string[] = []
    for (const review of api.listLocalReviews()) {
      for (const thread of api.getSnapshot(review.id)?.mutable.threads ?? []) {
        for (const comment of thread.comments) bodies.push(comment.body)
      }
    }
    // The control for "none is stamped": there ARE bodies to be stamped. The
    // walk submitted a comment and replied to it, so an empty collection would
    // mean the scan found nothing rather than that nothing was stamped.
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    expect(bodies.filter((body) => STAMP.test(body))).toEqual([])

    // The positive control for the counters. Called directly, both halves move
    // and the body really does come back stamped — so the zeros above are a
    // fact about the walk and not about a recorder nobody wired to the api.
    const stamped = writeDecorator.decorateBody('A body a mediated write would carry.')
    expect(STAMP.test(stamped)).toBe(true)
    expect(stamped).toContain(BROKER_HUMAN.name)
    writeDecorator.recordWrite(1, { endpoint: 'submitReview', pr: POLL_PR_NUMBER })
    expect(writeDecorator.calls).toEqual({ decorateBody: 1, recordWrite: 1 })
  })
})

describe('the served review list is the merge of the poll cache and this workspace', () => {
  test('it carries the polled pull request and a local review, and re-reads as a 304', async () => {
    const api = await apiOver(store)
    const list = api.listPulls(null)

    expect(list.notModified).toBe(false)
    // The poll half, pinned to the number the cache itself serves. Without this
    // literal the assertion would pass against a list assembled from the local
    // half alone, which is precisely the shape a broker daemon must not serve.
    expect(list.items.map((item) => item.pull.number)).toContain(POLL_PR_NUMBER)
    // The local half, identified by the reserved band rather than by a number
    // this file minted: the ids come from a mark the store owns.
    expect(list.items.filter((item) => isLocalReviewId(item.pull.number)).length).toBeGreaterThan(0)
    // The poll half was really consulted, and unconditionally: the client's
    // ETag conditions on the merged value, which this source has never issued.
    expect(pollCache.reads.length).toBeGreaterThan(0)
    expect(pollCache.reads.every((read) => read === null)).toBe(true)
    // The allowance travels from the half that actually spent from the shared
    // bucket, rather than the unspent one a purely local list may claim.
    expect(list.rateLimit).toEqual(POLL_RATE_LIMIT)

    // The conditional re-read, against the ETag the merged list just served.
    const conditional = api.listPulls(list.etag)
    expect(conditional.notModified).toBe(true)
    expect(conditional.etag).toBe(list.etag)
    expect(conditional.items).toEqual([])

    // The control: the same call with an ETag nothing served is answered in
    // FULL, so the 304 above is a match on a live value rather than a list that
    // answers "unchanged" to everything.
    const impossible = api.listPulls('W/"an-etag-no-list-has-ever-served"')
    expect(impossible.notModified).toBe(false)
    expect(impossible.etag).toBe(list.etag)
  })
})

describe('nothing on the local path left the workspace', () => {
  test('no request was attempted — and the tripwire it rests on records and throws', () => {
    // Order matters: the walk's evidence is read BEFORE the control fires, so
    // the control's own call cannot be mistaken for one the walk made.
    expect(attempted).toEqual([])

    const probe = 'https://api.github.com/rate_limit'
    expect(() => globalThis.fetch(probe)).toThrow(/reached the network/)
    // The stub is installed and reachable, so the empty list above is evidence
    // of a walk that stayed local rather than of a tripwire nobody armed.
    expect(attempted).toEqual([{ method: 'GET', url: probe }])
    attempted.length = 0
  })

  test('no git subprocess named a subcommand that contacts the remote', () => {
    // The half a wrapped `fetch` cannot see. This repository HAS a URL to
    // reach, so "no network" on the subprocess path is a claim about the
    // commands that ran rather than about a remote that does not exist.
    expect(runner.argvs.filter(namesNetworkSubcommand)).toEqual([])

    // Two controls, because the line above is satisfied by an empty record and
    // by a predicate that matches nothing alike. The recorder saw real work:
    // the walk drove git many times over. And the predicate does fire on a
    // command that would reach the remote.
    expect(runner.argvs.length).toBeGreaterThan(0)
    expect(runner.argvs.some((argv) => argv[0] === 'git')).toBe(true)
    expect(namesNetworkSubcommand(['git', 'fetch', 'origin'])).toBe(true)
  })
})

/**
 * Contract-conformance for the whole local-review loop — create, sync, draft,
 * submit, reply, resolve, react, restart — and for what happens once a pull
 * request covers the reviewed pair, on the DIRECT transport, driven against the
 * real adapter (`createDirectApi`), the real local-review surface, the real
 * hardened git seam and a real store on disk, over a seeded repository. The
 * assertions themselves live in `@revu/shared/conformance` and are run
 * identically against the in-process mock by its own runner, so both are held
 * to one bar from one source of truth.
 *
 * ## Why this suite is never credential-gated
 *
 * A review of a branch pair with no pull request behind it needs no token, no
 * origin remote and no network: everything it reads comes out of a git object
 * database on this filesystem and everything it writes goes into a SQLite file
 * beside it. So this runs unconditionally in the ordinary test gate, and it
 * must never be attached to the suites that skip themselves when no GitHub
 * credential is present — a local review's conformance would then be evidence
 * only on machines that happen to be logged in, which is exactly backwards.
 * Every assertion below is reachable on a laptop with no network at all.
 *
 * ## The two things that keep "no network" honest
 *
 * **A `fetch` tripwire**, armed before the fixture is seeded and restored
 * afterwards, which records every attempt and throws synchronously — a
 * rejected promise could be swallowed by a caller's own error handling and
 * surface as a plausible-looking empty result, whereas a synchronous throw
 * propagates out of whatever called it. It carries a positive control, because
 * "nothing called the stub" is worthless evidence when the stub was never
 * installed: an unarmed tripwire and a clean walk are indistinguishable from
 * the assertion's side.
 *
 * **A zero-remotes precondition**, because the tripwire covers only what goes
 * through this process's `fetch`. A `git fetch` is a subprocess with its own
 * network stack and its own credential helpers; no wrapper installed here can
 * see it. What stands between this suite and the network on that path is the
 * repository having no remote to reach in the first place, so that is asserted
 * against the fixture rather than assumed from how it was built.
 *
 * A throwing GitHub client is injected alongside, so a GitHub touch that
 * somehow reached the client interface fails naming the method it called
 * instead of quietly returning nothing. It is injected without a repository:
 * the two are documented as present together or absent together, the api
 * reports `githubEnabled` false unless both arrive, and every local id is
 * dispatched to the local surface before the client is ever read — so the
 * client here is inert by construction and exists only to name a breach.
 *
 * ## Why the store is a directory and never `:memory:`
 *
 * The durability block writes a draft, tears the implementation down and reads
 * it back through a fresh handle. An in-memory database is destroyed with the
 * connection that opened it, so a restart over one would hand back an empty
 * store and the block would assert nothing at all — it would pass by finding
 * whatever a second, unrelated database happened to contain. Reopening the
 * same file on disk is what makes "survived a restart" a claim about
 * persistence.
 *
 * ## How the archive block gets a pull request without a network
 *
 * This engine learns about pull requests through ONE seam — a listing of the
 * open pull requests for a single branch pair — and that seam is optional, so
 * the archive block is served by a fake the file controls. It records every
 * question it is asked and answers from a list a `appear` hook fills in, and it
 * touches no `fetch`, so the tripwire above stays armed across the whole of it.
 * The api the block drives is assembled WITH that seam; the api the suite above
 * drives is assembled without one, so that suite's review can never archive and
 * the seam records only the archive block's questions.
 *
 * The archive block also needs a pair of its own: creation is idempotent per
 * pair, so sharing the seeded pair would hand it the suite's already-synced
 * review. The fixture ships exactly one pair, so this file adds a second BASE
 * branch at the base tip — the alternate pair therefore resolves to the same
 * range as the seeded one and differs from it in nothing but its name. Both
 * pairs live in the same repository and the same store, which is what the two
 * blocks are entitled to share: their reviews are distinct rows under distinct
 * ids.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhUser, PullListResponse, PullSummary } from '@revu/shared'
import {
  runLocalReviewArchiveConformance,
  runLocalReviewConformanceSuite,
} from '@revu/shared/conformance'
import type { CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { CONFORMANCE_SESSION } from './conformance-fakes'
import { createDirectApi, type DirectApi } from './direct-api'
import { throwingGithubClient } from './github-write-stubs'
import type { SupersedingPullSource } from './local-archive'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { runGit } from './local-git'
import { createLocalReviewSurface } from './local-surface'
import { openDirectStore, type DirectStore } from './store'

/** The repository identity these reviews are scoped to. */
const SERVED_REPO = 'acme/served'

/** A second base branch at the base tip, so the archive block reviews its own pair. */
const ARCHIVE_BASE = 'release/archive-conformance'

/** The pull request the fake seam produces for that pair. */
const ARCHIVE_PR_NUMBER = 4242

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
 * An open pull request over the alternate pair, as the hosted repository would
 * list it: bare branch names on both sides, this repository on both sides, and
 * SHAs that match nothing — the comparison that decides an archive is over
 * repository and branch names, never over a SHA.
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

/** The listing seam, with the questions it was asked and the answer it gives. */
interface RecordingPullSource extends SupersedingPullSource {
  readonly asked: { headRef: string; baseRef: string }[]
  pulls: PullSummary[]
}

/**
 * ONE instance, shared by every api the archive block is handed — the one it
 * starts with and the one its restart returns — so a question asked before the
 * restart and a question asked after it land in the same record. Nothing here
 * touches `fetch`, so the tripwire stays armed while the block runs.
 */
const supersedingPulls: RecordingPullSource = {
  asked: [],
  pulls: [],
  listOpenPullsForPair(pair: { headRef: string; baseRef: string }): Promise<PullSummary[]> {
    supersedingPulls.asked.push({ headRef: pair.headRef, baseRef: pair.baseRef })
    return Promise.resolve(supersedingPulls.pulls)
  },
}

// ————————————————————————————————————————————————————————————————
// The implementation under test
// ————————————————————————————————————————————————————————————————

let fixture: FixtureRepo
let storeDir: string
let store: DirectStore
let runner: CommandRunner
/** `git remote`'s output in the fixture, captured before any review exists. */
let remotesOutput = ''
/** The handle the archive block's conditional list reads go through. */
let archiveHandle: DirectApi | null = null

/**
 * The direct api over one store handle: the real local surface, the real git
 * seam, the fixture as the repository, and a GitHub client every method of
 * which throws.
 *
 * The listing seam is passed through rather than wired here, because it is what
 * separates the two blocks this file runs: the suite over the seeded pair is
 * assembled WITHOUT one, so nothing can archive its review, and the archive
 * block is assembled with one.
 */
function apiOver(
  handle: DirectStore,
  extra: { supersedingPulls?: SupersedingPullSource } = {},
): DirectApi {
  const localReviews = createLocalReviewSurface({
    store: handle,
    runner,
    toplevel: fixture.dir,
    repo: SERVED_REPO,
    session: CONFORMANCE_SESSION,
  })
  return createDirectApi({
    session: CONFORMANCE_SESSION,
    store: handle,
    runner,
    cwd: fixture.dir,
    localReviews,
    github: throwingGithubClient(),
    ...(extra.supersedingPulls === undefined
      ? {}
      : { supersedingPulls: extra.supersedingPulls }),
  })
}

/** The archive block's api, rebuilt over the current store handle. */
function archiveApiOver(handle: DirectStore): DirectApi {
  archiveHandle = apiOver(handle, { supersedingPulls })
  return archiveHandle
}

beforeAll(async () => {
  // Armed first: seeding the fixture and opening the store are part of the
  // no-network claim, not a preamble exempt from it.
  armFetchTripwire()
  fixture = await createFixtureRepo()
  storeDir = mkdtempSync(join(tmpdir(), 'revu-local-conformance-'))
  store = openDirectStore({ dataDir: storeDir })
  runner = createBunCommandRunner()

  // The alternate base sits at the base tip, so the archive block's pair
  // resolves exactly as the seeded one does and differs from it only in name.
  // Spawned through the raw runner rather than the hardened seam: that seam
  // exists to keep caller-supplied values out of git's option parser on the
  // production path, and this is fixture setup with two literals.
  const made = await runner.run(['git', 'branch', ARCHIVE_BASE, fixture.baseSha], {
    cwd: fixture.dir,
  })
  if (!made.ok) {
    throw new Error(`could not create the fixture branch ${ARCHIVE_BASE}: ${made.stderr.trim()}`)
  }

  const remotes = await runGit(runner, fixture.dir, { args: ['remote'] })
  if (!remotes.ok) {
    throw new Error(
      `could not read the fixture's remotes (exit ${remotes.code}): ${remotes.stderr.trim()}`,
    )
  }
  remotesOutput = remotes.stdout.trim()
  // Thrown rather than merely asserted below, because a fixture with a remote
  // would give the git subprocesses a URL to reach and no assertion made after
  // the walk could take that back.
  if (remotesOutput !== '') {
    throw new Error(
      `the fixture repository has remotes (${remotesOutput}); a local review must have nowhere to reach`,
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

describe('the repository under review has nowhere to reach', () => {
  test('git reports no remotes at all', () => {
    // The half of "no network" a wrapped `fetch` cannot see: git runs as a
    // subprocess, so having no URL configured is the only thing standing
    // between this suite and the network on that path.
    expect(remotesOutput).toBe('')
  })
})

describe('direct local review — contract conformance', () => {
  runLocalReviewConformanceSuite({
    label: 'direct engine in-process',
    makeApi: () => apiOver(store),
    humanId: CONFORMANCE_SESSION.human.id,
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
      // The same SQLite file, reopened. Anything less — a second directory, an
      // in-memory database — would leave the durability block reading a store
      // nothing was ever written to.
      store.close()
      store = openDirectStore({ dataDir: storeDir })
      return apiOver(store)
    },
  })
})

describe('direct local review — archive on pull-request appearance', () => {
  runLocalReviewArchiveConformance({
    label: 'direct engine in-process',
    makeApi: () => archiveApiOver(store),
    humanId: CONFORMANCE_SESSION.human.id,
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

describe('the archive check asked the hosted repository exactly one question', () => {
  test('it named the bare branch pair, once, and nothing re-asked after the archive', () => {
    // Bare on both sides: the store holds `refs/heads/…`, and a pull request
    // names branches with no namespace at all, so the qualification stops at
    // the seam. Exactly one question, because detection never runs again on a
    // review that already carries a number — every sync after the archiving
    // one is frozen and asks nothing.
    expect(supersedingPulls.asked).toEqual([
      { headRef: fixture.headBranch, baseRef: ARCHIVE_BASE },
    ])
  })
})

describe('nothing on the local path left the workspace', () => {
  test('the walk attempted no request — and the tripwire it rests on records and throws', () => {
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
})

/**
 * Seed a scratch GitHub repository with fixture pull requests that mirror the
 * hard cases a PR-review client must survive: a clean small change, a large
 * change (many files, a lockfile, a binary, a rename), a mid-review PR with a
 * mix of resolved and outdated review threads, a PR whose base branch advances
 * after opening (moving the merge base), and a PR whose head is force-pushed
 * after a line comment is left (making the comment drift or become lost).
 *
 * The script is idempotent: every fixture lives on a stable, prefixed head
 * branch and carries a title marker, so re-running detects the existing PR,
 * resets the branch to the intended tree, force-pushes, and reopens if closed.
 * A second run therefore converges to the same PR numbers and end state rather
 * than creating duplicates.
 *
 * It seeds as the authenticated `gh` user (direct mode): it shells out to `gh`
 * (REST + GraphQL) and plain `git`, and never handles a token itself.
 *
 * Usage:
 *   bun run scripts/seed-scratch.ts
 *   bun run scripts/seed-scratch.ts --repo owner/name --workspace /path/to/clone
 *
 * A hard guard refuses to run against any repository whose name is not on the
 * built-in allowlist of intended scratch targets, so it can never mutate a real
 * repository by accident.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ——————————————————————————————————————————————————————————————
// Configuration & the scratch-target guard
// ——————————————————————————————————————————————————————————————

const DEFAULT_REPO = 'pat-mw/revu-sandbox'

/**
 * Repositories this script is permitted to mutate. Membership here is the only
 * thing that unlocks a run; a repo not listed aborts before any network call.
 * Every entry must be an obvious throwaway (name contains a scratch marker).
 */
const ALLOWED_SCRATCH_REPOS = new Set<string>([DEFAULT_REPO, 'apoha-pat/revu-sandbox'])

/** Substrings that mark a repository name as an intended scratch target. */
const SCRATCH_MARKERS = ['sandbox', 'scratch', 'fixture']

/** All fixture branches share this prefix so they are easy to detect and reset. */
const BRANCH_PREFIX = 'fixture/'

/** Every fixture PR title starts with this marker for a second detection axis. */
const TITLE_MARKER = '[fixture]'

const DEFAULT_BRANCH = 'main'

function parseArgs(argv: string[]): { repo: string; workspace: string | null } {
  let repo = process.env.SEED_REPO ?? DEFAULT_REPO
  let workspace = process.env.SEED_WORKSPACE ?? null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repo' || arg === '-r') repo = argv[++i] ?? repo
    else if (arg?.startsWith('--repo=')) repo = arg.slice('--repo='.length)
    else if (arg === '--workspace' || arg === '-w') workspace = argv[++i] ?? workspace
    else if (arg?.startsWith('--workspace=')) workspace = arg.slice('--workspace='.length)
  }
  return { repo, workspace }
}

function assertScratchTarget(repo: string): void {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    fail(`--repo must be "owner/name"; got ${JSON.stringify(repo)}`)
  }
  const name = repo.split('/')[1]!.toLowerCase()
  const marked = SCRATCH_MARKERS.some((m) => name.includes(m))
  if (!ALLOWED_SCRATCH_REPOS.has(repo) || !marked) {
    fail(
      `refusing to seed ${repo}: not an allowed scratch target.\n` +
        `  Allowed: ${[...ALLOWED_SCRATCH_REPOS].join(', ')}\n` +
        `  A target must be on the allowlist AND its name must contain one of: ${SCRATCH_MARKERS.join(', ')}.\n` +
        `  This guard exists so the seeder can never mutate a real repository.`,
    )
  }
}

// ——————————————————————————————————————————————————————————————
// Small process helpers (git / gh), with loud failures
// ——————————————————————————————————————————————————————————————

function fail(message: string): never {
  console.error(`\nseed-scratch: ${message}`)
  process.exit(1)
}

interface RunOptions {
  cwd?: string
  input?: string
  /** When true, a non-zero exit returns the result instead of aborting. */
  allowFailure?: boolean
  /** Suppress echoing the command (used for anything that could surface a secret). */
  quiet?: boolean
  /** Environment override for the child (merged by the caller). */
  env?: NodeJS.ProcessEnv
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  if (!opts.quiet) {
    console.log(`  $ ${cmd} ${args.join(' ')}`)
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const result: RunResult = {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
  if (result.status !== 0 && !opts.allowFailure) {
    fail(
      `command failed (exit ${result.status}): ${cmd} ${args.join(' ')}\n` +
        `${result.stderr || result.stdout}`.trim(),
    )
  }
  return result
}

const git = (repoDir: string, args: string[], opts: RunOptions = {}): RunResult =>
  run('git', ['-C', repoDir, ...args], opts)

const gh = (args: string[], opts: RunOptions = {}): RunResult => run('gh', args, opts)

/** Call the GitHub REST/GraphQL API and parse the JSON body. */
function ghJson<T>(args: string[], opts: RunOptions = {}): T {
  const res = gh(args, opts)
  return JSON.parse(res.stdout || 'null') as T
}

// ——————————————————————————————————————————————————————————————
// Deterministic fixture assets
// ——————————————————————————————————————————————————————————————

/**
 * A tiny valid PNG (1x1 transparent pixel), emitted from a fixed byte sequence
 * so the binary blob is byte-identical on every run. Kept a few hundred bytes.
 */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function writePng(path: string): void {
  writeFileSync(path, Buffer.from(PNG_1PX_BASE64, 'base64'))
}

/** A lockfile-shaped text blob; big-ish but deterministic. */
function lockfileContents(): string {
  const lines = ['# This file is generated. Edit the manifest instead.', 'lockfileVersion: 1', '']
  const pkgs = [
    'ansi-regex@6.0.1',
    'chalk@5.3.0',
    'commander@12.1.0',
    'debug@4.3.7',
    'kleur@4.1.5',
    'mri@1.2.0',
    'picocolors@1.1.0',
    'semver@7.6.3',
  ]
  for (const p of pkgs) {
    lines.push(`  "${p}":`)
    lines.push(`    resolution: {integrity: sha512-fixture-${p.replace(/[@.]/g, '-')}}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ——————————————————————————————————————————————————————————————
// Branch / PR convergence helpers
// ——————————————————————————————————————————————————————————————

interface Ctx {
  repo: string
  dir: string
}

interface FileSpec {
  path: string
  /** UTF-8 text content, or null when `binary` is set. */
  content?: string
  /** When true, write the fixed fixture PNG bytes at `path`. */
  binary?: boolean
}

/** Overwrite the working tree so only the listed files exist under `base` dirs we manage. */
function writeFiles(dir: string, files: FileSpec[]): void {
  for (const f of files) {
    const full = join(dir, f.path)
    mkdirSync(join(full, '..'), { recursive: true })
    if (f.binary) writePng(full)
    else writeFileSync(full, f.content ?? '')
  }
}

/** Hard-reset the working tree to `startRef`, then apply `files` and commit. */
function resetBranchTo(
  ctx: Ctx,
  branch: string,
  startRef: string,
  files: FileSpec[],
  commitMessage: string,
): void {
  git(ctx.dir, ['checkout', '-B', branch, startRef])
  git(ctx.dir, ['rm', '-rf', '--quiet', '.'], { allowFailure: true })
  // Restore the base tree, then layer the fixture files on top.
  git(ctx.dir, ['checkout', startRef, '--', '.'])
  writeFiles(ctx.dir, files)
  git(ctx.dir, ['add', '-A'])
  commit(ctx, commitMessage)
}

/**
 * Commit with an explicit, deterministic identity AND a fixed author/committer
 * date, so a commit with identical content and message produces an identical
 * SHA on every run. Stable SHAs keep re-runs from churning branch tips.
 */
const FIXED_COMMIT_DATE = '2020-01-01T00:00:00Z'

function commit(ctx: Ctx, message: string): void {
  git(
    ctx.dir,
    [
      '-c',
      'user.name=revu-seed',
      '-c',
      'user.email=seed@revu.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '--date',
      FIXED_COMMIT_DATE,
      '-m',
      message,
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXED_COMMIT_DATE,
        GIT_COMMITTER_DATE: FIXED_COMMIT_DATE,
      },
    },
  )
}

function currentSha(ctx: Ctx, ref = 'HEAD'): string {
  return git(ctx.dir, ['rev-parse', ref]).stdout.trim()
}

function pushForce(ctx: Ctx, branch: string): void {
  git(ctx.dir, ['push', '--force', 'origin', `${branch}:${branch}`])
}

/** Find an open-or-closed fixture PR by its head branch; returns null if none. */
interface PrInfo {
  number: number
  state: string
  url: string
  headRefName: string
  headSha: string
  baseRefName: string
}

function findPr(ctx: Ctx, branch: string): PrInfo | null {
  const items = ghJson<
    Array<{
      number: number
      state: string
      url: string
      headRefName: string
      headRefOid: string
      baseRefName: string
    }>
  >([
    'pr',
    'list',
    '-R',
    ctx.repo,
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,state,url,headRefName,headRefOid,baseRefName',
  ])
  if (!items.length) return null
  const it = items[0]!
  return {
    number: it.number,
    state: it.state,
    url: it.url,
    headRefName: it.headRefName,
    headSha: it.headRefOid,
    baseRefName: it.baseRefName,
  }
}

/** Ensure a PR exists for `branch`; create it if absent, reopen it if closed. */
function ensurePr(
  ctx: Ctx,
  opts: { branch: string; base: string; title: string; body: string },
): PrInfo {
  const existing = findPr(ctx, opts.branch)
  if (!existing) {
    gh([
      'pr',
      'create',
      '-R',
      ctx.repo,
      '--head',
      opts.branch,
      '--base',
      opts.base,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ])
  } else {
    if (existing.state === 'CLOSED') {
      gh(['pr', 'reopen', '-R', ctx.repo, String(existing.number)])
    }
    // Converge title/body/base in case a prior definition differed.
    gh([
      'pr',
      'edit',
      '-R',
      ctx.repo,
      String(existing.number),
      '--title',
      opts.title,
      '--body',
      opts.body,
      '--base',
      opts.base,
    ])
  }
  const info = findPr(ctx, opts.branch)
  if (!info) fail(`could not locate PR for branch ${opts.branch} after ensurePr`)
  return info
}

// ——————————————————————————————————————————————————————————————
// Review-thread helpers (REST for comments, GraphQL for resolve)
// ——————————————————————————————————————————————————————————————

interface ReviewComment {
  id: number
  path: string
  line: number | null
  original_line: number | null
  position: number | null
  body: string
  commit_id: string
}

function listReviewComments(ctx: Ctx, prNumber: number): ReviewComment[] {
  return ghJson<ReviewComment[]>([
    'api',
    '--paginate',
    `repos/${ctx.repo}/pulls/${prNumber}/comments`,
  ])
}

/**
 * Create a single inline review comment anchored to `line` in `path` at the
 * given `commitSha`. Uses the modern line/side anchor (not the legacy diff
 * position), which is what a review client persists and later reconciles.
 */
function createReviewComment(
  ctx: Ctx,
  prNumber: number,
  args: { commitSha: string; path: string; line: number; body: string },
): ReviewComment {
  return ghJson<ReviewComment>([
    'api',
    '-X',
    'POST',
    `repos/${ctx.repo}/pulls/${prNumber}/comments`,
    '-f',
    `body=${args.body}`,
    '-f',
    `commit_id=${args.commitSha}`,
    '-f',
    `path=${args.path}`,
    '-F',
    `line=${args.line}`,
    '-f',
    'side=RIGHT',
  ])
}

interface ReviewThreadNode {
  id: string
  isResolved: boolean
  isOutdated: boolean
  comments: { nodes: Array<{ databaseId: number; body: string }> }
}

/** Fetch review threads (GraphQL) so we can see resolved/outdated state + node ids. */
function listReviewThreads(ctx: Ctx, prNumber: number): ReviewThreadNode[] {
  const [owner, name] = ctx.repo.split('/')
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{ id isResolved isOutdated comments(first:20){ nodes{ databaseId body } } }
        }
      }
    }
  }`
  const data = ghJson<{
    data: {
      repository: { pullRequest: { reviewThreads: { nodes: ReviewThreadNode[] } } }
    }
  }>([
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${prNumber}`,
  ])
  return data.data.repository.pullRequest.reviewThreads.nodes
}

function resolveThread(threadId: string): void {
  const mutation = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`
  gh(['api', 'graphql', '-f', `query=${mutation}`, '-F', `id=${threadId}`])
}

/** Look up the review-comment id whose body matches, for idempotent thread reuse. */
function findCommentByBody(comments: ReviewComment[], marker: string): ReviewComment | undefined {
  return comments.find((c) => c.body.includes(marker))
}

// ——————————————————————————————————————————————————————————————
// Base project + scenarios
// ——————————————————————————————————————————————————————————————

/** Files that make up the initial fixture project on the default branch. */
function baseProjectFiles(): FileSpec[] {
  return [
    {
      path: 'README.md',
      content: [
        '# revu-sandbox',
        '',
        'A scratch repository seeded with fixture pull requests for exercising a',
        'PR-review client against real GitHub data: sync, inline comments, thread',
        'reconciliation, base advances, and force-push drift.',
        '',
        'Everything here is generated and disposable.',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: [
        'export function greet(name: string): string {',
        '  return `hello, ${name}`',
        '}',
        '',
        'export function add(a: number, b: number): number {',
        '  return a + b',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/math.ts',
      content: [
        'export function clamp(value: number, min: number, max: number): number {',
        '  if (value < min) return min',
        '  if (value > max) return max',
        '  return value',
        '}',
        '',
        'export function sum(values: number[]): number {',
        '  return values.reduce((acc, n) => acc + n, 0)',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/strings.ts',
      content: [
        'export function slugify(input: string): string {',
        "  return input.trim().toLowerCase().replace(/\\s+/g, '-')",
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'package.json',
      content:
        JSON.stringify(
          {
            name: 'revu-sandbox',
            private: true,
            version: '0.0.0',
            type: 'module',
          },
          null,
          2,
        ) + '\n',
    },
  ]
}

/**
 * Guarantee the default branch exists with the base project. The repo may start
 * completely empty (no commits, no default branch), so this bootstraps `main`
 * from an orphan commit the first time and is a no-op on later runs.
 */
function ensureBaseBranch(ctx: Ctx): string {
  const hasRemote = git(ctx.dir, ['ls-remote', '--heads', 'origin', DEFAULT_BRANCH], {
    allowFailure: true,
  }).stdout.trim()

  if (!hasRemote) {
    console.log(`\n[base] default branch ${DEFAULT_BRANCH} absent — bootstrapping`)
    git(ctx.dir, ['checkout', '--orphan', DEFAULT_BRANCH])
    git(ctx.dir, ['rm', '-rf', '--quiet', '.'], { allowFailure: true })
    writeFiles(ctx.dir, baseProjectFiles())
    git(ctx.dir, ['add', '-A'])
    commit(ctx, 'chore: seed base fixture project')
    git(ctx.dir, ['push', '-u', 'origin', `${DEFAULT_BRANCH}:${DEFAULT_BRANCH}`])
  } else {
    console.log(`\n[base] default branch ${DEFAULT_BRANCH} present — fetching`)
    git(ctx.dir, ['fetch', 'origin', DEFAULT_BRANCH])
    git(ctx.dir, ['checkout', '-B', DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`])
    // Converge the base project content so a partially-seeded base heals.
    writeFiles(ctx.dir, baseProjectFiles())
    git(ctx.dir, ['add', '-A'])
    const dirty = git(ctx.dir, ['status', '--porcelain']).stdout.trim()
    if (dirty) {
      commit(ctx, 'chore: converge base fixture project')
      git(ctx.dir, ['push', 'origin', `${DEFAULT_BRANCH}:${DEFAULT_BRANCH}`])
    }
  }
  return currentSha(ctx, DEFAULT_BRANCH)
}

interface Seeded {
  scenario: string
  number: number
  url: string
  shape: string
  /**
   * Extra scenario coordinates a live check needs. For base-advances this
   * carries the SHA of the head's FIRST commit off the fork (`h1`): an ancestor
   * of the head that a live check can fast-forward the base branch onto to move
   * the merge base under a fixed head.
   */
  detail?: Record<string, string>
}

/** Scenario: a clean, small PR with a single obvious inline-comment target. */
function seedCleanSmall(ctx: Ctx, baseSha: string): Seeded {
  const branch = `${BRANCH_PREFIX}clean-small`
  const files: FileSpec[] = [
    {
      path: 'src/strings.ts',
      content: [
        'export function slugify(input: string): string {',
        "  return input.trim().toLowerCase().replace(/\\s+/g, '-')",
        '}',
        '',
        'export function titleCase(input: string): string {',
        '  return input',
        "    .split(' ')",
        '    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))',
        "    .join(' ')",
        '}',
        '',
      ].join('\n'),
    },
  ]
  resetBranchTo(ctx, branch, baseSha, files, 'feat: add titleCase helper')
  pushForce(ctx, branch)
  const pr = ensurePr(ctx, {
    branch,
    base: DEFAULT_BRANCH,
    title: `${TITLE_MARKER} clean small PR`,
    body: 'A few changed lines in one file. The added `titleCase` function is a clear single-file inline-comment target.',
  })
  return {
    scenario: 'clean-small',
    number: pr.number,
    url: pr.url,
    shape: '1 file, small diff; single-file inline-comment target (titleCase)',
  }
}

/** Scenario: a large PR — 14+ files incl. a lockfile, a binary, and a rename. */
function seedLarge(ctx: Ctx, baseSha: string): Seeded {
  const branch = `${BRANCH_PREFIX}large`

  git(ctx.dir, ['checkout', '-B', branch, baseSha])
  git(ctx.dir, ['checkout', baseSha, '--', '.'])

  // A rename: move an existing base file to a new path (git detects the rename).
  // git mv needs the destination directory to already exist.
  mkdirSync(join(ctx.dir, 'src/text'), { recursive: true })
  git(ctx.dir, ['mv', 'src/strings.ts', 'src/text/strings.ts'])

  // Many new source modules to push the changed-file count well past 14.
  const modules: FileSpec[] = []
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, '0')
    modules.push({
      path: `src/modules/mod${n}.ts`,
      content: [
        `export const MODULE_ID = 'mod${n}'`,
        '',
        `export function feature${n}(input: number): number {`,
        `  return input * ${i} + ${i}`,
        '}',
        '',
      ].join('\n'),
    })
  }
  const extra: FileSpec[] = [
    { path: 'assets/logo.png', binary: true },
    { path: 'pnpm-lock.yaml', content: lockfileContents() },
    {
      path: 'src/text/index.ts',
      content: ["export * from './strings'", ''].join('\n'),
    },
  ]
  writeFiles(ctx.dir, [...modules, ...extra])
  git(ctx.dir, ['add', '-A'])
  commit(ctx, 'feat: large change with modules, lockfile, binary asset, and a rename')
  pushForce(ctx, branch)

  const pr = ensurePr(ctx, {
    branch,
    base: DEFAULT_BRANCH,
    title: `${TITLE_MARKER} large PR (many files + binary + rename)`,
    body: 'Exercises the cold-sync request budget and binary/rename handling: 12 new modules, a lockfile-style file, a binary PNG, and a rename of src/strings.ts.',
  })

  // Report the true changed-file count from the compare endpoint.
  const cmp = ghJson<{ files: unknown[] }>([
    'api',
    `repos/${ctx.repo}/compare/${DEFAULT_BRANCH}...${branch}`,
    '--jq',
    '{files: .files}',
  ])
  const fileCount = cmp.files.length
  return {
    scenario: 'large',
    number: pr.number,
    url: pr.url,
    shape: `${fileCount} changed files incl. binary (assets/logo.png), lockfile (pnpm-lock.yaml), rename (src/strings.ts -> src/text/strings.ts)`,
  }
}

/**
 * Scenario: a mid-review PR carrying review threads where some are resolved and
 * some are outdated. Built by (1) committing a file, (2) commenting on a line at
 * that commit, (3) pushing a follow-up commit that rewrites the commented lines
 * so the thread goes outdated, (4) leaving a second comment that stays current,
 * and (5) resolving one thread via the GraphQL resolveReviewThread mutation.
 */
function seedMidReview(ctx: Ctx, baseSha: string): Seeded {
  const branch = `${BRANCH_PREFIX}mid-review`
  const outdatedMarker = 'FIXTURE-THREAD-outdated'
  const resolvedMarker = 'FIXTURE-THREAD-resolved'

  // First commit: a file whose early lines we will comment on, then rewrite.
  const v1: FileSpec[] = [
    {
      path: 'src/review-target.ts',
      content: [
        'export function computeScore(values: number[]): number {',
        '  let total = 0',
        '  for (const v of values) {',
        '    total += v',
        '  }',
        '  return total',
        '}',
        '',
        'export function average(values: number[]): number {',
        '  return computeScore(values) / values.length',
        '}',
        '',
      ].join('\n'),
    },
  ]
  resetBranchTo(ctx, branch, baseSha, v1, 'feat: add scoring helpers for review')
  pushForce(ctx, branch)
  const firstSha = currentSha(ctx, branch)

  const pr = ensurePr(ctx, {
    branch,
    base: DEFAULT_BRANCH,
    title: `${TITLE_MARKER} mid-review PR (resolved + outdated threads)`,
    body: 'Has review threads in mixed states: one resolved, one outdated after a follow-up commit rewrote the commented lines.',
  })

  // Reuse existing review comments if a prior run already created them.
  let comments = listReviewComments(ctx, pr.number)

  // Comment #1: on a line we will rewrite in the next commit -> becomes outdated.
  if (!findCommentByBody(comments, outdatedMarker)) {
    createReviewComment(ctx, pr.number, {
      commitSha: firstSha,
      path: 'src/review-target.ts',
      line: 4, // `total += v`
      body: `${outdatedMarker}: this manual loop can be replaced with reduce.`,
    })
  }
  // Comment #2: on a stable line we will not touch -> stays current, gets resolved.
  if (!findCommentByBody(comments, resolvedMarker)) {
    createReviewComment(ctx, pr.number, {
      commitSha: firstSha,
      path: 'src/review-target.ts',
      line: 10, // `return computeScore(values) / values.length`
      body: `${resolvedMarker}: guard against divide-by-zero when values is empty.`,
    })
  }

  // Second commit: rewrite the body so comment #1's anchored lines are gone,
  // pushing that thread to outdated. The averaging line is left intact.
  const v2: FileSpec[] = [
    {
      path: 'src/review-target.ts',
      content: [
        'export function computeScore(values: number[]): number {',
        '  return values.reduce((total, v) => total + v, 0)',
        '}',
        '',
        'export function average(values: number[]): number {',
        '  return computeScore(values) / values.length',
        '}',
        '',
      ].join('\n'),
    },
  ]
  // Only push a follow-up if the head still matches the first commit (idempotent).
  const remoteHead = findPr(ctx, branch)?.headSha
  if (remoteHead === firstSha) {
    git(ctx.dir, ['checkout', '-B', branch, firstSha])
    writeFiles(ctx.dir, v2)
    git(ctx.dir, ['add', '-A'])
    commit(ctx, 'refactor: use reduce for computeScore (makes earlier comment outdated)')
    pushForce(ctx, branch)
  }

  // Resolve exactly the thread whose comment carries the resolved marker.
  const threads = listReviewThreads(ctx, pr.number)
  const resolvedThread = threads.find((t) =>
    t.comments.nodes.some((c) => c.body.includes(resolvedMarker)),
  )
  if (resolvedThread && !resolvedThread.isResolved) {
    resolveThread(resolvedThread.id)
  }

  // Report the observed thread states.
  const finalThreads = listReviewThreads(ctx, pr.number)
  const resolvedCount = finalThreads.filter((t) => t.isResolved).length
  const outdatedCount = finalThreads.filter((t) => t.isOutdated).length
  return {
    scenario: 'mid-review',
    number: pr.number,
    url: pr.url,
    shape: `${finalThreads.length} threads: ${resolvedCount} resolved, ${outdatedCount} outdated`,
  }
}

/**
 * Scenario: the base branch advances after the PR opens so the MERGE BASE moves
 * under a FIXED head — the two-half cache-keying regression. GitHub's three-dot
 * PR diff (`merge_base…head`) only changes when the merge base moves, so the
 * base must advance onto a commit the head already contains, not diverge on an
 * independent commit.
 *
 * Construction (all off the default-branch fork `forkSha`):
 *   - head branch = fork + h1 + h2 (TWO commits; h1 adds src/feature.ts, h2 adds
 *     src/feature-extra.ts). The head SHA is fixed at h2.
 *   - base branch = fork (the PRE-advance state; NOT pre-advanced with an
 *     independent commit).
 * The PR is base=base@fork, head=head@(fork+h1+h2), so merge_base = fork and the
 * three-dot diff spans both h1 and h2.
 *
 * Fast-forwarding the base branch onto h1 (an ANCESTOR of the head) then moves
 * merge_base from fork → h1 while the head SHA stays h2, and the three-dot diff
 * shrinks to just h2's file — same head, moved compareKey. This seeder leaves
 * the base at the PRE-advance fork and exposes h1's SHA so a live check can
 * perform that advance and reset it back afterwards.
 *
 * Idempotent: a re-run resets the head to fork+h1+h2 (stable SHAs) and the base
 * back to the fork, converging to the same PR #4 and the same pre-advance state.
 */
function seedBaseAdvances(ctx: Ctx, baseSha: string): Seeded {
  const baseBranch = `${BRANCH_PREFIX}base-advances-target`
  const headBranch = `${BRANCH_PREFIX}base-advances`

  // Head branch, first commit (h1): add src/feature.ts off the fork.
  const h1Files: FileSpec[] = [
    {
      path: 'src/feature.ts',
      content: [
        'export function feature(flag: boolean): string {',
        "  return flag ? 'on' : 'off'",
        '}',
        '',
      ].join('\n'),
    },
  ]
  resetBranchTo(ctx, headBranch, baseSha, h1Files, 'feat: add feature toggle')
  const h1Sha = currentSha(ctx, headBranch)

  // Head branch, second commit (h2): add src/feature-extra.ts on top of h1. This
  // is the only change that survives once the base advances onto h1, so the
  // post-advance three-dot diff is exactly this file.
  writeFiles(ctx.dir, [
    {
      path: 'src/feature-extra.ts',
      content: [
        "import { feature } from './feature'",
        '',
        'export function featureLabel(flag: boolean): string {',
        '  return `feature is ${feature(flag)}`',
        '}',
        '',
      ].join('\n'),
    },
  ])
  git(ctx.dir, ['add', '-A'])
  commit(ctx, 'feat: add featureLabel wrapper')
  pushForce(ctx, headBranch)
  const headSha = currentSha(ctx, headBranch)

  // Base branch: the PRE-advance state — the fork itself, NOT pre-advanced with
  // an independent commit. Reset it to the fork on every run so the pre-advance
  // state is reproducible (a live check advances it, then resets it back here).
  git(ctx.dir, ['checkout', '-B', baseBranch, baseSha])
  pushForce(ctx, baseBranch)
  const baseSha_ = currentSha(ctx, baseBranch)

  const pr = ensurePr(ctx, {
    branch: headBranch,
    base: baseBranch,
    title: `${TITLE_MARKER} base-advances PR (merge base moves)`,
    body:
      'Open against a dedicated base branch sitting at the fork. The head carries ' +
      'two commits (h1, h2). Fast-forwarding the base onto h1 — a commit the head ' +
      'already contains — moves the merge base under a FIXED head, so the three-dot ' +
      'diff shrinks to h2 alone. That is the two-half cache-keying regression.',
  })

  return {
    scenario: 'base-advances',
    number: pr.number,
    url: pr.url,
    shape:
      `base ${baseBranch}@${baseSha_.slice(0, 7)} (fork), ` +
      `head ${headBranch}@${headSha.slice(0, 7)} (fork+h1+h2); ` +
      `merge base = fork. Advancing base onto h1 ${h1Sha.slice(0, 7)} moves the merge ` +
      `base under a fixed head`,
    // h1 is the head's first commit off the fork — an ancestor of the head. A
    // live base-advance check fast-forwards the base onto this SHA to move the
    // merge base while the head SHA stays fixed.
    detail: { headSha, h1Sha, forkSha: baseSha },
  }
}

/**
 * Scenario: force-push drift. Open a PR, comment on a specific line, then
 * force-push a rewritten head where the commented commit no longer exists and
 * the commented lines are moved/deleted — the reconcile drift/lost case.
 */
function seedForcePush(ctx: Ctx, baseSha: string): Seeded {
  const branch = `${BRANCH_PREFIX}force-push`
  const commentMarker = 'FIXTURE-force-push-comment'

  // Initial head: a file with distinct lines we will comment on, then rewrite.
  const v1: FileSpec[] = [
    {
      path: 'src/handler.ts',
      content: [
        'export function handle(event: string): string {',
        "  if (event === 'start') {",
        "    return 'starting'",
        '  }',
        "  if (event === 'stop') {",
        "    return 'stopping'",
        '  }',
        "  return 'unknown'",
        '}',
        '',
      ].join('\n'),
    },
  ]
  resetBranchTo(ctx, branch, baseSha, v1, 'feat: add event handler')
  pushForce(ctx, branch)
  const firstSha = currentSha(ctx, branch)

  const pr = ensurePr(ctx, {
    branch,
    base: DEFAULT_BRANCH,
    title: `${TITLE_MARKER} force-push PR (comment drifts after rewrite)`,
    body: 'A line comment is left, then the head is force-pushed so the commented commit is gone and the commented lines move/delete — reconcile drift/lost.',
  })

  // Comment on line 3 (`return 'starting'`) at the first commit.
  let comments = listReviewComments(ctx, pr.number)
  if (!findCommentByBody(comments, commentMarker)) {
    createReviewComment(ctx, pr.number, {
      commitSha: firstSha,
      path: 'src/handler.ts',
      line: 3,
      body: `${commentMarker}: prefer a lookup table over the if-chain.`,
    })
  }

  // Force-push a rewritten head: rebuild the branch from base with a completely
  // different tree/history so the commented commit is no longer an ancestor and
  // the commented lines are gone. Idempotent: only rewrite while the remote head
  // is still the original commit.
  const remoteHead = findPr(ctx, branch)?.headSha
  if (remoteHead === firstSha) {
    const v2: FileSpec[] = [
      {
        path: 'src/handler.ts',
        content: [
          'const RESPONSES: Record<string, string> = {',
          "  start: 'starting',",
          "  stop: 'stopping',",
          '}',
          '',
          'export function handle(event: string): string {',
          "  return RESPONSES[event] ?? 'unknown'",
          '}',
          '',
        ].join('\n'),
      },
    ]
    // Rebuild from base as a fresh single commit (new history -> force-push).
    resetBranchTo(ctx, branch, baseSha, v2, 'refactor: replace if-chain with lookup table (rewrites history)')
    pushForce(ctx, branch)
  }
  const newHead = currentSha(ctx, branch)

  return {
    scenario: 'force-push',
    number: pr.number,
    url: pr.url,
    shape: `head force-pushed ${firstSha.slice(0, 7)} -> ${newHead.slice(0, 7)} after a line comment (comment drifts/lost)`,
  }
}

// ——————————————————————————————————————————————————————————————
// Main
// ——————————————————————————————————————————————————————————————

function main(): void {
  const { repo, workspace } = parseArgs(process.argv.slice(2))
  assertScratchTarget(repo)

  // Verify auth without ever surfacing the token.
  const auth = gh(['auth', 'status'], { allowFailure: true, quiet: true })
  if (auth.status !== 0) {
    fail('gh is not authenticated. Run `gh auth login` first (needs the `repo` scope).')
  }

  console.log(`seed-scratch: target repo ${repo}`)

  // Prepare a working clone. Reuse a provided workspace if it is already a clone
  // of this repo; otherwise create a fresh temp clone and clean it up after.
  let dir: string
  let cleanup = false
  const cloneUrl = `https://github.com/${repo}.git`

  if (workspace) {
    dir = workspace
    if (existsSync(join(dir, '.git'))) {
      const remote = git(dir, ['remote', 'get-url', 'origin'], { allowFailure: true }).stdout.trim()
      if (!remote.includes(repo)) {
        fail(`workspace ${dir} is a clone of ${remote}, not ${repo}`)
      }
      git(dir, ['fetch', '--prune', 'origin'], { allowFailure: true })
    } else {
      mkdirSync(dir, { recursive: true })
      run('gh', ['repo', 'clone', repo, dir, '--', '--no-checkout'], { allowFailure: true })
      if (!existsSync(join(dir, '.git'))) {
        // Empty repo: init and wire the remote so the first push can bootstrap.
        git(dir, ['init'])
        git(dir, ['remote', 'add', 'origin', cloneUrl])
      }
    }
  } else {
    dir = mkdtempSync(join(tmpdir(), 'revu-seed-'))
    cleanup = true
    run('gh', ['repo', 'clone', repo, dir, '--', '--no-checkout'], { allowFailure: true })
    if (!existsSync(join(dir, '.git'))) {
      git(dir, ['init'])
      git(dir, ['remote', 'add', 'origin', cloneUrl])
    }
  }

  const ctx: Ctx = { repo, dir }
  const seeded: Seeded[] = []

  try {
    const baseSha = ensureBaseBranch(ctx)

    console.log('\n[1/5] clean small PR')
    seeded.push(seedCleanSmall(ctx, baseSha))

    console.log('\n[2/5] large PR')
    seeded.push(seedLarge(ctx, baseSha))

    console.log('\n[3/5] mid-review PR')
    seeded.push(seedMidReview(ctx, baseSha))

    console.log('\n[4/5] base-advances PR')
    seeded.push(seedBaseAdvances(ctx, baseSha))

    console.log('\n[5/5] force-push PR')
    seeded.push(seedForcePush(ctx, baseSha))
  } finally {
    if (cleanup) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n———————————————————————————————————————————')
  console.log('Seeded fixture PRs (converged):')
  for (const s of seeded) {
    console.log(`  ${s.scenario.padEnd(14)} #${s.number}  ${s.url}`)
    console.log(`  ${' '.repeat(14)}   ${s.shape}`)
  }
  console.log('———————————————————————————————————————————')
  console.log('Done. Re-run to converge to the same PRs (idempotent).')
}

main()

/**
 * End-to-end driver for a review of two local branches, in a repository that
 * has no remote and against a daemon that has no GitHub half at all.
 *
 * A temporary git repository is seeded from scratch — two branches, a handful
 * of changed lines, and zero remotes — and the daemon is started inside it in
 * direct mode with the local-only switch on, so it discovers that repository
 * from its own working directory and serves reviews with no origin, no token
 * and no viewer. A headless system Chrome then drives the whole flow:
 *
 *   inbox → New local review → pick base and head → create → files screen →
 *   sync → add an inline draft comment → submit the review → assert the draft
 *   cleared.
 *
 * ## What this proves that the unit level cannot
 *
 * Three claims, each paired with the positive half that keeps it honest — an
 * absence nobody can distinguish from a flow that never ran is not evidence:
 *
 *   - the app genuinely talked to the daemon (at least one real `/api/*`
 *     request fired) AND the daemon issued no outbound request while it did;
 *   - the daemon's network log holds its installation line and nothing else,
 *     with every recorded URL printed on failure so a red names the escape;
 *   - the same locator that finds the `Files` and `Conversation` tabs finds no
 *     `Checks` and no `Description` tab. Asserting the absence with a locator
 *     that never found anything would pass against an empty page.
 *
 * ## What this does NOT prove
 *
 * The network guard wraps `fetch` in the daemon process only. Real `git`
 * subprocesses get their own globals and go around it entirely, which is why
 * the seeded repository is asserted to have ZERO remotes: for a `git fetch`
 * there is simply nowhere to go. That assertion is a check line rather than a
 * comment, because it is the load-bearing half of the claim.
 *
 * Nor does it cover what a local review does once a pull request appears for
 * the same branch pair. A flow that reaches no GitHub cannot open one, so that
 * transition is proven where it can be — at the unit level, against a store.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Locator, Page, Request } from 'playwright-core'
import { screenshot, startHarness } from './harness'
import { isOutboundUrl } from './no-github-guard'

/** The branches the seeded repository compares, and the identity it carries. */
const BASE_BRANCH = 'main'
const HEAD_BRANCH = 'feature/e2e-local-review'
const GIT_USER_NAME = 'E2E Reviewer'
const GIT_USER_EMAIL = 'e2e@revu.invalid'

/** The title typed into the create dialog, so the review is identifiable. */
const REVIEW_TITLE = 'End-to-end local review'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}`, detail ?? '')
  }
}

/** Whether a request URL targets the daemon's `/api/*` surface. */
function isApiRequest(req: Request): boolean {
  try {
    return new URL(req.url()).pathname.startsWith('/api/')
  } catch {
    return false
  }
}

// ————————————————————————————————————————————————————————————————
// The seeded repository
// ————————————————————————————————————————————————————————————————

/**
 * The environment every `git` in this file runs under.
 *
 * Both config-path variables point at files that are never created, which is
 * how git is told to read no ambient configuration at all: a missing config
 * file is an empty one. That matters beyond tidiness — a developer's global
 * `diff.external` replaces the diff machinery wholesale and `core.autocrlf`
 * rewrites the bytes a blob is stored with, so a run could otherwise be green
 * on one machine and red on another for reasons that have nothing to do with
 * the flow. `GIT_TERMINAL_PROMPT=0` turns a credential prompt into an
 * immediate failure rather than a driver that hangs forever on a terminal it
 * does not own.
 */
function gitEnvironment(absentConfigDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.GIT_CONFIG_GLOBAL = join(absentConfigDir, 'absent-global-gitconfig')
  env.GIT_CONFIG_SYSTEM = join(absentConfigDir, 'absent-system-gitconfig')
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/** Run one git command in the seeded repository, throwing on a non-zero exit. */
function git(repoDir: string, env: Record<string, string>, args: string[]): string {
  const result = spawnSync('git', ['-C', repoDir, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `\`git ${args.join(' ')}\` exited ${String(result.status)}: ${(result.stderr ?? '').trim()}`,
    )
  }
  return result.stdout
}

/**
 * Commit the working tree with identity and signing pinned on the invocation.
 *
 * The identity flags are passed per commit as well as written into the
 * repository's config because the two serve different readers: the config is
 * what the daemon reads at boot to key drafts under a human, while the flags
 * are what `git commit` itself needs — and with the ambient config pinned
 * absent, a runner with no global identity would otherwise fail outright with
 * "Please tell me who you are". Signing and hooks are disabled for the mirror
 * image of that reason: a developer's signing key must not be asked for here.
 */
function commit(repoDir: string, env: Record<string, string>, message: string): void {
  git(repoDir, env, ['add', '-A'])
  git(repoDir, env, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    `user.name=${GIT_USER_NAME}`,
    '-c',
    `user.email=${GIT_USER_EMAIL}`,
    'commit',
    '-m',
    message,
  ])
}

/** The file the review is written against, as twenty distinct lines. */
function baseFileContents(): string {
  const lines: string[] = ['// A small module, one distinct line at a time.']
  for (let i = 1; i <= 19; i++) {
    lines.push(`export const value${i} = ${i * 7}`)
  }
  return `${lines.join('\n')}\n`
}

/** The same file with three lines changed and one appended. */
function headFileContents(): string {
  const lines = baseFileContents().trimEnd().split('\n')
  lines[3] = 'export const value3 = 210'
  lines[7] = 'export const value7 = 490'
  lines[11] = 'export const value11 = 770'
  lines.push('export const addedOnHead = true')
  return `${lines.join('\n')}\n`
}

/**
 * Seed a repository with a base branch, a head branch that changes a few lines
 * of it, and no remotes. The base branch is left checked out, so the worktree
 * holds committed content only.
 */
function seedRepository(repoDir: string, absentConfigDir: string): void {
  const env = gitEnvironment(absentConfigDir)
  const sourcePath = join(repoDir, 'src', 'index.ts')

  git(repoDir, env, ['init', '-b', BASE_BRANCH])
  // The identity the daemon reads at boot. It refuses to start without a
  // `user.email`, which is the key every draft and viewed mark is filed under.
  git(repoDir, env, ['config', 'user.name', GIT_USER_NAME])
  git(repoDir, env, ['config', 'user.email', GIT_USER_EMAIL])

  mkdirSync(dirname(sourcePath), { recursive: true })
  writeFileSync(sourcePath, baseFileContents(), 'utf8')
  commit(repoDir, env, 'Add the module under review')

  git(repoDir, env, ['checkout', '-b', HEAD_BRANCH])
  writeFileSync(sourcePath, headFileContents(), 'utf8')
  commit(repoDir, env, 'Change three constants and add one')

  git(repoDir, env, ['checkout', BASE_BRANCH])

  // Both are check lines rather than assumptions. Zero remotes is what stands
  // between a `git` subprocess and the network the guard cannot see, and a
  // clean worktree is what keeps the review about committed content.
  check('seeded repository has zero remotes', git(repoDir, env, ['remote']).trim() === '', {
    remotes: git(repoDir, env, ['remote']).trim(),
  })
  const status = git(repoDir, env, ['status', '--porcelain']).trim()
  check('seeded worktree is clean', status === '', status)
}

// ————————————————————————————————————————————————————————————————
// The create dialog
// ————————————————————————————————————————————————————————————————

/**
 * Choose a branch in one of the create dialog's two pickers.
 *
 * Each picker is a filterable list, so the two are told apart by the
 * accessible name of their filter box — the only thing on the screen that
 * distinguishes them, since both list the same branches. Typing the branch name
 * narrows the list to it before the choice is made, which is what keeps the
 * click off whichever row happened to be drawn first.
 *
 * The base is always chosen explicitly, which covers both worlds: a repository
 * with no remote has no default branch to preselect, and choosing a base that
 * was already preselected sets it to the value it already had.
 */
async function pickBranch(page: Page, filterLabel: string, branch: string): Promise<Locator> {
  const picker = page.locator(`[cmdk-root]:has(input[aria-label="${filterLabel}"])`)
  const filter = picker.locator(`input[aria-label="${filterLabel}"]`)
  await filter.waitFor({ timeout: 20_000 })
  await filter.fill(branch)
  const option = picker.getByRole('option', { name: branch, exact: true })
  await option.waitFor({ timeout: 20_000 })
  await option.click()
  return picker
}

// ————————————————————————————————————————————————————————————————
// The flow
// ————————————————————————————————————————————————————————————————

async function drive(repoDir: string, absentConfigDir: string, netlogPath: string): Promise<void> {
  const h = await startHarness({
    mode: 'direct',
    cwd: repoDir,
    preload: resolve(import.meta.dir, 'no-github-guard.ts'),
    env: {
      REVU_LOCAL_ONLY: '1',
      REVU_E2E_NETLOG: netlogPath,
      // Emptied rather than left alone: a developer's shell token must not be
      // what makes this run pass, and must not be what a stray call reaches for.
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: join(absentConfigDir, 'absent-global-gitconfig'),
      GIT_CONFIG_SYSTEM: join(absentConfigDir, 'absent-system-gitconfig'),
    },
  })
  const { page, base } = h

  // Every request the browser made, so the positive half of "no outbound
  // traffic" is a fact about a flow that actually ran.
  const apiCalls: string[] = []
  const browserOutbound: string[] = []
  page.on('request', (req) => {
    if (isApiRequest(req)) apiCalls.push(req.url())
    if (isOutboundUrl(req.url())) browserOutbound.push(req.url())
  })

  try {
    // ——— inbox ———
    await page.goto(`${base}/`)
    await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor({ timeout: 20_000 })
    check('inbox heading renders against a daemon with no GitHub half', true)

    // The invitation is offered twice on an empty inbox — once in the header
    // row and once in the empty state — and both raise the same dialog.
    await page.getByRole('button', { name: 'New local review' }).first().click()

    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 20_000 })
    check('create dialog opened', true)

    await pickBranch(page, 'Filter base branches', BASE_BRANCH)
    await pickBranch(page, 'Filter head branches', HEAD_BRANCH)

    await dialog.locator('#create-local-review-title').fill(REVIEW_TITLE)

    // Enabled is the observable proof both picks landed: the button stays
    // closed while either side is empty or the two name one ref.
    const createButton = dialog.getByRole('button', { name: 'Create review' })
    await createButton.waitFor({ timeout: 20_000 })
    check('Create review is enabled once both branches are picked', await createButton.isEnabled())
    await createButton.click()

    // A local review's id comes from a reserved high band, so its path carries
    // far more digits than a pull request number ever would.
    await page.waitForURL(/\/pr\/\d{10,}(\/|$)/, { timeout: 30_000 })
    const matched = /\/pr\/(\d+)/.exec(new URL(page.url()).pathname)
    const reviewId = matched?.[1] ?? ''
    check('landed on a review whose id is in the reserved local band', reviewId !== '', page.url())

    // ——— files ———
    await page.goto(`${base}/pr/${reviewId}/files`)
    await page.waitForURL(new RegExp(`/pr/${reviewId}/files`), { timeout: 20_000 })
    check('reached the files screen', true)

    // ——— sync ———
    // A review created a moment ago has never been synced, so the button is
    // guaranteed to mount — wait for it rather than probing with a
    // non-auto-waiting isVisible(), which races first render on a cold runner.
    // The success seal renders "⧗ <sha> · synced <time>", so match "· synced":
    // neither the "never synced" seal nor the "…since sync" stale seals can
    // satisfy it.
    const syncNow = page.getByRole('button', { name: 'Sync now' })
    await syncNow.waitFor({ timeout: 20_000 })
    await syncNow.click()
    await page.getByText(/· synced/).first().waitFor({ timeout: 30_000 })
    check('snapshot synced from local git (seal shows "· synced")', true)

    // ——— add an inline draft comment ———
    // The gutter is a button whose mousedown starts a line selection; a window
    // mouseup commits it and opens the composer. A single click issues both.
    const gutter = page.locator('button[aria-label^="Select line "]').first()
    await gutter.waitFor({ timeout: 20_000 })
    await gutter.click()

    let composer = page.locator('textarea[aria-label^="Comment on line"]').first()
    if (!(await composer.isVisible().catch(() => false))) {
      // Fallback: the `c` shortcut opens a composer for the focused file's
      // first changed line. Focus the diff surface first so the key is heard.
      await page.locator('button[aria-label^="Select line "]').first().hover()
      await page.keyboard.press('c')
    }
    composer = page.locator('textarea[aria-label^="Comment on line"]').first()
    await composer.waitFor({ timeout: 20_000 })
    check('inline comment composer opened', true)

    await composer.fill('These constants moved together — worth a line saying why.')
    await page.getByRole('button', { name: 'Add to review' }).click()

    await page.getByText('pending', { exact: true }).first().waitFor({ timeout: 20_000 })
    check('pending comment card appears', true)

    // ——— submit the review ———
    const submit = page.getByRole('button', { name: /Submit review · \d+/ })
    await submit.waitFor({ timeout: 20_000 })
    check('submit button shows a pending count', true)
    await submit.click()

    // The toast is the one piece of copy that differs from the mediated flow:
    // nothing was published anywhere, so a review of two local branches is
    // SAVED rather than posted.
    await page.getByText('Review saved', { exact: false }).waitFor({ timeout: 20_000 })
    check('toast "Review saved" shown', true)

    await page.getByText('No review in progress', { exact: false }).waitFor({ timeout: 20_000 })
    check('review bar reset to "No review in progress"', true)

    const submitGone = (await page.getByRole('button', { name: /Submit review · \d+/ }).count()) === 0
    check('Submit review button is gone (draft cleared)', submitGone)

    const pendingGone = (await page.getByText('pending', { exact: true }).count()) === 0
    check('pending comment card is gone', pendingGone)

    // ——— the seam was genuinely exercised ———
    check('app issued at least one real /api/* request', apiCalls.length > 0, apiCalls.length)

    // ——— and nothing left the machine ———
    check('browser made no request beyond loopback', browserOutbound.length === 0, browserOutbound)

    const netlog = readFileSync(netlogPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    check(
      'daemon network log opens with the guard installation line',
      netlog[0] === '{"installed":true}',
      netlog,
    )
    check(
      'daemon issued no outbound request during the whole flow',
      netlog.length === 1,
      // Printed whole rather than counted, so a red names the URL that escaped.
      netlog,
    )

    // ——— which sections this review offers, and which it does not ———
    // One locator, four questions. The strip is the header's only landmark and
    // it names the kind of review, so scoping to it also rules out the check
    // link that a mediated review draws in its meta row.
    const tabStrip = page.locator('nav[aria-label="Review sections"]')
    const tab = (label: string): Locator =>
      tabStrip.getByRole('link', { name: new RegExp(`^${label}\\b`) })
    check('Files tab is present', (await tab('Files').count()) === 1)
    check('Conversation tab is present', (await tab('Conversation').count()) === 1)
    check('Checks tab is absent', (await tab('Checks').count()) === 0)
    check('Description tab is absent', (await tab('Description').count()) === 0)

    if (failures > 0) {
      await screenshot(page, 'local-review-failure.png')
    }
  } catch (error) {
    failures++
    console.error('FAIL  unexpected error during the local review flow', error)
    await screenshot(page, 'local-review-failure.png')
  } finally {
    await h.stop()
  }
}

async function run(): Promise<void> {
  // Resolved through its real path because a temp directory is reached through
  // a symlink on some platforms while git reports the resolved form, so an
  // unresolved path would not compare equal to the toplevel git discovers.
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-e2e-local-repo-')))
  // Everything that is not the repository: the network log the daemon writes,
  // and the two config paths that are named but never created.
  const scratchDir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-e2e-local-scratch-')))
  const netlogPath = join(scratchDir, 'outbound.jsonl')

  try {
    seedRepository(repoDir, scratchDir)
    await drive(repoDir, scratchDir, netlogPath)
  } catch (error) {
    failures++
    console.error('FAIL  unexpected error before the flow started', error)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(scratchDir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

await run().catch((error) => {
  console.error('FATAL  local-review driver failed', error)
  process.exit(1)
})

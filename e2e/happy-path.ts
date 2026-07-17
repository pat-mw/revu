/**
 * End-to-end happy path over the real HTTP transport.
 *
 * Assumes `packages/app/dist` is already built in HTTP mode (see the
 * `build:e2e` script — it sets `VITE_REVU_API=/` so the served app makes
 * same-origin `/api/*` calls). The harness serves that dist behind revud on an
 * ephemeral port with pristine fixtures, then a headless system Chrome drives
 * the full flow:
 *
 *   inbox → open a PR → files screen → sync → add an inline draft comment →
 *   submit the review (COMMENT) → assert the draft cleared.
 *
 * Two properties are asserted beyond the flow itself:
 *   - the HTTP seam is genuinely exercised (at least one real `/api/*` request
 *     fires during the flow, proving the HTTP adapter is in play, not the mock);
 *   - `?mock=1` is pure (a page opened with that flag makes zero `/api/*`
 *     requests — the in-browser mock never touches the network).
 *
 * Each check logs `ok`/`FAIL`; any failure screenshots to `e2e/artifacts/` and
 * exits 1. A clean run exits 0.
 *
 * Target PR: 101. It is authored by another human and assigns the default
 * human (h-priya) as a reviewer, so it appears in the inbox; it is never
 * synced and carries no seeded draft, so it exercises the full
 * sync → comment → submit path and a fresh COMMENT submit returns `ok`.
 */
import type { Page, Request } from 'playwright-core'
import { screenshot, startHarness } from './harness'

const PR = 101

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

/**
 * Open a fresh page at `/?mock=1` and confirm the pure in-browser mock makes
 * zero `/api/*` requests while the inbox renders. Kept minimal and isolated in
 * its own page so its request listener never overlaps the happy path's.
 */
async function assertMockPurity(page: Page, base: string): Promise<void> {
  const apiCalls: string[] = []
  const listener = (req: Request): void => {
    if (isApiRequest(req)) apiCalls.push(req.url())
  }
  page.on('request', listener)
  try {
    await page.goto(`${base}/?mock=1`)
    await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor({ timeout: 20_000 })
    // Wait for a PR link so the mock has actually resolved its list, not just
    // painted the shell — any stray `/api/*` call would have fired by now.
    await page.locator('a[href^="/pr/"]').first().waitFor({ timeout: 20_000 })
    check('?mock=1 makes zero /api/* requests', apiCalls.length === 0, apiCalls)
  } finally {
    page.off('request', listener)
  }
}

async function run(): Promise<void> {
  const h = await startHarness()
  const { page, base } = h

  // Record every real `/api/*` request across the whole happy path.
  const apiCalls: string[] = []
  page.on('request', (req) => {
    if (isApiRequest(req)) apiCalls.push(req.url())
  })

  try {
    // ——— inbox ———
    await page.goto(`${base}/`)
    await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor({ timeout: 20_000 })
    check('inbox heading renders', true)

    const prLink = page.locator(`a[href="/pr/${PR}"]`).first()
    await prLink.waitFor({ timeout: 20_000 })
    check(`inbox lists PR ${PR}`, true)

    // ——— open the PR (genuine navigation), then land on the files screen ———
    await prLink.click()
    await page.waitForURL(new RegExp(`/pr/${PR}(/|$)`), { timeout: 20_000 })
    await page.goto(`${base}/pr/${PR}/files`)
    await page.waitForURL(new RegExp(`/pr/${PR}/files`), { timeout: 20_000 })
    check('reached the files screen', true)

    // ——— sync ———
    // PR 101 is deterministically never-synced on pristine fixtures, so the
    // "Sync now" button is guaranteed to mount — wait for it rather than
    // probing with a non-auto-waiting isVisible(), which races first render on
    // a cold runner (skipping the click leaves the PR unsynced). The success
    // seal renders "⧗ <sha> · synced <time>", so match "· synced": neither the
    // "never synced" seal nor the "This PR was never synced" empty state, nor
    // the "…since sync" stale seals, can satisfy it.
    const syncNow = page.getByRole('button', { name: 'Sync now' })
    await syncNow.waitFor({ timeout: 20_000 })
    await syncNow.click()
    await page.getByText(/· synced/).first().waitFor({ timeout: 30_000 })
    check('snapshot synced (seal shows "· synced")', true)

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

    await composer.fill('This TTL constant deserves a short comment explaining the unit.')
    await page.getByRole('button', { name: 'Add to review' }).click()

    // The pending comment card (badge "pending") appears inline.
    await page.getByText('pending', { exact: true }).first().waitFor({ timeout: 20_000 })
    check('pending comment card appears', true)

    // ——— submit the review (default verdict COMMENT) ———
    const submit = page.getByRole('button', { name: /Submit review · \d+/ })
    await submit.waitFor({ timeout: 20_000 })
    check('submit button shows a pending count', true)
    await submit.click()

    // ——— the assertion: the draft cleared ———
    // A successful COMMENT submit resets the review bar: the toast confirms the
    // post, the "Submit review · N" button is gone, and "No review in progress"
    // / a "Start review" button returns.
    await page.getByText('Review posted', { exact: false }).waitFor({ timeout: 20_000 })
    check('toast "Review posted" shown', true)

    await page
      .getByText('No review in progress', { exact: false })
      .waitFor({ timeout: 20_000 })
    check('review bar reset to "No review in progress"', true)

    const submitGone = (await page.getByRole('button', { name: /Submit review · \d+/ }).count()) === 0
    check('Submit review button is gone (draft cleared)', submitGone)

    const pendingGone = (await page.getByText('pending', { exact: true }).count()) === 0
    check('pending comment card is gone', pendingGone)

    // ——— the HTTP seam was genuinely exercised ———
    check(
      'app issued at least one real /api/* request',
      apiCalls.length > 0,
      apiCalls.length,
    )

    // ——— ?mock=1 purity (isolated fresh page) ———
    const mockPage = await h.context.newPage()
    try {
      await assertMockPurity(mockPage, base)
    } finally {
      await mockPage.close()
    }

    if (failures > 0) {
      await screenshot(page, 'failure.png')
    }
  } catch (error) {
    failures++
    console.error('FAIL  unexpected error during happy path', error)
    await screenshot(page, 'failure.png')
  } finally {
    await h.stop()
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

await run().catch((error) => {
  console.error('FATAL  e2e harness failed before the flow started', error)
  process.exit(1)
})

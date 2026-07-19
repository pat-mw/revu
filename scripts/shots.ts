/**
 * Capture the README / docs screenshot set against the dev server, driving the
 * pure in-browser mock (`?mock=1`) with a pristine profile so fixtures seed the
 * canonical demo state on every run.
 *
 *   bun dev                     # in another terminal (serves the mock build)
 *   bun run scripts/shots.ts
 *
 * Uses the installed system Chrome via playwright-core; no browser downloads.
 *
 * Determinism rules this script holds itself to (the app's own e2e learned
 * these the hard way):
 *   - a fresh browser context per run, fixed viewport, deviceScaleFactor 2;
 *   - every navigation carries `?mock=1`, so the transport is the HTTP-free mock
 *     regardless of how the dev server was built;
 *   - wait on a stable, surface-specific selector before every shot — never a
 *     bare timeout race — and assert a distinctive element is visible, so a
 *     mis-navigation fails loudly instead of shooting a blank or wrong screen;
 *   - the "fresh snapshot" seal is matched as `· synced` (with the middot), not
 *     bare `synced`, which also matches the "never synced" gate.
 */
import { chromium } from 'playwright-core'
import type { Locator, Page } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5173'
const OUT = 'docs/assets/screenshots'
mkdirSync(OUT, { recursive: true })

/** Append `?mock=1` (or `&mock=1`) so every page loads the HTTP-free mock. */
function withMock(pathAndQuery: string): string {
  const sep = pathAndQuery.includes('?') ? '&' : '?'
  return `${BASE}${pathAndQuery}${sep}mock=1`
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 860 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await context.newPage()

/** Fail loudly if the app logs an error while a surface is being captured. */
page.on('pageerror', (err) => {
  throw new Error(`page error while capturing: ${err.message}`)
})

const SELECTOR_TIMEOUT = 15_000

/** Wait for a locator to be visible, asserting it before we shoot. */
async function assertVisible(locator: Locator, what: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT })
  } catch {
    throw new Error(`expected "${what}" to be visible before screenshot — not found`)
  }
}

/** Navigate to a mock URL and confirm the app shell painted. */
async function goto(pathAndQuery: string): Promise<void> {
  await page.goto(withMock(pathAndQuery), { waitUntil: 'domcontentloaded' })
}

/**
 * Write one screenshot after asserting the guard selector is visible. A short
 * settle pause lets fonts and diff highlighting paint; it is a polish delay on
 * top of an already-satisfied wait, never the thing we rely on for correctness.
 */
async function shoot(
  name: string,
  guard: { locator: Locator; what: string },
  opts: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {},
): Promise<void> {
  await assertVisible(guard.locator, guard.what)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.fullPage ?? false, clip: opts.clip })
  console.log(`${name}.png`)
}

/** The fresh-snapshot seal, matched with the middot so "never synced" can't slip through. */
function freshSeal(p: Page): Locator {
  return p.locator('span.seal', { hasText: '· synced' })
}

// ————————————————————————————————————————————————————————————————
// 1 — Inbox: all four intent buckets + the loud unresolved number.
// ————————————————————————————————————————————————————————————————
await goto('/')
await assertVisible(page.getByRole('heading', { name: 'Inbox' }), 'inbox heading')
await assertVisible(page.getByRole('heading', { name: 'Waiting on you' }), 'waiting-on-you bucket')
await assertVisible(page.getByRole('heading', { name: 'To review' }), 'to-review bucket')
await shoot('inbox', {
  locator: page.getByRole('heading', { name: 'Waiting on you' }),
  what: 'inbox buckets',
})

// ————————————————————————————————————————————————————————————————
// 2 — Files workbench on the big diff (#204): tree + virtualized diff + seal.
// ————————————————————————————————————————————————————————————————
await goto('/pr/204/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await assertVisible(page.getByText(/expand \d+ lines?/).first(), 'a collapsed-context gap row')
await shoot('files-diff', {
  locator: page.getByRole('group', { name: 'Diff layout' }),
  what: 'diff layout toggle',
})

// ————————————————————————————————————————————————————————————————
// 3 — Files + inline thread on #312 (resolved/outdated/suggestion mid-review).
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await assertVisible(page.getByText(/\d+ comments?/).first(), 'an inline thread card')
await shoot('files-thread', {
  locator: page.getByText(/\d+ comments?/).first(),
  what: 'inline thread on the diff',
})

// ————————————————————————————————————————————————————————————————
// 4 — The violet review rail: #312 carries Priya's seeded pending draft.
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await assertVisible(page.getByRole('button', { name: /Submit review · \d+/ }), 'review-bar submit')
await assertVisible(page.getByText('saved · broker'), 'draft persistence whisper')
await shoot('review-bar', {
  locator: page.getByRole('button', { name: /Submit review · \d+/ }),
  what: 'violet review rail',
})

// ————————————————————————————————————————————————————————————————
// 5 — Unified vs split: capture the split layout by toggling with `u`.
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await assertVisible(page.getByRole('button', { name: 'Split' }), 'split toggle button')
// Diff surface must hold focus for `u` to route to the files view, not a field.
await page.locator('body').click()
await page.keyboard.press('u')
await assertVisible(
  page.getByRole('button', { name: 'Split' }).and(page.locator('[aria-pressed="true"]')),
  'split layout active',
)
await shoot('files-split', {
  locator: page.getByRole('button', { name: 'Split' }).and(page.locator('[aria-pressed="true"]')),
  what: 'split diff layout',
})

// ————————————————————————————————————————————————————————————————
// 6 — Conversation + thread cards on #312.
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/conversation')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await assertVisible(page.getByRole('region', { name: 'Review threads' }), 'review-threads section')
await shoot('conversation', {
  locator: page.getByRole('region', { name: 'Review threads' }),
  what: 'conversation thread cards',
})

// ————————————————————————————————————————————————————————————————
// 7 — Checks tab on #362: failing runs open by default + the honest log note.
// ————————————————————————————————————————————————————————————————
await goto('/pr/362/checks')
await assertVisible(page.getByText(/\d+ failed/), 'checks rollup with failures')
await assertVisible(page.getByText(/logs live on github\.com/), 'honest log note on a failing check')
await shoot('checks', {
  locator: page.getByText(/\d+ failed/),
  what: 'failing checks tab',
})

// ————————————————————————————————————————————————————————————————
// 8 — Author queue docked over the files screen (#347, authored by Priya).
// ————————————————————————————————————————————————————————————————
await goto('/pr/347/files?queue=1')
await assertVisible(page.getByText(/Unresolved · \d+ of \d+/), 'author queue header')
await assertVisible(page.getByRole('button', { name: /Resolve & next/ }), 'queue resolve action')
await shoot('author-queue', {
  locator: page.getByText(/Unresolved · \d+ of \d+/),
  what: 'author walk-the-queue dock',
})

// ————————————————————————————————————————————————————————————————
// 9 — Command palette (⌘K) over a PR, so the "This PR" group is present.
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await page.locator('body').click()
await page.keyboard.press('Meta+k')
await assertVisible(page.getByPlaceholder('Jump to a PR or run a command…'), 'palette input')
await assertVisible(page.getByText('Walk unresolved threads (author queue)'), 'this-PR palette group')
await shoot('command-palette', {
  locator: page.getByPlaceholder('Jump to a PR or run a command…'),
  what: 'command palette',
})
await page.keyboard.press('Escape')
await page.getByPlaceholder('Jump to a PR or run a command…').waitFor({ state: 'hidden', timeout: SELECTOR_TIMEOUT })

// ————————————————————————————————————————————————————————————————
// 10 — Keyboard shortcut sheet (the header `?` affordance, which `?` mirrors).
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
await assertVisible(page.getByRole('heading', { name: 'Keyboard' }), 'shortcut sheet heading')
await assertVisible(page.getByText('Every key the app claims, grouped by where it applies.'), 'shortcut sheet blurb')
await shoot('shortcut-sheet', {
  locator: page.getByRole('heading', { name: 'Keyboard' }),
  what: 'keyboard shortcut sheet',
})
await page.keyboard.press('Escape')
await page.getByRole('heading', { name: 'Keyboard' }).waitFor({ state: 'hidden', timeout: SELECTOR_TIMEOUT })

// ————————————————————————————————————————————————————————————————
// 11 — Dev panel: identity, network, shared rate budget, scenario map.
// ————————————————————————————————————————————————————————————————
await goto('/pr/312/files')
await assertVisible(freshSeal(page), 'fresh snapshot seal')
await page.getByRole('button', { name: 'Identity and workspace menu' }).click()
await page.getByRole('menuitem', { name: 'Dev panel…' }).click()
await assertVisible(page.getByRole('heading', { name: 'Demo controls' }), 'dev panel heading')
await assertVisible(page.getByText('Scenario map'), 'dev panel scenario map')
await shoot('dev-panel', {
  locator: page.getByRole('heading', { name: 'Demo controls' }),
  what: 'dev panel',
})
await page.keyboard.press('Escape')
await page.getByRole('heading', { name: 'Demo controls' }).waitFor({ state: 'hidden', timeout: SELECTOR_TIMEOUT })

// ————————————————————————————————————————————————————————————————
// 12 — Reconcile flow (#389). Mutates draft state, so it runs last.
// ————————————————————————————————————————————————————————————————
await goto('/pr/389/files')
await assertVisible(page.locator('span.seal[data-stale="true"]'), 'stale snapshot seal')
await assertVisible(page.getByRole('button', { name: /Submit review · \d+/ }), 'review-bar submit on the stale PR')
await page.getByRole('button', { name: /Submit review · \d+/ }).click()
await assertVisible(
  page.getByText('The branch moved while you were reviewing'),
  'head-moved dialog',
)
await page.getByRole('button', { name: 'Re-sync & reconcile' }).click()
await assertVisible(page.getByRole('heading', { name: 'Reconcile your review' }), 'reconcile dialog')
await assertVisible(page.getByText(/Anchors cleanly ·/), 'clean reconcile group')
await shoot('reconcile', {
  locator: page.getByRole('heading', { name: 'Reconcile your review' }),
  what: 'reconcile dialog',
})

await browser.close()
console.log('done')

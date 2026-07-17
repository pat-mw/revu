/**
 * Capture README screenshots against the dev server with a pristine profile
 * (fresh localStorage → fixtures seed the canonical demo state).
 *   bun dev            # in another terminal
 *   bun run scripts/shots.ts
 * Uses the installed system Chrome via playwright-core; no browser downloads.
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5173'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 860 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await context.newPage()

// 1 — Inbox: the sections + the big unresolved number.
await page.goto(`${BASE}/`)
await page.getByText('WAITING ON YOU', { exact: false }).waitFor({ timeout: 15_000 })
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/inbox.png` })
console.log('inbox.png')

// 2 — Files screen mid-review: seal, tree, diff, inline org-member thread.
await page.goto(`${BASE}/pr/312/files`)
await page.getByText('synced', { exact: false }).first().waitFor({ timeout: 15_000 })
await page.getByText('expand 6 lines').waitFor({ timeout: 15_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/files.png` })
console.log('files.png')

// 3 — Author queue docked over the files screen.
await page.goto(`${BASE}/pr/347/files?queue=1`)
await page.getByText('Unresolved · 1 of 4').waitFor({ timeout: 15_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/author-queue.png` })
console.log('author-queue.png')

// 4 — The reconcile flow (mutates draft state, so captured last).
await page.goto(`${BASE}/pr/389/files`)
await page.getByText('new commits since sync', { exact: false }).waitFor({ timeout: 15_000 })
await page.getByRole('button', { name: /Submit review · 3/ }).click()
await page.getByText('The branch moved while you were reviewing').waitFor({ timeout: 15_000 })
await page.getByRole('button', { name: 'Re-sync & reconcile' }).click()
await page.getByText('Reconcile your review').waitFor({ timeout: 30_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/reconcile.png` })
console.log('reconcile.png')

await browser.close()
console.log('done')

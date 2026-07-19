/**
 * Capture short, looping animated GIFs of the app's highest-value flows against
 * the dev server, driving the pure in-browser mock (`?mock=1`) with a pristine
 * profile so fixtures seed the canonical demo state on every run.
 *
 *   bun dev                     # in another terminal (serves the mock build)
 *   bun run scripts/gifs.ts
 *
 * Uses the installed system Chrome via playwright-core; no browser downloads.
 * PNG frames are captured with Playwright, decoded to RGBA with upng-js, and
 * assembled into a GIF with gifenc — a small, pure-JS pipeline with no native
 * dependency and no system binary, so it runs anywhere the app's own tooling
 * already does.
 *
 * Determinism rules this script holds itself to (the same ones the screenshot
 * pipeline learned the hard way):
 *   - a fresh browser context per flow, so the mock's localStorage-backed store
 *     re-seeds to the canonical demo state and drafts never accumulate between
 *     flows; fixed viewport, deviceScaleFactor 1 so captured pixels are CSS
 *     pixels and no rescale is needed;
 *   - every navigation carries `?mock=1`, so the transport is the HTTP-free mock
 *     regardless of how the dev server was built;
 *   - a `pageerror` listener that throws, so a broken surface fails the run
 *     loudly instead of recording a frozen or wrong screen;
 *   - wait on a stable, surface-specific selector before every captured beat —
 *     never a bare timeout as the thing correctness rests on; the short settle
 *     pauses between frames are polish on top of an already-satisfied wait;
 *   - the "fresh snapshot" seal is matched as `· synced` (with the middot), not
 *     bare `synced`, which also matches the "never synced" gate.
 *
 * Each GIF is built as a sequence of "beats" — a settled UI state held for a few
 * frames so the eye can read it — then a final beat that returns close to the
 * opening state, so the loop reads cleanly rather than jump-cutting.
 */
import { chromium } from 'playwright-core'
import type { BrowserContext, Locator, Page } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import UPNG from 'upng-js'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import type { Palette } from 'gifenc'

const BASE = 'http://localhost:5173'
const OUT = 'docs/assets/gifs'
mkdirSync(OUT, { recursive: true })

/** Append `?mock=1` (or `&mock=1`) so every page loads the HTTP-free mock. */
function withMock(pathAndQuery: string): string {
  const sep = pathAndQuery.includes('?') ? '&' : '?'
  return `${BASE}${pathAndQuery}${sep}mock=1`
}

const SELECTOR_TIMEOUT = 15_000

/** Frames per second the GIF plays at; 12 reads smoothly while staying small. */
const FPS = 12
/** Milliseconds each frame is shown, derived from the frame rate. */
const FRAME_DELAY_MS = Math.round(1000 / FPS)

/** Widest a GIF is allowed to be, so it embeds comfortably in docs and README. */
const MAX_GIF_WIDTH = 960

/** A rectangular region of the page to record, in CSS pixels. */
type Clip = { x: number; y: number; width: number; height: number }

/** One captured PNG frame plus the geometry every frame in a GIF shares. */
type Frame = { png: Buffer; width: number; height: number }

/** A decoded frame: flat RGBA pixels plus the dimensions they describe. */
type Rgba = { pixels: Uint8Array; width: number; height: number }

const browser = await chromium.launch({ channel: 'chrome', headless: true })

/**
 * Run one flow in its own pristine context so the mock store re-seeds to the
 * canonical demo state, capture its frames, encode the GIF, and always tear the
 * context down — even if a step throws — so a failure can't leak a live browser.
 */
async function record(
  name: string,
  clip: Clip,
  drive: (page: Page, capture: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  page.on('pageerror', (err) => {
    throw new Error(`page error while capturing ${name}: ${err.message}`)
  })

  const frames: Frame[] = []
  const capture = async (): Promise<void> => {
    const png = await page.screenshot({ clip })
    frames.push({ png, width: clip.width, height: clip.height })
  }

  try {
    await drive(page, capture)
  } finally {
    await context.close()
  }

  const bytes = encodeGif(frames)
  const path = `${OUT}/${name}.gif`
  writeFileSync(path, bytes)
  const kib = (bytes.byteLength / 1024).toFixed(0)
  console.log(`${name}.gif — ${frames.length} frames, ${kib} KiB`)
}

/**
 * Encode a sequence of same-sized PNG frames into a single looping GIF. Frames
 * wider than the width budget are downscaled first (box filter). A single global
 * palette is quantized from a stride-sampled union of every frame so the colours
 * stay stable across the loop (per-frame palettes flicker on flat UI), then each
 * frame is mapped onto that palette and written with a fixed delay.
 */
function encodeGif(frames: Frame[]): Uint8Array {
  if (frames.length === 0) throw new Error('no frames captured')

  const rgbaFrames = frames.map((f) => fitWidth(decodePng(f), MAX_GIF_WIDTH))
  const { width, height } = rgbaFrames[0]

  // Build the global palette from a sampled union of all frames. Sampling keeps
  // the quantizer input bounded on long clips while still seeing every colour a
  // beat introduces.
  const sample = sampleUnion(rgbaFrames)
  const palette: Palette = quantize(sample, 256, { format: 'rgb444' })

  const gif = GIFEncoder()
  for (const rgba of rgbaFrames) {
    const indexed = applyPalette(rgba.pixels, palette, 'rgb444')
    gif.writeFrame(indexed, width, height, { palette, delay: FRAME_DELAY_MS })
  }
  gif.finish()
  return gif.bytes()
}

/** Decode one PNG frame to a flat RGBA byte buffer with its dimensions. */
function decodePng(frame: Frame): Rgba {
  const decoded = UPNG.decode(toArrayBuffer(frame.png))
  const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0])
  return { pixels, width: decoded.width, height: decoded.height }
}

/**
 * Downscale a frame so it is no wider than `maxWidth`, preserving aspect ratio
 * with a box filter that averages the source pixels each output pixel covers.
 * Frames already within budget are returned untouched.
 */
function fitWidth(frame: Rgba, maxWidth: number): Rgba {
  if (frame.width <= maxWidth) return frame
  const scale = maxWidth / frame.width
  const outW = maxWidth
  const outH = Math.max(1, Math.round(frame.height * scale))
  const out = new Uint8Array(outW * outH * 4)
  const sx = frame.width / outW
  const sy = frame.height / outH
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * frame.width + xx) * 4
          r += frame.pixels[i]
          g += frame.pixels[i + 1]
          b += frame.pixels[i + 2]
          a += frame.pixels[i + 3]
          n++
        }
      }
      const o = (y * outW + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return { pixels: out, width: outW, height: outH }
}

/**
 * Concatenate a strided sample of every frame's pixels into one buffer for the
 * quantizer. Every ~7th pixel is taken so a long clip yields a bounded sample
 * that still covers each frame's palette.
 */
function sampleUnion(rgbaFrames: Rgba[]): Uint8Array {
  const STRIDE = 7
  const perFrame = rgbaFrames[0].pixels.length
  const sampledPerFrame = Math.ceil(perFrame / 4 / STRIDE) * 4
  const out = new Uint8Array(sampledPerFrame * rgbaFrames.length)
  let w = 0
  for (const { pixels } of rgbaFrames) {
    for (let px = 0; px * 4 < pixels.length; px += STRIDE) {
      const i = px * 4
      out[w++] = pixels[i]
      out[w++] = pixels[i + 1]
      out[w++] = pixels[i + 2]
      out[w++] = pixels[i + 3]
    }
  }
  return out.subarray(0, w)
}

/** View a Node Buffer as a plain ArrayBuffer for the PNG decoder. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** Wait for a locator to be visible, naming what we expected so a miss is legible. */
async function assertVisible(locator: Locator, what: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT })
  } catch {
    throw new Error(`expected "${what}" to be visible before capture — not found`)
  }
}

/** The fresh-snapshot seal, matched with the middot so "never synced" can't slip through. */
function freshSeal(page: Page): Locator {
  return page.locator('span.seal', { hasText: '· synced' })
}

/**
 * Hold the current UI state for a beat: capture `count` frames spaced by the
 * frame delay so a settled screen reads as a deliberate pause in the loop.
 */
async function hold(page: Page, capture: () => Promise<void>, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await capture()
    if (i < count - 1) await page.waitForTimeout(FRAME_DELAY_MS)
  }
}

/**
 * Type `text` into the focused field one character at a time, capturing a frame
 * every few characters so the draft appears to be written live rather than
 * pasted, without ballooning the frame count on longer sentences.
 */
async function typeLive(
  page: Page,
  capture: () => Promise<void>,
  text: string,
  everyChars: number,
): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i], { delay: 0 })
    if (i % everyChars === 0) {
      await capture()
      await page.waitForTimeout(FRAME_DELAY_MS)
    }
  }
  await capture()
}

// ————————————————————————————————————————————————————————————————
// Flow 1 — the `c` inline-comment flow: focus the diff, press `c`, write an
// inline comment, watch it land as a violet pending draft in the review rail.
// ————————————————————————————————————————————————————————————————
await record('inline-comment', { x: 120, y: 120, width: 960, height: 680 }, async (page, capture) => {
  await page.goto(withMock('/pr/312/files'), { waitUntil: 'domcontentloaded' })
  await assertVisible(freshSeal(page), 'fresh snapshot seal')
  await page.waitForTimeout(600)
  // Open on the settled diff.
  await hold(page, capture, 12)
  // The diff surface must hold focus for `c` to route to the files view.
  await page.locator('body').click()
  await page.keyboard.press('c')
  const composer = page.locator('textarea[aria-label^="Comment on line"]')
  await assertVisible(composer, 'inline comment composer')
  await hold(page, capture, 4)
  await composer.first().click()
  await typeLive(
    page,
    capture,
    "Clamp this to a sane maximum so a misconfigured refill can't starve the limiter.",
    3,
  )
  await hold(page, capture, 6)
  // Land it in the draft. The pending card renders in draft violet.
  await page.getByRole('button', { name: 'Add to review' }).click()
  await assertVisible(
    page.locator('.draft-marker').filter({ hasText: 'pending' }).first(),
    'violet pending draft',
  )
  await page.waitForTimeout(400)
  await hold(page, capture, 16)
})

// ————————————————————————————————————————————————————————————————
// Flow 2 — suggestion-block splice: from the composer, the suggestion affordance
// seeds a fenced ```suggestion block pre-filled with the focused line.
// ————————————————————————————————————————————————————————————————
await record('suggestion-block', { x: 120, y: 120, width: 960, height: 680 }, async (page, capture) => {
  await page.goto(withMock('/pr/312/files'), { waitUntil: 'domcontentloaded' })
  await assertVisible(freshSeal(page), 'fresh snapshot seal')
  await page.waitForTimeout(600)
  await page.locator('body').click()
  await page.keyboard.press('c')
  const composer = page.locator('textarea[aria-label^="Comment on line"]')
  await assertVisible(composer, 'inline comment composer')
  await hold(page, capture, 8)
  // The suggestion affordance splices a fenced block seeded with the line's text.
  await page.getByRole('button', { name: 'suggestion' }).click()
  await hold(page, capture, 6)
  await composer.first().click()
  await page.keyboard.press('End')
  await typeLive(page, capture, '\nrefillPerSecond: z.number().positive().max(1_000).default(10),', 2)
  await hold(page, capture, 6)
  await page.getByRole('button', { name: 'Add to review' }).click()
  await assertVisible(
    page.locator('.draft-marker').filter({ hasText: 'pending' }).first(),
    'violet pending draft with suggestion',
  )
  await page.waitForTimeout(400)
  await hold(page, capture, 16)
})

// ————————————————————————————————————————————————————————————————
// Flow 3 — the full reconcile flow (#389): a stale snapshot, submit blocked by
// the moved head, re-sync & reconcile, then the reconcile dialog classifying
// every pending comment. This is the signature interaction.
// ————————————————————————————————————————————————————————————————
await record('reconcile', { x: 250, y: 120, width: 960, height: 700 }, async (page, capture) => {
  await page.goto(withMock('/pr/389/files'), { waitUntil: 'domcontentloaded' })
  await assertVisible(page.locator('span.seal[data-stale="true"]'), 'stale snapshot seal')
  await assertVisible(
    page.getByRole('button', { name: /Submit review · \d+/ }),
    'review-bar submit on the stale PR',
  )
  await page.waitForTimeout(500)
  await hold(page, capture, 12)
  // Submitting against a moved head is blocked and routed through reconcile.
  await page.getByRole('button', { name: /Submit review · \d+/ }).click()
  await assertVisible(
    page.getByText('The branch moved while you were reviewing'),
    'head-moved dialog',
  )
  await hold(page, capture, 14)
  await page.getByRole('button', { name: 'Re-sync & reconcile' }).click()
  await assertVisible(page.getByRole('heading', { name: 'Reconcile your review' }), 'reconcile dialog')
  await assertVisible(page.getByText(/Anchors cleanly ·/), 'clean reconcile group')
  await page.waitForTimeout(500)
  await hold(page, capture, 24)
})

// ————————————————————————————————————————————————————————————————
// Flow 4 — identity-switch draft isolation: one human's pending draft is not the
// other's. Priya opens with a seeded draft; switching to another human via the
// dev panel shows an empty rail, proving drafts are keyed per human.
// ————————————————————————————————————————————————————————————————
await record('draft-isolation', { x: 0, y: 0, width: 1440, height: 900 }, async (page, capture) => {
  await page.goto(withMock('/pr/312/files'), { waitUntil: 'domcontentloaded' })
  await assertVisible(freshSeal(page), 'fresh snapshot seal')
  // The violet review rail carries Priya's seeded pending draft.
  await assertVisible(
    page.getByRole('button', { name: /Submit review · \d+/ }),
    "review rail with Priya's draft",
  )
  await assertVisible(page.getByText(/\d+ pending/).first(), 'pending count on the review rail')
  await page.waitForTimeout(500)
  await hold(page, capture, 16)
  // Open the dev panel and switch the active human.
  await page.getByRole('button', { name: 'Identity and workspace menu' }).click()
  await page.getByRole('menuitem', { name: 'Dev panel…' }).click()
  await assertVisible(page.getByRole('heading', { name: 'Demo controls' }), 'dev panel heading')
  await hold(page, capture, 8)
  await page.getByRole('button', { name: 'Alice Nguyen' }).click()
  await hold(page, capture, 6)
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: 'Demo controls' }).waitFor({ state: 'hidden', timeout: SELECTOR_TIMEOUT })
  // Alice's rail is empty — the draft was Priya's, not hers. The review bar
  // collapses to the "no review in progress" prompt.
  await assertVisible(
    page.getByText(/No review in progress/),
    "empty review rail after switching to Alice",
  )
  await page.waitForTimeout(500)
  await hold(page, capture, 18)
})

await browser.close()
console.log('done')

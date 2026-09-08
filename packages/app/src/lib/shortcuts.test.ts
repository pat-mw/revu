/**
 * The shortcut catalog's internal consistency.
 *
 * The catalog is documentation, not registration — a row here binds nothing,
 * and a binding elsewhere documents nothing. That split makes two kinds of
 * silent breakage possible, and both are structural rather than behavioural, so
 * they are checked here rather than by pressing keys:
 *
 * - **A row nobody can see.** The help sheet iterates a fixed group order and
 *   drops anything outside it, so an entry in an unlisted group renders
 *   nowhere. The order is imported from the sheet rather than restated here; a
 *   copy would agree with itself forever while drifting from what the sheet
 *   actually renders.
 * - **Two rows claiming one gesture.** Whichever registration happens to be
 *   last wins at dispatch, so the loser is a key the app documents and never
 *   honours. Sequences collide the same way single chords do — `g l` and `g l`
 *   are one gesture however they are spelled in the array — so both forms are
 *   normalised to one string before being counted.
 */
import { describe, expect, test } from 'bun:test'
import { GROUP_ORDER } from '@/components/shortcut-sheet'
import { SHORTCUT_CATALOG } from './shortcuts'
import type { ShortcutDef } from './shortcuts'

/** One comparable string per gesture, so a sequence and a chord count alike. */
function gesture(def: ShortcutDef): string {
  return Array.isArray(def.keys) ? def.keys.join('+') : def.keys
}

describe('the shortcut catalog', () => {
  test('names every entry once', () => {
    const ids = SHORTCUT_CATALOG.map((def) => def.id)
    expect(new Set(ids).size).toBe(SHORTCUT_CATALOG.length)
  })

  test('puts every entry in a group the help sheet renders', () => {
    const rendered = new Set<string>(GROUP_ORDER)
    for (const def of SHORTCUT_CATALOG) {
      expect(rendered.has(def.group)).toBe(true)
    }
  })

  test('lets no two entries claim the same keys', () => {
    const gestures = SHORTCUT_CATALOG.map(gesture)
    expect(new Set(gestures).size).toBe(SHORTCUT_CATALOG.length)
  })
})

describe('the chord that opens a local review', () => {
  const def = SHORTCUT_CATALOG.find((d) => d.id === 'new-local-review')

  test('is in the catalog', () => {
    expect(def).toBeDefined()
  })

  test('is a two-key sequence', () => {
    // A sequence rather than a bare key, and stated as data: the help sheet
    // renders the two presses as two chips joined by "then", and a single
    // string would render as one impossible chord. Array-ness is asserted
    // first, so the length below is only ever read off an array.
    const keys = def?.keys
    expect(Array.isArray(keys)).toBe(true)
    expect(keys).toHaveLength(2)
  })
})

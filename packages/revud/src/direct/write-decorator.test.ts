/**
 * The `WriteDecorator` strategy seam. Direct mode is a pure passthrough: bodies
 * are posted verbatim (no smuggled prefix) and nothing is recorded (GitHub's own
 * attribution is the record). The stamping counterpart — which direct mode never
 * selects — prepends the canonical prefix and delegates recording to a sink; it
 * is proven here so the seam's two ends are both covered.
 */
import { describe, expect, test } from 'bun:test'
import type { Human } from '@revu/shared'
import {
  createDirectWriteDecorator,
  createStampingWriteDecorator,
} from './write-decorator'

const HUMAN: Human = { id: 'a@x.io', name: 'Alice Nguyen', role: 'contractor', email: 'a@x.io' }

describe('createDirectWriteDecorator (passthrough)', () => {
  test('decorateBody returns the body verbatim — no prefix, no email', () => {
    const d = createDirectWriteDecorator(HUMAN)
    expect(d.decorateBody('looks good')).toBe('looks good')
    expect(d.decorateBody('')).toBe('')
    // The human email must never leak into a decorated body in direct mode.
    expect(d.decorateBody('hi')).not.toContain('a@x.io')
  })

  test('recordWrite is a no-op that does not throw', () => {
    const d = createDirectWriteDecorator(HUMAN)
    expect(() => d.recordWrite(12345)).not.toThrow()
  })
})

describe('createStampingWriteDecorator (broker counterpart)', () => {
  test('decorateBody prepends the canonical name/role prefix', () => {
    const recorded: number[] = []
    const d = createStampingWriteDecorator(HUMAN, (id) => recorded.push(id))
    const out = d.decorateBody('needs a test')
    expect(out.startsWith('**Alice Nguyen** (contractor)')).toBe(true)
    expect(out).toContain('needs a test')
  })

  test('an empty body stays empty (no bare prefix on a bodyless review)', () => {
    const d = createStampingWriteDecorator(HUMAN, () => {})
    expect(d.decorateBody('')).toBe('')
    expect(d.decorateBody('   ')).toBe('   ')
  })

  test('recordWrite forwards the GitHub id to the sink', () => {
    const recorded: number[] = []
    const d = createStampingWriteDecorator(HUMAN, (id) => recorded.push(id))
    d.recordWrite(2054417)
    expect(recorded).toEqual([2054417])
  })
})

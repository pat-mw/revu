import { describe, expect, test } from 'bun:test'
import type { CheckRun } from '@revu/shared'
import { countChecks, rollupChecks } from './checks-rollup'

/** A check run reduced to what the rollup reads: its status and conclusion. */
function run(
  status: CheckRun['status'],
  conclusion: CheckRun['conclusion'],
  name = 'build',
): CheckRun {
  return {
    id: 1,
    name,
    status,
    conclusion,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: status === 'completed' ? '2026-01-01T00:01:00.000Z' : null,
    details_url: 'https://example.invalid/run',
    output: { title: null, summary: null },
  }
}

describe('countChecks', () => {
  test('buckets by outcome and counts every run in the total', () => {
    const counts = countChecks([
      run('completed', 'success'),
      run('completed', 'success'),
      run('completed', 'failure'),
      run('in_progress', null),
      run('queued', null),
    ])
    expect(counts).toEqual({ passed: 2, failed: 1, running: 2, total: 5 })
  })

  test('timed out and cancelled runs are failures', () => {
    const counts = countChecks([
      run('completed', 'timed_out'),
      run('completed', 'cancelled'),
    ])
    expect(counts.failed).toBe(2)
  })

  test('neutral and skipped land in no bucket but still count toward the total', () => {
    const counts = countChecks([run('completed', 'neutral'), run('completed', 'skipped')])
    expect(counts).toEqual({ passed: 0, failed: 0, running: 0, total: 2 })
  })

  test('an empty set is all zeroes', () => {
    expect(countChecks([])).toEqual({ passed: 0, failed: 0, running: 0, total: 0 })
  })
})

describe('rollupChecks', () => {
  test('no runs at all yields no rollup rather than a green one', () => {
    expect(rollupChecks([])).toBeUndefined()
  })

  test('all settled and nothing red is success', () => {
    expect(rollupChecks([run('completed', 'success'), run('completed', 'skipped')])).toEqual({
      state: 'success',
      total: 2,
    })
  })

  test('anything still going is pending', () => {
    expect(rollupChecks([run('completed', 'success'), run('in_progress', null)])).toEqual({
      state: 'pending',
      total: 2,
    })
  })

  test('a red run outranks work still in flight', () => {
    expect(
      rollupChecks([
        run('completed', 'failure'),
        run('in_progress', null),
        run('completed', 'success'),
      ]),
    ).toEqual({ state: 'failure', total: 3 })
  })

  test('the total is every run, not just the bucketed ones', () => {
    expect(rollupChecks([run('completed', 'neutral')])).toEqual({
      state: 'success',
      total: 1,
    })
  })
})

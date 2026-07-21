/**
 * Reduce a commit's check runs to what a reader needs at a glance.
 *
 * Two surfaces ask the same question of the same data — the PR header wants
 * "how many passed out of how many", the pull list wants a single coloured
 * verdict — and both must answer it identically. A list row saying a pull is
 * green while its header shows a red check is the kind of contradiction that
 * costs a reader all trust in the indicator, so the counting lives here once
 * and both surfaces project from it.
 *
 * Pure: no fetching, no ordering assumptions, no dependence on where the runs
 * came from.
 */
import type { CheckRun, ChecksRollup } from '@revu/shared'

/** Check runs bucketed by outcome. Buckets need not sum to `total`. */
export interface CheckCounts {
  passed: number
  failed: number
  /** Anything not yet `completed` — queued or in progress. */
  running: number
  /** Every run considered, including outcomes in no bucket. */
  total: number
}

/**
 * Bucket check runs by outcome.
 *
 * A run that finished `neutral` or `skipped` lands in NO bucket while still
 * counting toward `total`. That is deliberate: a skipped job neither passed nor
 * failed nor is it still working, and inflating either bucket would misreport
 * the state of the pull. It does count toward `total` because it is a check the
 * repository configured and a reader scanning the list should see it exists.
 */
export function countChecks(checks: CheckRun[]): CheckCounts {
  let passed = 0
  let failed = 0
  let running = 0
  for (const c of checks) {
    if (c.status !== 'completed') running++
    else if (c.conclusion === 'success') passed++
    else if (
      c.conclusion === 'failure' ||
      c.conclusion === 'timed_out' ||
      c.conclusion === 'cancelled'
    ) {
      failed++
    }
  }
  return { passed, failed, running, total: checks.length }
}

/**
 * Collapse check runs to the single coarse verdict a list row carries.
 *
 * Precedence is failure → pending → success, because that is the order a
 * reader's attention should follow: a red run matters even while others are
 * still going, and only a fully-settled set with nothing red is green.
 *
 * An EMPTY set yields `undefined`, not a green rollup. A pull with no CI
 * configured and one whose first job has not registered yet are the same fact
 * from the outside, and neither is a passing build — claiming success for
 * either would be an indicator that lies.
 */
export function rollupChecks(checks: CheckRun[]): ChecksRollup | undefined {
  const counts = countChecks(checks)
  if (counts.total === 0) return undefined
  const state =
    counts.failed > 0 ? 'failure' : counts.running > 0 ? 'pending' : 'success'
  return { state, total: counts.total }
}

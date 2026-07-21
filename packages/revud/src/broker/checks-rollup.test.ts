import { describe, expect, test } from 'bun:test'
import type { ChecksRollup, PullListItem } from '@revu/shared'
import {
  CONFORMANCE_REPO,
  fakePollSources,
  initialPollState,
  mutatePulls,
} from '../direct/conformance-fakes'
import type { FakePull, PollFakeState } from '../direct/conformance-fakes'
import { brokerEtag, createPollLoop } from './poll-loop'
import type { PollFactsSource } from './poll-loop'

/**
 * The CI rollup the broker serves on each list row, and the one thing that can
 * move while every other input — the upstream list included — stands still.
 *
 * Two properties are load-bearing and are what this suite exists to hold:
 * the rollup must be reachable through the served ETag (a rollup that changes
 * behind a matching ETag never reaches the frontend at all), and it must never
 * be allowed to lie — a build that finished has to stop reading as "running",
 * and a rollup nobody could observe has to keep its last true value rather than
 * being blanked or invented.
 */

/** A pull row for the poll fake, defaulting everything the rollup does not care about. */
function pull(number: number, overrides: Partial<FakePull> = {}): FakePull {
  return {
    number,
    headSha: `HEAD-${number}`,
    baseSha: `BASE-${number}`,
    updatedAt: `2026-02-0${number % 9}T00:00:00.000Z`,
    unresolvedThreads: 0,
    commitCount: 1,
    mergeBaseSha: `MB-${number}`,
    ...overrides,
  }
}

/** A served list row carrying only what the ETag's annotation hash reads. */
function item(number: number, checks?: ChecksRollup): PullListItem {
  return {
    pull: {
      id: number,
      node_id: `PR_${number}`,
      number,
      state: 'open',
      draft: false,
      merged_at: null,
      title: `PR #${number}`,
      body: null,
      user: {
        login: 'author',
        id: 2,
        node_id: 'U_2',
        avatar_url: '',
        html_url: '',
        type: 'User',
      },
      labels: [],
      requested_reviewers: [],
      head: {
        ref: 'feature',
        sha: `HEAD-${number}`,
        label: 'o:feature',
        repo: { full_name: 'o/r', default_branch: 'main' },
      },
      base: {
        ref: 'main',
        sha: `BASE-${number}`,
        label: 'o:main',
        repo: { full_name: 'o/r', default_branch: 'main' },
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    },
    broker: {
      authorHumanId: null,
      canApprove: true,
      unresolvedThreads: 0,
      assignedReviewerHumanIds: [],
      compareKey: `MB-${number}...HEAD-${number}`,
      commitCount: 1,
      ...(checks === undefined ? {} : { checks }),
    },
  }
}

function buildLoop(state: PollFakeState, deps: { maxStaleTicks?: number } = {}) {
  const { client, facts } = fakePollSources(state)
  return createPollLoop({ client, facts, repo: CONFORMANCE_REPO, ...deps })
}

/** The rollup on a served row, or undefined when the row carries none. */
function rollupOf(items: PullListItem[], number: number): ChecksRollup | undefined {
  return items.find((it) => it.pull.number === number)?.broker.checks
}

describe('the broker ETag reaches the CI rollup', () => {
  test('the ETag moves when ONLY the rollup differs, with the list ETag held constant', () => {
    // The landmine: if the rollup were outside the hashed annotations, a client
    // holding the old ETag would 304 forever and keep a stale CI indicator. The
    // list ETag is byte-identical across all three of these — the rollup is the
    // only thing that differs.
    const listEtag = 'gh-list-etag-fixed'
    const pending = brokerEtag(listEtag, [item(101, { state: 'pending', total: 3 })])
    const failed = brokerEtag(listEtag, [item(101, { state: 'failure', total: 3 })])
    const succeeded = brokerEtag(listEtag, [item(101, { state: 'success', total: 3 })])

    expect(failed).not.toBe(pending)
    expect(succeeded).not.toBe(pending)
    expect(succeeded).not.toBe(failed)
  })

  test('the ETag moves when the check COUNT changes under the same state', () => {
    const listEtag = 'gh-list-etag-fixed'
    expect(brokerEtag(listEtag, [item(101, { state: 'success', total: 3 })])).not.toBe(
      brokerEtag(listEtag, [item(101, { state: 'success', total: 4 })]),
    )
  })

  test('a rollup appearing or disappearing moves the ETag', () => {
    const listEtag = 'gh-list-etag-fixed'
    const absent = brokerEtag(listEtag, [item(101)])
    const present = brokerEtag(listEtag, [item(101, { state: 'success', total: 1 })])
    expect(present).not.toBe(absent)
  })

  test('an unchanged rollup leaves the ETag byte-identical', () => {
    // The other half of the contract: the ETag must not churn, or every poll
    // becomes a 200 and the conditional read stops being free.
    const listEtag = 'gh-list-etag-fixed'
    expect(brokerEtag(listEtag, [item(101, { state: 'pending', total: 2 })])).toBe(
      brokerEtag(listEtag, [item(101, { state: 'pending', total: 2 })]),
    )
  })
})

describe('the poll loop serves the rollup', () => {
  test('a refreshed pull carries the rollup the batched facts reported', async () => {
    const state = initialPollState([
      pull(101, { checks: { state: 'failure', total: 4 } }),
      pull(202, { checks: { state: 'pending', total: 2 } }),
    ])
    const loop = buildLoop(state)
    await loop.pollOnce()

    const items = loop.listPulls(null).items
    expect(rollupOf(items, 101)).toEqual({ state: 'failure', total: 4 })
    expect(rollupOf(items, 202)).toEqual({ state: 'pending', total: 2 })
  })

  test('a pull with nothing reporting carries NO rollup key at all', async () => {
    // Absent is the contract's "nothing has reported". A fabricated green rollup
    // for a repo with no CI would be an indicator that lies.
    const state = initialPollState([pull(101, { checks: null })])
    const loop = buildLoop(state)
    await loop.pollOnce()

    const row = loop.listPulls(null).items[0]!
    expect(row.broker.checks).toBeUndefined()
    expect('checks' in row.broker).toBe(false)
  })

  test('an observed empty rollup CLEARS a rollup that was being served', async () => {
    // A head that moved to a commit no workflow runs on must stop advertising
    // the old commit's result.
    const state = initialPollState([pull(101, { checks: { state: 'success', total: 2 } })])
    const loop = buildLoop(state)
    await loop.pollOnce()
    expect(rollupOf(loop.listPulls(null).items, 101)).toEqual({ state: 'success', total: 2 })

    mutatePulls(state, (pulls) => {
      const p = pulls.find((x) => x.number === 101)!
      p.headSha = 'HEAD-101-b'
      p.checks = null
    })
    await loop.pollOnce()
    expect(rollupOf(loop.listPulls(null).items, 101)).toBeUndefined()
  })
})

describe('a finished build reaches a client holding the prior ETag', () => {
  test('CI completing during an upstream 304 flips the served ETag and the SAME conditional GET becomes a 200', async () => {
    // The scenario the whole track exists for. A CI run completing moves no head
    // SHA, no base SHA and no `updated_at`, so the upstream list still 304s —
    // the list ETag is held constant throughout, which the non-304 counter
    // proves. If the served ETag did not move with the rollup, the frontend's
    // conditional GET would keep matching and it would never learn the build
    // failed.
    const state = initialPollState([
      pull(101, { checks: { state: 'pending', total: 3 } }),
      pull(202, { checks: { state: 'success', total: 1 } }),
    ])
    const loop = buildLoop(state)
    await loop.pollOnce()

    const first = loop.listPulls(null)
    expect(rollupOf(first.items, 101)).toEqual({ state: 'pending', total: 3 })
    // The frontend caches this ETag; re-presenting it right now is a 304.
    expect(loop.listPulls(first.etag).notModified).toBe(true)
    expect(state.nonNotModified).toBe(1)

    // The build finishes. Nothing else about the pull moves — mutated WITHOUT
    // bumping the fake's ETag sequence, so the upstream list is untouched.
    state.pulls.find((p) => p.number === 101)!.checks = { state: 'failure', total: 3 }
    await loop.pollOnce()

    // The upstream list genuinely 304'd: the non-304 count did not move.
    expect(state.nonNotModified).toBe(1)

    // The client's cached ETag no longer matches, and the fresh 200 carries the
    // new CI state.
    const second = loop.listPulls(first.etag)
    expect(second.notModified).toBe(false)
    expect(second.etag).not.toBe(first.etag)
    expect(rollupOf(second.items, 101)).toEqual({ state: 'failure', total: 3 })
    // The settled pull is untouched by the sweep.
    expect(rollupOf(second.items, 202)).toEqual({ state: 'success', total: 1 })
  })

  test('once every rollup has settled the idle tick asks nothing and the ETag holds', async () => {
    // The sweep is bounded by CI actually in flight: with nothing pending there
    // is no facts query at all, so an idle broker stays free.
    const state = initialPollState([
      pull(101, { checks: { state: 'success', total: 1 } }),
      pull(202, { checks: { state: 'failure', total: 2 } }),
    ])
    const loop = buildLoop(state)
    await loop.pollOnce()
    const warm = loop.listPulls(null)
    const queriesAfterWarm = state.factsQueries

    for (let i = 0; i < 4; i++) await loop.pollOnce()

    expect(state.factsQueries).toBe(queriesAfterWarm)
    expect(state.nonNotModified).toBe(1)
    expect(loop.listPulls(warm.etag).notModified).toBe(true)
  })

  test('a pending rollup keeps being re-asked until it settles', async () => {
    const state = initialPollState([pull(101, { checks: { state: 'pending', total: 1 } })])
    const loop = buildLoop(state)
    await loop.pollOnce()
    const afterWarm = state.factsQueries

    // Two idle ticks, each one sweep, because the rollup is still in flight.
    await loop.pollOnce()
    await loop.pollOnce()
    expect(state.factsQueries).toBe(afterWarm + 2)

    // It settles; the tick that observes that is the last one to ask.
    state.pulls[0]!.checks = { state: 'success', total: 1 }
    await loop.pollOnce()
    const afterSettle = state.factsQueries
    await loop.pollOnce()
    expect(state.factsQueries).toBe(afterSettle)
    expect(rollupOf(loop.listPulls(null).items, 101)).toEqual({ state: 'success', total: 1 })
  })
})

describe('a checks failure is isolated to the pull it happened to', () => {
  test('a facts source that answers without a rollup leaves the prior one standing', async () => {
    // Not observed is not the same as nothing reported. Dropping the rollup here
    // would blink the indicator off on a pull whose CI is perfectly fine.
    const state = initialPollState([pull(101, { checks: { state: 'success', total: 5 } })])
    const loop = buildLoop(state)
    await loop.pollOnce()
    expect(rollupOf(loop.listPulls(null).items, 101)).toEqual({ state: 'success', total: 5 })

    // The pull changes, and this time the query answers with no rollup field.
    mutatePulls(state, (pulls) => {
      const p = pulls.find((x) => x.number === 101)!
      p.headSha = 'HEAD-101-b'
      p.commitCount = 9
      delete p.checks
    })
    await loop.pollOnce()

    const row = loop.listPulls(null).items[0]!
    expect(row.broker.checks).toEqual({ state: 'success', total: 5 })
    // The rest of the pull's facts refreshed normally — only the rollup carried.
    expect(row.broker.commitCount).toBe(9)
  })

  test('one pull losing its rollup neither fails the tick nor disturbs the others', async () => {
    const state = initialPollState([
      pull(101, { checks: { state: 'pending', total: 2 } }),
      pull(202, { checks: { state: 'pending', total: 1 } }),
    ])
    const { client, facts } = fakePollSources(state)
    // A facts source that drops #101 from the answer entirely — the shape a
    // number GitHub could not resolve takes.
    const partialFacts: PollFactsSource = {
      async getPullFacts(owner, repo, prNumbers) {
        const all = await facts.getPullFacts(owner, repo, prNumbers)
        delete all[101]
        return all
      },
      getCompare: facts.getCompare,
    }
    const loop = createPollLoop({
      client,
      facts: partialFacts,
      repo: CONFORMANCE_REPO,
      maxStaleTicks: 2,
    })
    await loop.pollOnce()

    // #101 was never observed, so it serves no rollup rather than a made-up one;
    // #202 refreshed normally and the tick counts as a success.
    const items = loop.listPulls(null).items
    expect(rollupOf(items, 101)).toBeUndefined()
    expect(rollupOf(items, 202)).toEqual({ state: 'pending', total: 1 })
    expect(() => loop.listPulls(null)).not.toThrow()
  })

  test("a pull whose compare fails still picks up its fresh rollup", async () => {
    // The compare and the rollup come from different requests; a broken compare
    // is no reason to freeze the CI indicator.
    const state = initialPollState([pull(101, { checks: { state: 'pending', total: 2 } })])
    const { client, facts } = fakePollSources(state)
    const brokenCompare: PollFactsSource = {
      getPullFacts: facts.getPullFacts,
      async getCompare(owner, repo, base, head) {
        if (head === 'HEAD-101-b') throw new Error('compare 404 for one pull')
        return facts.getCompare(owner, repo, base, head)
      },
    }
    const loop = createPollLoop({ client, facts: brokenCompare, repo: CONFORMANCE_REPO })
    await loop.pollOnce()
    expect(loop.listPulls(null).items[0]!.broker.compareKey).toBe('MB-101...HEAD-101')

    mutatePulls(state, (pulls) => {
      const p = pulls.find((x) => x.number === 101)!
      p.headSha = 'HEAD-101-b'
      p.checks = { state: 'failure', total: 2 }
    })
    await loop.pollOnce()

    const row = loop.listPulls(null).items[0]!
    // The compare key could not refresh and carried forward…
    expect(row.broker.compareKey).toBe('MB-101...HEAD-101')
    // …but the rollup, which never depended on it, is current.
    expect(row.broker.checks).toEqual({ state: 'failure', total: 2 })
  })

  test('a sweep that fails on an idle tick keeps the last true rollup and does not trip the tripwire', async () => {
    // Before the sweep existed a 304 tick made no upstream facts call at all, so
    // a failing sweep must not make an idle broker MORE fragile than it was. The
    // rollup stays at its last observed value, which remains the honest reading.
    const state = initialPollState([pull(101, { checks: { state: 'pending', total: 3 } })])
    const { client, facts } = fakePollSources(state)
    let sweepFailing = false
    const flakyFacts: PollFactsSource = {
      async getPullFacts(owner, repo, prNumbers) {
        if (sweepFailing) throw new Error('GraphQL rate bucket exhausted')
        return facts.getPullFacts(owner, repo, prNumbers)
      },
      getCompare: facts.getCompare,
    }
    const loop = createPollLoop({
      client,
      facts: flakyFacts,
      repo: CONFORMANCE_REPO,
      maxStaleTicks: 2,
    })
    await loop.pollOnce()
    const warm = loop.listPulls(null)

    sweepFailing = true
    for (let i = 0; i < 4; i++) await loop.pollOnce()

    // Still serving, still the last thing actually observed, ETag unmoved.
    const after = loop.listPulls(null)
    expect(rollupOf(after.items, 101)).toEqual({ state: 'pending', total: 3 })
    expect(after.etag).toBe(warm.etag)

    // And the sweep recovering picks the new state straight up.
    sweepFailing = false
    state.pulls[0]!.checks = { state: 'success', total: 3 }
    await loop.pollOnce()
    expect(rollupOf(loop.listPulls(null).items, 101)).toEqual({ state: 'success', total: 3 })
  })
})

/**
 * The collector merge core, exercised with a REAL in-memory host store and
 * injected fakes for the pull source and the GitHub read client — no network,
 * no docker, no environment. The suite pins the security contract: every
 * pulled record lands keyed by the container's channel-authentic `coderOwner`
 * (never by identity claimed inside the payload), an unbound container lands
 * nothing while the tick carries on, landing failures are isolated and
 * sanitized, and the out-of-band detector runs AFTER all containers land,
 * over the merged all-humans union — so a write mediated by one container is
 * never flagged just because another container's journal has not heard of it.
 * It also pins the structural robustness contract: pulled data is
 * attacker-shaped JSON despite the compile-time types, so no shape of pull
 * result — a non-array, a null element, a non-array record list — may reject
 * the tick; every element yields a recorded outcome, detection hints are
 * taken from every container regardless of binding or landing outcome, and a
 * reconcile failure on one PR is isolated into `reconcileErrors` without
 * losing any other PR's report.
 */
import { describe, expect, test } from 'bun:test'
import type { FileViewedState, ReviewDraft } from '@revu/shared'
import type { Page } from '../direct/github-client'
import type { OutOfBandReadClient } from '../broker/out-of-band-writes'
import { StoreWriteError, type AuditEntry } from '../direct/store'
import { createMapCoderOwnerResolver } from './identity-binding'
import { openHostStore, type HostStore } from './host-store'
import {
  runCollectorTick,
  type CollectorPullSource,
  type CollectorTickDeps,
  type PulledContainer,
} from './collector'

const BOT_LOGIN = 'revu-app[bot]'
const BOT = { login: BOT_LOGIN, id: 111, type: 'Bot' }
const REPO = { owner: 'o', repo: 'r' }

/** Bindings for the humans these tests know about; `mallory` is deliberately absent. */
const resolver = createMapCoderOwnerResolver({
  alice: { email: 'alice@corp.com' },
  bob: { email: 'bob@corp.com' },
})

function openStore(): HostStore {
  return openHostStore({ resolver, dataDir: ':memory:' })
}

function draft(humanId: string, prNumber: number, body: string): ReviewDraft {
  return {
    humanId,
    prNumber,
    headSha: 'head',
    compareKey: 'base...head',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function viewedState(): FileViewedState {
  return { 'a.ts': { viewed: true, blobSha: 's1', at: '2026-01-01T00:00:00.000Z' } }
}

/**
 * A pulled journal row. The identity fields default to workspace-claimed
 * garbage on purpose: the merge must land rows correctly WITHOUT trusting them.
 */
function auditRow(over: Partial<AuditEntry>): AuditEntry {
  return {
    githubId: 9001,
    humanId: 'workspace-claimed@spoof.io',
    workspace: 'workspace-claimed-label',
    endpoint: 'submitReview',
    pr: 7,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function container(over: Partial<PulledContainer> & Pick<PulledContainer, 'coderOwner'>): PulledContainer {
  return { drafts: [], viewed: [], auditRows: [], ...over }
}

function sourceOf(containers: readonly PulledContainer[]): CollectorPullSource {
  return { pull: async () => containers }
}

/**
 * A pull source returning ARBITRARY junk, modeling what the attacker-shaped
 * channel can actually deliver at runtime regardless of the compile-time type.
 */
function rawSource(value: unknown): CollectorPullSource {
  return { pull: async () => value as readonly PulledContainer[] }
}

/** Raw REST-shaped fixtures — only the fields the reconcile maps. */
function ghReview(id: number, user: unknown): unknown {
  return { id, state: 'COMMENTED', user, body: 'r' }
}
function ghIssueComment(id: number, user: unknown): unknown {
  return { id, body: 'c', user }
}

interface PrRemote {
  reviews?: unknown[]
  reviewComments?: unknown[]
  issueComments?: unknown[]
}

/** A fake read client serving canned single-page artifact lists per PR. */
function fakeGithub(byPr: Record<number, PrRemote>): OutOfBandReadClient {
  const page = (items: unknown[] | undefined): Page<unknown> => ({
    items: items ?? [],
    hasNext: false,
  })
  return {
    async getPullReviews(_o, _r, pr) {
      return page(byPr[pr]?.reviews)
    },
    async getPullReviewComments(_o, _r, pr) {
      return page(byPr[pr]?.reviewComments)
    },
    async getIssueComments(_o, _r, pr) {
      return page(byPr[pr]?.issueComments)
    },
  }
}

function deps(
  store: HostStore,
  containers: readonly PulledContainer[],
  byPr: Record<number, PrRemote> = {},
): CollectorTickDeps {
  return {
    source: sourceOf(containers),
    store,
    github: fakeGithub(byPr),
    repo: REPO,
    botLogin: BOT_LOGIN,
  }
}

describe('runCollectorTick — landing keyed by the channel-authentic owner', () => {
  test('a draft pulled from a container lands keyed by that container\'s binding', async () => {
    const store = openStore()
    const report = await runCollectorTick(
      deps(store, [
        container({
          coderOwner: 'bob',
          drafts: [draft('bob@corp.com', 12, 'looks good')],
          viewed: [{ prNumber: 12, state: viewedState() }],
        }),
      ]),
    )

    expect(report.containers).toEqual([
      {
        coderOwner: 'bob',
        bound: true,
        draftsLanded: 1,
        viewedLanded: 1,
        auditLanded: 0,
        auditRejected: [],
      },
    ])
    const landed = store.getDraft('bob', 12)
    expect(landed?.body).toBe('looks good')
    expect(landed?.humanId).toBe('bob@corp.com')
    expect(store.getViewed('bob', 12)).toEqual(viewedState())
    store.close()
  })

  test('channel-key, not payload identity: a spoofed humanId lands under the pulling container\'s binding, and the spoofed human\'s keyspace stays untouched', async () => {
    const store = openStore()
    // Container `bob` claims to be alice in every payload identity field.
    await runCollectorTick(
      deps(store, [
        container({
          coderOwner: 'bob',
          drafts: [draft('alice@corp.com', 5, 'spoofed draft')],
          auditRows: [
            auditRow({ githubId: 70, humanId: 'alice@corp.com', workspace: 'alice', pr: 5 }),
          ],
        }),
      ]),
    )

    // The draft landed under BOB's binding, re-keyed to bob's email.
    expect(store.getDraft('bob', 5)?.humanId).toBe('bob@corp.com')
    // Alice's keyspace is untouched — alice IS bound, so this is a real read.
    expect(store.getDraft('alice', 5)).toBeNull()
    expect(store.listAuditForOwner('alice')).toEqual([])
    // The landed audit rows carry the binding's identity, not the claimed one.
    expect(store.listAuditForOwner('bob')).toEqual([
      {
        githubId: 70,
        humanId: 'bob@corp.com',
        workspace: 'bob',
        endpoint: 'submitReview',
        pr: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    store.close()
  })

  test('an unbound container lands nothing and the tick still lands the bound ones — adding a container needs nothing beyond its binding', async () => {
    const store = openStore()
    const report = await runCollectorTick(
      deps(store, [
        container({ coderOwner: 'alice', drafts: [draft('alice@corp.com', 3, 'a')] }),
        // A second bound container: present in the binding map, zero other setup.
        container({ coderOwner: 'bob', drafts: [draft('bob@corp.com', 3, 'b')] }),
        // Not in the binding map at all.
        container({
          coderOwner: 'mallory',
          drafts: [draft('mallory@evil.io', 3, 'm')],
          auditRows: [auditRow({ githubId: 666, pr: 3 })],
        }),
      ]),
    )

    expect(report.containers).toEqual([
      {
        coderOwner: 'alice',
        bound: true,
        draftsLanded: 1,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
      },
      {
        coderOwner: 'bob',
        bound: true,
        draftsLanded: 1,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
      },
      {
        coderOwner: 'mallory',
        bound: false,
        draftsLanded: 0,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
      },
    ])
    // The bound containers landed; nothing of mallory's reached the store.
    expect(store.getDraft('alice', 3)?.body).toBe('a')
    expect(store.getDraft('bob', 3)?.body).toBe('b')
    expect(store.listAuditUnion()).toEqual([])
    // The unbound container's claimed activity DOES hint the detector: a PR
    // number is an identity-independent reconcile hint, so coverage does not
    // shrink just because the owner is unknown. Nothing of mallory's landed.
    expect(report.reconciledPrs).toEqual([3])
    store.close()
  })

  test('an unbound container that pulled back empty is still reported bound:false', async () => {
    const store = openStore()
    const report = await runCollectorTick(deps(store, [container({ coderOwner: 'mallory' })]))
    expect(report.containers[0].bound).toBe(false)
    store.close()
  })
})

describe('runCollectorTick — the detector runs over the MERGED union', () => {
  test('a write mediated by one container is not flagged against another container\'s journal; only the truly unaccounted write is', async () => {
    const store = openStore()
    // PR 7 on GitHub: three bot-authored reviews. 100 was mediated through
    // alice's container, 200 through bob's — each journaled ONLY in its own
    // container's local journal. 300 was posted out-of-band by no one.
    const byPr: Record<number, PrRemote> = {
      7: { reviews: [ghReview(100, BOT), ghReview(200, BOT), ghReview(300, BOT)] },
    }
    const report = await runCollectorTick(
      deps(
        store,
        [
          container({
            coderOwner: 'alice',
            auditRows: [auditRow({ githubId: 100, endpoint: 'submitReview', pr: 7 })],
          }),
          container({
            coderOwner: 'bob',
            auditRows: [auditRow({ githubId: 200, endpoint: 'submitReview', pr: 7 })],
          }),
        ],
        byPr,
      ),
    )

    expect(report.reconciledPrs).toEqual([7])
    expect(report.outOfBand).toHaveLength(1)
    const pr7 = report.outOfBand[0]
    expect(pr7.pr).toBe(7)
    // Alice's write (absent from bob's journal) and bob's (absent from
    // alice's) are both absolved by the union; only 300 is flagged.
    expect(pr7.outOfBand).toEqual([{ kind: 'review', id: 300, authorLogin: BOT_LOGIN }])
    store.close()
  })

  test('detection sees rows landed on PREVIOUS ticks too: the union is the store, not this tick\'s pull', async () => {
    const store = openStore()
    const byPr: Record<number, PrRemote> = { 7: { reviews: [ghReview(100, BOT)] } }
    // Tick 1: alice's container journals review 100 on PR 7.
    await runCollectorTick(
      deps(
        store,
        [
          container({
            coderOwner: 'alice',
            auditRows: [auditRow({ githubId: 100, endpoint: 'submitReview', pr: 7 })],
          }),
        ],
        byPr,
      ),
    )
    // Tick 2: only bob pulls, with unrelated activity on PR 7. Alice's
    // previously landed row still absolves her mediated review.
    const report = await runCollectorTick(
      deps(
        store,
        [
          container({
            coderOwner: 'bob',
            auditRows: [auditRow({ githubId: 555, endpoint: 'resolveThread', pr: 7 })],
          }),
        ],
        byPr,
      ),
    )
    expect(report.outOfBand[0].outOfBand).toEqual([])
    store.close()
  })

  test('reconciledPrs is the distinct pulled activity set unioned with extraPrNumbers', async () => {
    const store = openStore()
    const report = await runCollectorTick(
      deps(store, [
        container({
          coderOwner: 'alice',
          auditRows: [
            auditRow({ githubId: 1, pr: 3 }),
            auditRow({ githubId: 2, pr: 7 }),
            auditRow({ githubId: 3, pr: 3 }),
          ],
        }),
        container({
          coderOwner: 'bob',
          auditRows: [auditRow({ githubId: 4, pr: 7 })],
        }),
      ]),
      { extraPrNumbers: [7, 12] },
    )
    expect(report.reconciledPrs).toEqual([3, 7, 12])
    expect(report.outOfBand.map((r) => r.pr)).toEqual([3, 7, 12])
    store.close()
  })

  test('with no pulled activity and no extras, the detector reconciles nothing', async () => {
    const store = openStore()
    const report = await runCollectorTick(deps(store, [container({ coderOwner: 'alice' })]))
    expect(report.reconciledPrs).toEqual([])
    expect(report.outOfBand).toEqual([])
    store.close()
  })
})

describe('runCollectorTick — failure isolation', () => {
  test('a store failure on one container is recorded sanitized while the others land and the detector still runs', async () => {
    const store = openStore()
    // Wrap the real store: bob's first landing call blows up with a message
    // that must NOT leak into the report.
    const failing: HostStore = {
      ...store,
      landDraft(coderOwner, d) {
        if (coderOwner === 'bob') {
          throw new StoreWriteError('drafts', new Error('SECRET row contents'))
        }
        store.landDraft(coderOwner, d)
      },
    }
    const byPr: Record<number, PrRemote> = {
      7: { issueComments: [ghIssueComment(900, BOT)] },
    }
    const report = await runCollectorTick(
      deps(
        failing,
        [
          container({ coderOwner: 'bob', drafts: [draft('bob@corp.com', 7, 'x')] }),
          container({
            coderOwner: 'alice',
            drafts: [draft('alice@corp.com', 7, 'fine')],
            auditRows: [auditRow({ githubId: 44, endpoint: 'resolveThread', pr: 7 })],
          }),
        ],
        byPr,
      ),
    )

    const bob = report.containers.find((c) => c.coderOwner === 'bob')
    expect(bob?.bound).toBe(true)
    expect(bob?.error).toBe('StoreWriteError')
    expect(bob?.error).not.toContain('SECRET')
    expect(bob?.draftsLanded).toBe(0)
    // The healthy container landed and the detector still ran over the union.
    expect(store.getDraft('alice', 7)?.body).toBe('fine')
    expect(report.reconciledPrs).toEqual([7])
    expect(report.outOfBand[0].outOfBand).toEqual([
      { kind: 'issue_comment', id: 900, authorLogin: BOT_LOGIN },
    ])
    store.close()
  })

  test('a non-Error throw is reported under a fixed mnemonic, never echoed', async () => {
    const store = openStore()
    const failing: HostStore = {
      ...store,
      landAudit() {
        // A hostile/broken layer can throw literally anything.
        throw 'raw string with row contents'
      },
    }
    const report = await runCollectorTick(
      deps(failing, [container({ coderOwner: 'alice' })]),
    )
    expect(report.containers[0].error).toBe('UnknownError')
    store.close()
  })

  test('a malformed pulled audit row surfaces in that container\'s auditRejected while its valid rows land', async () => {
    const store = openStore()
    const report = await runCollectorTick(
      deps(store, [
        container({
          coderOwner: 'alice',
          auditRows: [
            auditRow({ githubId: 10, pr: 4 }),
            // The workspace journal is attacker-shaped JSON: a wrong-typed id.
            auditRow({ githubId: 'not-a-number' as unknown as number, pr: 4 }),
          ],
        }),
      ]),
    )
    expect(report.containers[0].auditLanded).toBe(1)
    expect(report.containers[0].auditRejected).toEqual([
      { index: 1, reason: 'githubId is not a positive safe integer' },
    ])
    // The valid row landed under alice's binding despite its rejected sibling.
    expect(store.listAuditForOwner('alice', { pr: 4 })).toHaveLength(1)
    store.close()
  })

  test('an error whose NAME does not look like an identifier is collapsed to UnknownError, never echoed', async () => {
    const store = openStore()
    const failing: HostStore = {
      ...store,
      landAudit() {
        // A hostile/alternate error type can fold content into `.name` too.
        const err = new Error('x')
        err.name = 'Error: SECRET row contents smuggled via name'
        throw err
      },
    }
    const report = await runCollectorTick(deps(failing, [container({ coderOwner: 'alice' })]))
    expect(report.containers[0].error).toBe('UnknownError')
    expect(JSON.stringify(report)).not.toContain('SECRET')
    store.close()
  })
})

describe('runCollectorTick — malformed pulled STRUCTURE never rejects the tick', () => {
  test('a null pulled element yields a sentinel outcome while the valid container in the same pull lands and the detector runs', async () => {
    const store = openStore()
    const byPr: Record<number, PrRemote> = {
      9: { issueComments: [ghIssueComment(90, BOT)] },
    }
    const report = await runCollectorTick({
      source: rawSource([
        null,
        container({
          coderOwner: 'alice',
          drafts: [draft('alice@corp.com', 9, 'still lands')],
          auditRows: [auditRow({ githubId: 1, endpoint: 'resolveThread', pr: 9 })],
        }),
      ]),
      store,
      github: fakeGithub(byPr),
      repo: REPO,
      botLogin: BOT_LOGIN,
    })

    expect(report.containers).toEqual([
      {
        coderOwner: '<malformed>',
        bound: false,
        draftsLanded: 0,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
        error: 'MalformedContainer',
      },
      {
        coderOwner: 'alice',
        bound: true,
        draftsLanded: 1,
        viewedLanded: 0,
        auditLanded: 1,
        auditRejected: [],
      },
    ])
    // The healthy container landed and the detector still ran to a finding.
    expect(store.getDraft('alice', 9)?.body).toBe('still lands')
    expect(report.reconciledPrs).toEqual([9])
    expect(report.outOfBand[0].outOfBand).toEqual([
      { kind: 'issue_comment', id: 90, authorLogin: BOT_LOGIN },
    ])
    store.close()
  })

  test('a non-array auditRows lands as empty: bound container recorded, unbound still detected, no throw', async () => {
    const store = openStore()
    const report = await runCollectorTick({
      source: rawSource([
        { coderOwner: 'alice', drafts: [], viewed: [], auditRows: null },
        // The binding is still consulted even with junk rows: unbound stays visible.
        { coderOwner: 'mallory', drafts: [], viewed: [], auditRows: null },
      ]),
      store,
      github: fakeGithub({}),
      repo: REPO,
      botLogin: BOT_LOGIN,
    })
    expect(report.containers).toEqual([
      {
        coderOwner: 'alice',
        bound: true,
        draftsLanded: 0,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
      },
      {
        coderOwner: 'mallory',
        bound: false,
        draftsLanded: 0,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
      },
    ])
    expect(report.reconciledPrs).toEqual([])
    store.close()
  })

  test('a non-array drafts is treated as empty while the container\'s other record kinds still land', async () => {
    const store = openStore()
    const report = await runCollectorTick({
      source: rawSource([
        {
          coderOwner: 'bob',
          drafts: 42,
          viewed: [{ prNumber: 4, state: viewedState() }],
          auditRows: [auditRow({ githubId: 8, pr: 4 })],
        },
      ]),
      store,
      github: fakeGithub({}),
      repo: REPO,
      botLogin: BOT_LOGIN,
    })
    expect(report.containers).toEqual([
      {
        coderOwner: 'bob',
        bound: true,
        draftsLanded: 0,
        viewedLanded: 1,
        auditLanded: 1,
        auditRejected: [],
      },
    ])
    expect(store.getViewed('bob', 4)).toEqual(viewedState())
    expect(report.reconciledPrs).toEqual([4])
    store.close()
  })

  test('elements without a usable coderOwner get the sentinel and never reach the store — but their valid PR hints still count', async () => {
    const store = openStore()
    const report = await runCollectorTick({
      source: rawSource([
        42,
        { coderOwner: 7, auditRows: [auditRow({ githubId: 2, pr: 6 })] },
        { coderOwner: '' },
      ]),
      store,
      github: fakeGithub({}),
      repo: REPO,
      botLogin: BOT_LOGIN,
    })
    expect(report.containers.map((c) => c.coderOwner)).toEqual([
      '<malformed>',
      '<malformed>',
      '<malformed>',
    ])
    for (const c of report.containers) {
      expect(c.bound).toBe(false)
      expect(c.error).toBe('MalformedContainer')
    }
    // Nothing landed; the owner-less element's valid activity still hints detection.
    expect(store.listAuditUnion()).toEqual([])
    expect(report.reconciledPrs).toEqual([6])
    store.close()
  })

  test('a non-array pull result is recorded as MalformedPull and the detector still reconciles the extras', async () => {
    const store = openStore()
    const byPr: Record<number, PrRemote> = { 3: { reviews: [ghReview(30, BOT)] } }
    const report = await runCollectorTick(
      {
        source: rawSource('not an array at all'),
        store,
        github: fakeGithub(byPr),
        repo: REPO,
        botLogin: BOT_LOGIN,
      },
      { extraPrNumbers: [3] },
    )
    expect(report.containers).toEqual([
      {
        coderOwner: '<malformed>',
        bound: false,
        draftsLanded: 0,
        viewedLanded: 0,
        auditLanded: 0,
        auditRejected: [],
        error: 'MalformedPull',
      },
    ])
    expect(report.reconciledPrs).toEqual([3])
    expect(report.outOfBand[0].outOfBand).toEqual([
      { kind: 'review', id: 30, authorLogin: BOT_LOGIN },
    ])
    store.close()
  })
})

describe('runCollectorTick — detection coverage never shrinks', () => {
  test('an unbound container\'s claimed activity still drives detection: a bypass on a PR only it references is flagged', async () => {
    const store = openStore()
    // PR 5 carries a genuine out-of-band bot review. No journal row anywhere
    // accounts for it, and the ONLY thing referencing PR 5 this tick is the
    // unbound mallory container's (untrusted, unlanded) journal.
    const byPr: Record<number, PrRemote> = { 5: { reviews: [ghReview(500, BOT)] } }
    const report = await runCollectorTick(
      deps(
        store,
        [container({ coderOwner: 'mallory', auditRows: [auditRow({ githubId: 999, pr: 5 })] })],
        byPr,
      ),
      // PR 5 deliberately NOT in extraPrNumbers: the hint alone must cover it.
    )
    expect(report.containers[0].bound).toBe(false)
    // Nothing of mallory's landed…
    expect(store.listAuditUnion()).toEqual([])
    // …but PR 5 was still reconciled and the bypass flagged.
    expect(report.reconciledPrs).toEqual([5])
    expect(report.outOfBand[0].outOfBand).toEqual([
      { kind: 'review', id: 500, authorLogin: BOT_LOGIN },
    ])
    store.close()
  })

  test('junk extraPrNumbers entries (NaN, negative, float) are dropped while a valid extra is kept', async () => {
    const store = openStore()
    const report = await runCollectorTick(deps(store, [container({ coderOwner: 'alice' })]), {
      extraPrNumbers: [Number.NaN, -1, 1.5, 9],
    })
    expect(report.reconciledPrs).toEqual([9])
    expect(report.outOfBand.map((r) => r.pr)).toEqual([9])
    store.close()
  })
})

describe('runCollectorTick — per-PR detector isolation', () => {
  test('a reconcile failure on one PR lands in reconcileErrors (sanitized) while the other PRs and container outcomes stand', async () => {
    const store = openStore()
    const byPr: Record<number, PrRemote> = {
      6: { issueComments: [ghIssueComment(60, BOT)] },
    }
    const healthy = fakeGithub(byPr)
    const github: OutOfBandReadClient = {
      ...healthy,
      async getPullReviews(owner, repo, pr, params) {
        if (pr === 5) {
          // A transient GitHub failure whose message must never surface.
          const err = new Error('SECRET response body for PR 5')
          err.name = 'HttpError'
          throw err
        }
        return healthy.getPullReviews(owner, repo, pr, params)
      },
    }
    const report = await runCollectorTick({
      source: sourceOf([
        container({
          coderOwner: 'alice',
          auditRows: [
            auditRow({ githubId: 1, endpoint: 'resolveThread', pr: 5 }),
            auditRow({ githubId: 2, endpoint: 'resolveThread', pr: 6 }),
          ],
        }),
      ]),
      store,
      github,
      repo: REPO,
      botLogin: BOT_LOGIN,
    })

    // The landing phase was untouched by the reconcile failure.
    expect(report.containers).toEqual([
      {
        coderOwner: 'alice',
        bound: true,
        draftsLanded: 0,
        viewedLanded: 0,
        auditLanded: 2,
        auditRejected: [],
      },
    ])
    expect(report.reconciledPrs).toEqual([5, 6])
    // PR 6 reconciled normally; PR 5 failed closed into reconcileErrors.
    expect(report.outOfBand.map((r) => r.pr)).toEqual([6])
    expect(report.outOfBand[0].outOfBand).toEqual([
      { kind: 'issue_comment', id: 60, authorLogin: BOT_LOGIN },
    ])
    expect(report.reconcileErrors).toEqual([{ pr: 5, error: 'HttpError' }])
    expect(JSON.stringify(report)).not.toContain('SECRET')
    store.close()
  })

  test('with no reconcile failures the report\'s reconcileErrors is empty', async () => {
    const store = openStore()
    const report = await runCollectorTick(deps(store, [container({ coderOwner: 'alice' })]), {
      extraPrNumbers: [2],
    })
    expect(report.reconcileErrors).toEqual([])
    expect(report.outOfBand.map((r) => r.pr)).toEqual([2])
    store.close()
  })
})

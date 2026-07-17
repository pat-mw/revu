/**
 * Headless smoke test for the mock adapter + fixtures, run with:
 *   bun run scripts/smoke.ts
 * Exercises every fixture scenario the UI depends on, without a browser.
 * Browser globals the mock layer touches (localStorage, window events) are
 * shimmed below.
 */

const storage = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size
  },
}
if (!('window' in globalThis)) {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
if (!('document' in globalThis)) {
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
}

const { createMockApi } = await import('../src/api/mock/adapter')
const { mockDev } = await import('../src/api/mock/devtools')
const { parseCommentIdentity } = await import('../src/lib/identity')
const { ApiError } = await import('../src/api/types')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}`, detail ?? '')
  }
}

mockDev.setLatency('zero')
mockDev.setFailureMode('none')
const api = createMockApi()

// ——— session & list ———
const session = await api.getSession()
check('session is default human h-priya', session.human.id === 'h-priya', session.human)

const list = await api.listPulls()
check('list has 10 pulls', list.items.length === 10, list.items.length)
const numbers = list.items.map((i) => i.pull.number).sort((a, b) => a - b)
check(
  'pull numbers complete',
  JSON.stringify(numbers) === JSON.stringify([101, 204, 312, 347, 355, 362, 389, 401, 410, 415]),
  numbers,
)
const again = await api.listPulls({ etag: list.etag })
check('etag match → notModified', again.notModified === true)

// ——— seeded state (312) ———
const snap312 = await api.getSnapshot(312)
check('312 seeded snapshot exists', snap312 !== null)
const draft312 = await api.getDraft(312)
check('312 seeded draft has 1 pending comment', draft312?.comments.length === 1, draft312)
const viewed312 = await api.getFileViewed(312)
check('312 seeded viewed has 2 files', Object.values(viewed312).filter((v) => v.viewed).length === 2)

// ——— first sync (101) ———
check('101 starts unsynced', (await api.getSnapshot(101)) === null)
const snap101 = await api.syncPull(101)
check('101 sync fetched blobs', (snap101.syncStats?.blobsFetched ?? 0) > 0, snap101.syncStats)
const headSha101 = snap101.immutable.blobIndex[snap101.immutable.files[0].filename]?.head
check('101 head blob readable', !!headSha101 && (await api.getBlob(headSha101!)).content.length > 0)

// ——— partial sync (401) ———
let partialThrew = false
try {
  await api.syncPull(401)
} catch (e) {
  partialThrew = e instanceof ApiError && e.code === 'network'
}
check('401 first sync throws network ApiError', partialThrew)
const partial401 = await api.getSnapshot(401)
check('401 partial snapshot kept', partial401?.partial !== null && partial401 !== null, partial401?.partial)
check(
  '401 partial names missing blobs',
  (partial401?.partial?.missingBlobShas.length ?? 0) > 0,
  partial401?.partial?.missingBlobShas.length,
)
const retry401 = await api.syncPull(401)
check('401 retry succeeds, no partial', retry401.partial === null)
check('401 retry fetched exactly the missing blobs', retry401.syncStats?.blobsFetched === partial401?.partial?.missingBlobShas.length, retry401.syncStats)

// ——— reconcile fixture (389) ———
const old389 = await api.getSnapshot(389)
const draft389 = await api.getDraft(389)
check('389 seeded snapshot behind remote', old389 !== null && draft389 !== null)
check('389 draft targets old head', draft389!.headSha === old389!.immutable.headSha)
const li389 = (await api.listPulls()).items.find((i) => i.pull.number === 389)!
check('389 list shows moved head', li389.pull.head.sha !== old389!.immutable.headSha)
check(
  '389 commit delta = 3',
  li389.broker.commitCount - old389!.immutable.commits.length === 3,
  { broker: li389.broker.commitCount, snap: old389!.immutable.commits.length },
)
await api.syncPull(389)
const report = await api.reconcileDraft(389)
const kinds = report.results.map((r) => r.kind).sort()
check('389 reconcile → clean/drifted/lost', JSON.stringify(kinds) === JSON.stringify(['clean', 'drifted', 'lost']), report.results)
const drifted = report.results.find((r) => r.kind === 'drifted')
check('389 drifted delta is +12', drifted?.kind === 'drifted' && drifted.delta === 12, drifted)
check('389 reconcile lists 3 new commits', report.newCommits.length === 3, report.newCommits.length)

// ——— base advanced (410) ———
const snap410 = await api.getSnapshot(410)
const li410 = (await api.listPulls()).items.find((i) => i.pull.number === 410)!
check('410 head unchanged', li410.pull.head.sha === snap410!.immutable.headSha)
check('410 compareKey moved (base advanced)', li410.broker.compareKey !== snap410!.immutable.compareKey, {
  live: li410.broker.compareKey,
  snap: snap410!.immutable.compareKey,
})
const resync410 = await api.syncPull(410)
check('410 re-sync rebuilt immutable', resync410.immutable.compareKey === li410.broker.compareKey)
check('410 gained gc-config in compare', resync410.immutable.files.some((f) => f.filename.includes('gc-config')))

// ——— mutable drift (415) ———
const snap415 = await api.getSnapshot(415)
const unresolvedBefore = snap415!.mutable.threads.filter((t) => !t.isResolved).length
const li415 = (await api.listPulls()).items.find((i) => i.pull.number === 415)!
check('415 broker sees fewer unresolved than stale snapshot', li415.broker.unresolvedThreads < unresolvedBefore, {
  broker: li415.broker.unresolvedThreads,
  snapshot: unresolvedBefore,
})
const resync415 = await api.syncPull(415)
check('415 re-sync reused every blob', resync415.syncStats?.blobsFetched === 0, resync415.syncStats)
check(
  '415 thread now resolved, same compareKey',
  resync415.immutable.compareKey === snap415!.immutable.compareKey &&
    resync415.mutable.threads.filter((t) => !t.isResolved).length === li415.broker.unresolvedThreads,
)

// ——— submit paths (312) ———
const moved = await api.submitReview({
  prNumber: 312,
  expectedHeadSha: 'not-the-real-head',
  event: 'COMMENT',
  body: '',
  comments: draft312!.comments,
})
check('312 submit vs wrong head → head_moved', moved.status === 'head_moved', moved)
const forbidden = await api.submitReview({
  prNumber: 312,
  expectedHeadSha: snap312!.immutable.headSha,
  event: 'APPROVE',
  body: 'lgtm',
  comments: [],
})
check('312 APPROVE → forbidden (App-authored)', forbidden.status === 'forbidden')
const before312 = (await api.listReviewThreads(312)).length
const ok312 = await api.submitReview({
  prNumber: 312,
  expectedHeadSha: snap312!.immutable.headSha,
  event: 'COMMENT',
  body: 'First pass done.',
  comments: draft312!.comments,
})
check('312 COMMENT submit ok', ok312.status === 'ok', ok312)
const after312 = await api.listReviewThreads(312)
check('312 submit created a thread', after312.length === before312 + 1, { before: before312, after: after312.length })
check('312 draft cleared after submit', (await api.getDraft(312)) === null)
const newThread = after312[after312.length - 1]
const parsed = parseCommentIdentity(newThread.comments[0])
check('312 new comment renders as Priya (smuggled identity)', parsed.identity.kind === 'human' && parsed.identity.name === 'Priya Raman', parsed.identity)

// ——— approve on org PR (355) ———
await api.syncPull(355)
const snap355 = await api.getSnapshot(355)
const ok355 = await api.submitReview({
  prNumber: 355,
  expectedHeadSha: snap355!.immutable.headSha,
  event: 'APPROVE',
  body: 'Runtime bump verified in the workspace image.',
  comments: [],
})
check('355 APPROVE succeeds (org-member PR)', ok355.status === 'ok' && ok355.review.state === 'APPROVED', ok355)

// ——— reply + reaction dedupe (347) ———
const threads347 = await api.listReviewThreads(347)
check('347 has 4 unresolved threads', threads347.filter((t) => !t.isResolved).length === 4)
const target = threads347.find((t) => !t.isResolved)!
const reply = await api.replyToThread(347, target.id, 'Pushed a fix in the latest commit.')
const replyParsed = parseCommentIdentity(reply)
check('347 reply smuggles current human', replyParsed.identity.kind === 'human' && replyParsed.identity.name === 'Priya Raman')
check('347 reply threads updated in snapshot', (await api.listReviewThreads(347)).find((t) => t.id === target.id)!.comments.length === target.comments.length + 1)
const commentWithReaction = threads347.flatMap((t) => t.comments).find((c) => c.reactions.total_count > 0)
if (commentWithReaction) {
  const key = (['+1', 'heart', 'laugh', 'hooray', 'confused', 'rocket', 'eyes', '-1'] as const).find(
    (k) => commentWithReaction.reactions[k] > 0,
  )!
  const rollup = await api.addReaction(347, commentWithReaction.id, key)
  check('reaction dedupe: shared identity cannot double-react', rollup[key] === commentWithReaction.reactions[key])
} else {
  const c = threads347[0].comments[0]
  const r1 = await api.addReaction(347, c.id, 'eyes')
  const r2 = await api.addReaction(347, c.id, 'eyes')
  check('reaction dedupe: second identical reaction is a no-op', r1.eyes === 1 && r2.eyes === 1, { r1: r1.eyes, r2: r2.eyes })
}

// ——— per-human isolation ———
mockDev.setHuman('h-alice')
check('draft isolation: alice sees no 389 draft', (await api.getDraft(389)) === null)
check('viewed isolation: alice sees no 312 viewed state', Object.keys(await api.getFileViewed(312)).length === 0)
mockDev.setHuman('h-priya')
check('draft survives identity round-trip', (await api.getDraft(389))?.comments.length === 3)

// ——— resolve/unresolve ———
const t347 = (await api.listReviewThreads(347)).find((t) => !t.isResolved)!
const resolved = await api.resolveThread(347, t347.id, true)
check('resolve flips thread', resolved.isResolved === true)
const li347 = (await api.listPulls()).items.find((i) => i.pull.number === 347)!
check('broker unresolved count follows remote truth', li347.broker.unresolvedThreads === 3, li347.broker.unresolvedThreads)

// ——— failure modes ———
mockDev.setFailureMode('all')
let cachedOk = false
try {
  cachedOk = (await api.getSnapshot(312)) !== null
} catch {
  cachedOk = false
}
check('offline-first: cached snapshot readable with broker down', cachedOk)
let writeFailed = false
try {
  await api.replyToThread(347, t347.id, 'this must fail')
} catch (e) {
  writeFailed = e instanceof ApiError
}
check('failure mode: writes fail loudly', writeFailed)
mockDev.setFailureMode('none')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

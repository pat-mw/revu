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

const { createMockApi } = await import('../packages/app/src/api/mock/adapter')
const { mockDev } = await import('../packages/app/src/api/mock/devtools')
const { parseCommentIdentity } = await import('@revu/shared')
const { ApiError } = await import('@revu/shared')
const { isLocalReviewId } = await import('@revu/shared')
const { LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE } = await import('@revu/shared')

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

// The listing carries pull requests AND the workspace's local reviews, which
// share one id space split by the reserved band. Each half is pinned by
// IDENTITY rather than by a total, so a fixture that lost a pull request while
// gaining a local review cannot balance the books and pass.
const list = await api.listPulls()
const numbers = list.items.map((i) => i.pull.number).sort((a, b) => a - b)
const pullNumbers = numbers.filter((n) => !isLocalReviewId(n))
const localIds = numbers.filter((n) => isLocalReviewId(n))
check(
  'pull numbers complete',
  JSON.stringify(pullNumbers) ===
    JSON.stringify([101, 204, 312, 347, 355, 362, 389, 401, 410, 415]),
  pullNumbers,
)
check(
  'exactly one local review, in the reserved band',
  localIds.length === 1 && localIds[0] >= LOCAL_REVIEW_ID_BASE,
  localIds,
)
check('list has 11 rows and nothing else', list.items.length === 11, list.items.length)
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
// Pinned per comment key: a bare sorted multiset of kinds would go on passing
// after a fixture comment swapped which side of the drift it landed on.
const kinds = report.results.map((r) => [r.comment.key, r.kind])
check(
  '389 reconcile classifies every seeded comment',
  JSON.stringify(kinds) ===
    JSON.stringify([
      ['pc-389-margin', 'clean'],
      ['pc-389-firein', 'drifted'],
      ['pc-389-shim', 'lost'],
      ['pc-389-legacy-signature', 'clean'],
    ]),
  kinds,
)
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
const parsed = parseCommentIdentity(newThread.comments[0], session.brokerLogin)
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
const replyParsed = parseCommentIdentity(reply, session.brokerLogin)
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
const roundTripped = (await api.getDraft(389))?.comments.map((c) => c.key) ?? []
check(
  'draft survives identity round-trip',
  JSON.stringify(roundTripped) ===
    JSON.stringify(['pc-389-margin', 'pc-389-firein', 'pc-389-shim', 'pc-389-legacy-signature']),
  roundTripped,
)

// ——— resolve/unresolve ———
const t347 = (await api.listReviewThreads(347)).find((t) => !t.isResolved)!
const resolved = await api.resolveThread(347, t347.id, true)
check('resolve flips thread', resolved.isResolved === true)
const li347 = (await api.listPulls()).items.find((i) => i.pull.number === 347)!
check('broker unresolved count follows remote truth', li347.broker.unresolvedThreads === 3, li347.broker.unresolvedThreads)

// ——— local review, end to end (no pull request behind it) ———
// A branch pair the workspace reviews without anything ever being pushed:
// created, synced, commented on, submitted, replied to and resolved. It runs
// last among the passing scenarios because it ADDS a row to the listing, and
// the fixture counts asserted at the top are about the workspace as it loads.
const localPair = { baseRef: 'main', headRef: 'feature/smoke-local' }
const localAnchor = { path: 'src/index.ts', line: 12, lineText: 'const x = compute()' }
const localBody = 'This guard clause reads inverted — the early return is the happy path.'
const local = await api.createLocalReview({ ...localPair, title: 'Smoke: local review walk' })
check(
  'local review id comes from the reserved review band',
  isLocalReviewId(local.id) && local.id >= LOCAL_REVIEW_ID_BASE,
  local.id,
)
check(
  'local review is listed exactly once',
  (await api.listLocalReviews()).filter((r) => r.id === local.id).length === 1,
)
check(
  'local review shows up in the pull listing',
  (await api.listPulls()).items.some((i) => i.pull.number === local.id),
)
// Nothing cached yet is an ordinary answer, not a rejection the UI would have
// to route down an error path.
check('local review starts unsynced (null, not a throw)', (await api.getSnapshot(local.id)) === null)

const localSnap = await api.syncPull(local.id)
// The key half matters: a `partial` whose value went undefined vanishes in
// serialization, and a `=== null` check alone would still pass.
check(
  'local sync carries partial as a present key valued null',
  Object.hasOwn(localSnap, 'partial') && localSnap.partial === null,
  localSnap.partial,
)
check(
  'local compare key is mergeBase...head',
  localSnap.immutable.compareKey ===
    `${localSnap.immutable.mergeBaseSha}...${localSnap.immutable.headSha}`,
  localSnap.immutable.compareKey,
)

const localAt = new Date().toISOString()
const localDraft = await api.saveDraft({
  humanId: session.human.id,
  prNumber: local.id,
  headSha: localSnap.immutable.headSha,
  compareKey: localSnap.immutable.compareKey,
  body: 'One blocking question.',
  event: 'COMMENT',
  comments: [
    {
      key: 'smoke-local-12',
      path: localAnchor.path,
      side: 'RIGHT',
      start_side: null,
      line: localAnchor.line,
      start_line: null,
      body: localBody,
      createdAt: localAt,
      updatedAt: localAt,
      anchor: { lineText: localAnchor.lineText, contextBefore: [], contextAfter: [] },
    },
  ],
  createdAt: localAt,
  updatedAt: localAt,
})
check('local draft saved with one pending comment', localDraft.comments.length === 1, localDraft)

const localMoved = await api.submitReview({
  prNumber: local.id,
  expectedHeadSha: 'not-the-real-head',
  event: 'COMMENT',
  body: localDraft.body,
  comments: localDraft.comments,
})
check('local submit vs wrong head → head_moved', localMoved.status === 'head_moved', localMoved)
check(
  'local head guard left the reviewer text where it was',
  (await api.getDraft(local.id))?.comments[0]?.body === localBody,
)

const localOk = await api.submitReview({
  prNumber: local.id,
  expectedHeadSha: localSnap.immutable.headSha,
  event: 'COMMENT',
  body: localDraft.body,
  comments: localDraft.comments,
})
check('local submit vs true head → ok', localOk.status === 'ok', localOk)
check('local draft cleared after submit', (await api.getDraft(local.id)) === null)

const localThreads = (await api.getSnapshot(local.id))!.mutable.threads
check('local submit materialized exactly one thread', localThreads.length === 1, localThreads.length)
const localThread = localThreads[0]
check(
  'local thread is anchored where the pending comment was',
  localThread.path === localAnchor.path && localThread.line === localAnchor.line,
  { path: localThread.path, line: localThread.line },
)
// Stored verbatim: the `**Name** (role)` stamp exists only because many humans
// share one GitHub account, and a local review has no such account behind it.
check(
  'local comment body is the reviewer text, unstamped',
  localThread.comments[0].body === localBody,
  localThread.comments[0].body,
)
check(
  'local comment ids come from the reserved entity band',
  localThread.comments.every((c) => c.id >= LOCAL_ENTITY_ID_BASE),
  localThread.comments.map((c) => c.id),
)

const localReply = await api.replyToThread(local.id, localThread.id, 'Rewrote it the other way round.')
check('local reply id is in the entity band', localReply.id >= LOCAL_ENTITY_ID_BASE, localReply.id)
const grown = (await api.getSnapshot(local.id))!.mutable.threads.find((t) => t.id === localThread.id)
check('local reply grew the thread to two comments', grown?.comments.length === 2, grown?.comments.length)

const localResolved = await api.resolveThread(local.id, localThread.id, true)
check('local resolve flips the thread and names who did it', localResolved.isResolved === true && (localResolved.resolvedBy?.login ?? '').length > 0, localResolved.resolvedBy)
const localAfter = (await api.getSnapshot(local.id))!.mutable.threads.find((t) => t.id === localThread.id)
check('local snapshot agrees the thread is resolved', localAfter?.isResolved === true)

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

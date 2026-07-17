import type {
  CheckRun,
  CommitInfo,
  GhUser,
  Human,
  IssueComment,
  PullDetail,
  PullFile,
  ReviewComment,
  ReviewSummary,
  ReviewThread,
} from '@/api/types'
import { prefixBody } from '@/lib/identity'
import { BROKER_BOT, HUMANS, ORG_DKOZLOV, REPO } from '../cast'
import type { FixtureSeeds, RemotePull } from '../contract'
import {
  blob,
  buildSnapshot,
  daysAgo,
  emptyReactions,
  fakeSha,
  hoursAgo,
  minutesAgo,
  nodeId,
  pullFile,
} from '../helpers'

/**
 * PR 347 — "feat(metering): schema migrations for usage rollups".
 *
 * The author-mode scenario. Priya (the default demo identity) opened this PR
 * through the broker, so `broker.authorHumanId` points at her and
 * `canApprove` is false (GitHub refuses self-review from the App login).
 *
 * The tension is temporal: four unresolved threads, three of which were
 * opened well BEFORE the last two commits landed (hoursAgo 20 and 4). From
 * the author's seat every one of those threads is "maybe already addressed"
 * — the commit messages sound responsive, but only re-reading the diff tells.
 * The seeded snapshot was synced after the final commit, so nothing here is
 * stale; the work is triage, not re-sync.
 */

const SHA_BASE = fakeSha('pr347-base')
const SHA_C1 = fakeSha('pr347-c1')
const SHA_C2 = fakeSha('pr347-c2')
const SHA_C3 = fakeSha('pr347-c3')
const SHA_C4 = fakeSha('pr347-c4')
const SHA_HEAD = fakeSha('pr347-head')

const priya = HUMANS.find((h) => h.id === 'h-priya')!
const alice = HUMANS.find((h) => h.id === 'h-alice')!
const marcus = HUMANS.find((h) => h.id === 'h-marcus')!

// ————————————————————————————————————————————————————————————————
// Blobs — full file contents on both sides of the compare
// ————————————————————————————————————————————————————————————————

const ROLLUP_BASE = `import { db } from '../db/client'
import type { UsageEvent } from './schema'

/** One aggregated bucket of usage for a single org + meter. */
export interface RollupBucket {
  orgId: string
  meter: string
  bucketStart: string
  eventCount: number
  quantitySum: number
}

function hourFloor(iso: string): string {
  const d = new Date(iso)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

/**
 * Aggregate raw usage events into hourly buckets, in memory. Callers page
 * through events in occurred_at order; this never touches the database.
 */
export function aggregateHourly(events: UsageEvent[]): RollupBucket[] {
  const buckets = new Map<string, RollupBucket>()
  for (const event of events) {
    const bucketStart = hourFloor(event.occurredAt)
    const key = \`\${event.orgId}:\${event.meter}:\${bucketStart}\`
    const bucket = buckets.get(key) ?? {
      orgId: event.orgId,
      meter: event.meter,
      bucketStart,
      eventCount: 0,
      quantitySum: 0,
    }
    bucket.eventCount += 1
    bucket.quantitySum += event.quantity
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}

/** Raw usage totals for one org across all meters — legacy report path. */
export async function readRawTotals(orgId: string): Promise<Record<string, number>> {
  const rows = await db.query<{ meter: string; total: string }>(
    'select meter, sum(quantity) as total from usage_events where org_id = $1 group by meter',
    [orgId],
  )
  const totals: Record<string, number> = {}
  for (const row of rows) totals[row.meter] = Number(row.total)
  return totals
}
`

const ROLLUP_HEAD = `import { db, withTransaction } from '../db/client'
import type { UsageEvent } from './schema'

/** One aggregated bucket of usage for a single org + meter. */
export interface RollupBucket {
  orgId: string
  meter: string
  bucketStart: string
  eventCount: number
  quantitySum: number
}

function hourFloor(iso: string): string {
  const d = new Date(iso)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

/**
 * Aggregate raw usage events into hourly buckets, in memory. Callers page
 * through events in occurred_at order; this never touches the database.
 */
export function aggregateHourly(events: UsageEvent[]): RollupBucket[] {
  const buckets = new Map<string, RollupBucket>()
  for (const event of events) {
    const bucketStart = hourFloor(event.occurredAt)
    const key = \`\${event.orgId}:\${event.meter}:\${bucketStart}\`
    const bucket = buckets.get(key) ?? {
      orgId: event.orgId,
      meter: event.meter,
      bucketStart,
      eventCount: 0,
      quantitySum: 0,
    }
    bucket.eventCount += 1
    bucket.quantitySum += event.quantity
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}

/** Last fully-rolled-up hour for a meter, or null before the first backfill. */
export async function readWatermark(meter: string): Promise<string | null> {
  const row = await db.queryOne<{ rolled_up_to: string }>(
    'select rolled_up_to from usage_rollup_watermark where meter = $1',
    [meter],
  )
  return row?.rolled_up_to ?? null
}

/** Upsert aggregated buckets; a re-run for the same hour overwrites in place. */
export async function writeHourlyRollups(buckets: RollupBucket[]): Promise<void> {
  await withTransaction(async (tx) => {
    for (const b of buckets) {
      await tx.execute(
        \`insert into usage_rollup_hourly
           (org_id, meter, bucket_start, event_count, quantity_sum)
         values ($1, $2, $3, $4, $5)
         on conflict (org_id, meter, bucket_start) do update
           set event_count = excluded.event_count,
               quantity_sum = excluded.quantity_sum,
               updated_at = now()\`,
        [b.orgId, b.meter, b.bucketStart, b.eventCount, b.quantitySum],
      )
    }
  })
}

/** Raw usage totals for one org across all meters — legacy report path. */
export async function readRawTotals(orgId: string): Promise<Record<string, number>> {
  const rows = await db.query<{ meter: string; total: string }>(
    'select meter, sum(quantity) as total from usage_events where org_id = $1 group by meter',
    [orgId],
  )
  const totals: Record<string, number> = {}
  for (const row of rows) totals[row.meter] = Number(row.total)
  return totals
}

/**
 * Roll up one window of raw events and advance the watermark. The watermark
 * only moves after every bucket in the window has been written.
 */
export async function runBackfillBatch(
  meter: string,
  batchStart: string,
  batchEnd: string,
): Promise<number> {
  const events = await db.query<UsageEvent>(
    \`select org_id as "orgId", meter, occurred_at as "occurredAt", quantity
       from usage_events
      where meter = $1 and occurred_at >= $2 and occurred_at < $3
      order by occurred_at\`,
    [meter, batchStart, batchEnd],
  )
  const buckets = aggregateHourly(events)
  await writeHourlyRollups(buckets)
  await db.execute(
    \`insert into usage_rollup_watermark (meter, rolled_up_to)
     values ($1, $2)
     on conflict (meter) do update set rolled_up_to = excluded.rolled_up_to\`,
    [meter, batchEnd],
  )
  return buckets.length
}
`

const SCHEMA_BASE = `import { z } from 'zod'

/** Raw usage event as ingested from the collector, one row per occurrence. */
export const usageEventSchema = z.object({
  orgId: z.string().uuid(),
  meter: z.string().min(1),
  occurredAt: z.string().datetime(),
  quantity: z.number().nonnegative(),
})

export type UsageEvent = z.infer<typeof usageEventSchema>
`

const SCHEMA_HEAD = `import { z } from 'zod'

/** Raw usage event as ingested from the collector, one row per occurrence. */
export const usageEventSchema = z.object({
  orgId: z.string().uuid(),
  meter: z.string().min(1),
  occurredAt: z.string().datetime(),
  quantity: z.number().nonnegative(),
})

export type UsageEvent = z.infer<typeof usageEventSchema>

/** Hourly rollup row as read back from usage_rollup_hourly. */
export const hourlyRollupSchema = z.object({
  orgId: z.string().uuid(),
  meter: z.string().min(1),
  bucketStart: z.string().datetime(),
  eventCount: z.number().int().nonnegative(),
  quantitySum: z.number().nonnegative(),
})

export type HourlyRollup = z.infer<typeof hourlyRollupSchema>

/** Watermark row: the last hour fully rolled up for a meter. */
export const rollupWatermarkSchema = z.object({
  meter: z.string().min(1),
  rolledUpTo: z.string().datetime(),
})

export type RollupWatermark = z.infer<typeof rollupWatermarkSchema>
`

const TEST_BASE = `import { describe, expect, it } from 'vitest'
import { aggregateHourly } from './rollup'
import type { UsageEvent } from './schema'

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    orgId: '00000000-0000-4000-8000-000000000001',
    meter: 'api.requests',
    occurredAt: '2026-07-01T10:15:00.000Z',
    quantity: 1,
    ...overrides,
  }
}

describe('aggregateHourly', () => {
  it('groups events into hour buckets per org and meter', () => {
    const buckets = aggregateHourly([
      event({ occurredAt: '2026-07-01T10:05:00.000Z' }),
      event({ occurredAt: '2026-07-01T10:59:59.000Z' }),
      event({ occurredAt: '2026-07-01T11:00:00.000Z' }),
    ])
    expect(buckets).toHaveLength(2)
  })

  it('sums quantities within a bucket', () => {
    const buckets = aggregateHourly([
      event({ quantity: 2 }),
      event({ quantity: 3.5 }),
    ])
    expect(buckets[0].quantitySum).toBe(5.5)
  })
})
`

const TEST_HEAD = `import { describe, expect, it } from 'vitest'
import { aggregateHourly, readWatermark, runBackfillBatch } from './rollup'
import type { UsageEvent } from './schema'

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    orgId: '00000000-0000-4000-8000-000000000001',
    meter: 'api.requests',
    occurredAt: '2026-07-01T10:15:00.000Z',
    quantity: 1,
    ...overrides,
  }
}

describe('aggregateHourly', () => {
  it('groups events into hour buckets per org and meter', () => {
    const buckets = aggregateHourly([
      event({ occurredAt: '2026-07-01T10:05:00.000Z' }),
      event({ occurredAt: '2026-07-01T10:59:59.000Z' }),
      event({ occurredAt: '2026-07-01T11:00:00.000Z' }),
    ])
    expect(buckets).toHaveLength(2)
  })

  it('sums quantities within a bucket', () => {
    const buckets = aggregateHourly([
      event({ quantity: 2 }),
      event({ quantity: 3.5 }),
    ])
    expect(buckets[0].quantitySum).toBe(5.5)
  })
})

describe('runBackfillBatch', () => {
  it('rolls up one window and advances the watermark', async () => {
    const written = await runBackfillBatch(
      'api.requests',
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T11:00:00.000Z',
    )
    expect(written).toBeGreaterThan(0)
    const watermark = await readWatermark('api.requests')
    expect(new Date(watermark!).getTime()).toBeLessThan(Date.now())
  })
})
`

const SQL_0042 = `-- Usage rollup tables: hourly and daily aggregates over raw usage_events.
-- Raw events stay append-only; rollups are derived and rebuildable.

create table usage_rollup_hourly (
  org_id        uuid        not null,
  meter         text        not null,
  bucket_start  timestamptz not null,
  event_count   bigint      not null default 0,
  quantity_sum  numeric     not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (org_id, meter, bucket_start)
);

create table usage_rollup_daily (
  org_id        uuid        not null,
  meter         text        not null,
  bucket_start  date        not null,
  event_count   bigint      not null default 0,
  quantity_sum  numeric     not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (org_id, meter, bucket_start)
);

-- Watermark of the last fully-rolled-up hour per meter.
create table usage_rollup_watermark (
  meter         text        primary key,
  rolled_up_to  timestamptz not null
);
`

const SQL_0043 = `-- Backfill hourly rollups from raw usage_events, one window per run.
-- Rows are upserted keyed on (org_id, meter, bucket_start), so a window
-- can be re-run; the runner passes [:batch_start, :batch_end) boundaries.

insert into usage_rollup_hourly (org_id, meter, bucket_start, event_count, quantity_sum)
select
  org_id,
  meter,
  date_trunc('hour', occurred_at) as bucket_start,
  count(*),
  sum(quantity)
from usage_events
where occurred_at >= :batch_start
  and occurred_at < :batch_end
group by org_id, meter, date_trunc('hour', occurred_at)
on conflict (org_id, meter, bucket_start) do update
  set event_count  = excluded.event_count,
      quantity_sum = excluded.quantity_sum,
      updated_at   = now();
`

const rollupBase = blob('src/metering/rollup.ts', ROLLUP_BASE, 'pr347-rollup-base')
const rollupHead = blob('src/metering/rollup.ts', ROLLUP_HEAD, 'pr347-rollup-head')
const schemaBase = blob('src/metering/schema.ts', SCHEMA_BASE, 'pr347-schema-base')
const schemaHead = blob('src/metering/schema.ts', SCHEMA_HEAD, 'pr347-schema-head')
const testBase = blob('src/metering/rollup.test.ts', TEST_BASE, 'pr347-test-base')
const testHead = blob('src/metering/rollup.test.ts', TEST_HEAD, 'pr347-test-head')
const sql42Head = blob('migrations/0042_usage_rollups.sql', SQL_0042, 'pr347-sql42-head')
const sql43Head = blob('migrations/0043_backfill_hourly.sql', SQL_0043, 'pr347-sql43-head')

// ————————————————————————————————————————————————————————————————
// Patches — unified diff hunks, consistent with the blobs above
// ————————————————————————————————————————————————————————————————

/** Unified diff for a newly added file: one hunk, every line a plus. */
function addedPatch(content: string): string {
  const lines = content.replace(/\n$/, '').split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
}

const PATCH_ROLLUP = `@@ -1,4 +1,4 @@
-import { db } from '../db/client'
+import { db, withTransaction } from '../db/client'
 import type { UsageEvent } from './schema'

 /** One aggregated bucket of usage for a single org + meter. */
@@ -39,6 +39,33 @@ export function aggregateHourly(events: UsageEvent[]): RollupBucket[] {
   return [...buckets.values()]
 }

+/** Last fully-rolled-up hour for a meter, or null before the first backfill. */
+export async function readWatermark(meter: string): Promise<string | null> {
+  const row = await db.queryOne<{ rolled_up_to: string }>(
+    'select rolled_up_to from usage_rollup_watermark where meter = $1',
+    [meter],
+  )
+  return row?.rolled_up_to ?? null
+}
+
+/** Upsert aggregated buckets; a re-run for the same hour overwrites in place. */
+export async function writeHourlyRollups(buckets: RollupBucket[]): Promise<void> {
+  await withTransaction(async (tx) => {
+    for (const b of buckets) {
+      await tx.execute(
+        \`insert into usage_rollup_hourly
+           (org_id, meter, bucket_start, event_count, quantity_sum)
+         values ($1, $2, $3, $4, $5)
+         on conflict (org_id, meter, bucket_start) do update
+           set event_count = excluded.event_count,
+               quantity_sum = excluded.quantity_sum,
+               updated_at = now()\`,
+        [b.orgId, b.meter, b.bucketStart, b.eventCount, b.quantitySum],
+      )
+    }
+  })
+}
+
 /** Raw usage totals for one org across all meters — legacy report path. */
 export async function readRawTotals(orgId: string): Promise<Record<string, number>> {
   const rows = await db.query<{ meter: string; total: string }>(
@@ -49,3 +76,30 @@ export async function readRawTotals(orgId: string): Promise<Record<string, numbe
   for (const row of rows) totals[row.meter] = Number(row.total)
   return totals
 }
+
+/**
+ * Roll up one window of raw events and advance the watermark. The watermark
+ * only moves after every bucket in the window has been written.
+ */
+export async function runBackfillBatch(
+  meter: string,
+  batchStart: string,
+  batchEnd: string,
+): Promise<number> {
+  const events = await db.query<UsageEvent>(
+    \`select org_id as "orgId", meter, occurred_at as "occurredAt", quantity
+       from usage_events
+      where meter = $1 and occurred_at >= $2 and occurred_at < $3
+      order by occurred_at\`,
+    [meter, batchStart, batchEnd],
+  )
+  const buckets = aggregateHourly(events)
+  await writeHourlyRollups(buckets)
+  await db.execute(
+    \`insert into usage_rollup_watermark (meter, rolled_up_to)
+     values ($1, $2)
+     on conflict (meter) do update set rolled_up_to = excluded.rolled_up_to\`,
+    [meter, batchEnd],
+  )
+  return buckets.length
+}`

const PATCH_SCHEMA = `@@ -9,3 +9,22 @@ export const usageEventSchema = z.object({
 })

 export type UsageEvent = z.infer<typeof usageEventSchema>
+
+/** Hourly rollup row as read back from usage_rollup_hourly. */
+export const hourlyRollupSchema = z.object({
+  orgId: z.string().uuid(),
+  meter: z.string().min(1),
+  bucketStart: z.string().datetime(),
+  eventCount: z.number().int().nonnegative(),
+  quantitySum: z.number().nonnegative(),
+})
+
+export type HourlyRollup = z.infer<typeof hourlyRollupSchema>
+
+/** Watermark row: the last hour fully rolled up for a meter. */
+export const rollupWatermarkSchema = z.object({
+  meter: z.string().min(1),
+  rolledUpTo: z.string().datetime(),
+})
+
+export type RollupWatermark = z.infer<typeof rollupWatermarkSchema>`

const PATCH_TEST = `@@ -1,5 +1,5 @@
 import { describe, expect, it } from 'vitest'
-import { aggregateHourly } from './rollup'
+import { aggregateHourly, readWatermark, runBackfillBatch } from './rollup'
 import type { UsageEvent } from './schema'

 function event(overrides: Partial<UsageEvent>): UsageEvent {
@@ -30,3 +30,16 @@ describe('aggregateHourly', () => {
     expect(buckets[0].quantitySum).toBe(5.5)
   })
 })
+
+describe('runBackfillBatch', () => {
+  it('rolls up one window and advances the watermark', async () => {
+    const written = await runBackfillBatch(
+      'api.requests',
+      '2026-07-01T10:00:00.000Z',
+      '2026-07-01T11:00:00.000Z',
+    )
+    expect(written).toBeGreaterThan(0)
+    const watermark = await readWatermark('api.requests')
+    expect(new Date(watermark!).getTime()).toBeLessThan(Date.now())
+  })
+})`

const PATCH_SQL42 = addedPatch(SQL_0042)
const PATCH_SQL43 = addedPatch(SQL_0043)

const files: PullFile[] = [
  pullFile({
    sha: sql42Head.sha,
    filename: 'migrations/0042_usage_rollups.sql',
    status: 'added',
    patch: PATCH_SQL42,
  }),
  pullFile({
    sha: sql43Head.sha,
    filename: 'migrations/0043_backfill_hourly.sql',
    status: 'added',
    patch: PATCH_SQL43,
  }),
  pullFile({
    sha: rollupHead.sha,
    filename: 'src/metering/rollup.ts',
    status: 'modified',
    patch: PATCH_ROLLUP,
  }),
  pullFile({
    sha: schemaHead.sha,
    filename: 'src/metering/schema.ts',
    status: 'modified',
    patch: PATCH_SCHEMA,
  }),
  pullFile({
    sha: testHead.sha,
    filename: 'src/metering/rollup.test.ts',
    status: 'modified',
    patch: PATCH_TEST,
  }),
]

const blobIndex: RemotePull['blobIndex'] = {
  'migrations/0042_usage_rollups.sql': { base: null, head: sql42Head.sha },
  'migrations/0043_backfill_hourly.sql': { base: null, head: sql43Head.sha },
  'src/metering/rollup.ts': { base: rollupBase.sha, head: rollupHead.sha },
  'src/metering/schema.ts': { base: schemaBase.sha, head: schemaHead.sha },
  'src/metering/rollup.test.ts': { base: testBase.sha, head: testHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Threads
// ————————————————————————————————————————————————————————————————

/**
 * Slice of a unified diff from its governing hunk header through the given
 * RIGHT-side line — the exact fragment GitHub serves as `diff_hunk` on a
 * review comment. Throws when the line is not visible in the patch, so an
 * inconsistent fixture fails at module load instead of rendering wrong.
 */
function diffHunkTo(patch: string, line: number): string {
  let out: string[] = []
  let newLn = 0
  for (const row of patch.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (m) {
      out = [row]
      newLn = Number(m[1]) - 1
      continue
    }
    out.push(row)
    if (!row.startsWith('-')) newLn += 1
    if (!row.startsWith('-') && newLn === line) return out.join('\n')
  }
  throw new Error(`diffHunkTo: right line ${line} not present in patch`)
}

function reviewComment(args: {
  id: number
  reviewId?: number
  inReplyTo?: number
  path: string
  patch: string
  line: number
  originalLine?: number
  originalCommitId: string
  user: GhUser
  body: string
  createdAt: string
}): ReviewComment {
  return {
    id: args.id,
    node_id: nodeId('PRRC', args.id),
    pull_request_review_id: args.reviewId ?? null,
    ...(args.inReplyTo !== undefined ? { in_reply_to_id: args.inReplyTo } : {}),
    path: args.path,
    diff_hunk: diffHunkTo(args.patch, args.line),
    commit_id: SHA_HEAD,
    original_commit_id: args.originalCommitId,
    line: args.line,
    original_line: args.originalLine ?? args.line,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: 'line',
    user: args.user,
    body: args.body,
    created_at: args.createdAt,
    updated_at: args.createdAt,
    reactions: emptyReactions(args.id),
    html_url: `https://github.com/meridian-labs/atlas/pull/347#discussion_r${args.id}`,
  }
}

function thread(args: {
  key: number
  path: string
  line: number
  resolvedBy?: string
  comments: ReviewComment[]
}): ReviewThread {
  return {
    id: nodeId('PRRT', args.key),
    isResolved: args.resolvedBy !== undefined,
    isOutdated: false,
    path: args.path,
    line: args.line,
    originalLine: args.line,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: args.resolvedBy ? { login: args.resolvedBy } : null,
    comments: args.comments,
  }
}

const REVIEW_DKOZLOV = 8347001

/** Unresolved — opened before the last two commits (idempotency question). */
const threadIdempotency = thread({
  key: 34710,
  path: 'src/metering/rollup.ts',
  line: 97,
  comments: [
    reviewComment({
      id: 3471001,
      reviewId: REVIEW_DKOZLOV,
      path: 'src/metering/rollup.ts',
      patch: PATCH_ROLLUP,
      line: 97,
      originalCommitId: SHA_C3,
      user: ORG_DKOZLOV,
      body: 'Is a re-run of the same window actually idempotent? The upsert overwrites event_count with the recount, which only works if the window re-reads every event for that hour. A window that splits an hour (say the runner is configured with 30-minute batches) will clobber the first half of the count. Either align windows to hour boundaries in code, or make this additive with a dedupe key.',
      createdAt: daysAgo(2),
    }),
  ],
})

/** Unresolved — opened before the last two commits (missing index). */
const threadIndex = thread({
  key: 34720,
  path: 'migrations/0042_usage_rollups.sql',
  line: 11,
  comments: [
    reviewComment({
      id: 3472001,
      reviewId: REVIEW_DKOZLOV,
      path: 'migrations/0042_usage_rollups.sql',
      patch: PATCH_SQL42,
      line: 11,
      originalCommitId: SHA_C3,
      user: ORG_DKOZLOV,
      body: "Billing's sweep reads by (meter, bucket_start) across all orgs; with the PK leading on org_id that's a full scan per meter. Add `create index on usage_rollup_hourly (meter, bucket_start)` — same for the daily table.",
      createdAt: daysAgo(2),
    }),
  ],
})

/** Unresolved — naming debate, already has one reply from the author. */
const threadNaming = thread({
  key: 34730,
  path: 'src/metering/schema.ts',
  line: 17,
  comments: [
    reviewComment({
      id: 3473001,
      path: 'src/metering/schema.ts',
      patch: PATCH_SCHEMA,
      line: 17,
      originalCommitId: SHA_C2,
      user: BROKER_BOT,
      body: prefixBody(
        alice,
        'Naming: the ingest pipeline and the query API both call this window_start / windowStart — bucketStart would be a third name for the same concept. Align on windowStart?',
      ),
      createdAt: daysAgo(3),
    }),
    reviewComment({
      id: 3473002,
      inReplyTo: 3473001,
      path: 'src/metering/schema.ts',
      patch: PATCH_SCHEMA,
      line: 17,
      originalCommitId: SHA_C2,
      user: BROKER_BOT,
      body: prefixBody(
        priya,
        "The tables in 0042 already say bucket_start, following the pg aggregation docs we based this on. I'd rather rename in the query API later than fork the migration now — if you feel strongly let's settle it in #data-platform.",
      ),
      createdAt: hoursAgo(70),
    }),
  ],
})

/** Unresolved — flaky wall-clock assertion in the new test. */
const threadFlakyTime = thread({
  key: 34740,
  path: 'src/metering/rollup.test.ts',
  line: 43,
  comments: [
    reviewComment({
      id: 3474001,
      path: 'src/metering/rollup.test.ts',
      patch: PATCH_TEST,
      line: 43,
      originalCommitId: SHA_C3,
      user: BROKER_BOT,
      body: prefixBody(
        marcus,
        "This is a wall-clock assertion — any past timestamp passes, so it can't fail meaningfully, and on a loaded runner it's the classic flake shape. Assert the watermark equals the batchEnd you passed in instead.",
      ),
      createdAt: hoursAgo(26),
    }),
  ],
})

/** Resolved — window-boundary question, answered and closed by the reviewer. */
const threadBoundary = thread({
  key: 34750,
  path: 'migrations/0043_backfill_hourly.sql',
  line: 14,
  resolvedBy: ORG_DKOZLOV.login,
  comments: [
    reviewComment({
      id: 3475001,
      reviewId: REVIEW_DKOZLOV,
      path: 'migrations/0043_backfill_hourly.sql',
      patch: PATCH_SQL43,
      line: 14,
      originalCommitId: SHA_C3,
      user: ORG_DKOZLOV,
      body: 'Is :batch_end inclusive? If the runner passes 10:00–11:00 and then 11:00–12:00, an event at exactly 11:00 must land in exactly one window.',
      createdAt: daysAgo(2),
    }),
    reviewComment({
      id: 3475002,
      inReplyTo: 3475001,
      path: 'migrations/0043_backfill_hourly.sql',
      patch: PATCH_SQL43,
      line: 14,
      originalCommitId: SHA_C3,
      user: BROKER_BOT,
      body: prefixBody(
        priya,
        'Exclusive — the runner passes [start, end), so 11:00.000 belongs to the second window only. The header comment on lines 2–3 spells that out now.',
      ),
      createdAt: hoursAgo(44),
    }),
  ],
})

const threads: ReviewThread[] = [
  threadIdempotency,
  threadIndex,
  threadNaming,
  threadFlakyTime,
  threadBoundary,
]

// ————————————————————————————————————————————————————————————————
// Timeline: commits, reviews, comments, checks
// ————————————————————————————————————————————————————————————————

function brokerCommit(
  sha: string,
  message: string,
  human: Human,
  date: string,
  parent: string,
): CommitInfo {
  return {
    sha,
    commit: { message, author: { name: human.name, email: human.email, date } },
    author: null,
    parents: [{ sha: parent }],
  }
}

/**
 * The last two commits land AFTER threads 1–3 above were opened — the
 * "maybe already addressed" signal author mode has to surface. Their
 * messages sound responsive without the threads having been resolved.
 */
const commits: CommitInfo[] = [
  brokerCommit(SHA_C1, 'feat(metering): add usage rollup tables migration', priya, daysAgo(4), SHA_BASE),
  brokerCommit(SHA_C2, 'feat(metering): backfill migration and rollup schemas', priya, hoursAgo(78), SHA_C1),
  brokerCommit(SHA_C3, 'feat(metering): rollup write path, backfill runner, and tests', priya, hoursAgo(60), SHA_C2),
  brokerCommit(SHA_C4, 'fix(metering): recount full hours when a backfill window is re-run', priya, hoursAgo(20), SHA_C3),
  brokerCommit(SHA_HEAD, 'refactor(metering): tighten rollup upsert and schema docs', priya, hoursAgo(4), SHA_C4),
]

const reviews: ReviewSummary[] = [
  {
    id: REVIEW_DKOZLOV,
    node_id: nodeId('PRR', REVIEW_DKOZLOV),
    user: ORG_DKOZLOV,
    body: 'Schema is close. The index and idempotency questions inline are blocking for me; the naming one is not.',
    state: 'COMMENTED',
    submitted_at: daysAgo(2),
    commit_id: SHA_C3,
  },
]

const issueComments: IssueComment[] = [
  {
    id: 2034701,
    node_id: nodeId('IC', 2034701),
    user: ORG_DKOZLOV,
    body: 'schema looks close; see inline',
    created_at: daysAgo(2),
    updated_at: daysAgo(2),
    reactions: emptyReactions(2034701),
  },
]

const checks: CheckRun[] = [
  {
    id: 5347001,
    name: 'typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(236),
    completed_at: minutesAgo(231),
    details_url: 'https://ci.meridian-labs.dev/atlas/typecheck/5347001',
    output: { title: 'tsc --noEmit', summary: 'No type errors across 214 files.' },
  },
  {
    id: 5347002,
    name: 'tests',
    status: 'in_progress',
    conclusion: null,
    started_at: minutesAgo(9),
    completed_at: null,
    details_url: 'https://ci.meridian-labs.dev/atlas/tests/5347002',
    output: { title: 'vitest', summary: null },
  },
]

// ————————————————————————————————————————————————————————————————
// Assembly
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

const detail: PullDetail = {
  id: 90347,
  node_id: nodeId('PR', 90347),
  number: 347,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'feat(metering): schema migrations for usage rollups',
  body: prefixBody(
    priya,
    'Adds the hourly/daily usage rollup tables with a re-runnable backfill, plus the write path the metering worker will call.\n\n- 0042 creates `usage_rollup_hourly` / `usage_rollup_daily` and the per-meter watermark\n- 0043 backfills hourly buckets from raw `usage_events`, one window per run\n- `runBackfillBatch` aggregates in memory and only advances the watermark after every bucket lands\n\nRollout: migrations first, worker flag next week. Raw events stay the source of truth — rollups are rebuildable.',
  ),
  user: BROKER_BOT,
  labels: [
    { id: 6101, name: 'metering', color: '1d76db', description: 'Usage metering and billing pipeline' },
    { id: 6102, name: 'migration', color: 'b60205', description: 'Contains schema migrations' },
  ],
  requested_reviewers: [ORG_DKOZLOV],
  head: {
    ref: 'metering/usage-rollups',
    sha: SHA_HEAD,
    label: 'meridian-labs:metering/usage-rollups',
    repo: { ...REPO },
  },
  base: { ref: 'main', sha: SHA_BASE, label: 'meridian-labs:main', repo: { ...REPO } },
  created_at: daysAgo(4),
  updated_at: hoursAgo(4),
  merged: false,
  mergeable: true,
  mergeable_state: 'blocked',
  merge_base_sha: SHA_BASE,
  comments: issueComments.length,
  review_comments: threads.reduce((n, t) => n + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
}

export const pr347: RemotePull = {
  detail,
  files,
  blobs: [rollupBase, rollupHead, schemaBase, schemaHead, testBase, testHead, sql42Head, sql43Head],
  blobIndex,
  threads,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-priya',
    canApprove: false,
    unresolvedThreads: 4,
    assignedReviewerHumanIds: [],
    compareKey: `${SHA_BASE}...${SHA_HEAD}`,
    commitCount: commits.length,
  },
}

/**
 * Seeded snapshot synced AFTER the final commit — fresh, not stale. The
 * interesting state here is entirely in the thread-vs-commit timestamps.
 */
export const pr347Seeds: FixtureSeeds = {
  snapshots: [
    buildSnapshot(pr347, hoursAgo(3), {
      syncStats: { blobsFetched: 8, blobsReused: 0, requests: 15 },
    }),
  ],
}

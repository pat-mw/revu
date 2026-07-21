import type { CheckRun, CommitInfo, FileBlob, IssueComment, PullDetail, PullFile, ReviewSummary, ReviewThread } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import { BROKER_BOT, HUMANS, ORG_DKOZLOV, REPO } from '../cast'
import type { FixtureSeeds, RemotePull } from '../contract'
import {
  blob,
  buildSnapshot,
  daysAgo,
  emptyReactions,
  hoursAgo,
  minutesAgo,
  nodeId,
  pullFile,
} from '../helpers'

/**
 * PR 362 — "chore(ts): enable strictNullChecks across services".
 *
 * The failure fixture: checks are red (typecheck + tests both failing) and the
 * branch has a merge conflict, so mergeability is false and dirty. Six files
 * (a tsconfig flip plus five null-guard edits) totalling a few hundred lines.
 * Authored by a contractor (Marcus) through the broker bot; the one unresolved
 * thread is from the org member dkozlov with a prefixed reply from Marcus.
 *
 * Every modified file's head blob is the literal head content; its base is the
 * head with the patch reversed. `pullFile` derives additions/deletions from the
 * patch so the file list matches what the viewer renders.
 *
 * Its base is the runtime-bump branch rather than the default branch — the
 * strict flags land on the pinned toolchain — which also makes it the sibling
 * of the ingest pull request one level down the same stack, so the inbox tree
 * has two children to order under one branch.
 */

const MARCUS = HUMANS.find((h) => h.id === 'h-marcus')!

const OWNER = REPO.full_name
const HEAD_SHA = 'c9d31a70b52e84f16a0c7d9e3b25f8471ad06e93'
const BASE_SHA = '4f18b2e0a7c9d135e864b02f7a19c3d5806eb241'
const MERGE_BASE_SHA = '4f18b2e0a7c9d135e864b02f7a19c3d5806eb241'

// ————————————————————————————————————————————————————————————————
// Patch construction: locate a `remove` block verbatim in the base, replace it
// with `add`, wrap in three lines of context, merging change regions whose
// context windows touch so the patch is a valid, non-overlapping unified diff.
// ————————————————————————————————————————————————————————————————

interface Mod {
  remove: string[]
  add: string[]
}

interface Change {
  start: number
  end: number
  add: string[]
}

function locateBlock(lines: string[], block: string[], from: number): number {
  for (let i = from; i <= lines.length - block.length; i++) {
    let ok = true
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  throw new Error(`remove block not found: ${JSON.stringify(block[0])}`)
}

function buildPatch(baseLines: string[], mods: Mod[]): { headContent: string; patch: string } {
  const ctx = 3
  const changes: Change[] = []
  let search = 0
  for (const mod of mods) {
    const start = locateBlock(baseLines, mod.remove, search)
    const end = start + mod.remove.length
    changes.push({ start, end, add: mod.add })
    search = end
  }

  const headLines: string[] = []
  let hCursor = 0
  for (const c of changes) {
    for (let i = hCursor; i < c.start; i++) headLines.push(baseLines[i])
    headLines.push(...c.add)
    hCursor = c.end
  }
  for (let i = hCursor; i < baseLines.length; i++) headLines.push(baseLines[i])

  const groups: Change[][] = []
  for (const c of changes) {
    const last = groups[groups.length - 1]
    if (last && c.start - last[last.length - 1].end <= ctx * 2) {
      last.push(c)
    } else {
      groups.push([c])
    }
  }

  const parts: string[] = []
  for (const group of groups) {
    const first = group[0]
    const lastChange = group[group.length - 1]
    const hunkStart = Math.max(0, first.start - ctx)
    const hunkEnd = Math.min(baseLines.length, lastChange.end + ctx)
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let pos = hunkStart
    for (const c of group) {
      for (let i = pos; i < c.start; i++) {
        body.push(` ${baseLines[i]}`)
        oldCount++
        newCount++
      }
      for (let i = c.start; i < c.end; i++) {
        body.push(`-${baseLines[i]}`)
        oldCount++
      }
      for (const line of c.add) {
        body.push(`+${line}`)
        newCount++
      }
      pos = c.end
    }
    for (let i = pos; i < hunkEnd; i++) {
      body.push(` ${baseLines[i]}`)
      oldCount++
      newCount++
    }
    parts.push(`@@ -${hunkStart + 1},${oldCount} +${hunkStart + 1},${newCount} @@`)
    parts.push(...body)
  }
  return { headContent: headLines.join('\n'), patch: parts.join('\n') }
}

// ————————————————————————————————————————————————————————————————
// File 1 — tsconfig.json (the flip that started the churn).
// ————————————————————————————————————————————————————————————————

const tsconfigBase = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": false,
    "strictNullChecks": false,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
`.split('\n')

const tsconfigBuilt = buildPatch(tsconfigBase, [
  {
    remove: [
      '    "strict": false,',
      '    "strictNullChecks": false,',
      '    "noImplicitAny": true,',
    ],
    add: [
      '    "strict": true,',
      '    "strictNullChecks": true,',
      '    "strictFunctionTypes": true,',
      '    "noImplicitAny": true,',
      '    "exactOptionalPropertyTypes": true,',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// File 2 — src/metering/rollup-reader.ts (the nullable-map edge case dkozlov
// flags: a Map lookup that can miss but is treated as always present).
// ————————————————————————————————————————————————————————————————

const rollupBase = `import type { Meter, Reading } from './types'

/**
 * Reads pre-aggregated meter rollups keyed by meter id. The rollup map is built
 * once per billing window; readers look up a meter and sum its readings.
 */
export class RollupReader {
  constructor(private readonly rollups: Map<string, Reading[]>) {}

  totalFor(meter: Meter): number {
    const readings = this.rollups.get(meter.id)
    let total = 0
    for (const reading of readings) {
      total += reading.value
    }
    return total
  }

  meters(): string[] {
    return [...this.rollups.keys()]
  }
}
`.split('\n')

const rollupBuilt = buildPatch(rollupBase, [
  {
    remove: [
      '  totalFor(meter: Meter): number {',
      '    const readings = this.rollups.get(meter.id)',
      '    let total = 0',
      '    for (const reading of readings) {',
      '      total += reading.value',
      '    }',
      '    return total',
      '  }',
    ],
    add: [
      '  totalFor(meter: Meter): number {',
      '    const readings = this.rollups.get(meter.id) ?? []',
      '    let total = 0',
      '    for (const reading of readings) {',
      '      total += reading.value',
      '    }',
      '    return total',
      '  }',
      '',
      '  /** Latest reading for a meter, or null when the meter has no rollup. */',
      '  latestFor(meter: Meter): Reading | null {',
      '    const readings = this.rollups.get(meter.id)',
      '    if (!readings || readings.length === 0) return null',
      '    return readings[readings.length - 1]',
      '  }',
      '',
      '  /** True when a meter has a rollup with at least one reading. */',
      '  hasReadings(meter: Meter): boolean {',
      '    const readings = this.rollups.get(meter.id)',
      '    return readings !== undefined && readings.length > 0',
      '  }',
    ],
  },
  {
    remove: [
      '  meters(): string[] {',
      '    return [...this.rollups.keys()]',
      '  }',
      '}',
    ],
    add: [
      '  meters(): string[] {',
      '    return [...this.rollups.keys()]',
      '  }',
      '',
      '  /** Meter ids that actually have at least one reading. */',
      '  nonEmptyMeters(): string[] {',
      '    const out: string[] = []',
      '    for (const [id, readings] of this.rollups) {',
      '      if (readings.length > 0) out.push(id)',
      '    }',
      '    return out',
      '  }',
      '',
      '  /** Sum of every reading across every meter. */',
      '  grandTotal(): number {',
      '    let total = 0',
      '    for (const readings of this.rollups.values()) {',
      '      for (const reading of readings) total += reading.value',
      '    }',
      '    return total',
      '  }',
      '}',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// File 3 — src/billing/invoice.ts (optional customer address, nullable due date).
// ————————————————————————————————————————————————————————————————

const invoiceBase = `import type { Customer, LineItem } from './types'

export interface Invoice {
  id: string
  customer: Customer
  items: LineItem[]
  dueDate?: string
  discount?: { code: string; percent: number }
}

/** Sum the line items on an invoice, ignoring any without a resolved price. */
export function invoiceTotal(invoice: Invoice): number {
  return invoice.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

/** Format the customer's billing city for a receipt header. */
export function billingCity(invoice: Invoice): string {
  return invoice.customer.address.city.toUpperCase()
}
`.split('\n')

const invoiceBuilt = buildPatch(invoiceBase, [
  {
    remove: [
      '/** Sum the line items on an invoice, ignoring any without a resolved price. */',
      'export function invoiceTotal(invoice: Invoice): number {',
      '  return invoice.items.reduce((sum, item) => sum + item.price * item.quantity, 0)',
      '}',
    ],
    add: [
      '/** Sum the line items on an invoice, ignoring any without a resolved price. */',
      'export function invoiceTotal(invoice: Invoice): number {',
      '  const subtotal = invoice.items.reduce(',
      '    (sum, item) => sum + item.price * item.quantity,',
      '    0,',
      '  )',
      '  const percent = invoice.discount?.percent ?? 0',
      '  return subtotal - Math.round((subtotal * percent) / 100)',
      '}',
    ],
  },
  {
    remove: ['/** Format the customer\'s billing city for a receipt header. */', 'export function billingCity(invoice: Invoice): string {', '  return invoice.customer.address.city.toUpperCase()', '}'],
    add: [
      "/** Format the customer's billing city for a receipt header, or 'N/A'. */",
      'export function billingCity(invoice: Invoice): string {',
      '  const city = invoice.customer.address?.city',
      "  return city ? city.toUpperCase() : 'N/A'",
      '}',
      '',
      '/** Days until an invoice is due, or null when it has no due date. */',
      'export function daysUntilDue(invoice: Invoice, now: number): number | null {',
      '  if (!invoice.dueDate) return null',
      '  const due = Date.parse(invoice.dueDate)',
      '  return Math.ceil((due - now) / 86_400_000)',
      '}',
      '',
      "export type DueStatus = 'no-date' | 'overdue' | 'due-soon' | 'scheduled'",
      '',
      '/** Classify an invoice by how close its due date is, tolerating a null date. */',
      'export function dueStatus(invoice: Invoice, now: number): DueStatus {',
      '  const days = daysUntilDue(invoice, now)',
      "  if (days === null) return 'no-date'",
      "  if (days < 0) return 'overdue'",
      "  if (days <= 3) return 'due-soon'",
      "  return 'scheduled'",
      '}',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// File 4 — src/events/session-store.ts (Map.get that may be undefined).
// ————————————————————————————————————————————————————————————————

const sessionBase = `import type { Session } from './types'

/** In-memory session store keyed by token. */
export class SessionStore {
  private sessions = new Map<string, Session>()

  put(token: string, session: Session): void {
    this.sessions.set(token, session)
  }

  userIdFor(token: string): string {
    return this.sessions.get(token).userId
  }

  touch(token: string, now: number): void {
    const session = this.sessions.get(token)
    session.lastSeen = now
  }

  lastSeen(token: string): number {
    return this.sessions.get(token).lastSeen
  }
}
`.split('\n')

const sessionBuilt = buildPatch(sessionBase, [
  {
    remove: [
      '  userIdFor(token: string): string {',
      '    return this.sessions.get(token).userId',
      '  }',
      '',
      '  touch(token: string, now: number): void {',
      '    const session = this.sessions.get(token)',
      '    session.lastSeen = now',
      '  }',
      '',
      '  lastSeen(token: string): number {',
      '    return this.sessions.get(token).lastSeen',
      '  }',
    ],
    add: [
      '  userIdFor(token: string): string | null {',
      '    return this.sessions.get(token)?.userId ?? null',
      '  }',
      '',
      '  touch(token: string, now: number): void {',
      '    const session = this.sessions.get(token)',
      '    if (!session) return',
      '    session.lastSeen = now',
      '  }',
      '',
      '  lastSeen(token: string): number | null {',
      '    return this.sessions.get(token)?.lastSeen ?? null',
      '  }',
      '',
      '  /** Remove a session, returning whether one was present. */',
      '  remove(token: string): boolean {',
      '    return this.sessions.delete(token)',
      '  }',
      '',
      '  /** Drop sessions not seen since the given cutoff. */',
      '  pruneIdle(cutoff: number): number {',
      '    let removed = 0',
      '    for (const [token, session] of this.sessions) {',
      '      if (session.lastSeen < cutoff) {',
      '        this.sessions.delete(token)',
      '        removed++',
      '      }',
      '    }',
      '    return removed',
      '  }',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// File 5 — src/config/env.ts (env vars are string | undefined under strict).
// ————————————————————————————————————————————————————————————————

const envBase = `/** Read a required environment variable, throwing when it is unset. */
export function required(key: string): string {
  const value = process.env[key]
  return value.trim()
}

/** Read an optional environment variable with a fallback. */
export function optional(key: string, fallback: string): string {
  return process.env[key] || fallback
}
`.split('\n')

const envBuilt = buildPatch(envBase, [
  {
    remove: [
      '/** Read a required environment variable, throwing when it is unset. */',
      'export function required(key: string): string {',
      '  const value = process.env[key]',
      '  return value.trim()',
      '}',
      '',
      '/** Read an optional environment variable with a fallback. */',
      'export function optional(key: string, fallback: string): string {',
      '  return process.env[key] || fallback',
      '}',
    ],
    add: [
      '/** Read a required environment variable, throwing when it is unset. */',
      'export function required(key: string): string {',
      '  const value = process.env[key]',
      '  if (value === undefined) {',
      '    throw new Error(`missing required environment variable: ${key}`)',
      '  }',
      '  return value.trim()',
      '}',
      '',
      '/** Read an optional environment variable with a fallback. */',
      'export function optional(key: string, fallback: string): string {',
      '  const value = process.env[key]',
      '  return value === undefined || value.length === 0 ? fallback : value',
      '}',
      '',
      '/** Read a required environment variable as an integer, validating it. */',
      'export function requiredInt(key: string): number {',
      '  const raw = required(key)',
      '  const value = Number.parseInt(raw, 10)',
      '  if (Number.isNaN(value)) {',
      '    throw new Error(`environment variable ${key} is not an integer: ${raw}`)',
      '  }',
      '  return value',
      '}',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// File 6 — src/scheduler/window.ts (nullable "current window" that strict flags).
// ————————————————————————————————————————————————————————————————

const windowBase = `import type { BillingWindow } from './types'

/**
 * Tracks the currently open billing window. Windows are opened and closed as
 * time advances; only one is open at a time.
 */
export class WindowTracker {
  private current: BillingWindow | null = null
  private history: BillingWindow[] = []

  open(window: BillingWindow): void {
    this.current = window
  }

  close(now: number): void {
    this.current.closedAt = now
    this.history.push(this.current)
    this.current = null
  }

  endOfCurrent(): Date {
    return new Date(this.current.endsAt)
  }

  count(): number {
    return this.history.length
  }
}
`.split('\n')

const windowBuilt = buildPatch(windowBase, [
  {
    remove: [
      '  close(now: number): void {',
      '    this.current.closedAt = now',
      '    this.history.push(this.current)',
      '    this.current = null',
      '  }',
      '',
      '  endOfCurrent(): Date {',
      '    return new Date(this.current.endsAt)',
      '  }',
    ],
    add: [
      '  close(now: number): void {',
      '    if (!this.current) {',
      "      throw new Error('no window is open')",
      '    }',
      '    this.current.closedAt = now',
      '    this.history.push(this.current)',
      '    this.current = null',
      '  }',
      '',
      '  /** End of the open window, or null when no window is currently open. */',
      '  endOfCurrent(): Date | null {',
      '    return this.current ? new Date(this.current.endsAt) : null',
      '  }',
      '',
      '  /** Whether a window is currently open. */',
      '  hasOpen(): boolean {',
      '    return this.current !== null',
      '  }',
      '',
      '  /** The most recently closed window, or null when none have closed yet. */',
      '  lastClosed(): BillingWindow | null {',
      '    return this.history.length === 0',
      '      ? null',
      '      : this.history[this.history.length - 1]',
      '  }',
      '',
      '  /** Find a historical window covering the given instant, or null. */',
      '  windowAt(instant: number): BillingWindow | null {',
      '    for (const window of this.history) {',
      '      if (instant >= window.startsAt && instant < window.endsAt) {',
      '        return window',
      '      }',
      '    }',
      '    return null',
      '  }',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// Blobs. Base is pre-edit; head is authored above (or derived by buildPatch).
// ————————————————————————————————————————————————————————————————

const tsconfigBaseBlob = blob('tsconfig.json', tsconfigBase.join('\n'), 'pr362-tsconfig-base')
const tsconfigHead = blob('tsconfig.json', tsconfigBuilt.headContent, 'pr362-tsconfig-head')
const rollupBaseBlob = blob('src/metering/rollup-reader.ts', rollupBase.join('\n'), 'pr362-rollup-base')
const rollupHead = blob('src/metering/rollup-reader.ts', rollupBuilt.headContent, 'pr362-rollup-head')
const invoiceBaseBlob = blob('src/billing/invoice.ts', invoiceBase.join('\n'), 'pr362-invoice-base')
const invoiceHead = blob('src/billing/invoice.ts', invoiceBuilt.headContent, 'pr362-invoice-head')
const sessionBaseBlob = blob('src/events/session-store.ts', sessionBase.join('\n'), 'pr362-session-base')
const sessionHead = blob('src/events/session-store.ts', sessionBuilt.headContent, 'pr362-session-head')
const envBaseBlob = blob('src/config/env.ts', envBase.join('\n'), 'pr362-env-base')
const envHead = blob('src/config/env.ts', envBuilt.headContent, 'pr362-env-head')
const windowBaseBlob = blob('src/scheduler/window.ts', windowBase.join('\n'), 'pr362-window-base')
const windowHead = blob('src/scheduler/window.ts', windowBuilt.headContent, 'pr362-window-head')

const files: PullFile[] = [
  pullFile({
    sha: tsconfigHead.sha,
    filename: 'tsconfig.json',
    status: 'modified',
    patch: tsconfigBuilt.patch,
  }),
  pullFile({
    sha: rollupHead.sha,
    filename: 'src/metering/rollup-reader.ts',
    status: 'modified',
    patch: rollupBuilt.patch,
  }),
  pullFile({
    sha: invoiceHead.sha,
    filename: 'src/billing/invoice.ts',
    status: 'modified',
    patch: invoiceBuilt.patch,
  }),
  pullFile({
    sha: sessionHead.sha,
    filename: 'src/events/session-store.ts',
    status: 'modified',
    patch: sessionBuilt.patch,
  }),
  pullFile({
    sha: envHead.sha,
    filename: 'src/config/env.ts',
    status: 'modified',
    patch: envBuilt.patch,
  }),
  pullFile({
    sha: windowHead.sha,
    filename: 'src/scheduler/window.ts',
    status: 'modified',
    patch: windowBuilt.patch,
  }),
]

const blobs: FileBlob[] = [
  tsconfigBaseBlob,
  tsconfigHead,
  rollupBaseBlob,
  rollupHead,
  invoiceBaseBlob,
  invoiceHead,
  sessionBaseBlob,
  sessionHead,
  envBaseBlob,
  envHead,
  windowBaseBlob,
  windowHead,
]

const blobIndex: Record<string, { base: string | null; head: string | null }> = {
  'tsconfig.json': { base: tsconfigBaseBlob.sha, head: tsconfigHead.sha },
  'src/metering/rollup-reader.ts': { base: rollupBaseBlob.sha, head: rollupHead.sha },
  'src/billing/invoice.ts': { base: invoiceBaseBlob.sha, head: invoiceHead.sha },
  'src/events/session-store.ts': { base: sessionBaseBlob.sha, head: sessionHead.sha },
  'src/config/env.ts': { base: envBaseBlob.sha, head: envHead.sha },
  'src/scheduler/window.ts': { base: windowBaseBlob.sha, head: windowHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Commits — three over two days.
// ————————————————————————————————————————————————————————————————

const commits: CommitInfo[] = [
  {
    sha: 'a10b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4',
    commit: {
      message: 'chore(ts): flip strictNullChecks on',
      author: { name: MARCUS.name, email: MARCUS.email, date: daysAgo(2) },
    },
    author: BROKER_BOT,
    parents: [{ sha: MERGE_BASE_SHA }],
  },
  {
    sha: 'b21c3d4e5f6071829304a5b6c7d8e9f012b3c4d5',
    commit: {
      message: 'fix(metering,billing): guard nullable lookups',
      author: { name: MARCUS.name, email: MARCUS.email, date: daysAgo(1) },
    },
    author: BROKER_BOT,
    parents: [{ sha: 'a10b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4' }],
  },
  {
    sha: HEAD_SHA,
    commit: {
      message: 'fix(config,events): env + session null guards',
      author: { name: MARCUS.name, email: MARCUS.email, date: hoursAgo(4) },
    },
    author: BROKER_BOT,
    parents: [{ sha: 'b21c3d4e5f6071829304a5b6c7d8e9f012b3c4d5' }],
  },
]

// ————————————————————————————————————————————————————————————————
// Thread — one unresolved, from dkozlov on the nullable-map edge case, with a
// prefixed reply from Marcus. The org member's comment keeps its real identity;
// the contractor reply is posted by the broker bot with a name prefix.
// ————————————————————————————————————————————————————————————————

// The thread is anchored on the totalFor null-guard; its diff_hunk is the
// single unified-diff hunk that contains that change (the first hunk of the
// rollup patch), matching GitHub's per-comment diff_hunk shape.
const rollupDiffHunk = rollupBuilt.patch.split(/\n(?=@@ )/)[0]

const threads: ReviewThread[] = [
  {
    id: nodeId('PRRT', 36201),
    isResolved: false,
    isOutdated: false,
    path: 'src/metering/rollup-reader.ts',
    line: 12,
    originalLine: 12,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [
      {
        id: 3620101,
        node_id: nodeId('PRRC', 3620101),
        pull_request_review_id: null,
        path: 'src/metering/rollup-reader.ts',
        diff_hunk: rollupDiffHunk,
        commit_id: HEAD_SHA,
        original_commit_id: HEAD_SHA,
        line: 12,
        original_line: 12,
        start_line: null,
        original_start_line: null,
        side: 'RIGHT',
        start_side: null,
        subject_type: 'line',
        user: ORG_DKOZLOV,
        body: "`?? []` silently returns 0 for a meter that has no rollup — but a missing rollup and a genuinely zero-usage meter are different things for billing. We've been bitten by this before: a rollup that failed to build looks identical to zero usage and we under-bill. Can `totalFor` return `number | null` and let the caller decide, rather than papering over the miss?",
        created_at: daysAgo(1),
        updated_at: daysAgo(1),
        reactions: emptyReactions(3620101),
        html_url: `https://github.com/${OWNER}/pull/362#discussion_r3620101`,
      },
      {
        id: 3620102,
        node_id: nodeId('PRRC', 3620102),
        pull_request_review_id: null,
        in_reply_to_id: 3620101,
        path: 'src/metering/rollup-reader.ts',
        diff_hunk: rollupDiffHunk,
        commit_id: HEAD_SHA,
        original_commit_id: HEAD_SHA,
        line: 12,
        original_line: 12,
        start_line: null,
        original_start_line: null,
        side: 'RIGHT',
        start_side: null,
        subject_type: 'line',
        user: BROKER_BOT,
        body: prefixBody(
          MARCUS,
          "Fair — the two cases are genuinely different and I was flattening them. I'd rather not change `totalFor`'s signature in this PR (it ripples into the billing run and the reconciler), so I've left it returning `0` for now but added `latestFor` returning `Reading | null` so callers that care can detect a missing rollup. If you'd prefer `totalFor` itself go nullable I'll split that into a follow-up rather than widen this diff — your call.",
        ),
        created_at: hoursAgo(6),
        updated_at: hoursAgo(6),
        reactions: emptyReactions(3620102),
        html_url: `https://github.com/${OWNER}/pull/362#discussion_r3620102`,
      },
    ],
  },
]

// ————————————————————————————————————————————————————————————————
// Checks — typecheck FAILURE, tests FAILURE, lint success.
// ————————————————————————————————————————————————————————————————

const checks: CheckRun[] = [
  {
    id: 362010,
    name: 'ci/typecheck',
    status: 'completed',
    conclusion: 'failure',
    started_at: hoursAgo(4),
    completed_at: hoursAgo(4),
    details_url: `https://github.com/${OWNER}/pull/362/checks?check_run_id=362010`,
    output: {
      title: 'tsc found 14 errors',
      summary: [
        'Enabling strictNullChecks surfaced 14 pre-existing null-safety errors. Three examples:',
        '',
        "- `src/metering/reconciler.ts:88` — Object is possibly 'undefined'.",
        "- `src/billing/run.ts:142` — Type 'string | undefined' is not assignable to type 'string'.",
        "- `src/events/dispatch.ts:57` — 'session' is possibly 'null'.",
        '',
        'Full log below.',
      ].join('\n'),
      text: [
        '$ bun run typecheck',
        '$ tsc -p tsconfig.json --noEmit',
        '',
        "src/metering/reconciler.ts(88,7): error TS2532: Object is possibly 'undefined'.",
        "src/metering/reconciler.ts(91,25): error TS18048: 'rollup' is possibly 'undefined'.",
        "src/billing/run.ts(142,11): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
        "src/billing/run.ts(160,18): error TS2345: Argument of type 'number | null' is not assignable to parameter of type 'number'.",
        "src/events/dispatch.ts(57,5): error TS18047: 'session' is possibly 'null'.",
        "src/events/dispatch.ts(63,9): error TS18047: 'session' is possibly 'null'.",
        "src/config/loader.ts(29,12): error TS2532: Object is possibly 'undefined'.",
        "src/config/loader.ts(44,20): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
        "src/api/handlers/usage.ts(73,15): error TS18048: 'meter' is possibly 'undefined'.",
        "src/api/handlers/usage.ts(80,7): error TS2532: Object is possibly 'undefined'.",
        "src/scheduler/window.ts(51,10): error TS18047: 'current' is possibly 'null'.",
        "src/scheduler/window.ts(58,22): error TS2322: Type 'Date | null' is not assignable to type 'Date'.",
        "src/metering/export.ts(112,9): error TS2532: Object is possibly 'undefined'.",
        "src/metering/export.ts(119,30): error TS18048: 'reading' is possibly 'undefined'.",
        'Found 14 errors in 6 files.',
        '',
        'error: script "typecheck" exited with code 2',
      ].join('\n'),
    },
  },
  {
    id: 362011,
    name: 'ci/tests',
    status: 'completed',
    conclusion: 'failure',
    started_at: hoursAgo(4),
    completed_at: hoursAgo(3),
    details_url: `https://github.com/${OWNER}/pull/362/checks?check_run_id=362011`,
    output: {
      title: '4 suites failed',
      summary: [
        '4 suites failed, 27 passed. The failures follow from the null-guard changes:',
        '',
        '- `metering/rollup-reader.test.ts` — expected total 0 for a missing meter, now asserts via `latestFor`.',
        '- `billing/invoice.test.ts` — `billingCity` returns `N/A` where the fixture expected a throw.',
        '- `events/session-store.test.ts` — `userIdFor` now returns `null` for an unknown token.',
        '- `config/env.test.ts` — `required` throws a new message the test pins verbatim.',
      ].join('\n'),
      text: [
        '$ bun test',
        '(fail) metering/rollup-reader.test.ts > totalFor sums a meter\'s readings',
        '(fail) billing/invoice.test.ts > billingCity throws on missing address',
        '(fail) events/session-store.test.ts > userIdFor returns the user id',
        '(fail) config/env.test.ts > required returns the trimmed value',
        '',
        ' 27 pass',
        ' 4 fail',
        'error: script "test" exited with code 1',
      ].join('\n'),
    },
  },
  {
    id: 362012,
    name: 'ci/lint',
    status: 'completed',
    conclusion: 'success',
    started_at: hoursAgo(4),
    completed_at: hoursAgo(4),
    details_url: `https://github.com/${OWNER}/pull/362/checks?check_run_id=362012`,
    output: {
      title: 'no lint errors',
      summary: 'eslint: 0 errors, 0 warnings across 148 files.',
    },
  },
]

// ————————————————————————————————————————————————————————————————
// Issue comments / reviews — none of either; the conversation lives on the one
// review thread.
// ————————————————————————————————————————————————————————————————

const issueComments: IssueComment[] = []
const reviews: ReviewSummary[] = []

// ————————————————————————————————————————————————————————————————
// Detail counts — honest sums from every file's derived counts.
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((sum, f) => sum + f.additions, 0)
const deletions = files.reduce((sum, f) => sum + f.deletions, 0)

const detail: PullDetail = {
  id: 100000362,
  node_id: nodeId('PR', 362),
  number: 362,
  state: 'open',
  draft: false,
  merged_at: null,
  merged: false,
  mergeable: false,
  mergeable_state: 'dirty',
  title: 'chore(ts): enable strictNullChecks across services',
  body: prefixBody(
    MARCUS,
    [
      'Turns on `strictNullChecks` (and a couple of adjacent strict flags) and fixes the null-safety holes it surfaces in metering, billing, config, and the session store.',
      '',
      'CI is red on purpose right now — the flip found 14 pre-existing errors across six files this PR does not yet touch, and four suites pin behaviour that the null guards deliberately change. I will push the remaining fixes and update the tests once we agree on the `totalFor` question below.',
      '',
      'Heads up: this sits on `chore/node-22` so the strict flags land on the pinned toolchain, and it now conflicts with that branch after the billing rename came through — I will rebase once the direction is settled so I do not redo the conflict resolution twice.',
    ].join('\n'),
  ),
  user: BROKER_BOT,
  labels: [
    { id: 6001, name: 'typescript', color: '3178C6', description: 'TypeScript config' },
    { id: 6002, name: 'blocked', color: 'E5645E', description: 'Blocked on discussion' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'marcus/strict-null-checks',
    sha: HEAD_SHA,
    label: 'meridian-labs:marcus/strict-null-checks',
    repo: { full_name: OWNER, default_branch: REPO.default_branch },
  },
  base: {
    ref: 'chore/node-22',
    sha: BASE_SHA,
    label: 'meridian-labs:chore/node-22',
    repo: { full_name: OWNER, default_branch: REPO.default_branch },
  },
  merge_base_sha: MERGE_BASE_SHA,
  comments: issueComments.length,
  review_comments: threads.reduce((sum, t) => sum + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
  created_at: daysAgo(2),
  updated_at: hoursAgo(4),
}

export const pr362: RemotePull = {
  detail,
  files,
  blobs,
  blobIndex,
  threads,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-marcus',
    canApprove: false,
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-alice'],
    compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    commitCount: commits.length,
  },
}

// ————————————————————————————————————————————————————————————————
// Seeds — a fresh snapshot synced twenty minutes ago; honest sync stats. Each
// file's base and head blob transfers, none reused (first sync of this PR).
// ————————————————————————————————————————————————————————————————

const seededSnapshot = buildSnapshot(pr362, minutesAgo(20), {
  syncStats: { blobsFetched: 12, blobsReused: 0, requests: 15 },
})

export const pr362Seeds: FixtureSeeds = {
  snapshots: [seededSnapshot],
}

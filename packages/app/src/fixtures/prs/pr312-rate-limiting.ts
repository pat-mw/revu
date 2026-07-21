import type { CheckRun, CommitInfo, GhUser, Human, IssueComment, PendingComment, PullDetail, PullFile, ReactionRollup, ReviewComment, ReviewDraft, ReviewSummary, ReviewThread } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import type { FixtureSeeds, RemotePull } from '../contract'
import { BROKER_BOT, HUMANS, ORG_DKOZLOV, REPO } from '../cast'
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
  reactions,
} from '../helpers'

/**
 * PR #312 — the mid-review workhorse. Contractor-authored (broker bot on the
 * GitHub side, Alice smuggled in body prefixes), four commits over three days,
 * a mix of resolved / unresolved / outdated / suggestion / file-level threads,
 * and one submitted review from the client's tech lead. Pre-synced 45 minutes
 * ago with a pending draft from Priya, so the demo opens onto live-feeling
 * review state without a first sync.
 */

function human(id: string): Human {
  const h = HUMANS.find((x) => x.id === id)
  if (!h) throw new Error(`fixture cast has no human ${id}`)
  return h
}

const alice = human('h-alice')
const marcus = human('h-marcus')
const priya = human('h-priya')

const MERGE_BASE_SHA = fakeSha('pr312/merge-base')
const C1_SHA = fakeSha('pr312/c1')
const C2_SHA = fakeSha('pr312/c2')
const C3_SHA = fakeSha('pr312/c3')
const C4_SHA = fakeSha('pr312/c4')
const HEAD_SHA = C4_SHA
const MAIN_TIP_SHA = fakeSha('atlas/main/tip')
const COMPARE_KEY = `${MERGE_BASE_SHA}...${HEAD_SHA}`

// ————— local patch/anchor helpers —————

/** Unified-diff patch for a newly added file: one hunk, every line an addition. */
function addedPatch(content: string): string {
  const lines = content.split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
}

/**
 * Tail of an added-file hunk, ending at `line` (1-based): the fragment a
 * review comment carries in `diff_hunk`, trimmed to the last `span` lines so
 * fixtures stay readable while every shown line really comes from the patch.
 */
function addedHunkFragment(lines: string[], line: number, span = 10): string {
  const start = Math.max(0, line - span)
  return [
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.slice(start, line).map((l) => `+${l}`),
  ].join('\n')
}

/** 1-based line number of an exact line in a blob — throws on fixture drift. */
function lineNumberOf(lines: string[], text: string): number {
  const idx = lines.indexOf(text)
  if (idx === -1) throw new Error(`fixture blob is missing expected line: ${text}`)
  return idx + 1
}

// ————— src/gateway/rate-limit.ts (added — the main file) —————

const rateLimitHeadContent = `import { clock } from '../lib/clock'
import { RateLimitExceededError } from './errors'
import type { GatewayConfig, TenantLimitOverride } from './config'

/**
 * Token-bucket rate limiting, one bucket per tenant per route class.
 *
 * Buckets refill continuously instead of on window boundaries: every call
 * computes the tokens earned since the last refill from elapsed monotonic
 * time, so a briefly idle tenant regains capacity smoothly rather than
 * slamming into a fixed-window reset.
 */

export interface BucketConfig {
  /** Maximum burst size — the bucket never holds more than this. */
  capacity: number
  /** Steady-state tokens added per second. */
  refillPerSecond: number
}

export interface RateDecision {
  allowed: boolean
  /** Whole tokens left after this decision, for the rate-limit header. */
  remaining: number
  /** Milliseconds until a token is available; 0 when allowed. */
  retryAfterMs: number
}

interface BucketState {
  tokens: number
  /** Monotonic timestamp (ms) of the last refill computation. */
  lastRefillAt: number
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, BucketState>()
  private readonly defaults: BucketConfig
  private readonly overrides = new Map<string, TenantLimitOverride>()

  constructor(defaults: BucketConfig, overrides: Iterable<TenantLimitOverride> = []) {
    this.defaults = defaults
    for (const override of overrides) {
      this.overrides.set(override.tenantId, override)
    }
  }

  /** Effective bucket parameters for a tenant, override-aware. */
  limitsFor(tenantId: string): BucketConfig {
    const override = this.overrides.get(tenantId)
    if (!override) return this.defaults
    return {
      capacity: override.capacity ?? this.defaults.capacity,
      refillPerSecond: override.refillPerSecond ?? this.defaults.refillPerSecond,
    }
  }

  /**
   * Take one token for the tenant, refilling first. The refill keeps
   * fractional tokens on purpose: rounding at low refill rates would starve
   * tenants whose requests arrive faster than one whole token apart.
   */
  take(tenantId: string, routeClass: string): RateDecision {
    const limits = this.limitsFor(tenantId)
    const key = \`\${tenantId}:\${routeClass}\`
    const now = clock.monotonicMs()
    let state = this.buckets.get(key)
    if (!state) {
      state = { tokens: limits.capacity, lastRefillAt: now }
      this.buckets.set(key, state)
    }
    const elapsedSeconds = (now - state.lastRefillAt) / 1000
    const refilled = state.tokens + elapsedSeconds * limits.refillPerSecond
    state.tokens = Math.min(limits.capacity, refilled)
    state.lastRefillAt = now
    if (state.tokens >= 1) {
      state.tokens -= 1
      return { allowed: true, remaining: Math.floor(state.tokens), retryAfterMs: 0 }
    }
    const deficit = 1 - state.tokens
    const retryAfterMs = Math.ceil((deficit / limits.refillPerSecond) * 1000)
    return { allowed: false, remaining: 0, retryAfterMs }
  }

  /** Take a token or throw the gateway's typed rate-limit error. */
  enforce(tenantId: string, routeClass: string): RateDecision {
    const decision = this.take(tenantId, routeClass)
    if (!decision.allowed) {
      throw new RateLimitExceededError(tenantId, routeClass, decision.retryAfterMs)
    }
    return decision
  }

  /** Drop buckets idle past \`idleMs\` — bounds memory on long-lived nodes. */
  evictIdle(idleMs: number): number {
    const cutoff = clock.monotonicMs() - idleMs
    let evicted = 0
    for (const [key, state] of this.buckets) {
      if (state.lastRefillAt < cutoff) {
        this.buckets.delete(key)
        evicted++
      }
    }
    return evicted
  }
}

export function limiterFromConfig(config: GatewayConfig): TokenBucketLimiter {
  return new TokenBucketLimiter(
    {
      capacity: config.rateLimit.capacity,
      refillPerSecond: config.rateLimit.refillPerSecond,
    },
    config.rateLimit.tenantOverrides,
  )
}`

const rateLimitHeadLines = rateLimitHeadContent.split('\n')

// ————— src/gateway/rate-limit.test.ts (added) —————

const rateLimitTestHeadContent = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clock } from '../lib/clock'
import { RateLimitExceededError } from './errors'
import { TokenBucketLimiter } from './rate-limit'

const DEFAULTS = { capacity: 10, refillPerSecond: 2 }

let nowMs = 0

beforeEach(() => {
  nowMs = 1_000_000
  vi.spyOn(clock, 'monotonicMs').mockImplementation(() => nowMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TokenBucketLimiter.take', () => {
  it('serves a full burst from a fresh bucket, then rejects', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS)
    for (let i = 0; i < 10; i++) {
      expect(limiter.take('tn_a', 'read').allowed).toBe(true)
    }
    expect(limiter.take('tn_a', 'read').allowed).toBe(false)
  })

  it('refills continuously from elapsed time', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS)
    for (let i = 0; i < 10; i++) limiter.take('tn_a', 'read')
    nowMs += 500
    expect(limiter.take('tn_a', 'read').allowed).toBe(true)
    expect(limiter.take('tn_a', 'read').allowed).toBe(false)
  })

  it('never refills past capacity', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS)
    limiter.take('tn_a', 'read')
    nowMs += 3_600_000
    expect(limiter.take('tn_a', 'read').remaining).toBe(9)
  })

  it('treats zero elapsed time as zero refill', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS)
    for (let i = 0; i < 10; i++) limiter.take('tn_a', 'read')
    const decision = limiter.take('tn_a', 'read')
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBe(500)
  })

  it('isolates buckets per tenant and per route class', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS)
    for (let i = 0; i < 10; i++) limiter.take('tn_a', 'read')
    expect(limiter.take('tn_a', 'read').allowed).toBe(false)
    expect(limiter.take('tn_a', 'write').allowed).toBe(true)
    expect(limiter.take('tn_b', 'read').allowed).toBe(true)
  })

  it('applies tenant overrides', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS, [
      { tenantId: 'tn_small', capacity: 2 },
    ])
    expect(limiter.take('tn_small', 'read').allowed).toBe(true)
    expect(limiter.take('tn_small', 'read').allowed).toBe(true)
    expect(limiter.take('tn_small', 'read').allowed).toBe(false)
  })
})

describe('TokenBucketLimiter.enforce', () => {
  it('throws the typed 429 error when the bucket is empty', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 })
    limiter.enforce('tn_a', 'read')
    expect(() => limiter.enforce('tn_a', 'read')).toThrowError(RateLimitExceededError)
  })
})

describe('TokenBucketLimiter.evictIdle', () => {
  it('drops buckets idle past the cutoff and keeps active ones', () => {
    const limiter = new TokenBucketLimiter(DEFAULTS)
    limiter.take('tn_idle', 'read')
    nowMs += 60_000
    limiter.take('tn_active', 'read')
    expect(limiter.evictIdle(30_000)).toBe(1)
  })
})`

// ————— docs/rate-limiting.md (added) —————

const docsHeadContent = `# Per-tenant rate limiting

The gateway enforces a token-bucket limit per tenant per route class
(\`read\`, \`write\`, \`admin\`). Buckets live in gateway process memory.

## Semantics

- Every request takes one token from the bucket keyed
  \`\${tenantId}:\${routeClass}\`.
- Buckets refill continuously: capacity accrues every millisecond at
  \`refillPerSecond\`, clamped at \`capacity\`.
- A new bucket starts full, so a tenant's first burst after idling is
  never penalized.

## Scope (v1)

Limiting is **per gateway node**. A tenant reaching the fleet through N
pods can spend up to N× the configured rate. This is deliberate for v1:
buckets stay lock-free and in-process, and the autoscaler holds the
fleet at 2–3 pods. Fleet-accurate limiting needs a shared store on the
hot path and is scoped to v2.

Event ingestion does not pass through this limiter — the collector has
its own quota system.

## Configuration

\`\`\`json
{
  "rateLimit": {
    "capacity": 120,
    "refillPerSecond": 10,
    "tenantOverrides": [
      { "tenantId": "tn_9f3ab2", "capacity": 600, "refillPerSecond": 50 }
    ]
  }
}
\`\`\`

## Responses

Over-limit requests receive \`429\` with error code \`rate_limited\` and a
\`retry-after\` header (integer seconds, rounded up). Every gateway
response carries \`x-ratelimit-remaining\`, floored to whole tokens.`

// ————— src/gateway/config.ts (modified) —————

const configBaseContent = `import { readFileSync } from 'node:fs'
import { z } from 'zod'

const upstreamSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(5_000),
})

export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(8080),
  upstreams: z.array(upstreamSchema).min(1),
  corsOrigins: z.array(z.string()).default([]),
})

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>

export function loadConfig(path: string): GatewayConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return gatewayConfigSchema.parse(raw)
}`

const configHeadContent = `import { readFileSync } from 'node:fs'
import { z } from 'zod'

const upstreamSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(5_000),
})

const tenantOverrideSchema = z.object({
  tenantId: z.string().min(1),
  capacity: z.number().int().positive().optional(),
  refillPerSecond: z.number().positive().optional(),
})

const rateLimitSchema = z.object({
  capacity: z.number().int().positive().default(120),
  refillPerSecond: z.number().positive().default(10),
  tenantOverrides: z.array(tenantOverrideSchema).default([]),
})

export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(8080),
  upstreams: z.array(upstreamSchema).min(1),
  corsOrigins: z.array(z.string()).default([]),
  rateLimit: rateLimitSchema.default({}),
})

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>
export type TenantLimitOverride = z.infer<typeof tenantOverrideSchema>

export function loadConfig(path: string): GatewayConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return gatewayConfigSchema.parse(raw)
}`

const configPatch = `@@ -7,13 +7,27 @@ const upstreamSchema = z.object({
   timeoutMs: z.number().int().positive().default(5_000),
 })

+const tenantOverrideSchema = z.object({
+  tenantId: z.string().min(1),
+  capacity: z.number().int().positive().optional(),
+  refillPerSecond: z.number().positive().optional(),
+})
+
+const rateLimitSchema = z.object({
+  capacity: z.number().int().positive().default(120),
+  refillPerSecond: z.number().positive().default(10),
+  tenantOverrides: z.array(tenantOverrideSchema).default([]),
+})
+
 export const gatewayConfigSchema = z.object({
   port: z.number().int().min(1).max(65_535).default(8080),
   upstreams: z.array(upstreamSchema).min(1),
   corsOrigins: z.array(z.string()).default([]),
+  rateLimit: rateLimitSchema.default({}),
 })

 export type GatewayConfig = z.infer<typeof gatewayConfigSchema>
+export type TenantLimitOverride = z.infer<typeof tenantOverrideSchema>

 export function loadConfig(path: string): GatewayConfig {
   const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown`

// ————— src/gateway/middleware.ts (modified) —————

const middlewareBaseContent = `import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveTenant } from '../auth/tenant'
import { GatewayError } from './errors'

export interface RequestContext {
  tenantId: string
  routeClass: 'read' | 'write' | 'admin'
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext
  }
}

export function classifyRoute(method: string): RequestContext['routeClass'] {
  if (method === 'GET' || method === 'HEAD') return 'read'
  return 'write'
}

export function registerContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const tenant = await resolveTenant(req.headers.authorization)
    req.ctx = { tenantId: tenant.id, routeClass: classifyRoute(req.method) }
  })
}

export function registerErrorMapping(app: FastifyInstance): void {
  app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof GatewayError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message })
    }
    return reply.status(500).send({ error: 'internal', message: 'unexpected error' })
  })
}`

const middlewareHeadContent = `import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveTenant } from '../auth/tenant'
import { GatewayError, RateLimitExceededError } from './errors'
import type { TokenBucketLimiter } from './rate-limit'

export interface RequestContext {
  tenantId: string
  routeClass: 'read' | 'write' | 'admin'
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext
  }
}

export function classifyRoute(method: string): RequestContext['routeClass'] {
  if (method === 'GET' || method === 'HEAD') return 'read'
  return 'write'
}

export function registerContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const tenant = await resolveTenant(req.headers.authorization)
    req.ctx = { tenantId: tenant.id, routeClass: classifyRoute(req.method) }
  })
}

/**
 * Rejects over-limit requests before any upstream work happens. Runs as a
 * preHandler (after auth) because the bucket key is the resolved tenant.
 */
export function registerRateLimit(app: FastifyInstance, limiter: TokenBucketLimiter): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const decision = limiter.take(req.ctx.tenantId, req.ctx.routeClass)
    reply.header('x-ratelimit-remaining', String(decision.remaining))
    if (!decision.allowed) {
      reply.header('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)))
      throw new RateLimitExceededError(req.ctx.tenantId, req.ctx.routeClass, decision.retryAfterMs)
    }
  })
}

export function registerErrorMapping(app: FastifyInstance): void {
  app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof GatewayError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message })
    }
    return reply.status(500).send({ error: 'internal', message: 'unexpected error' })
  })
}`

const middlewarePatch = `@@ -1,6 +1,7 @@
 import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
 import { resolveTenant } from '../auth/tenant'
-import { GatewayError } from './errors'
+import { GatewayError, RateLimitExceededError } from './errors'
+import type { TokenBucketLimiter } from './rate-limit'

 export interface RequestContext {
   tenantId: string
@@ -25,6 +26,21 @@ export function registerContext(app: FastifyInstance): void {
   })
 }

+/**
+ * Rejects over-limit requests before any upstream work happens. Runs as a
+ * preHandler (after auth) because the bucket key is the resolved tenant.
+ */
+export function registerRateLimit(app: FastifyInstance, limiter: TokenBucketLimiter): void {
+  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
+    const decision = limiter.take(req.ctx.tenantId, req.ctx.routeClass)
+    reply.header('x-ratelimit-remaining', String(decision.remaining))
+    if (!decision.allowed) {
+      reply.header('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)))
+      throw new RateLimitExceededError(req.ctx.tenantId, req.ctx.routeClass, decision.retryAfterMs)
+    }
+  })
+}
+
 export function registerErrorMapping(app: FastifyInstance): void {
   app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
     if (err instanceof GatewayError) {`

// ————— src/gateway/errors.ts (modified) —————

const errorsBaseContent = `/** Base class for errors the gateway maps to HTTP responses. */
export class GatewayError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export class UpstreamTimeoutError extends GatewayError {
  constructor(upstream: string, timeoutMs: number) {
    super(504, 'upstream_timeout', \`\${upstream} did not respond within \${timeoutMs}ms\`)
  }
}

export class TenantNotFoundError extends GatewayError {
  constructor(token: string) {
    super(401, 'tenant_not_found', \`no tenant for credential \${token.slice(0, 8)}…\`)
  }
}`

const errorsHeadContent = `/** Base class for errors the gateway maps to HTTP responses. */
export class GatewayError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export class UpstreamTimeoutError extends GatewayError {
  constructor(upstream: string, timeoutMs: number) {
    super(504, 'upstream_timeout', \`\${upstream} did not respond within \${timeoutMs}ms\`)
  }
}

export class TenantNotFoundError extends GatewayError {
  constructor(token: string) {
    super(401, 'tenant_not_found', \`no tenant for credential \${token.slice(0, 8)}…\`)
  }
}

export class RateLimitExceededError extends GatewayError {
  readonly retryAfterMs: number

  constructor(tenantId: string, routeClass: string, retryAfterMs: number) {
    super(429, 'rate_limited', \`tenant \${tenantId} exceeded the \${routeClass} rate limit\`)
    this.retryAfterMs = retryAfterMs
  }
}`

const errorsPatch = `@@ -21,3 +21,12 @@ export class TenantNotFoundError extends GatewayError {
     super(401, 'tenant_not_found', \`no tenant for credential \${token.slice(0, 8)}…\`)
   }
 }
+
+export class RateLimitExceededError extends GatewayError {
+  readonly retryAfterMs: number
+
+  constructor(tenantId: string, routeClass: string, retryAfterMs: number) {
+    super(429, 'rate_limited', \`tenant \${tenantId} exceeded the \${routeClass} rate limit\`)
+    this.retryAfterMs = retryAfterMs
+  }
+}`

// ————— blobs, files —————

const rateLimitHead = blob(
  'src/gateway/rate-limit.ts',
  rateLimitHeadContent,
  'pr312:head:src/gateway/rate-limit.ts',
)
const rateLimitTestHead = blob(
  'src/gateway/rate-limit.test.ts',
  rateLimitTestHeadContent,
  'pr312:head:src/gateway/rate-limit.test.ts',
)
const docsHead = blob('docs/rate-limiting.md', docsHeadContent, 'pr312:head:docs/rate-limiting.md')
const configBase = blob('src/gateway/config.ts', configBaseContent, 'pr312:base:src/gateway/config.ts')
const configHead = blob('src/gateway/config.ts', configHeadContent, 'pr312:head:src/gateway/config.ts')
const middlewareBase = blob(
  'src/gateway/middleware.ts',
  middlewareBaseContent,
  'pr312:base:src/gateway/middleware.ts',
)
const middlewareHead = blob(
  'src/gateway/middleware.ts',
  middlewareHeadContent,
  'pr312:head:src/gateway/middleware.ts',
)
const errorsBase = blob('src/gateway/errors.ts', errorsBaseContent, 'pr312:base:src/gateway/errors.ts')
const errorsHead = blob('src/gateway/errors.ts', errorsHeadContent, 'pr312:head:src/gateway/errors.ts')

const files: PullFile[] = [
  pullFile({
    sha: docsHead.sha,
    filename: 'docs/rate-limiting.md',
    status: 'added',
    patch: addedPatch(docsHeadContent),
  }),
  pullFile({
    sha: configHead.sha,
    filename: 'src/gateway/config.ts',
    status: 'modified',
    patch: configPatch,
  }),
  pullFile({
    sha: errorsHead.sha,
    filename: 'src/gateway/errors.ts',
    status: 'modified',
    patch: errorsPatch,
  }),
  pullFile({
    sha: middlewareHead.sha,
    filename: 'src/gateway/middleware.ts',
    status: 'modified',
    patch: middlewarePatch,
  }),
  pullFile({
    sha: rateLimitTestHead.sha,
    filename: 'src/gateway/rate-limit.test.ts',
    status: 'added',
    patch: addedPatch(rateLimitTestHeadContent),
  }),
  pullFile({
    sha: rateLimitHead.sha,
    filename: 'src/gateway/rate-limit.ts',
    status: 'added',
    patch: addedPatch(rateLimitHeadContent),
  }),
]

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

// ————— review threads —————

const capacityFieldLine = lineNumberOf(rateLimitHeadLines, '  capacity: number')
const refillMathLine = lineNumberOf(
  rateLimitHeadLines,
  '    const refilled = state.tokens + elapsedSeconds * limits.refillPerSecond',
)
const configRefillDefaultLine = 18 // head line of `refillPerSecond` inside rateLimitSchema
const configSuggestionHunk = configPatch.split('\n').slice(0, 13).join('\n')

interface CommentSpec {
  id: number
  reviewId: number
  inReplyTo?: number
  path: string
  diffHunk: string
  commitId: string
  originalCommitId: string
  line: number | null
  originalLine: number | null
  subjectType?: 'line' | 'file'
  user: GhUser
  body: string
  createdAt: string
  reactionRollup?: ReactionRollup
}

function comment(spec: CommentSpec): ReviewComment {
  return {
    id: spec.id,
    node_id: nodeId('PRRC', spec.id),
    pull_request_review_id: spec.reviewId,
    in_reply_to_id: spec.inReplyTo,
    path: spec.path,
    diff_hunk: spec.diffHunk,
    commit_id: spec.commitId,
    original_commit_id: spec.originalCommitId,
    line: spec.line,
    original_line: spec.originalLine,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: spec.subjectType ?? 'line',
    user: spec.user,
    body: spec.body,
    created_at: spec.createdAt,
    updated_at: spec.createdAt,
    reactions: spec.reactionRollup ?? emptyReactions(spec.id),
    html_url: `https://github.com/meridian-labs/atlas/pull/312#discussion_r${spec.id}`,
  }
}

/** (a) Resolved: bucket-size defaults, settled early and closed by dkozlov. */
const threadDefaults: ReviewThread = {
  id: nodeId('PRRT', 312001),
  isResolved: true,
  isOutdated: false,
  path: 'src/gateway/rate-limit.ts',
  line: capacityFieldLine,
  originalLine: capacityFieldLine,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: { login: ORG_DKOZLOV.login },
  comments: [
    comment({
      id: 91312001,
      reviewId: 7312001,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, capacityFieldLine),
      commitId: HEAD_SHA,
      originalCommitId: C1_SHA,
      line: capacityFieldLine,
      originalLine: capacityFieldLine,
      user: ORG_DKOZLOV,
      body: 'Where do 120/10 come from? Enterprise API traffic peaks well above 10 rps per tenant today.',
      createdAt: daysAgo(2),
    }),
    comment({
      id: 91312002,
      reviewId: 7312003,
      inReplyTo: 91312001,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, capacityFieldLine),
      commitId: HEAD_SHA,
      originalCommitId: C1_SHA,
      line: capacityFieldLine,
      originalLine: capacityFieldLine,
      user: BROKER_BOT,
      body: prefixBody(
        alice,
        'p99 across growth-plan tenants over the last 30 days is 6.2 rps sustained with ~80-request bursts — 120/10 clears that with headroom. Enterprise tenants get `tenantOverrides` (wired in this PR), and ingest never touches this limiter; the collector has its own quota.',
      ),
      createdAt: hoursAgo(40),
    }),
    comment({
      id: 91312003,
      reviewId: 7312004,
      inReplyTo: 91312001,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, capacityFieldLine),
      commitId: HEAD_SHA,
      originalCommitId: C1_SHA,
      line: capacityFieldLine,
      originalLine: capacityFieldLine,
      user: ORG_DKOZLOV,
      body: 'sg.',
      createdAt: hoursAgo(30),
    }),
  ],
}

/** (b) Unresolved: the deep chain on the refill math — the PR's live question. */
const threadRefill: ReviewThread = {
  id: nodeId('PRRT', 312002),
  isResolved: false,
  isOutdated: false,
  path: 'src/gateway/rate-limit.ts',
  line: refillMathLine,
  originalLine: refillMathLine,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: null,
  comments: [
    comment({
      id: 91312011,
      reviewId: 7312002,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, refillMathLine),
      commitId: HEAD_SHA,
      originalCommitId: C3_SHA,
      line: refillMathLine,
      originalLine: refillMathLine,
      user: ORG_DKOZLOV,
      body: '`clock.monotonicMs()` is per-process. Two gateway pods means a tenant effectively gets 2× the configured rate. Accepted, or does this need the shared store?',
      createdAt: hoursAgo(24),
    }),
    comment({
      id: 91312012,
      reviewId: 7312005,
      inReplyTo: 91312011,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, refillMathLine),
      commitId: HEAD_SHA,
      originalCommitId: C3_SHA,
      line: refillMathLine,
      originalLine: refillMathLine,
      user: BROKER_BOT,
      body: prefixBody(
        alice,
        "Accepted, and it's deliberate — per-node buckets keep the hot path lock-free with zero I/O. The autoscaler holds the fleet at 2–3 pods, so the worst case is 3× on paper and ~2× observed. Fleet-accurate limiting means a shared store on every request; that's the v2 line.",
      ),
      createdAt: hoursAgo(22),
    }),
    comment({
      id: 91312013,
      reviewId: 7312006,
      inReplyTo: 91312011,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, refillMathLine),
      commitId: HEAD_SHA,
      originalCommitId: C3_SHA,
      line: refillMathLine,
      originalLine: refillMathLine,
      user: BROKER_BOT,
      body: prefixBody(
        marcus,
        'One wrinkle worth writing down while we are here: `state.tokens` accumulates fractional refill in a float. Each take() adds `elapsed * rate` and subtracts 1, so after a few million operations the residue sits around 1e-9 tokens — harmless, but it means `remaining` can flicker between N and N−1 for identically spaced requests. I traced it: the clamp at capacity re-baselines the value, so there is no unbounded drift.',
      ),
      createdAt: hoursAgo(20),
    }),
    comment({
      id: 91312014,
      reviewId: 7312007,
      inReplyTo: 91312011,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, refillMathLine),
      commitId: HEAD_SHA,
      originalCommitId: C3_SHA,
      line: refillMathLine,
      originalLine: refillMathLine,
      user: ORG_DKOZLOV,
      body: 'float residue is fine — the clamp re-baselines, as you say. the pod multiplier is what I want written into the doc before this merges.',
      createdAt: hoursAgo(19),
      reactionRollup: reactions(91312014, { '+1': 2 }),
    }),
    comment({
      id: 91312015,
      reviewId: 7312008,
      inReplyTo: 91312011,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, refillMathLine),
      commitId: HEAD_SHA,
      originalCommitId: C3_SHA,
      line: refillMathLine,
      originalLine: refillMathLine,
      user: BROKER_BOT,
      body: prefixBody(
        priya,
        'One case worth pinning in a test before this settles: two requests inside the same millisecond give `elapsedSeconds = 0`, so the refill contributes nothing — correct, but nothing asserts it today, and it documents that the math carries no minimum-elapsed assumption.',
      ),
      createdAt: hoursAgo(8),
      reactionRollup: reactions(91312015, { heart: 1 }),
    }),
    comment({
      id: 91312016,
      reviewId: 7312009,
      inReplyTo: 91312011,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: addedHunkFragment(rateLimitHeadLines, refillMathLine),
      commitId: HEAD_SHA,
      originalCommitId: C3_SHA,
      line: refillMathLine,
      originalLine: refillMathLine,
      user: BROKER_BOT,
      body: prefixBody(
        alice,
        'Both done — the Scope section of `docs/rate-limiting.md` now spells out the per-node multiplier, and the zero-elapsed case is asserted in `rate-limit.test.ts`. Keeping floats.',
      ),
      createdAt: hoursAgo(4),
    }),
  ],
}

/**
 * (c) Outdated: an early naming nit on the fixed-window refill that the
 * continuous-refill rewrite deleted. The diff_hunk preserves the old hunk
 * text; `line` is null because the code no longer exists in the current diff.
 * Resolved through revu, so GitHub records the broker bot as the resolver.
 */
const outdatedRefillHunk = [
  '@@ -0,0 +1,96 @@',
  '+  private refill(state: BucketState, limits: BucketConfig): void {',
  '+    const nowSec = Date.now() / 1000',
  '+    const elapsedWindows = Math.floor(nowSec - state.lastWindowSec)',
  '+    if (elapsedWindows <= 0) return',
  '+    const earned = elapsedWindows * limits.refillPerSecond',
  '+    state.tokens = Math.min(limits.capacity, state.tokens + earned)',
  '+    state.lastWindowSec = nowSec',
].join('\n')

const threadOutdatedNaming: ReviewThread = {
  id: nodeId('PRRT', 312003),
  isResolved: true,
  isOutdated: true,
  path: 'src/gateway/rate-limit.ts',
  line: null,
  originalLine: 60,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: { login: BROKER_BOT.login },
  comments: [
    comment({
      id: 91312021,
      reviewId: 7312010,
      path: 'src/gateway/rate-limit.ts',
      diffHunk: outdatedRefillHunk,
      commitId: C2_SHA,
      originalCommitId: C2_SHA,
      line: null,
      originalLine: 60,
      user: BROKER_BOT,
      body: prefixBody(
        marcus,
        '`lastWindowSec` holds a timestamp, not a window index — `lastRefillSec` would read straight.',
      ),
      createdAt: hoursAgo(45),
    }),
  ],
}

/** (d) Unresolved: a GitHub suggestion bounding the refill rate in config. */
const threadConfigBound: ReviewThread = {
  id: nodeId('PRRT', 312004),
  isResolved: false,
  isOutdated: false,
  path: 'src/gateway/config.ts',
  line: configRefillDefaultLine,
  originalLine: configRefillDefaultLine,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: null,
  comments: [
    comment({
      id: 91312031,
      reviewId: 7312011,
      path: 'src/gateway/config.ts',
      diffHunk: configSuggestionHunk,
      commitId: HEAD_SHA,
      originalCommitId: HEAD_SHA,
      line: configRefillDefaultLine,
      originalLine: configRefillDefaultLine,
      user: ORG_DKOZLOV,
      body: 'Nothing stops a config typo (`refillPerSecond: 100000`) from switching the limiter off quietly. Bound it:\n\n```suggestion\n  refillPerSecond: z.number().positive().max(1_000).default(10),\n```',
      createdAt: hoursAgo(3),
    }),
  ],
}

/** (e) File-level thread on the doc — no line anchor at all. */
const threadDocHeaders: ReviewThread = {
  id: nodeId('PRRT', 312005),
  isResolved: false,
  isOutdated: false,
  path: 'docs/rate-limiting.md',
  line: null,
  originalLine: null,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'FILE',
  resolvedBy: null,
  comments: [
    comment({
      id: 91312041,
      reviewId: 7312012,
      path: 'docs/rate-limiting.md',
      diffHunk: '',
      commitId: HEAD_SHA,
      originalCommitId: HEAD_SHA,
      line: null,
      originalLine: null,
      subjectType: 'file',
      user: BROKER_BOT,
      body: prefixBody(
        marcus,
        'The response-header contract is split across two sections — `retry-after` lives under Responses while `x-ratelimit-remaining` is mentioned in passing. A small table (header / when present / meaning) would make this quotable in the customer-facing docs.',
      ),
      createdAt: hoursAgo(3),
    }),
  ],
}

const threads: ReviewThread[] = [
  threadDefaults,
  threadRefill,
  threadOutdatedNaming,
  threadConfigBound,
  threadDocHeaders,
]

// ————— conversation, reviews, checks, commits —————

/**
 * Third-party bots that comment on the client's repo with raw-HTML bodies.
 * They are real GitHub apps, not broker-proxied contractors, so their bodies
 * carry no human prefix and their `user` is the app's own bot identity.
 */
const LINEAR_BOT: GhUser = {
  login: 'linear[bot]',
  id: 9100341,
  node_id: nodeId('BOT', 9100341),
  avatar_url: '',
  html_url: 'https://github.com/apps/linear',
  type: 'Bot',
}

const GREPTILE_BOT: GhUser = {
  login: 'greptile-apps[bot]',
  id: 9100352,
  node_id: nodeId('BOT', 9100352),
  avatar_url: '',
  html_url: 'https://github.com/apps/greptile-apps',
  type: 'Bot',
}

/**
 * A Linear linkback in the shape the Linear GitHub app posts: raw HTML —
 * paragraph link, `<details>`/`<summary>`, `<sub>`, and a `<picture>` with a
 * dark-scheme `<source srcset>` — exercising exactly the tags the markdown
 * renderer must produce as real elements rather than escaped text.
 */
export const linearLinkbackBody = [
  '<p><a href="https://linear.app/meridian/issue/MER-1289/gateway-rate-limiting">MER-1289 Gateway rate limiting</a></p>',
  '<details><summary>Synced with Linear</summary>',
  '<p><sub>This pull request is linked to MER-1289. The issue moves to <strong>In Review</strong> while this PR is open and closes when it merges.</sub></p>',
  '<picture>',
  '<source media="(prefers-color-scheme: dark)" srcset="https://static.linear.app/badges/mer-1289-dark.png 1x, https://static.linear.app/badges/mer-1289-dark@2x.png 2x">',
  '<img alt="MER-1289 status badge" src="https://static.linear.app/badges/mer-1289.png" height="20">',
  '</picture>',
  '</details>',
].join('\n')

/**
 * A Greptile-style review summary: HTML heading and table, a `<details>`
 * section whose body holds a ```mermaid fence (blank lines around the fence
 * keep it markdown inside the raw-HTML flow block), and a `<sub>` footer.
 */
export const greptileSummaryBody = [
  '<h3>Greptile Summary</h3>',
  '<p>Adds a per-tenant token bucket in front of the gateway write path. Buckets refill lazily on access, idle buckets are evicted on a sweep, and limits are configurable per tenant tier.</p>',
  '<table>',
  '<thead><tr><th>File</th><th>Change</th><th>Risk</th></tr></thead>',
  '<tbody>',
  '<tr><td><code>limiter/bucket.ts</code></td><td>Token bucket core</td><td>Medium</td></tr>',
  '<tr><td><code>limiter/config.ts</code></td><td>Tier limits</td><td>Low</td></tr>',
  '<tr><td><code>gateway/middleware.ts</code></td><td>Enforcement hook</td><td>Medium</td></tr>',
  '</tbody>',
  '</table>',
  '<details>',
  '<summary>Request flow</summary>',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant C as Client',
  '  participant G as Gateway',
  '  participant B as Bucket',
  '  C->>G: write request',
  '  G->>B: take(tenant)',
  '  B-->>G: granted or drained',
  '  G-->>C: 200 or 429 with Retry-After',
  '```',
  '',
  '</details>',
  '<sub>Last reviewed commit: 4f21c09 · <a href="https://app.greptile.com/review/meridian-labs/atlas/312">View in Greptile</a></sub>',
].join('\n')

const issueComments: IssueComment[] = [
  {
    id: 61312000,
    node_id: nodeId('IC', 61312000),
    user: LINEAR_BOT,
    body: linearLinkbackBody,
    created_at: daysAgo(3),
    updated_at: daysAgo(3),
    reactions: emptyReactions(61312000),
  },
  {
    id: 61312001,
    node_id: nodeId('IC', 61312001),
    user: BROKER_BOT,
    body: prefixBody(
      marcus,
      'Soaked this branch with the k6 profile from the perf repo: 10k tenants, 500 rps mixed read/write for 30 minutes. p99 added latency 0.4ms, the bucket map topped out at 38MB, and allocation churn flattened after warm-up. Happy with the memory story once `evictIdle` is on a timer.',
    ),
    created_at: hoursAgo(21),
    updated_at: hoursAgo(21),
    reactions: reactions(61312001, { '+1': 1 }),
  },
  {
    id: 61312002,
    node_id: nodeId('IC', 61312002),
    user: ORG_DKOZLOV,
    body: 'Rollout: staging with defaults for a week, then prod behind `gateway.rate_limit`. Add the runbook link to the description before merge.',
    created_at: hoursAgo(18),
    updated_at: hoursAgo(18),
    reactions: emptyReactions(61312002),
  },
  {
    id: 61312003,
    node_id: nodeId('IC', 61312003),
    user: GREPTILE_BOT,
    body: greptileSummaryBody,
    created_at: hoursAgo(23),
    updated_at: hoursAgo(23),
    reactions: emptyReactions(61312003),
  },
]

const reviews: ReviewSummary[] = [
  {
    id: 7312002,
    node_id: nodeId('PRR', 7312002),
    user: ORG_DKOZLOV,
    body: 'First pass done — bucket math questions inline. The per-pod multiplier and the config bound are what stand between this and approve.',
    state: 'COMMENTED',
    submitted_at: daysAgo(1),
    commit_id: C3_SHA,
  },
]

const checks: CheckRun[] = [
  {
    id: 88312001,
    name: 'ci/typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(295),
    completed_at: minutesAgo(292),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88312001',
    output: { title: 'tsc --noEmit', summary: '0 errors across 418 files', text: null },
  },
  {
    id: 88312002,
    name: 'ci/tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(295),
    completed_at: minutesAgo(288),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88312002',
    output: { title: 'vitest', summary: '329 passed, 0 failed, 0 skipped', text: null },
  },
  {
    id: 88312003,
    name: 'ci/lint',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(295),
    completed_at: minutesAgo(291),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88312003',
    output: { title: 'eslint', summary: '0 problems', text: null },
  },
]

const commits: CommitInfo[] = [
  {
    sha: C1_SHA,
    commit: {
      message:
        'feat(gateway): token bucket limiter core\n\nPer-tenant, per-route-class buckets with fixed-window refill.',
      author: { name: 'Alice Nguyen', email: 'alice.nguyen@acme.dev', date: daysAgo(3) },
    },
    author: BROKER_BOT,
    parents: [{ sha: MERGE_BASE_SHA }],
  },
  {
    sha: C2_SHA,
    commit: {
      message: 'feat(gateway): enforce limits in the request pipeline',
      author: { name: 'Alice Nguyen', email: 'alice.nguyen@acme.dev', date: daysAgo(2) },
    },
    author: BROKER_BOT,
    parents: [{ sha: C1_SHA }],
  },
  {
    sha: C3_SHA,
    commit: {
      message:
        'refactor(gateway): continuous refill from the monotonic clock\n\nReplaces the fixed-window refill: windows made burst behavior at the\nboundary and left the field names lying about what they held.',
      author: { name: 'Alice Nguyen', email: 'alice.nguyen@acme.dev', date: hoursAgo(28) },
    },
    author: BROKER_BOT,
    parents: [{ sha: C2_SHA }],
  },
  {
    sha: C4_SHA,
    commit: {
      message: 'feat(gateway): tenant overrides + rate limiting doc',
      author: { name: 'Alice Nguyen', email: 'alice.nguyen@acme.dev', date: hoursAgo(5) },
    },
    author: BROKER_BOT,
    parents: [{ sha: C3_SHA }],
  },
]

// ————— the pull —————

const detail: PullDetail = {
  id: 2841312,
  node_id: nodeId('PR', 312),
  number: 312,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'feat(gateway): per-tenant rate limiting with token buckets',
  body: prefixBody(
    alice,
    [
      '## What',
      '',
      'Token-bucket rate limiting at the gateway, one bucket per tenant per route class (`read` / `write` / `admin`).',
      '',
      '- `TokenBucketLimiter` — continuous refill from the monotonic clock, fractional tokens kept on purpose (rounding starves low-rate tenants).',
      '- `registerRateLimit` preHandler — sets `x-ratelimit-remaining` on every response, `429` + `retry-after` when a bucket is empty.',
      '- Config: `rateLimit.{capacity,refillPerSecond}` with per-tenant overrides; defaults 120 burst / 10 rps.',
      '- `docs/rate-limiting.md` covers semantics and the deliberate v1 scope (per-node buckets).',
      '',
      '## Out of scope',
      '',
      'Fleet-accurate (cross-pod) limiting — needs a shared store on the hot path; scoped to v2. Ingest keeps its own collector-side quota.',
      '',
      '## Testing',
      '',
      'Unit tests over burst, refill, isolation, overrides, eviction. Marcus ran the k6 soak — numbers in the conversation.',
    ].join('\n'),
  ),
  user: BROKER_BOT,
  labels: [
    { id: 9003, name: 'area/gateway', color: 'bfd4f2', description: 'API gateway' },
    { id: 9004, name: 'feature', color: 'a2eeef', description: 'New capability' },
  ],
  requested_reviewers: [ORG_DKOZLOV],
  head: {
    ref: 'feat/gateway-rate-limiting',
    sha: HEAD_SHA,
    label: 'meridian-labs:feat/gateway-rate-limiting',
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  base: {
    ref: 'main',
    sha: MAIN_TIP_SHA,
    label: 'meridian-labs:main',
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  created_at: daysAgo(3),
  updated_at: hoursAgo(3),
  merged: false,
  mergeable: true,
  mergeable_state: 'blocked',
  merge_base_sha: MERGE_BASE_SHA,
  comments: issueComments.length,
  review_comments: threads.reduce((n, t) => n + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
}

export const pr312: RemotePull = {
  detail,
  files,
  blobs: [
    rateLimitHead,
    rateLimitTestHead,
    docsHead,
    configBase,
    configHead,
    middlewareBase,
    middlewareHead,
    errorsBase,
    errorsHead,
  ],
  blobIndex: {
    'docs/rate-limiting.md': { base: null, head: docsHead.sha },
    'src/gateway/config.ts': { base: configBase.sha, head: configHead.sha },
    'src/gateway/errors.ts': { base: errorsBase.sha, head: errorsHead.sha },
    'src/gateway/middleware.ts': { base: middlewareBase.sha, head: middlewareHead.sha },
    'src/gateway/rate-limit.test.ts': { base: null, head: rateLimitTestHead.sha },
    'src/gateway/rate-limit.ts': { base: null, head: rateLimitHead.sha },
  },
  threads,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-alice',
    canApprove: false,
    unresolvedThreads: threads.filter((t) => !t.isResolved).length,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: COMPARE_KEY,
    commitCount: commits.length,
  },
}

// ————— seeds: snapshot, Priya's pending draft, viewed state —————

const remainingFloorLine = lineNumberOf(
  rateLimitHeadLines,
  '      return { allowed: true, remaining: Math.floor(state.tokens), retryAfterMs: 0 }',
)

const pendingRemainingComment: PendingComment = {
  key: 'pc-312-priya-remaining-floor',
  path: 'src/gateway/rate-limit.ts',
  side: 'RIGHT',
  start_side: null,
  line: remainingFloorLine,
  start_line: null,
  body: "Floor here means the header can read `x-ratelimit-remaining: 0` while the bucket still holds 0.9 of a token — a well-behaved client then backs off a full refill interval it didn't need. Is truncation deliberate over rounding, or worth exposing tenths?",
  createdAt: hoursAgo(2),
  updatedAt: hoursAgo(2),
  anchor: {
    lineText: rateLimitHeadLines[remainingFloorLine - 1],
    contextBefore: rateLimitHeadLines.slice(remainingFloorLine - 4, remainingFloorLine - 1),
    contextAfter: rateLimitHeadLines.slice(remainingFloorLine, remainingFloorLine + 3),
  },
}

const priyaDraft: ReviewDraft = {
  humanId: 'h-priya',
  prNumber: 312,
  headSha: HEAD_SHA,
  compareKey: COMPARE_KEY,
  body: 'Bucket math looks right overall — still want to trace the refill under clock skew before I sign off.',
  event: 'COMMENT',
  comments: [pendingRemainingComment],
  createdAt: hoursAgo(2),
  updatedAt: minutesAgo(55),
}

export const pr312Seeds: FixtureSeeds = {
  snapshots: [
    buildSnapshot(pr312, minutesAgo(45), {
      syncStats: { blobsFetched: 12, blobsReused: 0, requests: 15 },
    }),
  ],
  drafts: [priyaDraft],
  viewed: [
    {
      humanId: 'h-priya',
      prNumber: 312,
      state: {
        'docs/rate-limiting.md': { viewed: true, blobSha: docsHead.sha, at: hoursAgo(2) },
        'src/gateway/errors.ts': { viewed: true, blobSha: errorsHead.sha, at: minutesAgo(110) },
      },
    },
  ],
}

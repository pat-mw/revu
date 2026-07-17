import type { CheckRun, CommitInfo, FileBlob, IssueComment, PullDetail, PullFile, ReviewSummary, ReviewThread } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import { BROKER_BOT, HUMANS, ORG_DKOZLOV, REPO } from '../cast'
import type { RemotePull } from '../contract'
import {
  blob,
  daysAgo,
  emptyReactions,
  hoursAgo,
  nodeId,
  pullFile,
} from '../helpers'

/**
 * PR 401 — "feat(o11y): OpenTelemetry spans for the ingest path".
 *
 * The partial-sync fixture. This PR is deliberately NOT pre-synced (no seeds
 * module export), and it carries `scenario.failSyncAfterBlobs: 3`: the mock
 * adapter transfers blobs in `blobIndex` iteration order and aborts the sync
 * after the third blob has landed, resolving a partial Snapshot. The blobIndex
 * is ordered so the first three transferred blobs cover `tracer.ts` (base is
 * null — added) and the head+base of one modified file, leaving every other
 * file's blobs absent. The UI must then render the arrived files and name the
 * rest as missing rather than pretending the whole diff is present.
 *
 * Patch/blob consistency still holds for every file: a re-sync (which the
 * scenario does not fail) would fetch the remaining blobs and complete.
 */

const ALICE = HUMANS.find((h) => h.id === 'h-alice')!

const OWNER = REPO.full_name
const HEAD_SHA = 'e73a015c9b48d2f6a1073e5c9d4b28f60a1e7c35'
const BASE_SHA = '2c6f9b81a04d735e9c82b0f14a67d3e5089bc4a7'
const MERGE_BASE_SHA = '2c6f9b81a04d735e9c82b0f14a67d3e5089bc4a7'

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

function addedPatch(content: string): string {
  const lines = content.split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
}

// ————————————————————————————————————————————————————————————————
// File 1 — src/telemetry/tracer.ts (added, ~120 lines). Span wrappers, context
// propagation, and exporter configuration for the ingest path.
// ————————————————————————————————————————————————————————————————

const tracerContent = `import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Context,
} from '@opentelemetry/api'
import { Resource } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

/**
 * Tracing setup for the ingest service. One provider is installed at startup;
 * the rest of the code takes spans through the thin \`withSpan\` helper so call
 * sites do not depend on the OpenTelemetry API surface directly.
 */

const SERVICE_NAME = 'atlas-ingest'

export interface TracingOptions {
  /** OTLP collector endpoint; when unset, tracing is a no-op. */
  endpoint?: string
  /** Fraction of traces to sample, in [0, 1]. Defaults to 1 in dev, 0.1 in prod. */
  sampleRatio?: number
  /** Override the exporter, mainly for tests. */
  exporter?: SpanExporter
}

let provider: BasicTracerProvider | null = null

/** Install the global tracer provider. Idempotent; a second call is ignored. */
export function initTracing(options: TracingOptions = {}): void {
  if (provider) return
  if (!options.endpoint && !options.exporter) return

  const resource = new Resource({
    'service.name': SERVICE_NAME,
    'service.version': process.env.ATLAS_VERSION ?? 'dev',
  })

  const exporter =
    options.exporter ?? new OTLPTraceExporter({ url: options.endpoint })

  provider = new BasicTracerProvider({ resource })
  provider.addSpanProcessor(new BatchSpanProcessor(exporter))
  provider.register()
}

/** Flush and shut down the provider, so a graceful exit does not drop spans. */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return
  await provider.forceFlush()
  await provider.shutdown()
  provider = null
}

function tracer(): Tracer {
  return trace.getTracer(SERVICE_NAME)
}

/**
 * Run \`fn\` inside a span named \`name\`, recording exceptions and setting the
 * span status. Attributes are attached before the body runs. The active context
 * is propagated so nested \`withSpan\` calls parent correctly.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, { attributes })
  const active = trace.setSpan(context.active(), span)
  try {
    const result = await context.with(active, () => fn(span))
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    })
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    span.end()
  }
}

/** Synchronous variant of withSpan for hot code paths that never await. */
export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => T,
): T {
  const span = tracer().startSpan(name, { attributes })
  try {
    const result = fn(span)
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    span.end()
  }
}

/** Capture the current context so it can be re-entered from a worker callback. */
export function captureContext(): Context {
  return context.active()
}

/** Re-enter a previously captured context, e.g. inside a pool task. */
export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn)
}

/** Add an event to the currently active span, if any. */
export function addSpanEvent(name: string, attributes?: Record<string, string | number>): void {
  const span = trace.getSpan(context.active())
  span?.addEvent(name, attributes)
}
`

// ————————————————————————————————————————————————————————————————
// File 2 — src/ingest/pipeline.ts (modified). Wrap ingest in a span. This is
// the SECOND file whose blobs land before the sync fails, so its base and head
// are among the first three transferred.
// ————————————————————————————————————————————————————————————————

const pipelineBase = `import type { Envelope } from '../events/schema'
import { Batcher } from './batcher'
import { Checkpoints } from './checkpoints'

/** The ingest pipeline: batch then checkpoint. */
export class Pipeline {
  private readonly batcher: Batcher
  private readonly checkpoints: Checkpoints

  constructor(batchSize: number, dir: string) {
    this.batcher = new Batcher(batchSize)
    this.checkpoints = new Checkpoints(dir)
  }

  async ingest(envelope: Envelope): Promise<void> {
    const batch = this.batcher.add(envelope)
    if (batch) {
      await this.checkpoints.write(batch)
    }
  }
}
`.split('\n')

const pipelineBuilt = buildPatch(pipelineBase, [
  {
    remove: [
      "import type { Envelope } from '../events/schema'",
      "import { Batcher } from './batcher'",
      "import { Checkpoints } from './checkpoints'",
    ],
    add: [
      "import type { Envelope } from '../events/schema'",
      "import { Batcher } from './batcher'",
      "import { Checkpoints } from './checkpoints'",
      "import { withSpan } from '../telemetry/tracer'",
    ],
  },
  {
    remove: [
      '  async ingest(envelope: Envelope): Promise<void> {',
      '    const batch = this.batcher.add(envelope)',
      '    if (batch) {',
      '      await this.checkpoints.write(batch)',
      '    }',
      '  }',
    ],
    add: [
      '  async ingest(envelope: Envelope): Promise<void> {',
      "    await withSpan('ingest.envelope', { 'envelope.id': envelope.id }, async () => {",
      '      const batch = this.batcher.add(envelope)',
      '      if (batch) {',
      "        await withSpan('ingest.checkpoint', { 'batch.size': batch.length }, () =>",
      '          this.checkpoints.write(batch),',
      '        )',
      '      }',
      '    })',
      '  }',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// Files 3–7 — modified instrumentation. Their blobs come AFTER the first three
// in blobIndex order, so the failed sync leaves them absent.
// ————————————————————————————————————————————————————————————————

// 3. src/ingest/worker-pool.ts — propagate context into pool tasks.
const workerPoolBase = `import { performance } from 'node:perf_hooks'

/** A minimal pool wrapper used by the ingest path. */
export class WorkerPool<I, O> {
  private inFlight = 0

  constructor(private readonly maxWorkers: number) {}

  async submit(payload: I, run: (payload: I) => Promise<O>): Promise<O> {
    this.inFlight++
    const startedAt = performance.now()
    try {
      return await run(payload)
    } finally {
      this.inFlight--
      void startedAt
    }
  }

  get load(): number {
    return this.inFlight / this.maxWorkers
  }
}
`.split('\n')

const workerPoolBuilt = buildPatch(workerPoolBase, [
  {
    remove: ["import { performance } from 'node:perf_hooks'"],
    add: [
      "import { performance } from 'node:perf_hooks'",
      "import { captureContext, withContext } from '../telemetry/tracer'",
      "import type { Context } from '@opentelemetry/api'",
    ],
  },
  {
    remove: [
      '  async submit(payload: I, run: (payload: I) => Promise<O>): Promise<O> {',
      '    this.inFlight++',
      '    const startedAt = performance.now()',
      '    try {',
      '      return await run(payload)',
      '    } finally {',
      '      this.inFlight--',
      '      void startedAt',
      '    }',
      '  }',
    ],
    add: [
      '  async submit(payload: I, run: (payload: I) => Promise<O>): Promise<O> {',
      '    // Capture the submitter\'s context so spans created inside the task',
      '    // parent to the request that enqueued it, not to whatever ran last.',
      '    const ctx: Context = captureContext()',
      '    this.inFlight++',
      '    const startedAt = performance.now()',
      '    try {',
      '      return await withContext(ctx, () => run(payload))',
      '    } finally {',
      '      this.inFlight--',
      '      void startedAt',
      '    }',
      '  }',
    ],
  },
])

// 4. src/api/handlers/ingest.ts — root span per request.
const handlerBase = `import type { Request, Response } from '../http'
import { Pipeline } from '../../ingest/pipeline'
import { decodeEnvelope } from '../../events/decode'

const pipeline = new Pipeline(500, './checkpoints')

/** POST /ingest — accept a single msgpack envelope. */
export async function ingestHandler(req: Request, res: Response): Promise<void> {
  const envelope = decodeEnvelope(req.body)
  await pipeline.ingest(envelope)
  res.status(202).end()
}
`.split('\n')

const handlerBuilt = buildPatch(handlerBase, [
  {
    remove: [
      "import type { Request, Response } from '../http'",
      "import { Pipeline } from '../../ingest/pipeline'",
      "import { decodeEnvelope } from '../../events/decode'",
    ],
    add: [
      "import type { Request, Response } from '../http'",
      "import { Pipeline } from '../../ingest/pipeline'",
      "import { decodeEnvelope } from '../../events/decode'",
      "import { withSpan } from '../../telemetry/tracer'",
    ],
  },
  {
    remove: [
      'export async function ingestHandler(req: Request, res: Response): Promise<void> {',
      '  const envelope = decodeEnvelope(req.body)',
      '  await pipeline.ingest(envelope)',
      '  res.status(202).end()',
      '}',
    ],
    add: [
      'export async function ingestHandler(req: Request, res: Response): Promise<void> {',
      "  await withSpan('http.ingest', { 'http.method': 'POST', 'http.route': '/ingest' }, async () => {",
      '    const envelope = decodeEnvelope(req.body)',
      '    await pipeline.ingest(envelope)',
      '    res.status(202).end()',
      '  })',
      '}',
    ],
  },
])

// 5. src/config/telemetry.ts — read exporter config from the environment.
const configBase = `/** Telemetry configuration resolved from the environment. */
export interface TelemetryConfig {
  enabled: boolean
  sampleRatio: number
}

export function loadTelemetryConfig(): TelemetryConfig {
  return {
    enabled: process.env.OTEL_ENABLED === 'true',
    sampleRatio: Number(process.env.OTEL_SAMPLE_RATIO ?? '1'),
  }
}
`.split('\n')

const configBuilt = buildPatch(configBase, [
  {
    remove: [
      '/** Telemetry configuration resolved from the environment. */',
      'export interface TelemetryConfig {',
      '  enabled: boolean',
      '  sampleRatio: number',
      '}',
    ],
    add: [
      '/** Telemetry configuration resolved from the environment. */',
      'export interface TelemetryConfig {',
      '  enabled: boolean',
      '  endpoint?: string',
      '  sampleRatio: number',
      '}',
    ],
  },
  {
    remove: [
      'export function loadTelemetryConfig(): TelemetryConfig {',
      '  return {',
      "    enabled: process.env.OTEL_ENABLED === 'true',",
      "    sampleRatio: Number(process.env.OTEL_SAMPLE_RATIO ?? '1'),",
      '  }',
      '}',
    ],
    add: [
      'export function loadTelemetryConfig(): TelemetryConfig {',
      '  return {',
      "    enabled: process.env.OTEL_ENABLED === 'true',",
      '    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,',
      "    sampleRatio: Number(process.env.OTEL_SAMPLE_RATIO ?? '1'),",
      '  }',
      '}',
    ],
  },
])

// 6. src/index.ts — wire tracing init/shutdown into the service lifecycle.
const indexBase = `import { startServer } from './server'

async function main(): Promise<void> {
  const server = await startServer()
  process.on('SIGTERM', async () => {
    await server.close()
    process.exit(0)
  })
}

void main()
`.split('\n')

const indexBuilt = buildPatch(indexBase, [
  {
    remove: ["import { startServer } from './server'"],
    add: [
      "import { startServer } from './server'",
      "import { initTracing, shutdownTracing } from './telemetry/tracer'",
      "import { loadTelemetryConfig } from './config/telemetry'",
    ],
  },
  {
    remove: [
      'async function main(): Promise<void> {',
      '  const server = await startServer()',
      '  process.on(\'SIGTERM\', async () => {',
      '    await server.close()',
      '    process.exit(0)',
      '  })',
      '}',
    ],
    add: [
      'async function main(): Promise<void> {',
      '  const telemetry = loadTelemetryConfig()',
      '  if (telemetry.enabled) {',
      '    initTracing({ endpoint: telemetry.endpoint, sampleRatio: telemetry.sampleRatio })',
      '  }',
      '  const server = await startServer()',
      "  process.on('SIGTERM', async () => {",
      '    await server.close()',
      '    await shutdownTracing()',
      '    process.exit(0)',
      '  })',
      '}',
    ],
  },
])

// 7. src/events/decode.ts — a span around the decode step.
const decodeBase = `import { unpack } from 'msgpackr'
import { EnvelopeSchema, type Envelope } from './schema'

export function decodeEnvelope(raw: Uint8Array): Envelope {
  const value = unpack(raw)
  return EnvelopeSchema.parse(value)
}
`.split('\n')

const decodeBuilt = buildPatch(decodeBase, [
  {
    remove: [
      "import { unpack } from 'msgpackr'",
      "import { EnvelopeSchema, type Envelope } from './schema'",
    ],
    add: [
      "import { unpack } from 'msgpackr'",
      "import { EnvelopeSchema, type Envelope } from './schema'",
      "import { withSpanSync } from '../telemetry/tracer'",
    ],
  },
  {
    remove: [
      'export function decodeEnvelope(raw: Uint8Array): Envelope {',
      '  const value = unpack(raw)',
      '  return EnvelopeSchema.parse(value)',
      '}',
    ],
    add: [
      'export function decodeEnvelope(raw: Uint8Array): Envelope {',
      "  return withSpanSync('decode.envelope', { 'raw.bytes': raw.byteLength }, () => {",
      '    const value = unpack(raw)',
      '    return EnvelopeSchema.parse(value)',
      '  })',
      '}',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// Blobs.
// ————————————————————————————————————————————————————————————————

const tracerHead = blob('src/telemetry/tracer.ts', tracerContent, 'pr401-tracer-head')
const pipelineBaseBlob = blob('src/ingest/pipeline.ts', pipelineBase.join('\n'), 'pr401-pipeline-base')
const pipelineHead = blob('src/ingest/pipeline.ts', pipelineBuilt.headContent, 'pr401-pipeline-head')
const workerPoolBaseBlob = blob('src/ingest/worker-pool.ts', workerPoolBase.join('\n'), 'pr401-worker-pool-base')
const workerPoolHead = blob('src/ingest/worker-pool.ts', workerPoolBuilt.headContent, 'pr401-worker-pool-head')
const handlerBaseBlob = blob('src/api/handlers/ingest.ts', handlerBase.join('\n'), 'pr401-handler-base')
const handlerHead = blob('src/api/handlers/ingest.ts', handlerBuilt.headContent, 'pr401-handler-head')
const configBaseBlob = blob('src/config/telemetry.ts', configBase.join('\n'), 'pr401-config-base')
const configHead = blob('src/config/telemetry.ts', configBuilt.headContent, 'pr401-config-head')
const indexBaseBlob = blob('src/index.ts', indexBase.join('\n'), 'pr401-index-base')
const indexHead = blob('src/index.ts', indexBuilt.headContent, 'pr401-index-head')
const decodeBaseBlob = blob('src/events/decode.ts', decodeBase.join('\n'), 'pr401-decode-base')
const decodeHead = blob('src/events/decode.ts', decodeBuilt.headContent, 'pr401-decode-head')

const files: PullFile[] = [
  pullFile({
    sha: tracerHead.sha,
    filename: 'src/telemetry/tracer.ts',
    status: 'added',
    patch: addedPatch(tracerContent),
  }),
  pullFile({
    sha: pipelineHead.sha,
    filename: 'src/ingest/pipeline.ts',
    status: 'modified',
    patch: pipelineBuilt.patch,
  }),
  pullFile({
    sha: workerPoolHead.sha,
    filename: 'src/ingest/worker-pool.ts',
    status: 'modified',
    patch: workerPoolBuilt.patch,
  }),
  pullFile({
    sha: handlerHead.sha,
    filename: 'src/api/handlers/ingest.ts',
    status: 'modified',
    patch: handlerBuilt.patch,
  }),
  pullFile({
    sha: configHead.sha,
    filename: 'src/config/telemetry.ts',
    status: 'modified',
    patch: configBuilt.patch,
  }),
  pullFile({
    sha: indexHead.sha,
    filename: 'src/index.ts',
    status: 'modified',
    patch: indexBuilt.patch,
  }),
  pullFile({
    sha: decodeHead.sha,
    filename: 'src/events/decode.ts',
    status: 'modified',
    patch: decodeBuilt.patch,
  }),
]

const blobs: FileBlob[] = [
  tracerHead,
  pipelineBaseBlob,
  pipelineHead,
  workerPoolBaseBlob,
  workerPoolHead,
  handlerBaseBlob,
  handlerHead,
  configBaseBlob,
  configHead,
  indexBaseBlob,
  indexHead,
  decodeBaseBlob,
  decodeHead,
]

/**
 * blobIndex order IS the sync transfer order the mock adapter honors. It is
 * arranged so the first three blobs a sync fetches are:
 *   1. tracer.ts head (the added file — base is null, nothing to fetch there)
 *   2. pipeline.ts base
 *   3. pipeline.ts head
 * After the third blob the scenario aborts the sync, so tracer.ts and
 * pipeline.ts render fully while worker-pool, handler, config, index, and
 * decode are left with their blobs missing — the partial state the UI must own.
 */
const blobIndex: Record<string, { base: string | null; head: string | null }> = {
  'src/telemetry/tracer.ts': { base: null, head: tracerHead.sha },
  'src/ingest/pipeline.ts': { base: pipelineBaseBlob.sha, head: pipelineHead.sha },
  'src/ingest/worker-pool.ts': { base: workerPoolBaseBlob.sha, head: workerPoolHead.sha },
  'src/api/handlers/ingest.ts': { base: handlerBaseBlob.sha, head: handlerHead.sha },
  'src/config/telemetry.ts': { base: configBaseBlob.sha, head: configHead.sha },
  'src/index.ts': { base: indexBaseBlob.sha, head: indexHead.sha },
  'src/events/decode.ts': { base: decodeBaseBlob.sha, head: decodeHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Commits — three over three days.
// ————————————————————————————————————————————————————————————————

const commits: CommitInfo[] = [
  {
    sha: 'f01a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3',
    commit: {
      message: 'feat(o11y): add tracer module and exporter config',
      author: { name: ALICE.name, email: ALICE.email, date: daysAgo(3) },
    },
    author: BROKER_BOT,
    parents: [{ sha: MERGE_BASE_SHA }],
  },
  {
    sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d',
    commit: {
      message: 'feat(o11y): span the ingest pipeline and decode step',
      author: { name: ALICE.name, email: ALICE.email, date: daysAgo(2) },
    },
    author: BROKER_BOT,
    parents: [{ sha: 'f01a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3' }],
  },
  {
    sha: HEAD_SHA,
    commit: {
      message: 'feat(o11y): propagate context into pool tasks; wire lifecycle',
      author: { name: ALICE.name, email: ALICE.email, date: hoursAgo(8) },
    },
    author: BROKER_BOT,
    parents: [{ sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d' }],
  },
]

// ————————————————————————————————————————————————————————————————
// Thread — one unresolved, from dkozlov on context propagation cost.
// ————————————————————————————————————————————————————————————————

const workerPoolDiffHunk = workerPoolBuilt.patch

const threads: ReviewThread[] = [
  {
    id: nodeId('PRRT', 40101),
    isResolved: false,
    isOutdated: false,
    path: 'src/ingest/worker-pool.ts',
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
        id: 4010101,
        node_id: nodeId('PRRC', 4010101),
        pull_request_review_id: null,
        path: 'src/ingest/worker-pool.ts',
        diff_hunk: workerPoolDiffHunk,
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
        body: 'captureContext() on every submit is on the hot path — the pool submits per envelope at tens of thousands a second. Is context.active() cheap enough there, or should we capture once per batch and reuse it? A quick microbench on the ingest box would settle it before this ships.',
        created_at: hoursAgo(10),
        updated_at: hoursAgo(10),
        reactions: emptyReactions(4010101),
        html_url: `https://github.com/${OWNER}/pull/401#discussion_r4010101`,
      },
    ],
  },
]

// ————————————————————————————————————————————————————————————————
// Checks — two passing (no third check on this PR yet).
// ————————————————————————————————————————————————————————————————

const checks: CheckRun[] = [
  {
    id: 401010,
    name: 'ci/typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: hoursAgo(8),
    completed_at: hoursAgo(8),
    details_url: `https://github.com/${OWNER}/pull/401/checks?check_run_id=401010`,
    output: {
      title: 'tsc: no errors',
      summary: 'Type-checked 209 files in 10.6s.',
    },
  },
  {
    id: 401011,
    name: 'ci/tests',
    status: 'completed',
    conclusion: 'success',
    started_at: hoursAgo(8),
    completed_at: hoursAgo(7),
    details_url: `https://github.com/${OWNER}/pull/401/checks?check_run_id=401011`,
    output: {
      title: '171 passed',
      summary: '171 passed, 0 failed across 29 suites in 44.1s.',
    },
  },
]

// ————————————————————————————————————————————————————————————————
// Issue comments / reviews — none; discussion is on the one thread.
// ————————————————————————————————————————————————————————————————

const issueComments: IssueComment[] = []
const reviews: ReviewSummary[] = []

// ————————————————————————————————————————————————————————————————
// Detail counts — honest sums.
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((sum, f) => sum + f.additions, 0)
const deletions = files.reduce((sum, f) => sum + f.deletions, 0)

const detail: PullDetail = {
  id: 100000401,
  node_id: nodeId('PR', 401),
  number: 401,
  state: 'open',
  draft: false,
  merged_at: null,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  title: 'feat(o11y): OpenTelemetry spans for the ingest path',
  body: prefixBody(
    ALICE,
    [
      'Adds OpenTelemetry tracing to the ingest path: a new `tracer.ts` sets up the provider and exposes thin `withSpan` helpers, and the pipeline, HTTP handler, decode step, and pool are instrumented with spans that parent correctly through captured context.',
      '',
      'Tracing is off unless `OTEL_ENABLED=true`, so this is a no-op in environments that do not configure a collector.',
      '',
      'One open question from Dmitri on the cost of capturing context per submit — see the thread. I lean toward measuring before optimizing, but happy to capture per batch if the microbench says so.',
    ].join('\n'),
  ),
  user: BROKER_BOT,
  labels: [
    { id: 7001, name: 'observability', color: '4CC8A8', description: 'Tracing/metrics' },
    { id: 7002, name: 'ingest', color: '3FD0B4', description: 'Ingestion pipeline' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'alice/otel-ingest-spans',
    sha: HEAD_SHA,
    label: 'meridian-labs:alice/otel-ingest-spans',
    repo: { full_name: OWNER, default_branch: REPO.default_branch },
  },
  base: {
    ref: 'main',
    sha: BASE_SHA,
    label: 'meridian-labs:main',
    repo: { full_name: OWNER, default_branch: REPO.default_branch },
  },
  merge_base_sha: MERGE_BASE_SHA,
  comments: issueComments.length,
  review_comments: threads.reduce((sum, t) => sum + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
  created_at: daysAgo(3),
  updated_at: hoursAgo(8),
}

export const pr401: RemotePull = {
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
    authorHumanId: 'h-alice',
    canApprove: false,
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    commitCount: commits.length,
  },
  // The first sync attempt dies after three blobs have transferred; the adapter
  // enforces this against blobIndex order, leaving the trailing files missing
  // until a re-sync. There are deliberately no seeds for this PR — it starts
  // un-synced so the partial-sync path is reachable from a cold load.
  scenario: { failSyncAfterBlobs: 3 },
}

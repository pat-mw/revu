import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { FileViewedState, ReviewDraft } from '@revu/shared'
import type { AuditEntry } from '../direct/store'
import { StoreUnreadableError, StoreWriteError } from '../direct/store'
import type { CoderOwnerBinding, CoderOwnerResolver } from './identity-binding'

/**
 * The host-side durable store the collector lands pulled workspace state into.
 *
 * TRUST BOUNDARY — everything pulled OUT of a workspace container is untrusted
 * for identity. A contractor has passwordless sudo inside their own container,
 * so the `humanId` embedded in a pulled `ReviewDraft` and the `human_id` /
 * `workspace` fields of a pulled audit journal are workspace-claimed and
 * spoofable. The one identity signal that crosses the boundary intact is the
 * container's `coder.owner` label, which the host-side collector reads off the
 * container itself. This store is therefore keyed and authorized EXCLUSIVELY by
 * that binding: every method takes a `coderOwner`, resolves it through the
 * injected `CoderOwnerResolver` to the canonical email key, and re-keys the
 * landed rows to that email — the workspace-claimed identity fields in the
 * pulled payload are discarded on the way in. There is deliberately no method
 * that accepts an email or any other caller-claimed identity: an email is a
 * store KEY, not a credential, and accepting one would let any caller read any
 * human's state.
 *
 * An owner the resolver does not know throws `UnboundOwnerError` rather than
 * returning an empty result: an unresolved owner in the collector means a
 * human's work is about to be dropped or misattributed, and that must fail
 * loud, never silently read as "nothing there".
 *
 * This is its own SQLite file, separate from the direct-mode store: the host
 * store holds only host-durable per-human state (drafts, viewed state, the
 * merged audit journal) — snapshots and blobs are per-workspace sync caches
 * and never land here. The audit table also differs structurally from the
 * direct-mode journal: the collector re-pulls each workspace's FULL journal on
 * every tick, so landing must be idempotent. A UNIQUE constraint over the full
 * stored tuple is the dedup key (the insert targets it with `ON CONFLICT ...
 * DO NOTHING`): a re-pull of an already-landed row is byte-identical and
 * inserts nothing, while rows that differ in any field all land. The bound
 * this buys is deliberately slightly lossy: two genuine journal rows that are
 * byte-identical across the whole tuple — e.g. two idempotent-retry
 * double-journals of the SAME logical write within the same millisecond —
 * collapse to one stored row. That is a harmless UNDERCOUNT (same human, same
 * GitHub id, same endpoint, same PR — the attribution is identical either
 * way), never a misattribution. If exact row counting is ever required, the
 * fix is to dedup on the workspace journal row's rowid instead, which would
 * require the pull source to carry that rowid across the boundary.
 *
 * Durability discipline matches the direct store: WAL with FULL synchrony, a
 * write path that never swallows a failure (`StoreWriteError`), absent rows
 * read back as empty (`null` / `{}`) while present-but-corrupt rows throw
 * `StoreUnreadableError`, and a `meta.store_version` ladder that migrates in
 * place — never dropping or reseeding a table.
 */

/** The on-disk schema version. Bump this and add a migration step when the shape changes. */
export const HOST_STORE_VERSION = 1

/**
 * A `coder.owner` reached the store with no identity binding. Fail-loud by
 * design: silently returning an empty result for an unbound owner would drop
 * that human's pulled work (or hide that their reads return nothing) without a
 * trace. The message names only the owner label — never row contents.
 */
export class UnboundOwnerError extends Error {
  readonly coderOwner: string

  constructor(coderOwner: string) {
    super(
      `coder.owner "${coderOwner}" has no identity binding. Refusing to proceed: ` +
        "an unbound owner means a human's work would be dropped or misattributed. " +
        'Add the owner to the host-side identity-binding map.',
    )
    this.name = 'UnboundOwnerError'
    this.coderOwner = coderOwner
  }
}

/**
 * Resolve the host-store data directory:
 * `${XDG_DATA_HOME:-~/.local/share}/revu/host`. An explicit
 * `REVU_HOST_DATA_DIR` overrides both (used by tests and deployments to point
 * elsewhere). Distinct from the direct-mode dir so the two stores never share
 * a file.
 */
export function resolveHostDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.REVU_HOST_DATA_DIR
  if (override && override.length > 0) return override
  const xdg = env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'revu', 'host')
}

/** The store file name under the data dir. */
const DB_FILE = 'host.sqlite'

/**
 * The host store surface. Every method that touches per-human state takes the
 * channel-authentic `coderOwner` and resolves it to the canonical email key
 * before touching a row; an unknown owner throws `UnboundOwnerError`. Landing
 * methods re-key the pulled payload to the binding, discarding any
 * workspace-claimed identity embedded in it.
 */
export interface HostStore {
  /**
   * Land a pulled draft under the binding's email. The draft's embedded
   * `humanId` is workspace-claimed and is OVERWRITTEN with the binding's email
   * before persisting, so a spoofed value never reaches disk and `getDraft`
   * round-trips consistently.
   */
  landDraft(coderOwner: string, draft: ReviewDraft): void
  /** Land pulled per-PR viewed state under the binding's email. */
  landViewed(coderOwner: string, prNumber: number, state: FileViewedState): void
  /**
   * Land a pulled audit journal. Each stored row is constructed host-side:
   * `human_id` is the binding's email and `workspace` is the channel-authentic
   * `coderOwner`; the pulled entry's `humanId` and `workspace` (both
   * workspace-claimed) are discarded, keeping only `githubId` / `endpoint` /
   * `pr` / `createdAt` — and those four are VALIDATED before insert, because
   * the journal is attacker-controllable JSON from inside the workspace and
   * SQLite column affinity would otherwise store a wrong-typed value (a string
   * in an INTEGER column) without raising any violation. Valid rows land
   * idempotently (a re-pull of already-landed rows inserts nothing); invalid
   * rows come back in `rejected` — never silently dropped, and never allowed
   * to block the valid rows in the same batch. Each rejection carries the
   * entry's index in the input array and a reason naming the offending field,
   * never echoing its value.
   */
  landAudit(
    coderOwner: string,
    entries: readonly AuditEntry[],
  ): { landed: number; rejected: readonly { index: number; reason: string }[] }

  /** The landed draft for this owner's human, or `null` when none exists. */
  getDraft(coderOwner: string, prNumber: number): ReviewDraft | null
  /** The landed viewed state for this owner's human; `{}` when none exists. */
  getViewed(coderOwner: string, prNumber: number): FileViewedState
  /**
   * Read one human's landed audit rows, oldest → newest (insertion order).
   * ALWAYS resolves the binding first: an unknown owner — including an absent
   * or non-string value that slipped through the type system — throws
   * `UnboundOwnerError` rather than silently widening or emptying the read.
   * `pr` and `sinceIso` (inclusive; ISO strings compare as text) narrow
   * further.
   */
  listAuditForOwner(
    coderOwner: string,
    filter?: { pr?: number; sinceIso?: string },
  ): AuditEntry[]
  /**
   * The all-humans audit union, oldest → newest — a DELIBERATE cross-human
   * read, kept as its own method (with no owner parameter at all) so an
   * owner-scoped call can never drift into the union via a missing filter
   * value. It exists for the per-PR views that must see every human's writes
   * side by side, e.g. detecting writes performed out-of-band of any one
   * human's workspace. `pr` and `sinceIso` (inclusive) narrow it.
   */
  listAuditUnion(filter?: { pr?: number; sinceIso?: string }): AuditEntry[]

  /**
   * Offboarding: delete this human's working state (drafts + viewed) while
   * RETAINING every audit row — the journal is permanent attribution history
   * and must survive the human's departure. Returns how many rows of each kind
   * were removed.
   */
  purgeWorkingState(coderOwner: string): { draftsPurged: number; viewedPurged: number }

  /** Close the underlying database handle (tests + shutdown). */
  close(): void
}

/** Parse a stored JSON cell, mapping a parse failure to `StoreUnreadableError`. */
function parseRow<T>(table: string, rowKey: string, json: string): T {
  try {
    return JSON.parse(json) as T
  } catch (err) {
    throw new StoreUnreadableError(table, rowKey, err)
  }
}

/** Upper bound on a stored `endpoint`: write-route names are short identifiers. */
const MAX_ENDPOINT_LENGTH = 64

/**
 * Upper bound on a stored `createdAt`: ISO-8601 UTC timestamps run ~24-30
 * characters, so this cap never rejects a real one while bounding how much an
 * attacker-supplied string can grow the permanent journal.
 */
const MAX_CREATED_AT_LENGTH = 40

/** True only for a number that is a safe integer strictly greater than zero. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Validate the non-identity fields of a pulled audit entry against what the
 * schema means, not just what it will accept. The journal is produced inside
 * the contractor's container, so despite the compile-time `AuditEntry` type
 * every field is attacker-controllable JSON at runtime: a `null`, a
 * wrong-typed value, or an oversized string must be rejected HERE — SQLite
 * column affinity would otherwise store a string into the INTEGER `github_id`
 * column without any constraint violation, landing a type-lie in the
 * permanent journal. The identity fields (`humanId` / `workspace`) need no
 * validation: they are discarded and reconstructed host-side from the binding.
 *
 * Returns `null` for a valid entry, or a rejection reason that names the
 * offending FIELD and the rule it broke — never echoing the value itself, so
 * the reason can be surfaced or logged without leaking pulled content.
 */
function validateAuditEntry(entry: AuditEntry): string | null {
  // A journal array element can itself be `null` (valid JSON): reject it as a
  // row rather than letting destructuring throw and abort the whole batch.
  if (typeof entry !== 'object' || entry === null) return 'entry is not an object'
  // Widen to unknown: the compile-time types are exactly what a hostile
  // journal gets to lie about.
  const { githubId, endpoint, pr, createdAt } = entry as {
    githubId: unknown
    endpoint: unknown
    pr: unknown
    createdAt: unknown
  }
  if (!isPositiveSafeInteger(githubId)) return 'githubId is not a positive safe integer'
  if (typeof endpoint !== 'string') return 'endpoint is not a string'
  if (endpoint.length === 0) return 'endpoint is empty'
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return `endpoint exceeds ${MAX_ENDPOINT_LENGTH} characters`
  }
  if (!isPositiveSafeInteger(pr)) return 'pr is not a positive safe integer'
  if (typeof createdAt !== 'string') return 'createdAt is not a string'
  if (createdAt.length === 0) return 'createdAt is empty'
  if (createdAt.length > MAX_CREATED_AT_LENGTH) {
    return `createdAt exceeds ${MAX_CREATED_AT_LENGTH} characters`
  }
  return null
}

/**
 * Open (creating if needed) the host store, run migrations in place, and
 * return the store surface. `dataDir` defaults via `resolveHostDataDir`;
 * passing `':memory:'` opens an ephemeral database with no file (tests). The
 * resolver is REQUIRED — the store cannot authorize anything without it.
 */
export function openHostStore(opts: {
  resolver: CoderOwnerResolver
  dataDir?: string
  env?: Record<string, string | undefined>
}): HostStore {
  const { resolver } = opts
  const env = opts.env ?? process.env
  const dataDir = opts.dataDir ?? resolveHostDataDir(env)

  let db: Database
  if (dataDir === ':memory:') {
    db = new Database(':memory:')
  } else {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    db = new Database(join(dataDir, DB_FILE))
  }

  // Durability pragmas: a WAL with FULL synchrony means a committed write has
  // reached disk before the call returns — the collector's ack that a pulled
  // draft is safe must be trustworthy, because the workspace copy is disposable.
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = FULL')

  migrate(db)

  /**
   * Resolve the channel-authentic owner label to its binding, or fail loud.
   * Every per-human method funnels through here BEFORE touching a row, so no
   * code path can key or authorize by anything the workspace claimed.
   */
  function mustResolve(coderOwner: string): CoderOwnerBinding {
    const binding = resolver.resolve(coderOwner)
    if (binding === null) throw new UnboundOwnerError(coderOwner)
    return binding
  }

  /** Run a write, wrapping any failure in a typed `StoreWriteError` (never swallowed). */
  function write<T>(table: string, fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      throw new StoreWriteError(table, err)
    }
  }

  /**
   * Shared audit read: rows oldest → newest in insertion order (rowid). A
   * non-null `humanId` is an ALREADY-RESOLVED binding email that narrows to
   * one human; `null` is the deliberate all-humans union. Only the two
   * `listAudit*` methods call this — the owner-scoped one always resolves
   * first, the union one always passes `null`.
   */
  function queryAudit(
    humanId: string | null,
    filter: { pr?: number; sinceIso?: string },
  ): AuditEntry[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (humanId !== null) {
      clauses.push('human_id = ?')
      params.push(humanId)
    }
    if (filter.pr !== undefined) {
      clauses.push('pr = ?')
      params.push(filter.pr)
    }
    if (filter.sinceIso !== undefined) {
      // ISO-8601 UTC timestamps sort correctly as text; inclusive at the bound.
      clauses.push('created_at >= ?')
      params.push(filter.sinceIso)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = db
      .query(
        'SELECT github_id, human_id, workspace, endpoint, pr, created_at ' +
          `FROM audit_log${where} ORDER BY rowid ASC`,
      )
      .all(...params) as {
      github_id: number
      human_id: string
      workspace: string
      endpoint: string
      pr: number
      created_at: string
    }[]
    return rows.map((r) => ({
      githubId: r.github_id,
      humanId: r.human_id,
      workspace: r.workspace,
      endpoint: r.endpoint,
      pr: r.pr,
      createdAt: r.created_at,
    }))
  }

  return {
    landDraft(coderOwner: string, draft: ReviewDraft): void {
      const binding = mustResolve(coderOwner)
      // Re-key: the persisted document carries the binding's email, not the
      // workspace-claimed `draft.humanId`, so a spoofed value never reaches
      // disk and the row key and embedded id cannot disagree.
      const rekeyed: ReviewDraft = { ...draft, humanId: binding.email }
      write('drafts', () => {
        db.run(
          'INSERT INTO drafts (human_id, pr_number, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, pr_number) DO UPDATE SET data = excluded.data',
          [binding.email, rekeyed.prNumber, JSON.stringify(rekeyed)],
        )
      })
    },

    landViewed(coderOwner: string, prNumber: number, state: FileViewedState): void {
      const binding = mustResolve(coderOwner)
      write('viewed', () => {
        db.run(
          'INSERT INTO viewed (human_id, pr_number, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, pr_number) DO UPDATE SET data = excluded.data',
          [binding.email, prNumber, JSON.stringify(state)],
        )
      })
    },

    landAudit(
      coderOwner: string,
      entries: readonly AuditEntry[],
    ): { landed: number; rejected: readonly { index: number; reason: string }[] } {
      const binding = mustResolve(coderOwner)
      if (entries.length === 0) return { landed: 0, rejected: [] }
      // Validate every pulled entry host-side BEFORE touching the database.
      // Invalid rows are collected, not thrown: one malformed row must never
      // block the same human's valid rows from landing this tick (a thrown
      // batch would be a permanent poison pill, since the collector re-pulls
      // the same journal every tick). Nor are they dropped silently: the
      // caller sees exactly which input indices failed and why, with reasons
      // that name the field but never echo the pulled value.
      const rejected: { index: number; reason: string }[] = []
      const valid: AuditEntry[] = []
      entries.forEach((entry, index) => {
        const reason = validateAuditEntry(entry)
        if (reason === null) valid.push(entry)
        else rejected.push({ index, reason })
      })
      if (valid.length === 0) return { landed: 0, rejected }
      const landed = write('audit_log', () => {
        // Each stored row is constructed HERE, host-side: identity comes from
        // the binding (`human_id`) and the channel-authentic label
        // (`workspace`); only the validated non-identity fields of the pulled
        // entry are kept. The conflict target is the full-tuple UNIQUE, so a
        // re-pull of an already-landed row inserts nothing (`changes` = 0)
        // while ANY OTHER constraint violation still aborts loudly — unlike a
        // blanket `INSERT OR IGNORE`, which would also swallow NOT NULL
        // violations and make a discarded row indistinguishable from a dedup.
        const insert = db.prepare(
          'INSERT INTO audit_log ' +
            '(github_id, human_id, workspace, endpoint, pr, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(github_id, human_id, workspace, endpoint, pr, created_at) DO NOTHING',
        )
        let inserted = 0
        const tx = db.transaction((rows: readonly AuditEntry[]) => {
          for (const entry of rows) {
            const result = insert.run(
              entry.githubId,
              binding.email,
              binding.coderOwner,
              entry.endpoint,
              entry.pr,
              entry.createdAt,
            )
            inserted += result.changes
          }
        })
        tx(valid)
        return inserted
      })
      return { landed, rejected }
    },

    getDraft(coderOwner: string, prNumber: number): ReviewDraft | null {
      const binding = mustResolve(coderOwner)
      const row = db
        .query('SELECT data FROM drafts WHERE human_id = ? AND pr_number = ?')
        .get(binding.email, prNumber) as { data: string } | null
      if (!row) return null
      const stored = parseRow<ReviewDraft>('drafts', `${binding.email}/${prNumber}`, row.data)
      // Defense in depth: landing already re-keys the embedded humanId to the
      // binding, and the read re-stamps it AGAIN, so the invariant "row key ==
      // embedded id" holds even if a stored row were edited out-of-band or
      // mangled by a future migration bug. Both boundaries enforce it.
      return { ...stored, humanId: binding.email }
    },

    getViewed(coderOwner: string, prNumber: number): FileViewedState {
      const binding = mustResolve(coderOwner)
      const row = db
        .query('SELECT data FROM viewed WHERE human_id = ? AND pr_number = ?')
        .get(binding.email, prNumber) as { data: string } | null
      if (!row) return {}
      return parseRow<FileViewedState>('viewed', `${binding.email}/${prNumber}`, row.data)
    },

    listAuditForOwner(
      coderOwner: string,
      filter: { pr?: number; sinceIso?: string } = {},
    ): AuditEntry[] {
      // The argument is an owner label, never an email: it goes through the
      // same binding resolution (and the same fail-loud) as every other path,
      // so an absent or unknown owner throws instead of reading anything.
      const binding = mustResolve(coderOwner)
      return queryAudit(binding.email, filter)
    },

    listAuditUnion(filter: { pr?: number; sinceIso?: string } = {}): AuditEntry[] {
      // The intentional cross-human union. This method takes no owner at all,
      // so the only way to read across humans is to call it BY NAME — an
      // owner-scoped read can never widen into it through a missing value.
      return queryAudit(null, filter)
    },

    purgeWorkingState(coderOwner: string): { draftsPurged: number; viewedPurged: number } {
      const binding = mustResolve(coderOwner)
      // Working state only: drafts and viewed rows go, the audit journal is
      // NEVER touched — it is permanent attribution history that must outlive
      // the human's offboarding. Both deletes commit in ONE transaction so
      // offboarding is atomic: never a partial purge where the drafts are
      // gone but the viewed state lingers (or the reverse).
      return write('drafts+viewed', () => {
        let draftsPurged = 0
        let viewedPurged = 0
        const tx = db.transaction(() => {
          draftsPurged = db.run('DELETE FROM drafts WHERE human_id = ?', [binding.email]).changes
          viewedPurged = db.run('DELETE FROM viewed WHERE human_id = ?', [binding.email]).changes
        })
        tx()
        return { draftsPurged, viewedPurged }
      })
    },

    close(): void {
      db.close()
    },
  }
}

/**
 * Create tables if absent and migrate an older store IN PLACE. Migration never
 * drops or reseeds a table — that would wipe landed drafts or, worse, the
 * audit journal — it only creates missing tables and adds columns/defaults,
 * then stamps the current `store_version`.
 *
 * On open:
 *   - a fresh file (no `meta` row) is stamped at `HOST_STORE_VERSION`;
 *   - an older version runs the additive steps between its version and current
 *     (none exist yet at version 1);
 *   - a version NEWER than this build is left untouched — never downgraded or
 *     reseeded.
 *
 * The `audit_log` UNIQUE constraint spans the full stored tuple: it is the
 * conflict target for idempotent landing. Rows differing in any field all
 * land; byte-identical rows collapse to one, which undercounts only the case
 * of two identical retry journals of the same logical write within the same
 * millisecond — same human, id, endpoint, and PR, so attribution is unchanged.
 */
function migrate(db: Database): void {
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.run(
    'CREATE TABLE IF NOT EXISTS drafts (human_id TEXT NOT NULL, pr_number INTEGER NOT NULL, ' +
      'data TEXT NOT NULL, PRIMARY KEY (human_id, pr_number))',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS viewed (human_id TEXT NOT NULL, pr_number INTEGER NOT NULL, ' +
      'data TEXT NOT NULL, PRIMARY KEY (human_id, pr_number))',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS audit_log (github_id INTEGER NOT NULL, ' +
      'human_id TEXT NOT NULL, workspace TEXT NOT NULL, endpoint TEXT NOT NULL, ' +
      'pr INTEGER NOT NULL, created_at TEXT NOT NULL, ' +
      'UNIQUE(github_id, human_id, workspace, endpoint, pr, created_at))',
  )

  const row = db.query("SELECT value FROM meta WHERE key = 'store_version'").get() as
    | { value: string }
    | null
  const current = row ? Number(row.value) : null

  if (current === null) {
    // Fresh file: stamp the current version. (No data to migrate.)
    db.run(
      "INSERT INTO meta (key, value) VALUES ('store_version', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [String(HOST_STORE_VERSION)],
    )
    return
  }

  if (current > HOST_STORE_VERSION) {
    // A file from a newer build. Do not downgrade or reseed — leave it be; the
    // additive tables above are already present, so reads still work.
    return
  }

  // Additive migration steps, oldest → newest, each guarded by
  // `if (current < N)` and each only creating tables or defaulting columns —
  // never dropping, rewriting, or reseeding a row. None exist yet at version 1.

  if (current < HOST_STORE_VERSION) {
    db.run("UPDATE meta SET value = ? WHERE key = 'store_version'", [
      String(HOST_STORE_VERSION),
    ])
  }
}

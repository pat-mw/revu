import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type {
  FileBlob,
  FileViewedState,
  HumanPreferences,
  ReviewDraft,
  Snapshot,
  SnapshotImmutable,
} from '@revu/shared'
import { DEFAULT_PREFERENCES } from '@revu/shared'

/**
 * The durable, disk-backed store for direct mode.
 *
 * Unlike the mock (which persists ONE JSON blob under a `localStorage` key and
 * may swallow write failures for a browser), this store is a real SQLite file
 * on the daemon's disk. Durability is a daemon concern here, so the write path
 * NEVER swallows an error: a failed persist surfaces as a typed `StoreWriteError`
 * so the caller can answer `persist_failed` rather than a success the client
 * would trust as saved. In-memory work is not the model — the disk IS the model.
 *
 * The tables split state by how it is keyed and how long it lives:
 *
 *   - `immutables` — the immutable half of a snapshot, keyed by
 *     `compareKey = merge_base…head` (NOT by head alone), append-only and
 *     cache-forever with no TTL. This is what lets `syncPull` skip the diff/base-
 *     tree/commits work on a warm re-sync of an unchanged comparison.
 *   - `snapshots` — the per-PR assembled snapshot (mutable half + a reference to
 *     the immutable half's compareKey). Overwritten on every sync.
 *   - `blobs` — content-addressed by git blob SHA, append-only, cache-forever,
 *     no TTL: identical SHA ⇒ identical bytes.
 *   - `drafts` — per-human, per-PR review drafts. The irreplaceable local work;
 *     they must survive a version bump and a restart.
 *   - `viewed` — per-human, per-PR per-file viewed state.
 *   - `prefs` — per-human workspace preferences.
 *   - `meta` — the single `store_version` row that drives migrate-in-place.
 *
 * Absent vs unreadable: a genuinely missing row reads back as `null` (never
 * synced / no draft yet — the correct empty answer). A row that EXISTS but whose
 * stored JSON cannot be parsed throws `StoreUnreadableError` rather than
 * returning `null`, because returning `null` would let a caller treat a present
 * document as absent and overwrite it. A present-but-unreadable row is never
 * reseeded or overwritten.
 */

/** The on-disk schema version. Bump this and add a migration step when the shape changes. */
export const STORE_VERSION = 1

/** A stored row could not be read back: the row EXISTS but its JSON is corrupt. */
export class StoreUnreadableError extends Error {
  readonly table: string
  readonly rowKey: string

  constructor(table: string, rowKey: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `The ${table} row "${rowKey}" exists but could not be parsed (${detail}). ` +
        'Refusing to treat it as absent: a present row is real state and must not ' +
        'be silently overwritten. Repair or remove the row to continue.',
    )
    this.name = 'StoreUnreadableError'
    this.table = table
    this.rowKey = rowKey
  }
}

/**
 * A durable write failed — the mutation did NOT reach disk (disk full,
 * permissions, read-only filesystem). Surfaced, never swallowed, so the daemon
 * can answer `persist_failed` instead of a success the client would trust. The
 * message carries no token material and no row contents.
 */
export class StoreWriteError extends Error {
  readonly table: string

  constructor(table: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to persist to the ${table} table: ${detail}`)
    this.name = 'StoreWriteError'
    this.table = table
  }
}

/**
 * Resolve the data directory: `${XDG_DATA_HOME:-~/.local/share}/revu`. An
 * explicit `REVU_DATA_DIR` overrides both (used by tests to point at a temp dir).
 */
export function resolveDirectDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.REVU_DATA_DIR
  if (override && override.length > 0) return override
  const xdg = env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'revu')
}

/** The store file name under the data dir. */
const DB_FILE = 'direct.sqlite'

/** The immutable half plus the head SHA it belongs to, as persisted. */
interface StoredImmutable {
  compareKey: string
  immutable: SnapshotImmutable
  /**
   * The incompleteness of THIS immutable half (file cap hit, merge-base tree
   * truncated), carried with it so a warm compareKey hit reattaches the honest
   * `partial` instead of reporting a truncated half as complete. Absent in rows
   * written before the field existed — read back as `null` (complete), which is
   * what those rows meant.
   */
  partial?: Snapshot['partial']
}

/**
 * A stored snapshot minus its immutable half: the mutable half and the top-level
 * envelope, plus the `compareKey` that joins it to the `immutables` table. The
 * immutable half is stored once per compareKey and re-attached on read, so a warm
 * re-sync that reuses the immutable half does not duplicate it on disk.
 */
interface StoredSnapshotEnvelope {
  prNumber: number
  syncedAt: string
  partial: Snapshot['partial']
  syncStats: Snapshot['syncStats']
  compareKey: string
  mutable: Snapshot['mutable']
}

/**
 * The durable store surface direct mode reads and writes. Every getter returns
 * a fresh value (JSON round-trips, so nothing aliases internal state) and every
 * setter that touches disk throws `StoreWriteError` on failure rather than
 * swallowing it.
 */
export interface DirectStore {
  // ——— immutable half, keyed by compareKey (the two-half cache) ———
  /**
   * The cached immutable half for a compare, with the `partial` that describes
   * its own incompleteness (null = complete). `null` when the key is absent.
   */
  getImmutable(
    compareKey: string,
  ): { immutable: SnapshotImmutable; partial: Snapshot['partial'] } | null
  putImmutable(immutable: SnapshotImmutable, partial?: Snapshot['partial']): void

  // ——— per-PR assembled snapshot ———
  getSnapshot(prNumber: number): Snapshot | null
  putSnapshot(snapshot: Snapshot): void

  // ——— content-addressed blobs ———
  hasBlob(sha: string): boolean
  getBlob(sha: string): FileBlob | null
  putBlobs(blobs: FileBlob[]): void

  // ——— per-human drafts ———
  getDraft(humanId: string, prNumber: number): ReviewDraft | null
  putDraft(draft: ReviewDraft): void
  deleteDraft(humanId: string, prNumber: number): void

  // ——— per-human viewed state ———
  getViewed(humanId: string, prNumber: number): FileViewedState
  setViewed(humanId: string, prNumber: number, state: FileViewedState): void

  // ——— per-human preferences ———
  getPreferences(humanId: string): HumanPreferences
  setPreferences(humanId: string, patch: Partial<HumanPreferences>): HumanPreferences

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

/**
 * Open (creating if needed) the direct-mode store at the resolved data dir, run
 * migrations in place, and return the store surface. A `:memory:` path is
 * honored verbatim for tests; any other path is created under the data dir.
 *
 * `dataDir` defaults to `${XDG_DATA_HOME:-~/.local/share}/revu`. Passing
 * `':memory:'` opens an ephemeral database with no file.
 */
export function openDirectStore(
  opts: { dataDir?: string; env?: Record<string, string | undefined> } = {},
): DirectStore {
  const env = opts.env ?? process.env
  const dataDir = opts.dataDir ?? resolveDirectDataDir(env)

  let db: Database
  if (dataDir === ':memory:') {
    db = new Database(':memory:')
  } else {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    db = new Database(join(dataDir, DB_FILE))
  }

  // Durability pragmas: a WAL with FULL synchrony means a committed write has
  // reached disk before the call returns, which is the whole point of a durable
  // host — an ack the client can trust as saved.
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = FULL')

  migrate(db)

  /** Run a write, wrapping any failure in a typed `StoreWriteError` (never swallowed). */
  function write(table: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      throw new StoreWriteError(table, err)
    }
  }

  return {
    getImmutable(
      compareKey: string,
    ): { immutable: SnapshotImmutable; partial: Snapshot['partial'] } | null {
      const row = db
        .query('SELECT data FROM immutables WHERE compare_key = ?')
        .get(compareKey) as { data: string } | null
      if (!row) return null
      const stored = parseRow<StoredImmutable>('immutables', compareKey, row.data)
      return { immutable: stored.immutable, partial: stored.partial ?? null }
    },

    putImmutable(immutable: SnapshotImmutable, partial: Snapshot['partial'] = null): void {
      const stored: StoredImmutable = {
        compareKey: immutable.compareKey,
        immutable,
        partial,
      }
      write('immutables', () => {
        // Cache-forever, no TTL: an identical compareKey is idempotently the
        // same diff, so a re-put replaces bytes-for-bytes without invalidation.
        db.run(
          'INSERT INTO immutables (compare_key, data) VALUES (?, ?) ' +
            'ON CONFLICT(compare_key) DO UPDATE SET data = excluded.data',
          [immutable.compareKey, JSON.stringify(stored)],
        )
      })
    },

    getSnapshot(prNumber: number): Snapshot | null {
      const row = db
        .query('SELECT data FROM snapshots WHERE pr_number = ?')
        .get(prNumber) as { data: string } | null
      if (!row) return null
      const envelope = parseRow<StoredSnapshotEnvelope>(
        'snapshots',
        String(prNumber),
        row.data,
      )
      const imm = db
        .query('SELECT data FROM immutables WHERE compare_key = ?')
        .get(envelope.compareKey) as { data: string } | null
      if (!imm) {
        // The snapshot references an immutable half that is not on disk. That is
        // a corrupt store, not an absent snapshot: surface it rather than return
        // a snapshot with a fabricated or empty immutable half.
        throw new StoreUnreadableError(
          'snapshots',
          String(prNumber),
          new Error(
            `snapshot references compareKey "${envelope.compareKey}" with no stored immutable half`,
          ),
        )
      }
      const stored = parseRow<StoredImmutable>('immutables', envelope.compareKey, imm.data)
      return {
        prNumber: envelope.prNumber,
        syncedAt: envelope.syncedAt,
        partial: envelope.partial,
        syncStats: envelope.syncStats,
        immutable: stored.immutable,
        mutable: envelope.mutable,
      }
    },

    putSnapshot(snapshot: Snapshot): void {
      const envelope: StoredSnapshotEnvelope = {
        prNumber: snapshot.prNumber,
        syncedAt: snapshot.syncedAt,
        partial: snapshot.partial,
        syncStats: snapshot.syncStats,
        compareKey: snapshot.immutable.compareKey,
        mutable: snapshot.mutable,
      }
      // `snapshot.partial` only ever describes the immutable half's own
      // incompleteness (file cap, truncated merge-base tree), so it rides with
      // the immutable row and survives a warm compareKey reuse. If a snapshot-
      // scoped partial (e.g. missing blob bytes a retry can fix) is ever added,
      // split it out of this row rather than pinning it to the compare.
      const storedImm: StoredImmutable = {
        compareKey: snapshot.immutable.compareKey,
        immutable: snapshot.immutable,
        partial: snapshot.partial,
      }
      write('snapshots', () => {
        // The immutable half and the envelope are written in ONE transaction so a
        // snapshot never references an immutable half that is not on disk.
        const tx = db.transaction(() => {
          db.run(
            'INSERT INTO immutables (compare_key, data) VALUES (?, ?) ' +
              'ON CONFLICT(compare_key) DO UPDATE SET data = excluded.data',
            [snapshot.immutable.compareKey, JSON.stringify(storedImm)],
          )
          db.run(
            'INSERT INTO snapshots (pr_number, data) VALUES (?, ?) ' +
              'ON CONFLICT(pr_number) DO UPDATE SET data = excluded.data',
            [snapshot.prNumber, JSON.stringify(envelope)],
          )
        })
        tx()
      })
    },

    hasBlob(sha: string): boolean {
      const row = db.query('SELECT 1 FROM blobs WHERE sha = ?').get(sha)
      return row !== null
    },

    getBlob(sha: string): FileBlob | null {
      const row = db.query('SELECT data FROM blobs WHERE sha = ?').get(sha) as
        | { data: string }
        | null
      if (!row) return null
      return parseRow<FileBlob>('blobs', sha, row.data)
    },

    putBlobs(blobs: FileBlob[]): void {
      if (blobs.length === 0) return
      write('blobs', () => {
        const insert = db.prepare(
          'INSERT INTO blobs (sha, data) VALUES (?, ?) ' +
            'ON CONFLICT(sha) DO NOTHING',
        )
        const tx = db.transaction((rows: FileBlob[]) => {
          for (const b of rows) insert.run(b.sha, JSON.stringify(b))
        })
        tx(blobs)
      })
    },

    getDraft(humanId: string, prNumber: number): ReviewDraft | null {
      const row = db
        .query('SELECT data FROM drafts WHERE human_id = ? AND pr_number = ?')
        .get(humanId, prNumber) as { data: string } | null
      if (!row) return null
      return parseRow<ReviewDraft>('drafts', `${humanId}/${prNumber}`, row.data)
    },

    putDraft(draft: ReviewDraft): void {
      write('drafts', () => {
        db.run(
          'INSERT INTO drafts (human_id, pr_number, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, pr_number) DO UPDATE SET data = excluded.data',
          [draft.humanId, draft.prNumber, JSON.stringify(draft)],
        )
      })
    },

    deleteDraft(humanId: string, prNumber: number): void {
      write('drafts', () => {
        db.run('DELETE FROM drafts WHERE human_id = ? AND pr_number = ?', [humanId, prNumber])
      })
    },

    getViewed(humanId: string, prNumber: number): FileViewedState {
      const row = db
        .query('SELECT data FROM viewed WHERE human_id = ? AND pr_number = ?')
        .get(humanId, prNumber) as { data: string } | null
      if (!row) return {}
      return parseRow<FileViewedState>('viewed', `${humanId}/${prNumber}`, row.data)
    },

    setViewed(humanId: string, prNumber: number, state: FileViewedState): void {
      write('viewed', () => {
        db.run(
          'INSERT INTO viewed (human_id, pr_number, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, pr_number) DO UPDATE SET data = excluded.data',
          [humanId, prNumber, JSON.stringify(state)],
        )
      })
    },

    getPreferences(humanId: string): HumanPreferences {
      const row = db
        .query('SELECT data FROM prefs WHERE human_id = ?')
        .get(humanId) as { data: string } | null
      if (!row) return { ...DEFAULT_PREFERENCES }
      const stored = parseRow<Partial<HumanPreferences>>('prefs', humanId, row.data)
      // New preference fields default from `DEFAULT_PREFERENCES`, so an old row
      // that predates a field reads back with the field defaulted, never missing.
      return { ...DEFAULT_PREFERENCES, ...stored }
    },

    setPreferences(humanId: string, patch: Partial<HumanPreferences>): HumanPreferences {
      const current = this.getPreferences(humanId)
      const next: HumanPreferences = { ...current, ...patch }
      write('prefs', () => {
        db.run(
          'INSERT INTO prefs (human_id, data) VALUES (?, ?) ' +
            'ON CONFLICT(human_id) DO UPDATE SET data = excluded.data',
          [humanId, JSON.stringify(next)],
        )
      })
      return next
    },

    close(): void {
      db.close()
    },
  }
}

/**
 * Create tables if absent and migrate an older store IN PLACE. Migration never
 * drops or reseeds a table — that would wipe drafts — it only creates missing
 * tables and adds columns/defaults, then stamps the current `store_version`.
 *
 * The `meta` row records the version the file was last written at. On open:
 *   - a fresh file (no `meta` row) is stamped at `STORE_VERSION`;
 *   - an older version runs the additive steps between its version and current;
 *   - a version NEWER than this build is left untouched (a future file this
 *     build cannot reason about) — it is not downgraded or reseeded.
 *
 * When the shape changes: bump `STORE_VERSION`, add a `CREATE TABLE IF NOT
 * EXISTS` / `ALTER TABLE … ADD COLUMN` step here defaulting the new field, and
 * the ladder upgrades every existing file without touching a single draft.
 */
function migrate(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  )

  // Version 1 shape. Every table is created only when absent, so re-opening a
  // populated store adds nothing and drops nothing.
  db.run(
    'CREATE TABLE IF NOT EXISTS immutables (compare_key TEXT PRIMARY KEY, data TEXT NOT NULL)',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS snapshots (pr_number INTEGER PRIMARY KEY, data TEXT NOT NULL)',
  )
  db.run('CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, data TEXT NOT NULL)')
  db.run(
    'CREATE TABLE IF NOT EXISTS drafts (human_id TEXT NOT NULL, pr_number INTEGER NOT NULL, ' +
      'data TEXT NOT NULL, PRIMARY KEY (human_id, pr_number))',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS viewed (human_id TEXT NOT NULL, pr_number INTEGER NOT NULL, ' +
      'data TEXT NOT NULL, PRIMARY KEY (human_id, pr_number))',
  )
  db.run('CREATE TABLE IF NOT EXISTS prefs (human_id TEXT PRIMARY KEY, data TEXT NOT NULL)')

  const row = db.query("SELECT value FROM meta WHERE key = 'store_version'").get() as
    | { value: string }
    | null
  const current = row ? Number(row.value) : null

  if (current === null) {
    // Fresh file: stamp the current version. (No data to migrate.)
    db.run(
      "INSERT INTO meta (key, value) VALUES ('store_version', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [String(STORE_VERSION)],
    )
    return
  }

  if (current > STORE_VERSION) {
    // A file from a newer build. Do not downgrade or reseed — leave it be; the
    // additive tables above are already present, so reads still work.
    return
  }

  // Future additive migration steps go here, oldest → newest, each guarded by
  // `if (current < N)` and each only creating tables or defaulting columns.
  // (There are none yet; version 1 is the initial shape.)

  if (current < STORE_VERSION) {
    db.run("UPDATE meta SET value = ? WHERE key = 'store_version'", [String(STORE_VERSION)])
  }
}

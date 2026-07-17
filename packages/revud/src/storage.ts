import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A durable, disk-backed `Storage` implementation and the boot-time install
 * that makes the app's mock store hydrate from disk instead of a browser tab.
 *
 * The mock's persistent broker store reads and writes ONE JSON document under a
 * single `localStorage` key. In a browser that key lives in `window.localStorage`
 * and dies with the tab; a disposable daemon needs it on disk so a restart loses
 * no draft. This polyfill implements just enough of the `Storage` interface for
 * the store (`getItem`/`setItem`/`removeItem`, plus `clear`/`key`/`length` for
 * completeness) over one file at `${dataDir}/revu.broker.v1.json`.
 *
 * Writes are ATOMIC: the payload is written to a sibling temp file which is then
 * `rename`d over the target. `rename` within a directory is atomic on POSIX, so
 * a crash mid-write can never leave a half-written document — a reader sees
 * either the old bytes or the new ones, never a truncation.
 *
 * Reads distinguish ABSENT from UNREADABLE. A missing file returns `null`
 * (never synced — seeding from fixtures is correct). A file that EXISTS but
 * cannot be read throws `StoreFileUnreadableError` instead of returning `null`:
 * the store treats `null` as "absent" and reseeds, and the next flush would
 * then overwrite the real document with fresh seed state — turning a transient
 * I/O error into permanent draft loss. The daemon refuses to boot on an
 * unreadable store file rather than silently reseeding over it.
 */

/** The single storage key the mock store persists its whole document under. */
const BROKER_KEY = 'revu.broker.v1'

/**
 * The broker store file EXISTS on disk but could not be read (permissions, an
 * I/O fault). Deliberately distinct from "absent": absent means never synced
 * and seeding is safe; unreadable means a real document — possibly full of
 * drafts — is present and MUST NOT be replaced with seed state. Callers treat
 * this as a hard failure, never as an empty store.
 */
export class StoreFileUnreadableError extends Error {
  readonly path: string

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `The broker store file at ${path} exists but could not be read (${detail}). ` +
        'Refusing to continue: treating it as absent would reseed from fixtures and ' +
        'overwrite every saved draft on the next write. Fix the file permissions, ' +
        'or move the file aside to deliberately start fresh.',
    )
    this.name = 'StoreFileUnreadableError'
    this.path = path
  }
}

/** On-disk file name for the broker document. */
const DOC_FILE = `${BROKER_KEY}.json`

/** Resolve the data directory: `REVU_DATA_DIR` or `<cwd>/.revud`. */
export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.REVU_DATA_DIR
  if (configured && configured.length > 0) return configured
  return join(process.cwd(), '.revud')
}

/**
 * A `Storage`-shaped value backed by a single JSON file on disk. Only the
 * `revu.broker.v1` key maps to the file; any other key is held in memory so the
 * shape stays faithful without inventing extra files (the mock never uses them).
 */
export class DiskStorage {
  private readonly dataDir: string
  private readonly docPath: string
  private readonly extras = new Map<string, string>()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.docPath = join(dataDir, DOC_FILE)
  }

  private ensureDir(): void {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
  }

  /**
   * `null` ONLY when the document is genuinely absent (never persisted).
   * A present-but-unreadable file throws `StoreFileUnreadableError` — returning
   * `null` would make the store reseed and later overwrite the real document.
   */
  getItem(key: string): string | null {
    if (key !== BROKER_KEY) return this.extras.get(key) ?? null
    if (!existsSync(this.docPath)) return null
    try {
      return readFileSync(this.docPath, 'utf8')
    } catch (err) {
      throw new StoreFileUnreadableError(this.docPath, err)
    }
  }

  setItem(key: string, value: string): void {
    if (key !== BROKER_KEY) {
      this.extras.set(key, String(value))
      return
    }
    this.ensureDir()
    // Write to a per-process temp sibling, then rename over the target. The
    // rename is the only observable mutation and it is atomic within the dir.
    const tmpPath = `${this.docPath}.${process.pid}.tmp`
    writeFileSync(tmpPath, String(value), 'utf8')
    renameSync(tmpPath, this.docPath)
  }

  removeItem(key: string): void {
    if (key !== BROKER_KEY) {
      this.extras.delete(key)
      return
    }
    if (existsSync(this.docPath)) {
      try {
        unlinkSync(this.docPath)
      } catch {
        // Already gone (concurrent remove) — a removed document is a removed document.
      }
    }
  }

  clear(): void {
    this.extras.clear()
    this.removeItem(BROKER_KEY)
  }

  key(index: number): string | null {
    const keys = [...this.extras.keys()]
    if (existsSync(this.docPath)) keys.push(BROKER_KEY)
    return keys[index] ?? null
  }

  get length(): number {
    return this.extras.size + (existsSync(this.docPath) ? 1 : 0)
  }
}

/**
 * Install the disk-backed storage as `globalThis.localStorage` BEFORE any mock
 * module loads, so the store's module-load `load()` hydrates from disk. Returns
 * the resolved data directory for logging. Overwrites any pre-existing
 * `localStorage` (e.g. an in-memory test shim) so the daemon's durability path
 * is the one that runs.
 *
 * Boot-time guard: the store document is read once here, so a PRESENT but
 * UNREADABLE file fails startup loudly (`StoreFileUnreadableError`) before the
 * store can load. The store's own loader intentionally reseeds on any read
 * failure — correct in a browser, where localStorage holds the only copy and
 * the session must keep working — but against a disk that swallow would let a
 * transient I/O error silently replace a real document, full of drafts, with
 * seed state on the next flush. An absent file passes: seeding a never-synced
 * data dir is the correct first boot.
 */
export function installDiskStorage(
  env: Record<string, string | undefined> = process.env,
): { dataDir: string; storage: DiskStorage } {
  const dataDir = resolveDataDir(env)
  const storage = new DiskStorage(dataDir)
  // Throws StoreFileUnreadableError when the document exists but cannot be
  // read; `null` (absent) and a successful read both proceed.
  storage.getItem(BROKER_KEY)
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return { dataDir, storage }
}

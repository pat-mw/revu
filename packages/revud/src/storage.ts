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
 */

/** The single storage key the mock store persists its whole document under. */
const BROKER_KEY = 'revu.broker.v1'

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

  getItem(key: string): string | null {
    if (key !== BROKER_KEY) return this.extras.get(key) ?? null
    if (!existsSync(this.docPath)) return null
    try {
      return readFileSync(this.docPath, 'utf8')
    } catch {
      return null
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
 */
export function installDiskStorage(
  env: Record<string, string | undefined> = process.env,
): { dataDir: string; storage: DiskStorage } {
  const dataDir = resolveDataDir(env)
  const storage = new DiskStorage(dataDir)
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return { dataDir, storage }
}

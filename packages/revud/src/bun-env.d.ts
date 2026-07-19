/**
 * Minimal ambient declarations for the Bun runtime surface revud uses, so the
 * daemon type-checks without pulling in `@types/bun` (zero new dependencies).
 * Only the members actually called are declared; Bun provides the real
 * implementations at runtime. Web globals (`Request`, `Response`, `URL`,
 * `fetch`) come from the `DOM` lib in tsconfig.
 */

/** The Bun HTTP server handle returned by `Bun.serve`. */
interface BunServer {
  readonly port: number
  stop(closeActiveConnections?: boolean): void
}

/**
 * A lazily-read file handle from `Bun.file`. It extends `Blob` so it is a valid
 * `Response` body (Bun streams it with the right content type), and adds the
 * one extra member revud calls.
 */
interface BunFile extends Blob {
  exists(): Promise<boolean>
}

interface BunServeOptions {
  port?: number
  fetch(req: Request): Response | Promise<Response>
}

/** A spawned child process handle (subset used by the integration tests). */
interface BunSubprocess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | string): void
}

interface BunSpawnOptions {
  env?: Record<string, string | undefined>
  /** Working directory for the child process (defaults to the parent's cwd). */
  cwd?: string
  stdout?: 'pipe' | 'inherit' | 'ignore'
  stderr?: 'pipe' | 'inherit' | 'ignore'
}

/**
 * Bun's built-in YAML surface. `parse` returns `unknown` because the parsed
 * shape is untrusted host input the caller validates; it throws on syntactically
 * invalid YAML.
 */
interface BunYaml {
  parse(text: string): unknown
}

interface BunNamespace {
  serve(options: BunServeOptions): BunServer
  file(path: string): BunFile
  sleep(ms: number): Promise<void>
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess
  readonly YAML: BunYaml
}

declare const Bun: BunNamespace

declare module 'bun' {
  export type Server = BunServer
  export type Subprocess = BunSubprocess
}

/**
 * Minimal `bun:sqlite` surface the durable store uses. Only the members the
 * store calls are declared; Bun provides the real implementation at runtime.
 * A bound query/statement's row type is unknown here — callers narrow it — so
 * `get`/`all` return `unknown`.
 */
declare module 'bun:sqlite' {
  /**
   * Mutation counts reported by a completed `run`: `changes` is the number of
   * rows the statement inserted/updated/deleted (0 when an `INSERT OR IGNORE`
   * hit a conflict), matching SQLite's `sqlite3_changes`.
   */
  export interface Changes {
    readonly changes: number
    readonly lastInsertRowid: number | bigint
  }

  /** A prepared statement, run with positional parameters. */
  export interface Statement {
    run(...params: (string | number | null)[]): Changes
    get(...params: (string | number | null)[]): unknown
    all(...params: (string | number | null)[]): unknown[]
  }

  /** A single SQLite database handle over one file (or `:memory:`). */
  export class Database {
    constructor(filename: string)
    run(sql: string, params?: (string | number | null)[]): Changes
    query(sql: string): Statement
    prepare(sql: string): Statement
    /** Wrap `fn` in a transaction; the returned function commits on success, rolls back on throw. */
    transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void
    close(): void
  }
}

interface ImportMeta {
  /** True when this module is the program entry point (`bun run <file>`). */
  readonly main: boolean
  /** Absolute path of the directory containing this module. */
  readonly dir: string
}

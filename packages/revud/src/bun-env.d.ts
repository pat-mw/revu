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
  stdout?: 'pipe' | 'inherit' | 'ignore'
  stderr?: 'pipe' | 'inherit' | 'ignore'
}

interface BunNamespace {
  serve(options: BunServeOptions): BunServer
  file(path: string): BunFile
  sleep(ms: number): Promise<void>
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess
}

declare const Bun: BunNamespace

declare module 'bun' {
  export type Server = BunServer
  export type Subprocess = BunSubprocess
}

interface ImportMeta {
  /** True when this module is the program entry point (`bun run <file>`). */
  readonly main: boolean
  /** Absolute path of the directory containing this module. */
  readonly dir: string
}

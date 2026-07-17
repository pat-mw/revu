/**
 * Minimal ambient declarations for the Bun + Node surface the co-located
 * integration test uses to spawn a real `revud` child process. Declared by hand
 * so the app type-checks without pulling in `@types/bun` (zero new
 * dependencies), mirroring `packages/revud/src/bun-env.d.ts`. Only the members
 * the test actually calls are declared; Bun/Node supply the real
 * implementations at runtime. Web globals (`fetch`, `Response`, `Headers`,
 * `AbortController`, `TextDecoder`, `DOMException`) come from the DOM lib.
 */

/** A spawned child process handle — the subset the integration test reads. */
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
  sleep(ms: number): Promise<void>
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess
}

declare const Bun: BunNamespace

declare module 'bun' {
  export type Subprocess = BunSubprocess
}

/** The Node process handle — only `env` is read (to inherit the parent env). */
declare const process: {
  env: Record<string, string | undefined>
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function mkdtempSync(prefix: string): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function writeFileSync(path: string, data: string, encoding?: string): void
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

interface ImportMeta {
  /** Absolute path of the directory containing this module. */
  readonly dir: string
}

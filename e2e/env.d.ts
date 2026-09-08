/**
 * Minimal ambient declarations for the Bun surface the repository-root tooling
 * reaches for — the end-to-end drivers under `e2e` and the suites under `test`.
 * Both directories belong to one TypeScript project, so these declarations
 * cover both.
 *
 * Written by hand rather than pulled from `@types/bun` so the typecheck adds no
 * dependency, mirroring the per-package ambients the app and the daemon carry.
 * Only the members actually called are declared; Bun supplies the real
 * implementations at runtime. Node's own surface (`process`, `node:fs`,
 * `node:os`, `node:path`, `node:child_process`) is NOT redeclared here — this
 * project sets `"types": ["node"]`, so `@types/node` is authoritative for it.
 * Web globals (`fetch`, `Response`, `URL`, `ReadableStream`, `TextDecoder`)
 * come from the DOM lib, and `playwright-core` ships its own types.
 */

/** A spawned child process handle — the subset the drivers read. */
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

interface BunSpawnSyncOptions extends BunSpawnOptions {
  stdin?: 'ignore' | 'inherit'
}

/**
 * The completed result of a synchronous spawn. `stdout`/`stderr` are the raw
 * captured bytes (decode them to read them), and `success` is the convenience
 * form of `exitCode === 0`.
 */
interface BunSyncSubprocess {
  readonly exitCode: number
  readonly success: boolean
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

interface BunNamespace {
  sleep(ms: number): Promise<void>
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess
  spawnSync(cmd: string[], options?: BunSpawnSyncOptions): BunSyncSubprocess
}

declare const Bun: BunNamespace

declare module 'bun' {
  export type Subprocess = BunSubprocess
  export type SyncSubprocess = BunSyncSubprocess
}

/**
 * Minimal ambient types for Bun's built-in test runner (`bun:test`), so the
 * suites here typecheck without pulling in a dependency. The matcher set is
 * intentionally permissive — an `any` index signature accepts any
 * Jest-compatible matcher name — so adding an assertion never means editing
 * this file.
 *
 * Every test and every lifecycle hook accepts an optional trailing millisecond
 * budget, which Bun honours in place of its default. It is declared because a
 * suite that spawns real processes does not fit the default, and raising the
 * budget for the whole run instead would hide a genuine hang everywhere else.
 */
declare module 'bun:test' {
  type TestFn = () => void | Promise<void>

  export function describe(label: string, fn: () => void): void
  export function it(label: string, fn: TestFn, timeout?: number): void
  export const test: {
    (label: string, fn: TestFn, timeout?: number): void
    /** Registers the test, skipping it when `condition` is true (e.g. an environment where the setup cannot fail as intended). */
    skipIf(condition: boolean): (label: string, fn: TestFn, timeout?: number) => void
  }

  export function beforeAll(fn: TestFn, timeout?: number): void
  export function afterAll(fn: TestFn, timeout?: number): void
  export function beforeEach(fn: TestFn, timeout?: number): void
  export function afterEach(fn: TestFn, timeout?: number): void

  interface Matchers {
    not: Matchers
    resolves: Matchers
    rejects: Matchers
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toStrictEqual(expected: unknown): void
    toBeNull(): void
    toBeUndefined(): void
    toBeDefined(): void
    toBeTruthy(): void
    toBeFalsy(): void
    toContain(expected: unknown): void
    toContainEqual(expected: unknown): void
    toHaveLength(length: number): void
    toHaveProperty(key: string, value?: unknown): void
    toThrow(expected?: unknown): void
    toMatch(expected: string | RegExp): void
    toMatchObject(expected: object): void
    toBeGreaterThan(n: number): void
    toBeGreaterThanOrEqual(n: number): void
    toBeLessThan(n: number): void
    toBeLessThanOrEqual(n: number): void
    toBeInstanceOf(cls: unknown): void
    toBeCloseTo(n: number, digits?: number): void
    // Escape hatch for any Bun/Jest matcher not spelled out above.
    [matcher: string]: any
  }

  export function expect(actual: unknown): Matchers
}

interface ImportMeta {
  /** Absolute path of the directory containing this module. */
  readonly dir: string
  /** True when this module is the program entry point (`bun run <file>`). */
  readonly main: boolean
}

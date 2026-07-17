/**
 * Minimal ambient types for Bun's built-in test runner (`bun:test`) so the
 * co-located `*.test.ts` suites typecheck under `tsc -b` without pulling in a
 * dependency. Bun supplies the real implementations at runtime; these
 * declarations describe only the surface the suites consume. The matcher set
 * is intentionally permissive — an `any` index signature accepts any
 * Jest-compatible matcher name — so adding an assertion never means editing
 * this file.
 */
declare module 'bun:test' {
  type TestFn = () => void | Promise<void>

  export function describe(label: string, fn: () => void): void
  export function it(label: string, fn: TestFn): void
  export const test: {
    (label: string, fn: TestFn): void
    /** Registers the test, skipping it when `condition` is true (e.g. an environment where the setup cannot fail as intended). */
    skipIf(condition: boolean): (label: string, fn: TestFn) => void
  }

  export function beforeAll(fn: TestFn): void
  export function afterAll(fn: TestFn): void
  export function beforeEach(fn: TestFn): void
  export function afterEach(fn: TestFn): void

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

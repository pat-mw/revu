/**
 * The end-to-end harness decides what to spawn before it spawns anything, so
 * that decision can be asserted here — with no daemon, no built dist and no
 * browser. Two properties matter most and are pinned below:
 *
 *   - the default resolution is byte-identical to the mock harness the existing
 *     driver has always booted (mode, port, dist dir, argv);
 *   - ownership of the data directory is a value, not a convention: the harness
 *     may only delete a directory it created itself.
 *
 * The resolution is pure, so every case injects a stub data-dir factory and
 * touches no disk. The one case that exercises the real factory removes the
 * directory it makes.
 */
import { expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DIST_DIR, REVUD_ENTRY, resolveHarnessOptions } from './harness-options'

/** A data dir no test creates: the resolution only ever copies it around. */
const STUB_DATA_DIR = '/stub/revu-e2e-data'

/** Injected in place of the real `mkdtempSync`, so resolution stays on paper. */
const stubDeps = { makeDataDir: (): string => STUB_DATA_DIR }

test('the exported paths point at the daemon entry and the built app dist', () => {
  // Derived here from this file's own location rather than read back off the
  // module, so a wrong constant cannot agree with itself.
  expect(REVUD_ENTRY).toBe(resolve(import.meta.dir, '../packages/revud/src/index.ts'))
  expect(DIST_DIR).toBe(resolve(import.meta.dir, '../packages/app/dist'))
})

test('the default resolution boots the mock daemon on an ephemeral port', () => {
  const resolved = resolveHarnessOptions(undefined, stubDeps)

  expect(resolved.mode).toBe('mock')
  expect(resolved.cwd).toBeUndefined()
  expect(resolved.dataDir).toBe(STUB_DATA_DIR)
  expect(resolved.ownsDataDir).toBe(true)

  expect(resolved.argv).toEqual(['bun', 'run', REVUD_ENTRY])
  expect(resolved.argv).not.toContain('--preload')

  expect(resolved.env.REVU_PORT).toBe('0')
  expect(resolved.env.REVU_MODE).toBe('mock')
  expect(resolved.env.REVU_DATA_DIR).toBe(STUB_DATA_DIR)
  expect(resolved.env.REVU_DIST_DIR).toBe(DIST_DIR)
  // The port is ephemeral by literal, not by whatever the module happens to say.
  expect(resolved.env.REVU_PORT).not.toBe('4173')
})

test('with no arguments at all it mints a temp data directory it owns', () => {
  const resolved = resolveHarnessOptions()
  try {
    expect(resolved.ownsDataDir).toBe(true)
    expect(resolved.dataDir.startsWith(join(tmpdir(), 'revu-e2e-'))).toBe(true)
    expect(existsSync(resolved.dataDir)).toBe(true)
    expect(resolved.env.REVU_DATA_DIR).toBe(resolved.dataDir)
  } finally {
    rmSync(resolved.dataDir, { recursive: true, force: true })
  }
})

test('direct mode changes the mode and the working directory and nothing else', () => {
  const base = resolveHarnessOptions(undefined, stubDeps)
  const resolved = resolveHarnessOptions({ mode: 'direct', cwd: '/some/repo' }, stubDeps)

  expect(resolved.mode).toBe('direct')
  expect(resolved.env.REVU_MODE).toBe('direct')
  expect(resolved.cwd).toBe('/some/repo')

  // Everything the daemon is otherwise told stays exactly as it was.
  expect(resolved.argv).toEqual(base.argv)
  expect(resolved.env.REVU_DIST_DIR).toBe(base.env.REVU_DIST_DIR)
  expect(resolved.env.REVU_PORT).toBe(base.env.REVU_PORT)
  expect(resolved.env.REVU_DATA_DIR).toBe(base.env.REVU_DATA_DIR)
  expect(resolved.dataDir).toBe(base.dataDir)
  expect(resolved.ownsDataDir).toBe(base.ownsDataDir)
  // And no other environment variable moved: put the mode back and the whole
  // environment is the default one again.
  expect({ ...resolved.env, REVU_MODE: 'mock' }).toEqual(base.env)
})

test('a caller-supplied data directory is used as given and is never owned', () => {
  let minted = 0
  const countingDeps = {
    makeDataDir: (): string => {
      minted++
      return STUB_DATA_DIR
    },
  }

  const resolved = resolveHarnessOptions({ dataDir: '/caller/owned/data' }, countingDeps)

  expect(resolved.dataDir).toBe('/caller/owned/data')
  expect(resolved.env.REVU_DATA_DIR).toBe('/caller/owned/data')
  // `false` is the teardown contract: the harness deletes only what it created.
  expect(resolved.ownsDataDir).toBe(false)
  // A caller directory must not also mint a temp one, which nothing would remove.
  expect(minted).toBe(0)
})

test('a caller environment merges over the daemon variables without dropping any', () => {
  const resolved = resolveHarnessOptions(
    { env: { REVU_LOCAL_ONLY: '1', REVU_PORT: '4321' } },
    stubDeps,
  )

  // The caller's environment is applied last, so a caller key wins.
  expect(resolved.env.REVU_PORT).toBe('4321')
  expect(resolved.env.REVU_LOCAL_ONLY).toBe('1')
  // Every daemon variable survives the merge.
  expect(resolved.env.REVU_DATA_DIR).toBe(STUB_DATA_DIR)
  expect(resolved.env.REVU_DIST_DIR).toBe(DIST_DIR)
  expect(resolved.env.REVU_MODE).toBe('mock')
  // The ambient environment is still inherited, so the child finds its tools.
  expect(resolved.env.PATH).toBe(process.env.PATH ?? '')
})

test('a preload guard is placed ahead of the entry point in argv', () => {
  const resolved = resolveHarnessOptions({ preload: '/x/guard.ts' }, stubDeps)

  expect(resolved.argv).toEqual(['bun', 'run', '--preload', '/x/guard.ts', REVUD_ENTRY])
})

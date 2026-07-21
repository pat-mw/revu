/**
 * The `revu` command — the surface a contractor actually types.
 *
 * Everything asserted here is a REFUSAL or a read: no test starts the daemon,
 * so the suite touches no ports and leaves no processes behind. That is not a
 * limitation dodged, it is where the risk lives — the command's job is to
 * resolve which repository it is looking at and decline when it cannot, and a
 * wrong answer there opens somebody else's repository while looking successful.
 *
 * The script is driven as a real subprocess against a temporary HOME and a
 * temporary install prefix, because its behaviour is its output and its exit
 * code, not any function it happens to define.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'bin', 'revu')

let home: string
let prefix: string
let work: string

/** An install prefix whose `revud` exists and is executable but is never run. */
function makePrefix(runtimeEnv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'revu-prefix-'))
  writeFileSync(join(dir, 'revud'), '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(join(dir, 'revud'), 0o755)
  writeFileSync(join(dir, 'revu.commit'), 'abcdef1234567890\n', 'utf8')
  if (runtimeEnv !== undefined) writeFileSync(join(dir, 'runtime.env'), runtimeEnv, 'utf8')
  return dir
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

/** A git repository whose `origin` is whatever the caller names, or none. */
function makeRepo(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'revu-repo-'))
  git(dir, 'init', '-q')
  if (origin !== undefined) git(dir, 'remote', 'add', 'origin', origin)
  return dir
}

interface Run {
  code: number
  out: string
}

function runRevu(args: string[], opts: { cwd?: string; prefix?: string } = {}): Run {
  const proc = spawnSync('bash', [SCRIPT, ...args], {
    cwd: opts.cwd ?? work,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      REVU_PREFIX: opts.prefix ?? prefix,
      // Deliberately absent: VSCODE_IPC_HOOK_CLI. Without it the command must
      // never try to reach an editor, so these runs cannot open anything.
    },
  })
  return { code: proc.status ?? -1, out: `${proc.stdout}${proc.stderr}` }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'revu-home-'))
  mkdirSync(join(home, '.local', 'share', 'revu'), { recursive: true })
  prefix = makePrefix()
  work = mkdtempSync(join(tmpdir(), 'revu-work-'))
})

afterEach(() => {
  for (const d of [home, prefix, work]) rmSync(d, { recursive: true, force: true })
})

describe('resolving which repository to review', () => {
  test('refuses in a directory that is not a git repository', () => {
    const r = runRevu([])
    expect(r.code).toBe(1)
    expect(r.out).toContain('not a GitHub repository')
  })

  test('refuses in a git repository that has no origin', () => {
    const repo = makeRepo()
    const r = runRevu([], { cwd: repo })
    rmSync(repo, { recursive: true, force: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('not a GitHub repository')
  })

  test('refuses when the origin is a git remote somewhere other than GitHub', () => {
    const repo = makeRepo('https://gitlab.com/acme/widget.git')
    const r = runRevu([], { cwd: repo })
    rmSync(repo, { recursive: true, force: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('not a GitHub repository')
  })

  // The whole point. A configured default is present and correct, and the
  // command must still decline, because the question is not "what was this
  // workspace set up for" but "what am I looking at".
  test('does NOT fall back to the configured repository when there is no repo here', () => {
    const p = makePrefix('REVU_REPO="acme/configured"\nREVU_PORT="4780"\n')
    const r = runRevu([], { prefix: p })
    rmSync(p, { recursive: true, force: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('not a GitHub repository')
  })

  test('names where the repositories actually are, when told', () => {
    const repos = mkdtempSync(join(tmpdir(), 'revu-repos-'))
    const inner = join(repos, 'widget')
    mkdirSync(inner)
    git(inner, 'init', '-q')
    const p = makePrefix(`REVU_REPOS_DIR="${repos}"\n`)
    const r = runRevu([], { prefix: p })
    rmSync(repos, { recursive: true, force: true })
    rmSync(p, { recursive: true, force: true })
    expect(r.out).toContain('Available here')
    expect(r.out).toContain(inner)
  })
})

describe('refusing to run at all', () => {
  test('stops when the daemon binary is not installed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'revu-empty-'))
    const r = runRevu(['status'], { prefix: empty })
    rmSync(empty, { recursive: true, force: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('not installed')
  })

  test('rejects an unknown subcommand rather than guessing at one', () => {
    const r = runRevu(['bogus'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('unknown command')
  })

  test('says so when asked for logs that do not exist yet', () => {
    const r = runRevu(['logs'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('no log yet')
  })
})

describe('status', () => {
  test('reports the daemon as down, and every field a diagnosis needs', () => {
    const p = makePrefix('REVU_REPO="acme/widget"\nREVU_BOT_LOGIN="acme-app[bot]"\n')
    const r = runRevu(['status'], { prefix: p })
    rmSync(p, { recursive: true, force: true })
    expect(r.code).toBe(0)
    expect(r.out).toContain('acme/widget')
    expect(r.out).toContain('not running')
    expect(r.out).toContain('acme-app[bot]')
    expect(r.out).toContain('build')
    // The credential is what actually breaks in service, so its absence has to
    // read as a cause rather than a blank field.
    expect(r.out).toContain('absent')
  })

  test('runs without a settings file at all', () => {
    const r = runRevu(['status'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('revu')
  })
})

describe('output discipline', () => {
  test('emits no escape sequences when it is not writing to a terminal', () => {
    // A bot login renders as `name[bot]`, so looking for a bare `[` would pass
    // for entirely the wrong reason. Match the escape introducer itself, and put
    // a bracket in the output deliberately so the test would notice its absence.
    const p = makePrefix('REVU_BOT_LOGIN="acme-app[bot]"\n')
    const r = runRevu(['status'], { prefix: p })
    rmSync(p, { recursive: true, force: true })
    expect(r.out).toContain('acme-app[bot]')
    expect(r.out.includes(String.fromCharCode(27))).toBe(false)
  })

  test('--help describes the command without doing anything', () => {
    const r = runRevu(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('revu status')
    expect(r.out).toContain('REVU_ACCESS_HINT')
    // The header is the help text; it must not leak the shell that follows it.
    expect(r.out).not.toContain('set -euo')
  })
})

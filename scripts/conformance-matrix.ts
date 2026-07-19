/**
 * The conformance-matrix release gate: runs the SAME shared `RevuApi`
 * conformance suite across every transport leg and reports one pass/fail line
 * per leg, exiting non-zero if any REQUIRED leg fails.
 *
 * The assertions are NOT duplicated here. Each in-gate leg points at a
 * `*.test.ts` runner that calls `runConformanceSuite` from
 * `@revu/shared/conformance`; this script spawns `bun test <runner>` with the
 * JUnit reporter and reads the run's `tests`/`failures` totals back out of the
 * report XML. So there is exactly one copy of the contract assertions, held to
 * over both transports, and this file only orchestrates and summarizes.
 *
 * The four legs:
 *   A (required, in-gate): the in-process mock adapter.
 *   B (required, in-gate): revud serving the mock store over real HTTP — the
 *      runner spawns revud in mock mode against a STUB dist + a temp data dir,
 *      so it is hermetic on a fresh checkout where the frontend is not built and
 *      never touches the real build.
 *   C (optional, live): direct mode against the scratch repo. Runs only when a
 *      GitHub token (`GH_TOKEN`/`GITHUB_TOKEN`) is present; the scratch repo is
 *      refreshed via `scripts/seed-scratch.ts` first. When the token is absent
 *      it is SKIPPED with a visible reason and does not fail the matrix.
 *   D (optional, live): broker mode against the scratch org. Runs only when its
 *      workspace credential env is present; otherwise SKIPPED with a visible
 *      reason. The live scratch-org run needs a real org with member accounts,
 *      which is stood up during on-prem deployment, so this leg is deferred and
 *      never fails the matrix in the network-free gate.
 *
 * Honesty rule: an optional leg that cannot run logs an explicit
 * `skipped: <required secret/env> absent` line. It is NEVER reported as a silent
 * pass, and a live leg whose committed runner is not yet available is reported
 * as skipped-deferred rather than green.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Terminal outcome of one leg. `skipped` never counts against the gate. */
type LegOutcome = 'passed' | 'failed' | 'skipped'

interface LegResult {
  id: string
  name: string
  required: boolean
  outcome: LegOutcome
  /** Passing test count for a leg that ran; null for a skipped leg. */
  tests: number | null
  /** Failing test count for a leg that ran; null for a skipped leg. */
  failures: number | null
  /** Human-readable detail: the skip reason, or an error summary on failure. */
  detail: string
}

/**
 * The first environment variable in `names` that is set to a non-blank value,
 * or null when none is. Trims so an accidental whitespace-only secret in CI is
 * treated as absent rather than silently enabling a live leg.
 */
function firstPresentEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const raw = process.env[name]
    if (raw !== undefined && raw.trim().length > 0) return name
  }
  return null
}

/** Totals read from a JUnit report's root `<testsuites>` element. */
interface JUnitTotals {
  tests: number
  failures: number
}

/**
 * Pull `tests` and `failures` off the root `<testsuites …>` element of a JUnit
 * report. Bun's reporter always emits that single root with both attributes, so
 * a shallow attribute scan is enough and avoids taking an XML-parser dependency
 * into a gate script.
 */
function parseJUnitTotals(xml: string): JUnitTotals | null {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0]
  if (!root) return null
  const num = (attr: string): number | null => {
    const m = new RegExp(`\\b${attr}="(\\d+)"`).exec(root)
    return m ? Number(m[1]) : null
  }
  const tests = num('tests')
  const failures = num('failures')
  if (tests === null || failures === null) return null
  return { tests, failures }
}

/**
 * Run one conformance runner file under `bun test` with the JUnit reporter and
 * fold the result into a `LegResult`. The runner owns all of its own process
 * setup (a mock store reset, or spawning revud against a stub dist + temp data
 * dir); this only invokes it and reads the totals back.
 */
function runSuiteLeg(leg: { id: string; name: string; required: boolean; testFile: string }): LegResult {
  const outfile = join(mkdtempSync(join(tmpdir(), 'revu-conf-matrix-')), 'report.xml')
  const abs = join(REPO_ROOT, leg.testFile)
  if (!existsSync(abs)) {
    return {
      id: leg.id,
      name: leg.name,
      required: leg.required,
      outcome: 'failed',
      tests: null,
      failures: null,
      detail: `runner not found: ${leg.testFile}`,
    }
  }

  const proc = spawnSync(
    'bun',
    ['test', abs, '--reporter=junit', `--reporter-outfile=${outfile}`],
    { cwd: REPO_ROOT, encoding: 'utf8', env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
  )

  let totals: JUnitTotals | null = null
  try {
    totals = parseJUnitTotals(readFileSync(outfile, 'utf8'))
  } catch {
    totals = null
  } finally {
    rmSync(dirname(outfile), { recursive: true, force: true })
  }

  // The process exit code is the source of truth for pass/fail; the parsed
  // totals annotate the summary. A zero exit with unreadable totals is still a
  // pass (the run completed), just reported without counts.
  const passed = proc.status === 0
  const failures = totals?.failures ?? (passed ? 0 : null)
  return {
    id: leg.id,
    name: leg.name,
    required: leg.required,
    outcome: passed ? 'passed' : 'failed',
    tests: totals?.tests ?? null,
    failures,
    detail: passed
      ? 'shared conformance suite green'
      : `bun test exited ${proc.status ?? 'signal'}${totals ? ` (${totals.failures} failing)` : ''}`,
  }
}

/** A skipped optional leg with a visible, non-silent reason. */
function skip(id: string, name: string, reason: string): LegResult {
  return { id, name, required: false, outcome: 'skipped', tests: null, failures: null, detail: reason }
}

/**
 * Leg C — direct mode vs the scratch repo. Live: it needs a GitHub token to
 * talk to real GitHub and refreshes the scratch repo via `seed-scratch.ts`
 * first. Absent-token is the in-gate case and skips with a visible reason.
 *
 * The live run itself needs member accounts on the scratch org and is stood up
 * during on-prem deployment, so no live conformance runner is committed yet;
 * when a token IS present this leg refreshes the fixture and then reports
 * skipped-deferred rather than a silent pass, so a future live runner has a
 * seeded target and the gate never claims a run that did not happen.
 */
function runDirectLiveLeg(): LegResult {
  const id = 'C'
  const name = 'direct mode vs scratch repo (live)'
  const tokenVar = firstPresentEnv(['GH_TOKEN', 'GITHUB_TOKEN'])
  if (!tokenVar) {
    return skip(id, name, 'skipped: GH_TOKEN/GITHUB_TOKEN absent — live scratch-repo leg not run')
  }

  console.log(`[${id}] refreshing the scratch repo via scripts/seed-scratch.ts …`)
  const seed = spawnSync('bun', ['run', join(REPO_ROOT, 'scripts', 'seed-scratch.ts')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (seed.status !== 0) {
    return skip(id, name, `skipped: seed-scratch failed (exit ${seed.status ?? 'signal'}) — live leg not run`)
  }

  const liveRunner = join(REPO_ROOT, 'packages', 'revud', 'src', 'direct', 'conformance-live.test.ts')
  if (!existsSync(liveRunner)) {
    return skip(
      id,
      name,
      'skipped-deferred: scratch refreshed, but the live direct conformance runner is not committed (on-prem deployment work)',
    )
  }
  return runSuiteLeg({ id, name, required: false, testFile: 'packages/revud/src/direct/conformance-live.test.ts' })
}

/**
 * Leg D — broker mode vs the scratch org. Live: it needs the disposable
 * workspace's injected credential + sandbox clone, surfaced via
 * `REVU_CREDENTIALS_FILE` / `REVU_SANDBOX_DIR`. That environment only exists on
 * a provisioned on-prem host with a real org, so this leg is deferred: absent
 * env skips with a visible reason and never fails the matrix.
 */
function runBrokerLiveLeg(): LegResult {
  const id = 'D'
  const name = 'broker mode vs scratch org (live)'
  const credVar = firstPresentEnv(['REVU_CREDENTIALS_FILE'])
  const sandboxVar = firstPresentEnv(['REVU_SANDBOX_DIR'])
  if (!credVar || !sandboxVar) {
    const missing = [credVar ? null : 'REVU_CREDENTIALS_FILE', sandboxVar ? null : 'REVU_SANDBOX_DIR']
      .filter((v): v is string => v !== null)
      .join(' + ')
    return skip(id, name, `skipped: ${missing} absent — broker leg deferred to on-prem, not run`)
  }

  const liveRunner = join(REPO_ROOT, 'packages', 'revud', 'src', 'broker', 'conformance-live.test.ts')
  if (!existsSync(liveRunner)) {
    return skip(
      id,
      name,
      'skipped-deferred: broker env present, but the live broker conformance runner is not committed (on-prem deployment work)',
    )
  }
  return runSuiteLeg({ id, name, required: false, testFile: 'packages/revud/src/broker/conformance-live.test.ts' })
}

function main(): void {
  console.log('conformance matrix — running the shared RevuApi suite across every leg\n')

  const results: LegResult[] = []

  // Leg A: in-process mock. Required, in-gate.
  results.push(
    runSuiteLeg({
      id: 'A',
      name: 'mock in-process',
      required: true,
      testFile: 'packages/app/src/api/mock/conformance.test.ts',
    }),
  )

  // Leg B: revud-mock over real HTTP. Required, in-gate. The runner spawns revud
  // in mock mode against a stub dist + temp data dir, so it is hermetic.
  results.push(
    runSuiteLeg({
      id: 'B',
      name: 'revud-mock over HTTP',
      required: true,
      testFile: 'packages/app/src/api/http/conformance.test.ts',
    }),
  )

  // Legs C + D: live, optional, gated on their secret/env being present.
  results.push(runDirectLiveLeg())
  results.push(runBrokerLiveLeg())

  console.log('\nconformance matrix summary')
  console.log('──────────────────────────')
  for (const r of results) {
    const mark = r.outcome === 'passed' ? 'PASS' : r.outcome === 'failed' ? 'FAIL' : 'SKIP'
    const gate = r.required ? 'required' : 'optional'
    const counts = r.tests !== null ? ` (${r.tests} tests, ${r.failures ?? 0} failing)` : ''
    console.log(`  [${r.id}] ${mark}  ${r.name} — ${gate}${counts}`)
    console.log(`        ${r.detail}`)
  }

  const requiredFailed = results.filter((r) => r.required && r.outcome !== 'passed')
  console.log('')
  if (requiredFailed.length > 0) {
    const names = requiredFailed.map((r) => r.id).join(', ')
    console.error(`conformance matrix FAILED — required leg(s) not green: ${names}`)
    process.exit(1)
  }
  console.log('conformance matrix PASSED — all required legs green.')
}

main()

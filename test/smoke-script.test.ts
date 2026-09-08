/**
 * The headless smoke script still runs, and still passes, against the current
 * mock adapter and fixtures.
 *
 * That script is a hand-rolled walk over every fixture scenario the UI depends
 * on, run with `bun run scripts/smoke.ts`. It is not a `bun test` file: it owns
 * its own browser-global shims, its own `check(...)` reporter and its own exit
 * code, and nothing in the test suite imports it. So it is invisible to the
 * gate — it can be broken by an ordinary fixture change for weeks without a
 * single red run, and the person who broke it is the least likely to notice,
 * because they had no reason to invoke a script that lives outside the runner.
 *
 * Running it as a child process is the whole point rather than an
 * implementation detail. The script's contract IS its exit code, and reaching
 * that contract requires the shims it installs at module scope, the dynamic
 * imports it performs afterwards, and the `process.exit` it ends on — none of
 * which survive being imported into a runner that already has globals of its
 * own and cannot be allowed to exit. A child process reproduces the exact
 * invocation a developer types.
 *
 * A failure carries the tail of the script's own output, because the script
 * reports which check failed and this file cannot know: without it a red here
 * would say only that some number other than zero came back, and the reader
 * would have to re-run the script by hand to learn anything at all.
 *
 * The budget is generous because the walk drives real fixture syncs and durable
 * store writes through a cold `bun` start, which is bound by the machine rather
 * than by the code under test.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

/** The script under test, named as the invocation a developer would type. */
const SCRIPT = 'scripts/smoke.ts'

/** The line the script prints only when every one of its checks passed. */
const SUCCESS_BANNER = 'ALL CHECKS PASSED'

/** How much of the child's output a failure carries — enough to hold the FAIL lines. */
const TAIL_CHARS = 6000

/** Every check the script printed, both streams, most recent last. */
function tailOf(stdout: Uint8Array, stderr: Uint8Array): string {
  const decoder = new TextDecoder()
  const combined = `${decoder.decode(stdout)}\n${decoder.decode(stderr)}`
  return combined.length > TAIL_CHARS ? combined.slice(-TAIL_CHARS) : combined
}

describe('the headless smoke script', () => {
  test(
    'exits zero against the current mock adapter and fixtures',
    () => {
      const run = Bun.spawnSync(['bun', 'run', SCRIPT], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const tail = tailOf(run.stdout, run.stderr)

      // The tail rides along on both sides so a red prints the script's own
      // FAIL lines instead of a bare number; the exit code is what is pinned.
      expect([run.exitCode, tail]).toEqual([0, tail])
      // The exit code alone would also be zero for a script that stopped
      // before running a single check, so the banner is what proves the walk
      // reached its end.
      expect([tail.includes(SUCCESS_BANNER), tail]).toEqual([true, tail])
    },
    60_000,
  )
})

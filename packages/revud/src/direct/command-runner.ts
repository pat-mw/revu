/**
 * The injectable seam for running external commands (`git`, `gh`). Direct mode
 * shells out to read git config, the origin remote, and the GitHub token; a
 * `CommandRunner` is the one place that touches a real subprocess, so every unit
 * test injects a fake and nothing spawns a process or reaches the network.
 *
 * The result deliberately separates a clean exit from a failure: `ok` reflects a
 * zero exit code, and `stdout`/`stderr` are captured whole. Callers decide what a
 * non-zero exit means (an absent config value, an unauthenticated `gh`), so this
 * layer never throws for a non-zero exit — it reports it.
 */

export interface CommandResult {
  /** True when the process exited with code 0. */
  ok: boolean
  /** The process exit code (or a negative sentinel when it could not be spawned). */
  code: number
  /** Captured standard output, decoded as UTF-8. Never trimmed here. */
  stdout: string
  /** Captured standard error, decoded as UTF-8. Never trimmed here. */
  stderr: string
}

/**
 * Runs one external command and resolves its captured result. `args[0]` is the
 * executable and the rest are literal arguments — no shell, so no interpolation
 * and nothing to quote or escape. An implementation must never throw for a
 * non-zero exit; it reports it via `ok`/`code`. It MAY reject only when the
 * executable itself cannot be located or spawned.
 */
export interface CommandRunner {
  run(args: string[], opts?: { cwd?: string }): Promise<CommandResult>
}

/**
 * The production `CommandRunner`, backed by `Bun.spawn`. Captures stdout/stderr,
 * waits for exit, and maps a spawn failure (executable not found) to a result
 * with a negative code and the error text on `stderr` rather than a reject, so a
 * missing `gh` or `git` is handled by the same non-zero-exit path callers already
 * use for an unauthenticated tool.
 */
export function createBunCommandRunner(): CommandRunner {
  return {
    async run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      try {
        const proc = Bun.spawn(args, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { ok: code === 0, code, stdout, stderr }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code: -1, stdout: '', stderr: message }
      }
    },
  }
}

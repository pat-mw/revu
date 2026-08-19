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

/** Options one invocation may carry. */
export interface CommandOptions {
  /** The working directory to spawn in. Always passed explicitly, never assumed. */
  cwd?: string
  /**
   * Bytes to write to the process's standard input, which is then closed. A
   * command reading its work from stdin keeps that work out of the argv, where
   * git's option parser would still be running — so a value that must not be
   * mistaken for a flag has somewhere safe to travel. It is also the only way
   * to reach the batch forms of git's plumbing, whose whole value is that a
   * batch either applies completely or not at all.
   *
   * Omitted means the child gets no stdin rather than the parent's, so a
   * command that unexpectedly reads from it fails instead of hanging on a
   * terminal the daemon does not own.
   */
  stdin?: string
}

/**
 * Runs one external command and resolves its captured result. `args[0]` is the
 * executable and the rest are literal arguments — no shell, so no interpolation
 * and nothing to quote or escape. An implementation must never throw for a
 * non-zero exit; it reports it via `ok`/`code`. It MAY reject only when the
 * executable itself cannot be located or spawned.
 */
export interface CommandRunner {
  run(args: string[], opts?: CommandOptions): Promise<CommandResult>
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
    async run(args: string[], opts?: CommandOptions): Promise<CommandResult> {
      try {
        const proc = Bun.spawn(args, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          // A string here is written to the child and the pipe is then closed,
          // so a command waiting on end-of-input proceeds. Without the key the
          // child gets no stdin at all, which is what keeps a command that
          // reads it unexpectedly from blocking forever.
          ...(opts?.stdin !== undefined
            ? { stdin: new TextEncoder().encode(opts.stdin) }
            : {}),
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

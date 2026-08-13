/**
 * Pure, syntactic ref-name validation — no subprocess, no filesystem.
 *
 * Ref names arrive over HTTP and end up as git command arguments. The command
 * runner takes an argv array (no shell), so shell injection is impossible, but
 * a name beginning with `-` would be read by git as a FLAG — an option-injection
 * vector — and git itself rejects a further set of shapes. This module is the
 * first-pass filter both the client and the server import; a server that
 * shells out to git must still run `git check-ref-format` as the final
 * authority, because a handful of rules (e.g. reflog-dependent ones) are not
 * checkable syntactically.
 *
 * `@revu/shared` is dependency-free by design and has no `node:child_process`,
 * which is why the subprocess half cannot live here.
 */

/** Characters git forbids anywhere in a ref name. */
const FORBIDDEN_CHARS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\'])

/**
 * Whether `ref` is syntactically acceptable as a git ref name, per the rules of
 * `git check-ref-format` that are checkable without a subprocess, plus the
 * leading-dash rejection that closes the option-injection vector:
 *
 * - non-empty, not the single character `@`, and not beginning with `-`
 * - no `..`, no `@{`, no ASCII control characters, and none of the characters
 *   space `~` `^` `:` `?` `*` `[` `\`
 * - no leading, trailing, or consecutive `/`, and no trailing `.`
 * - no slash-separated component beginning with `.` or ending with `.lock`
 *
 * Accepts both bare branch names (`feature/x`) and fully qualified refs
 * (`refs/heads/feature/x`, `refs/remotes/origin/main`).
 */
export function isValidRefName(ref: string): boolean {
  if (ref === '' || ref === '@') return false
  if (ref.startsWith('-')) return false
  if (ref.startsWith('/') || ref.endsWith('/')) return false
  if (ref.endsWith('.')) return false
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false
  for (const ch of ref) {
    const code = ch.codePointAt(0) as number
    if (code < 0x20 || code === 0x7f) return false
    if (FORBIDDEN_CHARS.has(ch)) return false
  }
  for (const component of ref.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) return false
  }
  return true
}

/**
 * Qualify a bare branch name under `refs/heads/`; a name already under `refs/`
 * passes through unchanged. Purely mechanical — it does NOT validate, so run
 * `isValidRefName` on the input first.
 *
 * A bare name is always treated as a LOCAL branch. A remote-tracking ref must
 * arrive fully qualified (`refs/remotes/origin/main`) — a bare `origin/main`
 * is indistinguishable from a local branch literally named `origin/main`,
 * which is why `BranchRef.ref` carries the fully qualified form.
 */
export function normalizeRefName(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
}

/**
 * The scratch repository the live smoke scripts act against.
 *
 * Every live smoke performs REAL operations on GitHub, and several of them are
 * mutating: they leave review comments, post and delete bot comments, and move
 * a fixture branch. Aiming one at the wrong repository is therefore not a
 * harmless no-op, so the target is never inferred and never defaulted — it is
 * named explicitly by `REVU_SMOKE_REPO` and validated before any network call.
 *
 *   REVU_SMOKE_REPO=owner/name bun run scripts/smoke-direct.ts
 *
 * An unset, malformed, or unmarked value aborts with exit code 2 (a usage
 * error) and a message naming the variable. There is deliberately no fallback:
 * a default would let a typo or a forgotten export point a mutating run at a
 * repository the operator never named, which is exactly the accident this
 * resolver exists to prevent.
 */
import { parseRepoOverride } from '../packages/revud/src/direct/repo'
import type { RepoRef } from '../packages/revud/src/direct/repo'

/** The one variable that names the smoke target. Required; it has no default. */
export const SMOKE_REPO_ENV = 'REVU_SMOKE_REPO'

/**
 * Substrings that mark a repository name as an intended scratch target. The
 * smokes only ever run against a repository the fixture seeder has populated,
 * and the seeder refuses any name without one of these markers — so requiring
 * the same marker here rejects a real repository without rejecting any target
 * that could legitimately have been seeded.
 */
const SCRATCH_MARKERS = ['sandbox', 'scratch', 'fixture']

/**
 * Resolve the smoke target from the environment, or abort. The returned pair is
 * guaranteed to be a well-formed `owner/name` whose name carries a scratch
 * marker; every other outcome exits non-zero before the caller can act on it.
 */
export function resolveSmokeRepo(): RepoRef {
  const raw = process.env[SMOKE_REPO_ENV]
  if (raw === undefined || raw.trim().length === 0) {
    abort(
      `${SMOKE_REPO_ENV} is not set.\n` +
        `  Name the scratch repository this smoke acts against, as "owner/name":\n` +
        `    ${SMOKE_REPO_ENV}=owner/name bun run scripts/<smoke-script>.ts\n` +
        '  There is no default. These scripts write to whatever they are pointed at,\n' +
        '  so the target is always named explicitly rather than assumed.',
    )
  }

  const parsed = parseRepoOverride(raw)
  if (parsed === null) {
    abort(
      `${SMOKE_REPO_ENV}=${JSON.stringify(raw)} is not a valid repository reference.\n` +
        '  Expected exactly "owner/name" — two non-empty segments of letters, digits,\n' +
        '  ".", "_" or "-" (a trailing ".git" is tolerated). A full URL is not accepted.',
    )
  }

  const name = parsed.repo.toLowerCase()
  if (!SCRATCH_MARKERS.some((marker) => name.includes(marker))) {
    abort(
      `refusing to smoke ${parsed.owner}/${parsed.repo}: the name carries no scratch marker.\n` +
        `  The repository name must contain one of: ${SCRATCH_MARKERS.join(', ')}.\n` +
        '  These scripts mutate their target, so an unmarked name is treated as a mistake\n' +
        '  rather than an instruction.',
    )
  }

  return parsed
}

/** Print an actionable configuration error and exit 2 (bad usage). */
function abort(message: string): never {
  console.error(`\nsmoke target: ${message}`)
  process.exit(2)
}

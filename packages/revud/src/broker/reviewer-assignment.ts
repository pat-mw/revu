import { readFileSync } from 'node:fs'

/**
 * The broker's host-side reviewer-assignment record: which humans a lead has
 * assigned to each pull request, and the github-login → `Human.id` map.
 *
 * GitHub only ever sees the shared bot as the reviewer on a broker-mediated PR,
 * so "who is assigned to review this" cannot live on GitHub — it lives in a
 * host-side YAML file the lead edits, read here and surfaced in the poll meta as
 * `assignedReviewerHumanIds`. The file sits alongside the SQLite store (under the
 * data dir) so it survives a workspace rebuild, and is re-read on every poll tick
 * so a lead's edit takes effect without a restart.
 *
 * The loader IS the record: there is deliberately NO in-workspace mutation API.
 * The broker has no authenticated admin surface, so an admin endpoint that could
 * rewrite assignments is out of scope — the lead's edit to the YAML file on the
 * host is the one source of truth, and this module only reads it.
 *
 * The file is parsed with the runtime's real YAML parser (`Bun.YAML.parse`), so
 * quoted scalars, real block lists, and comments are handled correctly; this
 * module only VALIDATES the parsed shape into the two known sections. A real
 * parser also fixes a class of silent-corruption bugs a hand-rolled line reader
 * had (a mis-tokenized bracketed list, a coerced exotic key, a dropped quoted
 * value).
 *
 * Resilience: a read failure, a YAML syntax error, or an unrecognized shape KEEPS
 * the last-good map and logs a token-free warning rather than crashing the poll
 * loop or blanking assignments. The warning NEVER echoes the file's bytes — a
 * YAML error can quote a line a lead mispasted a secret into — so only the file
 * path and a generic reason appear. A non-empty file that parses to neither known
 * section (a likely typo / mis-indent) keeps last-good instead of silently
 * blanking; an intentionally-present-but-empty section (`assignments:` with no
 * children) is honored as the lead clearing that section.
 *
 * File format (a fixed two-section shape):
 *
 *   humans:
 *     octocat: h-priya      # github login -> Human.id
 *     hubot: h-marcus
 *   assignments:
 *     347: [h-priya]        # pr number -> [assigned Human.id ...]
 *     355: [h-priya, h-marcus]
 */

/** The parsed record: PR-number → assigned human ids, and github-login → human id. */
interface ReviewerRecord {
  /** PR number → the human ids assigned to review it. */
  assignments: Map<number, string[]>
  /** Lowercased github login → `Human.id`. The future collector seam reuses this. */
  humans: Map<string, string>
}

/** The query surface the poll loop reads through; `load()` re-reads the file. */
export interface ReviewerAssignments {
  /**
   * The human ids assigned to review a PR, or `[]` when none are (or the PR is
   * absent). A fresh array each call, so a caller cannot mutate the cached map.
   */
  assignmentsFor(pr: number): string[]
  /**
   * The `Human.id` a github login maps to, or `undefined` when the login is not
   * in the humans map. The lookup is case-insensitive on the login. This is the
   * seam the future host-side collector reuses to attribute a bot-mediated PR's
   * real opener.
   */
  humanForLogin(login: string): string | undefined
  /**
   * Re-read the file, replacing the in-memory record on success. On a read or
   * parse failure the last-good record is KEPT and a token-free warning is
   * logged (the file bytes are never echoed). Safe to call every poll tick.
   */
  load(): void
}

/**
 * An empty record — what a never-loaded (or first-load-failed) map answers with:
 * no assignments, no login mapping.
 */
function emptyRecord(): ReviewerRecord {
  return { assignments: new Map(), humans: new Map() }
}

/**
 * A parse outcome the loader acts on. A `ReviewerRecord` REPLACES the in-memory
 * record; `'keep-last-good'` signals a warn-and-keep (a non-empty file that
 * parses to a shape with neither known section — a likely typo/mis-indent that
 * must NOT silently blank live assignments).
 */
type ParseOutcome = ReviewerRecord | 'keep-last-good'

/**
 * Is `value` a plain object (a YAML mapping), not an array or a scalar? Only a
 * mapping can carry the `humans` / `assignments` sections.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one assignment VALUE into a list of trimmed non-empty human ids. A
 * real YAML list (`- h-priya`) arrives as an array; a bare scalar (`h-priya`)
 * arrives as a string and records one human; an empty/`null` value (the lead
 * cleared this PR's reviewers) is an empty list. A non-string list entry (a
 * number, a nested map) is dropped rather than coerced.
 */
function normalizeAssignmentValue(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/**
 * Validate the parsed YAML into a `ReviewerRecord`, or decide the load must keep
 * its last-good record. Uses a real YAML parser upstream, so it only has to
 * validate the SHAPE — never re-tokenize bytes:
 *
 *   - An empty document (`null` — a blank / comment-only file) is the honest "no
 *     reviewers configured yet" state: an empty record (no assignments, no map).
 *   - A NON-EMPTY document that is not a mapping, or a mapping with NEITHER a
 *     `humans` NOR an `assignments` key, is a likely typo / mis-indent (e.g. a
 *     miscapitalized `Assignments:` parks the real data under an unknown key).
 *     That returns `'keep-last-good'` so a silent full blank cannot happen.
 *   - A mapping WITH at least one known section is honored as authoritative,
 *     INCLUDING a `humans:` / `assignments:` present-but-empty (value `null`),
 *     which is the lead intentionally clearing that section.
 *
 * `humans` must be a map<login, Human.id> (login lowercased; a non-string id is
 * dropped). `assignments` PR keys are validated with a STRICT decimal check
 * (`/^\d+$/`): a non-decimal key (a quoted `"0x1f"`, a float, garbage) makes the
 * WHOLE load keep last-good with a token-free warning — the file is malformed, so
 * it never partially applies (and never routes a bad key to a wrong PR), just as
 * any other validation failure keeps the last-good map intact.
 */
function validateReviewerRecord(
  parsed: unknown,
  warn: (reason: string) => void,
): ParseOutcome {
  // A blank or comment-only file parses to null: the "no reviewers yet" default.
  if (parsed === null || parsed === undefined) return emptyRecord()

  if (!isMapping(parsed)) {
    // A bare scalar or a top-level list is not the two-section shape at all.
    return 'keep-last-good'
  }

  const hasHumans = Object.prototype.hasOwnProperty.call(parsed, 'humans')
  const hasAssignments = Object.prototype.hasOwnProperty.call(parsed, 'assignments')
  if (!hasHumans && !hasAssignments) {
    // A non-empty mapping with neither known key — a probable typo/mis-indent.
    return 'keep-last-good'
  }

  const record = emptyRecord()

  if (hasHumans && parsed.humans !== null && parsed.humans !== undefined) {
    if (!isMapping(parsed.humans)) {
      warn('the "humans" section is not a login → id mapping')
      return 'keep-last-good'
    }
    for (const [login, id] of Object.entries(parsed.humans)) {
      // A non-string id (a number, a nested map) is not a Human.id — skip it.
      if (typeof id === 'string' && id.trim().length > 0) {
        record.humans.set(login.toLowerCase(), id.trim())
      }
    }
  }

  if (hasAssignments && parsed.assignments !== null && parsed.assignments !== undefined) {
    if (!isMapping(parsed.assignments)) {
      warn('the "assignments" section is not a PR → reviewers mapping')
      return 'keep-last-good'
    }
    for (const [key, value] of Object.entries(parsed.assignments)) {
      // A strict decimal key only. YAML may present an integer key as its decimal
      // string (e.g. an unquoted `007` → `"7"`); a NON-decimal key (a quoted
      // `"0x1f"`, a float `"3.0"`, or garbage) makes the whole load keep last-good
      // — the file is malformed, so nothing partially applies and no bad key is
      // ever routed to a wrong PR. The warning names no key, so no bytes leak.
      if (!/^\d+$/.test(key) || Number(key) <= 0) {
        warn('an assignments key is not a decimal PR number')
        return 'keep-last-good'
      }
      record.assignments.set(Number(key), normalizeAssignmentValue(value))
    }
  }

  return record
}

/**
 * Build the reviewer-assignment surface over a file path. The file is NOT read at
 * construction — call `load()` (the poll loop calls it each tick) to read it.
 * Until the first successful load the record is empty (no assignments, no login
 * map), which is the correct default for a deployment with no reviewers file yet.
 *
 * `log` defaults to `console.warn`; tests inject a capture to assert the warning
 * is token-free.
 */
export function createReviewerAssignments(
  path: string,
  log: (message: string) => void = console.warn,
): ReviewerAssignments {
  let record: ReviewerRecord = emptyRecord()

  function load(): void {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      // An absent file is the normal "no reviewers configured yet" state, not an
      // error worth warning about — keep the empty/last-good record silently.
      // Any OTHER read failure (permissions, a directory in the way) warns with
      // the errno mnemonic only, never the file contents.
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') {
        log(`revud: could not read reviewers file at ${path} (${code ?? 'read error'}); keeping the last-good assignments`)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = Bun.YAML.parse(text)
    } catch {
      // A YAML syntax error keeps the last-good record. The warning carries only
      // the path — NEVER the parser's message or the file bytes, since a YAML
      // error can quote the offending line (which a lead may have mispasted a
      // secret into). A generic reason is logged instead.
      log(`revud: could not parse reviewers file at ${path} (invalid YAML); keeping the last-good assignments`)
      return
    }

    // A local flag so a validation warning fires exactly once per load with a
    // token-free reason (the validator never receives or echoes file bytes).
    let warned = false
    const warn = (reason: string): void => {
      warned = true
      log(`revud: reviewers file at ${path} — ${reason}; keeping the last-good assignments`)
    }
    const outcome = validateReviewerRecord(parsed, warn)
    if (outcome === 'keep-last-good') {
      // A non-empty file whose shape is unrecognized (neither known section, or a
      // section of the wrong type): keep the last-good record rather than silently
      // blanking live assignments. Warn once, token-free, if not already warned by
      // a section-type check above.
      if (!warned) {
        log(`revud: reviewers file at ${path} has neither a "humans" nor an "assignments" section; keeping the last-good assignments`)
      }
      return
    }
    // Replace the record only on a fully successful validation, so a partial parse
    // can never leave a half-applied map.
    record = outcome
  }

  return {
    assignmentsFor(pr: number): string[] {
      const ids = record.assignments.get(pr)
      return ids ? [...ids] : []
    },
    humanForLogin(login: string): string | undefined {
      return record.humans.get(login.toLowerCase())
    },
    load,
  }
}

/**
 * Resolve the reviewers file path: `REVU_REVIEWERS_FILE` when set, else
 * `reviewers.yaml` under the data dir (alongside the SQLite store, so it survives
 * a workspace rebuild). `dataDir` is the already-resolved data directory.
 */
export function resolveReviewersFile(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.REVU_REVIEWERS_FILE
  if (override && override.length > 0) return override
  return `${dataDir}/reviewers.yaml`
}

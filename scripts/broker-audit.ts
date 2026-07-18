/**
 * Operator CLI: export the host store's audit journal — the authoritative
 * provenance record of every revu-mediated write (which human, by binding
 * email; which workspace = coder.owner; which endpoint; which PR; the
 * GitHub-assigned id; when) — for a client or compliance conversation.
 *
 * Read-only: nothing in the store is created, changed, or removed. The output
 * is a faithful representation of the journal for the query — rows are never
 * dropped, reordered, or deduped — and every rendered field is neutralized
 * against hostile content (CSV formula injection, table-breaking control
 * characters) without altering which rows appear.
 *
 * Configuration is by environment:
 *   REVU_OWNER_MAP_FILE   path to the JSON owner map (coder.owner -> { email, displayName? })
 *   REVU_HOST_DATA_DIR    optional host-store data dir override (else the XDG default)
 *
 * Usage: bun run scripts/broker-audit.ts [--owner <coder.owner>] [--pr <n>]
 *                                        [--since <ISO-8601 UTC>] [--format <table|json|csv>]
 *
 *   --owner   scope to one human, resolved through the identity binding
 *             (default: the all-humans union)
 *   --pr      narrow to one pull request (positive integer)
 *   --since   narrow to rows created at or after this instant, inclusive —
 *             a full ISO-8601 UTC timestamp or a YYYY-MM-DD date
 *   --format  table (default), json, or csv
 *
 * Exit codes: 0 success (including an empty result), 1 configuration or
 * unbound-owner or store failure, 2 bad usage. Errors print a message, never
 * a stack trace.
 */
import type { AuditExportFormat } from '../packages/revud/src/collector/audit-export'
import {
  canonicalizeSinceBound,
  exportAudit,
  formatAudit,
} from '../packages/revud/src/collector/audit-export'
import { OwnerMapConfigError, openHostStoreFromEnv } from '../packages/revud/src/collector/config'
import { UnboundOwnerError } from '../packages/revud/src/collector/host-store'

const USAGE =
  'usage: bun run scripts/broker-audit.ts [--owner <coder.owner>] [--pr <n>] ' +
  '[--since <ISO-8601 UTC>] [--format <table|json|csv>]'

const FORMATS: readonly string[] = ['table', 'json', 'csv']

interface CliArgs {
  owner?: string
  pr?: number
  since?: string
  format: AuditExportFormat
}

function parseArgs(argv: readonly string[]): CliArgs | { usageError: string } {
  const args: CliArgs = { format: 'table' }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (flag !== '--owner' && flag !== '--pr' && flag !== '--since' && flag !== '--format') {
      return { usageError: `unknown argument: ${flag}` }
    }
    if (seen.has(flag)) return { usageError: `${flag} given more than once` }
    seen.add(flag)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      return { usageError: `${flag} requires a value` }
    }
    if (flag === '--owner') {
      const owner = value.trim()
      if (owner.length === 0) return { usageError: '--owner requires a non-empty coder.owner' }
      args.owner = owner
    } else if (flag === '--pr') {
      const pr = Number(value)
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(pr) || pr <= 0) {
        return { usageError: '--pr must be a positive integer' }
      }
      args.pr = pr
    } else if (flag === '--since') {
      // Canonicalize the bound to the store's millisecond-precision form so a
      // whole-second bound still includes a row landed exactly at it; `null`
      // means an unacceptable or impossible instant.
      const canonical = canonicalizeSinceBound(value)
      if (canonical === null) {
        return {
          usageError:
            '--since must be an ISO-8601 UTC instant (e.g. 2026-07-01T00:00:00Z) or a YYYY-MM-DD date',
        }
      }
      args.since = canonical
    } else {
      if (!FORMATS.includes(value)) {
        return { usageError: '--format must be one of: table, json, csv' }
      }
      args.format = value as AuditExportFormat
    }
  }
  return args
}

const parsed = parseArgs(process.argv.slice(2))
if ('usageError' in parsed) {
  console.error(parsed.usageError)
  console.error(USAGE)
  process.exit(2)
}

try {
  const store = openHostStoreFromEnv()
  try {
    const rows = exportAudit(store, {
      coderOwner: parsed.owner,
      pr: parsed.pr,
      sinceIso: parsed.since,
    })
    console.log(formatAudit(rows, parsed.format))
  } finally {
    store.close()
  }
} catch (err) {
  if (err instanceof OwnerMapConfigError || err instanceof UnboundOwnerError) {
    // Both carry self-contained operator messages (no file content, no row
    // contents) — print the message, not a stack trace.
    console.error(err.message)
    process.exit(1)
  }
  // Anything else is unexpected: name the error class only. Its message or
  // stack could carry store content, and this output may be pasted into a
  // client-facing thread.
  const name = err instanceof Error ? err.name : typeof err
  console.error(`audit export failed (${name}). Check REVU_HOST_DATA_DIR and the host store.`)
  process.exit(1)
}

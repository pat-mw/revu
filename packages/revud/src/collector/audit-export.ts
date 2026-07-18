import type { AuditEntry } from '../direct/store'
import type { HostStore } from './host-store'

/**
 * Read-only export over the host store's audit journal: the operator-facing
 * compliance view of every revu-mediated write (which human, by binding email;
 * which workspace; which endpoint; which PR; the GitHub-assigned id; when).
 *
 * FAITHFUL REPRESENTATION is the core contract. The export never drops,
 * reorders, or dedups rows: a client relies on this being the complete journal
 * for the query, and an omission could hide a bypass. `exportAudit` returns
 * exactly what the store's audit reads return, in store order (oldest →
 * newest); `formatAudit` renders every entry it is given, one row per entry.
 *
 * HOSTILE FIELD CONTENT. `endpoint` and `createdAt` originate in the
 * workspace's local journal — the host store bounds their length but not
 * their charset — so a row can carry spreadsheet formula triggers
 * (`=HYPERLINK(...)`), delimiters, quotes, control characters, or terminal
 * escape sequences. The renderers therefore treat EVERY field defensively:
 * `csv` quote-escapes and formula-neutralizes every cell so opening the file
 * in a spreadsheet cannot execute anything; `table` replaces control
 * characters so one row cannot break the layout or emit terminal escapes.
 * Neutralization only changes how a value renders, never which rows appear.
 *
 * This is a host-side operator report: the human's email (`human_id`) and
 * `coder.owner` (`workspace`) ARE the audit identity the operator needs, so
 * they appear verbatim. Nothing else (tokens, credentials, row keys beyond
 * the journal fields) enters the output.
 */

export interface AuditExportQuery {
  /**
   * When set, scope to this one human. The value is a channel-authentic
   * `coder.owner` label resolved through the identity binding (an unknown
   * owner throws `UnboundOwnerError` — never an empty result). When absent,
   * the export is the deliberate all-humans union.
   */
  coderOwner?: string
  /** Narrow to rows landed for this pull request. */
  pr?: number
  /** Narrow to rows created at or after this ISO-8601 instant (inclusive; compared as text). */
  sinceIso?: string
}

export type AuditExportFormat = 'table' | 'json' | 'csv'

/**
 * The shape an operator `--since` bound may take: a full ISO-8601 UTC instant
 * (with optional fractional seconds and a mandatory `Z`) or a `YYYY-MM-DD`
 * date. Anything else — local-time offsets, slashes, a bare year — is not a
 * bound that compares correctly against the journal's UTC `created_at`.
 */
const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z)?$/

/**
 * Validate and CANONICALIZE a `--since` bound to the store's canonical
 * millisecond-precision form (`YYYY-MM-DDTHH:mm:ss.sssZ`), so the store's
 * lexicographic `created_at >= bound` compare is exact at the boundary.
 *
 * This matters because stored `created_at` values are ALWAYS millisecond
 * precision, while an operator naturally types a whole-second bound: comparing
 * `'…00.000Z' >= '…00Z'` as text is false (`.` < `Z`), so a row landed exactly
 * at the bound would be silently dropped from a compliance export. Parsing and
 * re-emitting to the canonical form makes the boundary row match. A date-only
 * bound canonicalizes to that day's UTC midnight.
 *
 * Returns the canonical string, or `null` when `raw` is not an acceptable
 * instant. The round-trip guard rejects an impossible calendar date the shape
 * admits (February 30, month 13): some engines roll it over instead of
 * rejecting, which would silently shift the bound.
 */
export function canonicalizeSinceBound(raw: string): string | null {
  const since = raw.trim()
  if (!SINCE_PATTERN.test(since)) return null
  const t = Date.parse(since)
  if (Number.isNaN(t)) return null
  const iso = new Date(t).toISOString()
  if (iso.slice(0, 10) !== since.slice(0, 10)) return null
  // For a full instant the HH:mm:ss fields must survive the round-trip too, so
  // a rolled-over minute or hour is rejected rather than silently accepted.
  if (since.length !== 10 && iso.slice(11, 19) !== since.slice(11, 19)) return null
  return iso
}

/**
 * Read the audit rows matching the query, verbatim and in store order. This
 * is a pure pass-through to the store's two audit reads — owner-scoped
 * (binding-resolved, fail-loud on an unknown owner) or the all-humans union —
 * with the `pr` / `sinceIso` filters handed through unchanged. No row is ever
 * dropped, reordered, or deduped here.
 *
 * `sinceIso` is compared by the store as text against millisecond-precision
 * `created_at` values, so a caller supplying a whole-second bound should pass
 * it through `canonicalizeSinceBound` first, or the boundary row is dropped.
 */
export function exportAudit(store: HostStore, query: AuditExportQuery): AuditEntry[] {
  const filter = { pr: query.pr, sinceIso: query.sinceIso }
  if (query.coderOwner !== undefined) {
    return store.listAuditForOwner(query.coderOwner, filter)
  }
  return store.listAuditUnion(filter)
}

/** Render entries in the requested format. Every entry appears exactly once, in the given order. */
export function formatAudit(entries: readonly AuditEntry[], format: AuditExportFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(entries, null, 2)
    case 'csv':
      return formatCsv(entries)
    case 'table':
      return formatTable(entries)
  }
}

/** CSV column order; field names mirror the store's audit columns. */
const CSV_HEADER = 'github_id,human_id,workspace,endpoint,pr,created_at'

/**
 * A cell needs formula-neutralization when it begins with a spreadsheet formula
 * trigger (`=`, `+`, `-`, `@`) OR with any whitespace. Leading whitespace is
 * included because some importers strip it before evaluating the cell, exposing
 * a following trigger (`" =cmd"`, a leading tab/newline/no-break-space/BOM);
 * neutralizing on any leading whitespace covers every such case at once.
 */
const NEEDS_FORMULA_GUARD = /^[\s=+\-@]/

/**
 * Render one CSV cell injection-safe:
 * 1. If the content begins with a formula trigger or leading whitespace, prefix
 *    a single quote so a spreadsheet renders it as text instead of evaluating
 *    it (a leading `'` is the spreadsheet "treat as literal text" marker and is
 *    not itself displayed).
 * 2. Double every embedded double quote, then wrap the cell in double quotes.
 * Every cell — including numeric ones — goes through this, so a wrong-typed
 * value that ever reached a numeric column still renders inert.
 */
function csvCell(raw: string): string {
  const neutralized = NEEDS_FORMULA_GUARD.test(raw) ? `'${raw}` : raw
  return `"${neutralized.replaceAll('"', '""')}"`
}

function formatCsv(entries: readonly AuditEntry[]): string {
  const lines = [CSV_HEADER]
  for (const e of entries) {
    lines.push(
      [
        csvCell(String(e.githubId)),
        csvCell(e.humanId),
        csvCell(e.workspace),
        csvCell(e.endpoint),
        csvCell(String(e.pr)),
        csvCell(e.createdAt),
      ].join(','),
    )
  }
  return lines.join('\n')
}

/**
 * Replace every control character (C0, DEL, C1) with `?` so a hostile field
 * cannot inject newlines/tabs that break the table layout, nor ANSI escape
 * sequences that restyle or rewrite the operator's terminal. Visible `?`
 * placeholders (rather than silent stripping) keep tampering noticeable.
 */
function tableCell(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) as number
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : ch
  }
  return out
}

/** Table column order: time first, then who/where, then what. */
const TABLE_COLUMNS: readonly { header: string; value: (e: AuditEntry) => string }[] = [
  { header: 'created_at', value: (e) => e.createdAt },
  { header: 'workspace', value: (e) => e.workspace },
  { header: 'human_id', value: (e) => e.humanId },
  { header: 'endpoint', value: (e) => e.endpoint },
  { header: 'pr', value: (e) => String(e.pr) },
  { header: 'github_id', value: (e) => String(e.githubId) },
]

function formatTable(entries: readonly AuditEntry[]): string {
  // An empty result is a real answer ("nothing matched the query") and must
  // read as one — never a bare empty string an operator could mistake for a
  // failed command.
  if (entries.length === 0) return 'no audit rows'
  const rows = entries.map((e) => TABLE_COLUMNS.map((c) => tableCell(c.value(e))))
  const widths = TABLE_COLUMNS.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => r[i].length)),
  )
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd()
  const lines = [
    render(TABLE_COLUMNS.map((c) => c.header)),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(render),
    `${entries.length} audit ${entries.length === 1 ? 'row' : 'rows'}`,
  ]
  return lines.join('\n')
}

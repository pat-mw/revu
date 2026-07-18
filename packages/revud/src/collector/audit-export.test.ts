/**
 * Audit export over the host store: these tests run against a real in-memory
 * host store with a real binding, landing rows through `landAudit` exactly as
 * the collector does. They pin the two security-critical contracts: faithful
 * representation (every matching row appears, in store order — nothing
 * dropped, reordered, or deduped) and hostile-field neutralization (a
 * workspace-authored `endpoint`/`createdAt` cannot become a spreadsheet
 * formula in the CSV or break the table layout).
 */
import { describe, expect, test } from 'bun:test'
import type { AuditEntry } from '../direct/store'
import { canonicalizeSinceBound, exportAudit, formatAudit } from './audit-export'
import { openHostStore, UnboundOwnerError, type HostStore } from './host-store'
import { createMapCoderOwnerResolver } from './identity-binding'

const resolver = createMapCoderOwnerResolver({
  alice: { email: 'alice@corp.com' },
  bob: { email: 'bob@corp.com' },
})

function open(): HostStore {
  return openHostStore({ resolver, dataDir: ':memory:' })
}

/**
 * A pulled journal entry. The identity fields are deliberately junk: landing
 * discards them and re-keys to the binding, so the export must show binding
 * identity, never these.
 */
function pulled(over: Partial<AuditEntry>): AuditEntry {
  return {
    githubId: 9001,
    humanId: 'claimed@spoof.example',
    workspace: 'claimed-workspace',
    endpoint: 'submitReview',
    pr: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'
const T4 = '2026-01-04T00:00:00.000Z'

/** What the store hands back after landing: binding identity, store order. */
function landed(
  githubId: number,
  owner: 'alice' | 'bob',
  pr: number,
  createdAt: string,
  endpoint = 'submitReview',
): AuditEntry {
  return { githubId, humanId: `${owner}@corp.com`, workspace: owner, endpoint, pr, createdAt }
}

/** Two humans, two PRs, four distinct timestamps, landed in known order. */
function seeded(): HostStore {
  const store = open()
  store.landAudit('alice', [
    pulled({ githubId: 1, pr: 1, createdAt: T1 }),
    pulled({ githubId: 2, pr: 2, createdAt: T2, endpoint: 'replyToThread' }),
  ])
  store.landAudit('bob', [
    pulled({ githubId: 3, pr: 1, createdAt: T3 }),
    pulled({ githubId: 4, pr: 2, createdAt: T4 }),
  ])
  return store
}

const ALICE_1 = landed(1, 'alice', 1, T1)
const ALICE_2 = landed(2, 'alice', 2, T2, 'replyToThread')
const BOB_1 = landed(3, 'bob', 1, T3)
const BOB_2 = landed(4, 'bob', 2, T4)

/**
 * Parse one line of the formatter's CSV, where every cell is double-quoted
 * and embedded quotes are doubled. Returns the decoded cell contents.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  const re = /"((?:[^"]|"")*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) cells.push(m[1].replaceAll('""', '"'))
  return cells
}

describe('exportAudit: faithful representation + filters', () => {
  test('an empty query returns the full union in store order, nothing dropped', () => {
    const store = seeded()
    expect(exportAudit(store, {})).toEqual([ALICE_1, ALICE_2, BOB_1, BOB_2])
    store.close()
  })

  test('pr narrows to that PR across humans', () => {
    const store = seeded()
    expect(exportAudit(store, { pr: 1 })).toEqual([ALICE_1, BOB_1])
    expect(exportAudit(store, { pr: 2 })).toEqual([ALICE_2, BOB_2])
    store.close()
  })

  test('sinceIso narrows inclusively at the bound', () => {
    const store = seeded()
    // The row created exactly AT the bound (T2) is included.
    expect(exportAudit(store, { sinceIso: T2 })).toEqual([ALICE_2, BOB_1, BOB_2])
    store.close()
  })

  test('coderOwner scopes to that human, binding-resolved', () => {
    const store = seeded()
    expect(exportAudit(store, { coderOwner: 'alice' })).toEqual([ALICE_1, ALICE_2])
    expect(exportAudit(store, { coderOwner: 'bob' })).toEqual([BOB_1, BOB_2])
    store.close()
  })

  test('combined filters AND together', () => {
    const store = seeded()
    expect(exportAudit(store, { coderOwner: 'bob', pr: 2, sinceIso: T2 })).toEqual([BOB_2])
    // A combination nothing satisfies is an honest empty result, not an error.
    expect(exportAudit(store, { coderOwner: 'alice', pr: 1, sinceIso: T2 })).toEqual([])
    store.close()
  })
})

describe('canonicalizeSinceBound: a whole-second bound still includes the boundary row', () => {
  test('a whole-second Z bound canonicalizes to millisecond precision', () => {
    // The blocker: stored created_at is always .sssZ, so a text compare of
    // a whole-second bound would drop a row landed exactly at it.
    expect(canonicalizeSinceBound('2026-07-01T00:00:00Z')).toBe('2026-07-01T00:00:00.000Z')
    expect(canonicalizeSinceBound('2026-07-01T12:30:45Z')).toBe('2026-07-01T12:30:45.000Z')
  })

  test('a date-only bound canonicalizes to that day UTC midnight', () => {
    expect(canonicalizeSinceBound('2026-07-01')).toBe('2026-07-01T00:00:00.000Z')
  })

  test('sub-second fractions canonicalize to milliseconds', () => {
    expect(canonicalizeSinceBound('2026-07-01T00:00:00.5Z')).toBe('2026-07-01T00:00:00.500Z')
    expect(canonicalizeSinceBound('2026-07-01T00:00:00.123456789Z')).toBe(
      '2026-07-01T00:00:00.123Z',
    )
  })

  test('impossible or ill-shaped bounds are rejected (null), never silently shifted', () => {
    for (const bad of [
      '2026-02-30', // February 30 — engines roll it to March 2
      '2026-13-01', // month 13
      '2026-07-01T25:00:00Z', // hour 25
      '2026-07-01T00:00:00', // no Z (ambiguous local time)
      '2026/07/01', // slashes
      '2026', // bare year
      'yesterday',
      '',
    ]) {
      expect(canonicalizeSinceBound(bad)).toBeNull()
    }
  })

  test('the boundary row is included end to end after canonicalization', () => {
    const store = open()
    store.landAudit('alice', [pulled({ githubId: 50, createdAt: '2026-07-01T00:00:00.000Z' })])
    // A raw whole-second bound would drop it; the canonical bound keeps it.
    const bound = canonicalizeSinceBound('2026-07-01T00:00:00Z')!
    expect(exportAudit(store, { sinceIso: bound })).toHaveLength(1)
    store.close()
  })
})

describe('exportAudit: union vs owner scoping', () => {
  test('the union shows both humans; owner scoping shows exactly one', () => {
    const store = seeded()
    const union = exportAudit(store, {})
    expect(new Set(union.map((e) => e.humanId))).toEqual(
      new Set(['alice@corp.com', 'bob@corp.com']),
    )
    const scoped = exportAudit(store, { coderOwner: 'alice' })
    expect(scoped.every((e) => e.humanId === 'alice@corp.com')).toBe(true)
    // Union and scoped agree row-for-row: scoping filters, never rewrites.
    expect(scoped).toEqual(union.filter((e) => e.humanId === 'alice@corp.com'))
    store.close()
  })

  test('an unknown coderOwner throws UnboundOwnerError — never an empty export', () => {
    const store = seeded()
    expect(() => exportAudit(store, { coderOwner: 'mallory' })).toThrow(UnboundOwnerError)
    expect(() => exportAudit(store, { coderOwner: '' })).toThrow(UnboundOwnerError)
    store.close()
  })
})

describe('formatAudit csv: injection guard', () => {
  test('a formula-triggering endpoint landed through the store is neutralized', () => {
    const store = open()
    // Within the store's 64-char endpoint bound, hostile charset: the store
    // accepts it, so the formatter is the last line of defense.
    const hostile = "=cmd|' /c calc'!A1"
    const result = store.landAudit('alice', [pulled({ githubId: 7, endpoint: hostile })])
    expect(result).toEqual({ landed: 1, rejected: [] })

    const csv = formatAudit(exportAudit(store, {}), 'csv')
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    const cells = parseCsvLine(lines[1])
    expect(cells).toHaveLength(6)
    // The endpoint cell renders as literal text: single-quote prefixed, so no
    // spreadsheet evaluates it — and the original content is still legible.
    expect(cells[3]).toBe(`'${hostile}`)
    // No decoded cell in the row begins with a raw formula trigger.
    for (const cell of cells) {
      expect(/^[=+@\t\r-]/.test(cell)).toBe(false)
    }
    store.close()
  })

  test('every formula trigger character is prefixed, in every string field', () => {
    const triggers = ['=SUM(A1:A9)', '+1', '-1', '@cmd', '\ttabbed', '\rreturned']
    const entries = triggers.map((endpoint, i) => ({
      ...landed(100 + i, 'alice', 1, T1),
      endpoint,
    }))
    // createdAt is also workspace-authored: guard it identically.
    entries.push({ ...landed(200, 'alice', 1, '=NOW()') })
    const lines = formatAudit(entries, 'csv').split('\n')
    expect(lines).toHaveLength(1 + entries.length)
    for (const line of lines.slice(1)) {
      for (const cell of parseCsvLine(line)) {
        expect(/^[=+@\t\r-]/.test(cell)).toBe(false)
      }
    }
    // Spot-check the neutralized forms survive decode legibly.
    expect(parseCsvLine(lines[1])[3]).toBe("'=SUM(A1:A9)")
    expect(parseCsvLine(lines[7])[5]).toBe("'=NOW()")
  })

  test('a trigger hidden behind leading whitespace is also neutralized', () => {
    // Some importers strip leading whitespace before evaluating, exposing the
    // trigger — so a leading space/tab/no-break-space/BOM is guarded too. (A
    // literal newline is a valid RFC 4180 quoted-cell character, kept as-is.)
    const hidden = [' =cmd', '\t=cmd', ' =cmd', '﻿=cmd']
    const entries = hidden.map((endpoint, i) => ({ ...landed(300 + i, 'alice', 1, T1), endpoint }))
    const lines = formatAudit(entries, 'csv').split('\n')
    expect(lines).toHaveLength(1 + entries.length)
    for (const line of lines.slice(1)) {
      const endpointCell = parseCsvLine(line)[3]
      // The single-quote prefix lands before the whitespace, so the decoded
      // cell begins with `'` — never whitespace-then-a-raw-trigger.
      expect(endpointCell.startsWith("'")).toBe(true)
    }
  })

  test('commas and double quotes in a field are escaped and round-trip exactly', () => {
    const store = open()
    const tricky = 'review,"quoted",done'
    store.landAudit('alice', [pulled({ githubId: 8, endpoint: tricky })])
    const lines = formatAudit(exportAudit(store, {}), 'csv').split('\n')
    expect(lines).toHaveLength(2)
    // The raw line carries the doubled-quote escape…
    expect(lines[1]).toContain('"review,""quoted"",done"')
    // …and still decodes to exactly six cells with the original content.
    const cells = parseCsvLine(lines[1])
    expect(cells).toHaveLength(6)
    expect(cells[3]).toBe(tricky)
    store.close()
  })

  test('header and row count are exact; an empty export is just the header', () => {
    const store = seeded()
    const lines = formatAudit(exportAudit(store, {}), 'csv').split('\n')
    expect(lines[0]).toBe('github_id,human_id,workspace,endpoint,pr,created_at')
    expect(lines).toHaveLength(5)
    // Numeric cells render as plain decimal.
    expect(parseCsvLine(lines[1])[0]).toBe('1')
    expect(parseCsvLine(lines[1])[4]).toBe('1')
    expect(formatAudit([], 'csv')).toBe('github_id,human_id,workspace,endpoint,pr,created_at')
    store.close()
  })
})

describe('formatAudit json', () => {
  test('round-trips to the exact entries, in order', () => {
    const store = seeded()
    const rows = exportAudit(store, {})
    expect(JSON.parse(formatAudit(rows, 'json'))).toEqual(rows)
    expect(JSON.parse(formatAudit([], 'json'))).toEqual([])
    store.close()
  })
})

describe('formatAudit table', () => {
  test('shows every row, aligned under the headers, with a count footer', () => {
    const store = seeded()
    const lines = formatAudit(exportAudit(store, {}), 'table').split('\n')
    // header + separator + 4 rows + footer
    expect(lines).toHaveLength(7)
    expect(lines[0]).toContain('created_at')
    expect(lines[0]).toContain('endpoint')
    expect(lines[6]).toBe('4 audit rows')
    // Alignment: every row's endpoint value starts where the header does.
    const at = lines[0].indexOf('endpoint')
    expect(lines[2].slice(at)).toStartWith('submitReview')
    expect(lines[3].slice(at)).toStartWith('replyToThread')
    // All four rows are present with both identities.
    const body = lines.slice(2, 6).join('\n')
    expect(body).toContain('alice@corp.com')
    expect(body).toContain('bob@corp.com')
    expect(body).toContain(T1)
    expect(body).toContain(T4)
    store.close()
  })

  test('control characters in a field cannot break the layout', () => {
    const hostile: AuditEntry = {
      ...landed(9, 'alice', 1, T1),
      endpoint: 'bad\nrow\tsplit\u001b[31m',
    }
    const out = formatAudit([hostile], 'table')
    const lines = out.split('\n')
    // Still exactly header + separator + one row + footer: the embedded
    // newline did not mint an extra line.
    expect(lines).toHaveLength(4)
    expect(out).not.toContain('\t')
    expect(out).not.toContain('\u001b')
    // Replacement is visible, not silent.
    expect(lines[2]).toContain('bad?row?split?[31m')
    expect(lines[3]).toBe('1 audit row')
  })

  test('an empty result is a clear line, never an empty string', () => {
    const store = open()
    expect(formatAudit(exportAudit(store, { pr: 424242 }), 'table')).toBe('no audit rows')
    store.close()
  })
})

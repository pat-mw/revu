/**
 * The host-side reviewer-assignment loader. These tests run entirely disk-local
 * (a temp file per test) and network-free, asserting: the fixed two-section shape
 * parses to assignments + the login→human map; a re-read picks up a lead's edit
 * without a restart; and a read/parse failure KEEPS the last-good map, logs a
 * token-free warning, and never echoes the file bytes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReviewerAssignments,
  resolveReviewersFile,
} from './reviewer-assignment'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revu-reviewers-'))
  file = join(dir, 'reviewers.yaml')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write the reviewers file, then build + load a fresh surface over it. */
function loaded(yaml: string, log: (m: string) => void = () => {}) {
  writeFileSync(file, yaml, 'utf8')
  const r = createReviewerAssignments(file, log)
  r.load()
  return r
}

const SAMPLE = `
humans:
  octocat: h-priya      # github login -> Human.id
  hubot: h-marcus
assignments:
  347: [h-priya]        # pr number -> [assigned Human.id ...]
  355: [h-priya, h-marcus]
`

describe('resolveReviewersFile', () => {
  test('honors REVU_REVIEWERS_FILE over the data-dir default', () => {
    expect(resolveReviewersFile('/data', { REVU_REVIEWERS_FILE: '/etc/reviewers.yaml' })).toBe(
      '/etc/reviewers.yaml',
    )
  })

  test('defaults to reviewers.yaml under the data dir', () => {
    expect(resolveReviewersFile('/data', {})).toBe('/data/reviewers.yaml')
  })
})

describe('parsing the fixed two-section shape', () => {
  test('assignmentsFor and humanForLogin read back the parsed file', () => {
    const r = loaded(SAMPLE)
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
    expect(r.assignmentsFor(355)).toEqual(['h-priya', 'h-marcus'])
    expect(r.humanForLogin('octocat')).toBe('h-priya')
    expect(r.humanForLogin('hubot')).toBe('h-marcus')
  })

  test('assignmentsFor defaults to [] for an unassigned PR, and a fresh array each call', () => {
    const r = loaded(SAMPLE)
    expect(r.assignmentsFor(999)).toEqual([])
    // A caller cannot mutate the cached map through the returned array.
    const a = r.assignmentsFor(347)
    a.push('h-mallory')
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
  })

  test('humanForLogin is case-insensitive and undefined for an unknown login', () => {
    const r = loaded(SAMPLE)
    expect(r.humanForLogin('OctoCat')).toBe('h-priya')
    expect(r.humanForLogin('nobody')).toBeUndefined()
  })

  test('an empty assignment list parses to []', () => {
    const r = loaded('assignments:\n  400: []\n')
    expect(r.assignmentsFor(400)).toEqual([])
  })

  test('a real YAML block list (dashes) parses to the reviewer ids', () => {
    const r = loaded('assignments:\n  347:\n    - h-priya\n    - h-marcus\n')
    expect(r.assignmentsFor(347)).toEqual(['h-priya', 'h-marcus'])
  })

  test('quoted scalars parse (the value is not clipped or dropped)', () => {
    const r = loaded('humans:\n  octocat: "h-priya"\nassignments:\n  347: ["h-priya"]\n')
    expect(r.humanForLogin('octocat')).toBe('h-priya')
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
  })
})

describe('shape validation and last-good resilience', () => {
  test('a typo\'d section header keeps last-good and warns (never silently blanks)', () => {
    const logs: string[] = []
    const r = createReviewerAssignments(file, (m) => logs.push(m))
    writeFileSync(file, SAMPLE, 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])

    // A miscapitalized section header parks the real data under an unknown key —
    // a real YAML parser would happily read it as `{Assignments: {...}}`, which
    // must NOT silently blank the live assignments.
    writeFileSync(file, 'Assignments:\n  347: [h-marcus]\n', 'utf8')
    r.load()

    // The prior assignments still serve, and a warning fired.
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(file)
  })

  test('an intentionally-present-but-empty assignments section CLEARS assignments', () => {
    const r = createReviewerAssignments(file, () => {})
    writeFileSync(file, 'assignments:\n  347: [h-priya]\n', 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])

    // The lead deliberately clears all assignments by emptying the section.
    writeFileSync(file, 'assignments:\n', 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual([])
  })

  test('a non-integer PR key is rejected and the whole load keeps last-good', () => {
    const logs: string[] = []
    const r = createReviewerAssignments(file, (m) => logs.push(m))
    writeFileSync(file, 'assignments:\n  347: [h-priya]\n', 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])

    // A quoted non-decimal key must not be coerced (the hand-rolled parser turned
    // `0x1f` into 31). It is rejected, the load keeps last-good, and a warning
    // fires — the malformed file never partially applies.
    writeFileSync(file, 'assignments:\n  "0x1f": [h-marcus]\n', 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
    expect(r.assignmentsFor(31)).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(file)
  })

  test('a YAML syntax error keeps last-good and never echoes the parser message or bytes', () => {
    const logs: string[] = []
    const r = createReviewerAssignments(file, (m) => logs.push(m))
    writeFileSync(file, SAMPLE, 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])

    // Unbalanced flow brackets carrying a mispasted secret is invalid YAML.
    const SECRET = 'ghp_flowbracketsecret1234567890'
    writeFileSync(file, `assignments:\n  347: [${SECRET}\n`, 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain(SECRET)
  })
})

describe('re-read without a restart', () => {
  test('a lead edit is picked up on the next load(), no restart', () => {
    const r = loaded('assignments:\n  347: [h-priya]\n')
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
    // The lead edits the file, adding a second reviewer and a new PR.
    writeFileSync(file, 'assignments:\n  347: [h-priya, h-marcus]\n  360: [h-marcus]\n', 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya', 'h-marcus'])
    expect(r.assignmentsFor(360)).toEqual(['h-marcus'])
  })
})

describe('resilient, no-leak error handling', () => {
  test('an absent file yields empty maps and logs nothing (the normal "no reviewers yet" state)', () => {
    const logs: string[] = []
    const r = createReviewerAssignments(join(dir, 'missing.yaml'), (m) => logs.push(m))
    r.load()
    expect(r.assignmentsFor(347)).toEqual([])
    expect(r.humanForLogin('octocat')).toBeUndefined()
    expect(logs).toEqual([])
  })

  test('a parse failure KEEPS the last-good map and warns without echoing file bytes', () => {
    const logs: string[] = []
    const r = createReviewerAssignments(file, (m) => logs.push(m))
    writeFileSync(file, SAMPLE, 'utf8')
    r.load()
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])

    // The lead mispastes a secret into the file where a PR number belongs — the
    // key is not a positive integer, so the parse throws.
    const SECRET = 'ghp_supersecrettokenvalue1234567890'
    writeFileSync(file, `assignments:\n  ${SECRET}: [h-priya]\n`, 'utf8')
    r.load()

    // The last-good map is kept — assignments still serve the prior file.
    expect(r.assignmentsFor(347)).toEqual(['h-priya'])
    // A warning fired, naming the path but NEVER echoing the file bytes.
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(file)
    expect(logs[0]).not.toContain(SECRET)
  })

  test('a malformed humans entry (missing id) is a kept-last-good, no-leak warning', () => {
    const logs: string[] = []
    const r = createReviewerAssignments(file, (m) => logs.push(m))
    writeFileSync(file, 'humans:\n  octocat: h-priya\n', 'utf8')
    r.load()
    expect(r.humanForLogin('octocat')).toBe('h-priya')

    const SECRET = 'AKIAIOSFODNN7EXAMPLE'
    // A humans entry whose value is a mispasted secret would still parse; the
    // no-leak guarantee that matters is the PARSE-ERROR path, which must never
    // quote the offending line. Force a parse error with a top-level malformed
    // line carrying the secret.
    writeFileSync(file, `${SECRET}\n`, 'utf8')
    r.load()

    // Kept last-good; warning is token-free.
    expect(r.humanForLogin('octocat')).toBe('h-priya')
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain(SECRET)
  })
})

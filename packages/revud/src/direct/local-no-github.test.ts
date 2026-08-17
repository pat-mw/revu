/**
 * The local git read path must be structurally unable to reach GitHub: no client
 * type, no client method, no API host, no third-party SDK. "The client is never
 * called" is a property of every code path at once, so no runtime test can
 * enumerate it — the durable form of the claim is that the vocabulary needed to
 * make such a call does not appear in the source at all. A module that cannot name
 * a client cannot mis-call one.
 *
 * Three things make this guard falsifiable rather than decorative:
 *
 * 1. **Each scanned module is asserted to exist, and to be non-empty, before its
 *    text is examined.** A source scan over a file that is absent — or present but
 *    empty — satisfies every absence assertion trivially, which would convert an
 *    unverified claim into a recorded green. A missing module is a failure here,
 *    never a skip.
 * 2. **Every banned pattern is asserted to match a probe that deliberately
 *    contains the construct**, so no member of the ban list can be a pattern that
 *    matches nothing anywhere and therefore never objects to what it forbids.
 * 3. **Every banned pattern is additionally measured against the real modules that
 *    legitimately do carry the GitHub read tier's vocabulary**, and the set of
 *    patterns with no such witness is pinned. A pattern proved live only against a
 *    hand-written probe is proved against its author's spelling; matching how the
 *    codebase actually spells it is the stronger claim, and the pin makes it
 *    visible when a rename costs a pattern its witness.
 *
 * One absence per test throughout: the runner abandons a test body at its first
 * failed expectation, so two absence assertions sharing a body leave the second
 * one unfalsifiable.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

/** The modules that make up the local git read path. Every one of them is scanned. */
const SCANNED_MODULES = ['local-git.ts', 'local-git-argv.ts', 'local-sync.ts'] as const

interface BannedToken {
  /** How the failure names the thing that was found. */
  readonly label: string
  readonly pattern: RegExp
}

/**
 * The vocabulary a caller would need in order to reach GitHub from this path.
 *
 * Each identifier is anchored on word boundaries, so ordinary prose explaining
 * *why* a module talks to no such service is not itself a violation, while the
 * exact spelling that would compile is. `getBlob` and `getBlobObjects` are two
 * separate methods and neither pattern subsumes the other: the trailing boundary
 * on `getBlob` stops it matching inside `getBlobObjects`, so a module using only
 * the batched call would slip past a list carrying just `getBlob`.
 */
const BANNED: readonly BannedToken[] = [
  { label: "an import of the GitHub client module", pattern: /['"][^'"]*github-client['"]/ },
  { label: 'the GitHub client type', pattern: /\bGithubClient\b/ },
  { label: 'the batched blob read', pattern: /\bgetBlobObjects\b/ },
  { label: 'the single blob read', pattern: /\bgetBlob\b/ },
  { label: 'the GitHub API host', pattern: /api\.github\.com/ },
  { label: 'a third-party GitHub SDK', pattern: /octokit/i },
]

/**
 * A source-shaped string containing one instance of every banned construct, in the
 * form a real caller would write it. Its only purpose is to prove each pattern can
 * fire.
 */
const PROBE = [
  "import type { GithubClient } from './github-client'",
  'const many = await github.getBlobObjects(owner, repo, shas)',
  'const one = await github.getBlob(owner, repo, sha)',
  "const base = 'https://api.github.com'",
  "import { Octokit } from 'octokit'",
].join('\n')

/**
 * The modules that legitimately do reach GitHub, joined. The blob provider imports
 * the client and calls both blob reads; the client itself carries the type and the
 * API host. Measuring the ban list against these proves each pattern matches the
 * spelling this codebase actually uses, not merely the spelling of the probe above.
 */
const GITHUB_TIER_SOURCE = ['blobs.ts', 'github-client.ts']
  .map((module) => readFileSync(new URL(`./${module}`, import.meta.url), 'utf8'))
  .join('\n')

/**
 * Reads one scanned module, failing loudly when it is not there. `readFileSync`
 * would also throw, but the message matters: an absent module means this guard has
 * nothing to scan, and that is the failure mode it was written to prevent.
 */
function readScanned(module: string): string {
  const url = new URL(`./${module}`, import.meta.url)
  if (!existsSync(url)) {
    throw new Error(
      `${module} does not exist, so this guard has nothing to scan — that is a failure, not a pass`,
    )
  }
  return readFileSync(url, 'utf8')
}

describe('the local git read path is present to be scanned', () => {
  for (const module of SCANNED_MODULES) {
    test(`${module} exists`, () => {
      expect(existsSync(new URL(`./${module}`, import.meta.url))).toBe(true)
    })

    test(`${module} has source text to scan`, () => {
      // A present-but-empty file satisfies every absence assertion below.
      expect(readScanned(module).length).toBeGreaterThan(0)
    })
  }
})

describe('the local git read path names no way to reach GitHub', () => {
  for (const module of SCANNED_MODULES) {
    for (const banned of BANNED) {
      test(`${module} contains no ${banned.label}`, () => {
        expect(readScanned(module)).not.toMatch(banned.pattern)
      })
    }
  }
})

describe('every banned pattern can fire', () => {
  for (const banned of BANNED) {
    test(`${banned.label} is matched in a source-shaped probe`, () => {
      expect(PROBE).toMatch(banned.pattern)
    })
  }

  test('the ban list has six members', () => {
    // An independent literal rather than a count derived from the list itself, so
    // dropping a member is red here even though every remaining assertion still
    // passes.
    expect(BANNED).toHaveLength(6)
  })

  test('only the third-party SDK pattern has no witness in this tree', () => {
    // Derived by measurement, not declared: if a rename in the GitHub read tier
    // costs one of these patterns its real-source witness, this list grows and the
    // guard says so rather than quietly relying on the probe alone. No dependency
    // in this workspace provides the third-party SDK, so that pattern has nothing
    // real to match and the probe is the whole of its proof.
    const unwitnessed = BANNED.filter((b) => !b.pattern.test(GITHUB_TIER_SOURCE)).map(
      (b) => b.label,
    )
    expect(unwitnessed).toEqual(['a third-party GitHub SDK'])
  })

  for (const banned of BANNED.filter((b) => b.label !== 'a third-party GitHub SDK')) {
    test(`${banned.label} is matched in the GitHub read tier's own source`, () => {
      expect(GITHUB_TIER_SOURCE).toMatch(banned.pattern)
    })
  }
})

/**
 * Behavioral contract for the identity-smuggling module.
 *
 * Comments written through the broker are posted by a single bot login with
 * the human author's name smuggled into a bold markdown prefix. These tests
 * pin the parser, its inverse, and the derived display helpers to the exact
 * behavior of the code as written — including the honestly-documented
 * ambiguities (a lone all-letters word such as "Warning" parses as a person).
 *
 * Name validation is LETTERS-ONLY as implemented: a token containing a digit
 * is rejected, so such a body currently parses as the bot. These tests assert
 * that letters-only contract exactly and do not anticipate any future
 * relaxation.
 */
import { describe, it, expect } from 'bun:test'
import { BROKER_LOGIN, type GhUser, type Human, type ReviewComment } from '@/api/types'
import {
  avatarStyle,
  identityName,
  isOwnComment,
  parseCommentIdentity,
  parsePrefixedBody,
  prefixBody,
} from '@/lib/identity'

// ————————————————————————————————————————————————————————————————
// Minimal typed fixtures. Only the fields the module reads are honest
// (login for routing, body for parsing, name/role for humans); the rest of
// each GitHub-shaped record is padded through a narrow cast so the fixtures
// stay small without weakening the fields under test.
// ————————————————————————————————————————————————————————————————

function ghUser(login: string): GhUser {
  return {
    login,
    id: 1,
    node_id: 'U_1',
    avatar_url: 'https://example.invalid/a.png',
    html_url: 'https://example.invalid/u',
    type: login.endsWith('[bot]') ? 'Bot' : 'User',
  }
}

/** A comment carrying only the fields `parseCommentIdentity` / `isOwnComment` read. */
function reviewComment(login: string, body: string): ReviewComment {
  return {
    id: 100,
    node_id: 'RC_100',
    pull_request_review_id: null,
    path: 'src/x.ts',
    diff_hunk: '@@ -1 +1 @@',
    commit_id: 'c'.repeat(40),
    original_commit_id: 'c'.repeat(40),
    line: 1,
    original_line: 1,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: 'line',
    user: ghUser(login),
    body,
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T00:00:00Z',
    reactions: {
      url: 'https://example.invalid/r',
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    html_url: 'https://example.invalid/c',
  }
}

function human(name: string, role: Human['role'] = 'contractor'): Human {
  return { id: 'h_1', name, role, email: 'h@example.invalid' }
}

describe('parsePrefixedBody', () => {
  it('parses a bare name prefix separated by a blank line', () => {
    expect(parsePrefixedBody('**Alice Nguyen**\n\ncontent')).toEqual({
      name: 'Alice Nguyen',
      role: null,
      rest: 'content',
    })
  })

  it('captures an optional parenthesized role', () => {
    expect(parsePrefixedBody('**Alice** (contractor)\n\nx')).toEqual({
      name: 'Alice',
      role: 'contractor',
      rest: 'x',
    })
  })

  it('preserves multi-line and structured content in rest', () => {
    const rest = 'line one\n\nline two\n- item'
    expect(parsePrefixedBody(`**Bob**\n\n${rest}`)?.rest).toBe(rest)
  })

  it('returns null for an inline bold opener with no blank line', () => {
    expect(parsePrefixedBody('**Alice** hi')).toBeNull()
  })

  it('returns null when only a single newline separates name and content', () => {
    expect(parsePrefixedBody('**Alice**\ncontent')).toBeNull()
  })
})

describe('parsePrefixedBody name validation', () => {
  it('accepts letters from non-ASCII scripts', () => {
    expect(parsePrefixedBody('**José**\n\nx')?.name).toBe('José')
    expect(parsePrefixedBody('**Zoë**\n\nx')?.name).toBe('Zoë')
  })

  it('accepts hyphen, apostrophe (straight and curly), and period inside a token', () => {
    expect(parsePrefixedBody('**Anne-Marie**\n\nx')?.name).toBe('Anne-Marie')
    expect(parsePrefixedBody("**O'Brien**\n\nx")?.name).toBe("O'Brien")
    expect(parsePrefixedBody('**O’Brien**\n\nx')?.name).toBe('O’Brien')
    expect(parsePrefixedBody('**J.R.**\n\nx')?.name).toBe('J.R.')
  })

  it('accepts between one and four tokens', () => {
    expect(parsePrefixedBody('**Ada**\n\nx')?.name).toBe('Ada')
    expect(parsePrefixedBody('**Ada Bee Cee Dee**\n\nx')?.name).toBe('Ada Bee Cee Dee')
  })

  it('rejects five tokens', () => {
    expect(parsePrefixedBody('**Ada Bee Cee Dee Eff**\n\nx')).toBeNull()
  })

  it('rejects a token containing a digit (letters-only contract)', () => {
    // A digit anywhere in a token fails the token regex, so the whole body
    // parses as the bot rather than a person. This is the current contract.
    expect(parsePrefixedBody('**Bob2**\n\nx')).toBeNull()
    expect(parsePrefixedBody('**alice2**\n\nx')).toBeNull()
  })

  it('accepts a token at the 24-character cap and rejects one past it', () => {
    // The token regex is one leading letter plus up to 23 more, so 24 letters
    // is the longest accepted token; 25 letters is rejected.
    const cap = 'A'.repeat(24)
    const over = 'A'.repeat(25)
    expect(parsePrefixedBody(`**${cap}**\n\nx`)?.name).toBe(cap)
    expect(parsePrefixedBody(`**${over}**\n\nx`)).toBeNull()
  })
})

describe('parsePrefixedBody documented ambiguities', () => {
  it('parses a lone all-letters word as a person (the smuggling format owns this)', () => {
    // "Warning" is a single all-letters token, so despite reading like a
    // heading it parses as a person named "Warning".
    expect(parsePrefixedBody('**Warning**\n\ntext')).toEqual({
      name: 'Warning',
      role: null,
      rest: 'text',
    })
  })

  it('rejects a bold opener whose token carries a digit', () => {
    expect(parsePrefixedBody('**Note 1**\n\nx')).toBeNull()
  })

  it('rejects a bold opener containing a non-letter symbol', () => {
    expect(parsePrefixedBody('**No@te**\n\nx')).toBeNull()
  })
})

describe('parseCommentIdentity', () => {
  it('leaves a real GitHub user untouched even when the body looks prefixed', () => {
    const comment = reviewComment('octocat', '**Alice**\n\ncontent')
    const parsed = parseCommentIdentity(comment)
    expect(parsed.identity).toEqual({ kind: 'github', user: comment.user })
    // Prefix parsing never applies to non-broker comments: body is unchanged.
    expect(parsed.body).toBe('**Alice**\n\ncontent')
  })

  it('resolves a broker comment with a valid prefix to a human and strips the prefix', () => {
    const parsed = parseCommentIdentity(reviewComment(BROKER_LOGIN, '**Alice** (lead)\n\nhello'))
    expect(parsed.identity).toEqual({ kind: 'human', name: 'Alice', role: 'lead' })
    expect(parsed.body).toBe('hello')
  })

  it('resolves a broker comment with a valid prefix and no role to a null role', () => {
    const parsed = parseCommentIdentity(reviewComment(BROKER_LOGIN, '**Alice**\n\nhello'))
    expect(parsed.identity).toEqual({ kind: 'human', name: 'Alice', role: null })
    expect(parsed.body).toBe('hello')
  })

  it('falls back to the bot when a broker comment has no parseable prefix', () => {
    const comment = reviewComment(BROKER_LOGIN, 'just a plain body, no prefix')
    const parsed = parseCommentIdentity(comment)
    expect(parsed.identity).toEqual({ kind: 'bot', user: comment.user })
    expect(parsed.body).toBe('just a plain body, no prefix')
  })
})

describe('prefixBody round-trip', () => {
  it('produces the exact prefixed string the broker posts', () => {
    expect(prefixBody(human('Alice Nguyen', 'contractor'), 'the review markdown')).toBe(
      '**Alice Nguyen** (contractor)\n\nthe review markdown',
    )
  })

  it('recovers name, role, and markdown exactly through parseCommentIdentity', () => {
    const author = human('Alice Nguyen', 'contractor')
    const markdown = 'Actually this should be a `Map`.\n\nSecond paragraph.'
    const body = prefixBody(author, markdown)
    const parsed = parseCommentIdentity(reviewComment(BROKER_LOGIN, body))
    expect(parsed.identity).toEqual({
      kind: 'human',
      name: author.name,
      role: author.role,
    })
    expect(parsed.body).toBe(markdown)
  })

  it('round-trips the lead role too', () => {
    const author = human('Bob', 'lead')
    const parsed = parseCommentIdentity(reviewComment(BROKER_LOGIN, prefixBody(author, 'x')))
    expect(parsed.identity).toEqual({ kind: 'human', name: 'Bob', role: 'lead' })
    expect(parsed.body).toBe('x')
  })
})

describe('identityName', () => {
  it('returns the smuggled name for a human identity', () => {
    expect(identityName({ kind: 'human', name: 'Alice', role: null })).toBe('Alice')
  })

  it('returns the login for a github identity', () => {
    expect(identityName({ kind: 'github', user: ghUser('octocat') })).toBe('octocat')
  })

  it('returns the login for a bot identity', () => {
    expect(identityName({ kind: 'bot', user: ghUser(BROKER_LOGIN) })).toBe(BROKER_LOGIN)
  })
})

describe('isOwnComment', () => {
  it('is true when the parsed human name matches the session human', () => {
    const body = prefixBody(human('Alice'), 'mine')
    expect(isOwnComment(reviewComment(BROKER_LOGIN, body), human('Alice'))).toBe(true)
  })

  it('is false when a broker comment resolves to a different human name', () => {
    const body = prefixBody(human('Bob'), 'theirs')
    expect(isOwnComment(reviewComment(BROKER_LOGIN, body), human('Alice'))).toBe(false)
  })

  it('is false for a real GitHub (non-broker) comment', () => {
    // Even a body that looks prefixed stays github-kind for a real login.
    const comment = reviewComment('octocat', '**Alice**\n\nx')
    expect(isOwnComment(comment, human('Alice'))).toBe(false)
  })

  it('is false for a bot comment with no parseable prefix', () => {
    const comment = reviewComment(BROKER_LOGIN, 'plain body')
    expect(isOwnComment(comment, human('Alice'))).toBe(false)
  })
})

describe('avatarStyle', () => {
  it('is deterministic for the same name', () => {
    expect(avatarStyle('Alice Nguyen')).toEqual(avatarStyle('Alice Nguyen'))
  })

  it('derives initials from first and last word when there are 2+ words', () => {
    expect(avatarStyle('Alice Nguyen').initials).toBe('AN')
  })

  it('derives initials from the first two characters for a single word', () => {
    expect(avatarStyle('bob').initials).toBe('BO')
  })

  it('treats a hyphen as a word separator when forming initials', () => {
    // The initials split is on whitespace OR hyphen, so a hyphenated single
    // token yields two-word initials.
    expect(avatarStyle('Anne-Marie').initials).toBe('AM')
  })

  it('emits hsl color and background strings', () => {
    const style = avatarStyle('Zoë')
    expect(style.color).toMatch(/^hsl\(/)
    expect(style.background).toMatch(/^hsl\(/)
    expect(style.color).toContain('48% 72%')
    expect(style.background).toContain('32% 24%')
  })
})

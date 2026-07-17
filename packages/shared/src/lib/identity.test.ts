/**
 * Behavioral contract for the identity-smuggling module.
 *
 * Comments written through the broker are posted by a single bot login with
 * the human author's name smuggled into a bold markdown prefix. These tests
 * pin the parser, its inverse, and the derived display helpers to the exact
 * behavior of the code as written — including the honestly-documented
 * ambiguities (a lone all-letters word such as "Warning" parses as a person).
 *
 * Name validation spans the broker's author-name charset: letters (any
 * script), digits, underscore, and hyphen, with apostrophes and periods also
 * allowed inside a token. A Coder username such as `alice2` or `j_doe` is a
 * valid stamped name, so these tests pin those as parsing to a person. What
 * still keeps markdown out is the 1–4 token cap and the per-token length cap,
 * not the charset — so a symbol like `@`, five tokens, or an over-length token
 * is still rejected. These tests assert both sides of that contract.
 */
import { describe, it, expect } from 'bun:test'
import type { GhUser, Human, ReviewComment } from '../api/types'
import {
  avatarStyle,
  identityName,
  isOwnComment,
  parseCommentIdentity,
  parsePrefixedBody,
  prefixBody,
} from './identity'

// ————————————————————————————————————————————————————————————————
// Minimal typed fixtures. Only the fields the module reads are honest
// (login for routing, body for parsing, name/role for humans); the rest of
// each GitHub-shaped record is padded through a narrow cast so the fixtures
// stay small without weakening the fields under test.
// ————————————————————————————————————————————————————————————————

/**
 * The bot login these tests thread into the parser. It is deliberately NOT the
 * value any adapter or fixture uses: a hardcoded broker login left anywhere in
 * the parser would make comments authored by this login parse as the bot
 * instead of resolving their smuggled human, so these tests would fail.
 */
const BOT_LOGIN = 'test-broker[bot]'

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

  it('accepts a token carrying digits or an underscore (Coder username charset)', () => {
    // Coder usernames carry digits and underscores; the broker stamps them
    // verbatim, so the parser must recover them as a person rather than
    // dropping the prefix and rendering the bare bot.
    expect(parsePrefixedBody('**Bob2**\n\nx')?.name).toBe('Bob2')
    expect(parsePrefixedBody('**alice2**\n\nx')?.name).toBe('alice2')
    expect(parsePrefixedBody('**j_doe**\n\nx')?.name).toBe('j_doe')
  })

  it('accepts digits and underscore across the token-count range', () => {
    expect(parsePrefixedBody('**dev_1 qa_2**\n\nx')?.name).toBe('dev_1 qa_2')
    expect(parsePrefixedBody('**a1 b2 c3 d4**\n\nx')?.name).toBe('a1 b2 c3 d4')
  })

  it('still rejects a digit/underscore string that is not a valid stamped prefix', () => {
    // The charset widened, but the caps did not: five tokens, a symbol outside
    // the charset, and an over-length token are all still rejected, so a body
    // like these parses as the bot rather than a bogus person.
    expect(parsePrefixedBody('**a1 b2 c3 d4 e5**\n\nx')).toBeNull()
    expect(parsePrefixedBody('**user@2fa**\n\nx')).toBeNull()
    expect(parsePrefixedBody(`**${'x9'.repeat(13)}**\n\nx`)).toBeNull()
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

  it('parses a bold opener whose token carries a digit (charset now admits it)', () => {
    // Digits joined the charset, so `Note 1` reads as a two-token person the
    // same way `Warning` reads as a one-token person — the smuggling format
    // owns this. The token-count and length caps, not the charset, are what
    // fence markdown out.
    expect(parsePrefixedBody('**Note 1**\n\nx')).toEqual({
      name: 'Note 1',
      role: null,
      rest: 'x',
    })
  })

  it('rejects a bold opener containing a symbol outside the charset', () => {
    expect(parsePrefixedBody('**No@te**\n\nx')).toBeNull()
  })
})

describe('parseCommentIdentity', () => {
  it('leaves a real GitHub user untouched even when the body looks prefixed', () => {
    const comment = reviewComment('octocat', '**Alice**\n\ncontent')
    const parsed = parseCommentIdentity(comment, BOT_LOGIN)
    expect(parsed.identity).toEqual({ kind: 'github', user: comment.user })
    // Prefix parsing never applies to non-broker comments: body is unchanged.
    expect(parsed.body).toBe('**Alice**\n\ncontent')
  })

  it('resolves a broker comment with a valid prefix to a human and strips the prefix', () => {
    const parsed = parseCommentIdentity(reviewComment(BOT_LOGIN, '**Alice** (lead)\n\nhello'), BOT_LOGIN)
    expect(parsed.identity).toEqual({ kind: 'human', name: 'Alice', role: 'lead' })
    expect(parsed.body).toBe('hello')
  })

  it('resolves a broker comment with a valid prefix and no role to a null role', () => {
    const parsed = parseCommentIdentity(reviewComment(BOT_LOGIN, '**Alice**\n\nhello'), BOT_LOGIN)
    expect(parsed.identity).toEqual({ kind: 'human', name: 'Alice', role: null })
    expect(parsed.body).toBe('hello')
  })

  it('falls back to the bot when a broker comment has no parseable prefix', () => {
    const comment = reviewComment(BOT_LOGIN, 'just a plain body, no prefix')
    const parsed = parseCommentIdentity(comment, BOT_LOGIN)
    expect(parsed.identity).toEqual({ kind: 'bot', user: comment.user })
    expect(parsed.body).toBe('just a plain body, no prefix')
  })

  it('routes off the passed bot login, not any hardcoded string', () => {
    // The broker login is configuration, threaded in from the session. The same
    // prefixed comment resolves to its smuggled human ONLY when its author login
    // is named as the bot; under any other bot login it is a genuine GitHub
    // user whose body is left verbatim. A parser that pinned a constant login
    // would break one of these two assertions.
    const comment = reviewComment('renamed-broker[bot]', '**Alice**\n\nhello')

    const asBot = parseCommentIdentity(comment, 'renamed-broker[bot]')
    expect(asBot.identity).toEqual({ kind: 'human', name: 'Alice', role: null })
    expect(asBot.body).toBe('hello')

    const asStranger = parseCommentIdentity(comment, BOT_LOGIN)
    expect(asStranger.identity).toEqual({ kind: 'github', user: comment.user })
    expect(asStranger.body).toBe('**Alice**\n\nhello')
  })

  it('never treats a real author as the bot when botLogin is empty', () => {
    // An empty botLogin is misconfiguration: it must take the non-bot path so
    // no genuine author is mis-attributed. Even a comment whose own author
    // login is the empty string stays github-kind with its body verbatim.
    const realAuthor = parseCommentIdentity(reviewComment('octocat', '**Alice**\n\nhello'), '')
    expect(realAuthor.identity).toEqual({ kind: 'github', user: ghUser('octocat') })
    expect(realAuthor.body).toBe('**Alice**\n\nhello')

    const emptyLoginAuthor = parseCommentIdentity(reviewComment('', '**Alice**\n\nhello'), '')
    expect(emptyLoginAuthor.identity).toEqual({ kind: 'github', user: ghUser('') })
    expect(emptyLoginAuthor.body).toBe('**Alice**\n\nhello')
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
    const parsed = parseCommentIdentity(reviewComment(BOT_LOGIN, body), BOT_LOGIN)
    expect(parsed.identity).toEqual({
      kind: 'human',
      name: author.name,
      role: author.role,
    })
    expect(parsed.body).toBe(markdown)
  })

  it('round-trips the lead role too', () => {
    const author = human('Bob', 'lead')
    const parsed = parseCommentIdentity(reviewComment(BOT_LOGIN, prefixBody(author, 'x')), BOT_LOGIN)
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
    expect(identityName({ kind: 'bot', user: ghUser(BOT_LOGIN) })).toBe(BOT_LOGIN)
  })
})

describe('isOwnComment id-map branch (broker write log)', () => {
  it('is true when the write log attributes the comment id to the session human', () => {
    // The write log keys on Human.id, so this holds regardless of the smuggled
    // name — even when the body carries a DIFFERENT (stale) display name.
    const comment = reviewComment(BOT_LOGIN, prefixBody(human('Stale Name'), 'mine'))
    const me = { ...human('Whatever'), id: 'h-alice' }
    expect(
      isOwnComment(comment, {
        human: me,
        commentAuthors: { [comment.id]: 'h-alice' },
        botLogin: BOT_LOGIN,
      }),
    ).toBe(true)
  })

  it('is false when the write log attributes the comment id to a different human', () => {
    const comment = reviewComment(BOT_LOGIN, prefixBody(human('Alice'), 'theirs'))
    const me = { ...human('Alice'), id: 'h-alice' }
    expect(
      isOwnComment(comment, {
        human: me,
        commentAuthors: { [comment.id]: 'h-bob' },
        botLogin: BOT_LOGIN,
      }),
    ).toBe(false)
  })

  it('takes precedence over the smuggled name (the map wins on a rename)', () => {
    // Name says Alice, but the log says h-bob authored it: the log is truth.
    const comment = reviewComment(BOT_LOGIN, prefixBody(human('Alice'), 'x'))
    const alice = { ...human('Alice'), id: 'h-alice' }
    expect(
      isOwnComment(comment, {
        human: alice,
        commentAuthors: { [comment.id]: 'h-bob' },
        botLogin: BOT_LOGIN,
      }),
    ).toBe(false)
  })
})

describe('isOwnComment name-fallback branch (write log absent)', () => {
  it('is true when the parsed human name matches and no map covers the comment', () => {
    const body = prefixBody(human('Alice'), 'mine')
    expect(
      isOwnComment(reviewComment(BOT_LOGIN, body), {
        human: human('Alice'),
        botLogin: BOT_LOGIN,
      }),
    ).toBe(true)
  })

  it('is true via the name fallback when the map is present but silent on this comment', () => {
    // commentAuthors exists but has no entry for THIS comment id — detection
    // must fall through to the name match rather than treating it as not-yours.
    const body = prefixBody(human('Alice'), 'mine')
    const comment = reviewComment(BOT_LOGIN, body)
    expect(
      isOwnComment(comment, {
        human: human('Alice'),
        commentAuthors: { 999999: 'h-someone-else' },
        botLogin: BOT_LOGIN,
      }),
    ).toBe(true)
  })

  it('is false when a broker comment resolves to a different human name', () => {
    const body = prefixBody(human('Bob'), 'theirs')
    expect(
      isOwnComment(reviewComment(BOT_LOGIN, body), {
        human: human('Alice'),
        botLogin: BOT_LOGIN,
      }),
    ).toBe(false)
  })

  it('is false for a real GitHub (non-broker) comment', () => {
    // Even a body that looks prefixed stays github-kind for a real login.
    const comment = reviewComment('octocat', '**Alice**\n\nx')
    expect(isOwnComment(comment, { human: human('Alice'), botLogin: BOT_LOGIN })).toBe(false)
  })

  it('is false for a bot comment with no parseable prefix', () => {
    const comment = reviewComment(BOT_LOGIN, 'plain body')
    expect(isOwnComment(comment, { human: human('Alice'), botLogin: BOT_LOGIN })).toBe(false)
  })
})

describe('isOwnComment direct-mode branch (viewer login, no write log)', () => {
  it('is true when the comment author login equals the viewer login', () => {
    // Direct GitHub connection: no broker, no smuggled prefix — the real login
    // is trustworthy, so "yours" is a login comparison.
    const comment = reviewComment('alice-gh', 'a plain comment from github.com')
    expect(
      isOwnComment(comment, {
        human: human('Alice'),
        botLogin: '',
        viewerLogin: 'alice-gh',
      }),
    ).toBe(true)
  })

  it('is false when the comment author login differs from the viewer login', () => {
    const comment = reviewComment('someone-else', 'not mine')
    expect(
      isOwnComment(comment, {
        human: human('Alice'),
        botLogin: '',
        viewerLogin: 'alice-gh',
      }),
    ).toBe(false)
  })

  it('the write log still wins over the viewer login when it names the comment', () => {
    // Both signals present: the authoritative write log takes precedence.
    const comment = reviewComment('alice-gh', 'x')
    const me = { ...human('Alice'), id: 'h-alice' }
    expect(
      isOwnComment(comment, {
        human: me,
        commentAuthors: { [comment.id]: 'h-bob' },
        botLogin: '',
        viewerLogin: 'alice-gh',
      }),
    ).toBe(false)
  })
})

describe('isOwnComment survives a Coder username rename', () => {
  it('still resolves via the write log after the human display name changes', () => {
    // Ground truth: Alice authored this comment. The broker stamped her
    // then-current display name into the body and logged her stable id.
    const originalName = 'alice2'
    const authored = reviewComment(BOT_LOGIN, prefixBody(human(originalName), 'mine'))
    const writeLog = { [authored.id]: 'h-alice' }

    // Coder renames Alice AFTER the comment exists: her display name is now
    // something entirely different, so the smuggled prefix is stale.
    const renamedAlice: Human = { ...human('Alice Tan-Rivera'), id: 'h-alice' }

    // Name-matching alone would fail (the body still says "alice2"), but the
    // write log keys on the stable id, so "yours" still resolves.
    expect(
      isOwnComment(authored, {
        human: renamedAlice,
        commentAuthors: writeLog,
        botLogin: BOT_LOGIN,
      }),
    ).toBe(true)

    // And the failure the id map fixes: with NO write log, the stale name no
    // longer matches the renamed human — the exact regression this guards.
    expect(
      isOwnComment(authored, { human: renamedAlice, botLogin: BOT_LOGIN }),
    ).toBe(false)
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

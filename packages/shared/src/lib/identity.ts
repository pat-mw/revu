import type { GhUser, Human, ReviewComment } from '../api/types'

/**
 * Identity smuggling: comments written through revu are posted by the broker
 * bot with the human's name prepended to the markdown body:
 *
 *   **Alice Nguyen** (contractor)
 *
 *   Actually this should probably be a `Map` — …
 *
 * This module parses that prefix back out. It is deliberately defensive:
 * a body that merely starts with bold text is NOT necessarily a prefix.
 */

export type CommentIdentity =
  | { kind: 'human'; name: string; role: string | null }
  | { kind: 'github'; user: GhUser }
  /** Broker comment with no parseable prefix — rendered as the bot itself. */
  | { kind: 'bot'; user: GhUser }

export interface ParsedComment {
  identity: CommentIdentity
  /** Body with the identity prefix stripped (unchanged when no prefix parsed). */
  body: string
}

/**
 * `**Name**` optionally followed by ` (role)`, then a blank line, then content.
 * The blank line is load-bearing: `**Alice** hi` inline is regular markdown.
 */
const PREFIX_RE = /^\*\*([^*\n]{1,60})\*\*(?:[ \t]*\(([^)\n]{1,32})\))?[ \t]*\r?\n[ \t]*\r?\n([\s\S]*)$/

/**
 * A prefix name must look like a personal name: 1–4 tokens of letters
 * (any script), with hyphens/apostrophes/periods allowed inside tokens.
 * This is what rejects `**Warning**`-style bold openers… mostly. A comment
 * literally starting with `**Bob**\n\n` will parse — that ambiguity is
 * inherent to the smuggling scheme, and the broker owns the format.
 */
const NAME_TOKEN_RE = /^[\p{L}][\p{L}'’.-]{0,23}$/u

function looksLikePersonName(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/)
  if (tokens.length < 1 || tokens.length > 4) return false
  return tokens.every((t) => NAME_TOKEN_RE.test(t))
}

/** Parse a raw body. Only meaningful for broker-authored comments. */
export function parsePrefixedBody(
  body: string,
): { name: string; role: string | null; rest: string } | null {
  const m = PREFIX_RE.exec(body)
  if (!m) return null
  const name = m[1].trim()
  if (!looksLikePersonName(name)) return null
  return { name, role: m[2]?.trim() ?? null, rest: m[3] }
}

/**
 * Resolve who a comment is "from". Comments from real GitHub users (org
 * members reviewing on github.com) keep their genuine identity untouched —
 * prefix parsing only ever applies to the broker bot's comments. `botLogin`
 * is the login every workspace write authenticates as; it comes from the
 * session, so the same comment renders correctly whatever the broker is named.
 */
export function parseCommentIdentity(
  comment: {
    user: GhUser
    body: string
  },
  botLogin: string,
): ParsedComment {
  if (comment.user.login !== botLogin) {
    return { identity: { kind: 'github', user: comment.user }, body: comment.body }
  }
  const parsed = parsePrefixedBody(comment.body)
  if (!parsed) {
    return { identity: { kind: 'bot', user: comment.user }, body: comment.body }
  }
  return {
    identity: { kind: 'human', name: parsed.name, role: parsed.role },
    body: parsed.rest,
  }
}

/** Build the body the broker would post — the exact inverse of the parser. */
export function prefixBody(human: Human, markdown: string): string {
  return `**${human.name}** (${human.role})\n\n${markdown}`
}

/** Display name for any identity. */
export function identityName(identity: CommentIdentity): string {
  switch (identity.kind) {
    case 'human':
      return identity.name
    case 'github':
      return identity.user.login
    case 'bot':
      return identity.user.login
  }
}

/**
 * Whether a comment was written by the given session human. GitHub provides
 * no `viewer`, so "yours" is derived by matching the smuggled name — the only
 * signal that exists.
 */
export function isOwnComment(comment: ReviewComment, human: Human, botLogin: string): boolean {
  const { identity } = parseCommentIdentity(comment, botLogin)
  return identity.kind === 'human' && identity.name === human.name
}

// ————————————————————————————————————————————————————————————————
// Deterministic generated avatars — no gravatars behind locked-down egress.
// ————————————————————————————————————————————————————————————————

function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

export interface AvatarStyle {
  /** e.g. `hsl(210 42% 62%)` — tuned for legibility on the dark theme. */
  color: string
  background: string
  initials: string
}

/**
 * Hues avoid the semantic bands the app reserves: add-teal (150–180),
 * del-rust (10–40) and draft-violet (250–270) stay meaningful.
 */
const AVATAR_HUES = [205, 225, 330, 350, 95, 55, 285, 185]

export function avatarStyle(name: string): AvatarStyle {
  const hue = AVATAR_HUES[hashString(name) % AVATAR_HUES.length]
  const words = name.replace(/\[.*\]/g, '').trim().split(/[\s-]+/)
  const initials =
    words.length >= 2
      ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase()
  return {
    color: `hsl(${hue} 48% 72%)`,
    background: `hsl(${hue} 32% 24%)`,
    initials,
  }
}

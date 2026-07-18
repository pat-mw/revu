import type { GhUser, Human } from '../api/types'

/**
 * Derive the stable `Human.id` from a git-config email. The id is the email
 * lowercased and trimmed — nothing more — so it is a deterministic, stable key
 * for drafts, viewed state, and the audit log.
 *
 * Email, not display name, is the key on purpose: names driven by workspace
 * usernames are unique only per deployment at a point in time, and a username
 * can be renamed or a departed one re-registered, at which point a name-keyed
 * history silently reattributes. Lowercasing folds the case-insensitive local
 * part and domain of an address to one canonical key so the same person is one
 * id regardless of how their client cased the address. The email is never
 * rendered into a comment body — it is a key, not display copy.
 */
export function emailToId(email: string): string {
  return email.trim().toLowerCase()
}

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
 *
 * The name capture is wide enough for the longest legal stamped display name:
 * up to four tokens of the maximum single-token length plus their single-space
 * separators. It stays narrower than that would strictly allow so the capture
 * never truncates a name the token validator would otherwise accept, which
 * would make the stamper and this parser disagree at the boundary.
 */
const PREFIX_RE = /^\*\*([^*\n]{1,140})\*\*(?:[ \t]*\(([^)\n]{1,32})\))?[ \t]*\r?\n[ \t]*\r?\n([\s\S]*)$/

/**
 * A prefix name must look like a stamped identity: 1–4 tokens over the same
 * charset the broker allows in an author name — letters (any script), digits,
 * underscore, and hyphen — with apostrophes and periods also permitted inside
 * a token so real personal names survive. Coder usernames carry digits and
 * underscores (`alice2`, `j_doe`), so a letters-only rule would drop that
 * contractor's smuggled prefix and render every one of their comments as the
 * bare bot; the broker owns this format on both ends, so the parser tracks it.
 *
 * The token-count cap (1–4) and the per-token length cap are what keep
 * `**Warning**`-style bold openers and other markdown out — not the charset.
 * A comment literally starting with `**Bob**\n\n` still parses; that ambiguity
 * is inherent to the smuggling scheme.
 *
 * The per-token length cap tracks the broker's maximum username length of 32
 * characters (one leading character plus up to 31 more). A shorter cap would
 * drop a legitimately long username on the way back out — the stamper writes
 * it, so this parser must accept it — and render that contributor as the bare
 * bot; a longer cap would let more markdown through.
 */
const NAME_TOKEN_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_'’.-]{0,31}$/u

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
 *
 * `botLogin` is trusted config, but an empty string must never match a real
 * author: it takes the non-bot path so a misconfigured empty login can never
 * mis-attribute a genuine GitHub user (or an empty login) as the bot.
 */
export function parseCommentIdentity(
  comment: {
    user: GhUser
    body: string
  },
  botLogin: string,
): ParsedComment {
  if (botLogin === '' || comment.user.login !== botLogin) {
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

/** Everything `isOwnComment` needs to decide "is this comment mine?". */
export interface OwnCommentContext {
  /** The human currently driving the session. */
  human: Human
  /**
   * The broker's write log for this snapshot (comment id → author `Human.id`).
   * When it names this comment, it is authoritative and survives a rename;
   * absent or silent on a comment, detection falls back to the smuggled name.
   */
  commentAuthors?: Record<number, string>
  /** The bot login the broker writes as; also excludes bot comments from the login match. */
  botLogin: string
  /**
   * The login this session self-identifies as. Direct mode: the viewer's own
   * GitHub login — a comment is yours iff its real author login equals it.
   * Broker mode: the BOT's login (the session carries it for the write
   * self-guards), which must NOT be login-matched against bot-authored
   * comments — every human's mediated comment shares that author, so those
   * resolve via the write log or the smuggled name instead.
   */
  viewerLogin?: string
}

/**
 * Whether a comment was written by the session human. Three signals, checked in
 * order of trust:
 *
 * 1. The broker's write log (`commentAuthors[comment.id]`). This is ground
 *    truth: it keys on `Human.id`, so it stays correct across a Coder username
 *    rename or a reused username — the failures display-name matching cannot
 *    survive. Consulted first, and only when it actually names this comment.
 * 2. Login match (`viewerLogin` set, no write-log entry, and the comment NOT
 *    authored by the bot): yours iff `comment.user.login === viewerLogin`. In
 *    direct mode `botLogin` is `''` — no real author login equals it — so every
 *    comment takes this branch, and the real author login is trustworthy
 *    because GitHub is talked to directly. In broker mode the session carries
 *    the BOT's login as `viewerLogin` (the write self-guards need a self
 *    identity), while every mediated comment — EVERY human's — is also
 *    authored by that same bot; a login match there would claim every stamped
 *    comment as the session human's own. So bot-authored comments skip this
 *    signal entirely and fall through to 3, where the smuggled name is the
 *    only thing that distinguishes the humans behind the shared login.
 * 3. Name fallback: with no write-log entry and no login signal, the remaining
 *    signal is the name the broker smuggled into the body. This is the legacy
 *    behavior, kept so non-broker-logged comments still resolve.
 *
 * The write log wins whenever it names the comment, so a stale smuggled name
 * never overrides it.
 */
export function isOwnComment(
  comment: { id: number; user: GhUser; body: string },
  ctx: OwnCommentContext,
): boolean {
  const loggedAuthor = ctx.commentAuthors?.[comment.id]
  if (loggedAuthor !== undefined) {
    return loggedAuthor === ctx.human.id
  }
  if (
    ctx.viewerLogin !== undefined &&
    ctx.viewerLogin !== '' &&
    comment.user.login !== ctx.botLogin
  ) {
    return comment.user.login === ctx.viewerLogin
  }
  const { identity } = parseCommentIdentity(comment, ctx.botLogin)
  return identity.kind === 'human' && identity.name === ctx.human.name
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

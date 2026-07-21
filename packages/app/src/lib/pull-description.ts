/**
 * Resolve a pull request body into what a reader actually sees and who to
 * credit for it.
 *
 * Nothing here fetches: it is a reading of the body a snapshot already carries.
 */
import { parseCommentIdentity } from '@revu/shared'
import type { CommentIdentity, GhUser } from '@revu/shared'

export interface PullDescription {
  /**
   * Who wrote the description. A body written through the broker is posted by
   * the bot with the human smuggled into a prefix, so this is the person, not
   * the shared account, wherever the prefix parses.
   */
  identity: CommentIdentity
  /** The body to render: identity prefix stripped, outer whitespace trimmed. */
  body: string
  /** True when there is nothing to read — a different fact from "not synced". */
  isEmpty: boolean
}

/**
 * Emptiness is decided on the parsed body, never the raw one. A pull request
 * opened through the broker with no prose still arrives as a non-empty string
 * — the `**Name** (role)` prefix is always there — so testing the raw body
 * would call that a description and render a byline over blank space. A null
 * body, an empty one, and a whitespace-only one all land in the same place,
 * because to a reader they are the same fact.
 */
export function readPullDescription(
  pull: { user: GhUser; body: string | null },
  brokerLogin: string,
): PullDescription {
  const parsed = parseCommentIdentity(
    { user: pull.user, body: pull.body ?? '' },
    brokerLogin,
  )
  const body = parsed.body.trim()
  return { identity: parsed.identity, body, isEmpty: body === '' }
}

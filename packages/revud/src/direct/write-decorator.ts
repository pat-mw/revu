import type { Human, Session } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import type { DirectStore } from './store'

/**
 * How a write is dressed before it reaches GitHub, and what is recorded after.
 *
 * This is the second strategy seam that lets one shared write core serve every
 * deployment mode (the first is the `TokenSource`). Under the shared-identity
 * broker every GitHub call posts as the same bot, so a write must smuggle the
 * human's display name into the comment body (`decorateBody`) and the broker must
 * append the GitHub-assigned id to an append-only audit log (`recordWrite`) —
 * ground truth for "who wrote this" that survives a Coder username rename. In
 * direct mode the human authenticates to GitHub for real, so there is nothing to
 * smuggle and no separate audit to keep: both operations are the identity.
 *
 * The write core is unaware of the difference. It calls `decorateBody` on every
 * body it is about to POST and `recordWrite` after every successful write; the
 * injected strategy decides whether either does anything. Keeping the seam here
 * — not inline `if (mode === …)` branches in the write path — is what lets a
 * later broker mode land stamping and logging as one small file without touching
 * submit/reply/resolve/react.
 */
export interface WriteDecorator {
  /**
   * Transform a comment/review body before it is POSTed. Direct mode returns it
   * unchanged (the human posts as themselves); a broker decorator prepends the
   * smuggled `**name** (role)` prefix. Called for the review body and for every
   * pending comment's body, so a decorator that stamps stamps them all.
   */
  decorateBody(body: string): string

  /**
   * Record a completed write against GitHub, keyed by the id GitHub assigned
   * plus the endpoint that produced it and the pull request it landed on — the
   * metadata an audit row needs to answer "who wrote what, where". Direct mode
   * is a no-op (GitHub's own author attribution is the record); a broker
   * decorator appends the id + meta to its append-only audit journal. Called
   * only after a confirmed successful write, once per created/mutated id.
   */
  recordWrite(githubId: number, meta: { endpoint: string; pr: number }): void

  /**
   * Declares this decorator safe to serve BROKER writes through: true ONLY for
   * the broker decorator, which both stamps every body with the human's
   * smuggled prefix AND appends every confirmed write to the durable audit
   * journal. The api surfaces this as its own `brokerWritesEnabled` capability
   * and the router opens the broker write routes on THAT — never on session
   * shape — so a broker assembly cannot be write-enabled over a passthrough
   * decorator: an unstamped, unjournaled write as the shared bot is
   * structurally unreachable. Absence fails closed (treated as false).
   */
  readonly brokerWritesEnabled?: boolean
}

/**
 * The direct-mode `WriteDecorator`: a pure passthrough.
 *
 * `decorateBody` returns the body verbatim — no `prefixBody`, so the comment
 * posts exactly as the human typed it and GitHub attributes it to the real
 * authenticated user. `recordWrite` does nothing with the id or its meta — there
 * is no separate write log in direct mode, because GitHub's own attribution IS
 * the log, and an email must never be written into a comment body or a side
 * channel here.
 *
 * The `human` is accepted for symmetry with a stamping decorator (which needs the
 * display name) and to make the seam's shape identical across modes; direct mode
 * ignores it, which is exactly the point — identity is cosmetic here.
 */
export function createDirectWriteDecorator(human: Human): WriteDecorator {
  void human
  return {
    decorateBody(body: string): string {
      return body
    },
    recordWrite(): void {
      // No audit log in direct mode: the authenticated GitHub user is the
      // record, so the id and its endpoint/pr meta are deliberately discarded.
    },
    // A passthrough neither stamps nor journals, so it must never carry the
    // broker write routes: explicit false keeps the capability fail-closed.
    brokerWritesEnabled: false,
  }
}

/**
 * A stamping `WriteDecorator` — provided as the concrete counterpart the seam
 * exists for, though direct mode never selects it. `decorateBody` prepends the
 * canonical smuggled prefix via the shared `prefixBody` (the exact inverse of the
 * body parser), so a shared-identity write renders under the human's display
 * name. `recordWrite` is delegated to an injected sink — id plus the
 * endpoint/pr meta the audit row carries — so the audit journal's storage stays
 * outside this pure formatter. An empty body is left empty (a review with no
 * body must not become a bare prefix).
 */
export function createStampingWriteDecorator(
  human: Human,
  recordWrite: (githubId: number, meta: { endpoint: string; pr: number }) => void,
): WriteDecorator {
  return {
    decorateBody(body: string): string {
      return body.trim().length > 0 ? prefixBody(human, body) : body
    },
    recordWrite,
  }
}

/**
 * The broker-mode `WriteDecorator`: the stamping formatter above composed with
 * the durable audit journal. Every non-empty body posts under the human's
 * smuggled `**name** (role)` prefix, and every confirmed write appends one
 * `audit_log` row: the GitHub-assigned id keyed to `session.human.id` (the
 * lowercased git-config email — a LOCAL journal key that never enters a posted
 * body), the session's workspace, the endpoint that produced the write, the
 * pull request it landed on, and an ISO-8601 UTC timestamp. `appendAudit` is
 * durable and never swallows a failure, so a write that reached GitHub but
 * could not be journaled surfaces as a typed store error rather than becoming
 * a silently unattributed write. `now` is injectable for deterministic tests.
 *
 * This is the ONLY decorator that declares `brokerWritesEnabled`: it alone
 * guarantees both halves — stamping AND the durable journal — so it alone may
 * carry the api capability the router opens broker writes on. The bare
 * stamping decorator above does not declare it (its `recordWrite` is whatever
 * sink was injected, with no durability guarantee).
 */
export function createBrokerWriteDecorator(
  session: Session,
  store: Pick<DirectStore, 'appendAudit'>,
  now: () => string = () => new Date().toISOString(),
): WriteDecorator {
  return {
    ...createStampingWriteDecorator(session.human, (githubId, meta) => {
      store.appendAudit({
        githubId,
        humanId: session.human.id,
        workspace: session.workspace,
        endpoint: meta.endpoint,
        pr: meta.pr,
        createdAt: now(),
      })
    }),
    brokerWritesEnabled: true,
  }
}

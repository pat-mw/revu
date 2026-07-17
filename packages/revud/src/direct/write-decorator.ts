import type { Human } from '@revu/shared'
import { prefixBody } from '@revu/shared'

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
   * Record a completed write against GitHub, keyed by the id GitHub assigned.
   * Direct mode is a no-op (GitHub's own author attribution is the record); a
   * broker decorator appends `{ commentId → human.id }` to its audit log. Called
   * only after a confirmed successful write, once per created comment/review id.
   */
  recordWrite(githubId: number): void
}

/**
 * The direct-mode `WriteDecorator`: a pure passthrough.
 *
 * `decorateBody` returns the body verbatim — no `prefixBody`, so the comment
 * posts exactly as the human typed it and GitHub attributes it to the real
 * authenticated user. `recordWrite` does nothing — there is no separate write log
 * in direct mode, because GitHub's own attribution IS the log, and an email must
 * never be written into a comment body or a side channel here.
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
      // No audit log in direct mode: the authenticated GitHub user is the record.
    },
  }
}

/**
 * A stamping `WriteDecorator` — provided as the concrete counterpart the seam
 * exists for, though direct mode never selects it. `decorateBody` prepends the
 * canonical smuggled prefix via the shared `prefixBody` (the exact inverse of the
 * body parser), so a shared-identity write renders under the human's display
 * name. `recordWrite` is delegated to an injected sink so the audit log's storage
 * stays outside this pure formatter. An empty body is left empty (a review with
 * no body must not become a bare prefix).
 */
export function createStampingWriteDecorator(
  human: Human,
  recordWrite: (githubId: number) => void,
): WriteDecorator {
  return {
    decorateBody(body: string): string {
      return body.trim().length > 0 ? prefixBody(human, body) : body
    },
    recordWrite,
  }
}

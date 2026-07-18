import { emailToId } from '@revu/shared'

/**
 * The `coder.owner` → email identity binding: the host-side mapping from the
 * one channel-authentic identity signal to the canonical audit/store key.
 *
 * TRUST BOUNDARY — display identity vs audit identity. A workspace container
 * self-reports plenty of identity: git-config `user.email` / `user.name`,
 * request headers, anything revud in the workspace chooses to say. All of it
 * lives on the contractor's side of the boundary — the contractor has
 * passwordless sudo in their own container and can set any of it to any value.
 * That identity is DISPLAY-ONLY: fine to render, never to be trusted for
 * attribution. The ONLY identity signal that crosses the boundary intact is
 * the container's `coder.owner` label: it is set by the host-owned workspace
 * template (with zero contractor-editable parameters), and the host-side
 * collector reads it off the container it is pulling from — the workspace
 * never gets a chance to claim it. Audit rows, durable per-human state, and
 * draft-access authorization must key off THIS binding and nothing the
 * workspace reports. In one rule: display identity = workspace-reported,
 * spoofable; audit/store identity = the `coder.owner` binding resolved here,
 * host-authenticated, the only trustworthy key.
 *
 * The canonical key is an email because the durable store keys `human_id` by
 * `emailToId(email)` (lowercased, trimmed): usernames can be renamed or
 * re-registered, at which point a username-keyed history silently
 * reattributes. This module therefore maps the channel-authentic username to
 * that canonical email key.
 *
 * Normalization contract:
 * - Emails are normalized through `emailToId` ONCE, at construction time, so
 *   every binding this resolver hands out already carries the canonical store
 *   key — `resolve` never returns a raw, un-normalized email.
 * - `coder.owner` keys match EXACTLY (case-sensitive): Coder usernames are
 *   exact identifiers, and case-folding two distinct usernames onto one
 *   binding would be an identity merge. Both the map's keys and the lookup
 *   input are trimmed of surrounding whitespace (whitespace is never part of
 *   a username; a stray space must not split one identity in two), but no
 *   other folding is applied.
 * - An empty or whitespace-only lookup NEVER resolves. Unknown owners return
 *   `null` — a caller must treat that as "no identity", never invent one.
 *
 * The resolver is pure and deterministic: no I/O, no environment reads, and
 * the map is snapshotted at construction (later mutation of the input object
 * does not change what resolves). Returned bindings — and the resolver object
 * itself — are frozen so a caller cannot poison what another caller receives.
 */

export interface CoderOwnerBinding {
  /** The channel-authentic Coder username (container label). */
  coderOwner: string
  /** Canonical audit/store key — an email normalized via emailToId (lowercased, trimmed). */
  email: string
  /** Display-only human name, when the map carries one. */
  displayName?: string
}

export interface CoderOwnerResolver {
  /**
   * Resolve a channel-authentic coder.owner to its canonical binding.
   * Returns null for an unknown owner — NEVER fabricate an identity.
   */
  resolve(coderOwner: string): CoderOwnerBinding | null
}

/**
 * Build an in-memory resolver from a host-side map keyed by `coder.owner`.
 * This is the injected implementation used behind the `CoderOwnerResolver`
 * seam; a deployment backs the same interface with its real host-side owner
 * registry.
 *
 * The map is trusted host-side configuration, so misconfiguration fails FAST
 * at construction rather than silently at resolve time — a silently
 * unresolvable owner would drop that human from collection without a trace,
 * and a silent identity merge would let two people share one audit/draft key.
 * Construction throws on: an empty/whitespace-only owner key; a missing or
 * non-string email, or one that normalizes to the empty string; two keys that
 * collapse to the same trimmed owner; two keys that collide case-insensitively
 * (a Coder username is unique case-insensitively, so the second is dead config
 * that would silently drop that human); and two distinct owners whose emails
 * normalize to the same key (an identity merge — two humans would share one
 * durable-store/audit key). A genuine one-person-two-accounts case is served by
 * giving each account its own email, never by pointing two owners at one.
 *
 * Entries are copied into a `Map` at construction: lookups never touch an
 * object prototype chain, so owner strings like `"__proto__"` or
 * `"constructor"` cannot resolve to anything but an explicit map entry.
 */
export function createMapCoderOwnerResolver(
  map: Record<string, { email: string; displayName?: string }>,
): CoderOwnerResolver {
  const bindings = new Map<string, CoderOwnerBinding>()
  // Owner uniqueness is enforced case-insensitively (usernames are unique that
  // way) even though lookup stays case-sensitive; email uniqueness catches a
  // config that would silently merge two humans onto one store/audit key.
  const ownerByFold = new Map<string, string>()
  const ownerByEmail = new Map<string, string>()
  for (const [rawOwner, entry] of Object.entries(map)) {
    const coderOwner = rawOwner.trim()
    if (coderOwner === '') {
      throw new Error('identity-binding map: empty coder.owner key')
    }
    if (bindings.has(coderOwner)) {
      throw new Error(
        `identity-binding map: duplicate coder.owner key after trimming: ${coderOwner}`,
      )
    }
    const fold = coderOwner.toLowerCase()
    const foldClash = ownerByFold.get(fold)
    if (foldClash !== undefined) {
      throw new Error(
        `identity-binding map: coder.owner keys collide case-insensitively: ${foldClash}, ${coderOwner}`,
      )
    }
    const rawEmail = (entry as { email?: unknown } | null | undefined)?.email
    if (typeof rawEmail !== 'string') {
      throw new Error(`identity-binding map: missing or non-string email for coder.owner ${coderOwner}`)
    }
    const email = emailToId(rawEmail)
    if (email === '') {
      throw new Error(`identity-binding map: empty email for coder.owner ${coderOwner}`)
    }
    const emailClash = ownerByEmail.get(email)
    if (emailClash !== undefined) {
      // Name the two owner keys (host-config coordinates), NOT the email: this
      // message can reach operator logs via the host-CLI config loader, and the
      // colliding email is a person's address — the keys alone locate the fix.
      throw new Error(
        `identity-binding map: two coder.owner keys map to one email (identity merge): ` +
          `${emailClash}, ${coderOwner}`,
      )
    }
    const rawName = entry.displayName
    const displayName = typeof rawName === 'string' && rawName.trim() !== '' ? rawName : undefined
    const binding: CoderOwnerBinding =
      displayName === undefined ? { coderOwner, email } : { coderOwner, email, displayName }
    bindings.set(coderOwner, Object.freeze(binding))
    ownerByFold.set(fold, coderOwner)
    ownerByEmail.set(email, coderOwner)
  }
  return Object.freeze({
    resolve(coderOwner: string): CoderOwnerBinding | null {
      // A missing container label arrives here as a non-string at runtime; fail
      // closed to `null` (no identity) rather than throwing and aborting a tick.
      if (typeof coderOwner !== 'string') return null
      const key = coderOwner.trim()
      if (key === '') return null
      return bindings.get(key) ?? null
    },
  })
}

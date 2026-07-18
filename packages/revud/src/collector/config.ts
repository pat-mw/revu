import { readFileSync } from 'node:fs'
import type { HostStore } from './host-store'
import { openHostStore } from './host-store'
import type { CoderOwnerResolver } from './identity-binding'
import { createMapCoderOwnerResolver } from './identity-binding'

/**
 * Shared configuration for the host-side operator CLIs (offboarding, audit
 * export, and whatever else runs on the host against the durable store): one
 * place that builds the `coder.owner` → email resolver and opens the host
 * store from the environment, so every CLI authorizes through the same
 * binding.
 *
 * The owner map is read from a JSON file named by `REVU_OWNER_MAP_FILE`,
 * shaped `Record<string, { email: string; displayName?: string }>` and keyed
 * by `coder.owner`. The file is a host-side stand-in source: a deployment
 * backs the same `CoderOwnerResolver` seam with its real owner registry (the
 * host's workspace-to-owner map or the Coder API) without the CLIs changing.
 *
 * Error discipline: every configuration failure throws
 * `OwnerMapConfigError` with a self-contained, operator-actionable message —
 * naming the env var or file path and a sanitized reason, NEVER echoing file
 * content. In particular a JSON parse failure is reported without the parser's
 * own message, because `JSON.parse` errors can quote the malformed input and
 * this error may end up in logs.
 */

/** A host-CLI configuration problem: a clear operator message, no file content. */
export class OwnerMapConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnerMapConfigError'
  }
}

/**
 * Build the `CoderOwnerResolver` from the JSON owner map named by
 * `REVU_OWNER_MAP_FILE`. Throws `OwnerMapConfigError` when the variable is
 * unset, the file cannot be read, the content is not valid JSON, the parsed
 * value is not a plain object, or the map itself is invalid (the
 * identity-binding constructor's fail-fast checks: empty keys, missing
 * emails, duplicate owners, identity merges).
 */
export function loadOwnerResolver(
  env: Record<string, string | undefined> = process.env,
): CoderOwnerResolver {
  const path = env.REVU_OWNER_MAP_FILE
  if (path === undefined || path.trim().length === 0) {
    throw new OwnerMapConfigError(
      'REVU_OWNER_MAP_FILE is not set. Point it at the host-side JSON owner map ' +
        '(a JSON object of coder.owner -> { email, displayName? }) so owners can be ' +
        'resolved to their canonical identity.',
    )
  }
  const file = path.trim()

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    // The path and OS error code are operator-supplied coordinates, safe to
    // name; nothing from the file itself is available or echoed.
    const code = (err as { code?: unknown }).code
    const suffix = typeof code === 'string' ? ` (${code})` : ''
    throw new OwnerMapConfigError(
      `owner map file could not be read: ${file}${suffix}. ` +
        'Check that REVU_OWNER_MAP_FILE names a readable JSON file.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Deliberately no parse detail: JSON.parse error messages can quote the
    // malformed content, and this message must stay safe to log.
    throw new OwnerMapConfigError(`owner map file is not valid JSON: ${file}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OwnerMapConfigError(
      `owner map file must be a JSON object of coder.owner -> { email, displayName? }: ${file}`,
    )
  }

  try {
    return createMapCoderOwnerResolver(
      parsed as Record<string, { email: string; displayName?: string }>,
    )
  } catch (err) {
    // The binding constructor fails fast on a misconfigured map with messages
    // that name the offending owner key — surface that reason under this
    // module's config-error type so CLIs handle one error family.
    const reason = err instanceof Error ? err.message : String(err)
    throw new OwnerMapConfigError(`owner map file ${file}: ${reason}`)
  }
}

/**
 * Open the host store configured entirely from the environment: the owner map
 * via `REVU_OWNER_MAP_FILE` (see `loadOwnerResolver`) and the data directory
 * via `REVU_HOST_DATA_DIR` / `XDG_DATA_HOME` (resolved inside the store).
 * The caller owns the handle and must `close()` it.
 */
export function openHostStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): HostStore {
  return openHostStore({ resolver: loadOwnerResolver(env), env })
}

/**
 * Operator CLI: offboard a departed human's host-side durable state.
 *
 * Purges the human's working state (drafts + per-PR viewed rows) from the
 * host store while RETAINING every audit row — the journal is the permanent
 * compliance record of what they did through the shared bot identity and is
 * never deleted. Prints the resulting `OffboardResult` counts as JSON to
 * stdout; `auditRetained` is read after the purge, proving the journal
 * survived it.
 *
 * ORDERING: run this while the departing owner is still present in the owner
 * map — i.e. BEFORE removing their entry from the host's owner registry —
 * because the purge is keyed by resolving `coder.owner` through that binding.
 * Once the entry is gone the owner no longer resolves and this exits with an
 * error, having purged nothing.
 *
 * Configuration is by environment:
 *   REVU_OWNER_MAP_FILE   path to the JSON owner map (coder.owner -> { email, displayName? })
 *   REVU_HOST_DATA_DIR    optional host-store data dir override (else the XDG default)
 *
 * Usage: bun run scripts/broker-offboard.ts --owner <coder.owner>
 */
import { OwnerMapConfigError, openHostStoreFromEnv } from '../packages/revud/src/collector/config'
import { UnboundOwnerError } from '../packages/revud/src/collector/host-store'
import { offboardHuman } from '../packages/revud/src/collector/offboard'

function parseOwner(argv: readonly string[]): string | null {
  const at = argv.indexOf('--owner')
  if (at === -1) return null
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) return null
  const owner = value.trim()
  return owner.length > 0 ? owner : null
}

const owner = parseOwner(process.argv.slice(2))
if (owner === null) {
  console.error('usage: bun run scripts/broker-offboard.ts --owner <coder.owner>')
  process.exit(2)
}

try {
  const store = openHostStoreFromEnv()
  try {
    const result = offboardHuman(store, owner)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
} catch (err) {
  if (err instanceof OwnerMapConfigError || err instanceof UnboundOwnerError) {
    // Both carry self-contained operator messages (no file content, no row
    // contents) — print the message, not a stack trace.
    console.error(err.message)
    process.exit(1)
  }
  throw err
}

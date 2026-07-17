import type { FixtureDB, FixtureSeeds } from './contract'
import { BROKER_BOT, DEFAULT_HUMAN_ID, HUMANS, ORG_MEMBERS, REPO } from './cast'
import { pr101 } from './prs/pr101-cache-ttl'
import { pr204, pr204Seeds } from './prs/pr204-ingestion'
import { pr312, pr312Seeds } from './prs/pr312-rate-limiting'
import { pr347, pr347Seeds } from './prs/pr347-usage-metering'
import { pr355 } from './prs/pr355-node-runtime'
import { pr362, pr362Seeds } from './prs/pr362-strict-null'
import { pr389, pr389Seeds } from './prs/pr389-token-refresh'
import { pr401 } from './prs/pr401-otel'
import { pr410, pr410Seeds } from './prs/pr410-retention-sweep'
import { pr415, pr415Seeds } from './prs/pr415-webhook-signatures'

/**
 * The assembled fixture database consumed by the mock adapter: every remote
 * pull in PR-number order plus the pre-seeded broker-side state (snapshots,
 * drafts, viewed files, orphaned blobs) contributed by individual PR modules.
 * PRs without seeds are the first-sync demonstrations — the adapter must see
 * them as never-synced.
 */

const allSeeds: FixtureSeeds[] = [
  pr204Seeds,
  pr312Seeds,
  pr347Seeds,
  pr362Seeds,
  pr389Seeds,
  pr410Seeds,
  pr415Seeds,
]

/** Concatenate one optional seed array across every contributing module. */
function collect<T>(pick: (seeds: FixtureSeeds) => T[] | undefined): T[] {
  return allSeeds.flatMap((seeds) => pick(seeds) ?? [])
}

export const fixtureDB: FixtureDB = {
  repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  humans: HUMANS,
  defaultHumanId: DEFAULT_HUMAN_ID,
  orgMembers: ORG_MEMBERS,
  brokerBot: BROKER_BOT,
  pulls: [pr101, pr204, pr312, pr347, pr355, pr362, pr389, pr401, pr410, pr415],
  seededSnapshots: collect((s) => s.snapshots),
  seededDrafts: collect((s) => s.drafts),
  seededViewed: collect((s) => s.viewed),
  seededBlobs: collect((s) => s.blobs),
}

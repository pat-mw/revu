import type { HostStore } from './host-store'

/**
 * Host-side offboarding hook for a departing human's durable state. The
 * sandbox teardown (suspend, delete the workspace, remove the owner-registry
 * entry, delete the Coder user) destroys everything inside the workspace; this
 * hook is the one step that touches the HOST store, and it has exactly two
 * obligations:
 *
 *  - RETAIN the audit journal. The journal is the permanent compliance record
 *    of what the departing human did through the shared bot identity — it must
 *    outlive their departure, and offboarding never deletes a row of it.
 *  - PURGE the working state. Drafts and per-PR viewed rows are the human's
 *    working state; the operating agreement requires wiping it when they
 *    leave, and a wiped keyspace also guarantees a later re-onboarding of the
 *    same identity starts clean, with no stale drafts attributed to the new
 *    engagement.
 *
 * ORDERING CONSTRAINT — run this while the departing owner is STILL PRESENT
 * in the host-side identity binding, i.e. BEFORE their entry is removed from
 * the owner registry the resolver reads. Both the purge and the retention
 * count work by resolving `coder.owner` through that binding to the canonical
 * email key; once the binding entry is gone there is no way to resolve the
 * departing human's email, and the store fails loud with `UnboundOwnerError`
 * (nothing purged, nothing counted). Teardown of the rest of the human's
 * footprint — including removing them from the owner registry — must
 * therefore happen only AFTER this hook has completed.
 *
 * The key is the human's CURRENT email in the binding: editing an owner's
 * mapped email mid-engagement strands their earlier rows under the old email,
 * so a later purge keyed by the new email leaves those behind. An email change
 * is a re-identification, not a rename — migrate or purge the old key first.
 */

export interface OffboardResult {
  /** The channel-authentic owner label the offboarding was keyed by. */
  coderOwner: string
  /** How many draft rows were deleted. */
  draftsPurged: number
  /** How many per-PR viewed rows were deleted. */
  viewedPurged: number
  /**
   * How many audit rows this human still has AFTER the purge — the operator's
   * proof that the compliance journal survived the wipe.
   */
  auditRetained: number
}

/**
 * Offboard one human: purge their working state (drafts + viewed, atomically,
 * via the store's single-transaction purge) and report how many audit rows
 * remain for them. An owner the resolver does not know throws
 * `UnboundOwnerError` before anything is touched — see the ordering
 * constraint above.
 */
export function offboardHuman(store: HostStore, coderOwner: string): OffboardResult {
  // Purge FIRST, count SECOND. `purgeWorkingState` deletes drafts + viewed in
  // one transaction and by contract never touches the audit journal; counting
  // the audit rows AFTER it returns makes `auditRetained` evidence that the
  // journal actually survived the purge, not a snapshot from before it.
  const { draftsPurged, viewedPurged } = store.purgeWorkingState(coderOwner)
  const auditRetained = store.listAuditForOwner(coderOwner).length
  return { coderOwner, draftsPurged, viewedPurged, auditRetained }
}

import type {
  FileBlob,
  FileViewedState,
  HumanPreferences,
  ReviewDraft,
  Session,
  Snapshot,
} from '@revu/shared'
import { ApiError } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GithubClient } from './github-client'
import type { RepoRef } from './repo'
import type { DirectStore } from './store'
import { syncPull as runSyncPull } from './sync'

/**
 * The direct-mode read/persist surface the router dispatches to. It is the small
 * shared core the integration guide describes — sync engine, snapshot store,
 * draft store — bound to one injected `GithubClient` (whose `TokenSource` is the
 * only strategy that differs by deployment mode) and one durable `DirectStore`.
 *
 * The write path (submitReview, replyToThread, resolveThread, addReaction) and
 * the GraphQL thread read are NOT here: they are separate concerns that land
 * later. This surface covers exactly the routes direct mode answers today —
 * sync, snapshot, drafts, viewed, preferences — plus a blob read that is a store
 * lookup (the byte-transfer path is separate).
 *
 * The session is captured once and used to key per-human state (drafts, viewed,
 * preferences) by `session.human.id` — the git-config email — never by any
 * client-supplied value.
 */
export interface DirectApi {
  /** Run the burst sync and persist; may resolve a `partial` snapshot. */
  syncPull(prNumber: number): Promise<Snapshot>
  /** The cached snapshot, or `null` when the PR was never synced (not an error). */
  getSnapshot(prNumber: number): Snapshot | null

  /**
   * A content-addressed blob from the store. Blob bytes are provisioned during
   * `syncPull` (local git first, then the API), so a synced PR's blobs are all
   * present. A SHA absent from the store throws a typed `not_found` `ApiError` —
   * NEVER a fabricated blob — matching the mock oracle: the client must re-sync,
   * not render invented bytes.
   */
  getBlob(sha: string): FileBlob

  getDraft(prNumber: number): ReviewDraft | null
  saveDraft(draft: ReviewDraft): ReviewDraft
  discardDraft(prNumber: number): void

  getFileViewed(prNumber: number): FileViewedState
  setFileViewed(
    prNumber: number,
    path: string,
    viewed: boolean,
    blobSha: string | null,
  ): FileViewedState

  getPreferences(): HumanPreferences
  setPreferences(patch: Partial<HumanPreferences>): HumanPreferences
}

export interface DirectApiDeps {
  session: Session
  github: GithubClient
  repo: RepoRef
  store: DirectStore
  /** Runs `git cat-file` for the local-first blob provider. Omit to skip local git. */
  runner?: CommandRunner
  /** The git clone directory the blob provider reads from; defaults to the process cwd. */
  cwd?: string
  /** Timestamp source; injectable for deterministic tests. */
  now?: () => string
}

/** Build the direct-mode API surface over an injected client + durable store. */
export function createDirectApi(deps: DirectApiDeps): DirectApi {
  const humanId = deps.session.human.id
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async syncPull(prNumber: number): Promise<Snapshot> {
      return runSyncPull(
        {
          github: deps.github,
          repo: deps.repo,
          store: deps.store,
          ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
          ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        },
        prNumber,
      )
    },

    getSnapshot(prNumber: number): Snapshot | null {
      return deps.store.getSnapshot(prNumber)
    },

    getBlob(sha: string): FileBlob {
      const blob = deps.store.getBlob(sha)
      if (blob === null) {
        // Never fabricate a blob: a SHA absent from the store means the byte
        // transfer never provisioned it, so the client must re-sync. This is the
        // same typed `not_found` the mock answers with.
        throw new ApiError(
          'not_found',
          `Blob ${sha} is not in the local snapshot store — re-sync this pull request to fetch it.`,
        )
      }
      return blob
    },

    getDraft(prNumber: number): ReviewDraft | null {
      return deps.store.getDraft(humanId, prNumber)
    },

    saveDraft(draft: ReviewDraft): ReviewDraft {
      // The draft is keyed by the session's human id, never by whatever id the
      // caller put in the body — a client cannot write another human's draft.
      const stored: ReviewDraft = { ...draft, humanId, updatedAt: now() }
      deps.store.putDraft(stored)
      return stored
    },

    discardDraft(prNumber: number): void {
      deps.store.deleteDraft(humanId, prNumber)
    },

    getFileViewed(prNumber: number): FileViewedState {
      return deps.store.getViewed(humanId, prNumber)
    },

    setFileViewed(
      prNumber: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): FileViewedState {
      const state = deps.store.getViewed(humanId, prNumber)
      state[path] = { viewed, blobSha, at: now() }
      deps.store.setViewed(humanId, prNumber, state)
      return state
    },

    getPreferences(): HumanPreferences {
      return deps.store.getPreferences(humanId)
    },

    setPreferences(patch: Partial<HumanPreferences>): HumanPreferences {
      return deps.store.setPreferences(humanId, patch)
    },
  }
}

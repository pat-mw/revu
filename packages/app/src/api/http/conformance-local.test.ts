/**
 * Conformance runner: drives the shared LOCAL-REVIEW conformance block — the
 * whole loop over a branch pair with no pull request behind it — against
 * revud-mock over REAL HTTP. The assertions live in `@revu/shared/conformance`
 * and are run identically against the in-process mock by a sibling runner, so
 * both transports are held to the same contract from one source of truth.
 *
 * What this leg adds over the in-process one is the two layers between the
 * reviewer and the store: the HTTP envelope and the client adapter. Everything
 * the block asserts has to survive being serialized, routed and validated back
 * into a typed value —
 *
 * - the moved head arrives as a RESOLVED `head_moved` result rather than an
 *   error status the adapter would rethrow as an `ApiError`;
 * - the never-synced snapshot arrives as `null` rather than a `404` the
 *   adapter would turn into a thrown `not_found`;
 * - `partial` arrives as a PRESENT key valued `null`, which is exactly what
 *   JSON drops when a serializer writes `undefined` instead;
 * - ids stay in the reserved review and entity bands, so nothing on the way
 *   through renumbers, truncates or stringifies them;
 * - comment bodies come back byte-for-byte, with no author stamp added by any
 *   layer in between.
 *
 * The restart carries the same weight it does anywhere else and one thing more:
 * the daemon is a separate process, so a draft written against a local review
 * id must be found again by a NEW process reading the on-disk broker document —
 * not by a store that merely stayed alive in memory.
 *
 * The daemon, its stub dist and its temp data dir come from the shared spawn
 * helper beside this file. The data dir is this suite's own, so the walk cannot
 * be derailed by whatever another `bun test` file's daemon wrote.
 *
 * Two config values are worth their reasons:
 *
 * - The branch pair is one nothing else in this workspace reviews. Creation is
 *   idempotent per pair, so a pair shared with another suite would hand this
 *   walk that suite's review — already synced, already carrying threads — and
 *   the "nothing synced yet" and "gained exactly one thread" assertions would
 *   be measuring the wrong review.
 * - The compare is declared EMPTY because nothing git-shaped stands behind the
 *   daemon's reused mock store: a runtime-created branch pair has no objects to
 *   diff, so the honest snapshot is the legal empty compare (merge base ==
 *   head, no files, no blobs, no commits) and a comment anchors wherever it
 *   says it does.
 */
import { afterAll, beforeAll, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLocalReviewConformanceSuite } from '@revu/shared/conformance'
import { createHttpApi } from './adapter'
import type { Daemon } from './conformance-daemon'
import { makeStubDist, startDaemon, stopDaemon } from './conformance-daemon'

let daemon: Daemon
let dataDir: string
let distDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-conf-local-data-'))
  distDir = makeStubDist()
  daemon = await startDaemon(dataDir, distDir)
})

afterAll(async () => {
  if (daemon) await stopDaemon(daemon)
  // Best-effort cleanup so temp dirs never accumulate across runs.
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  if (distDir) rmSync(distDir, { recursive: true, force: true })
})

describe('revud-mock over HTTP local review conformance', () => {
  runLocalReviewConformanceSuite({
    label: 'revud-mock over HTTP',
    makeApi: () => createHttpApi(daemon.base),
    // The daemon's own answer, so the drafts written here are keyed exactly
    // as its session keys them.
    humanId: async () => (await createHttpApi(daemon.base).getSession()).human.id,
    pair: { baseRef: 'main', headRef: 'feature/local-review-conformance' },
    anchor: { path: 'src/index.ts', line: 12, lineText: 'const x = compute()' },
    compare: 'empty',
    restart: async () => {
      // Restart against the SAME data dir so a new process must rehydrate the
      // draft from the on-disk broker document. The new process rebinds a
      // fresh port, so the returned adapter points at the new base.
      await stopDaemon(daemon)
      daemon = await startDaemon(dataDir, distDir)
      return createHttpApi(daemon.base)
    },
  })
})

/**
 * Conformance runner: drives the shared `RevuApi` conformance suite against
 * revud-mock over REAL HTTP. The assertions live in `@revu/shared/conformance`
 * and are run identically against the in-process mock by a sibling runner, so
 * both transports are held to the same contract from one source of truth.
 *
 * The daemon, its stub dist and its per-run temp data dir all come from the
 * shared spawn helper beside this file, which explains why each is shaped the
 * way it is. What belongs to THIS runner is what it points that daemon at: the
 * fixture pull numbers each scenario is driven against, and the transport's own
 * answer for a sync that dies mid-transfer.
 *
 * The restart hook — which the durability scenario drives — stops the daemon
 * and starts a new one against the SAME data dir, so a saved draft must reload
 * from the on-disk broker document. The daemon rebinds to a new port, so the
 * hook hands back a fresh `createHttpApi` pointed at the new base.
 */
import { afterAll, beforeAll, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expectPartialSyncThrows,
  runConformanceSuite,
  runLocalReviewDeleteConformance,
} from '@revu/shared/conformance'
import { createHttpApi } from './adapter'
import type { Daemon } from './conformance-daemon'
import { makeStubDist, startDaemon, stopDaemon } from './conformance-daemon'

let daemon: Daemon
let dataDir: string
let distDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-conf-data-'))
  distDir = makeStubDist()
  daemon = await startDaemon(dataDir, distDir)
})

afterAll(async () => {
  if (daemon) await stopDaemon(daemon)
  // Best-effort cleanup so temp dirs never accumulate across runs.
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  if (distDir) rmSync(distDir, { recursive: true, force: true })
})

describe('revud-mock over HTTP conformance', () => {
  runConformanceSuite({
    label: 'revud-mock over HTTP',
    makeApi: () => createHttpApi(daemon.base),
    scenarios: {
      baseline: 101,
      seededDraft: 312,
      baseAdvanced: 410,
      mutableDrift: 415,
      partialSync: 401,
      reconcile: 389,
    },
    restart: async () => {
      // Restart against the SAME data dir so the on-disk broker document must
      // rehydrate the saved draft. The new process rebinds a fresh port, so the
      // returned adapter points at the new base.
      await stopDaemon(daemon)
      daemon = await startDaemon(dataDir, distDir)
      return createHttpApi(daemon.base)
    },
    // The daemon reuses the mock store, so the simulated drop reaches the wire
    // as the `network` error envelope and the client adapter rethrows it as an
    // ApiError. Asserting the code here proves the envelope survives HTTP.
    partialSyncSurfacing: expectPartialSyncThrows('network'),
  })

  // The same delete block the in-process runner drives, over the wire: what
  // this leg adds is that the refusal's `unprocessable` and the absent id's
  // `not_found` each survive the HTTP envelope and come back as the typed
  // error a client catches. The daemon's store is in another process, so no
  // storage witness is handed in; every contract-level assertion stands.
  runLocalReviewDeleteConformance({
    label: 'revud-mock over HTTP',
    makeApi: () => createHttpApi(daemon.base),
    // The daemon's own answer, so the drafts written here are keyed exactly
    // as its session keys them.
    humanId: async () => (await createHttpApi(daemon.base).getSession()).human.id,
    pair: { baseRef: 'main', headRef: 'feature/delete-conformance' },
    anchor: { path: 'src/index.ts', line: 12, lineText: 'const x = compute()' },
  })
})

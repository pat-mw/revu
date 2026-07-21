/**
 * Guards the one part of the conformance suite that is deliberately delegated
 * to the runner: how a transport surfaces a `syncPull` that dies mid-transfer.
 *
 * The risk being tested is not an adapter bug — it is a harness bug. If the
 * fallback used by a runner that supplies no surfacing hook ever degraded into
 * "accept anything", every future leg would report green on a scenario it never
 * really checked, and the conformance matrix would be lying. So the fallback is
 * pinned here from both sides: it must accept each shape the contract allows,
 * and it must reject a sync that reported plain success or failed outside the
 * error envelope.
 *
 * Snapshots are cast from the one field under test; the fallback reads nothing
 * else, and building the full two-half snapshot would only obscure that.
 */
import { describe, expect, it } from 'bun:test'
import { ApiError } from '../src/index.ts'
import type { Snapshot } from '../src/index.ts'
import {
  expectPartialSyncResolves,
  expectPartialSyncSurfacedSomehow,
  expectPartialSyncThrows,
} from './suite.ts'

const completed = { partial: null } as unknown as Snapshot
const interrupted = {
  partial: { missingBlobShas: ['b1', 'b2'], reason: 'connection lost' },
} as unknown as Snapshot

describe('partial-sync surfacing expectations', () => {
  describe('the fallback used when a runner supplies no hook', () => {
    it('accepts a transport that raises the drop inside the error envelope', () => {
      expectPartialSyncSurfacedSomehow({
        kind: 'threw',
        error: new ApiError('network', 'connection dropped during sync'),
      })
    })

    it('accepts a transport that resolves with the partial snapshot instead', () => {
      expectPartialSyncSurfacedSomehow({ kind: 'resolved', snapshot: interrupted })
    })

    it('rejects a sync that claimed plain success', () => {
      expect(() =>
        expectPartialSyncSurfacedSomehow({ kind: 'resolved', snapshot: completed }),
      ).toThrow()
    })

    it('rejects a failure thrown outside the error envelope', () => {
      expect(() =>
        expectPartialSyncSurfacedSomehow({ kind: 'threw', error: new Error('boom') }),
      ).toThrow()
    })
  })

  describe('the explicit hooks a runner can pin its transport to', () => {
    it('the raising hook rejects a resolve, a wrong code, and a bare Error', () => {
      const expectNetwork = expectPartialSyncThrows('network')
      expectNetwork({ kind: 'threw', error: new ApiError('network', 'dropped') })
      expect(() => expectNetwork({ kind: 'resolved', snapshot: interrupted })).toThrow()
      expect(() =>
        expectNetwork({ kind: 'threw', error: new ApiError('rate_limited', 'slow down') }),
      ).toThrow()
      expect(() => expectNetwork({ kind: 'threw', error: new Error('boom') })).toThrow()
    })

    it('the resolving hook rejects a raise and a resolve that names nothing missing', () => {
      const expectResolved = expectPartialSyncResolves()
      expectResolved({ kind: 'resolved', snapshot: interrupted })
      expect(() => expectResolved({ kind: 'resolved', snapshot: completed })).toThrow()
      expect(() =>
        expectResolved({ kind: 'threw', error: new ApiError('network', 'dropped') }),
      ).toThrow()
    })
  })
})

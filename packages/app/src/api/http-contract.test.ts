/**
 * Fixture round-trip proof for the transport validators.
 *
 * The `RevuApi` contract crosses an HTTP boundary as JSON. `validateSnapshot`
 * (and its siblings) must reconstruct that JSON into a typed value LOSSLESSLY:
 * no field dropped, no field altered, no coercion. This suite asserts exactly
 * that against every `Snapshot` the fixtures can produce, then adds negative
 * cases proving the validators reject malformed input rather than passing it
 * through.
 *
 * Per-PR snapshots are built with the pure `buildSnapshot` helper — the same
 * function the mock sync engine uses for its remote → cache copy — so the test
 * is deterministic and free of network-latency flakiness. The seeded snapshots
 * (deliberately stale entries) are validated as-is.
 */
import { describe, expect, test } from 'bun:test'
import {
  validateSnapshot,
  validateSnapshotResponse,
  validateSubmitResult,
  validateFileViewedState,
  ValidationError,
} from '@revu/shared'
import type { ReviewSummary, Snapshot, SubmitResult } from '@revu/shared'
import { fixtureDB } from '@/fixtures'
import { buildSnapshot } from '@/fixtures/helpers'

/** Simulate the wire: serialize to JSON and parse back before validating. */
function overWire(snap: Snapshot): unknown {
  return JSON.parse(JSON.stringify(snap))
}

describe('snapshot validator round-trips every fixture PR', () => {
  for (const pull of fixtureDB.pulls) {
    test(`buildSnapshot for PR #${pull.detail.number} is lossless`, () => {
      const snap = buildSnapshot(pull, new Date().toISOString())
      // Compare against the WIRE form (what actually crosses the boundary),
      // and use toStrictEqual so any spurious `key: undefined` the validator
      // might emit is caught rather than silently ignored.
      const wire = overWire(snap)
      expect(validateSnapshot(wire)).toStrictEqual(wire)
    })
  }
})

describe('snapshot validator round-trips every seeded snapshot', () => {
  // Seeded snapshots include deliberately stale entries. `buildSnapshot`
  // defaults `partial: null` and no seed sets it, so these do NOT exercise
  // `Snapshot.partial` non-null — that path is covered explicitly by the
  // syncPull-partial transport test below. What these cover is the full
  // per-PR snapshot shape as it sits pre-built in the fixture store.
  fixtureDB.seededSnapshots.forEach((snap, i) => {
    test(`seeded snapshot #${i} (PR #${snap.prNumber}) is lossless`, () => {
      const wire = overWire(snap)
      expect(validateSnapshot(wire)).toStrictEqual(wire)
    })
  })
})

describe('the validators actually validate', () => {
  const sample = (): Snapshot =>
    buildSnapshot(fixtureDB.pulls[0], new Date().toISOString())

  test('a deleted required field throws ValidationError', () => {
    const tampered = overWire(sample()) as Record<string, unknown>
    delete (tampered.immutable as Record<string, unknown>).headSha
    expect(() => validateSnapshot(tampered)).toThrow(ValidationError)
  })

  test('a wrongly-typed field throws ValidationError (no coercion)', () => {
    const tampered = overWire(sample()) as Record<string, unknown>
    // headSha is a string; a number must be rejected, not coerced.
    ;(tampered.immutable as Record<string, unknown>).headSha = 42
    expect(() => validateSnapshot(tampered)).toThrow(ValidationError)
  })

  test('an unknown extra top-level field is dropped by the validator', () => {
    const wire = overWire(sample())
    const tampered = { ...(wire as Record<string, unknown>) }
    tampered.somethingExtra = 'should not survive'
    const validated = validateSnapshot(tampered)
    // The extra key is stripped, so the output matches the clean wire form and
    // does NOT carry the injected field.
    expect('somethingExtra' in (validated as object)).toBe(false)
    expect(validated).toStrictEqual(wire)
  })

  test('a record key literally named __proto__ survives as an own property', () => {
    // `__proto__` is a legal git path and reaches vRecord via blobIndex. A
    // naive `out[key] = value` would set the prototype instead of an own key,
    // silently dropping it. Assert with getOwnPropertyNames — the reliable
    // proof, since toStrictEqual can be finicky with `__proto__`. The key is
    // injected via JSON.parse (a plain assignment would set the prototype, not
    // create an own key, so vRecord's Object.keys would never see it).
    const wire = overWire(sample()) as Record<string, unknown>
    const immutable = wire.immutable as Record<string, unknown>
    immutable.blobIndex = JSON.parse(
      '{"__proto__": {"base": "basesha", "head": "headsha"}}',
    )
    const result = validateSnapshot(wire)
    const resultBlobIndex = (
      (result as Snapshot).immutable as unknown as {
        blobIndex: Record<string, unknown>
      }
    ).blobIndex
    expect(Object.getOwnPropertyNames(resultBlobIndex)).toContain('__proto__')
  })
})

describe('the three non-error transport semantics survive validation', () => {
  test('getSnapshot returns HTTP 200 with a JSON null body', () => {
    // A never-synced PR responds `null`, not a 404-as-error. The response
    // validator must accept it unchanged and must not throw.
    expect(validateSnapshotResponse(JSON.parse('null'))).toBeNull()
    expect(() => validateSnapshotResponse(JSON.parse('null'))).not.toThrow()
  })

  test('submitReview head_moved (and ok/forbidden) round-trip losslessly', () => {
    // head_moved is an HTTP 200 value, never an error status.
    const headMoved: SubmitResult = {
      status: 'head_moved',
      currentHeadSha: 'deadbeef',
      newCommits: 2,
    }
    const headMovedWire = JSON.parse(JSON.stringify(headMoved))
    expect(validateSubmitResult(headMovedWire)).toStrictEqual(headMovedWire)

    // ok carries a full ReviewSummary. Reuse a fixture GhUser so every user
    // field is valid without hand-rolling.
    const review: ReviewSummary = {
      id: 1,
      node_id: 'PRR_ok',
      user: buildSnapshot(fixtureDB.pulls[0], new Date().toISOString()).mutable
        .pull.user,
      body: 'looks good',
      state: 'APPROVED',
      submitted_at: new Date().toISOString(),
      commit_id: 'deadbeef',
    }
    const ok: SubmitResult = { status: 'ok', review }
    const okWire = JSON.parse(JSON.stringify(ok))
    expect(validateSubmitResult(okWire)).toStrictEqual(okWire)

    const forbidden: SubmitResult = {
      status: 'forbidden',
      reason: 'the App authored this PR; GitHub refuses self-review',
    }
    const forbiddenWire = JSON.parse(JSON.stringify(forbidden))
    expect(validateSubmitResult(forbiddenWire)).toStrictEqual(forbiddenWire)
  })

  test('syncPull with Snapshot.partial non-null round-trips losslessly', () => {
    // A sync that died mid-flight names what is missing. That is an HTTP 200
    // body, not an error, and the non-null `partial` must survive the wire.
    const snap = buildSnapshot(
      fixtureDB.pulls[0],
      new Date().toISOString(),
    )
    snap.partial = {
      missingBlobShas: ['abc123'],
      reason: 'network gone mid-sync',
    }
    const wire = overWire(snap)
    expect(validateSnapshot(wire)).toStrictEqual(wire)
  })
})

describe('a record key literally named __proto__ survives vRecord', () => {
  test('validateFileViewedState keeps a __proto__ path as an own property', () => {
    // FileViewedState is a bare vRecord; `__proto__` is a legal path key. Build
    // the wire from a JSON string so `__proto__` is an OWN key (an object
    // literal / assignment would set the prototype instead, and vRecord's
    // Object.keys would never see it).
    const at = new Date().toISOString()
    const wire = JSON.parse(
      `{"__proto__": {"viewed": true, "blobSha": null, "at": "${at}"},` +
        ` "src/app.ts": {"viewed": false, "blobSha": "abc", "at": "${at}"}}`,
    )
    const result = validateFileViewedState(wire)
    expect(Object.getOwnPropertyNames(result)).toContain('__proto__')
  })
})

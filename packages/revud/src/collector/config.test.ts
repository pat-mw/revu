/**
 * The host-CLI configuration seam. These tests run disk-local (a temp dir per
 * test holding the owner-map JSON and the store file) and assert both halves
 * of the contract: a valid `REVU_OWNER_MAP_FILE` yields a resolver — and via
 * `openHostStoreFromEnv` a store — that authorizes by the binding; and every
 * misconfiguration (unset variable, missing file, malformed JSON, wrong JSON
 * shape, invalid map) throws `OwnerMapConfigError` with an operator message
 * that names the coordinate but never echoes file content.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewDraft } from '@revu/shared'
import { loadOwnerResolver, openHostStoreFromEnv, OwnerMapConfigError } from './config'
import { UnboundOwnerError } from './host-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revu-collector-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write an owner-map file into the temp dir and return its path. */
function writeMap(content: string): string {
  const path = join(dir, 'owners.json')
  writeFileSync(path, content)
  return path
}

function draft(prNumber: number, body: string): ReviewDraft {
  return {
    humanId: 'workspace-claimed@spoof.io',
    prNumber,
    headSha: 'head',
    compareKey: 'base...head',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('loadOwnerResolver: a valid map resolves owners to canonical bindings', () => {
  test('resolves a known owner with the email normalized to the store key', () => {
    const path = writeMap(
      JSON.stringify({ alice: { email: ' Alice@Corp.COM ', displayName: 'Alice N' } }),
    )
    const resolver = loadOwnerResolver({ REVU_OWNER_MAP_FILE: path })
    expect(resolver.resolve('alice')).toEqual({
      coderOwner: 'alice',
      email: 'alice@corp.com',
      displayName: 'Alice N',
    })
    // Unknown owners return null (no identity) — never an invented binding.
    expect(resolver.resolve('mallory')).toBeNull()
  })
})

describe('openHostStoreFromEnv: the store authorizes by the file-configured binding', () => {
  test('a landed draft is keyed by the binding and unbound owners fail loud', () => {
    const path = writeMap(JSON.stringify({ alice: { email: 'alice@corp.com' } }))
    const env = { REVU_OWNER_MAP_FILE: path, REVU_HOST_DATA_DIR: join(dir, 'host') }
    const store = openHostStoreFromEnv(env)
    store.landDraft('alice', draft(204, 'work'))
    // The workspace-claimed humanId in the payload was discarded: the read
    // comes back re-keyed to the map's canonical email.
    expect(store.getDraft('alice', 204)!.humanId).toBe('alice@corp.com')
    // An owner outside the file's map does not resolve anywhere.
    expect(() => store.getDraft('mallory', 204)).toThrow(UnboundOwnerError)
    store.close()
  })
})

describe('OwnerMapConfigError: every misconfiguration is a clear, content-free throw', () => {
  test('unset REVU_OWNER_MAP_FILE names the variable', () => {
    expect(() => loadOwnerResolver({})).toThrow(OwnerMapConfigError)
    expect(() => loadOwnerResolver({ REVU_OWNER_MAP_FILE: '   ' })).toThrow(
      /REVU_OWNER_MAP_FILE is not set/,
    )
  })

  test('a nonexistent path names the path and the OS reason', () => {
    const missing = join(dir, 'nope.json')
    expect(() => loadOwnerResolver({ REVU_OWNER_MAP_FILE: missing })).toThrow(OwnerMapConfigError)
    try {
      loadOwnerResolver({ REVU_OWNER_MAP_FILE: missing })
      throw new Error('expected OwnerMapConfigError')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnerMapConfigError)
      expect((err as Error).message).toContain(missing)
      expect((err as Error).message).toContain('ENOENT')
    }
  })

  test('malformed JSON throws without echoing any of the file content', () => {
    // The file content stands in for anything sensitive an operator might have
    // mispasted into the map file — none of it may surface in the error.
    const path = writeMap('{"alice": {"email": "hunter2-secret@corp.com"')
    try {
      loadOwnerResolver({ REVU_OWNER_MAP_FILE: path })
      throw new Error('expected OwnerMapConfigError')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnerMapConfigError)
      const message = (err as Error).message
      expect(message).toContain('not valid JSON')
      expect(message).toContain(path)
      expect(message).not.toContain('hunter2')
      expect(message).not.toContain('alice')
    }
  })

  test('valid JSON of the wrong shape (array / scalar / null) is rejected as not-an-object', () => {
    for (const content of ['[1,2,3]', '"a string"', 'null', '42']) {
      const path = writeMap(content)
      expect(() => loadOwnerResolver({ REVU_OWNER_MAP_FILE: path })).toThrow(
        /must be a JSON object/,
      )
    }
  })

  test('an invalid map (missing email) surfaces the binding failure as a config error', () => {
    const path = writeMap(JSON.stringify({ alice: { displayName: 'no email' } }))
    expect(() => loadOwnerResolver({ REVU_OWNER_MAP_FILE: path })).toThrow(OwnerMapConfigError)
    expect(() => loadOwnerResolver({ REVU_OWNER_MAP_FILE: path })).toThrow(
      /missing or non-string email/,
    )
  })

  test('an identity-merge misconfig names the owner keys but never the colliding email', () => {
    // Two owners mapping to one email is a config error whose message can reach
    // operator logs via the CLI — it must locate the fix by owner key without
    // leaking the person's address.
    const path = writeMap(
      JSON.stringify({
        alice: { email: 'secret.contractor@corp.com' },
        alice2: { email: 'Secret.Contractor@Corp.COM' },
      }),
    )
    try {
      loadOwnerResolver({ REVU_OWNER_MAP_FILE: path })
      throw new Error('expected OwnerMapConfigError')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnerMapConfigError)
      const message = (err as Error).message
      expect(message).toContain('identity merge')
      expect(message).toContain('alice')
      expect(message).toContain('alice2')
      expect(message).not.toContain('secret.contractor@corp.com')
      expect(message.toLowerCase()).not.toContain('secret.contractor')
    }
  })

  test('openHostStoreFromEnv fails the same way before opening anything', () => {
    expect(() => openHostStoreFromEnv({})).toThrow(OwnerMapConfigError)
  })
})

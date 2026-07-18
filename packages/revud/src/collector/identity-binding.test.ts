/**
 * The `coder.owner` → email identity binding: known owners resolve to a
 * binding whose email is already the canonical `emailToId` store key, unknown
 * and empty owners never resolve, and the resolver's API shape enforces the
 * invariant that the ONLY way in is a channel-authentic `coder.owner` — no
 * email-keyed lookup exists to be handed a workspace-reported address.
 */
import { describe, expect, test } from 'bun:test'
import { createMapCoderOwnerResolver } from './identity-binding'

describe('createMapCoderOwnerResolver', () => {
  test('a known coder.owner resolves to its binding with an emailToId-normalized email', () => {
    const resolver = createMapCoderOwnerResolver({
      alice: { email: '  Alice.Nguyen@Example.COM ' },
    })
    expect(resolver.resolve('alice')).toEqual({
      coderOwner: 'alice',
      email: 'alice.nguyen@example.com',
    })
  })

  test('an unknown owner resolves to null — an identity is never fabricated', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(resolver.resolve('mallory')).toBeNull()
  })

  test('an empty or whitespace-only owner never resolves', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(resolver.resolve('')).toBeNull()
    expect(resolver.resolve('   ')).toBeNull()
    expect(resolver.resolve('\t\n')).toBeNull()
  })

  test('the lookup input is trimmed, but the owner match is otherwise exact (case-sensitive)', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(resolver.resolve('  alice  ')?.email).toBe('a@example.com')
    // Coder usernames are exact identifiers: case-folding would merge identities.
    expect(resolver.resolve('Alice')).toBeNull()
    expect(resolver.resolve('ALICE')).toBeNull()
  })

  test('displayName is carried through when present and absent when not', () => {
    const resolver = createMapCoderOwnerResolver({
      alice: { email: 'a@example.com', displayName: 'Alice Nguyen' },
      bob: { email: 'b@example.com' },
    })
    expect(resolver.resolve('alice')?.displayName).toBe('Alice Nguyen')
    expect(resolver.resolve('bob')?.displayName).toBeUndefined()
  })

  test('resolution is a construction-time snapshot: mutating the input map later changes nothing', () => {
    const input: Record<string, { email: string }> = { alice: { email: 'a@example.com' } }
    const resolver = createMapCoderOwnerResolver(input)
    input['mallory'] = { email: 'm@example.com' }
    input['alice'].email = 'hijacked@example.com'
    expect(resolver.resolve('mallory')).toBeNull()
    expect(resolver.resolve('alice')?.email).toBe('a@example.com')
  })

  test('returned bindings are frozen so a caller cannot poison later resolutions', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    const binding = resolver.resolve('alice')
    expect(binding).not.toBeNull()
    expect(Object.isFrozen(binding)).toBe(true)
    expect(() => {
      ;(binding as { email: string }).email = 'poison@example.com'
    }).toThrow()
    expect(resolver.resolve('alice')?.email).toBe('a@example.com')
  })

  test('object-prototype property names never resolve without an explicit entry', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(resolver.resolve('__proto__')).toBeNull()
    expect(resolver.resolve('constructor')).toBeNull()
    expect(resolver.resolve('hasOwnProperty')).toBeNull()
  })

  test('misconfiguration fails fast at construction, not silently at resolve time', () => {
    expect(() => createMapCoderOwnerResolver({ '  ': { email: 'a@example.com' } })).toThrow(
      'empty coder.owner key',
    )
    expect(() => createMapCoderOwnerResolver({ alice: { email: '   ' } })).toThrow(
      'empty email for coder.owner alice',
    )
    // "alice" and "alice " collapse to one trimmed key — an ambiguous binding.
    expect(() =>
      createMapCoderOwnerResolver({
        alice: { email: 'a@example.com' },
        'alice ': { email: 'other@example.com' },
      }),
    ).toThrow('duplicate coder.owner key')
  })

  test('construction rejects two owners that normalize to one email — a silent identity merge', () => {
    // Two distinct people must never share a store/audit key. The collision is
    // invisible in config review because it only appears after emailToId folds
    // case and whitespace, so the binding refuses to construct.
    expect(() =>
      createMapCoderOwnerResolver({
        alice: { email: 'shared@agency.com' },
        bob: { email: '  Shared@Agency.COM ' },
      }),
    ).toThrow('identity merge')
  })

  test('construction rejects case-insensitively colliding owner keys — dead config drops a human', () => {
    // A Coder username is unique case-insensitively, so `alice`/`Alice` cannot
    // both arrive on the channel; the losing entry silently drops that human.
    expect(() =>
      createMapCoderOwnerResolver({
        alice: { email: 'a@example.com' },
        Alice: { email: 'b@example.com' },
      }),
    ).toThrow('collide case-insensitively')
  })

  test('construction rejects a missing or non-string email with a descriptive error', () => {
    expect(() =>
      createMapCoderOwnerResolver({ alice: {} as unknown as { email: string } }),
    ).toThrow('missing or non-string email for coder.owner alice')
    expect(() =>
      createMapCoderOwnerResolver({ alice: { email: 42 as unknown as string } }),
    ).toThrow('missing or non-string email for coder.owner alice')
  })

  test('a non-string lookup fails closed to null instead of throwing (a missing container label)', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(resolver.resolve(undefined as unknown as string)).toBeNull()
    expect(resolver.resolve(null as unknown as string)).toBeNull()
  })

  test('a whitespace-only displayName is treated as absent, not carried through', () => {
    const resolver = createMapCoderOwnerResolver({
      alice: { email: 'a@example.com', displayName: '   ' },
    })
    expect(resolver.resolve('alice')?.displayName).toBeUndefined()
  })

  test('the resolver object itself is frozen — resolve cannot be swapped out', () => {
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(Object.isFrozen(resolver)).toBe(true)
    expect(() => {
      ;(resolver as { resolve: unknown }).resolve = () => ({
        coderOwner: 'x',
        email: 'x@example.com',
      })
    }).toThrow()
  })

  test('INVARIANT: the only way to obtain an identity is via a coder.owner key', () => {
    // The resolver's entire surface is `resolve(coderOwner)`. There is
    // deliberately no function that accepts an email and returns a binding:
    // an email is workspace-reported (display-only, spoofable), so an
    // email-keyed entry point would let a workspace-claimed address mint an
    // audit identity. Asserting the exact API shape pins that down.
    const resolver = createMapCoderOwnerResolver({ alice: { email: 'a@example.com' } })
    expect(Object.keys(resolver)).toEqual(['resolve'])
    // Feeding an email where a coder.owner belongs must not resolve either.
    expect(resolver.resolve('a@example.com')).toBeNull()
  })
})

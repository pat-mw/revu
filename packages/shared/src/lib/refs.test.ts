/**
 * Unit suite for the pure, syntactic ref-name validator. Each rejection rule
 * gets its own case with an otherwise-valid name, so a validator that rejects
 * everything and one that rejects only the leading `-` are both distinguishable
 * from the real thing. Acceptance cases pin that ordinary branch names and
 * fully qualified refs still pass.
 */

import { describe, expect, it } from 'bun:test'
import { isValidRefName, normalizeRefName } from './refs'

describe('isValidRefName — option-injection guard', () => {
  it('rejects an argument-shaped name beginning with a dash', () => {
    expect(isValidRefName('--upload-pack=/bin/sh')).toBe(false)
  })

  it('rejects a plain leading dash', () => {
    expect(isValidRefName('-feature')).toBe(false)
  })
})

describe('isValidRefName — shapes git check-ref-format rejects', () => {
  it('rejects the empty string', () => {
    expect(isValidRefName('')).toBe(false)
  })

  it('rejects two consecutive dots', () => {
    expect(isValidRefName('feature/../escape')).toBe(false)
  })

  it('rejects a space', () => {
    expect(isValidRefName('feature x')).toBe(false)
  })

  it('rejects a tilde', () => {
    expect(isValidRefName('feature~1')).toBe(false)
  })

  it('rejects a caret', () => {
    expect(isValidRefName('feature^2')).toBe(false)
  })

  it('rejects a colon', () => {
    expect(isValidRefName('feature:x')).toBe(false)
  })

  it('rejects a question mark', () => {
    expect(isValidRefName('feature?')).toBe(false)
  })

  it('rejects an asterisk', () => {
    expect(isValidRefName('feature*')).toBe(false)
  })

  it('rejects an open bracket', () => {
    expect(isValidRefName('feature[0]')).toBe(false)
  })

  it('rejects a control character', () => {
    expect(isValidRefName('feature\u0007x')).toBe(false)
  })

  it('rejects a newline', () => {
    expect(isValidRefName('feature\nx')).toBe(false)
  })

  it('rejects a trailing slash', () => {
    expect(isValidRefName('feature/')).toBe(false)
  })

  it('rejects a trailing .lock', () => {
    expect(isValidRefName('feature.lock')).toBe(false)
  })

  it('rejects a component ending in .lock mid-name', () => {
    expect(isValidRefName('feature.lock/x')).toBe(false)
  })
})

describe('isValidRefName — further subprocess-free git rules', () => {
  it('rejects a backslash', () => {
    expect(isValidRefName('feature\\x')).toBe(false)
  })

  it('rejects a leading slash', () => {
    expect(isValidRefName('/feature')).toBe(false)
  })

  it('rejects consecutive slashes', () => {
    expect(isValidRefName('feature//x')).toBe(false)
  })

  it('rejects a trailing dot', () => {
    expect(isValidRefName('feature.')).toBe(false)
  })

  it('rejects a component beginning with a dot', () => {
    expect(isValidRefName('feature/.hidden')).toBe(false)
  })

  it('rejects the @{ sequence', () => {
    expect(isValidRefName('feature@{1}')).toBe(false)
  })

  it('rejects the single character @', () => {
    expect(isValidRefName('@')).toBe(false)
  })
})

describe('isValidRefName — legal names pass', () => {
  it('accepts a plain branch name', () => {
    expect(isValidRefName('main')).toBe(true)
  })

  it('accepts a slashed branch name', () => {
    expect(isValidRefName('feature/x')).toBe(true)
  })

  it('accepts a fully qualified head ref', () => {
    expect(isValidRefName('refs/heads/feature/x')).toBe(true)
  })

  it('accepts a fully qualified remote-tracking ref', () => {
    expect(isValidRefName('refs/remotes/origin/main')).toBe(true)
  })

  it('accepts an interior dash and dot', () => {
    expect(isValidRefName('release-1.0')).toBe(true)
  })
})

describe('normalizeRefName', () => {
  it('qualifies a bare branch name under refs/heads/', () => {
    expect(normalizeRefName('feature/x')).toBe('refs/heads/feature/x')
  })

  it('returns an already-qualified head ref unchanged', () => {
    expect(normalizeRefName('refs/heads/feature/x')).toBe('refs/heads/feature/x')
  })

  it('returns an already-qualified remote-tracking ref unchanged', () => {
    expect(normalizeRefName('refs/remotes/origin/main')).toBe(
      'refs/remotes/origin/main',
    )
  })
})

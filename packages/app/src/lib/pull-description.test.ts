/**
 * Unit suite for the pull request description reader (./pull-description).
 * The cases that matter are the ones where "has a body" and "has something to
 * read" disagree: a body that is only a smuggled identity prefix, and a body
 * that is only whitespace.
 */

import { describe, it, expect } from 'bun:test'
import type { GhUser } from '@revu/shared'
import { readPullDescription } from './pull-description'

const BOT_LOGIN = 'revu-broker[bot]'

function ghUser(login: string): GhUser {
  return {
    login,
    id: 1,
    node_id: 'U_1',
    avatar_url: '',
    html_url: '',
    type: login.endsWith('[bot]') ? 'Bot' : 'User',
  }
}

function pull(login: string, body: string | null) {
  return { user: ghUser(login), body }
}

describe('readPullDescription', () => {
  it('keeps a genuine GitHub author and trims the body it renders', () => {
    const d = readPullDescription(pull('octocat', '\n\nRewrites the cache key.\n\n'), BOT_LOGIN)
    expect(d.identity).toEqual({ kind: 'github', user: ghUser('octocat') })
    expect(d.body).toBe('Rewrites the cache key.')
    expect(d.isEmpty).toBe(false)
  })

  it('reports a null body as empty', () => {
    const d = readPullDescription(pull('octocat', null), BOT_LOGIN)
    expect(d.body).toBe('')
    expect(d.isEmpty).toBe(true)
  })

  it('reports an empty and a whitespace-only body as empty', () => {
    expect(readPullDescription(pull('octocat', ''), BOT_LOGIN).isEmpty).toBe(true)
    expect(readPullDescription(pull('octocat', '  \n\n\t '), BOT_LOGIN).isEmpty).toBe(true)
  })

  it('credits the smuggled human and renders only the prose beneath the prefix', () => {
    const d = readPullDescription(
      pull(BOT_LOGIN, '**Alice Nguyen** (contractor)\n\nSwitches the queue to a `Map`.'),
      BOT_LOGIN,
    )
    expect(d.identity).toEqual({ kind: 'human', name: 'Alice Nguyen', role: 'contractor' })
    expect(d.body).toBe('Switches the queue to a `Map`.')
    expect(d.isEmpty).toBe(false)
  })

  it('calls a body that is nothing but the identity prefix empty', () => {
    // The raw body is a non-empty string, so a check on `pull.body` alone would
    // render a byline over blank space instead of saying there is no description.
    const d = readPullDescription(pull(BOT_LOGIN, '**Alice Nguyen** (contractor)\n\n'), BOT_LOGIN)
    expect(d.identity).toEqual({ kind: 'human', name: 'Alice Nguyen', role: 'contractor' })
    expect(d.isEmpty).toBe(true)
  })

  it('leaves an unprefixed broker body verbatim under the bot identity', () => {
    const d = readPullDescription(pull(BOT_LOGIN, 'Opened by automation.'), BOT_LOGIN)
    expect(d.identity).toEqual({ kind: 'bot', user: ghUser(BOT_LOGIN) })
    expect(d.body).toBe('Opened by automation.')
    expect(d.isEmpty).toBe(false)
  })

  it('routes off the broker login it is given, not a hardcoded one', () => {
    const d = readPullDescription(pull(BOT_LOGIN, '**Alice** (contractor)\n\nbody'), 'other[bot]')
    expect(d.identity).toEqual({ kind: 'github', user: ghUser(BOT_LOGIN) })
    expect(d.body).toBe('**Alice** (contractor)\n\nbody')
  })
})

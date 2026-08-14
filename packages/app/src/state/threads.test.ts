/**
 * The two identity derivations behind the optimistic thread mutations: what
 * body an optimistic reply carries, and who an optimistic resolve is
 * attributed to. Both are pure functions of the session and the review's mode,
 * so both are asserted directly — the hooks that call them need a renderer and
 * a query client and add nothing to the decision under test.
 *
 * Both derivations exist because an optimistic value that disagrees with the
 * stored one is not merely wrong for a moment: the success paths copy the body
 * and `resolvedBy` straight out of the response, so a disagreement shows up as
 * a visible swap under the reader's eyes.
 *
 * The mode is the second input for a reason that is easy to lose: a local
 * review's writes never pass through a shared account, whatever identity the
 * session happens to carry, so both answers change on a local review even
 * though the session did not.
 */
import { describe, expect, test } from 'bun:test'
import type { Human, Session } from '@revu/shared'
import { parsePrefixedBody } from '@revu/shared'
import { optimisticBody, optimisticResolvedBy } from './threads'

const HUMAN: Human = {
  id: 'alice@example.com',
  name: 'Alice Nguyen',
  role: 'contractor',
  email: 'alice@example.com',
}

/**
 * Direct mode: the viewer authenticates to GitHub as themselves, so there is
 * no bot and `brokerLogin` carries the empty "no bot" sentinel while
 * `viewerLogin` carries the viewer's own login.
 */
const DIRECT: Session = {
  human: HUMAN,
  brokerLogin: '',
  workspace: 'direct-acme-widgets',
  viewerLogin: 'alice-ng',
}

/**
 * Broker mode with a configured bot identity: every mediated write is authored
 * by that one bot, so `brokerLogin` and `viewerLogin` both carry its login.
 */
const BROKER: Session = {
  human: HUMAN,
  brokerLogin: 'acme-revu[bot]',
  workspace: 'ws-alice',
  viewerLogin: 'acme-revu[bot]',
}

/**
 * Broker mode with no configured bot identity — the reads-only shape: no
 * self-identity at all, so neither login is available. Writes are refused at
 * the transport in this shape, but the derivations must still be total.
 */
const NO_LOGIN: Session = {
  human: HUMAN,
  brokerLogin: '',
  workspace: 'ws-alice',
}

const BODY = 'This should probably be a `Map` — the linear scan is the hot path.'

/**
 * A body whose own first line is bold, so a non-stamping assertion cannot pass
 * merely because the text contains no asterisks. The opening token is not
 * name-shaped, so the parser rejects it as a prefix and a leaked stamp is the
 * only thing that could make it parse.
 */
const BOLD_OPENER = '**note: quadratic**\n\nThe inner loop rescans the whole list.'

describe('optimisticBody', () => {
  test('a stamping session smuggles the human into a pull request reply', () => {
    const parsed = parsePrefixedBody(optimisticBody(BROKER, 'github', BODY))
    expect(parsed).not.toBeNull()
    expect(parsed?.name).toBe(HUMAN.name)
    expect(parsed?.role).toBe(HUMAN.role)
    expect(parsed?.rest).toBe(BODY)
  })

  test('a stamping session does NOT stamp a local review', () => {
    // The local write path stores bodies verbatim under every session, because
    // nothing local is written through a shared account. A stamp here would
    // render as literal markdown until the stored comment replaced it.
    const produced = optimisticBody(BROKER, 'local', BODY)
    expect(parsePrefixedBody(produced)).toBeNull()
    expect(produced).toBe(BODY)
  })

  test('a non-stamping session produces no prefix on either kind of review', () => {
    expect(parsePrefixedBody(optimisticBody(DIRECT, 'github', BODY))).toBeNull()
    expect(optimisticBody(DIRECT, 'github', BODY)).toBe(BODY)
    expect(parsePrefixedBody(optimisticBody(DIRECT, 'local', BODY))).toBeNull()
    expect(optimisticBody(DIRECT, 'local', BODY)).toBe(BODY)
  })

  test('a body that merely opens in bold is still unstamped without a bot', () => {
    const produced = optimisticBody(DIRECT, 'github', BOLD_OPENER)
    expect(parsePrefixedBody(produced)).toBeNull()
    expect(produced).toBe(BOLD_OPENER)
  })

  test('a broker with no configured bot does not stamp', () => {
    const produced = optimisticBody(NO_LOGIN, 'github', BODY)
    expect(parsePrefixedBody(produced)).toBeNull()
    expect(produced).toBe(BODY)
  })
})

describe('optimisticResolvedBy', () => {
  /** `onGithub` is the login the pull request write path records for this session. */
  const shapes: { label: string; session: Session; onGithub: string }[] = [
    { label: 'direct mode', session: DIRECT, onGithub: 'alice-ng' },
    { label: 'broker with a bot', session: BROKER, onGithub: 'acme-revu[bot]' },
    { label: 'broker with no bot', session: NO_LOGIN, onGithub: HUMAN.name },
  ]

  for (const { label, session, onGithub } of shapes) {
    test(`${label} attributes a pull request resolve to the acting identity`, () => {
      expect(optimisticResolvedBy(session, 'github')).toEqual({ login: onGithub })
    })

    test(`${label} attributes a local resolve to the reviewer's display name`, () => {
      // There is no account to name on a local review, so the local write path
      // attributes the resolution by display name under every session shape.
      expect(optimisticResolvedBy(session, 'local')).toEqual({ login: HUMAN.name })
    })

    test(`${label} never attributes a resolve to an empty login`, () => {
      expect(optimisticResolvedBy(session, 'github').login).not.toBe('')
      expect(optimisticResolvedBy(session, 'local').login).not.toBe('')
    })
  }
})

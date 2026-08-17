/**
 * The three identity derivations behind the optimistic thread mutations: what
 * body an optimistic reply carries, who authors it, and who an optimistic
 * resolve is attributed to. All three are pure functions of the session and the
 * review's mode, so all three are asserted directly — the hooks that call them
 * need a renderer and a query client and add nothing to the decision under test.
 *
 * They exist because an optimistic value that disagrees with the stored one is
 * not merely wrong for a moment: the success paths copy the comment and
 * `resolvedBy` straight out of the response, so a disagreement shows up as a
 * visible swap under the reader's eyes.
 *
 * The mode is the second input for a reason that is easy to lose: a local
 * review's writes never pass through a shared account, whatever identity the
 * session happens to carry, so every answer changes on a local review even
 * though the session did not.
 */
import { describe, expect, test } from 'bun:test'
import type { GhUser, Human, Session } from '@revu/shared'
import { parsePrefixedBody } from '@revu/shared'
import { optimisticAuthor, optimisticBody, optimisticResolvedBy } from './threads'

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

describe('optimisticAuthor', () => {
  /**
   * The exact author a local write records: the reviewer's display name in the
   * only name-shaped field a GitHub user has, an id outside every real band
   * (GitHub ids are positive and nothing local mints them), `type: 'Bot'`
   * marking it as not a genuine account, and no URLs because there is nothing
   * on github.com to link to.
   *
   * Spelled out here rather than imported from the write path, so a change to
   * the stored shape has to be mirrored into the optimistic one deliberately
   * instead of the two tracking each other into agreement on a wrong value.
   */
  const LOCAL_SENTINEL: GhUser = {
    login: HUMAN.name,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }

  /**
   * `onGithub` is the author the pull request write path records for this
   * session: the shared bot where one fronts many humans, and the
   * authenticated viewer where the session writes as a real GitHub user.
   * A session with no write identity at all cannot post — its answer only has
   * to be total and nameable, so it falls back to the display name and is
   * marked as the non-account it is.
   */
  const shapes: { label: string; session: Session; onGithub: Pick<GhUser, 'login' | 'type'> }[] = [
    { label: 'direct mode', session: DIRECT, onGithub: { login: 'alice-ng', type: 'User' } },
    {
      label: 'broker with a bot',
      session: BROKER,
      onGithub: { login: 'acme-revu[bot]', type: 'Bot' },
    },
    { label: 'broker with no bot', session: NO_LOGIN, onGithub: { login: HUMAN.name, type: 'Bot' } },
  ]

  for (const { label, session, onGithub } of shapes) {
    test(`${label} authors a pull request reply as the identity that posts it`, () => {
      const author = optimisticAuthor(session, 'github')
      expect(author.login).toBe(onGithub.login)
      expect(author.type).toBe(onGithub.type)
    })

    test(`${label} authors a local reply as the local sentinel reviewer`, () => {
      // A local write is never mediated by an account, under any session — the
      // local branch of the write path is taken above the account it would
      // otherwise write through. So the stored author is the sentinel below,
      // field for field, whatever identity the session carries.
      expect(optimisticAuthor(session, 'local')).toEqual(LOCAL_SENTINEL)
    })

    test(`${label} never authors an optimistic reply with an empty login`, () => {
      expect(optimisticAuthor(session, 'github').login).not.toBe('')
      expect(optimisticAuthor(session, 'local').login).not.toBe('')
    })

    test(`${label} never puts the reviewer's email in the rendered author`, () => {
      // The email is a storage key, never a body: no field of a rendered user
      // may carry it, and `login` is the field that gets drawn.
      for (const mode of ['github', 'local'] as const) {
        expect(Object.values(optimisticAuthor(session, mode))).not.toContain(HUMAN.email)
      }
    })
  }
})

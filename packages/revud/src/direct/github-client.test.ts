/**
 * The minimal authenticated GitHub client. A fake `fetch` records the request
 * and returns a canned `GET /user`, so no test opens a socket. The tests pin the
 * required headers (Bearer auth from the TokenSource, API version, User-Agent),
 * the viewer mapping, and the error path on a non-2xx.
 */
import { describe, expect, test } from 'bun:test'
import type { FetchLike } from './github-client'
import { createGithubClient, GithubRequestError } from './github-client'
import type { TokenSource } from './token-source'

const staticToken = (token: string): TokenSource => ({
  async getToken() {
    return token
  },
})

interface Captured {
  url: string
  init?: RequestInit
}

/** A fake fetch returning `body` at `status`, recording the last request. */
function fakeFetch(status: number, body: unknown, captured: Captured[]): FetchLike {
  return async (url, init) => {
    captured.push({ url, ...(init !== undefined ? { init } : {}) })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('createGithubClient.getViewer', () => {
  test('sends Bearer auth, API version, and a User-Agent to the user endpoint', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('secret-token'),
      fetchImpl: fakeFetch(200, { login: 'octocat', id: 583231 }, captured),
      baseUrl: 'https://api.github.test',
    })
    const viewer = await client.getViewer()
    expect(viewer).toEqual({ login: 'octocat', id: 583231 })

    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.url).toBe('https://api.github.test/user')
    const headers = req.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(headers['x-github-api-version']).toBeTruthy()
    expect(headers['user-agent']).toBeTruthy()
    expect(headers.accept).toContain('application/vnd.github')
  })

  test('throws GithubRequestError on a 401', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('bad-token'),
      fetchImpl: fakeFetch(401, { message: 'Bad credentials' }, []),
    })
    await expect(client.getViewer()).rejects.toBeInstanceOf(GithubRequestError)
  })

  test('throws when the response is missing login/id', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { name: 'no login here' }, []),
    })
    await expect(client.getViewer()).rejects.toBeInstanceOf(GithubRequestError)
  })

  test('never puts the token in the request URL', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('super-secret'),
      fetchImpl: fakeFetch(200, { login: 'a', id: 1 }, captured),
    })
    await client.getViewer()
    expect(captured[0].url).not.toContain('super-secret')
  })
})

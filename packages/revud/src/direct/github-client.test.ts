/**
 * The minimal authenticated GitHub client. A fake `fetch` records the request
 * and returns a canned `GET /user`, so no test opens a socket. The tests pin the
 * required headers (Bearer auth from the TokenSource, API version, User-Agent),
 * the viewer mapping, and the error path on a non-2xx.
 */
import { describe, expect, test } from 'bun:test'
import type { FetchLike } from './github-client'
import { createGithubClient, GithubGraphqlError, GithubRequestError } from './github-client'
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

describe('createGithubClient.graphql (the review-thread read seam)', () => {
  test('POSTs to the GraphQL endpoint with Bearer auth, User-Agent, and a JSON body', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('gql-secret'),
      fetchImpl: fakeFetch(200, { data: { ping: 'pong' } }, captured),
      graphqlUrl: 'https://api.github.test/graphql',
    })
    const data = await client.graphql<{ ping: string }>('query { ping }', { a: 1 })
    expect(data).toEqual({ ping: 'pong' })

    const req = captured[0]
    expect(req.url).toBe('https://api.github.test/graphql')
    expect(req.init?.method).toBe('POST')
    const headers = req.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer gql-secret')
    expect(headers['user-agent']).toBeTruthy()
    expect(headers['content-type']).toContain('application/json')
    const body = JSON.parse(req.init?.body as string) as { query: string; variables: unknown }
    expect(body.query).toContain('ping')
    expect(body.variables).toEqual({ a: 1 })
  })

  test('never puts the token in the request URL or the body', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('do-not-leak'),
      fetchImpl: fakeFetch(200, { data: {} }, captured),
    })
    await client.graphql('query { x }', {})
    expect(captured[0].url).not.toContain('do-not-leak')
    expect(captured[0].init?.body as string).not.toContain('do-not-leak')
  })

  test('throws GithubGraphqlError on a non-2xx', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(502, { message: 'bad gateway' }, []),
    })
    await expect(client.graphql('query { x }', {})).rejects.toBeInstanceOf(GithubGraphqlError)
  })

  test('throws GithubGraphqlError when the response carries top-level errors', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { errors: [{ message: "Field 'x' doesn't exist" }] }, []),
    })
    await expect(client.graphql('query { x }', {})).rejects.toBeInstanceOf(GithubGraphqlError)
  })
})

describe('createGithubClient.getReviewThreads', () => {
  test('returns the connection nodes + pageInfo, defaulting an empty PR to no threads', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(
        200,
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ id: 'PRRT_x', comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }],
                },
              },
            },
          },
        },
        [],
      ),
    })
    const page = await client.getReviewThreads('o', 'r', 3, null)
    expect(page.nodes.map((n) => n.id)).toEqual(['PRRT_x'])
    expect(page.pageInfo.hasNextPage).toBe(false)
  })

  test('a null pullRequest (deleted/absent) yields an empty page, not a throw', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { data: { repository: { pullRequest: null } } }, []),
    })
    const page = await client.getReviewThreads('o', 'r', 999, null)
    expect(page.nodes).toEqual([])
    expect(page.pageInfo.hasNextPage).toBe(false)
  })
})

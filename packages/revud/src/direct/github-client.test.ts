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

describe('createGithubClient.getBlob (the single-blob REST fallback)', () => {
  test('returns the base64 content, encoding, and size from git/blobs/{sha}', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(
        200,
        { content: 'aGVsbG8=\n', encoding: 'base64', size: 5 },
        captured,
      ),
      baseUrl: 'https://api.github.test',
    })
    const blob = await client.getBlob('o', 'r', 'abc123')
    expect(blob.encoding).toBe('base64')
    expect(blob.size).toBe(5)
    // The raw base64 is returned verbatim; the caller decodes it.
    expect(blob.content).toBe('aGVsbG8=\n')
    expect(captured[0].url).toBe('https://api.github.test/repos/o/r/git/blobs/abc123')
  })

  test('throws GithubRequestError on a non-2xx', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(404, { message: 'Not Found' }, []),
    })
    await expect(client.getBlob('o', 'r', 'missing')).rejects.toBeInstanceOf(GithubRequestError)
  })
})

describe('createGithubClient.getBlobObjects (the GraphQL object() batch)', () => {
  test('aliases each SHA under object(oid:) and maps the results back by SHA', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(
        200,
        {
          data: {
            repository: {
              b0: { isBinary: false, text: 'alpha\n', byteSize: 6 },
              b1: { isBinary: true, text: null, byteSize: 2048 },
            },
          },
        },
        captured,
      ),
      graphqlUrl: 'https://api.github.test/graphql',
    })
    const result = await client.getBlobObjects('o', 'r', ['SHA_A', 'SHA_B'])
    expect(result.SHA_A).toEqual({ isBinary: false, text: 'alpha\n', byteSize: 6 })
    expect(result.SHA_B).toEqual({ isBinary: true, text: null, byteSize: 2048 })

    // SHAs travel as $o<index> variables, never spliced into the query string.
    const body = JSON.parse(captured[0].init?.body as string) as {
      query: string
      variables: Record<string, unknown>
    }
    expect(body.query).toContain('object(oid:$o0)')
    expect(body.query).toContain('... on Blob { isBinary text byteSize isTruncated }')
    expect(body.query).not.toContain('SHA_A')
    expect(body.variables.o0).toBe('SHA_A')
    expect(body.variables.o1).toBe('SHA_B')
  })

  test('an unresolved alias (null repository field) maps that SHA to null', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { data: { repository: { b0: null } } }, []),
    })
    const result = await client.getBlobObjects('o', 'r', ['GONE'])
    expect(result.GONE).toBeNull()
  })

  test('an empty SHA list makes no request and returns an empty map', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { data: {} }, captured),
    })
    const result = await client.getBlobObjects('o', 'r', [])
    expect(result).toEqual({})
    expect(captured).toHaveLength(0)
  })

  test('never puts the token in the request URL or body', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('leak-me-not'),
      fetchImpl: fakeFetch(200, { data: { repository: { b0: null } } }, captured),
    })
    await client.getBlobObjects('o', 'r', ['X'])
    expect(captured[0].url).not.toContain('leak-me-not')
    expect(captured[0].init?.body as string).not.toContain('leak-me-not')
  })
})

describe('createGithubClient write surface', () => {
  test('submitReview POSTs to the reviews endpoint with the review body', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { id: 42, state: 'COMMENTED', commit_id: 'h' }, captured),
      baseUrl: 'https://api.github.test',
    })
    const body = {
      commit_id: 'h',
      event: 'COMMENT' as const,
      body: 'review text',
      comments: [{ path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'note' }],
    }
    const raw = (await client.submitReview('o', 'r', 5, body)) as { id: number }
    expect(raw.id).toBe(42)
    const req = captured[0]
    expect(req.url).toBe('https://api.github.test/repos/o/r/pulls/5/reviews')
    expect((req.init as RequestInit).method).toBe('POST')
    const sent = JSON.parse((req.init as RequestInit).body as string) as typeof body
    expect(sent.commit_id).toBe('h')
    expect(sent.comments[0].path).toBe('a.ts')
  })

  test('submitReview throws a GithubRequestError carrying the 422 status', async () => {
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(422, { message: 'validation failed' }, []),
    })
    let thrown: unknown
    try {
      await client.submitReview('o', 'r', 5, { commit_id: 'h', event: 'COMMENT', body: '', comments: [] })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(GithubRequestError)
    expect((thrown as GithubRequestError).status).toBe(422)
  })

  test('replyToReviewComment POSTs to the comment replies endpoint', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(201, { id: 99, in_reply_to_id: 7 }, captured),
      baseUrl: 'https://api.github.test',
    })
    await client.replyToReviewComment('o', 'r', 5, 7, 'thanks')
    const req = captured[0]
    expect(req.url).toBe('https://api.github.test/repos/o/r/pulls/5/comments/7/replies')
    expect((req.init as RequestInit).method).toBe('POST')
    const sent = JSON.parse((req.init as RequestInit).body as string) as { body: string }
    expect(sent.body).toBe('thanks')
  })

  test('addReaction POSTs the content to the pulls-comment reactions endpoint', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { id: 1, content: '+1' }, captured),
      baseUrl: 'https://api.github.test',
    })
    await client.addReaction('o', 'r', 88, '+1')
    const req = captured[0]
    expect(req.url).toBe('https://api.github.test/repos/o/r/pulls/comments/88/reactions')
    const sent = JSON.parse((req.init as RequestInit).body as string) as { content: string }
    expect(sent.content).toBe('+1')
  })

  test('setThreadResolution runs the resolve mutation and returns the thread node', async () => {
    const captured: Captured[] = []
    const node = {
      id: 'PRRT_x',
      isResolved: true,
      isOutdated: false,
      path: 'a.ts',
      line: 3,
      originalLine: 3,
      startLine: null,
      originalStartLine: null,
      diffSide: 'RIGHT',
      startDiffSide: null,
      subjectType: 'LINE',
      resolvedBy: { login: 'alice' },
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    }
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { data: { resolveReviewThread: { thread: node } } }, captured),
    })
    const out = await client.setThreadResolution('PRRT_x', true)
    expect(out.id).toBe('PRRT_x')
    expect(out.isResolved).toBe(true)
    const sent = JSON.parse((captured[0].init as RequestInit).body as string) as { query: string }
    expect(sent.query).toContain('resolveReviewThread')
  })

  test('setThreadResolution(false) runs the unresolve mutation', async () => {
    const captured: Captured[] = []
    const node = {
      id: 'PRRT_x', isResolved: false, isOutdated: false, path: 'a.ts', line: 3,
      originalLine: 3, startLine: null, originalStartLine: null, diffSide: 'RIGHT',
      startDiffSide: null, subjectType: 'LINE', resolvedBy: null,
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    }
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { data: { unresolveReviewThread: { thread: node } } }, captured),
    })
    await client.setThreadResolution('PRRT_x', false)
    const sent = JSON.parse((captured[0].init as RequestInit).body as string) as { query: string }
    expect(sent.query).toContain('unresolveReviewThread')
  })

  test('getReviewComments pages the one-review comments endpoint', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, [{ id: 1, path: 'a.ts' }], captured),
      baseUrl: 'https://api.github.test',
    })
    const page = await client.getReviewComments('o', 'r', 5, 42, { page: 1, perPage: 100 })
    expect(page.items).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://api.github.test/repos/o/r/pulls/5/reviews/42/comments?per_page=100&page=1',
    )
  })

  test('addIssueCommentReaction POSTs to the ISSUE comment reactions endpoint', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { id: 1, content: 'heart' }, captured),
      baseUrl: 'https://api.github.test',
    })
    await client.addIssueCommentReaction('o', 'r', 88, 'heart')
    const req = captured[0]
    expect(req.url).toBe('https://api.github.test/repos/o/r/issues/comments/88/reactions')
    expect((req.init as RequestInit).method).toBe('POST')
    const sent = JSON.parse((req.init as RequestInit).body as string) as { content: string }
    expect(sent.content).toBe('heart')
  })

  test('getIssueComment GETs the single issue comment (rollup read-back)', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('t'),
      fetchImpl: fakeFetch(200, { id: 88, reactions: { total_count: 1 } }, captured),
      baseUrl: 'https://api.github.test',
    })
    await client.getIssueComment('o', 'r', 88)
    expect(captured[0].url).toBe('https://api.github.test/repos/o/r/issues/comments/88')
    expect((captured[0].init as RequestInit).method).toBe('GET')
  })

  test('a write never places the token in the URL or body', async () => {
    const captured: Captured[] = []
    const client = createGithubClient({
      tokenSource: staticToken('super-secret'),
      fetchImpl: fakeFetch(200, { id: 1 }, captured),
    })
    await client.submitReview('o', 'r', 1, { commit_id: 'h', event: 'COMMENT', body: 'x', comments: [] })
    expect(captured[0].url).not.toContain('super-secret')
    expect((captured[0].init as RequestInit).body as string).not.toContain('super-secret')
  })
})

/**
 * Mapping raw GitHub REST payloads onto the contract types. These are pure,
 * network-free assertions on the narrowing: patch presence stays honest (a
 * binary/oversize file has no `patch`), enums coerce to their contract values,
 * and missing optional fields default rather than throw.
 */
import { describe, expect, test } from 'bun:test'
import {
  mapCheckRuns,
  mapCommit,
  mapIssueComment,
  mapPullDetail,
  mapPullFile,
  mapReview,
  mapReviewComment,
  mapUser,
} from './mappers'

describe('mapPullFile', () => {
  test('carries patch when GitHub sent one', () => {
    const f = mapPullFile({
      sha: 's',
      filename: 'a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: '@@ -1 +1 @@',
    })
    expect(f.patch).toBe('@@ -1 +1 @@')
  })

  test('omits patch for a binary/oversize file (no patch field) — honest, not faked', () => {
    const f = mapPullFile({ sha: 's', filename: 'img.png', status: 'added' })
    expect(f.patch).toBeUndefined()
    expect(f.filename).toBe('img.png')
  })

  test('carries previous_filename only for a rename', () => {
    const renamed = mapPullFile({
      sha: 's',
      filename: 'new.ts',
      status: 'renamed',
      previous_filename: 'old.ts',
    })
    expect(renamed.previous_filename).toBe('old.ts')
    const plain = mapPullFile({ sha: 's', filename: 'a.ts', status: 'modified' })
    expect(plain.previous_filename).toBeUndefined()
  })

  test('an unknown status coerces to modified', () => {
    expect(mapPullFile({ filename: 'a', status: 'weird' }).status).toBe('modified')
  })
})

describe('mapPullDetail folds in the derived merge base', () => {
  test('merge_base_sha comes from the argument, not the payload', () => {
    const d = mapPullDetail(
      { number: 7, head: { sha: 'h' }, base: { sha: 'b' }, state: 'open' },
      'MB',
    )
    expect(d.merge_base_sha).toBe('MB')
    expect(d.head.sha).toBe('h')
    expect(d.number).toBe(7)
  })

  test('defaults are contract-valid on a lean payload', () => {
    const d = mapPullDetail({}, 'MB')
    expect(d.state).toBe('open')
    expect(d.mergeable_state).toBe('unknown')
    expect(d.labels).toEqual([])
    expect(d.body).toBeNull()
  })
})

describe('mapUser', () => {
  test('null for a null user (a deleted account)', () => {
    expect(mapUser(null)).toBeNull()
  })

  test('coerces an unknown type to User', () => {
    expect(mapUser({ login: 'x', id: 1, type: 'Mannequin' })?.type).toBe('User')
    expect(mapUser({ login: 'b', id: 2, type: 'Bot' })?.type).toBe('Bot')
  })
})

describe('mapIssueComment / mapReview / mapCommit / mapCheckRuns', () => {
  test('issue comment reactions default to a zeroed rollup', () => {
    const c = mapIssueComment({ id: 1, body: 'hi', user: { login: 'x', id: 1 } })
    expect(c.reactions.total_count).toBe(0)
    expect(c.reactions['+1']).toBe(0)
  })

  test('review state coerces to a contract value', () => {
    expect(mapReview({ id: 1, state: 'APPROVED' }).state).toBe('APPROVED')
    expect(mapReview({ id: 2, state: 'GARBAGE' }).state).toBe('COMMENTED')
  })

  test('commit carries author + parents', () => {
    const c = mapCommit({
      sha: 'c1',
      commit: { message: 'm', author: { name: 'A', email: 'a@x', date: '2026' } },
      author: { login: 'a', id: 1 },
      parents: [{ sha: 'p1' }],
    })
    expect(c.sha).toBe('c1')
    expect(c.commit.author.date).toBe('2026')
    expect(c.parents).toEqual([{ sha: 'p1' }])
  })

  test('check runs read from the check_runs array', () => {
    const runs = mapCheckRuns({
      check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }],
    })
    expect(runs).toHaveLength(1)
    expect(runs[0].conclusion).toBe('success')
  })

  test('an unknown check conclusion coerces to null', () => {
    const runs = mapCheckRuns({
      check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'weird' }],
    })
    expect(runs[0].conclusion).toBeNull()
  })
})

describe('mapReviewComment (REST reply / single-comment response)', () => {
  test('maps a reply comment, carrying in_reply_to_id when present', () => {
    const c = mapReviewComment({
      id: 7001,
      node_id: 'PRRC_x',
      pull_request_review_id: null,
      in_reply_to_id: 42,
      path: 'a.ts',
      diff_hunk: '@@ -1 +1 @@',
      commit_id: 'h',
      original_commit_id: 'h',
      line: 5,
      original_line: 5,
      start_line: null,
      original_start_line: null,
      side: 'RIGHT',
      start_side: null,
      subject_type: 'line',
      user: { login: 'alice', id: 1, type: 'User' },
      body: 'thanks',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      reactions: { total_count: 0, '+1': 0 },
      html_url: 'https://github.com/o/r/pull/1#discussion_r7001',
    })
    expect(c.id).toBe(7001)
    expect(c.in_reply_to_id).toBe(42)
    expect(c.side).toBe('RIGHT')
    expect(c.user.login).toBe('alice')
    expect(c.body).toBe('thanks')
  })

  test('a root comment (no in_reply_to_id) omits the field', () => {
    const c = mapReviewComment({ id: 1, path: 'a.ts', body: 'x' })
    expect('in_reply_to_id' in c).toBe(false)
    // Defensive defaults for a lean payload.
    expect(c.side).toBe('RIGHT')
    expect(c.line).toBeNull()
    expect(c.reactions.total_count).toBe(0)
  })
})

/**
 * The boundary of "a draft holds text", pinned from both sides. The empty
 * shape an editor creates on its own must read as empty — otherwise merely
 * opening a review makes it undeletable — and each of the two ways a human
 * puts something into a draft must read as text on its own, so a check that
 * looked at only one of them could not pass here.
 */
import { describe, expect, it } from 'bun:test'
import type { PendingComment } from '../api/types'
import { draftHoldsText } from './drafts'

function pending(body: string): PendingComment {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    key: 'k',
    path: 'src/a.ts',
    side: 'RIGHT',
    start_side: null,
    line: 1,
    start_line: null,
    body,
    createdAt: at,
    updatedAt: at,
    anchor: { lineText: 'x', contextBefore: [], contextAfter: [] },
  }
}

describe('draftHoldsText', () => {
  it('an editor-created draft — empty body, no comments — holds nothing', () => {
    expect(draftHoldsText({ body: '', comments: [] })).toBe(false)
  })

  it('a body with any character in it is text, a lone newline included', () => {
    expect(draftHoldsText({ body: 'Looks good.', comments: [] })).toBe(true)
    expect(draftHoldsText({ body: '\n', comments: [] })).toBe(true)
  })

  it('a pending comment is text even when the body is empty', () => {
    expect(draftHoldsText({ body: '', comments: [pending('inline note')] })).toBe(true)
  })

  it('a pending comment counts by its presence, not by its own body', () => {
    // A comment a human anchored and has not typed into yet is still theirs:
    // the anchor is the work, and the check reads the array, not the text.
    expect(draftHoldsText({ body: '', comments: [pending('')] })).toBe(true)
  })
})

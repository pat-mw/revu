/**
 * Keeps the three copies of the error-code vocabulary in lockstep. The union
 * (`ApiErrorCode`), the status map (`HTTP_STATUS_BY_CODE`), and the literal
 * list inside `validateHttpErrorBody` each spell the codes independently:
 * `tsc` ties the union to the status map, but nothing ties either to the
 * validator's list — a code added to the union alone would compile green and
 * then be rejected on the wire as a `ValidationError`. These assertions close
 * that hole, and the pinned list makes any change to the vocabulary loud.
 */

import { describe, expect, test } from 'bun:test'
import { ApiError } from './api/types'
import { HTTP_STATUS_BY_CODE, statusForApiError } from './http'
import { ValidationError, validateHttpErrorBody } from './http-validators'

/** Every code that can ride the wire, plus the client-side-only `network`. */
const allCodes = [...Object.keys(HTTP_STATUS_BY_CODE), 'network']

describe('the error-code vocabulary is pinned', () => {
  test('the full code set is exactly the expected literal list', () => {
    expect([...allCodes].sort()).toEqual(
      [
        'broker_unreachable',
        'conflict',
        'forbidden',
        'network',
        'not_found',
        'persist_failed',
        'rate_limited',
        'unprocessable',
      ].sort(),
    )
  })

  test('unprocessable maps to HTTP 422', () => {
    expect(HTTP_STATUS_BY_CODE.unprocessable).toBe(422)
  })

  test('every wire status is an error status', () => {
    for (const status of Object.values(HTTP_STATUS_BY_CODE)) {
      expect(Number.isInteger(status)).toBe(true)
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(600)
    }
  })
})

describe('validateHttpErrorBody accepts every code in the vocabulary', () => {
  for (const code of allCodes) {
    test(`{ code: '${code}' } passes through unchanged`, () => {
      const body = { code, message: 'm' }
      expect(validateHttpErrorBody(body)).toStrictEqual(body)
    })
  }

  test('an unknown code throws ValidationError', () => {
    expect(() =>
      validateHttpErrorBody({ code: 'no_such_code', message: 'm' }),
    ).toThrow(ValidationError)
  })
})

describe('network never rides the wire', () => {
  test('statusForApiError throws for a network error', () => {
    expect(() => statusForApiError(new ApiError('network', 'offline'))).toThrow()
  })

  test('statusForApiError answers the mapped status for every wire code', () => {
    for (const [code, status] of Object.entries(HTTP_STATUS_BY_CODE)) {
      const err = new ApiError(code as ApiError['code'], 'm')
      expect(statusForApiError(err)).toBe(status)
    }
  })
})

import { ApiError } from '@revu/shared'
import { minutesUntil } from '@/lib/time'

/**
 * The title the human reads when a submit comes back `head_moved`. Unlike a
 * thrown API failure, `head_moved` is a RETURNED value the frontend branches on
 * to open the head-moved dialog — it never passes through `describeApiError`, so
 * this title, not a `describeApiError` sentence, is its whole user-facing copy.
 * It lives here, beside the other review copy, so the string has one source of
 * truth the dialog renders and a test can pin.
 */
export const HEAD_MOVED_TITLE = 'The branch moved while you were reviewing'

/**
 * One honest sentence for a thrown API failure. Rate-limit errors get the
 * countdown treatment because the shared bucket is a fact of life here, not
 * an anomaly; everything else surfaces the transport's own message, which the
 * mock (and a real broker) already phrases as failure + consequence.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited' && error.resetAt) {
      return `Rate limit exhausted. Resets in ${minutesUntil(error.resetAt)} minutes.`
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

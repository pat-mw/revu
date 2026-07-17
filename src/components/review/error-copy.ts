import { ApiError } from '@/api/types'
import { minutesUntil } from '@/lib/time'

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

import type { GithubClient } from './github-client'

/**
 * The write-surface methods of `GithubClient` as throwing stubs, for read-path
 * tests whose fake clients must satisfy the full interface without exercising a
 * write. A read test that spreads these gets an honest failure (never a silent
 * success) if it accidentally reaches the write path, and stays unchanged when a
 * new write method is added — the stub set is the one place they live.
 *
 * This is test-support code (imported only by `*.test.ts`), kept out of the
 * production surface: nothing here runs in a live daemon.
 */
export function unusedWriteMethods(): Pick<
  GithubClient,
  | 'submitReview'
  | 'replyToReviewComment'
  | 'addReaction'
  | 'addIssueCommentReaction'
  | 'getReviewComment'
  | 'getReviewComments'
  | 'getIssueComment'
  | 'setThreadResolution'
> {
  const notUsed = (name: string): never => {
    throw new Error(`the read path must not call the write method ${name}`)
  }
  return {
    submitReview: () => notUsed('submitReview'),
    replyToReviewComment: () => notUsed('replyToReviewComment'),
    addReaction: () => notUsed('addReaction'),
    addIssueCommentReaction: () => notUsed('addIssueCommentReaction'),
    getReviewComment: () => notUsed('getReviewComment'),
    getReviewComments: () => notUsed('getReviewComments'),
    getIssueComment: () => notUsed('getIssueComment'),
    setThreadResolution: () => notUsed('setThreadResolution'),
  }
}

/**
 * A full `GithubClient` whose every method throws when called, for write-path
 * tests that exercise only a few methods and override just those. Spreading this
 * base means a test never has to stub the dozen read methods it does not touch,
 * and any accidental call fails loudly rather than returning a silent default.
 * Test-support code (imported only by `*.test.ts`).
 */
export function throwingGithubClient(): GithubClient {
  const notUsed = (name: string): never => {
    throw new Error(`the test did not stub GithubClient.${name}`)
  }
  return {
    getViewer: () => notUsed('getViewer'),
    getPullDetail: () => notUsed('getPullDetail'),
    getCompare: () => notUsed('getCompare'),
    getPullFiles: () => notUsed('getPullFiles'),
    getIssueComments: () => notUsed('getIssueComments'),
    getPullReviews: () => notUsed('getPullReviews'),
    getPullCommits: () => notUsed('getPullCommits'),
    getCheckRuns: () => notUsed('getCheckRuns'),
    getTree: () => notUsed('getTree'),
    getBlob: () => notUsed('getBlob'),
    getBlobObjects: () => notUsed('getBlobObjects'),
    graphql: () => notUsed('graphql'),
    getReviewThreads: () => notUsed('getReviewThreads'),
    getThreadComments: () => notUsed('getThreadComments'),
    ...unusedWriteMethods(),
  }
}

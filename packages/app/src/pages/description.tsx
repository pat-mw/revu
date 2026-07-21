import { Link, useParams } from 'react-router'
import { FileText } from 'lucide-react'
import { identityName } from '@revu/shared'
import { useSnapshot } from '@/state/queries'
import { useSession } from '@/state/session'
import { readPullDescription } from '@/lib/pull-description'
import { relativeTime } from '@/lib/time'
import { IdentityAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Markdown } from '@/components/ui/markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { SyncEmptyState } from './pr-layout'

/**
 * The Description tab: the pull request body as it stood at the last sync,
 * read-only, in the same markdown renderer every other comment body uses.
 *
 * The two ways this page can show no prose are kept apart on purpose. An
 * unsynced pull request has a body nobody has fetched yet, and the fix is the
 * sync burst. A synced one with an empty body has no description at all, and
 * no amount of syncing will produce one — so it points at the diff instead.
 * Collapsing the two would tell the reader something untrue about the pull
 * request either way.
 */
export function DescriptionPage() {
  const prNumber = Number(useParams<{ n: string }>().n)
  const session = useSession()
  const snapshot = useSnapshot(prNumber).data

  if (snapshot === undefined) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-2 px-4 py-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    )
  }

  if (snapshot === null) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <SyncEmptyState
            prNumber={prNumber}
            icon={<FileText size={20} strokeWidth={1.5} />}
            title="Sync to read the description"
            hint="Everything after sync is local."
          />
        </div>
      </div>
    )
  }

  const pull = snapshot.mutable.pull
  const description = readPullDescription(pull, session.brokerLogin)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4">
        {description.isEmpty ? (
          <EmptyState
            icon={<FileText size={20} strokeWidth={1.5} />}
            title="This pull request has no description"
            hint="It was opened with an empty body, so the diff and the commits are the whole account of the change."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="../files">Open files</Link>
              </Button>
            }
          />
        ) : (
          <article className="rounded-(--radius-sm) border border-line bg-panel">
            <header className="hairline-b flex min-w-0 items-center gap-2 px-3 py-2">
              <IdentityAvatar identity={description.identity} size="xs" />
              <span className="truncate text-sm font-medium text-ink">
                {identityName(description.identity)}
              </span>
              <span className="shrink-0 text-2xs text-ink-mut">opened this pull request</span>
              <span className="ml-auto shrink-0 text-2xs text-ink-faint">
                {relativeTime(pull.created_at)}
              </span>
            </header>
            <div className="px-3 py-2">
              <Markdown>{description.body}</Markdown>
            </div>
          </article>
        )}
      </div>
    </div>
  )
}

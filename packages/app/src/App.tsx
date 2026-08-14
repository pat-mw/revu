import type { ReactElement } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router'

import { AppShell } from '@/components/app-shell'
import { InboxPage } from '@/pages/inbox'
import { PrLayout } from '@/pages/pr-layout'
import { DescriptionPage } from '@/pages/description'
import { ConversationPage } from '@/pages/conversation'
import { FilesPage } from '@/pages/files'
import { CommitsPage } from '@/pages/commits'
import { ChecksPage } from '@/pages/checks'
import { redirectTargetFor, reviewMode } from '@/lib/review-mode'
import type { ReviewTab } from '@/lib/review-mode'

/**
 * One review section, rendered only when the review actually has that section.
 *
 * Omitting a tab from the strip does not omit its route: `/pr/<n>/checks` and
 * `/pr/<n>/description` stay typeable and bookmarkable however the header is
 * drawn, and on a review of two local branches both of those screens have
 * nothing true to render — no continuous integration ran, and no body was typed
 * into a form. So the sections a review does not offer are answered here, with
 * the same table the strip reads, rather than left to render a claim about a
 * service this workspace is not talking to.
 *
 * Delete this and both screens are one bookmark away again, silently.
 */
function ReviewSection({ tab, page }: { tab: ReviewTab; page: ReactElement }) {
  const { n } = useParams<{ n: string }>()
  const target = redirectTargetFor(reviewMode(Number(n)), tab)
  if (target === null) return page
  return <Navigate to={`/pr/${n}/${target}`} replace />
}

/**
 * Deep-linkable URLs are part of the product: `/pr/482/files#thread-9931`
 * must land on the thread. Files is the default tab — people come here to work.
 */
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<InboxPage />} />
        <Route path="/pr/:n" element={<PrLayout />}>
          <Route index element={<Navigate to="files" replace />} />
          <Route
            path="description"
            element={<ReviewSection tab="description" page={<DescriptionPage />} />}
          />
          <Route
            path="conversation"
            element={<ReviewSection tab="conversation" page={<ConversationPage />} />}
          />
          <Route path="files" element={<ReviewSection tab="files" page={<FilesPage />} />} />
          <Route
            path="commits"
            element={<ReviewSection tab="commits" page={<CommitsPage />} />}
          />
          <Route
            path="checks"
            element={<ReviewSection tab="checks" page={<ChecksPage />} />}
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

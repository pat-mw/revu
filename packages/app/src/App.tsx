import { Navigate, Route, Routes } from 'react-router'

import { AppShell } from '@/components/app-shell'
import { InboxPage } from '@/pages/inbox'
import { PrLayout } from '@/pages/pr-layout'
import { DescriptionPage } from '@/pages/description'
import { ConversationPage } from '@/pages/conversation'
import { FilesPage } from '@/pages/files'
import { CommitsPage } from '@/pages/commits'
import { ChecksPage } from '@/pages/checks'

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
          <Route path="description" element={<DescriptionPage />} />
          <Route path="conversation" element={<ConversationPage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="commits" element={<CommitsPage />} />
          <Route path="checks" element={<ChecksPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

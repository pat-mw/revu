import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'

import '@fontsource/iosevka/400.css'
import '@fontsource/iosevka/400-italic.css'
import '@fontsource/iosevka/500.css'
import '@fontsource/iosevka/700.css'
import '@fontsource/atkinson-hyperlegible/400.css'
import '@fontsource/atkinson-hyperlegible/400-italic.css'
import '@fontsource/atkinson-hyperlegible/700.css'
import '@fontsource-variable/archivo/index.css'
import './styles/globals.css'

import { App } from './App'
import { queryClient } from './state/queries'
import { SessionProvider } from './state/session'
import { KeyboardProvider } from './lib/keyboard'
import { ToastProvider } from './components/ui/toast'
import { TooltipProvider } from './components/ui/tooltip'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <KeyboardProvider>
          <TooltipProvider>
            <ToastProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ToastProvider>
          </TooltipProvider>
        </KeyboardProvider>
      </SessionProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)

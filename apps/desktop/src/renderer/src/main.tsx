import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/ui'
import { queryClient } from '@/data/query'
import { applyAppearance, useSettings } from '@/data/settings'
import { router } from '@/app/router'
import { installErrorReporting } from './lib/errors'
import './styles.css'

installErrorReporting()

function Root() {
  const { appearance, accent } = useSettings()
  useEffect(() => applyAppearance({ appearance, accent }), [appearance, accent])
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

import { CSPProvider } from '@base-ui/react/csp-provider';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SessionProvider } from './api/session';
import { Toaster } from './ui/toast';
import { TooltipProvider } from './ui/tooltip';

/**
 * Everything the app runs inside. Base UI's own <style> elements are off (the CSP allows no inline
 * styles); the one rule they carried is in app.css.
 */
export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={400}>
          <Toaster>
            <SessionProvider>{children}</SessionProvider>
          </Toaster>
        </TooltipProvider>
      </QueryClientProvider>
    </CSPProvider>
  );
}

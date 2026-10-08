import { Toast as Base } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { overlaySurface } from './recipes';

/** One manager for the whole app, so anything (a failed mutation, a sign-out) can raise a toast. */
export const toastManager = Base.createToastManager();

type Kind = 'success' | 'error' | 'info';

function add(kind: Kind, title: string, description?: string) {
  toastManager.add({ title, description, type: kind, timeout: kind === 'error' ? 8000 : 4000 });
}

export const toast = {
  success: (title: string, description?: string) => add('success', title, description),
  error: (title: string, description?: string) => add('error', title, description),
  info: (title: string, description?: string) => add('info', title, description),
};

const ICONS: Record<Kind, ReactNode> = {
  success: <CircleCheck aria-hidden className="size-4 text-success-indicator" />,
  error: <CircleAlert aria-hidden className="size-4 text-destructive-indicator" />,
  info: <Info aria-hidden className="size-4 text-info-indicator" />,
};

export function Toaster({ children }: { children: ReactNode }) {
  return (
    <Base.Provider toastManager={toastManager} limit={4}>
      {children}
      <Base.Portal>
        <Base.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col-reverse gap-2 outline-hidden">
          <ToastList />
        </Base.Viewport>
      </Base.Portal>
    </Base.Provider>
  );
}

function ToastList() {
  const { toasts } = Base.useToastManager();
  return toasts.map((item) => (
    <Base.Root
      key={item.id}
      toast={item}
      className={cn(
        'relative flex items-start gap-3 rounded-xl px-3.5 py-3',
        overlaySurface,
        'transition-[opacity,translate] duration-300 ease-out-custom data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:opacity-0',
      )}
    >
      <span className="mt-0.5 flex shrink-0">
        {ICONS[(item.type as Kind | undefined) ?? 'info'] ?? ICONS.info}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Base.Title className="text-label text-foreground" />
        <Base.Description className="text-caption break-words text-muted-foreground" />
      </div>
      <Base.Close
        aria-label="Dismiss"
        className="-mt-0.5 -mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-fill hover:text-foreground"
      >
        <X aria-hidden className="size-3.5" />
      </Base.Close>
    </Base.Root>
  ));
}

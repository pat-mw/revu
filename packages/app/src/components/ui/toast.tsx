import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

export type ToastKind = 'info' | 'error' | 'success'

export interface ToastOptions {
  title: string
  detail?: string
  kind?: ToastKind
  /** A single inline action, e.g. "Undo" / "Re-sync". */
  action?: { label: string; onClick: () => void }
}

interface ToastRecord extends ToastOptions {
  id: number
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** How long a non-error toast lives before auto-dismissing (ms). */
const AUTO_DISMISS_MS = 6000
/** Most toasts visible at once; older ones fall off the top of the stack. */
const MAX_STACK = 4

/**
 * A tiny bespoke toaster — no dependency, tuned to the app's density. Toasts stack
 * bottom-right, capped at four. Info/success auto-dismiss after six seconds with
 * the timer paused while the pointer is over the stack; error toasts persist until
 * dismissed, because a failure the user didn't see is a failure they'll repeat.
 * The provider mounts its own portal viewport, so there is no separate Toaster to
 * place — importing and rendering `ToastProvider` is enough. `Toaster` is exported
 * as a no-op for symmetry with call sites that expect a mountable viewport.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const idRef = useRef(0)
  const [paused, setPaused] = useState(false)
  const mountedRef = useRef(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    setMounted(true)
    return () => {
      mountedRef.current = false
    }
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((opts: ToastOptions) => {
    const id = ++idRef.current
    setToasts((prev) => {
      const next = [...prev, { ...opts, id }]
      return next.length > MAX_STACK ? next.slice(next.length - MAX_STACK) : next
    })
    return id
  }, [])

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            className="pointer-events-none fixed bottom-3 right-3 z-[100] flex w-80 flex-col gap-2"
            role="region"
            aria-label="Notifications"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            {toasts.map((t) => (
              <ToastCard key={t.id} toast={t} paused={paused} onDismiss={dismiss} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  )
}
ToastProvider.displayName = 'ToastProvider'

const KIND_META: Record<
  ToastKind,
  { icon: typeof Info; className: string; persist: boolean }
> = {
  info: { icon: Info, className: 'text-ink-mut', persist: false },
  success: { icon: CheckCircle2, className: 'text-add', persist: false },
  error: { icon: XCircle, className: 'text-danger', persist: true },
}

function ToastCard({
  toast,
  paused,
  onDismiss,
}: {
  toast: ToastRecord
  paused: boolean
  onDismiss: (id: number) => void
}) {
  const kind = toast.kind ?? 'info'
  const meta = KIND_META[kind]
  const Icon = meta.icon

  useEffect(() => {
    if (meta.persist || paused) return
    const handle = window.setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(handle)
  }, [meta.persist, paused, toast.id, onDismiss])

  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-2.5 rounded-(--radius-md) border border-line bg-overlay px-3 py-2.5 text-sm text-ink shadow-xl',
      )}
    >
      <Icon
        size={15}
        strokeWidth={1.5}
        className={cn('mt-0.5 shrink-0', meta.className)}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium leading-snug text-ink">{toast.title}</p>
        {toast.detail && (
          <p className="text-xs leading-relaxed text-ink-mut">{toast.detail}</p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick()
              onDismiss(toast.id)
            }}
            className="mt-0.5 self-start rounded-(--radius-xs) text-xs font-medium text-draft transition-colors hover:text-draft/80"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 -mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-(--radius-xs) text-ink-faint transition-colors hover:bg-raised hover:text-ink"
      >
        <X size={13} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  )
}

/**
 * Access the toaster from anywhere under `ToastProvider`. Returns a stable
 * `toast()` that queues a notification (and returns its id) plus a `dismiss(id)`.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}

/**
 * A no-op mount point. The viewport already ships inside `ToastProvider`, so
 * nothing needs mounting; this exists only so call sites that expect a
 * `<Toaster />` compile and render harmlessly.
 */
export function Toaster() {
  return null
}
Toaster.displayName = 'Toaster'

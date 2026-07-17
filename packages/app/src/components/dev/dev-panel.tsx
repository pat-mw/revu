import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { NameAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { mockDev, DEV_EVENT } from '@/api/mock/devtools'
import type { DevState } from '@/api/mock/devtools'
import { minutesUntil } from '@/lib/time'
import { cn } from '@/lib/cn'

/**
 * Subscribe a component to dev-panel state. Reads `mockDev.get()` and re-reads
 * on every `DEV_EVENT`, so an identity/latency/failure change made here or
 * elsewhere is reflected immediately. The rate reading is refreshed alongside.
 */
function useDevState(): { dev: DevState; rate: ReturnType<typeof mockDev.getRate> } {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(DEV_EVENT, onChange)
    return () => window.removeEventListener(DEV_EVENT, onChange)
  }, [])
  // `tick` is only a re-render trigger; the fresh reads happen on every render.
  void tick
  return { dev: mockDev.get(), rate: mockDev.getRate() }
}

/** Section label — dense uppercase micro-label in the faintest ink. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-sans text-2xs font-medium uppercase tracking-wide text-ink-faint">
      {children}
    </h3>
  )
}

/** A labeled `<select>` retokened to the dense dark surface. */
function DevSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-ink-mut">
      <span className="shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-7 rounded-(--radius-sm) border border-line bg-raised px-2 text-sm text-ink outline-none hover:border-line-strong"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

const LATENCY_OPTIONS: { value: DevState['latency']; label: string }[] = [
  { value: 'zero', label: 'zero' },
  { value: 'fast', label: 'fast' },
  { value: 'realistic', label: 'realistic' },
  { value: 'slow', label: 'slow' },
]

const FAILURE_OPTIONS: { value: DevState['failureMode']; label: string }[] = [
  { value: 'none', label: 'none' },
  { value: 'writes', label: 'writes fail' },
  { value: 'sync', label: 'sync fails' },
  { value: 'all', label: 'broker unreachable' },
]

/** One-line explanation of what each failure mode proves. */
const FAILURE_CAPTION: Record<DevState['failureMode'], string> = {
  none: 'Everything succeeds — the happy path.',
  writes:
    'Replies and submits fail; user text rolls back editable, never discarded.',
  sync: 'Sync fails; the cached snapshot still reviews fine — reads are local.',
  all: 'Broker unreachable: cached snapshots still review fine — reads are local.',
}

/** The scenario map: each PR paired with the exact behavior it demonstrates. */
const SCENARIOS: { n: number; note: string }[] = [
  { n: 101, note: 'first sync happy path' },
  { n: 204, note: '2,400-line diff, lockfile, binary, rename (virtualization)' },
  {
    n: 312,
    note: 'mid-review threads: resolved/outdated/suggestion/reactions + your seeded draft',
  },
  { n: 347, note: 'you authored it — author mode + queue' },
  { n: 355, note: 'org-member PR — Approve actually works' },
  { n: 362, note: 'failing checks + merge conflict' },
  {
    n: 389,
    note: 'stale snapshot + draft against an old head → submit reconcile (clean/drifted/lost)',
  },
  { n: 401, note: 'sync dies partway — partial snapshot' },
  { n: 410, note: "base advanced, head didn't — diff still changed" },
  { n: 415, note: 'thread resolved on github.com since sync, zero new commits' },
]

/**
 * The demo control room. Everything here is out-of-band production tooling that
 * would not ship in the real broker client, so it is the one sanctioned importer
 * of the mock transport's dev hooks (`mockDev`). It lets a presenter prove the
 * app's hardest invariants on demand: identity isolation (drafts are broker-side,
 * keyed to the human), offline-first reads, honest rate accounting, and the full
 * map of which PR demonstrates which behavior.
 */
export function DevPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const { dev, rate } = useDevState()
  const [confirmingReset, setConfirmingReset] = useState(false)

  // A closing panel abandons any half-committed reset confirmation.
  useEffect(() => {
    if (!open) setConfirmingReset(false)
  }, [open])

  const humans = mockDev.listHumans()

  const goToPr = useCallback(
    (n: number) => {
      onOpenChange(false)
      navigate(`/pr/${n}`)
    },
    [navigate, onOpenChange],
  )

  const doReset = useCallback(() => {
    mockDev.reset()
    setConfirmingReset(false)
    onOpenChange(false)
    navigate('/')
  }, [navigate, onOpenChange])

  const spentPct =
    rate.limit > 0 ? Math.min(100, (rate.used / rate.limit) * 100) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Demo controls</DialogTitle>
          <DialogDescription>
            Out-of-band tooling to prove the app's invariants on demand.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 flex max-h-[70vh] flex-col divide-y divide-line overflow-y-auto">
          {/* ——— Identity ——— */}
          <section className="flex flex-col gap-2 px-4 py-3">
            <SectionLabel>Identity</SectionLabel>
            <div className="flex flex-col gap-0.5">
              {humans.map((h) => {
                const active = h.id === dev.humanId
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => mockDev.setHuman(h.id)}
                    aria-pressed={active}
                    className={cn(
                      'flex items-center gap-2.5 rounded-(--radius-sm) px-2 py-1.5 text-left transition-colors',
                      active ? 'bg-raised' : 'hover:bg-raised/60',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                        active ? 'border-draft' : 'border-line-strong',
                      )}
                      aria-hidden
                    >
                      {active && (
                        <span className="size-1.5 rounded-full bg-draft" />
                      )}
                    </span>
                    <NameAvatar name={h.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {h.name}
                    </span>
                    <span className="shrink-0 text-2xs text-ink-faint">
                      {h.role}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">
              Drafts and viewed-state are broker-side, keyed to the human — switch
              identities to prove isolation.
            </p>
          </section>

          {/* ——— Network ——— */}
          <section className="flex flex-col gap-2 px-4 py-3">
            <SectionLabel>Network</SectionLabel>
            <DevSelect
              label="Latency"
              value={dev.latency}
              options={LATENCY_OPTIONS}
              onChange={(v) => mockDev.setLatency(v)}
            />
            <DevSelect
              label="Failure mode"
              value={dev.failureMode}
              options={FAILURE_OPTIONS}
              onChange={(v) => mockDev.setFailureMode(v)}
            />
            <p className="text-xs leading-relaxed text-ink-faint">
              {FAILURE_CAPTION[dev.failureMode]}
            </p>
          </section>

          {/* ——— Rate budget ——— */}
          <section className="flex flex-col gap-2 px-4 py-3">
            <SectionLabel>Rate budget</SectionLabel>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-sm text-ink">
                {rate.remaining.toLocaleString()}/{rate.limit.toLocaleString()}
              </span>
              <span className="text-xs text-ink-faint">
                resets in {minutesUntil(rate.reset)}m
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
              role="progressbar"
              aria-label="Shared rate budget spent"
              aria-valuemin={0}
              aria-valuemax={rate.limit}
              aria-valuenow={rate.used}
            >
              <div
                className="h-full rounded-full bg-ink"
                style={{ width: `${spentPct}%` }}
              />
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">
              One shared bucket across the whole installation. Reads spend it; a
              304 on the PR list poll costs nothing.
            </p>
          </section>

          {/* ——— Scenario map ——— */}
          <section className="flex flex-col gap-2 px-4 py-3">
            <SectionLabel>Scenario map</SectionLabel>
            <div className="flex flex-col gap-0.5">
              {SCENARIOS.map((s) => (
                <button
                  key={s.n}
                  type="button"
                  onClick={() => goToPr(s.n)}
                  className="flex items-baseline gap-2 rounded-(--radius-sm) px-1.5 py-1 text-left transition-colors hover:bg-raised"
                >
                  <span className="shrink-0 font-mono text-2xs text-ink-mut">
                    #{s.n}
                  </span>
                  <span className="min-w-0 text-xs leading-snug text-ink-mut">
                    {s.note}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* ——— Danger ——— */}
          <section className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <SectionLabel>Reset demo data</SectionLabel>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                Drops every draft, viewed flag, and mutation; re-seeds from
                fixtures.
              </p>
            </div>
            {confirmingReset ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={doReset}>
                  Confirm reset
                </Button>
              </div>
            ) : (
              <Button
                variant="danger"
                size="sm"
                className="shrink-0"
                onClick={() => setConfirmingReset(true)}
              >
                Reset demo data
              </Button>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
DevPanel.displayName = 'DevPanel'

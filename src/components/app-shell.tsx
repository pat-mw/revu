import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NameAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CommandPalette } from '@/components/palette'
import { ShortcutSheet } from '@/components/shortcut-sheet'
import { DevPanel } from '@/components/dev/dev-panel'
import { useRateLimit } from '@/state/queries'
import { useCurrentHuman, useSession } from '@/state/session'
import { mockDev } from '@/api/mock/devtools'
import { useSequenceShortcut } from '@/lib/keyboard'
import { minutesUntil } from '@/lib/time'
import { cn } from '@/lib/cn'

/** The client-side repo the whole workspace is scoped to — a chrome constant. */
const REPO_CONTEXT = 'meridian-labs/atlas'

/** Match `/pr/:n` at the head of a path, returning the PR number or null. */
function matchPrNumber(pathname: string): number | null {
  const m = /^\/pr\/(\d+)(?:\/|$)/.exec(pathname)
  return m ? Number(m[1]) : null
}

/**
 * The shared-bucket status chip. The single rate budget is spent across every
 * workspace in the installation, so its honesty matters: the number goes gold
 * under a thousand reads left and red under two hundred, and its tooltip names
 * exactly why a poll can be free (a 304 on the PR list costs nothing).
 */
function RateChip() {
  const rate = useRateLimit()
  if (!rate.data) {
    return <span className="skeleton h-3.5 w-16" aria-hidden />
  }
  const { remaining, limit, reset } = rate.data
  const tone =
    remaining < 200
      ? 'text-danger'
      : remaining < 1000
        ? 'text-stale'
        : 'text-ink-mut'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('cursor-default font-mono text-2xs tabular-nums', tone)}
          aria-label={`Shared rate budget: ${remaining} of ${limit} reads remaining`}
        >
          {remaining.toLocaleString()}/{limit.toLocaleString()}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Shared across every workspace in the installation. Resets in{' '}
        {minutesUntil(reset)}m. Reads spend it; the PR list polls free on 304s.
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The identity menu. Names who is currently driving the shared bot, lists every
 * human who can drive it (checkmarking the current one), and exposes the dev
 * panel plus a quiet, non-interactive workspace line: the app reviews through
 * one GitHub App identity, and that fact is always visible here.
 */
function IdentityMenu({ onOpenDevPanel }: { onOpenDevPanel: () => void }) {
  const human = useCurrentHuman()
  const session = useSession()
  const humans = mockDev.listHumans()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded-(--radius-sm) px-1.5 text-left outline-none transition-colors hover:bg-raised"
          aria-label="Identity and workspace menu"
        >
          <NameAvatar name={human.name} size="sm" />
          <span className="hidden min-w-0 flex-col leading-tight sm:flex">
            <span className="truncate text-xs text-ink">{human.name}</span>
            <span className="truncate text-2xs text-ink-faint">{human.role}</span>
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.5}
            className="shrink-0 text-ink-faint"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        {humans.map((h) => {
          const active = h.id === human.id
          return (
            <DropdownMenuItem
              key={h.id}
              onSelect={() => mockDev.setHuman(h.id)}
              className="gap-2"
            >
              <NameAvatar name={h.name} size="sm" />
              <span className="min-w-0 flex-1 truncate">{h.name}</span>
              <span className="shrink-0 text-2xs text-ink-faint">{h.role}</span>
              {active && (
                <Check
                  size={14}
                  strokeWidth={2}
                  className="shrink-0 !text-draft"
                  aria-hidden
                />
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenDevPanel}>Dev panel…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1 font-mono text-2xs leading-snug text-ink-faint">
          {session.workspace} · via {session.brokerLogin}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The application chrome: a dense topbar over a single scrollable work area.
 *
 * The topbar carries the product mark (the one place violet appears outside
 * draft state — a 5px dot standing in for "your unseen work"), the quiet repo
 * context, the shared rate-limit chip, a keyboard-help affordance, and the
 * identity menu. The shell owns the three global overlays (command palette,
 * shortcut sheet, dev panel), lifting their open-state here so any of them can
 * open any other, and it registers the `g …` navigation sequences that jump
 * between the inbox and a PR's tabs.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [devOpen, setDevOpen] = useState(false)

  const openSheet = useCallback(() => setSheetOpen(true), [])
  const openDevPanel = useCallback(() => setDevOpen(true), [])

  // Sequence navigation. `g i` always goes home; `g f` / `g c` switch the
  // current PR's tab and no-op gracefully when no PR is open.
  useSequenceShortcut(['g', 'i'], () => navigate('/'))
  useSequenceShortcut(['g', 'f'], () => {
    const n = matchPrNumber(location.pathname)
    if (n !== null) navigate(`/pr/${n}/files`)
  })
  useSequenceShortcut(['g', 'c'], () => {
    const n = matchPrNumber(location.pathname)
    if (n !== null) navigate(`/pr/${n}/conversation`)
  })

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <header className="hairline-b flex h-10 shrink-0 items-center gap-3 px-3">
        <Link
          to="/"
          className="flex items-center gap-1 rounded-(--radius-xs) font-display font-semibold tracking-tight text-ink outline-none"
          aria-label="revu — go to inbox"
        >
          <span>revu</span>
          <span
            className="size-[5px] rounded-full bg-draft"
            aria-hidden
          />
        </Link>

        <span className="hidden font-mono text-2xs text-ink-faint sm:inline">
          {REPO_CONTEXT}
        </span>

        <div className="ml-auto flex items-center gap-2.5">
          <RateChip />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Keyboard shortcuts"
            onClick={openSheet}
          >
            <span className="text-sm font-medium" aria-hidden>
              ?
            </span>
          </Button>
          <IdentityMenu onOpenDevPanel={openDevPanel} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenSheet={openSheet}
      />
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
      <DevPanel open={devOpen} onOpenChange={setDevOpen} />
    </div>
  )
}
AppShell.displayName = 'AppShell'

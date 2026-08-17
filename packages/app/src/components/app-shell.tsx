import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Check, ChevronDown, Moon, Sun } from 'lucide-react'
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
import {
  CreateLocalReviewDialog,
  CreateLocalReviewProvider,
} from '@/components/create-local-review'
import type { CreateLocalReviewControl } from '@/components/create-local-review'
import { DevPanel } from '@/components/dev/dev-panel'
import { usePullList, useRateLimit } from '@/state/queries'
import { useCurrentHuman, useSession } from '@/state/session'
import { devControls } from '@/api/dev'
import { useHumans } from '@/state/dev-humans'
import { useTheme } from '@/state/theme'
import { useSequenceShortcut, useShortcut } from '@/lib/keyboard'
import { matchPrNumber, showRateChip } from '@/lib/review-mode'
import { minutesUntil } from '@/lib/time'
import { cn } from '@/lib/cn'

/**
 * Header label for the repository the workspace is scoped to. Read from the
 * pull list rather than held as a constant, so the chrome names the repository
 * actually being reviewed instead of whichever one the fixtures describe.
 * Blank until the first list resolves — a wrong name is worse than none.
 */
function useRepoContext(): string | null {
  const list = usePullList()
  return list.data?.items[0]?.pull.base.repo.full_name ?? null
}

/**
 * The shared-bucket status chip. The single rate budget is spent across every
 * workspace in the installation, so its honesty matters: the number goes gold
 * under a thousand reads left and red under two hundred, and its tooltip says
 * which activity actually spends the budget — an unchanged list poll does not.
 *
 * Not every workspace has such a budget. One wired to no upstream service
 * answers the read with a failure rather than with a bucket, and that answer is
 * the difference between "still loading" and "there is nothing here" — which is
 * why the chip distinguishes them rather than treating both as no-data-yet. A
 * read still in flight keeps the chip's place and its shimmer; a read that came
 * back with nothing removes the chip entirely, because a shimmer that will
 * never resolve is a permanent load, not an absence.
 */
function RateChip() {
  const rate = useRateLimit()
  const rateAvailable = rate.data !== undefined ? true : rate.isError ? false : null
  if (!showRateChip({ rateAvailable })) return null
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
        {minutesUntil(reset)}m. Syncing and reading spend it; waiting on the
        inbox does not.
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
function IdentityMenu({
  onOpenDevPanel,
  theme,
  onToggleTheme,
}: {
  onOpenDevPanel: () => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}) {
  const human = useCurrentHuman()
  const session = useSession()
  const humans = useHumans()

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
        {/* Choosing who you are acting as is a demo affordance and exists only
            while the store is the mock one. Against real GitHub the roster is
            empty, and the switcher is omitted rather than shown empty — the
            acting identity there comes from the workspace, not from a menu. */}
        {humans.length > 0 && (
          <>
            {humans.map((h) => {
              const active = h.id === human.id
              return (
                <DropdownMenuItem
                  key={h.id}
                  onSelect={() => void devControls.setHuman(h.id)}
                  className="gap-2"
                >
                  <NameAvatar name={h.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{h.name}</span>
                  <span className="shrink-0 text-2xs text-ink-faint">
                    {h.role}
                  </span>
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
          </>
        )}
        <DropdownMenuItem
          // Keep the menu open on toggle so the scheme switch is visible in place.
          onSelect={(e) => {
            e.preventDefault()
            onToggleTheme()
          }}
          className="gap-2"
        >
          {theme === 'dark' ? (
            <Sun size={14} strokeWidth={1.5} aria-hidden />
          ) : (
            <Moon size={14} strokeWidth={1.5} aria-hidden />
          )}
          <span className="flex-1">
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </span>
          <span className="text-2xs text-ink-faint">
            {theme === 'dark' ? 'Dark' : 'Light'}
          </span>
        </DropdownMenuItem>
        {humans.length > 0 && (
          <DropdownMenuItem onSelect={onOpenDevPanel}>
            Dev panel…
          </DropdownMenuItem>
        )}
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
 * identity menu. The shell owns the four global overlays (command palette,
 * shortcut sheet, create-review dialog, dev panel), lifting their open-state
 * here so any of them can open any other, and it registers the `g …` sequences
 * that jump between the inbox and a PR's tabs and start a local review.
 *
 * The create dialog is also offered from the routed screen below, which the
 * shell cannot pass props to, so the shell provides the dialog's own opener
 * context around everything. The palette takes the opener as a prop instead,
 * exactly as it already takes the one for the shortcut sheet — the shell
 * renders it, so there is nothing to reach across.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [devOpen, setDevOpen] = useState(false)

  // Color scheme is applied to <html> and the highlighter from the stored
  // preference here, once, at the top of the shell — the menu below only reads it.
  const { theme, setTheme } = useTheme()
  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  const openSheet = useCallback(() => setSheetOpen(true), [])
  const openDevPanel = useCallback(() => setDevOpen(true), [])
  const openCreate = useCallback(() => setCreateOpen(true), [])
  const repoContext = useRepoContext()

  const createControl = useMemo<CreateLocalReviewControl>(
    () => ({ open: openCreate, isOpen: createOpen }),
    [openCreate, createOpen],
  )

  // Sequence navigation. `g i` always goes home; `g f` / `g c` switch the
  // current PR's tab and no-op gracefully when no PR is open. `g l` starts a
  // local review, and is registered here rather than on the inbox so it works
  // from a PR page too — the same reach the palette entry has.
  useSequenceShortcut(['g', 'i'], () => navigate('/'))
  useSequenceShortcut(['g', 'f'], () => {
    const n = matchPrNumber(location.pathname)
    if (n !== null) navigate(`/pr/${n}/files`)
  })
  useSequenceShortcut(['g', 'c'], () => {
    const n = matchPrNumber(location.pathname)
    if (n !== null) navigate(`/pr/${n}/conversation`)
  })
  useSequenceShortcut(['g', 'l'], openCreate)

  // Toggle the color scheme from anywhere; documented in the '?' sheet catalog.
  useShortcut('mod+shift+l', toggleTheme)

  return (
    <CreateLocalReviewProvider control={createControl}>
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

          {repoContext !== null && (
            <span className="hidden font-mono text-2xs text-ink-faint sm:inline">
              {repoContext}
            </span>
          )}

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
            <IdentityMenu
              onOpenDevPanel={openDevPanel}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenSheet={openSheet}
          onCreateLocalReview={openCreate}
        />
        <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
        {/* The one mount of the create dialog. Every entry point — the header
            control, the empty inbox's invitation, the palette, the chord —
            raises this instance through the control above. */}
        <CreateLocalReviewDialog open={createOpen} onOpenChange={setCreateOpen} />
        <DevPanel open={devOpen} onOpenChange={setDevOpen} />
      </div>
    </CreateLocalReviewProvider>
  )
}
AppShell.displayName = 'AppShell'

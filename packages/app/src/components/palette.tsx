import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  CheckSquare,
  FileDiff,
  GitCommitHorizontal,
  Inbox,
  Keyboard,
  ListChecks,
  MessagesSquare,
  RefreshCw,
  User,
} from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { NameAvatar } from '@/components/ui/avatar'
import { usePullList } from '@/state/queries'
import { useSyncPull } from '@/state/queries'
import { useCurrentHuman } from '@/state/session'
import { useToast } from '@/components/ui/toast'
import { devControls } from '@/api/dev'
import { useHumans } from '@/state/dev-humans'
import { useShortcut } from '@/lib/keyboard'
import { formatKeys } from '@/lib/keyboard'
import { SHORTCUT_CATALOG } from '@/lib/shortcuts'
import { ApiError } from '@revu/shared'
/** Look up a chord's formatted chips by catalog id, for CommandShortcut hints. */
function chordChips(id: string): string[] | null {
  const def = SHORTCUT_CATALOG.find((d) => d.id === id)
  if (!def || Array.isArray(def.keys)) return null
  return formatKeys(def.keys)
}

/** Right-aligned key hint chip, rendered only when a catalog entry exists. */
function ShortcutHint({ id }: { id: string }) {
  const chips = chordChips(id)
  if (!chips) return null
  return <CommandShortcut>{chips.join(' ')}</CommandShortcut>
}

/** Match `/pr/:n` at the head of a path, returning the PR number or null. */
function matchPrNumber(pathname: string): number | null {
  const m = /^\/pr\/(\d+)(?:\/|$)/.exec(pathname)
  return m ? Number(m[1]) : null
}

/**
 * The command palette — the app's ⌘K launcher. It registers its own chord so it
 * opens from anywhere, and groups actions by scope:
 *
 * - "Go": the inbox and every open PR (title identity-cleaned, capped at ten and
 *   filtered by cmdk's built-in matcher).
 * - "This PR": the current PR's tabs, a re-sync, and the author-queue walk —
 *   present only while a PR is open.
 * - "Identity": switch which human drives the shared bot.
 * - "Help": open the keyboard sheet.
 *
 * Selecting an item runs its action and closes the palette.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenSheet,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenSheet: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { toast } = useToast()
  const currentHuman = useCurrentHuman()
  const pulls = usePullList()

  useShortcut('mod+k', () => onOpenChange(!open))

  const prNumber = matchPrNumber(location.pathname)
  const sync = useSyncPull(prNumber ?? 0)

  const openPulls = useMemo(() => {
    // A PR title never carries the broker's smuggled `**Name** (role)` prefix —
    // that convention lives in comment/description bodies — so titles render
    // directly. The list is capped at ten; cmdk's matcher filters the rest.
    const items = pulls.data?.items ?? []
    return items
      .filter((i) => i.pull.state === 'open')
      .slice(0, 10)
      .map((i) => ({ number: i.pull.number, title: i.pull.title }))
  }, [pulls.data])

  const humans = useHumans()

  const run = useCallback(
    (action: () => void) => {
      onOpenChange(false)
      action()
    },
    [onOpenChange],
  )

  const resync = useCallback(() => {
    if (prNumber === null) return
    sync.mutate(undefined, {
      onError: (error: ApiError) => {
        toast({
          kind: 'error',
          title: 'Re-sync failed',
          detail:
            error instanceof ApiError
              ? error.message
              : 'The broker did not respond.',
        })
      },
    })
  }, [prNumber, sync, toast])

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a PR or run a command…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Go">
          <CommandItem
            value="inbox go to inbox"
            onSelect={() => run(() => navigate('/'))}
          >
            <Inbox strokeWidth={1.5} aria-hidden />
            <span>Inbox</span>
            <ShortcutHint id="go-inbox" />
          </CommandItem>
          {openPulls.map((p) => (
            <CommandItem
              key={p.number}
              value={`pr ${p.number} ${p.title}`}
              onSelect={() => run(() => navigate(`/pr/${p.number}`))}
            >
              <FileDiff strokeWidth={1.5} aria-hidden />
              <span className="truncate">
                <span className="font-mono text-ink-mut">#{p.number}</span>
                <span className="text-ink-faint"> · </span>
                {p.title}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>

        {prNumber !== null && (
          <>
            <CommandSeparator />
            <CommandGroup heading="This PR">
              <CommandItem
                value="files diff this pr"
                onSelect={() => run(() => navigate(`/pr/${prNumber}/files`))}
              >
                <FileDiff strokeWidth={1.5} aria-hidden />
                <span>Files</span>
                <ShortcutHint id="go-files" />
              </CommandItem>
              <CommandItem
                value="conversation this pr"
                onSelect={() =>
                  run(() => navigate(`/pr/${prNumber}/conversation`))
                }
              >
                <MessagesSquare strokeWidth={1.5} aria-hidden />
                <span>Conversation</span>
                <ShortcutHint id="go-conversation" />
              </CommandItem>
              <CommandItem
                value="commits this pr"
                onSelect={() => run(() => navigate(`/pr/${prNumber}/commits`))}
              >
                <GitCommitHorizontal strokeWidth={1.5} aria-hidden />
                <span>Commits</span>
              </CommandItem>
              <CommandItem
                value="checks this pr"
                onSelect={() => run(() => navigate(`/pr/${prNumber}/checks`))}
              >
                <ListChecks strokeWidth={1.5} aria-hidden />
                <span>Checks</span>
              </CommandItem>
              <CommandItem
                value="resync snapshot re-sync"
                onSelect={() => run(resync)}
              >
                <RefreshCw strokeWidth={1.5} aria-hidden />
                <span>Re-sync snapshot</span>
                <ShortcutHint id="resync" />
              </CommandItem>
              <CommandItem
                value="walk unresolved threads author queue"
                onSelect={() =>
                  run(() => navigate(`/pr/${prNumber}/files?queue=1`))
                }
              >
                <CheckSquare strokeWidth={1.5} aria-hidden />
                <span>Walk unresolved threads (author queue)</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Identity">
          {humans.map((h) => (
            <CommandItem
              key={h.id}
              value={`identity switch ${h.name} ${h.role}`}
              onSelect={() => run(() => void devControls.setHuman(h.id))}
            >
              {h.id === currentHuman.id ? (
                <User strokeWidth={1.5} aria-hidden />
              ) : (
                <NameAvatar name={h.name} size="sm" />
              )}
              <span className="truncate">
                Switch to {h.name}
                <span className="text-ink-faint"> · {h.role}</span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Help">
          <CommandItem
            value="keyboard shortcuts help"
            onSelect={() => run(onOpenSheet)}
          >
            <Keyboard strokeWidth={1.5} aria-hidden />
            <span>Keyboard shortcuts</span>
            <ShortcutHint id="help" />
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
CommandPalette.displayName = 'CommandPalette'

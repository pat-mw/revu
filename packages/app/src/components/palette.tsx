import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  CheckSquare,
  FileDiff,
  GitBranch,
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
import type { PullListItem } from '@revu/shared'
import { partitionInbox, rowIdentity } from '@/lib/local-reviews'
import type { RowIdentity } from '@/lib/local-reviews'
import { matchPrNumber } from '@/lib/review-mode'

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

/**
 * One review the palette offers, reduced to the three things an item needs:
 * where selecting it goes, what it draws, and what a typed query is matched
 * against.
 *
 * `number` is a destination and nothing else. A local review's number is a
 * synthetic key that no reader has ever been shown and that nothing on GitHub
 * answers to, so it belongs in a route and in no other field here — which is
 * why the drawn text and the searched text are separate fields derived from the
 * identity slot rather than read back off it.
 */
export interface PaletteReview {
  /** Where selecting the item goes. Never drawn, never matched against. */
  number: number
  /** The identity slot as data: a pull request's number, or a branch pair. */
  identity: RowIdentity
  title: string
  /** The text a typed query is matched against. */
  value: string
}

/**
 * How many of each kind the palette lists before it stops.
 *
 * The cap exists so the launcher stays a short list rather than a second inbox.
 * It is per kind and not over the two together, deliberately: one budget shared
 * between them would make the number of branch reviews someone happens to be
 * holding decide how many pull requests they can see, and a reader with a dozen
 * local reviews would open the palette to a wall of them with every pull
 * request pushed off the end. Two budgets mean the ceiling on each group is a
 * fact about that group. The filter is what finds anything past either one.
 */
const PALETTE_REVIEW_CAP = 10

/** One listed row as an item, with its identity deciding what is searchable. */
function toPaletteReview(item: PullListItem): PaletteReview {
  const identity = rowIdentity(item)
  // The number appears in exactly one arm. A local review is searched by the
  // two branches it renders and by the title its author typed — the same text
  // the item draws, so what the palette finds and what it shows agree.
  const searchable =
    identity.kind === 'github'
      ? `pr ${item.pull.number}`
      : `local review ${identity.base} ${identity.head}`
  return {
    number: item.pull.number,
    identity,
    title: item.pull.title,
    value: `${searchable} ${item.pull.title}`,
  }
}

/**
 * The open reviews the palette lists, split by kind and capped one kind at a
 * time.
 *
 * Split rather than filtered: both kinds are offered, because the palette is
 * how a review is reached from any screen and a local review that could only be
 * reached from the inbox would be unreachable from every other one. They are
 * separated because they are not drawn the same way and must not be searched
 * the same way.
 *
 * Pure and exported so that "no local review's number is drawn or searchable"
 * is a property of a function rather than of a component that renders through a
 * dialog portal and serializes to nothing.
 */
export function paletteReviews(items: readonly PullListItem[]): {
  pulls: PaletteReview[]
  local: PaletteReview[]
} {
  const { local, github } = partitionInbox(items.filter((i) => i.pull.state === 'open'))
  return {
    pulls: github.slice(0, PALETTE_REVIEW_CAP).map(toPaletteReview),
    local: local.slice(0, PALETTE_REVIEW_CAP).map(toPaletteReview),
  }
}

/**
 * What a review's palette item draws: its identity slot, then its title.
 *
 * Portal-free and exported for the same reason the derivation is pure — the
 * palette is a dialog and renders to the empty string on the server, so this is
 * the largest piece of it an assertion can actually read.
 *
 * The branch pair is labelled as one phrase rather than left to be read out
 * piecemeal: the arrow carries the direction and has no spoken form.
 */
export function PaletteReviewLabel({ review }: { review: PaletteReview }) {
  const { identity } = review
  return (
    <span className="truncate">
      {identity.kind === 'github' ? (
        <span className="font-mono text-ink-mut">{identity.text}</span>
      ) : (
        <span
          role="img"
          aria-label={`Local review of ${identity.head} against ${identity.base}`}
          className="font-mono text-ink-mut"
        >
          {identity.base}
          <span className="text-ink-faint" aria-hidden>
            {' ← '}
          </span>
          {identity.head}
        </span>
      )}
      <span className="text-ink-faint"> · </span>
      {review.title}
    </span>
  )
}
PaletteReviewLabel.displayName = 'PaletteReviewLabel'

/**
 * The command palette — the app's ⌘K launcher. It registers its own chord so it
 * opens from anywhere, and groups actions by scope:
 *
 * - "Go": the inbox, starting a review of two local branches, and the open pull
 *   requests (title identity-cleaned, capped and filtered by cmdk's built-in
 *   matcher).
 * - "Local reviews": the open reviews with no pull request behind them, drawn
 *   and searched by their branch pair. Present only when there is one.
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
  onCreateLocalReview,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenSheet: () => void
  /**
   * Raise the shared create-review dialog. Handed in rather than mounted here,
   * so the palette entry and every other entry point open one dialog.
   */
  onCreateLocalReview: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { toast } = useToast()
  const currentHuman = useCurrentHuman()
  const pulls = usePullList()

  useShortcut('mod+k', () => onOpenChange(!open))

  const prNumber = matchPrNumber(location.pathname)
  const sync = useSyncPull(prNumber ?? 0)

  // A review title never carries the broker's smuggled `**Name** (role)`
  // prefix — that convention lives in comment/description bodies — so titles
  // render directly. Each group is capped; cmdk's matcher filters the rest.
  const reviews = useMemo(() => paletteReviews(pulls.data?.items ?? []), [pulls.data])

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
          <CommandItem
            value="new local review compare branches"
            onSelect={() => run(onCreateLocalReview)}
          >
            <GitBranch strokeWidth={1.5} aria-hidden />
            <span>New local review</span>
            <ShortcutHint id="new-local-review" />
          </CommandItem>
          {reviews.pulls.map((review) => (
            <CommandItem
              key={review.number}
              value={review.value}
              onSelect={() => run(() => navigate(`/pr/${review.number}`))}
            >
              <FileDiff strokeWidth={1.5} aria-hidden />
              <PaletteReviewLabel review={review} />
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Their own group, because they are neither drawn nor searched the way
            a pull request is. An empty heading is worse than none, so the group
            is omitted rather than shown with nothing under it. */}
        {reviews.local.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Local reviews">
              {reviews.local.map((review) => (
                <CommandItem
                  key={review.number}
                  value={review.value}
                  onSelect={() => run(() => navigate(`/pr/${review.number}`))}
                >
                  <GitBranch strokeWidth={1.5} aria-hidden />
                  <PaletteReviewLabel review={review} />
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

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

        {/* Switching the acting human is a demo affordance backed by the mock
            store. The roster is empty against real GitHub, where identity comes
            from the workspace — so the whole group is omitted rather than shown
            with no entries under it. */}
        {humans.length > 0 && (
          <>
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
          </>
        )}

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

import { useMemo, useState } from 'react'
import { SmilePlus } from 'lucide-react'
import type { ReactionKey, ReviewComment } from '@/api/types'
import { IdentityAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { identityName, parseCommentIdentity } from '@/lib/identity'
import type { CommentIdentity } from '@/lib/identity'
import { formatDate, relativeTime } from '@/lib/time'
import { useCurrentHuman } from '@/state/session'
import { useAddReaction } from '@/state/threads'

const REACTION_KEYS: ReactionKey[] = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
]

const REACTION_EMOJI: Record<ReactionKey, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
}

const REACTION_LABEL: Record<ReactionKey, string> = {
  '+1': 'thumbs up',
  '-1': 'thumbs down',
  laugh: 'laugh',
  hooray: 'hooray',
  confused: 'confused',
  heart: 'heart',
  rocket: 'rocket',
  eyes: 'eyes',
}

/**
 * The fields a comment must carry to render here. Review comments and issue
 * (conversation) comments both satisfy this shape, so one renderer serves the
 * diff, the thread cards, and the conversation timeline.
 */
export type RenderableComment = Pick<
  ReviewComment,
  'id' | 'user' | 'body' | 'created_at' | 'reactions'
>

/** The small identity descriptor rendered beside the author name. */
function identityChip(identity: CommentIdentity): string | null {
  switch (identity.kind) {
    case 'human':
      return identity.role ? `(${identity.role})` : null
    case 'github':
      return 'org member · github.com'
    case 'bot':
      return 'app'
  }
}

/**
 * One comment: identity header, cleaned markdown body, reaction row. The
 * identity prefix the broker smuggles into the body is parsed exactly once —
 * the header renders the parsed identity and the body renders the CLEANED
 * markdown, never the raw prefixed text.
 */
export function CommentView({
  prNumber,
  comment,
}: {
  prNumber: number
  comment: RenderableComment
}) {
  const currentHuman = useCurrentHuman()
  const addReaction = useAddReaction(prNumber)
  const [pickerOpen, setPickerOpen] = useState(false)

  const parsed = useMemo(() => parseCommentIdentity(comment), [comment])
  // "Yours" is derived from the smuggled name — the same rule isOwnComment
  // applies — reusing the single parse above instead of parsing again.
  const own =
    parsed.identity.kind === 'human' && parsed.identity.name === currentHuman.name

  const chip = identityChip(parsed.identity)
  const active = REACTION_KEYS.filter((k) => comment.reactions[k] > 0)

  return (
    <article className="group/comment min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <IdentityAvatar identity={parsed.identity} size="sm" />
        <span className="truncate text-sm font-semibold text-ink">
          {identityName(parsed.identity)}
        </span>
        {chip && <span className="truncate text-2xs text-ink-faint">{chip}</span>}
        {own && <span className="shrink-0 text-2xs text-draft">(you)</span>}
        <time
          className="ml-auto shrink-0 text-2xs text-ink-faint"
          dateTime={comment.created_at}
          title={formatDate(comment.created_at)}
        >
          {relativeTime(comment.created_at)}
        </time>
      </div>
      <div className="mt-1 pl-7">
        <Markdown>{parsed.body}</Markdown>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-7">
        {active.map((k) => (
          <span
            key={k}
            title={REACTION_LABEL[k]}
            className="inline-flex select-none items-center gap-1 rounded-(--radius-xs) bg-raised px-1.5 py-px text-2xs text-ink-mut"
          >
            <span aria-hidden>{REACTION_EMOJI[k]}</span>
            <span className="font-mono">{comment.reactions[k]}</span>
            <span className="sr-only">{REACTION_LABEL[k]}</span>
          </span>
        ))}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Add reaction"
                  className={cn(
                    'h-6 w-6 px-0 [&_svg]:size-[13px]',
                    // Hidden until the comment is hovered or focus enters it, but
                    // always in the tab order; opening the picker pins it visible.
                    'opacity-0 transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100',
                  )}
                >
                  <SmilePlus strokeWidth={1.5} aria-hidden />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              Reactions come from the shared app identity — one of each, total, across
              every human.
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-auto p-1">
            <div className="grid grid-cols-4 gap-0.5">
              {REACTION_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  title={REACTION_LABEL[k]}
                  aria-label={REACTION_LABEL[k]}
                  className="flex h-7 w-7 items-center justify-center rounded-(--radius-xs) text-base leading-none transition-colors hover:bg-raised"
                  onClick={() => {
                    addReaction.mutate({ commentId: comment.id, reaction: k })
                    setPickerOpen(false)
                  }}
                >
                  {REACTION_EMOJI[k]}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </article>
  )
}
CommentView.displayName = 'CommentView'

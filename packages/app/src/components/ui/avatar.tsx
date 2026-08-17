import { Bot } from 'lucide-react'
import type { CommentIdentity } from '@revu/shared'
import { avatarStyle, identityName } from '@revu/shared'
import { orgMemberTitle } from '@/lib/mode-copy'
import type { ReviewMode } from '@/lib/review-mode'
import { cn } from '@/lib/cn'

/** Disc diameter and glyph size per named size. */
const SIZES = {
  xs: { box: 16, text: 'text-[9px]', glyph: 10 },
  sm: { box: 20, text: 'text-[10px]', glyph: 12 },
  md: { box: 24, text: 'text-xs', glyph: 14 },
} as const

export type AvatarSize = keyof typeof SIZES

/**
 * A colored-initials disc for a person, with hue derived deterministically from
 * their name (avatarStyle keeps those hues clear of the app's reserved semantic
 * bands). No network avatars — egress is locked down in the target workspace.
 */
function InitialsDisc({
  name,
  size,
  className,
  title,
  ring,
}: {
  name: string
  size: AvatarSize
  className?: string
  title?: string
  ring?: boolean
}) {
  const { box, text } = SIZES[size]
  const style = avatarStyle(name)
  return (
    <span
      title={title}
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-sans font-semibold leading-none',
        text,
        ring && 'ring-1 ring-line-strong ring-offset-1 ring-offset-canvas',
        className,
      )}
      style={{
        width: box,
        height: box,
        color: style.color,
        background: style.background,
      }}
    >
      {style.initials}
    </span>
  )
}

/** A neutral disc bearing a bot glyph — the broker identity with no smuggled human. */
function BotDisc({
  size,
  className,
  title,
  label,
}: {
  size: AvatarSize
  className?: string
  title?: string
  label: string
}) {
  const { box, glyph } = SIZES[size]
  return (
    <span
      title={title}
      role="img"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full bg-raised text-ink-mut',
        className,
      )}
      style={{ width: box, height: box }}
    >
      <Bot size={glyph} strokeWidth={1.5} aria-hidden />
    </span>
  )
}

/**
 * Avatar for a resolved comment identity. Humans and real GitHub users get a
 * colored-initials disc; on a mediated pull request an identity resolved to a
 * GitHub account additionally carries a subtle ring and a title naming where
 * that person reviews. The unparsed broker bot renders as a neutral bot disc.
 *
 * `mode` is required rather than defaulted, and the reason is that the identity
 * alone cannot answer this. The parser calls every author of a review of two
 * local branches a GitHub account — their login is simply not the shared write
 * identity's — so the ringed treatment fires there by default and says
 * something false about a person who never touched that site. A required prop
 * makes a call site that has not thought about it a compile error instead of a
 * quiet wrong answer on a screen.
 */
export function IdentityAvatar({
  identity,
  mode,
  size = 'sm',
  className,
}: {
  identity: CommentIdentity
  /** Which kind of review this identity is being drawn inside. */
  mode: ReviewMode
  size?: AvatarSize
  className?: string
}) {
  const name = identityName(identity)
  if (identity.kind === 'bot') {
    return <BotDisc size={size} className={className} title={name} label={name} />
  }
  const orgTitle = identity.kind === 'github' ? orgMemberTitle(mode) : null
  if (orgTitle !== null) {
    return (
      <InitialsDisc name={name} size={size} className={className} ring title={orgTitle} />
    )
  }
  return <InitialsDisc name={name} size={size} className={className} />
}
IdentityAvatar.displayName = 'IdentityAvatar'

/**
 * Avatar keyed by a bare name string, for places that hold a name without a full
 * identity (reviewer chips, assignee lists). Colored-initials disc.
 */
export function NameAvatar({
  name,
  size = 'sm',
  className,
}: {
  name: string
  size?: AvatarSize
  className?: string
}) {
  return <InitialsDisc name={name} size={size} className={className} />
}
NameAvatar.displayName = 'NameAvatar'

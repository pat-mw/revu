import { Bot } from 'lucide-react'
import { avatarStyle, identityName, type CommentIdentity } from '@/lib/identity'
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
 * colored-initials disc; GitHub org members additionally carry a subtle ring and
 * a title explaining they review directly on github.com. The unparsed broker bot
 * renders as a neutral bot disc.
 */
export function IdentityAvatar({
  identity,
  size = 'sm',
  className,
}: {
  identity: CommentIdentity
  size?: AvatarSize
  className?: string
}) {
  const name = identityName(identity)
  if (identity.kind === 'bot') {
    return <BotDisc size={size} className={className} title={name} label={name} />
  }
  if (identity.kind === 'github') {
    return (
      <InitialsDisc
        name={name}
        size={size}
        className={className}
        ring
        title="org member · reviews on github.com"
      />
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

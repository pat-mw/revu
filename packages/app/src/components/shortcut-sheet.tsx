import { Fragment, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useShortcut } from '@/lib/keyboard'
import { formatKeys } from '@/lib/keyboard'
import { SHORTCUT_CATALOG } from '@/lib/shortcuts'
import type { ShortcutDef } from '@/lib/shortcuts'

/** The order sections appear in the sheet — Global first, Review last. */
const GROUP_ORDER: ShortcutDef['group'][] = [
  'Global',
  'Navigation',
  'Files',
  'Threads',
  'Review',
]

/**
 * One catalog row: the human label on the left, the key chips on the right. A
 * single chord renders as one `<Kbd>`; a sequence (`['g','i']`) renders as two
 * `<Kbd>` groups joined by a faint "then", so a two-step gesture reads as two
 * distinct presses rather than one impossible chord.
 */
function ShortcutRow({ def }: { def: ShortcutDef }) {
  const isSequence = Array.isArray(def.keys)
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="min-w-0 truncate text-sm text-ink-mut">{def.label}</span>
      {isSequence ? (
        <span className="flex shrink-0 items-center gap-1">
          {(def.keys as string[]).map((chord, i) => (
            <Fragment key={`${chord}-${i}`}>
              {i > 0 && (
                <span className="text-2xs text-ink-faint">then</span>
              )}
              <Kbd keys={formatKeys(chord)} />
            </Fragment>
          ))}
        </span>
      ) : (
        <Kbd className="shrink-0" keys={formatKeys(def.keys as string)} />
      )}
    </div>
  )
}

/**
 * The keyboard reference sheet, opened by `?` (`shift+/`) or from the palette.
 * It reads the shortcut catalog as its single source of truth and lays the
 * entries out in a dense two-column grid, grouped by section. It documents the
 * keys the app claims; it never binds handlers itself (registration lives at
 * each feature's call site).
 */
export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  useShortcut('shift+/', () => onOpenChange(true))

  const grouped = useMemo(() => {
    const byGroup = new Map<ShortcutDef['group'], ShortcutDef[]>()
    for (const def of SHORTCUT_CATALOG) {
      const list = byGroup.get(def.group) ?? []
      list.push(def)
      byGroup.set(def.group, list)
    }
    return GROUP_ORDER.map((group) => ({
      group,
      items: byGroup.get(group) ?? [],
    })).filter((section) => section.items.length > 0)
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
          <DialogDescription>
            Every key the app claims, grouped by where it applies.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {grouped.map((section) => (
            <section key={section.group} className="flex flex-col gap-0.5">
              <h3 className="mb-1 font-sans text-2xs font-medium uppercase tracking-wide text-ink-faint">
                {section.group}
              </h3>
              <div className="flex flex-col divide-y divide-line">
                {section.items.map((def) => (
                  <ShortcutRow key={def.id} def={def} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="hairline-t pt-2 text-xs text-ink-faint">
          Shortcuts are inert while typing in a field — Esc always works.
        </p>
      </DialogContent>
    </Dialog>
  )
}
ShortcutSheet.displayName = 'ShortcutSheet'

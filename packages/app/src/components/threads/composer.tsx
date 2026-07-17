import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { FileDiff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'

export interface CommentComposerProps {
  /** The markdown being written. Fully controlled — the composer never clears it. */
  value: string
  onChange: (value: string) => void
  /** Fires from the submit button and from mod+enter inside the textarea. */
  onSubmit: () => void
  /** Fires from the Cancel button and from escape inside the textarea. */
  onCancel?: () => void
  submitLabel: string
  placeholder?: string
  autoFocus?: boolean
  /**
   * Exact source line(s) to seed a ```suggestion fence with. When non-null a
   * "suggestion" toolbar button splices the fence at the caret; null (or
   * undefined) hides the button — replies and issue comments have no anchor
   * line to suggest against.
   */
  suggestionSeed?: string | null
  /** True while the parent's write is in flight: submit disables, spinner shows. */
  busy?: boolean
  /** Tighter chrome and a shorter textarea for inline (in-diff, in-card) use. */
  compact?: boolean
}

/**
 * The one comment composer, used inline in the diff, in thread footers, in the
 * Conversation tab, and in the author queue. Write/Preview tabs over a
 * borderless textarea inside a hairline card; the toolbar carries the
 * suggestion splice, a markdown hint, and the cancel/submit pair.
 *
 * Persistence contract: the parent owns the text. Submit and cancel never
 * mutate `value` here — a failed optimistic write refills the same state, so
 * nothing typed is ever lost inside this component.
 */
export function CommentComposer({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  placeholder,
  autoFocus,
  suggestionSeed,
  busy,
  compact,
}: CommentComposerProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSubmit = value.trim() !== '' && !busy

  /**
   * Splice the suggestion fence at the caret (or append when the textarea is
   * unmounted because Preview is showing), then return focus with the caret
   * placed after the inserted fence.
   */
  const insertSuggestion = () => {
    if (suggestionSeed == null) return
    const snippet = `\n\`\`\`suggestion\n${suggestionSeed}\n\`\`\`\n`
    const el = textareaRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + snippet + value.slice(end))
    setTab('write')
    const caret = start + snippet.length
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (node) {
        node.focus()
        node.setSelectionRange(caret, caret)
      }
    })
  }

  const onTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      // Swallowed even when not submittable so the chord never leaks to a
      // global handler (the review bar submits the whole review on mod+enter).
      e.preventDefault()
      e.stopPropagation()
      if (canSubmit) onSubmit()
      return
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  return (
    <div className="rounded-(--radius-sm) border border-line bg-panel">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'write' | 'preview')}>
        <TabsList className={cn('flex w-full gap-3 px-2', compact ? 'h-6' : 'h-7')}>
          <TabsTrigger value="write" className={compact ? 'text-2xs' : 'text-xs'}>
            Write
          </TabsTrigger>
          <TabsTrigger value="preview" className={compact ? 'text-2xs' : 'text-xs'}>
            Preview
          </TabsTrigger>
        </TabsList>
        <TabsContent value="write" className="mt-0">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder={placeholder}
            aria-label={placeholder ?? 'Write a comment'}
            autoFocus={autoFocus}
            className={cn(
              'rounded-none border-0 bg-transparent',
              compact ? 'min-h-[44px]' : 'min-h-[72px]',
            )}
          />
        </TabsContent>
        <TabsContent
          value="preview"
          className={cn('mt-0 px-2 py-1.5', compact ? 'min-h-[44px]' : 'min-h-[72px]')}
        >
          {value.trim() !== '' ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-sm text-ink-faint">Nothing to preview yet.</p>
          )}
        </TabsContent>
      </Tabs>
      <div className="flex items-center gap-2 border-t border-line px-2 py-1 text-2xs">
        {suggestionSeed != null && (
          <Button
            variant="ghost"
            size="sm"
            className="[&_svg]:size-[13px]"
            onClick={insertSuggestion}
          >
            <FileDiff strokeWidth={1.5} aria-hidden />
            suggestion
          </Button>
        )}
        <span className="text-ink-faint">markdown supported</span>
        <div className="ml-auto flex items-center gap-1.5">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!canSubmit} onClick={onSubmit}>
            {busy && <Spinner size={12} label="Sending" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
CommentComposer.displayName = 'CommentComposer'

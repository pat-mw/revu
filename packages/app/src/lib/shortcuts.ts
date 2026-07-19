/**
 * The shortcut catalog. This is the single source of truth for what keys the
 * app claims — it drives the '?' help sheet and annotates the command palette.
 * Registration (`useShortcut` / `useSequenceShortcut`) is wired separately at
 * each call site; a catalog entry documents intent, it does not bind a handler.
 *
 * `keys` is a string for a single chord (e.g. `'mod+k'`, `'shift+/'`) and a
 * string array for a sequence (`['g', 'i']` = press `g`, then `i`). The chord
 * grammar matches `formatKeys` in `./keyboard`.
 */

export interface ShortcutDef {
  id: string
  keys: string | string[]
  label: string
  group: 'Global' | 'Navigation' | 'Files' | 'Threads' | 'Review'
}

export const SHORTCUT_CATALOG: ShortcutDef[] = [
  // ——— Global ———
  { id: 'help', keys: 'shift+/', label: 'Keyboard shortcuts', group: 'Global' },
  { id: 'command-palette', keys: 'mod+k', label: 'Command palette', group: 'Global' },
  { id: 'go-inbox', keys: ['g', 'i'], label: 'Go to inbox', group: 'Global' },
  { id: 'go-files', keys: ['g', 'f'], label: 'Go to files', group: 'Global' },
  { id: 'go-conversation', keys: ['g', 'c'], label: 'Go to conversation', group: 'Global' },
  { id: 'resync', keys: 'shift+r', label: 'Re-sync snapshot', group: 'Global' },
  { id: 'toggle-theme', keys: 'mod+shift+l', label: 'Toggle light / dark theme', group: 'Global' },

  // ——— Navigation ———
  { id: 'next-file', keys: 'j', label: 'Next file', group: 'Navigation' },
  { id: 'prev-file', keys: 'k', label: 'Previous file', group: 'Navigation' },
  { id: 'next-thread', keys: 'n', label: 'Next thread', group: 'Navigation' },
  { id: 'prev-thread', keys: 'p', label: 'Previous thread', group: 'Navigation' },
  { id: 'open-focused', keys: 'enter', label: 'Open focused item', group: 'Navigation' },

  // ——— Files ———
  { id: 'toggle-viewed', keys: 'v', label: 'Toggle viewed on focused file', group: 'Files' },
  { id: 'toggle-unified', keys: 'u', label: 'Toggle unified / split', group: 'Files' },
  { id: 'expand-context', keys: 'e', label: 'Expand all context in focused file', group: 'Files' },
  { id: 'collapse-file', keys: '[', label: 'Collapse file', group: 'Files' },
  { id: 'expand-file', keys: ']', label: 'Expand file', group: 'Files' },

  // ——— Threads ———
  { id: 'reply-thread', keys: 'r', label: 'Reply to focused thread', group: 'Threads' },
  { id: 'resolve-thread', keys: 'x', label: 'Resolve / unresolve focused thread', group: 'Threads' },
  { id: 'toggle-outdated', keys: 'o', label: 'Toggle outdated threads', group: 'Threads' },
  { id: 'toggle-resolved', keys: 'h', label: 'Toggle resolved threads', group: 'Threads' },

  // ——— Review ———
  { id: 'comment-line', keys: 'c', label: 'Comment on focused line', group: 'Review' },
  { id: 'focus-review-bar', keys: 's', label: 'Focus review bar', group: 'Review' },
  { id: 'submit-review', keys: 'mod+enter', label: 'Submit review / comment', group: 'Review' },
]

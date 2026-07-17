import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'

/**
 * The keyboard system. One window `keydown` listener, mounted by
 * `KeyboardProvider`, dispatches to a registry of hook-registered handlers.
 *
 * Design constraints this file enforces:
 *
 * - A single normalized key ("chord") maps to a *stack* of handlers. The last
 *   registered enabled handler wins, so a screen-level binding overrides a
 *   global one for the same chord. Registration is a hook (`useShortcut` /
 *   `useSequenceShortcut`); unmount or a deps change unregisters cleanly.
 * - Handlers receive the raw `KeyboardEvent`. When a handler fires the registry
 *   calls `preventDefault()` for it — the app owns the key, the browser doesn't.
 * - Input guard: events originating in an input, textarea, select, or
 *   contenteditable are ignored unless the binding opts into `allowInInput`,
 *   with `escape` always allowed through so a field can be dismissed.
 * - Sequences ("g" then "i") only trigger from single-key first elements, never
 *   start inside an input, expire after a short window, and swallow both keys.
 * - All hook state is held in refs so re-renders never re-subscribe the window
 *   listener or churn the registry.
 */

// ————————————————————————————————————————————————————————————————
// Platform
// ————————————————————————————————————————————————————————————————

/**
 * True on Apple platforms, where `mod` means the Command (meta) key. Elsewhere
 * `mod` means Control. Guarded for non-DOM environments so importing this
 * module never throws.
 */
const IS_MAC: boolean =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(
    // `platform` is deprecated but still the most reliable Apple signal; fall
    // back to the UA string where it is absent.
    (navigator.platform || navigator.userAgent || '').toLowerCase(),
  )

// ————————————————————————————————————————————————————————————————
// Chord parsing & normalization
// ————————————————————————————————————————————————————————————————

interface ParsedChord {
  /** The normalized key name: lowercased single char, or a named key. */
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

/** Named keys whose `event.key` differs from the token used in a chord string. */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  enter: 'enter',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
}

/** Parse a chord string (`'mod+shift+k'`, `'['`, `'escape'`) into its parts. */
function parseChord(chord: string): ParsedChord {
  const parts = chord.split('+')
  let mod = false
  let shift = false
  let alt = false
  let key = ''
  for (const rawPart of parts) {
    const part = rawPart.trim().toLowerCase()
    if (part === 'mod') mod = true
    else if (part === 'shift') shift = true
    else if (part === 'alt' || part === 'option' || part === 'opt') alt = true
    else key = KEY_ALIASES[part] ?? part
  }
  return { key, mod, shift, alt }
}

/** The key a native event actually carries, normalized to the chord vocabulary. */
function eventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase()
  return KEY_ALIASES[k] ?? k
}

/**
 * A stable registry id for a chord, insensitive to modifier order. Two chords
 * that describe the same combination collapse to the same string.
 *
 * `shift` is folded into the key for `event.key` values that already encode the
 * shifted glyph. Pressing `shift+/` yields `event.key === '?'`, so the chord
 * `'shift+/'` and a raw `'?'` must normalize identically. For letter keys the
 * browser reports the lowercase base key while `shiftKey` is set, so `shift`
 * stays an explicit flag there.
 */
function chordId(p: ParsedChord): string {
  return `${p.mod ? 'M' : ''}${p.shift ? 'S' : ''}${p.alt ? 'A' : ''}:${p.key}`
}

/** Build the registry id for an incoming event. */
function eventChordId(e: KeyboardEvent): string {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  const key = eventKey(e)
  // `eventKey` already lowercases, so a single-char `key` that is not a letter
  // is a shifted glyph the browser produced (`?`, `<`, `{`, …). Its shift is
  // baked into the glyph, so it is not recorded again as a modifier flag.
  // Letters keep shift explicit — the browser reports the base letter there.
  const isBakedGlyph = key.length === 1 && !(key >= 'a' && key <= 'z')
  const shift = e.shiftKey && !isBakedGlyph
  return chordId({ key, mod, shift, alt: e.altKey })
}

/**
 * Normalize a chord string the way an event normalizes, so `'shift+/'`
 * registers under the same id the browser will report for `?`.
 */
function normalizeChordString(chord: string): string {
  const p = parseChord(chord)
  // `shift+<single char>`: if the char is a punctuation/symbol key, treat the
  // shift as producing a glyph and drop the explicit flag to match events. For
  // letters, keep shift explicit (browsers report the base letter + shiftKey).
  if (p.shift && p.key.length === 1) {
    const isLetter = p.key >= 'a' && p.key <= 'z'
    if (!isLetter) {
      return chordId({ key: SHIFTED_GLYPH[p.key] ?? p.key, mod: p.mod, shift: false, alt: p.alt })
    }
  }
  return chordId(p)
}

/** US-keyboard shifted glyphs, so `'shift+/'` resolves to the `?` the browser emits. */
const SHIFTED_GLYPH: Record<string, string> = {
  '/': '?',
  '.': '>',
  ',': '<',
  '[': '{',
  ']': '}',
  ';': ':',
  "'": '"',
  '-': '_',
  '=': '+',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '`': '~',
  '\\': '|',
}

// ————————————————————————————————————————————————————————————————
// Input guard
// ————————————————————————————————————————————————————————————————

/** True when the event came from a control that owns text entry. */
function isFromTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// ————————————————————————————————————————————————————————————————
// Registry
// ————————————————————————————————————————————————————————————————

interface HandlerEntry {
  handler: (e: KeyboardEvent) => void
  enabled: boolean
  allowInInput: boolean
}

interface SequenceEntry {
  /** Normalized second-key registry id (the first key is always a bare key). */
  first: string
  second: string
  handler: (e: KeyboardEvent) => void
  enabled: boolean
}

interface KeyboardRegistry {
  /** chordId → ordered handler stack; last enabled entry wins. */
  chords: Map<string, HandlerEntry[]>
  /** Ordered set of active sequence bindings; last matching enabled wins. */
  sequences: SequenceEntry[]
  register(id: string, entry: HandlerEntry): () => void
  registerSequence(entry: SequenceEntry): () => void
}

function createRegistry(): KeyboardRegistry {
  const chords = new Map<string, HandlerEntry[]>()
  const sequences: SequenceEntry[] = []

  return {
    chords,
    sequences,
    register(id, entry) {
      const stack = chords.get(id) ?? []
      stack.push(entry)
      chords.set(id, stack)
      return () => {
        const current = chords.get(id)
        if (!current) return
        const idx = current.indexOf(entry)
        if (idx !== -1) current.splice(idx, 1)
        if (current.length === 0) chords.delete(id)
      }
    },
    registerSequence(entry) {
      sequences.push(entry)
      return () => {
        const idx = sequences.indexOf(entry)
        if (idx !== -1) sequences.splice(idx, 1)
      }
    },
  }
}

const KeyboardContext = createContext<KeyboardRegistry | null>(null)

function useRegistry(): KeyboardRegistry {
  const registry = useContext(KeyboardContext)
  if (!registry) {
    throw new Error('useShortcut must be used within <KeyboardProvider>.')
  }
  return registry
}

// ————————————————————————————————————————————————————————————————
// Provider — the single window listener
// ————————————————————————————————————————————————————————————————

/** How long a pending sequence prefix stays live before it is abandoned. */
const SEQUENCE_TIMEOUT_MS = 600

export function KeyboardProvider({ children }: { children: ReactNode }) {
  // The registry is created once and never replaced, so the window listener
  // below subscribes exactly one time for the provider's whole lifetime.
  const registry = useMemo(() => createRegistry(), [])

  useEffect(() => {
    // Pending sequence state lives in the effect closure, not React state, so a
    // sequence in flight never triggers a render or a listener re-subscribe.
    let pendingFirst: string | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null

    const clearPending = () => {
      pendingFirst = null
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore standalone modifier presses — they can never form a chord alone.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return
      }

      const fromTextEntry = isFromTextEntry(e.target)
      const key = eventKey(e)
      const isEscape = key === 'escape'
      const id = eventChordId(e)

      // ——— sequence resolution (second key of a pending prefix) ———
      if (pendingFirst !== null) {
        const first = pendingFirst
        // Any modifier or an input focus cancels the pending prefix; the second
        // key must be a plain, input-free keystroke to complete a sequence.
        if (!fromTextEntry && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const match = lastEnabled(
            registry.sequences.filter((s) => s.enabled && s.first === first && s.second === id),
          )
          if (match) {
            clearPending()
            e.preventDefault()
            match.handler(e)
            return
          }
        }
        // No completion: drop the prefix and fall through so this key can act on
        // its own (or start a fresh prefix below).
        clearPending()
      }

      // ——— single-chord dispatch ———
      // The input guard blocks bindings that did not opt in; `escape` always
      // passes so a focused field can be dismissed with a global handler.
      const stack = registry.chords.get(id)
      if (stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const entry = stack[i]
          if (!entry.enabled) continue
          if (fromTextEntry && !entry.allowInInput && !isEscape) continue
          e.preventDefault()
          entry.handler(e)
          return
        }
      }

      // ——— begin a new sequence prefix ———
      // Only bare single keys (no modifiers, not from an input) may open one.
      if (fromTextEntry || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const startsSequence = registry.sequences.some((s) => s.enabled && s.first === id)
      if (startsSequence) {
        pendingFirst = id
        pendingTimer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      clearPending()
    }
  }, [registry])

  return <KeyboardContext.Provider value={registry}>{children}</KeyboardContext.Provider>
}

/** Return the last (highest-priority) entry, or undefined for an empty list. */
function lastEnabled<T>(entries: T[]): T | undefined {
  return entries.length ? entries[entries.length - 1] : undefined
}

// ————————————————————————————————————————————————————————————————
// Hooks
// ————————————————————————————————————————————————————————————————

/**
 * Bind a chord to a handler for the lifetime of the calling component.
 *
 * The handler is kept in a ref and read at dispatch time, so passing a fresh
 * closure each render does not re-register or re-subscribe. Registration is
 * re-run only when the chord string or the `enabled` / `allowInInput` options
 * actually change.
 */
export function useShortcut(
  keys: string,
  handler: (e: KeyboardEvent) => void,
  opts?: { enabled?: boolean; allowInInput?: boolean },
): void {
  const registry = useRegistry()
  const enabled = opts?.enabled ?? true
  const allowInInput = opts?.allowInInput ?? false

  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const id = useMemo(() => normalizeChordString(keys), [keys])

  useEffect(() => {
    const entry: HandlerEntry = {
      handler: (e) => handlerRef.current(e),
      enabled,
      allowInInput,
    }
    return registry.register(id, entry)
  }, [registry, id, enabled, allowInInput])
}

/**
 * Bind a two-key sequence (press `seq[0]`, then `seq[1]` within the sequence
 * window) to a handler. The first element must be a bare single key; modifiers
 * on either element are not part of the sequence vocabulary. A completed
 * sequence swallows both keystrokes.
 *
 * Like `useShortcut`, the handler is ref-held and re-registration happens only
 * when the sequence tokens or `enabled` change.
 */
export function useSequenceShortcut(
  seq: string[],
  handler: (e: KeyboardEvent) => void,
  opts?: { enabled?: boolean },
): void {
  const registry = useRegistry()
  const enabled = opts?.enabled ?? true

  const handlerRef = useRef(handler)
  handlerRef.current = handler

  // Sequences are exactly two keys; a malformed length disables the binding
  // rather than throwing at render time.
  const first = seq.length === 2 ? normalizeChordString(seq[0]) : null
  const second = seq.length === 2 ? normalizeChordString(seq[1]) : null

  useEffect(() => {
    if (first === null || second === null) return
    const entry: SequenceEntry = {
      first,
      second,
      handler: (e) => handlerRef.current(e),
      enabled,
    }
    return registry.registerSequence(entry)
  }, [registry, first, second, enabled])
}

// ————————————————————————————————————————————————————————————————
// Presentation — key chips for <Kbd>
// ————————————————————————————————————————————————————————————————

/** Platform glyph for a modifier token, macOS symbol vs. spelled word. */
const MOD_LABEL: Record<string, { mac: string; other: string }> = {
  mod: { mac: '⌘', other: 'Ctrl' },
  shift: { mac: '⇧', other: 'Shift' },
  alt: { mac: '⌥', other: 'Alt' },
}

/** Display labels for named non-printing keys. */
const NAMED_KEY_LABEL: Record<string, string> = {
  escape: 'Esc',
  esc: 'Esc',
  enter: '↵',
  return: '↵',
  ' ': 'Space',
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}

/**
 * Render a chord string as the individual chips a `<Kbd>` component shows.
 * `'mod+k'` → `['⌘','K']` on macOS / `['Ctrl','K']` elsewhere; `'shift+/'`
 * collapses to the single glyph `['?']` because that is the key the user
 * actually presses. Letter keys are uppercased for display.
 */
export function formatKeys(keys: string): string[] {
  const parts = keys.split('+').map((p) => p.trim().toLowerCase())

  let shift = false
  let mod = false
  let alt = false
  let key = ''
  for (const part of parts) {
    if (part === 'mod') mod = true
    else if (part === 'shift') shift = true
    else if (part === 'alt' || part === 'option' || part === 'opt') alt = true
    else key = part
  }

  // `shift` + a punctuation/symbol key collapses to its shifted glyph as one
  // chip (`shift+/` → `?`), matching what a keyboard produces in one press.
  if (shift && key.length === 1) {
    const isLetter = key >= 'a' && key <= 'z'
    if (!isLetter && SHIFTED_GLYPH[key]) {
      return [SHIFTED_GLYPH[key]]
    }
  }

  const chips: string[] = []
  if (mod) chips.push(IS_MAC ? MOD_LABEL.mod.mac : MOD_LABEL.mod.other)
  if (alt) chips.push(IS_MAC ? MOD_LABEL.alt.mac : MOD_LABEL.alt.other)
  if (shift) chips.push(IS_MAC ? MOD_LABEL.shift.mac : MOD_LABEL.shift.other)

  if (key) {
    const named = NAMED_KEY_LABEL[key]
    if (named) chips.push(named)
    else if (key.length === 1) chips.push(key.toUpperCase())
    else chips.push(key.charAt(0).toUpperCase() + key.slice(1))
  }

  return chips
}

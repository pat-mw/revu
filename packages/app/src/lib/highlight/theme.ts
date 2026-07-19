import type { ThemeRegistration } from 'shiki/core'

/**
 * The two syntax themes designed to sit *under* the diff line tints — one per
 * app color scheme (`revu-dark`, `revu-light`).
 *
 * The diff surface owns saturation: add/del line backgrounds are alpha tints of
 * teal and rust, and word-level emphasis steps alpha (never hue). For that to
 * read, syntax color must stay in a narrow, low-chroma band so no token ever
 * out-shouts the diff. Every color here is a muted warm-neutral or a cool/warm
 * accent at low chroma; the background is transparent so the diff line tint
 * shows through unmodified in either scheme.
 *
 * The light theme is the mirror, not a tint of the dark one: each role is
 * re-anchored so it reads on the warm-neutral light canvas (every code color
 * clears ~4.5:1 there, comments stay quiet by intent), while holding the same
 * scope→role mapping so a file highlights identically in structure whichever
 * scheme is active.
 *
 * Scope coverage aims at the common TextMate scopes rather than an exhaustive
 * grammar map: comment, string, keyword/storage, function/type names, numeric
 * and language constants, punctuation/operators, variables/properties, and
 * markup tags/attributes. Anything unmatched falls back to the default `fg`.
 */

/** The colors one scheme assigns to each syntax role. */
interface ThemePalette {
  fg: string
  comment: string
  keyword: string
  string: string
  function: string
  type: string
  number: string
  punctuation: string
  variable: string
  tag: string
  attribute: string
}

/** Dark scheme — quiet warm grays with cool/warm pastel accents at low chroma. */
const DARK: ThemePalette = {
  fg: '#c9c7bd',
  comment: '#6b6a61',
  keyword: '#8aa7c7',
  string: '#c4b68c',
  function: '#e3e1d7',
  type: '#9fc2b5',
  number: '#c79e8f',
  punctuation: '#8a887e',
  variable: '#c9c7bd',
  tag: '#9fc2b5',
  attribute: '#c4b68c',
}

/**
 * Light scheme — the same roles anchored for a warm-neutral light canvas.
 * Foreground is a near-black warm gray; keyword a desaturated slate-blue, type
 * and tag the darkened teal (sibling to the add hue), string and attribute a
 * warm sand-brown, number a muted rust — all deep enough to read on light while
 * still ceding the loudest hue on any diff line to the teal/rust line tint.
 */
const LIGHT: ThemePalette = {
  fg: '#2d2c24',
  comment: '#84837a',
  keyword: '#2f5c8f',
  string: '#7a5a1e',
  function: '#3a3830',
  type: '#186a56',
  number: '#9a5a2a',
  punctuation: '#6b6a61',
  variable: '#2d2c24',
  tag: '#186a56',
  attribute: '#7a5a1e',
}

/**
 * Build a `ThemeRegistration` from a role palette. The background is transparent
 * so diff line tints (add/del/word) remain the loudest hue over the code.
 */
function buildTheme(
  name: string,
  type: 'dark' | 'light',
  p: ThemePalette,
): ThemeRegistration {
  return {
    name,
    type,
    bg: 'transparent',
    fg: p.fg,
    colors: {
      'editor.foreground': p.fg,
      'editor.background': '#00000000',
    },
    settings: [
      {
        // Base rule: everything defaults to the quiet foreground.
        settings: { foreground: p.fg },
      },
      {
        scope: [
          'comment',
          'comment.line',
          'comment.block',
          'comment.block.documentation',
          'punctuation.definition.comment',
          'string.comment',
        ],
        settings: { foreground: p.comment, fontStyle: 'italic' },
      },
      {
        scope: [
          'string',
          'string.quoted',
          'string.template',
          'string.unquoted',
          'string.interpolated',
          'string.regexp',
          'constant.other.symbol',
          'meta.embedded.line.ruby',
        ],
        settings: { foreground: p.string },
      },
      {
        scope: [
          'punctuation.definition.string',
          'punctuation.definition.string.begin',
          'punctuation.definition.string.end',
        ],
        settings: { foreground: p.string },
      },
      {
        scope: [
          'keyword',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'keyword.operator.logical',
          'keyword.other',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.control.import',
          'keyword.control.from',
        ],
        settings: { foreground: p.keyword },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call.generic',
          'variable.function',
          'entity.name.method',
        ],
        settings: { foreground: p.function },
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'entity.other.inherited-class',
          'support.type',
          'support.class',
          'entity.name.namespace',
          'entity.name.type.class',
          'storage.type.class',
        ],
        settings: { foreground: p.type },
      },
      {
        scope: [
          'constant.numeric',
          'constant.language',
          'constant.language.boolean',
          'constant.language.null',
          'constant.language.undefined',
          'constant.character',
          'constant.character.escape',
          'constant.other',
          'support.constant',
        ],
        settings: { foreground: p.number },
      },
      {
        scope: [
          'punctuation',
          'punctuation.separator',
          'punctuation.terminator',
          'punctuation.accessor',
          'punctuation.definition.parameters',
          'punctuation.section',
          'meta.brace',
          'keyword.operator',
          'keyword.operator.assignment',
          'keyword.operator.arithmetic',
          'keyword.operator.comparison',
          'keyword.operator.relational',
        ],
        settings: { foreground: p.punctuation },
      },
      {
        scope: [
          'variable',
          'variable.other',
          'variable.other.readwrite',
          'variable.parameter',
          'variable.other.property',
          'variable.other.object.property',
          'meta.property-name',
          'support.variable.property',
          'support.type.property-name',
        ],
        settings: { foreground: p.variable },
      },
      {
        scope: [
          'entity.name.tag',
          'entity.name.tag.html',
          'entity.name.tag.xml',
          'punctuation.definition.tag',
          'meta.tag',
        ],
        settings: { foreground: p.tag },
      },
      {
        scope: [
          'entity.other.attribute-name',
          'entity.other.attribute-name.html',
          'entity.other.attribute-name.class.css',
          'entity.other.attribute-name.id.css',
          'support.type.property-name.css',
        ],
        settings: { foreground: p.attribute },
      },
      {
        // Markdown headings/emphasis stay in-band — quiet, no loud accent.
        scope: [
          'markup.heading',
          'entity.name.section.markdown',
          'markup.bold',
          'markup.italic',
        ],
        settings: { foreground: p.function },
      },
      {
        scope: ['markup.inline.raw', 'markup.fenced_code', 'markup.raw.code'],
        settings: { foreground: p.string },
      },
    ],
  }
}

/** Syntax theme for the dark scheme. */
export const revuDarkTheme: ThemeRegistration = buildTheme('revu-dark', 'dark', DARK)

/** Syntax theme for the light scheme. */
export const revuLightTheme: ThemeRegistration = buildTheme('revu-light', 'light', LIGHT)

/** The app color scheme a highlight request should be tokenized for. */
export type HighlightTheme = 'revu-dark' | 'revu-light'

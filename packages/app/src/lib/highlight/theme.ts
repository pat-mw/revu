import type { ThemeRegistration } from 'shiki/core'

/**
 * `revu-dark` — the syntax theme designed to sit *under* the diff line tints.
 *
 * The diff surface owns saturation: add/del line backgrounds are alpha tints of
 * teal and rust, and word-level emphasis steps alpha (never hue). For that to
 * read, syntax color must stay in a narrow, low-chroma band so no token ever
 * out-shouts the diff. Every color here is a muted warm-neutral or a cool/warm
 * pastel at low chroma; the background is transparent so the diff line tint
 * shows through unmodified.
 *
 * Scope coverage aims at the common TextMate scopes rather than an exhaustive
 * grammar map: comment, string, keyword/storage, function/type names, numeric
 * and language constants, punctuation/operators, variables/properties, and
 * markup tags/attributes. Anything unmatched falls back to the default `fg`.
 */

/** Default foreground — quiet warm gray, matches app ink but slightly cooler. */
const FG = '#C9C7BD'
const COMMENT = '#6B6A61'
const KEYWORD = '#8AA7C7'
const STRING = '#C4B68C'
const FUNCTION = '#E3E1D7'
const TYPE = '#9FC2B5'
const NUMBER = '#C79E8F'
const PUNCTUATION = '#8A887E'
const VARIABLE = '#C9C7BD'
const TAG = '#9FC2B5'
const ATTRIBUTE = '#C4B68C'

export const revuDarkTheme: ThemeRegistration = {
  name: 'revu-dark',
  type: 'dark',
  // Transparent so diff line tints (add/del/word) remain the loudest hue.
  bg: 'transparent',
  fg: FG,
  colors: {
    'editor.foreground': FG,
    'editor.background': '#00000000',
  },
  settings: [
    {
      // Base rule: everything defaults to the quiet foreground.
      settings: { foreground: FG },
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
      settings: { foreground: COMMENT, fontStyle: 'italic' },
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
      settings: { foreground: STRING },
    },
    {
      scope: [
        'punctuation.definition.string',
        'punctuation.definition.string.begin',
        'punctuation.definition.string.end',
      ],
      settings: { foreground: STRING },
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
      settings: { foreground: KEYWORD },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call.generic',
        'variable.function',
        'entity.name.method',
      ],
      settings: { foreground: FUNCTION },
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
      settings: { foreground: TYPE },
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
      settings: { foreground: NUMBER },
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
      settings: { foreground: PUNCTUATION },
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
      settings: { foreground: VARIABLE },
    },
    {
      scope: [
        'entity.name.tag',
        'entity.name.tag.html',
        'entity.name.tag.xml',
        'punctuation.definition.tag',
        'meta.tag',
      ],
      settings: { foreground: TAG },
    },
    {
      scope: [
        'entity.other.attribute-name',
        'entity.other.attribute-name.html',
        'entity.other.attribute-name.class.css',
        'entity.other.attribute-name.id.css',
        'support.type.property-name.css',
      ],
      settings: { foreground: ATTRIBUTE },
    },
    {
      // Markdown headings/emphasis stay in-band — quiet, no loud accent.
      scope: [
        'markup.heading',
        'entity.name.section.markdown',
        'markup.bold',
        'markup.italic',
      ],
      settings: { foreground: FUNCTION },
    },
    {
      scope: ['markup.inline.raw', 'markup.fenced_code', 'markup.raw.code'],
      settings: { foreground: STRING },
    },
  ],
}

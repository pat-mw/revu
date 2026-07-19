# revu — design contract

## Design authority — taste skill routing (do not re-decide)

This project was routed through the **taste router** (`.claude/skills/taste/SKILL.md` at
`/Users/patmw/dev/tasteful`). Any new session or agent doing visual work here must honor
this resolution instead of re-running the router:

- **Routing outcome:** `revu` is greenfield **dense product UI** (virtualized diff viewer,
  data-heavy panes, multi-step review workflow) — the decorative landing-page rulebooks
  exclude it by design, and no sanctioned aesthetic exception was requested (no brutalist /
  Notion-like / Linear-like ask; the brief ships its own §6 direction). **No aesthetic
  rulebook is loaded.** The foundation is the router's official-substrate map: **shadcn/ui
  as an unstyled substrate, retokened** (below), TanStack Virtual/Query for the data-dense
  surfaces — which is also exactly what the brief mandates.
- **Language authority:** the build brief's §6 plus this document. If they conflict with a
  taste rulebook someone loads later, this document wins.
- **Delivery modifier:** `.agents/skills/full-output-enforcement/SKILL.md` — complete
  files, no placeholders, no `// ...`, no skeletons. Binding on every agent writing code.
- **Reconciliations:** none needed (no overlay loaded). Fonts/icons chosen here, not by a
  rulebook: Iosevka / Atkinson Hyperlegible / Archivo, Lucide icons at 14–16px stroke 1.5.

## What this is

A mock-data-driven, fully interactive prototype of **revu** — the only code-review surface
for contractors working in disposable Coder workspaces against a client's private repos,
where every GitHub call authenticates as one shared GitHub App (`meridian-review-bot[bot]`).
Drafts and per-file viewed state are broker-side and keyed to the human; a PR is an
offline snapshot with an honest age; submit reconciles rather than fails.

Stack: Bun + Vite + React 18 + TS (strict, `verbatimModuleSyntax`) + Tailwind v4 +
react-router + TanStack Query/Virtual + parse-diff + Shiki. Path alias `@/` → `src/`.

## Token plan — pass 1 (draft)

- Hexes: canvas `#141513`, ink `#D8D6CE`, add-teal `#3FD0B4`, del-rust `#F2825C`,
  draft-violet `#9D8CFF`, stale-gold `#E0B84C`.
- Faces: Iosevka (mono), Atkinson Hyperlegible (body), Archivo (display).
- Layout: three-pane workbench — file tree | diff | review rail.
- Signature: a "snapshot seal" stamp in the PR header + violet draft rail.

## Critique against the brief

1. *"Diff colour must survive syntax highlighting"* — pass 1 said nothing about the syntax
   theme, which is where diff palettes die. Fix: the Shiki theme is **designed with** the
   diff tints — token colors stay in a neutral/cool, low-saturation band (comments gray,
   keywords desaturated blue, strings warm sand at low chroma) so teal/rust line tints at
   ≤10% alpha stay the loudest hue on the line. Word-level emphasis steps alpha (~26%),
   never hue.
2. *"Not a Christmas tree over 2,000 lines"* — pass 1's add/del values were too saturated
   for full-line paint. Fix: saturated color lives only in gutters and word-diff spans;
   line backgrounds are alpha tints of the same hues.
3. *Red-green deficiency* — teal (~165°) vs rust (~20°) sits on the blue↔orange axis, safe
   for deutan/protan. Color is never the sole channel: gutters always carry `+`/`−`.
4. *Two warm yellows collided* — pass 1 had del-rust and stale-gold too close. Fix: del
   pulls toward orange-red (`#E5885E`), stale toward brass (`#D9B44A`), and staleness
   always pairs glyph + text ("3 new commits since sync"), never color alone.
5. *"Spend your boldness once"* — pass 1 spent it twice (seal + rail). Fix: **violet is
   the one loud thing**, reserved exclusively for draft/pending state. The seal is
   structural and quiet (mono, hairline border), going gold only in its stale state.
6. Avatar hues (generated identities) must dodge the semantic bands — reserved hue windows
   around add/del/draft excluded from the avatar palette.

## Token plan — revised (built)

- **canvas `#151613`** — warm-neutral near-black (explicitly not GitHub `#0d1117` blue-dark);
  steps: panel `#1B1D19`, raised `#22241F`, hairline `#2E312B`.
- **ink `#D9D7CD`** (≈11:1 on canvas), muted `#96948A`, faint `#6B6A61`.
- **add `#4CC8A8`** / **del `#E5885E`** — line tints at 9% alpha, word emphasis at ~26%,
  gutter glyph color full-strength.
- **draft `#A48FFF`** — the single bold move: pending comments, draft rail, review bar
  accent, selection. If it's violet, it's yours and GitHub can't see it yet.
- **stale `#D9B44A`** — snapshot age, head-moved warnings, reconcile "drifted".
- Danger `#E5645E` for destructive only. Focus ring is neutral ink, never semantic.
- **Faces:** *Iosevka* (mono — narrow terminal face, buys ~15% more columns in split
  diffs; 12.5px/1.5); *Atkinson Hyperlegible* (body 13px — designed for legibility, fits a
  tool whose work must read clearly to someone who'll never meet you); *Archivo* (display —
  wordmark, section labels, big inbox numbers only).
- **Layout:** dense three-pane workbench, hairline-separated, laptop-half-screen safe
  (file tree collapses to a rail below ~1100px).
- **Signature element:** the **snapshot seal** — `⧗ b3f2a41 · synced 26m ago` in mono,
  stamped on every PR header. It is the offline-first contract made visible: quiet when
  fresh, gold with an action ("3 new commits — Re-sync") when the world moved.

## Diff palette reasoning (solved first, rest followed)

Teal/rust on the blue↔orange axis survives deuteranopia and protanopia; alpha-stepped
tints keep 2,000-line files calm while word-level spans carry the actual signal; the
syntax theme is co-designed in the same low-chroma band so highlighting layers under diff
color instead of fighting it; and the gutter's `+`/`−` glyphs plus split-view position
mean color is redundant, never load-bearing. Add/del never appear outside diff surfaces,
so the two "brand" colors the user actually learns are violet (= your unsent work) and
gold (= time moved under you) — which is the app's whole thesis in two hues.

## Two schemes — dark by heritage, light re-derived (not tinted)

The palette above is the **dark** scheme, and dark stays the default: a first-time visitor
lands on dark on purpose, and only an explicit choice moves them. But dark is no longer the
*only* scheme. A **light** scheme ships alongside it, chosen by a `.light` class on `<html>`
(dark is the absence of the class), so the same `bg-canvas` / `text-add` / `--diff-*`
utilities resolve against whichever palette is active. Nothing hardcodes a hex outside the
global stylesheet — swapping the class swaps the whole app, and the syntax highlighter
carries a matching light theme so code and diffs stay legible on light.

The light scheme is a **re-derivation, not a tint of the dark values**. A dark-tuned rgba
laid over a light base washes out to nothing, and teal/rust light enough to glow on
near-black are too pale to read on a light canvas — so every value is re-anchored while the
*principles* are held exactly: add/del stay teal/rust on the blue↔orange axis (colorblind-
safe), line tints stay low-alpha so syntax highlighting is the top layer, word emphasis
steps alpha and never hue, violet stays reserved for draft/pending, gold stays staleness,
and color is never the only channel (the `+`/`−` glyphs and the stale glyph+text remain).

Choices specific to light:

- **Warm-neutral canvas, not white.** `#F4F2EA` echoes the warm dark rather than a clinical
  white. Surfaces step **darker** than the canvas (in dark they step lighter), so the
  panel → raised → overlay → hairline hierarchy reads with the light polarity.
- **Teal/rust darkened onto the canvas.** add `#0F7D63` and del `#B64A17` are deep enough to
  carry the gutter glyphs and word-diff fills against light while staying on their hue axis.
- **Diff-line alphas lifted, word/gutter/draft/stale re-tuned.** Line washes rise to ~10%
  (from 9% on dark) and every derived tint is re-tuned so each reads as an intentional wash
  over light instead of disappearing — still ≤ ~12% for line washes and ≤ ~24% for word
  emphasis, keeping highlighting the loudest hue on the line.
- **Draft-violet and stale-gold darkened, still distinct.** draft `#6741CF` and stale
  `#8A6D10` hold their exclusive meanings and stay legible and separable on light.
- **Contrast.** Body ink `#26261F` clears ~13:1 on the light canvas (well past the ~7:1 bar);
  muted/faint inks stay above their AA thresholds.

Full light token set (the source of truth is the global stylesheet's `.light` block; this
table mirrors it):

| Token | Dark | Light |
| --- | --- | --- |
| `--color-canvas` | `#151613` | `#F4F2EA` |
| `--color-panel` | `#1B1D19` | `#ECEADF` |
| `--color-raised` | `#22241F` | `#E3E0D3` |
| `--color-overlay` | `#282B25` | `#DCD8C9` |
| `--color-line` | `#2E312B` | `#D9D5C6` |
| `--color-line-strong` | `#3C4038` | `#C9C4B2` |
| `--color-ink` | `#D9D7CD` | `#26261F` |
| `--color-ink-mut` | `#96948A` | `#5F5E54` |
| `--color-ink-faint` | `#6B6A61` | `#84837A` |
| `--color-add` | `#4CC8A8` | `#0F7D63` |
| `--color-del` | `#E5885E` | `#B64A17` |
| `--color-draft` | `#A48FFF` | `#6741CF` |
| `--color-stale` | `#D9B44A` | `#8A6D10` |
| `--color-danger` | `#E5645E` | `#C22B26` |
| `--color-ring` | `#DAD8CE` | `#3A3A32` |
| `--diff-add-bg` | `rgba(76,200,168,.09)` | `rgba(15,125,99,.10)` |
| `--diff-add-word-bg` | `rgba(76,200,168,.26)` | `rgba(15,125,99,.24)` |
| `--diff-add-gutter` | `rgba(76,200,168,.14)` | `rgba(15,125,99,.18)` |
| `--diff-del-bg` | `rgba(229,136,94,.09)` | `rgba(182,74,23,.10)` |
| `--diff-del-word-bg` | `rgba(229,136,94,.24)` | `rgba(182,74,23,.22)` |
| `--diff-del-gutter` | `rgba(229,136,94,.14)` | `rgba(182,74,23,.18)` |
| `--diff-hunk-bg` | `#1E211C` | `#E9E6DA` |
| `--draft-tint` | `rgba(164,143,255,.12)` | `rgba(103,65,207,.10)` |
| `--draft-tint-strong` | `rgba(164,143,255,.24)` | `rgba(103,65,207,.20)` |
| `--stale-tint` | `rgba(217,180,74,.12)` | `rgba(138,109,16,.14)` |
| `--resolved-tint` | `rgba(150,148,138,.07)` | `rgba(95,94,84,.08)` |
| `--selection-bg` | `rgba(164,143,255,.30)` | `rgba(103,65,207,.22)` |
| `--stale-edge` | `rgba(217,180,74,.45)` | `rgba(138,109,16,.55)` |
| `--scrim` | `rgba(0,0,0,.55)` | `rgba(43,40,30,.42)` |

The syntax theme is co-designed per scheme: a light role palette (near-black warm fg,
desaturated slate-blue keywords, darkened-teal types/tags, warm-sand strings/attributes,
muted-rust numbers) that clears ~4.5:1 on the light canvas while still ceding the loudest
hue on any diff line to the teal/rust line tint. The scheme choice is a per-human
preference (broker-side, alongside the diff layout), applied to `<html>` before first paint
by a tiny inline boot script reading a local cache of that choice — so there is no dark
flash on load. `prefers-color-scheme` is deliberately not consulted on first visit: dark is
the heritage default, honored until the human chooses otherwise.

## The one risk

Reserving the only saturated accent for **invisible state** (the draft) instead of brand
or CTAs. A tool whose loudest color marks work nobody else can see yet is unusual — it
risks feeling like the app is shouting about nothing. Taken deliberately: the draft's
trustworthiness is the product's hardest UX problem (broker-side, survives rebuilds,
invisible to GitHub), and giving it the palette's entire boldness budget is what makes
"this exists and is safe" legible without a lecture.

## Conventions for all agents

See `AGENTS.md` (file ownership, verification commands, code style, a11y bars).

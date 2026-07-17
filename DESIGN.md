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

## The one risk

Reserving the only saturated accent for **invisible state** (the draft) instead of brand
or CTAs. A tool whose loudest color marks work nobody else can see yet is unusual — it
risks feeling like the app is shouting about nothing. Taken deliberately: the draft's
trustworthiness is the product's hardest UX problem (broker-side, survives rebuilds,
invisible to GitHub), and giving it the palette's entire boldness budget is what makes
"this exists and is safe" legible without a lecture.

## Conventions for all agents

See `AGENTS.md` (file ownership, verification commands, code style, a11y bars).

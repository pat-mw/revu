# Agent conventions — revu

Binding for every agent writing code in this repo. Read `DESIGN.md` first.

## Ownership & verification

- File ownership is exclusive: create/edit ONLY the files assigned to you. Local helper
  components live inside your files. Shared contracts (`src/api/types.ts`,
  `src/api/client.ts`, `src/fixtures/contract.ts`, `src/styles/globals.css`) are
  read-only inputs — if one seems wrong, report it in your final message instead of
  editing it.
- Verify with `cd /Users/patmw/dev/tasteful/revu && bunx tsc -b --force 2>&1 | head -40`.
  Until all phases land, imports of files owned by OTHER agents may fail to resolve —
  fix errors only in YOUR files; missing-module errors elsewhere are expected mid-build.

## The gate — `bun run check`

- `bun run check` is the mandatory pre-PR gate and runs, in order (fastest first):
  `oxlint` → `tsc -b` → `bun test` → `vite build`. It must exit clean before any PR,
  and CI runs the identical command — never push red, never skip a step to save time.
- For a fast inner loop, run the pieces directly (`bun test`, `bunx tsc -b`,
  `bunx oxlint`); `bun run check` is the whole gate you run before pushing.
- Tests are co-located `*.test.ts` on Bun's built-in runner (no extra deps).
  `test/preload.ts` (wired via `bunfig.toml`) shims the browser globals the mock
  layer reads, so mock-backed suites run headlessly.
- Optional pre-push hook that runs the gate automatically — enable once per clone
  with `git config core.hooksPath .githooks`. `.githooks/pre-push` then blocks any
  push whose gate is red (`--no-verify` bypasses a single push in an emergency).

## Code style

- TypeScript strict + `verbatimModuleSyntax`: use `import type { … }` for types.
- `noUnusedLocals`/`noUnusedParameters` are on — don't leave dead bindings.
- Comments/docstrings are self-contained descriptions of code and constraints. Never
  reference phases, agents, waves, tickets, PR numbers, or any tracking artifact.
- Complete output only: no `// ...`, no TODOs, no stubs, no "rest follows the pattern".
  Every file you deliver compiles and does its whole job.

## Visual system

- Use the token utilities from `globals.css`: `bg-canvas/panel/raised/overlay` (overlay = floating surfaces: menus, popovers, toasts), `text-ink/-mut/-faint`,
  `border-line/-strong`, semantic `text-add/del/draft/stale/danger`, `font-mono/sans/display`,
  sizes `text-2xs/xs/code/sm/base`. Raw hex values in components are a defect.
- Violet (`draft`) is reserved for pending/draft state. Add/del colors appear only on
  diff surfaces. Stale-gold means "time moved". Danger-red means destructive.
- Density: default `text-sm` (13px), gaps of 1–2 Tailwind units inside panes, hairline
  (`border-line`) separation instead of whitespace where panes meet. No `py-24` anywhere.
- Icons: `lucide-react`, 14–16px, `strokeWidth={1.5}`.
- Every interactive element: visible focus (global `:focus-visible` handles it — don't
  suppress outlines), `aria-label` where text isn't visible, keyboard reachable.
- Loading = skeletons matching final layout (`.skeleton`). Empty states are invitations
  with a next action. Errors name the failure and the fix.

## Data rules

- All reads/writes go through `api` from `@/api` — components never import fixtures or
  the mock directly (the dev panel is the sanctioned exception).
- GitHub-shaped objects keep exact GitHub field names; broker-shaped state is separate.
  Never key immutable content by head SHA alone — the compare key is `merge_base...head`.
- TanStack Query: blobs `staleTime: Infinity` (content-addressed); snapshot queries
  invalidated only by sync; the PR list is the only polling surface.
- Never discard user-written text on failure — optimistic writes roll back to an
  editable state with the text intact.

# Known landmines — traps already identified

Each of these has a ticket or a doc section; listed here so no session rediscovers them the hard way.

**In the prototype (fix before real GitHub traffic — milestone M1):**
- `looksLikePersonName` in `src/lib/identity.ts` admits only letter-tokens, but Coder usernames can contain digits/underscores (`alice2`, `j_doe`) — such a contractor's every comment would render as the bare bot. Relax the charset + add an `alice2` fixture (M1.2) **before the first stamped comment**.
- `BROKER_LOGIN` is a hardcoded const in `src/api/types.ts` — but `session.brokerLogin` already exists in the type and is populated by the mock; the bug is that `lib/identity.ts` imports the const instead of reading the session (M1.1).
- Own-comment detection is name-string matching — breaks across Coder renames/username reuse; upgrade to the `commentAuthors` id-map with name fallback (M1.3).
- Split-mode preference sits in `sessionStorage` (`src/pages/files.tsx`) — the last browser-side per-human state; fold into the prefs store (M1.4) to make "rebuild loses nothing" literally total.

**GitHub API:**
- GraphQL thread comments must be normalized to the REST `ReviewComment` vocabulary — request `fullDatabaseId` for REST-numeric ids, map `diffSide`→`side`, carry `diffHunk`→`diff_hunk`. **Confirm `fullDatabaseId` still exists in the current schema** before building on it (M2.4).
- `replyToThread`: REST wants a *comment* id, the contract passes a *thread* id — reply to the thread's **first** comment; GitHub attaches replies to the root regardless.
- Reactions are per-GitHub-user and there is one bot user: everyone's 👍 is the same 👍. Ship shared-and-honest; **do not** build per-human reaction simulation.
- Installation tokens *can* run `resolveReviewThread`/`unresolveReviewThread` GraphQL mutations; `resolvedBy` reads as the bot (UI already renders that).
- Blobs: local `git cat-file` first (zero API cost, works offline); API fallback batched via GraphQL `object()` aliases ~30/query. Binary heuristic = NUL byte in first 8000 bytes, same as git.
- **A base-branch advance moves the three-dot compare but does NOT refresh the pull's stored `base.sha` until a "synchronize"** (a head push, or a `PATCH pulls/{n}` base edit / `gh pr edit --base <same branch>`). The direct sync reads `pull.base.sha` to compute `merge_base…head`, so a base advance with no head push is invisible until GitHub recomputes `base.sha` — relevant to M4's live-layer base-change detection, and the reason the base-advances live check (`scripts/smoke-direct.ts`) nudges the base with a re-edit before re-syncing.

**Test harness (`bun test`) — bit CI twice during M0:**
- **One shared mock store across all files.** The `test/preload.ts` `localStorage` shim is a single process-wide `Map`, and the mock store persists to it (debounced ~1s). `bun test` re-imports the store per file but the shim is shared, so one file's mock mutations — or a debounced flush of them — leak into another file's `load()`. Green locally, red on the slower CI runner (order/timing dependent). **Any test that drives the mock (`createMockApi`/`mockDev`) must `mockDev.reset()` in `beforeAll` (and `afterAll` if it mutates).** The scenario walk assumes a pristine fixture seed.
- **The gate runs `bun test` BEFORE the app build** (`oxlint && tsc -b && bun test && build`), so `packages/app/dist` does not exist during tests. Any test that starts `revud` must point it at a stub dist via `REVU_DIST_DIR` (+ a temp `REVU_DATA_DIR`), never the real build.

**Transport modes (M0+):**
- The app selects `createMockApi()` unless `VITE_REVU_API` is set at build time; `?mock=1` ALWAYS forces the pure in-browser mock (no HTTP). `dev:e2e` builds with `VITE_REVU_API=/` so the served app makes same-origin relative `/api/*` calls to revud (port-independent). A no-arg `bun run build:app` produces a mock build.
- `addReaction` carries the owning PR as `?pr=<n>` — the contract route path (`/api/comments/:id/reactions`) has only the comment id, but the mock/revud need the PR to locate the comment.

**E2E (playwright-core, headless system Chrome) — the browser gate (MT.4+):**
- The e2e driver is a **plain `bun run` script, never a `*.test.ts`** (`e2e/happy-path.ts` + `e2e/harness.ts`, run via `bun run test:e2e`). The gate runs `bun test` BEFORE the app build, so a `*.test.ts` e2e would be swept into the gate and run with no `dist` present. It does its own `check()` assertions and `process.exit(1)` on failure, exactly like `scripts/smoke.ts`. CI runs it as a **separate `e2e` job** with `needs: check` (after the gate), capped `timeout-minutes: 10`.
- The e2e needs the **HTTP-mode** dist (`build:e2e` = `VITE_REVU_API=/ bun run build:app`); a no-arg `build:app` is a mock build and would silently pass the whole UI flow without touching the network. The happy path asserts **≥1 real `/api/*` request** fired (the seam is genuinely exercised) and that `?mock=1` fires **zero** — that pair is the only guard against an accidental mock build.
- **Happy-path fixture = PR 101:** never-synced, no seeded draft, authored by another human with `h-priya` (the default human) as reviewer, so it appears in the inbox. Clean `sync → inline draft comment → COMMENT submit → draft cleared`. Avoid 312 (seeded draft) and 389 (reconcile).
- Two selector traps that were green-locally/red-on-a-cold-runner: (1) a non-auto-waiting `isVisible()` probe on the `Sync now` button races first render — **wait for the button, don't probe**; (2) `getByText('synced')` also matches "This PR was never synced" / the "never synced" seal — match the success seal `⧗ <sha> · synced <time>` with **`/· synced/`** instead.
- Chrome on CI: `channel: 'chrome'` resolves the preinstalled Google Chrome on `ubuntu-latest` (confirmed: e2e job green in ~14s); `E2E_CHROME_PATH` overrides `executablePath` as an escape hatch. No browser-download step. The harness serves the real dist via a fresh temp `REVU_DATA_DIR` + ephemeral `REVU_PORT=0` per run (pristine fixtures), so the shared-mock-store `mockDev.reset()` rule does not apply here.

**Linear MCP (tracking):**
- Milestone names ≤ 80 chars or `save_milestone` fails. Milestone comments need the milestone **UUID** (`list_milestones` first). Status-update reads need `orderBy:"createdAt"`. `list_issues` has no milestone filter. Real newlines in bodies, never literal `\n`.

**CHECKPOINT_1 (independent pre-M2 review of `main` @ `5985f34` → milestone M1.6) — traps + do-not-undo:**
- **`/api/dev`, `/api/dev/reset` are mock-only forever (C3).** They change identity (`dev.setHuman`) and reseed the store; gated at the revud router boundary on an **explicitly-passed** mode (not `process.env`, so a stray env var can't re-enable it). **M3/direct must never expose them.** They sit outside the shared `ROUTES` table by design — documented in `http.ts`.
- **Durability is a daemon concern, not a browser one (C5).** The mock's `flush()`/`load()` swallow storage errors — correct for localStorage, wrong on disk. revud surfaces write failures as typed errors (never 200 on an unpersisted draft) and distinguishes absent from unreadable (never reseed over a present-but-unreadable document). **M2.3's SQLite store owns durability end-to-end: no error swallowing on the write path; unreadable ≠ absent.** Do not inherit the browser swallow into the durable path.
- **`STORE_VERSION` migrations migrate in place, never reseed (C4 — restates the M1.4 P0).** Any store-shape change bumps the version and defaults new fields in `load()`'s migration ladder; a bump that reseeds wipes drafts and violates "drafts survive everything." A new field (e.g. `startLineText`) defaults to null on old documents.
- **`anchor.ts` reconcile logic is shared truth, written once (C1/C2).** Blob-side selection (base for LEFT, head for RIGHT) lives in ONE selector imported by both the adapter and the reconcile dialog; the `clean` fast path requires a context-score floor (a coincidental duplicate line at the original index must not short-circuit to `clean`). The conformance suite is where reconcile correctness is proven — add scenarios (LEFT-side, preview/report parity), don't re-verify by hand.

**Do NOT "fix" these — correct unasked-for calls a checkpoint could provoke undoing (CHECKPOINT_1 §What-is-solid):**
- **Reusing the app's mock in revud** (`import('@revu/app/mock')` + a disk-backed `Storage` polyfill) instead of M0.3's specified port — one oracle, no divergence. Keep it.
- **The `load()` migration ladder + the M1.4 in-place prefs migration** (a version bump never wipes drafts) — exactly right.
- **The `network`-code enveloping** (client-side-only code, no HTTP status, surfaced as an enveloped 5xx and reconstructed adapter-side) — a careful, correctly-documented call at both ends.
- **DOM-global guards** (`typeof document`/`typeof localStorage`) for headless reuse, and the boot-order dependency (install storage → then load mock) — load-bearing, documented, tested.
- **MT** (the TDD milestone inserted ahead of M0) and **the transport-parameterized conformance suite** — the right assets; C1/C2 are gaps in its *scenarios*, not its design.

**M2 (direct mode — first real GitHub) — decisions:**
- **Direct-mode auth = the `gh` user, NOT the GitHub App.** The direct `TokenSource` resolves the token via `gh auth token` (respecting `GH_TOKEN`/`GITHUB_TOKEN`); owner/repo from `git remote get-url origin` (guide §5 + MILESTONES.md M2.2). The App private key `tmp/revu-sandbox-app.pem` + installation-token minting is **M3's separate `TokenSource` strategy** (broker mode), not M2. A prior handover's "run as the bot in M2" was aspirational — the doc is source of truth. **Do NOT wire the `.pem`/App into M2 direct mode.** Non-secret App coords (App id 4326148, installation 147260896) live in `tmp/appdetails.md` and are for M3.
- **Mode = an injected pair of strategies (`TokenSource`, `WriteDecorator`) around one shared core** (guide §5). The core — sync engine, snapshot store, draft store, anchor — is ~all the code; mock/direct/broker differ only in the injected pair. M2.2 builds `TokenSource`; M2.6 builds `WriteDecorator`.
- **Scratch repo `pat-mw/revu-sandbox` is seeded as the gh user** by `scripts/seed-scratch.ts` — idempotent (re-run converges, no duplicate PRs), guarded to the scratch target so it can never mutate a real repo. Wired into conformance CI (M5.1). The detailed sync/normalize/write/blob traps for M2.3–M2.7 already live in the "GitHub API" + "Transport modes" sections above and in `docs/agent/INTEGRATION_GUIDE.md` §3–§4.

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

**Test harness (`bun test`) — bit CI twice during M0:**
- **One shared mock store across all files.** The `test/preload.ts` `localStorage` shim is a single process-wide `Map`, and the mock store persists to it (debounced ~1s). `bun test` re-imports the store per file but the shim is shared, so one file's mock mutations — or a debounced flush of them — leak into another file's `load()`. Green locally, red on the slower CI runner (order/timing dependent). **Any test that drives the mock (`createMockApi`/`mockDev`) must `mockDev.reset()` in `beforeAll` (and `afterAll` if it mutates).** The scenario walk assumes a pristine fixture seed.
- **The gate runs `bun test` BEFORE the app build** (`oxlint && tsc -b && bun test && build`), so `packages/app/dist` does not exist during tests. Any test that starts `revud` must point it at a stub dist via `REVU_DIST_DIR` (+ a temp `REVU_DATA_DIR`), never the real build.

**Transport modes (M0+):**
- The app selects `createMockApi()` unless `VITE_REVU_API` is set at build time; `?mock=1` ALWAYS forces the pure in-browser mock (no HTTP). `dev:e2e` builds with `VITE_REVU_API=/` so the served app makes same-origin relative `/api/*` calls to revud (port-independent). A no-arg `bun run build:app` produces a mock build.
- `addReaction` carries the owning PR as `?pr=<n>` — the contract route path (`/api/comments/:id/reactions`) has only the comment id, but the mock/revud need the PR to locate the comment.

**Linear MCP (tracking):**
- Milestone names ≤ 80 chars or `save_milestone` fails. Milestone comments need the milestone **UUID** (`list_milestones` first). Status-update reads need `orderBy:"createdAt"`. `list_issues` has no milestone filter. Real newlines in bodies, never literal `\n`.

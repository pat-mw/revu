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

**Linear MCP (tracking):**
- Milestone names ≤ 80 chars or `save_milestone` fails. Milestone comments need the milestone **UUID** (`list_milestones` first). Status-update reads need `orderBy:"createdAt"`. `list_issues` has no milestone filter. Real newlines in bodies, never literal `\n`.

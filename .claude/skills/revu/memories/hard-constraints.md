# Hard constraints — non-negotiables for any revu change

From `AGENTS.md`, `docs/agent/INTEGRATION_GUIDE.md`, and the prototype's contract. Violating any of these is a defect even if tests pass.

- **The `RevuApi` interface (`src/api/client.ts`) + wire types (`src/api/types.ts`) are the frozen contract.** The mock's semantics ARE the spec — three that must survive any transport: `submitReview` returns `{status:'head_moved'}` as a **200-level value, never an error**; `syncPull` may **resolve** with `snapshot.partial` set rather than throwing; `getSnapshot` returns **`null`, not 404-as-error**, for never-synced PRs.
- **The mock adapter is never deleted.** It is the permanent test double, conformance oracle, and demo mode (`?mock=1` stays reachable in production builds).
- **TDD, self-verifying (milestone MT):** every code change lands with its tests (unit / integration / e2e as appropriate); the local gate (`bun run check` once MT.2 lands) and the GitHub Actions gate must be green — an agent verifies its own work locally, with **no human supervision and no external deployment**. Never merge red; never skip the gate.
- **Two-half caching:** never key immutable content by head SHA alone — the key is `compareKey = merge_base_sha...head_sha`. No TTL on the immutable store; a head-SHA match must never short-circuit the mutable fetch.
- **Drafts survive everything — that is the product.** A draft is deleted only on confirmed submit success. A 422 after the head-guard keeps the draft and surfaces `conflict`. Never discard user-written text on failure; optimistic writes roll back to an editable state with text intact.
- **Identity:** `Human.id` = lowercase git-config **email** (stable key for drafts/viewed/audit); name is display-only. Emails never go into GitHub comment bodies. Display identity (stamped prefix) and audit identity (broker channel) are separate systems — only audit needs to be tamper-proof.
- **Token custody:** the browser never sees a GitHub token; in broker mode, workspace `revud` never holds it either — GitHub-bound calls are forwarded to the broker. No token endpoint exists.
- **Reconcile logic is shared, not duplicated:** `src/lib/anchor.ts` is pure; server-side reconcile must import the *same module* the UI previews with — divergence there is the worst bug in the most important flow.
- **Workspaces serve the built `dist/`, never `vite dev`.**
- **Code style (AGENTS.md):** comments/docstrings are self-contained — never reference tickets, PR numbers, phases, agents, or tracking artifacts in code. TS strict + `verbatimModuleSyntax`; no raw hex in components (use `globals.css` tokens); all data access through `api` from `@/api`.
- **Secrets never enter Linear.**

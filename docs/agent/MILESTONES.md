# revu — Milestones

Companion to `revu-integration-guide.md`. This document is the single source for populating Linear: each `## Milestone` becomes a Linear milestone (or project), each `### Issue` becomes an issue, each `- [sub]` line becomes a sub-issue. IDs (`M2.3`) are stable references — use them in branch names and commit messages so cross-session context survives in Linear.

Conventions used throughout:

- **Exit criteria** on a milestone are the definition of done for the milestone as a whole; do not close the milestone with any unchecked.
- **Depends** names hard blockers only. Anything not listed may proceed in parallel.
- **Verify** on an issue is the acceptance test an agent must run (or write, then run) before closing.
- File paths refer to the `pat-mw/revu` repo unless prefixed `broker/` (new codebase) or `revud/` (new package; recommended location `packages/revud` in the same repo, with the existing frontend moving to `packages/app` in M0.1 — one repo, three packages: `app`, `revud`, `shared`).
- The mock adapter is never deleted. It is the permanent test double and demo mode.

---

## Milestone MT — TDD foundation (local + CI test gate)

**Goal:** test-driven development from the very first PR. An agent must be able to verify its own work — unit, integration, and (once the transport seam exists) e2e — locally, without supervision and without any external deployment. The same gate runs in CI on the public GitHub repo (free Actions runners), so nothing merges red.

**Exit criteria:**
- `bun run check` runs lint, typecheck, unit + mock-integration tests, and the production build locally; it is the documented pre-PR gate.
- GitHub Actions runs the same gate on every push and PR to `main`; merging requires it green.
- The pure lib modules (`anchor.ts`, `identity.ts`, `diff.ts`) and the mock adapter's fixture scenarios are covered by `bun test`.
- An e2e smoke drives the built app against revud-mock headlessly in CI.

**Depends:** nothing — runs in parallel with M0 from the first PR (only MT.4 needs M0.3/M0.4). Listed first because every later issue's **Verify** executes under this gate. Later gate growth stays in later milestones: the conformance harness is M1.5; the full release matrix is M5.1.

### Issue MT.1 — Unit-test foundation on `bun test`
Adopt Bun's built-in runner (zero new deps), co-located `*.test.ts`, and cover the pure logic first — it is the code the whole product leans on.
- [sub] Runner conventions + first suite: `lib/anchor.ts` exact/drift/lost classifications against fixture scenarios.
- [sub] `lib/identity.ts` (prefix round-trip, false-positive rejections, charset cases) and `lib/diff.ts` suites.
- [sub] Convert the `scripts/smoke.ts` scenario walk into `bun test` integration specs for the mock adapter (base-moved, resolved-elsewhere, partial sync, draft survival).
**Verify:** `bun test` green; deleting a covered branch in `anchor.ts` fails at least one test.

### Issue MT.2 — The local gate: one command, always green
- [sub] `bun run check` = oxlint + `tsc -b` + `bun test` + `vite build`; wire into package.json; document in `AGENTS.md` as the mandatory pre-PR gate.
- [sub] Opt-in pre-push hook via `core.hooksPath` (no new deps) running the gate.
**Verify:** a seeded type error, a lint error, and a failing test each make `bun run check` exit non-zero.

### Issue MT.3 — CI: the same gate on GitHub Actions
Public repo → free runners. One workflow; a red gate blocks merge. (M0.1's CI sub-task then reduces to: adapt this pipeline to the workspace layout.)
- [sub] The workflow: setup-bun, `bun install --frozen-lockfile`, `bun run check`, dependency caching; triggers on push + PR to `main`.
- [sub] Branch protection requiring the check green to merge; document the setting.
**Verify:** a PR with a deliberately failing test shows a red required check on GitHub.

### Issue MT.4 — E2E scaffold: headless app against revud-mock
`playwright-core` is already a devDependency (`scripts/shots.ts` launches the app headlessly) — formalize it into an e2e layer. **Depends:** M0.3, M0.4.
- [sub] E2E harness: build the app, boot revud-mock on one port, drive with playwright-core.
- [sub] First happy path asserted: inbox → PR → files → draft a comment → submit (mock) → draft cleared.
- [sub] CI job: run e2e headless after the gate; upload screenshots on failure.
**Verify:** the e2e job is green in CI on a clean checkout — no external deployment, no supervision.

---

## Milestone M0 — Transport seam

**Goal:** the frontend talks HTTP to a `revud` process that serves the mock store. Zero GitHub. Proves the contract boundary; after this milestone the UI cannot tell mock from real, which is the property every later milestone relies on.

**Exit criteria:**
- `bun run dev:e2e` starts revud (mock-backed) + built frontend on one port; every prototype flow works unchanged through HTTP.
- Killing and restarting revud mid-session loses no draft (drafts now live server-side in revud's store).
- `?mock=1` still runs the pure in-browser mock as before.

### Issue M0.1 — Repo restructure to workspace packages
Move frontend to `packages/app`, create `packages/revud` and `packages/shared`. Extract into `shared`: `src/api/types.ts`, `src/api/client.ts` (the `RevuApi` interface), `src/lib/anchor.ts`, `src/lib/identity.ts`. App imports from `@revu/shared`; no logic changes.
- [sub] Bun workspaces config, path aliases, tsconfig project references.
- [sub] CI: `tsc -b` + `vite build` + `oxlint` green at the new layout.
**Verify:** build passes; `grep -r "from '@/api/types'" packages/app` returns nothing.

### Issue M0.2 — HTTP contract definition
Write `packages/shared/http.ts`: route table for every `RevuApi` method exactly as guide §0, error envelope `{code, message, resetAt?}`, status mapping (`rate_limited`→429, `broker_unreachable`→502, `conflict`→409, `not_found`→404, `forbidden`→403, `network`→client-side only). Document the three non-error semantics that must survive transport: `submitReview` returns `head_moved` as 200; `syncPull` may resolve with `partial` set; `getSnapshot` returns 200 `null` for never-synced.
- [sub] Shared zod (or hand-rolled) validators for request/response bodies, used by both revud and the http adapter in dev builds.
**Verify:** validators round-trip every fixture PR's `Snapshot` without loss.

### Issue M0.3 — revud skeleton, mock-backed
`packages/revud`: Bun HTTP server, serves `packages/app/dist` statically plus `/api/*` per M0.2, backed by a port of `src/api/mock/store.ts` persisting to a JSON file on disk (replaces localStorage). Honors `AbortSignal` semantics on sync via request abort. Config via env: `REVU_PORT`, `REVU_MODE=mock`.
- [sub] Port mock store persistence: one JSON document on disk, atomic write (tmp+rename).
- [sub] Latency/failure dev toggles exposed at `/api/dev/*` so the existing dev panel keeps working against HTTP.
**Verify:** exit criteria 1–2.

### Issue M0.4 — `createHttpApi` frontend adapter
`packages/app/src/api/http/adapter.ts` (~150 lines): fetch wrapper, ApiError mapping, ETag pass-through on `listPulls`, AbortSignal on `syncPull`. `src/api/index.ts` selects on `VITE_REVU_API` / `?mock=1`.
- [sub] Optimistic-write parity check: reply/resolve/reaction flows behave identically to mock (same rollback on failure).
**Verify:** manual pass of the demo map in README through HTTP; dev panel failure toggles produce the same UI states as in-browser mock.

---

## Milestone M1 — Frontend punch list

**Goal:** the four prototype corrections from guide §7 that must precede any real GitHub traffic. Small, independent, parallelizable; all frontend/shared only.

**Exit criteria:** all four issues closed; conformance harness scaffold (M1.5) runs the mock adapter green.

**Depends:** M0.1 (shared package exists).

### Issue M1.1 — `BROKER_LOGIN` from session config
Delete const usage in `shared/identity.ts`; `parseCommentIdentity` and `isOwnComment` take the bot login (or the whole `Session`) as an argument. Mock populates `session.brokerLogin` already — thread it through callers (`comment-view.tsx`, `thread-card.tsx`, inbox unread logic).
**Verify:** grep for `BROKER_LOGIN` shows only the mock fixture seeding; renaming the fixture's bot login breaks nothing.

### Issue M1.2 — Parser charset vs Coder usernames
Relax `looksLikePersonName` to Coder's username charset (letters, digits, `_`, `-`, 1–4 tokens, still length-capped). Add fixture human `alice2` (`role: contractor`) with authored comments in one existing PR fixture.
**Verify:** `alice2` renders as a human, not the bot, in threads and inbox; existing `**Warning**`-style false-positive tests still reject.

### Issue M1.3 — Own-comment detection by id
Add `commentAuthors?: Record<number, string>` (comment id → human id/email) to `SnapshotMutable`. Mock populates it for broker-authored fixture comments. `isOwnComment`: id-map first, name-match fallback, direct-mode viewer-login branch (add `viewerLogin?: string` to `Session`).
**Verify:** rename a fixture human after their comments exist (simulating a Coder rename); "your comment" affordances still resolve via the id map.

### Issue M1.4 — Split-mode preference off sessionStorage
Move unified/split preference (`pages/files.tsx`) into the viewed/preferences store behind the adapter.
**Verify:** grep `sessionStorage` in `packages/app/src` returns nothing.

### Issue M1.5 — Conformance harness scaffold
`packages/shared/conformance/`: a test suite parameterized over any `RevuApi` implementation, asserting the spec's hard invariants from the fixtures: two-half cache keying (base-moved re-syncs the diff; head-unchanged still refetches mutable), `head_moved` as value, partial-sync resume fetches only missing blobs, drift/lost anchor classifications for the pr410-style scenario, draft survival across adapter restart.
**Verify:** suite green against mock adapter and against revud-mock over HTTP (catches transport bugs immediately).

---

## Milestone M2 — Direct mode: real GitHub, smallest surface

**Goal:** `revud --direct` in any cloned repo gives a working end-to-end review pipeline as the authenticated user, against a scratch repo first. This is where the sync engine, normalizer, and write path get real; it also ships the general-purpose tool.

**Exit criteria:**
- Conformance suite green against direct mode pointed at the seeded scratch repo.
- Full manual review loop on the scratch repo: sync → comment (incl. multi-line + suggestion) → submit → visible on github.com → reply from github.com → re-sync shows it threaded with genuine identity.
- Reconcile proven against a real force-push: draft written, force-push moving/deleting target lines, submit routes to reconcile, classifications correct, accepted comments land.
- Cold sync of a 14-file PR ≤ 12 API requests with local-git blobs; `syncStats` populated honestly.

**Depends:** M0, M1.5. (M1.1–M1.4 not blockers but should land before M2 closes.)

### Issue M2.1 — Scratch environment
Script (`scripts/seed-scratch.ts`) that creates/refreshes a test repo mirroring the fixture scenarios: a clean small PR, a large PR (14+ files incl. lockfile, binary, rename), a mid-review PR with resolved/outdated threads, a base-advances case, a force-push case. Idempotent; used by conformance CI.
- [sub] Document required scopes for the tester's `gh` auth.

### Issue M2.2 — Auth + repo resolution
`TokenSource` strategy interface; direct implementation via `gh auth token` / `GH_TOKEN`; owner/repo from `git remote get-url origin` with override flag. Session: git config name/email, email as `Human.id`, `viewerLogin` from `GET /user`.
**Verify:** revud refuses to start with a clear message when `gh` is unauthenticated or cwd isn't a repo.

### Issue M2.3 — Sync engine: REST reads
Steps 1–2, 4–6 of guide §3: pull detail (incl. `merge_base_sha`), files (paginated, patch presence handling for binary/oversize), issue comments, reviews, commits, check-runs, base tree for blob index. Immutable/mutable split enforced in the store exactly per guide §3.2 — `compareKey` short-circuits steps 2/6/7 only.
- [sub] Snapshot store: SQLite at `${XDG_DATA_HOME:-~/.local/share}/revu/` — tables `snapshots`, `blobs` (content-addressed), `drafts`, `viewed`, `prefs`.
- [sub] Pagination + 3000-file cap handling with an honest `partial` reason.
**Verify:** conformance cache-keying tests green against scratch base-moved PR.

### Issue M2.4 — Sync engine: GraphQL threads + normalizer
`reviewThreads` query (paginated, nested comments with `fullDatabaseId`, `diffHunk`, sides/lines, `isResolved`/`isOutdated`/`resolvedBy`) normalized to REST `ReviewComment` shape per guide §3.1. Confirm `fullDatabaseId` against current schema; if renamed, adapt and note in the issue.
**Verify:** normalizer output for the scratch mid-review PR is structurally identical (same keys, same types) to fixture pr347's threads; add as a snapshot test.

### Issue M2.5 — Blob provider: local git first
`git cat-file` provider with existence probe, NUL-heuristic binary flag, size; API fallback `GET /git/blobs/{sha}` (base64 decode). Batch fallback via GraphQL `object()` aliases (~30/query) for cold cache.
**Verify:** cold sync request count within budget (exit criterion 4); sync with network blackholed except broker/GitHub-unreachable still succeeds when local git has both SHAs.

### Issue M2.6 — Writes: submit, reply, resolve, react
Per guide §4: head-guard then `POST /reviews` with 1:1 `PendingComment` mapping; 422 → `conflict`, draft retained; reply-to-first-comment threading; GraphQL resolve mutations; reactions endpoint. `WriteDecorator` strategy interface with direct = passthrough.
- [sub] Draft deleted only on confirmed success; idempotency note for retry-after-timeout (re-check via `GET /pulls/{n}/reviews` before reposting).
**Verify:** exit criteria 2–3.

### Issue M2.7 — Reconcile server-side
`reconcileDraft` endpoint using the shared `anchor.ts` module against fresh head blobs; `newCommits` from snapshot delta.
**Verify:** conformance drift/lost tests green against the scratch force-push PR; UI preview matches server classification exactly (same module, but assert it anyway).

---

## Milestone M3 — Broker service

**Goal:** the broker grows the revu API from guide §2 on a scratch GitHub App + scratch org, run as a localhost process. Token custody, stamping, audit, durable per-human state. No sandbox hardware involved.

**Exit criteria:**
- revud in `REVU_MODE=broker` against localhost broker passes the conformance suite on the scratch org.
- Every write on github.com shows the stamped prefix; parser round-trips it; org-member comments interleave with genuine identity.
- Draft written via one revud instance survives that instance's deletion and reappears via a fresh one (simulated workspace rebuild).
- Audit log contains `{human_email, workspace, endpoint, pr, github_id, timestamp}` for every write, with GitHub-assigned ids.
- `canApprove` false on App-authored PRs (submit APPROVE rejected upstream and surfaced honestly), true on org-member PRs.

**Depends:** M2 (reuses sync engine and write path; broker wraps them).

### Issue M3.1 — Scratch App + org
Create GitHub App (PR read/write, contents read, checks read), install on scratch org mirroring M2.1 scenarios plus one PR opened by a real org-member account.
- [sub] Document App creation/permissions as the client-facing runbook for the real installation.

### Issue M3.2 — Token custody
Broker: App JWT → installation token mint, refresh before expiry, in-memory only, never serialized to responses or logs. revud broker-mode `TokenSource` = "ask broker to execute", i.e. **no token endpoint exists** — GitHub-bound calls are forwarded, per guide §2 topology.
**Verify:** grep broker logs/responses for `ghs_` finds nothing.

### Issue M3.3 — Broker endpoints: reads + caches
`/v1/pulls`, `/v1/pulls/:n/sync`, `/v1/blobs/:sha`, `/v1/rate-limit` — sync executes the M2 engine broker-side; shared content-addressed blob cache; snapshot cache serving warm re-syncs to any workspace.
**Verify:** two revud instances syncing the same PR: second sync's `blobsReused` equals blob count, request count ≤ mutable-refresh budget.

### Issue M3.4 — Broker endpoints: writes with stamping + audit
`WriteDecorator` broker implementation: `prefixBody(human)` on every outbound body, append-only audit log (SQLite) with GitHub response ids, per exit criteria. Reply/resolve/react/submit forwarded from revud with human identity from the request context.
- [sub] Audit log export command (`broker audit --pr 42 --since …`) for the client conversation.
**Verify:** exit criteria 2, 4.

### Issue M3.5 — Durable per-human state
`/v1/drafts/:email/:n`, `/v1/viewed/:email/:n` on broker SQLite; revud broker-mode delegates draft/viewed/prefs storage here instead of local.
**Verify:** exit criterion 3.

### Issue M3.6 — Workspace→broker authentication
Requests carry workspace identity from the transport channel (tailnet source / mTLS / per-workspace bearer minted at provision time — decide with what the existing token-injection channel already provides), mapped broker-side to the audit `workspace` field. Git-config identity remains the display layer; channel identity is the audit layer. Document the trust boundary as in guide §1.
**Verify:** a request with a forged `X-` identity header still audits under the channel-derived workspace.

---

## Milestone M4 — Live layer + identity ground truth

**Goal:** the inbox becomes genuinely live and own-comment detection becomes exact. Completes `BrokerPullMeta`.

**Exit criteria:**
- Inbox reflects an upstream change (new PR, new commit, thread resolved on github.com) within one poll interval without any snapshot sync.
- `commentAuthors` present in broker-mode snapshots; M1.3's id-path exercised end-to-end.
- Reviewer assignment visible in inbox sections.

**Depends:** M3.

### Issue M4.1 — Poll loop
30s conditional poll (`If-None-Match`), per guide §2.1; on change, batched GraphQL refresh of unresolved counts / head / `compareKey` / `commitCount` for changed PRs only. `/v1/pulls` serves from this cache with broker-level ETag; revud passes 304s through to the frontend's existing polling.
**Verify:** an hour of idle polling costs ≤ a handful of non-304 requests (log-verified).

### Issue M4.2 — `BrokerPullMeta` completion
`authorHumanId` from the broker's PR-creation log; `canApprove` derivation; `assignedReviewerHumanIds` via minimal assignment mechanism (YAML file or admin endpoint — smallest thing the lead will actually use; decide and note in-issue).
**Verify:** inbox sections (yours-with-comments / assigned-to-you) populate correctly for two different humans against the same broker.

### Issue M4.3 — `commentAuthors` in sync payload
Assemble from audit log during broker-side sync, merged into `SnapshotMutable`.
**Verify:** M1.3 verify-scenario, now against real broker data.

---

## Milestone M5 — Hardening + release gate

**Goal:** the suite and behaviors that make it safe to hand to people who didn't build it. Nothing ships to contractors before this closes.

**Depends:** M2, M3; M4 for the full matrix.

### Issue M5.1 — Conformance matrix in CI
The M1.5 suite as the release gate across: mock in-process, revud-mock HTTP, direct vs scratch repo, broker-mode vs scratch org. Scratch environments refreshed by M2.1/M3.1 scripts.

### Issue M5.2 — Failure drills
Scripted, each with asserted UI copy per `error-copy.ts`: broker down mid-draft-save (no data loss, retry works); GitHub 5xx mid-sync (partial snapshot honest, resume fetches only missing); rate-limit exhaustion (429 with reset time surfaced); token expiry mid-burst (broker refreshes transparently); submit-window force-push (guard→reconcile) and 422-after-guard (conflict, draft intact).

### Issue M5.3 — Performance pass
Large-PR fixture (2,000+ lines) and its scratch twin: sync wall-time budget, virtualized scroll jank check, Shiki worker not blocking first paint, warm-cache re-sync latency.

### Issue M5.4 — Security review
Token custody paths; audit-log integrity (append-only, workspace-channel binding from M3.6); what a hostile workspace can and cannot do — written up as one page for the client. Confirm: browser never sees a token; broker never trusts workspace-claimed identity for audit; drafts of human A unreadable via human B's session.

### Issue M5.5 — Docs
Direct-mode README for general users (`bunx revud` quickstart); operator runbook (broker install, App creation from M3.1 sub-doc, audit export); CONTRIBUTING note that the mock is the permanent oracle.

---

## Milestone M6 — On-prem deployment

**Goal:** the sandbox specifics that cannot be proven off-prem (guide's deferral list). Executed on-site as a checklist; every technical unknown was retired in M2–M5.

**Depends:** M5.

### Issue M6.1 — Broker deployment on the macOS host
Real App credentials (client runbook from M3.1), launchd service, broker SQLite location + backup for audit/drafts.

### Issue M6.2 — Lima + tailnet path
Workspace revud → host broker across the VM boundary; tailnet ACL for the broker port; document the address workspaces use.

### Issue M6.3 — Coder template wiring
Startup build + revud launch per guide §6 (serve `dist/`, never `vite dev`); port 4780 as a named Coder app; alias; confirm injected git identities parse (M1.2 charset) with the real username population.

### Issue M6.4 — Two-human end-to-end
The invariant proof: two contractors (two browser profiles / two workspaces), one PR, independent drafts, both submit, both stamped correctly, audit log distinguishes them, drafts survived a mid-test workspace rebuild for one of them.

### Issue M6.5 — Client acceptance
Walk the client's lead through: org-member review interleave on github.com, approve-on-github workflow for App-authored PRs (guide §2.1 gating), audit export, tailnet exposure surface. Sign-off closes the milestone.
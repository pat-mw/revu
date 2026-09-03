# revu — Milestones

Companion to `revu-integration-guide.md`. This document is the single source for populating the board: each `## Milestone` becomes a workstream, each `### Issue` becomes a ticket, each `- [sub]` line becomes a unit. IDs (`M2.3`) are stable references — use them in branch names and commit messages so cross-session context survives.

**Where the board lives:** MT–M7 were seeded into the Linear `revu` project, which now holds them as read-only history — the workspace hit its free issue cap and `save_issue` no longer works. From **M8** onward the board is local, at `.claude/workstreams/<id>-<slug>/`. This document and the board must never drift: if scope changes, update both in the same PR.

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

## Milestone M1.6 — reconcile correctness + surface hygiene

**Goal:** close the nine defects an independent pre-M2 code review (`docs/agent/CHECKPOINT_1.md`, review of `main` @ `5985f34`) found in code that M2 blesses as production-shared. Three P0s (C1–C3) must land before M2 opens; the P1/P2 findings (C4–C9) ride along before M2 closes. The through-line: every P0 is a place where two things that must agree were written twice, or where something outside the contract was allowed to matter — the conformance suite is the right structural answer and these are the scenarios it doesn't yet have.

**Exit criteria:** all nine findings closed with tests; the conformance suite gains LEFT-side + reconcile preview/report parity scenarios; the gate (`bun run check` + e2e) green on the stack tip.

**Depends:** M1 (landed). Blocks M2 — fix shared `anchor.ts`/`identity.ts` before M2 imports them verbatim.

### Issue M1.6.1 — Reconcile side-awareness + clean-path integrity (C1, C2)
`reconcileDraft` resolves the anchor blob unconditionally to head (`adapter.ts`), so LEFT-side comments (whose text lives in the base blob) mis-classify — while the dialog already selects base for LEFT. Introduce one shared blob selector imported by both; rename `classifyAnchor`'s line param so the wrong blob can't be passed silently; make `filePresence` side-aware (`added`→`lost` reason `file-added` for LEFT; `removed` non-terminal for LEFT). Separately, the `clean` fast path matches text-only at the original index with no context scoring, so a coincidental duplicate line classifies `clean` and is submitted with no human in the loop — require a context-score floor, demoting to the drift search below it.
**Verify:** LEFT-side comment on a deleted line in a base-unchanged PR → `clean`; a moved base blob → `drifted` with the base-side delta; dialog preview and adapter report agree on every fixture comment on both sides; a `}` at the original index after a 20-line insertion → `drifted`/`lost`, not `clean`; unmoved+intact-context still `clean`. Add LEFT-side comments to the PR 389 draft + a conformance parity scenario.

### Issue M1.6.2 — Gate /api/dev to mock mode (C3)
`/api/dev` (PUT `{humanId}` → `setHuman`), `failureMode`/`latency`, and `POST /api/dev/reset` (reseeds the store) run before any mode check and are absent from the shared `ROUTES` table — an unauthenticated call changes who you are, harmless only while `assertMode` permits mock alone. Gate `handleDev` at the router boundary on an explicitly-passed mode (not `process.env`), returning `null` (→ 404) in any non-mock mode; document the routes' out-of-table existence in `http.ts`; record the M3-regression landmine.
**Verify:** a daemon in any non-mock mode returns 404 for `GET/PUT /api/dev` and `POST /api/dev/reset`, asserted directly (not via `assertMode` rejecting boot first).

### Issue M1.6.3 — Identity token cap + stamper↔parser round-trip property test (C6)
`NAME_TOKEN_RE` caps a name token at 24 chars; Coder usernames reach 32, so a long-username contractor stamps fine but fails `looksLikePersonName` on the way back and renders as the bare bot — the M1.2 failure mode on the length axis. Raise the cap to Coder's real limit and make the inverse structural: a property/table test that `parsePrefixedBody(prefixBody(human, body))` round-trips exactly, for a corpus of legal Coder identities.
**Verify:** the property test passes for the corpus; a deliberate one-char tightening of the stamper or the parser fails it.

### Issue M1.6.4 — Ranged-comment start-line validation + STORE_VERSION bump (C4)
The range end is text-matched and context-scored; the start line is shifted rigidly by the same delta and never validated, so a line inserted inside a commented span silently mis-covers. Capture `startLineText` in `PendingComment.anchor` at write time and validate after shifting (search independently or surface the changed span for confirmation). Extending `anchor` bumps `STORE_VERSION` with an in-place migration (no reseed — the M1.4 lesson).
**Verify:** a ranged comment with a line inserted inside its span doesn't silently apply the old span length; a pre-existing store document loads intact across the version bump.

### Issue M1.6.5 — Durable flush: revud surfaces write/read failures (C5)
The mock's `flush()`/`load()` swallow storage errors — browser-correct for localStorage, wrong on disk, where the router returns 200 on a draft that never persisted and reseeds over a present-but-unreadable document. Surface failure at the revud boundary only (leave the browser semantics intact): a daemon flush path that returns a typed error on write failure, and a `getItem` that distinguishes absent from unreadable and never reseeds the latter.
**Verify:** a data dir made read-only mid-session → a draft save returns a typed error and the UI keeps the text editable; a corrupted-but-present document is not silently replaced by seed state. (Records the durability constraint for M2.3's SQLite store.)

### Issue M1.6.6 — Surface hygiene: strip ticket ref · lint gate · static path (C7, C8, C9)
C7: remove the `UZO-607` reference from an `integration.test.ts` describe (only ticket id in code; `AGENTS.md` forbids it). C8: resolve the 65 tolerated oxlint warnings — fix the `no-useless-escape` cluster, make `only-export-components` a configured choice — so the gate reports 0 warnings or an explicitly-justified set. C9: replace `resolveStaticPath`'s `startsWith(distDir)` prefix check and dead regex with a `relative()`-based containment check, exported and unit-tested.
**Verify:** `grep -rn "UZO-" packages e2e scripts` empty; `bunx oxlint` at 0 warnings (or configured); `/../secret` and its `%2e%2e%2f` encoding fall through to the SPA index, covered by a `resolveStaticPath` unit test.

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

## Milestone M3 — Broker mode: in-workspace engine + host-side collector

**Goal:** revu's shared-identity mode, corrected for the real sandbox topology (`docs/agent/CHECKPOINT_2.md`). The deployment is **MINT-AND-INJECT, not proxy**: the host token broker pushes a ~1h repo-scoped installation token into each container's `~/.git-credentials` over `docker exec`; there is no listening socket and no inbound service a workspace can call. So "broker mode" is **not a GitHub proxy** — it is the M2 direct engine running IN the workspace against the ambient injected token (via a file-credential `TokenSource`), plus a thin host-side **revu collector** (beside the token broker) that rides the existing 60s tick to pull each container's drafts + local audit journal (bound to the `coder.owner` label = channel-authentic), runs the out-of-band-write detector, and holds the durable per-human store. **No workspace-callable inbound surface** — this preserves the sandbox's zero-inbound invariant. Built on a scratch GitHub App + scratch org first; no sandbox hardware involved. See `CHECKPOINT_2.md` §F for the full per-ticket rationale and §E for the 7 owner decisions that drive it.

**Exit criteria:**
- revud in `REVU_MODE=broker` (inject-default) passes the conformance suite on the scratch org, reading + writing + reconciling in-workspace against a file-credential `TokenSource`.
- Every write on github.com shows the stamped prefix; parser round-trips it; org-member comments interleave with genuine identity.
- A draft written via one revud instance is pulled to the host collector and reappears via a fresh instance (simulated workspace rebuild + cross-workspace).
- The audit journal + host store contain `{human_email, workspace, endpoint, pr, github_id, timestamp}` for every mediated write, with GitHub-assigned ids; the out-of-band detector flags an App-authored comment posted directly (bypassing revud) as absent from every journal.
- Audit identity binds to `coder.owner` (host-authenticated), never to workspace-claimed identity; draft access is authorized by that binding, not by a path `:email` parameter.
- `canApprove` false on App-authored PRs (submit APPROVE rejected upstream and surfaced honestly), true on org-member PRs.
- The `FileCredentialTokenSource` tolerates ~40min credential rotation, the 60s cold-start gap, and the 401-erase of `~/.git-credentials` (re-read per request, surface a typed "awaiting credential" state, never serialize the token).

*Org-dependent validation deferred to M6:* the three criteria that need a real GitHub org with member accounts — the **scratch-org conformance** run, the **org-member interleave**, and **`canApprove` true on org-member PRs** — move with M3.1 to Milestone M6 (a scratch org with member accounts is not stand-up-able off a personal repo). The in-gate portions are complete and gate-green on `main`: in-workspace read/write/reconcile on a file-credential `TokenSource`; stamping + local audit journal + the out-of-band detector; the binding-authorized host store; the collector merge core (injected pull source); the `coder.owner` binding; offboarding retain-audit/purge; audit export; loopback bind. The `canApprove`-false-on-App-PRs half was proven live in M3.4.

### Issue M3.1 — Scratch App + org — **DEFERRED to M6**
Needs a real GitHub organization with ≥2 member accounts — for the org-member interleave, `canApprove`-true-on-org-PRs, and the scratch-org conformance run — which is not stand-up-able off a personal development repo. **Moved to Milestone M6** (on-prem deployment), where the real org + user accounts are created anyway; the App grant, the per-RevuApi-method→permission matrix, and the client-facing runbook ride along there. Linear keeps the stable `M3.1.x` IDs (UZO-575 + .1–.5) under M6. The in-gate M3 work was proven instead against injected conformance fakes + the real `pat-mw/revu-sandbox` repo/App (grant byte-identical, bot login `revu-sandbox-app[bot]`). See **Issue M3.1 (deferred)** under Milestone M6.

### Issue M3.2 — Token custody (inject-default `FileCredentialTokenSource`)
`FileCredentialTokenSource` reading `x-access-token` from `~/.git-credentials` (parse `https://x-access-token:<tok>@github.com`), **re-read per request** (never cached for process lifetime). This is the **deployment default**; the proxy-fetch `TokenSource` is kept as an **optional** guide-§5 strategy, not the default. Custody claim is **"revu adds no new credential and never serializes tokens"** — NOT "the workspace never holds a token" (false in this deployment; the workspace holds a live GitHub write token regardless of revu).
- [sub] Tolerate the externally-rotated credential: on 401 re-read-then-backoff; surface a typed "awaiting credential" state for the 60s cold gap + the 401-erase-of-the-file (`error-copy.ts` `broker_unreachable` semantics reusable). Conformance scenario: rotate the credential file mid-sync.
**Verify:** grep revud logs/responses for `ghs_` finds nothing; a mid-sync credential rotation does not fail the sync; a zero-byte credential surfaces "awaiting credential", not a crash.

### Issue M3.3 — Reads in-workspace (host cache de-prioritized)
Reads run **in-workspace** on the ambient token — the M2 engine + local-git blobs, cheapest path in this topology. The host shared blob/snapshot cache is **de-prioritized** (its value shrinks to cross-workspace warm-sync); if built at all it MUST be **scope-partitioned by `repos.map`** so workspace A never receives a blob from a repo only B is scoped to.
**Verify:** an in-workspace cold sync stays within the M2 request budget; if a host cache exists, a cross-scope blob request is refused.

### Issue M3.4 — Writes in-workspace + local audit journal + out-of-band detector
Writes run **in-workspace**: revud posts on the ambient token, stamps the body via `WriteDecorator` (`prefixBody(human)`), and appends to a **local audit journal**. The host collector pulls journals (`coder.owner`-bound) and runs the **out-of-band-write detector**: reconcile App-authored comment/review ids on GitHub against the journals; any id absent from every journal = an out-of-band write. Audit = **provenance** of mediated writes + **detection** of out-of-band. **NO permission split** — the injected token keeps `pull_requests:write`; contractors keep direct `gh` (`CHECKPOINT_2.md` §E.2). Audit is therefore **detection, not prevention**.
- [sub] Audit export command (`revu audit --pr 42 --since …`) over the host store for the client conversation.
**Verify:** exit criteria 2, 4 — a comment posted by revud appears in the journal with its GitHub id; a comment posted by a direct `curl` on the ambient token is flagged by the detector as absent from every journal.

### Issue M3.5 — Durable per-human state (host store, channel-keyed)
Host-side store keyed by the **channel-derived email** — a host-side `coder.owner`→email map (or Coder API at provision time), **never** workspace-claimed. `/home/coder` persists across stop/start (the volume covers rebuild); the host store covers **offboarding** + cross-workspace. Draft/viewed/prefs access is authorized by the **`coder.owner` binding**, NOT by a path `:email` parameter — drop the authorize-by-path shape (it lets any workspace read any human's drafts). At-rest/backup = ops-owned dependency (`CHECKPOINT_2.md` §E.4, §G), not a revu ticket.
**Verify:** exit criteria 3, 5 — a request for another human's drafts is refused on the `coder.owner` mismatch; a draft survives a simulated workspace rebuild via the host store.

### Issue M3.6 — Identity binding (push-only; no workspace→broker auth)
Re-framed for the push-only topology: there are **no** workspace→broker calls to authenticate. Identity = **`coder.owner` per container** (channel-authentic via the collector tick — the host knows which container it pulled from). **DROP** tailnet-source and mTLS (infeasible: workspaces are not tailnet nodes; Lima/Docker NAT collapses all workspaces to one source address; mTLS has no provisioning path). No inbound bearer needed. Git-config identity remains display-only; the `coder.owner` binding is the audit layer. Document the trust boundary as in guide §1 and `CHECKPOINT_2.md` §B.
**Verify:** the audit `workspace`/human field derives from the container the collector pulled from (`coder.owner`), never from any workspace-reported header or git config.

### Issue M3.7 — Host-side revu collector
The sandbox **adapter** (revu core stays generic): a host-side component beside the token broker that rides the existing 60s `docker exec` tick to pull each managed container's drafts + audit journal (`coder.owner`-bound), holds the `coder.owner`→email binding, owns the durable store, and drives the out-of-band-write detector. No listening socket; no workspace-callable surface.
**Verify:** the collector pulls a draft written in a container and lands it in the host store keyed by the channel-derived email; adding a container to the tick requires zero workspace-side revu configuration.

### Issue M3.8 — revud loopback bind + one-port serve + system-path packaging
revud binds **`127.0.0.1`** inside the container (the port-forward agent is co-resident, so loopback suffices; removes revu from the cross-container threat class on the shared docker bridge). Serve the SPA + API on **one** port reached via `coder port-forward --tcp` (path-based `coder_app` is broken for SPAs; port 3000 collides with Coder). Bake revud + built dist at a **system path** (`/opt/revu`) in the image — home-volume seeding happens once and never propagates updates; no revu state under `/home/coder` is authoritative.
**Verify:** an e2e assertion that revud is unreachable from a second container over the bridge; `coder port-forward --tcp` serves the SPA + API end-to-end on one mapping.

### Issue M3.9 — Offboarding retention/purge hook
On workspace delete (offboarding), the host store **retains audit rows** (compliance) and **purges drafts/viewed** (`CHECKPOINT_2.md` §E.5). Aligns host-side revu state with the operating agreement's wipe clause rather than the workspace lifecycle.
**Verify:** after an offboarding run for a human, their drafts/viewed are gone from the host store and their audit rows remain.

---

## Milestone M4 — Live layer + identity ground truth

**Goal:** the inbox becomes genuinely live and own-comment detection becomes exact. Completes `BrokerPullMeta`.

**Exit criteria:**
- Inbox reflects an upstream change (new PR, new commit, thread resolved on github.com) within one poll interval without any snapshot sync.
- `commentAuthors` present in broker-mode snapshots; M1.3's id-path exercised end-to-end.
- Reviewer assignment visible in inbox sections.

*CHECKPOINT_2 correction — `authorHumanId` is collector-populated:* revu does not create PRs (no `openPull`/`createPull`; contractors open PRs directly as the App via the injected token), so `authorHumanId` cannot come from a broker PR-creation log. M4.2 ships the in-workspace **seam** (a durable `pr_author` store + resolution into the poll meta); **population rides M6** (the collector, via the `coder.owner`↔PR correlation). `canApprove` derives independently from the bot login (`pull.user.login !== botLogin`) and needs no author join.

**Depends:** M3.

### Issue M4.1 — Poll loop
30s conditional poll (`If-None-Match`), per guide §2.1; on change, batched GraphQL refresh of unresolved counts / head / `compareKey` / `commitCount` for changed PRs only. `/v1/pulls` serves from this cache with broker-level ETag; revud passes 304s through to the frontend's existing polling.
**Verify:** an hour of idle polling costs ≤ a handful of non-304 requests (log-verified).

### Issue M4.2 — `BrokerPullMeta` completion
Completes the three list-level annotations on `BrokerPullMeta`: `authorHumanId`, `canApprove`, `assignedReviewerHumanIds`.

*CHECKPOINT_2 correction — revu does not create PRs:* the original premise ("`authorHumanId` from the broker's PR-creation log") is invalid under the inject model. revu is a review client — it has no `openPull`/`createPull` and never mediates PR creation; contractors open PRs directly as the App via the ambient injected token. PR-author attribution is therefore a **host-side collector concern** (only the M6 `docker exec` tick has the `coder.owner`↔PR correlation). So `authorHumanId` **population is deferred to M6**: M4.2 ships the in-workspace **seam** — a durable, first-write-wins `pr_author` store table (keyed by PR, `human_id` nullable for "org member opened it"), resolved into the poll meta through a narrow `getPrAuthor` read seam — proven in-gate with injected fake records; the collector populates it host-side via the `coder.owner`↔PR correlation. `canApprove` is derived **now, independently of any author join**, straight from the bot login: `canApprove = pull.user.login !== botLogin` (App-authored PR → the author login is the App bot login → `false`; org-member PR → `true`). This also lands the fix for M4.1's `canApprove` `true` placeholder. `assignedReviewerHumanIds` comes from a host-side `reviewers.yaml` (`REVU_REVIEWERS_FILE`, default alongside the SQLite store so it survives a workspace rebuild), re-read each poll tick so a lead's edit takes effect without a restart; a read/parse failure keeps the last-good map and logs a token-free warning (never echoing file bytes). The loader IS the record — there is no in-gate mutation API (the broker has no authenticated admin surface; an admin endpoint is out of scope).
**Verify (in-gate simulation):** inbox sections (yours-with-comments / assigned-to-you) populate correctly and disjointly for two different humans reading the same poll result — "yours" driven by `authorHumanId` (seeded via `recordPrAuthor`), "assigned-to-you" by `assignedReviewerHumanIds` (seeded via a temp `reviewers.yaml`). Truly-live two-human confirmation rides M6 (the collector); it is not claimed live-verified here.

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
Token custody paths; audit-log integrity (append-only, `coder.owner` channel binding from M3.6); what a hostile workspace can and cannot do — written up as one page for the client. Confirm (all HOLD under the corrected inject model — `CHECKPOINT_2.md` §F/M5.4): browser never sees a token (revud keeps it server-side in-workspace); audit identity binds to `coder.owner`, never workspace-claimed; drafts of human A unreadable via human B's session (authorized by the `coder.owner` binding, not a `:email` path param). **ADD the honest statement:** the ambient injected token carries `pull_requests:write`, so a contractor can post bot-identity comments directly, bypassing revu — the audit layer is **detection (the out-of-band-write detector), not prevention**.

### Issue M5.5 — Docs
Direct-mode README for general users (`bunx revud` quickstart); operator runbook (broker install, App creation from M3.1 sub-doc, audit export); CONTRIBUTING note that the mock is the permanent oracle.

---

## Milestone M6 — On-prem deployment

**Goal:** the sandbox specifics that cannot be proven off-prem (guide's deferral list), corrected to the real MINT-AND-INJECT topology (`docs/agent/CHECKPOINT_2.md` §B, §F). Executed on-site as a checklist; every technical unknown was retired in M2–M5.

**Depends:** M5.

### Issue M6.1 — Host-side revu collector deployment
Deploy the M3.7 collector beside the real token broker on the macOS host: launchd service, host SQLite location for audit/drafts. **At-rest/backup/FileVault are an ops-owned dependency** (`CHECKPOINT_2.md` §E.4, §G) — confirm the operator's backup + encryption plan for the audit log; it is not a revu deliverable.

### Issue M6.2 — Collector on the existing push tick (NO tailnet broker)
Wire the collector into the existing 60s `docker exec` tick to pull drafts + audit journals from each managed container (`coder.owner`-bound). **DROP the tailnet broker path entirely** — no `REVU_BROKER_URL=broker.tail<net>.ts.net`, no tailnet ACL for a broker port: workspace containers are NOT tailnet nodes (the tailnet terminates at the Mac) and container→host is Lima/Docker NAT that collapses all workspaces to one source address. There is no workspace→host listener; the collector reaches into containers from outside the VM, exactly like the token broker.
**Verify:** the collector pulls state from a container with no inbound surface exposed on the host; no workspace-callable revu port exists anywhere.

### Issue M6.3 — Coder template + image wiring
Bake revud + built dist at **`/opt/revu`** (system path — home-volume seeding never propagates updates); startup launches revud (serve `dist/`, never `vite dev`) **bound to `127.0.0.1`**; access via `coder port-forward --tcp` on one port (NOT a named `coder_app` — path-apps are broken for SPAs, no wildcard TLS; port 3000 collides with Coder). Confirm injected git identities parse (M1.2 charset) with the real username population.

### Issue M6.4 — Two-human end-to-end
The invariant proof: two contractors (two browser profiles / two workspaces), one PR, independent drafts, both submit, both stamped correctly, audit log distinguishes them, drafts survived a mid-test workspace rebuild for one of them.

### Issue M6.5 — Client acceptance
Walk the client's lead through: org-member review interleave on github.com, approve-on-github workflow for App-authored PRs (guide §2.1 gating), audit export (provenance + the out-of-band-write detector), and the exposure surface (revud loopback-bound, collector push-only, no workspace-callable listener). Sign-off closes the milestone.

### Issue M3.1 (deferred from M3) — Scratch App + org for org-member validation
Deferred here from M3 because it needs a real GitHub organization with ≥2 member accounts, which cannot be stood up off a personal development repo. Retains the stable `M3.1.x` IDs (Linear: UZO-575 + .1–.5). Its org-member interleave overlaps M6.5 (client acceptance) and its runbook overlaps M5.5 (operator runbook).
- [sub] Scratch GitHub App with the grant **byte-identical to the real one** (`contents:write` + `pull_requests:write` + `metadata:read` + `checks:read`; **NO webhooks**, poll-only); the sandbox App `revu-sandbox-app[bot]` already carries this grant.
- [sub] Scratch org + install the App; seed it mirroring the M2.1 scenarios (reuse `scripts/seed-scratch.ts`, idempotent).
- [sub] One PR opened by a **real org-member account** (distinct from the App) — the org-member interleave / `canApprove` proof.
- [sub] Per-RevuApi-method → App-permission matrix (verify `pull_requests:write` covers reviews, reply comments, resolve mutations, reactions; confirm issue-comment reads fit the grant) + the client-facing App-creation/permissions runbook.
**Verify:** on the real org, org-member comments interleave with genuine identity; `canApprove` is true on org-member PRs and false on App-authored ones; conformance passes against the scratch org; the permission matrix has no unverified rows.

---

## Milestone M7 — Open-source readiness: docs, README + repo cleanup

**Goal:** ready the repo for open-source release once the core product is proven end-to-end. A user-facing documentation pass plus repository hygiene: refresh the README to a modern standard (oil-oil/beautify-github-readme), ship a runnable/deployable Fumadocs docs site, verify every doc against the real implementation, and strip the repo of internal build-tracking and admin-harness artifacts so what remains is coherent for outside contributors and users. Post-implementation in spirit, but it splits by dependency: the **cleanup** half (M7.5–M7.7) runs strictly after the product works, while the **docs-authoring + setup** half (M7.1–M7.4) may begin as soon as the product *surface* is built (it now is) and runs in parallel with on-prem (M6) — see Depends / sequencing below. Distinct from M5.5, which ships the internal/technical direct-mode README + operator runbook + CONTRIBUTING note; M7 is the broader user-facing, public-readiness pass that consumes and polishes that material.

**Exit criteria:**
- Root `README.md` refreshed to the beautify-github-readme standard (hero → proof → what → why → how → use → detail; badges; real screenshots; accurate to shipped behavior, not the prototype "mockup" framing).
- A runnable, deployable Fumadocs 16 docs app (run with bun) exists as its own workspace package, isolated from `bun run check` and the CI gate; `docs:dev`/`docs:build` work; the site deploys.
- User-facing docs cover overview, quickstart, the three run modes, core flows, direct-mode setup, self-hosting revud, architecture, and reference — with imagery to the README's standard.
- Every documented claim, command, flag, endpoint, and keyboard shortcut verified against the implementation; no doc describes behavior the code doesn't have.
- Internal build-tracking docs retired (`docs/agent/MILESTONES.md`, `CHECKPOINT_1.md`, `branch-protection.md`); `INTEGRATION_GUIDE.md`/`AGENTS.md`/`DESIGN.md` reworked into public architecture/CONTRIBUTING/design docs; no `/Users/...` home paths remain in tracked files.
- `.claude/` admin harness removed from the public tree, its durable generally-useful content (product invariants, GitHub/API gotchas) extracted and scrubbed into public docs; session artifacts gitignored.
- Open-source hygiene in place: LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, `.env.example`, CODEOWNERS, issue/PR templates, README badges; a final secrets/personal-info sweep clean.

**Depends / sequencing:** the milestone splits by dependency. The **early-docs + setup chunks — M7.1 (media), M7.2 (README), M7.3 (Fumadocs scaffold), M7.4 (content)** — depend only on the *shipped product surface* (M2 direct + M3/M4 broker/live, now built), not on on-prem hardware, so they are pulled forward and run **before / in parallel with M6 (on-prem)**. They land as **one linear PR stack on top of the M4+M5 train tip** (not a fresh branch off `main`), so the docs and screenshots reflect the actual M4+M5 surface rather than a stale pre-M4 `main`; when the train merges down, the stack retargets base-up. The **accuracy and cleanup issues stay gated and run last**: M7.5 (accuracy pass) needs the doc surface frozen, and M7.6/M7.7 (retire the tracking docs + strip the `.claude/` harness) must not begin until the build is finished, because agents rely on `docs/agent/MILESTONES.md` and the `.claude/` harness throughout. Independent of M6 for delivery.

*Scope note:* this milestone is an addition beyond the original integration plan; it is seeded on Linear as milestone M7 (issues UZO-814–UZO-821, plus M7.9 / UZO-877 (docs theming) and M7.10 / UZO-883 (light mode) added later). M7.6 ultimately retires this document, so treat the M-IDs in code and commit messages as the durable cross-session anchor after the doc is gone.

### Issue M7.1 — Media & screenshot pipeline (shared visual assets)
The shared visual asset set that both the README (M7.2) and the docs site (M7.4) consume, to the beautify imagery standard. Capture is reproducible because mock mode (`?mock=1`) drives the whole app on deterministic fixtures with a fixed scenario/PR map; `scripts/shots.ts` is the starting point.
- [sub] Hero/banner SVG (1200-unit viewBox, self-contained background for GitHub light+dark, `<title>`/`<desc>`, system fonts, no `<script>`/`foreignObject`/remote fonts).
- [sub] Screenshots of the core surfaces on their best scenario PRs (inbox #101/#347, files workbench #204, review-bar draft rail, reconcile #389, conversation/threads #312, checks #362, author queue #347, command palette, dev panel, unified-vs-split, rate-limit chip).
- [sub] GIFs (opt-in; ~30fps, 4–6s, clean loop) of the comment `c` flow, suggestion-block splice, the full reconcile flow, and identity-switch draft isolation.
- [sub] Architecture diagram (SVG) of the `RevuApi`/revud/mode-strategy layering; store under one convention (`assets/readme/` or `docs/assets/`), lowercase-hyphenated.
**Verify:** the asset set is referenced by both README and docs; SVGs pass the beautify checks; screenshots match the shipped UI; GIFs loop within budget; `scripts/shots.ts` (or its successor) regenerates the deterministic screenshots from mock mode.

### Issue M7.2 — Refresh root README.md to the beautify-github-readme standard
Rewrite `README.md` (143 lines, prototype-framed) to the oil-oil/beautify-github-readme content sequence and visual system. Its "this is a mockup, not a working app" NOTE callout is now behind the code (direct mode talks to GitHub); it lacks a real-tool quickstart, a license, and a contributing pointer, and its architecture section describes only the mock layer. **Depends:** M7.1.
**Verify:** content order Hero → Proof → What → Why (mechanism: offline snapshot, draft, reconcile) → How it works → How to use (`bun install && bun dev`, then `revud --direct`) → detail → limits/license/contributing; the first-screen test passes; proof before claims; no "mockup" framing contradicting shipped direct mode; badges near the top; images centered `width='100%'` with meaningful alt; renders on GitHub light+dark and on a narrow viewport; every command runs as written.

### Issue M7.3 — Fumadocs 16 docs app (bun), gate-isolated + deployable
New workspace member `@revu/docs` at `packages/docs` running Fumadocs 16 with bun. Fumadocs 16 is Next.js-based and needs React 19, clashing with the app's React 18.3 — isolation is mandatory, not optional.
- [sub] Scaffold `@revu/docs` (Fumadocs 16); run/build with bun (`next dev`/`next build`); Next default port 3000.
- [sub] Gate isolation: own tsconfig NOT in the root `tsc -b` reference set; no `*.test.ts` under it (`bun test` globs the whole repo); add to oxlint ignore (`--deny-warnings`); pin `react`/`react-dom` exactly (bun overrides/nohoist) so React 19 never leaks into the app's Vite resolution.
- [sub] Deployability: root scripts `docs:dev`/`docs:build` (NOT part of `check`); `.next/`+`out/` gitignored; a deploy target wired/documented (docs is its own Next deployable, not served by revud); optional separate non-required CI job.
**Verify:** `bun run docs:dev`/`docs:build` work; `bun run check` and CI `check`/`e2e` remain green and unchanged; `bun run build:app` still resolves a single React; the docs site deploys.

### Issue M7.4 — User-facing documentation content (IA + pages)
Author the docs-site content against the information architecture, reusing existing prose (README "Why this exists" + constraints table; `DESIGN.md` token/palette; `INTEGRATION_GUIDE.md` §5/§6/§3.3; `docs/direct-mode-auth.md`) and the M7.1 imagery. Broker mode is reserved / not yet a boot option — label it, never describe it as shipped. **Depends:** M7.3, M7.1.
- [sub] Overview + Quickstart; Concepts (offline snapshot + seal, `compareKey`, content-addressed blobs, draft, reconcile, identity models, shared rate budget).
- [sub] Run modes (Mock/Direct/Broker deep dives); Guides/How-to (first sync, comment+suggest, submit, reconcile a moved head, author walk-the-queue, inbox triage, mark viewed, react).
- [sub] Keyboard & navigation (full catalog + command palette); Direct-mode setup (`gh` scopes, repo resolution, local SQLite draft store, scratch seeding).
- [sub] Self-hosting revud (env `REVU_MODE`/`REVU_PORT`/`REVU_REPO`/`REVU_DIST_DIR`/`REVU_DATA_DIR`, serving built `dist/`); Architecture & reference (`RevuApi` route table, `TokenSource`/`WriteDecorator`, sync burst budget, mock-as-oracle) + a Design page.
**Verify:** each section renders; navigation/search work; imagery displays on light+dark; no reserved (broker) feature is shown as shipped (final accuracy proof is M7.5).

### Issue M7.5 — Verify all docs against the implementation
Adversarial accuracy pass over the README (M7.2) and the docs site (M7.4): every documented claim, command, flag, env var, route, keyboard shortcut, and mode behavior traced to code and confirmed or corrected. **Depends:** M7.2, M7.4.
**Verify:** the highest-risk claims hold — direct-mode auth is the `gh` user (not the App); broker mode is reserved; `/api/dev` is mock-only; `submitReview` `head_moved` is a 200 value; `getSnapshot` returns `null`, not 404-as-error; drafts survive everything and are deleted only on confirmed submit success. Each doc statement is tied to a code referent; commands execute as written; the gate is green; a short report lists corrections.

### Issue M7.6 — Retire/rework internal repo docs for open-source
Once M7.4 has absorbed the valuable technical content, retire the build-tracking and agent-framed docs so the public tree is coherent. **Depends:** M7.4.
- [sub] Delete `docs/agent/MILESTONES.md`, `docs/agent/CHECKPOINT_1.md`, `docs/branch-protection.md` (fold the one `gh` command into CONTRIBUTING if useful).
- [sub] Rework `docs/agent/INTEGRATION_GUIDE.md` into a public architecture reference + operator runbook (strip the "for agents / order of work" framing).
- [sub] Convert `AGENTS.md` → `CONTRIBUTING.md` (keep the TS style, visual-token rules, data rules, and the `bun run check` gate; drop the agent file-ownership model, "complete output only", and the hardcoded `/Users/patmw/...` path on line 12).
- [sub] Edit `DESIGN.md` (keep the token plan, diff-palette reasoning, and risk; strip the taste-router/agent-convention lines and the `/Users/patmw/...` path on line 6); rewrite `docs/README.md` into a clean index; keep `docs/direct-mode-auth.md` with a reframed title.
**Verify:** `grep -rn "/Users/patmw" .` is clean across tracked files; no `docs/agent/` tracking artifacts remain; the valuable technical content survives in public form; the gate is green.

### Issue M7.7 — Remove/scrub the .claude/ admin harness for open-source
`.claude/` is the repo-admin session harness (the `revu` skill, `LINEAR_PROTOCOL.md`, memories), tied to the private Linear workspace, scratch GitHub App coordinates, and agent conventions meaningless to outside contributors. Extract its durable, generally-useful content (scrubbed), then remove it. **Depends:** M7.6.
- [sub] Extract product invariants (`memories/hard-constraints.md`) → a public architecture-constraints doc (drop the M-/C-IDs and CHECKPOINT references).
- [sub] Extract GitHub/API + bun-test + e2e gotchas (`memories/known-landmines.md`) → a public gotchas/contributor doc (drop the App id/installation, the scratch-repo guard, and the `UZO-`/CHECKPOINT references).
- [sub] Remove `.claude/skills/revu/` + memories from the tracked tree (or relocate privately); gitignore transient `.claude/` session artifacts.
**Verify:** the scrubbed content is present in public docs with no internal Linear URLs, App/installation ids, or tracking ids; the harness no longer ships publicly; `.claude/` transient artifacts are gitignored; the gate is green.

### Issue M7.8 — Open-source hygiene scaffolding + final secrets sweep
Add the standard open-source files the repo currently lacks, then run a final sweep.
- [sub] LICENSE (owner-chosen) + a README license badge/section.
- [sub] CONTRIBUTING.md (from M7.6 if produced there), CODE_OF_CONDUCT.md, SECURITY.md (disclosure policy + contact).
- [sub] `.env.example` documenting every referenced env var (`VITE_REVU_API`, `REVU_DATA_DIR`, `REVU_DIST_DIR`, `REVU_PORT`, `REVU_REPO`, `REVU_MODE`, `GH_TOKEN`, `GITHUB_TOKEN`, `E2E_CHROME_PATH`).
- [sub] CODEOWNERS, `.github/ISSUE_TEMPLATE/*`, a PR template; a README CI-status badge.
- [sub] Final secrets/personal-info sweep (only fake `gho_*` test fixtures expected; no `/Users/...` paths; no personal email in tracked files).
**Verify:** all hygiene files are present and linked from the README; `.env.example` covers every env var read by code/tests; the sweep is documented clean; the templates render in the GitHub UI; the gate is green.

### Issue M7.9 — Theme the Fumadocs docs app to match the web app (fonts + colors)
Theme `@revu/docs` so the documentation site reads as the same product as the web app, via Fumadocs 16's design-token system (fumadocs.dev/docs/ui/theme). The M7.3 scaffold ships the default Fumadocs look; this maps the app's `packages/app` `globals.css` palette (canvas/ink/add-teal/del-rust/draft-violet/stale-gold) onto the `--color-fd-*` tokens — draft-violet, the app's thesis colour, as the primary — and wires the three faces (Iosevka for code, Atkinson Hyperlegible for body, Archivo for display) self-hosted via the same `@fontsource` packages, with no remote fonts. Dark-first to match the dark-only app; the docs lock to dark. **Depends:** M7.3 (scaffold); best applied after M7.4 (real pages to theme). Added as scope growth within M7 (owner request).
**Verify:** `bun run docs:build` green; the site's colours and fonts visibly match the app; `bun run check` and the required CI jobs remain untouched and green; the root `bun.lock` is unchanged (theming stays inside the gate-isolated `packages/docs`); no remote-font/network dependency; no `/Users/…` paths.

### Issue M7.10 — Light mode: app light palette + docs light/dark (+ branding, redirect)
Add a real **light mode** to the web app — reopening the DESIGN.md dark-only decision — and make the docs support light/dark to match, **superseding M7.9's dark-lock**. The app gains a full light variant of every `packages/app` `globals.css` token (warm `#F4F2EA` canvas, `#26261F` ink, teal `#0F7D63` / rust `#B64A17` add/del re-derived for light, draft `#6741CF`, stale `#8A6D10`, diff-tint alphas re-derived), an identity-menu toggle + `mod+shift+l` shortcut persisting via the prefs store (a new `theme` field, migration-safe via the `DEFAULT_PREFERENCES` merge on both the app and revud stores), a no-flash boot script, and a co-designed light Shiki syntax theme. DESIGN.md documents the two schemes. The docs mirror the same palette with a working switcher, plus the `revu·docs` wordmark (Archivo + violet dot), favicon/metadata matching the app, and a `/`→`/docs` redirect. **Depends:** M7.9 (docs theme), M7.3. Added as scope growth within M7 (owner request).
**Verify:** app + docs both render correct light AND dark (the toggle flips background + foreground together, no flash, diff/syntax legible, draft-violet + stale-gold read) and match each other; `bun run check` green (873 pass / 1 skip / 0, the app change is in-gate, prefs migration-safe + conformance-green); `bun run docs:build` green; `/`→`/docs` (307); root `bun.lock` unchanged.

---

## Milestone M8 — Local-only reviews (pre-PR branch review)

**Goal:** review a local git branch against a base branch **before** any pull request exists, with the full revu review workflow, and with nothing ever sent to GitHub. Training feedback on a real client codebase stays inside the contractor's workspace; the client repo learns nothing until a PR is deliberately opened. A secondary and equally real outcome: the review pipeline stops depending on GitHub at all — a local review needs no token, no network, and no `origin`.

**Live tracking for this workstream is the local board at `.claude/workstreams/m8-local-reviews/`** — `BOARD.md` for current state, `HANDOVER.md` for the cross-session handover, and one file per ticket under `tickets/` carrying its units, its Verify, and verified code anchors. The sections below are the seed text those files were built from; the board is what changes as work lands.

A landing audit run on 2026-09-02 (`.claude/workstreams/m8-local-reviews/AUDIT-2026-09-02.md`) read every ticket, design section and exit criterion against the code on the stack tip and produced the close-out tickets M8.13–M8.17; M8 closes only once M8.17's Verify has actually been run.

Full design, including the surface map and the decision record, is `docs/agent/LOCAL_REVIEWS.md`. The shape in one line: **one new snapshot producer and one new write sink**, plugged into machinery (`anchor.ts`, `reconcile.ts`, `blobs.ts`, the two-half cache, the store's per-human halves) that is already provenance-blind.

**Decisions carried by the design doc** — D1 archive-on-PR (never publish local comments); D2 reserved high-number identity at the contract level; D3 committed content only + dirty-worktree warning; D4 the reserved band never enters `snapshots.pr_number` / `audit_log.pr` / `pr_author.pr` (the store gets its own `local_*` tables); D5 a capability inside direct/broker mode, not a fourth mode; D6 the mock specifies it first; D7 the local write path has no GitHub client in scope; D8 local reviews use the live base tip where PRs use GitHub's stale `pull.base.sha`.

**Exit criteria:**
- A local review can be created from a branch + base pair, in a repo with **no GitHub remote, no token, and no network**, and the full review loop works: sync → inline comments → draft → submit → threads → reply → resolve.
- Re-syncing after new commits, an amend, and a rebase all keep drafts alive and classify them through the existing reconcile flow; a rebase never mass-classifies comments as `lost` through unreachable objects.
- No local comment, thread, review, or reaction ever reaches GitHub — enforced structurally (no GitHub client in the local write path), and asserted by a test that fails if one is introduced.
- No synthetic id is ever written to `snapshots.pr_number`, `audit_log.pr`, or `pr_author.pr`; the host collector's and poll loop's view of "PR #N" is unchanged.
- Conformance is green over a local-review leg in every transport (mock in-process, revud-mock HTTP, direct); `bun run check` + e2e green.
- No GitHub-flavored affordance renders on a local review: no Checks or Description tab, no rate-limit cost copy, no "approves on github.com" lock, no "posted in one API call" toast.

**Depends:** M2 (the direct sync engine, store, and reconcile this reuses). Independent of M3–M6 — it needs no broker, no collector, and no on-prem hardware. Deliverable in parallel with M7's docs track; if both land, M7.4's run-modes content gains a local-review page.

### Issue M8.1 — Contract additions + the mock as the spec
The mock is the permanent oracle, so local reviews are specified there first and revud conforms. Adds the id bands to `packages/shared` and the smallest possible surface extension to `RevuApi` (branch listing + create/list/delete of local reviews); every existing method keeps its signature.
- [sub] `LOCAL_REVIEW_ID_BASE` / `LOCAL_ENTITY_ID_BASE` / `isLocalReviewId` in `packages/shared`, with the band-disjointness argument as tests (GitHub PR numbers, GitHub comment ids, the mock's 700M band, optimistic negatives).
- [sub] Contract extension: `listBranches`, `createLocalReview`, `listLocalReviews`, `deleteLocalReview`; new routes using only the allowlisted `:n` param so the route-param invariant test passes unamended.
- [sub] Mock implementation: synthetic `PullDetail`/`GhUser`/`ReviewSummary` shapes, local threads, local submit; a fixture local review reachable under `?mock=1`.
- [sub] Validators for the new payloads; ref-name validation shared with the daemon.
**Verify:** the existing conformance suite is green unchanged; a new local-review scenario walks create → sync → comment → submit → reply → resolve entirely in the mock; `?mock=1` demos it with no network.

### Issue M8.2 — Store v4: `local_*` tables
Additive migration in the existing doctrine — `CREATE TABLE IF NOT EXISTS` only, no row rewritten, no primary key altered (SQLite cannot alter a PK without a rebuild, which the doctrine forbids).
- [sub] `local_reviews` (with `UNIQUE(repo, base_ref, head_ref)` and `MAX(id)+1` minting), `local_snapshots`, `local_threads`, `local_reviews_submitted`, `local_drafts`, `local_viewed`; `immutables` and `blobs` reused untouched.
- [sub] `STORE_VERSION` 3→4 guarded step; a v3 file opens, migrates, and keeps every existing draft.
- [sub] Draft isolation extended to `local_drafts`: `(human_id, local_id)`, `human_id` taken from the session and overwritten on write.
- [sub] Typed store errors on the local tables (present-but-corrupt ≠ absent), matching the existing `StoreUnreadableError` / `StoreWriteError` behavior.
**Verify:** a v3 database migrates in place with drafts intact; the draft-isolation test suite passes against the local tables (a spoofed `humanId` lands under the session id); `audit_log` and `pr_author` are provably untouched by any local operation.

### Issue M8.3 — Local snapshot builder (git-only)
A sibling of `fetchImmutable` that produces the identical `SnapshotImmutable` from one clone. Replaces `GET /pulls/{n}` + `GET /compare` with `git rev-parse` + `git merge-base`, and the files/tree/commits calls with `git diff --raw -M` + `--numstat` + `-U3` + `git log`.
- [sub] Ref resolution and merge-base computation against the **live base tip** (D8), with typed errors for unrelated histories, shallow clones, and missing refs.
- [sub] `git diff --raw -M` → `files` + `blobIndex` (both sides' SHAs in one command, no file cap, no tree truncation); `--numstat` counts; `-U3` patches; reproduce the "absent patch means binary or oversize" convention and the NUL-byte binary heuristic.
- [sub] `git log` → `CommitInfo[]`; synthesize `PullDetail` per the design's field table.
- [sub] `provisionBlobs` gains a local-only flag so the GitHub tier is unreachable, not merely unused; submodule (160000) and symlink (120000) entries skipped or explicitly marked.
- [sub] Dirty-worktree detection via `git status --porcelain`, recorded on the review (D3).
- [sub] Ref-name hardening: normalize to `refs/heads/…`, pass `--`, validate with `git check-ref-format` — a ref beginning with `-` is read by git as a flag and nothing validates command arguments today.
**Verify:** against a seeded local repo, the built snapshot's `files`/`blobIndex`/`commits` match what the GitHub path produces for the same commit range; a branch with a renamed file, a binary file, a submodule, and a symlink all classify correctly; a ref named `--upload-pack=…` is rejected rather than executed.

### Issue M8.4 — Local write sink
Local implementations of the four write verbs, in a module with **no GitHub client in scope** (D7). Each returns a complete, well-formed value — the app's optimistic mutations copy fields back out of the response, so a stub that returns the old value makes an optimistic update silently revert.
- [sub] `submitReview`: local head guard via `git rev-parse` → materialize each `PendingComment` into a local `ReviewThread` (locally minted thread id, positive comment ids) + a local `ReviewSummary`; draft deleted only on confirmed success. `head_moved` stays a 200-level value; the idempotency re-check and the 422 path are dropped as having no local analogue.
- [sub] `replyToThread` / `resolveThread` / `addReaction` returning full normalized values.
- [sub] No stamping: `prefixBody` is skipped and the real `Human.id` is stored on the comment; the two latent optimistic-path bugs (unconditional stamping in the synthetic reply, empty-login attribution on resolve) are not inherited.
- [sub] Verdicts (`COMMENT`/`APPROVE`/`REQUEST_CHANGES`) kept as local training verdicts with `canApprove` true.
**Verify:** a test asserts the local write module imports no GitHub client and fails if one is added; submit materializes threads the UI can render; resolve/react round-trip through the optimistic path without reverting; a draft survives every non-success outcome.

### Issue M8.5 — Daemon wiring: dispatch, routes, `listPulls`, boot relaxation
Local reviews are a capability inside direct/broker mode (D5), dispatched on the id band.
- [sub] Dispatch in `direct-api` / `direct-router`: `isLocalReviewId(n)` routes sync, snapshot, threads, drafts, viewed, reconcile, and the writes to the local implementations; everything else is unchanged.
- [sub] Create/list/delete routes wired to the store, with ref validation shared with M8.3.
- [sub] `listPulls` merges local reviews into the list (direct mode currently 501s it) with a `compareKey`-derived ETag and a synthetic `RateLimitInfo`.
- [sub] Boot relaxation: a repo with no github.com origin and no token still starts and serves local reviews; GitHub-only surfaces degrade honestly rather than blocking startup.
**Verify:** `revud` starts in a repo with no remote and no token, creates a local review, and drives the full loop over HTTP; a GitHub PR in the same daemon is unaffected; the `/api/dev` mock-only gate and the 501 gates are unchanged.

### Issue M8.6 — App: creation flow + inbox surface
The only genuinely net-new UI in the milestone.
- [sub] Create dialog: local branch picker + base picker (local branches and remote-tracking refs), title defaulting to the head branch, duplicate creation returning the existing review.
- [sub] `Local reviews` inbox section above `Waiting on you`; a row variant that shows `base ← head` instead of `#number`, plus dirty-worktree and superseded badges.
- [sub] Entry point in the inbox header row beside the List/Tree control; one command-palette entry in the **Go** group; optional chord registered in the shortcut catalog.
**Verify:** a local review can be created, opened, and found again from a cold load; the tree view does not mis-parent local reviews; the palette entry is discoverable and the `?` sheet documents any chord.

### Issue M8.7 — App: local-mode chrome + copy correctness
A `mode: 'github' | 'local'` derived once from `isLocalReviewId` and threaded through the PR chrome, following the established "omit the group entirely rather than render it empty" precedent.
- [sub] Tab set: omit **Checks** and **Description**; keep Files, Conversation (threads only), Commits. Suppress the author banner and the "isn't in this installation" 404.
- [sub] Header + seal variant: `base ← head` and a `local` seal in place of `#347`; sync copy without request-budget estimates.
- [sub] Review-bar variant: no `canApprove` lock popover naming an org member who "approves on github.com"; no "posted in one API call" toast; no "saved on the broker" framing.
- [sub] Suppress the rate chip and the shared-bucket estimate on local reviews; sweep the remaining GitHub-asserting strings.
**Verify:** no local review renders a Checks or Description tab, a rate cost, an approval instruction, or a claim that anything was posted; the reconcile and staleness vocabulary still renders (it is correct as-is); a real PR's chrome is byte-identical to before.

### Issue M8.8 — Re-sync, rebase safety, and object pinning
The edge case most likely to produce "everything is lost" for no visible reason.
- [sub] Pin each synced snapshot's merge-base and head under `refs/revu/reviews/<id>/<compareKey>` so a later `git gc` cannot delete the objects anchoring resolves against.
- [sub] Rebase/amend detection: `draft.headSha` absent from `commits` is reported as "the branch was rewritten" rather than falling silently to the author-date heuristic, which under-reports because a rebase preserves author date.
- [sub] Graceful "objects missing, re-sync to rebuild" state where a dangling reference is a hard unreadable error today.
- [sub] Deleted/renamed head or base → typed `not_found`, review read-only, drafts and threads preserved.
- [sub] Base-advance behavior under D8 surfaced honestly (a local `compareKey` can change with zero new head commits).
**Verify:** after `git gc --prune=now`, a rebased branch still reconciles its draft with no comment lost to a missing object; a rebase reports a rewrite rather than an under-counted "N new commits"; deleting the head branch loses no draft.

### Issue M8.9 — Archive when a PR appears (D1)
- [sub] Detection on repo + head ref + base ref, comparing `head.repo.full_name` so a fork's identically named branch does not match.
- [sub] Archived state: read-only, threads/drafts/history preserved, a link to the PR; a PR closed without merging does not un-archive.
- [sub] Inbox and chrome surfacing of the superseded state.
**Verify:** opening a PR for a locally reviewed branch archives exactly that review and no other; the archived review still renders its threads; nothing is copied to the PR.

### Issue M8.10 — Retention and GC
The first `DELETE` this store grows beyond `deleteDraft`. A constantly rebased branch mints a fresh `compareKey` per sync and orphans the previous immutable half forever.
- [sub] Delete a local review: its rows, its pinned refs, and its snapshots.
- [sub] Prune immutables unreferenced by any snapshot (local or PR), leaving content-addressed blobs alone or pruning them under the same rule.
- [sub] Bound the growth introduced by re-sync churn and document the policy.
**Verify:** deleting a local review leaves no orphan rows and no pinned refs; the prune never removes an immutable half a live snapshot references; a PR snapshot is never collaterally affected.

### Issue M8.11 — Conformance leg, e2e, and docs
- [sub] A local-review leg in the conformance matrix, green in mock in-process, revud-mock HTTP, and direct.
- [sub] An e2e that creates a local review and drives create → sync → comment → submit headlessly, asserting zero GitHub requests.
- [sub] Docs: the local-review flow in the user-facing docs and the run-modes page; `docs/security-review.md` gains the statement that local reviews are deliberately invisible to the audit trail because they are deliberately invisible to the client.
**Verify:** `bun run check` + e2e green; the conformance matrix has no skipped local leg; the e2e asserts zero outbound GitHub requests for the whole local flow.

### Issue M8.12 — Delete confirmation for a review holding a draft
Added to the board after the owner's ruling of 2026-08-19, closing a gap M8.6 and M8.10 both left implicit: deleting a local review that holds an unsubmitted draft is refused server-side while any human's draft holds text — the daemon is the authority, not the client — and the app needs a confirmation surface for that refusal instead of a bare error. There is no force flag: confirming discards the reader's own draft through the draft store's own path and only then repeats the same, unchanged delete.
- [sub] Refusal copy: a one-sentence mapping of the typed refusal, in the established one-honest-sentence-per-error shape, that never claims text is destroyed and never says "lost".
- [sub] The confirm dialog: a portal-free body naming the review by its `base ← head` pair (never its number), the destructive control on the red treatment and not the default focus.
- [sub] Wiring: an unforced delete attempt surfaces the refusal as the dialog rather than a toast; confirming discards the draft then retries the delete; dismissing changes nothing, because the refusal happens before any record is touched.
**Verify:** create a review, save a draft, delete without confirming → refused, review still listed; confirm → draft discarded and the review deleted, gone from the list, its draft unreachable under its own key.

### Issue M8.13 — Local reviews: staleness, read-only after a vanished branch, rewrite honesty, and the small behaviour fixes
The 2026-09-02 landing audit found the local-review feature complete and the gate green, and found a short list of places where a local review's runtime behaviour diverges from something already written down — a mock docstring (the mock is the specification), a guide sentence, or a message naming a remedy — so no owner ruling stands between reading the gap and closing it.
- [sub] Serve the local list row's compare key, head SHA and commit count from live ref tips, as the mock's docstring already specifies, instead of from the last-synced snapshot — so a review can go stale before a Re-sync.
- [sub] Pin the sentence the base-advanced seal's tooltip shows, as one exported constant.
- [sub] Refuse all four write verbs, not only submit and reply, after the head branch is deleted or renamed, and show a read-only banner naming the vanished ref.
- [sub] Count commits-since-the-draft by SHA position rather than author date in the files-tab badge and the author queue counter, so a rebase (which preserves author dates) is counted correctly.
- [sub] Order the inbox's local section by whether it holds an open row rather than by row presence, so an all-archived local section drops to the bottom as the guide promises.
- [sub] Warn in the daemon log when a sync's ref-pin write fails, so a lost collection guarantee is no longer silent.
- [sub] Refetch the branch listing every time the create dialog opens, instead of only past a ten-second staleness window that no longer matches the dialog's lifetime.
- [sub] Make the create dialog's title field replace the pre-filled branch name on the first keystroke instead of appending to it.
- [sub] Rebuild a re-sync over a corrupted snapshot envelope or immutables row, so "Re-sync to rebuild" is a remedy that can actually run.
**Verify:** both live-row legs (head moved; base advanced with the head standing still) and the vanished-ref refusal are green on every transport with independently computed literals; conformance legs E/F/G carry both new cases; a `?mock=1` walk corroborates the seal going stale, the branch-gone banner, the reordered inbox section, the refetching create dialog and the title field.

### Issue M8.14 — Proof debt: every missing, vacuous or misplaced test the audit found
The landing audit found the feature's behaviour sound almost everywhere and found the proof missing in specific, named places — two majors that survived a three-lens refutation, dozens of minors whose remedy the audit itself named as a test or a control, and Verify items three tickets honestly recorded as partially-proven. Scope is tests, controls and test harness only; a handful of units move code with no behaviour change so a sequence becomes drivable, and one unit changes the mock (the contract's specification) under an owner ruling.
- [sub] A real-mock reconcile parity leg for a draft whose head SHA fell out of the compare, driven against two producers rather than a transcription.
- [sub] A new-commit → re-sync → reconcile walk on a local review, discriminating the slice branch from a rewrite branch by an independent literal.
- [sub] A real `git rebase` fixture onto an advanced base, so pin survival is proven against genuinely collectable objects rather than an amend that keeps every blob reachable.
- [sub] Scope the no-deletion source scan to the `performSync` closure it is meant to guard, rather than the whole file that also contains two legitimate deletes.
- [sub] Graph-walk `local-surface.ts` in the write-isolation test, asserting the one legitimate GitHub-module edge as a literal path rather than leaving the file uncovered.
- [sub] Boot the real daemon with a GitHub half wired and drive all four local writes, proving the client is never entered on a local id.
- [sub] Wrap `Bun.fetch` in the same guards as `fetch`, and pin statically that no source calls it directly.
- [sub] Clear `GH_TOKEN`/`GITHUB_TOKEN` from the serve suite's spawned child environment.
- [sub] A positive control that the serve suite's fetch tripwire actually loaded in the child process.
- [sub] Replace the decorative `requests === 0` assertion with evidence that can actually fail.
- [sub] Read `audit_log`/`pr_author` directly for a local id after a real local write, as a redundant, direct proof beside the store's own tripwire sweep.
- [sub] Run the collector and the poll loop over a store that also holds local reviews, and assert their view of a real PR is unchanged.
- [sub] Document and pin the sweep guard's three-table scope, with a control proving the excluded pair is covered elsewhere.
- [sub] Assert `mutable.checks` is `[]` on a local snapshot on every transport.
- [sub] Pin that the local write path cannot raise the `conflict` code, by a whole-file scan with a positive control.
- [sub] Sync a remote-tracking base ref to a successful snapshot with real git, not only the existing failure leg.
- [sub] Assert a synced local snapshot's committed content ignores an uncommitted worktree edit.
- [sub] Pin on three transports that re-creating an already-archived branch pair returns the archived review, never a new live one.
- [sub] Pin that the daemon's delete refusal names no review id, matching the mock's existing rule.
- [sub] Register the direct-engine local-delete runner as its own required conformance-matrix leg.
- [sub] Pin that the matrix runner exits 1 and names a skipped or failed required leg, rather than passing silently.
- [sub] Run the shared local-review suite over HTTP against a booted `--local-only` direct daemon *(runs only under the owner's ruling on Open question 3(a))*.
- [sub] Give the mock a way to stand behind a real compare so legs E and F exercise the diff-content assertions *(runs only under the owner's ruling on Open question 2(a))*.
- [sub] Retarget the dead `normalizeRef` rejection table at the production ref validator, and delete the unreachable seam.
- [sub] Add the `@ts-expect-error` row proving `DraftHead`'s paired fields cannot be set independently.
- [sub] Lift the reconcile-apply sequence into a drivable function and pin the head move strictly before submit on a conflict-terminated apply.
- [sub] Drive `useResolveThread`/`useAddReaction` end-to-end against the local sink's actual returned values.
- [sub] Render `RowBadges` with `dirty: true` and assert the worktree-dirty badge actually appears.
- [sub] Dispatch `base_defaulted` in the create-dialog reducer tests and pin its preselection-not-override rule.
- [sub] Rename a mis-named inbox-sections test to what it actually asserts.
- [sub] Pin that the header banner stack orders the dirty-worktree banner before the author banner.
- [sub] Extract and pin `RateChip`'s `rateAvailable` derivation as a pure function.
- [sub] Pin the mode argument at three presence-only gates, walking call sites rather than listing them.
- [sub] Drive the command-palette Go entry and the `g l` chord for a new local review in the e2e.
- [sub] Drive the create dialog's key-swallowing (`j` blocked while open, restored once closed) in the e2e.
- [sub] Drive the delete dialog — open, cancel, confirm — end to end in the e2e.
- [sub] Extend the `?mock=1` e2e segment with a create and a hard reload, proving zero network requests survive both.
**Verify:** every named test file green with its red observed first and recorded in a falsification ledger; `bun run conformance:matrix` exits 0 with the ruling-dependent legs matching the owner's answers; `bun run test:e2e` exits 0 over both drivers; the gate's pass count moves up and nothing moves down; a diff against the branch's own stack-parent base (never `main`) touches only the explicitly allowlisted non-test files.

### Issue M8.15 — Owner rulings with their implementing units
The landing audit found twelve questions that need a decision before code, each a place where two agents could land opposite behaviour with nothing going red because the behaviour was never decided. For each question this ticket writes both answers as complete, executable units; the owner strikes one before the other starts.
- [sub] Question 1 (M8.9 OQ10) — a draft on an archived review: refuse the write and hide the gutter composer, or keep it writable and pin that the guide says so.
- [sub] Question 2 — what bounds a live review's pin set: accept the two-refs-per-resync growth and document it as accepted, or prune stale pins after a successful sync.
- [sub] Question 3 — deleting an archived review: leave it allowed (pinned on three transports), or refuse it and teach the app the refusal.
- [sub] Question 4 (M8.8 OQ2) — the reconcile change that also reaches the pull-request path: record the sign-off, or revert the PR-path change with a test.
- [sub] Question 5 (M8.11 OQ3) — `local-scenario.test.ts`: keep it as the mock-armed tripwire, or collapse it into the shared conformance runner.
- [sub] Question 6 (M8.3 OQ3) — a live byte-level parity leg against real GitHub: rule it out as unnecessary given the structural leg, or write the committed runner.
- [sub] Question 7 — D3's `dirty` flag in the mock: make `dirty: true` reachable with a conformance case, or rule the mock's `dirty` permanently false and record why.
- [sub] Question 8 — the runbook's operator blob-reclamation flag: wire `REVU_RECLAIM_BLOBS` at boot, or reword the runbook to match what ships.
- [sub] Question 9 (M8.5 OQ6) — `bin/revu`'s local path: keep deferring it, recorded on the board, or ship it.
- [sub] Question 10 — renaming a mis-titled local review: no rename verb, pin the "set once" hint and fix the title field's append bug, or add a rename verb to the contract.
- [sub] Question 11 (M8.9 OQ2) — where the sync-cost caveat lives: in the live-review sync copy, or left to the guide alone with the narrowing recorded.
- [sub] Question 12 (M8.3 OQ5) — the `C → added` rename mapping: keep it as recorded, or pass `-C` so the mapping becomes reachable and pin it.
**Verify:** exactly one unit of each pair survives, marked struck at its source open question; each kept unit's Check run with its red or its control observed and reverted byte-for-byte; `bun run conformance:matrix` green on A/B/E/F/G; the mock's local conformance leg moved by exactly the cases the kept units added; `?mock=1` walks corroborate the archived gutter, the dirty badge and the create dialog's title field; `docs:build` green and the design doc, the guide and the board agree on every ruled question.

### Issue M8.16 — Docs, design doc, guides, runbook and board: every stale sentence
The landing audit read every ticket, design section and user-facing page against the tree and found no code defects — only sentences written before a ruling, an owner call or a measurement, and never revisited after the code moved under them. Each unit names the file, quotes the stale sentence and states its replacement; the only non-prose changes are one self-contained comment in `index.ts` and one new gate test guarding present-tense claims in the guides.
- [sub] Amend the design doc's schema, minting and eviction sections to the landed `generation` column, the durable high-water-mark minter, and the eviction paths M8.10 shipped.
- [sub] State the `-uno` (untracked-file-excluded) qualifier on the dirty-worktree detection in the design doc, the schema comment and the guide.
- [sub] Say "direct mode alone", not "direct and broker mode", in the design doc, both decision records and the `index.ts` comment — broker mode builds no local surface today.
- [sub] Correct §5/§5.1's absent-client claim, the real two-ref-per-compare pin naming scheme, and the re-sync-refusal-on-missing-objects behaviour.
- [sub] Correct §4.1's `etag` and `rateLimit` synthesis-table rows to what each transport actually composes.
- [sub] Fix three one-line inaccuracies: the board pointer, the two routers' actual id-band gates, and the query-key count.
- [sub] Move §8's unrelated-histories and shallow-clone cases from Creation to Re-sync, matching that creation resolves no SHAs.
- [sub] Add the path-keyed repository identity caveat — a review created before an `origin` existed is never archived — to the guide and to `direct.mdx`.
- [sub] Reword or verify the guide's "can go stale" staleness claim against whatever M8.13.1 actually shipped.
- [sub] Verify the guide's "drops below" inbox-ordering claim against whatever M8.13.5 actually shipped.
- [sub] Add the operator runbook's one residual fact — pinned refs live in the shared git dir and are visible from every linked worktree — once M8.15's pin and blob-flag rulings have landed.
- [sub] Add a security-review paragraph on pinned refs: real refs, invisible to an ordinary push, and what a mirror-push would and would not disclose.
- [sub] Annotate M8.1's settled Open question 5 with the owner's later delete-boundary supersession, without rewriting the original record.
- [sub] Correct M8.4's Check literals (the eleven-key port set, the five-file scanned set) and its now-false "forbidden is unreachable" claim.
- [sub] Restate M8.7's zero-diff corroboration as a commit-range claim, since two later commits have since touched the same files.
- [sub] Record M8.8's Verify clauses 6 and 8 as run, and clause 7 (real-mock parity) as open until M8.14.1 lands.
- [sub] Record the broker archive-seam's true evidence status in M8.9's Log (direct wiring corroborated live, broker wiring inert by construction), and stand down on OQ2 in favor of M8.15's question 11.
- [sub] Correct M8.10's Verify Log to say what its "unedited" file actually gained (eight `unexpected(...)` stubs, no behavioural line).
- [sub] Rewrite M8.12's unit text to the no-force ruling that shipped, and add the Landmines section it never had.
- [sub] Replace the `MILESTONES.md` M8.12 gap with a pointer noting the seed is owed, ahead of the real mirror step.
- [sub] Amend exit criterion 6 in both milestone records to carry the workspace-scoped rate-chip deviation (ruling R2).
- [sub] Add the board follow-ups this audit surfaces: `bin/revu`'s deferred local path, the `MILESTONES.md` seed debt, and the guides' missing gate guard.
- [sub] Add the smallest gate guard that catches copy drift between the product's own UI strings and what the guides quote them as.
- [sub] *(alternative A, taken only if M8.15 keeps the archived-draft refusal)* mirror the withheld-composer wording into `direct.mdx`.
- [sub] *(alternative B, taken only if M8.15 keeps the writable archived draft)* mirror the writable-draft wording into `direct.mdx` instead.
**Verify:** `bun run docs:build` green; the security-review and guide-claims guards both green with their red obtained by control; a diff against the branch's stack-parent base touches only `.md`/`.mdx` files plus the one new test and the one comment-only `index.ts` change; every stale sentence's grep returns zero hits and its replacement at least one, pasted into the Log.

### Issue M8.17 — Close-out: merge day, the exit criteria ticked against their runs, the workstream sealed
M8 exists on a branch and nowhere else — fifteen-plus pull requests open, none merged, every exit criterion green on the stack tip and unchecked because the boxes were always going to tick when the chain merged. This ticket is that day: the merge itself, the runs that make the ticks true, and the six records — `MILESTONE.md`, `BOARD.md`, every ticket's `State`, this document, the repo memories and `gh pr list` — brought into agreement and read back once, together. It writes no product code; its whole diff is the board and the docs, and it cannot close itself while any unit in M8.13–M8.16 is still open.
- [sub] Build and hand the owner the merge-day checklist, re-deriving live the five procedural facts that would otherwise bite the merger (no auto-retarget, three allowed merge methods with only one correct, an admin-only merge path, no required status check, two stale worktrees) and pruning the worktrees.
- [sub] Walk the checklist with the owner, one PR at a time, bottom-up, recording every merge commit SHA and how each next base was restored.
- [sub] Run the gate, the conformance matrix and the e2e suite on merged `main`, and record the exact numbers.
- [sub] Re-run M8.12's Verify 1 on `main` across all three of its files together, and move M8.12 to `Done`.
- [sub] Tick every exit criterion in `MILESTONE.md` against the run that proves it, named on the box's own line, and set the milestone `Status` to `CLOSED`.
- [sub] Mirror M8.12–M8.17 into this document, replacing the pointer M8.16.20 left with the real seed sections.
- [sub] Point the repo memories' active-workstream marker away from the now-closed board, and retire any landmine the merged code actually closed.
- [sub] Read `BOARD.md`, every ticket's `State` row and `gh pr list` together in one sitting and confirm they agree — and hold M8.17 at `In Review` while any of M8.13–M8.16 is not `Done`.
- [sub] The seal: the owner merges this ticket's own PR, then a one-line `board/m8-sealed` PR flips its `State` and `BOARD.md`'s row to `Done` together.
**Verify:** the three runs on merged `main` recorded with their numbers; every recorded head SHA an ancestor of `origin/main` with one merge commit per PR; no unchecked exit criterion and no tick without a named run; the three-way read agreeing before and after the seal; this document mirroring all seventeen tickets; the memories pointing at no closed workstream as active; M8.13–M8.16 each `Done` with a green Verify recorded in their own Log.

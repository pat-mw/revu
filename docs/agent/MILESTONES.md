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

**Depends:** M2 (reuses the sync engine + write path in-workspace; the collector wraps drafts/audit, not GitHub calls).

### Issue M3.1 — Scratch App + org
Create GitHub App with grant **byte-identical to the real one**: `contents:write` + `pull_requests:write` + `metadata:read` + `checks:read` (the owner adds `checks:read` to the real App — `CHECKPOINT_2.md` §E.3). **NO webhooks** (poll-only is correct). Install on scratch org mirroring M2.1 scenarios plus one PR opened by a real org-member account.
- [sub] Per-RevuApi-method → App-permission matrix: verify `pull_requests:write` covers reviews, review-comment replies, resolve mutations, and reactions; confirm PR issue-comment reads (`/issues/{n}/comments`) fit the grant (or note the `issues` permission if not).
- [sub] Document App creation/permissions as the client-facing runbook for the real installation.
**Verify:** conformance fails early against any RevuApi call outside the exact grant; the matrix has no unverified rows.

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

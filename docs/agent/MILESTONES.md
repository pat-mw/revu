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

# revu — integration guide

From mock to real. This document is grounded in the prototype as it exists at `pat-mw/revu` today: the `RevuApi` interface in `src/api/client.ts` is the contract, the types in `src/api/types.ts` are the wire shapes, and nothing in `src/components`, `src/pages`, `src/state`, or `src/lib` changes. Integration means writing implementations of one interface and standing up the services behind it.

---

## 0. The shape of the thing

Two deployment modes share one frontend and one API contract:

**Broker mode** — the Coder sandbox. Every GitHub call authenticates as the GitHub App via the broker on the macOS host. Identity is smuggled through comment bodies. Drafts and viewed state persist on the broker because workspaces are disposable.

**Direct mode** — the general-purpose, local-first tool. A developer with their own GitHub access runs revu against any repo. Calls authenticate as *them* (via `gh` CLI credentials), so there is no smuggling, no `[bot]`, real approve/request-changes, and drafts persist in a local store. This is the same offline-snapshot review pipeline without the multi-tenancy problem.

Both modes are served to the frontend by the same process: a small sidecar daemon, **`revud`**, which implements the `RevuApi` surface over HTTP. The frontend gets one new adapter:

```
src/api/
  client.ts          # unchanged — the contract
  mock/              # unchanged — keep it; it's the test double forever
  http/
    adapter.ts       # createHttpApi(baseUrl) — thin fetch wrapper, ~150 lines
```

`src/api/index.ts` picks at startup:

```ts
const base = import.meta.env.VITE_REVU_API ?? null
export const api: RevuApi = base ? createHttpApi(base) : createMockApi()
```

That is the *entire* frontend change, plus the punch list in §7. Everything else below is `revud` and the broker.

Why a daemon instead of calling GitHub from the browser? Three reasons that apply in both modes: the token never enters the browser; the snapshot cache and draft store need to live somewhere durable that isn't `localStorage`; and blob reads can come from the local git clone (§3.3), which a browser can't do. `revud` is a single Bun process serving the built frontend as static files and the API under `/api/` — one port, no CORS, `bunx revud` and open a tab.

### HTTP mapping

The contract maps mechanically. One route per method; `snake`/`camel` as in the types file, JSON bodies, errors as `{ code: ApiErrorCode, message, resetAt? }` with appropriate status codes (`rate_limited` → 429, `broker_unreachable` → 502, etc. — the copy in `src/components/review/error-copy.ts` already switches on these codes).

| `RevuApi` method | Route |
|---|---|
| `getSession` | `GET /api/session` |
| `listPulls` | `GET /api/pulls` (request `If-None-Match`, respond `ETag` / `304`) |
| `syncPull` | `POST /api/pulls/:n/sync` |
| `getSnapshot` | `GET /api/pulls/:n/snapshot` |
| `getBlob` | `GET /api/blobs/:sha` |
| `listReviewThreads` | `GET /api/pulls/:n/threads` |
| `replyToThread` | `POST /api/pulls/:n/threads/:threadId/reply` |
| `resolveThread` | `POST /api/pulls/:n/threads/:threadId/resolve` `{resolved}` |
| `addReaction` | `POST /api/comments/:id/reactions` `{reaction}` |
| `submitReview` | `POST /api/pulls/:n/review` |
| `reconcileDraft` | `GET /api/pulls/:n/reconcile` |
| `getDraft` / `saveDraft` / `discardDraft` | `GET` / `PUT` / `DELETE /api/pulls/:n/draft` |
| `getFileViewed` / `setFileViewed` | `GET` / `PUT /api/pulls/:n/viewed` |
| `getRateLimit` | `GET /api/rate-limit` |

Honor the mock's semantics exactly — they encode the spec. In particular: `submitReview` returns `{status: 'head_moved'}` as a **200-level value**, never an error (`src/api/mock/adapter.ts` and the review bar both depend on this); `syncPull` may resolve with `snapshot.partial` set rather than throwing; `getSnapshot` returns `null`, not 404-as-error, for never-synced PRs.

---

## 1. Identity: `git config` is the source of truth

Per the deployment decision: Coder templates already inject `user.name` and `user.email` from the Coder account into git config on workspace startup. revu reuses that instead of talking to Coder's API.

`revud` builds the `Session` at startup:

```ts
const name  = await $`git config user.name`.text()   // "Alice Nguyen"
const email = await $`git config user.email`.text()  // "alice@contractor.co"
const human: Human = {
  id: emailToId(email),        // stable key: lowercase email
  name, email,
  role: env.REVU_ROLE ?? 'contractor',
}
```

**Use the email as `Human.id`, not the name.** Names driven by Coder usernames are unique *per deployment at a point in time* — but usernames can be renamed, and a departed contractor's username can be re-registered, at which point name-keyed history silently reattributes. Email is the stable key for drafts, viewed state, and the audit log; name stays the display layer. The mock keys drafts as `humanId → prNumber → draft` (`src/api/mock/store.ts`); the broker store must do the same.

**Parser/username charset mismatch — fix before first stamped comment.** `looksLikePersonName` in `src/lib/identity.ts` admits only letter-tokens (`\p{L}` with `'`/`.`/`-`), but Coder usernames may contain digits and underscores — `alice2` or `j_doe` would fail validation, the prefix wouldn't parse, and that contractor's every comment would render as the bare bot. The broker owns the format on both ends, so relax the validator to Coder's actual username charset (and add a fixture human named `alice2` so the regression is caught in the mock).

The smuggled prefix stays name-based for display — `prefixBody()` in `src/lib/identity.ts` is already the canonical formatter and the parser is its inverse. Don't put emails in comment bodies; they're visible to the whole org on github.com.

**Trust boundary, stated honestly:** git config is workspace-writable, so a contractor can impersonate another in the *display* layer. That was accepted back when commit attribution took the same approach — convention, not authentication. The *audit* layer is separate and stays authoritative: the broker logs `{workspace, coder_user, endpoint, pr, comment_id, timestamp}` for every write it performs, and it knows the workspace from the mTLS/tailnet channel the request arrived on, not from anything the workspace claims. Display identity and audit identity are different systems; only one of them needs to be tamper-proof.

In direct mode the same code runs unchanged — everyone has git config — and the identity is cosmetic anyway because GitHub authenticates the human for real.

---

## 2. The broker's new surface (broker mode)

The broker currently mints installation tokens and injects them into workspaces. For revu it grows an HTTP API on the tailnet, and **workspace `revud` never holds the token at all** — it forwards GitHub-bound operations to the broker, which executes them. This is the proxy pattern from the original design, now concrete:

```
Browser tab ──▶ revud (workspace) ──▶ broker (macOS host) ──▶ GitHub
                    │                     │
                    │                     ├─ App token mint + refresh
                    │                     ├─ identity stamping on writes
                    │                     ├─ audit log (append-only)
                    │                     ├─ PR-list poll loop + ETag cache
                    │                     ├─ blob/snapshot cache (shared, content-addressed)
                    │                     └─ draft + viewed store (SQLite, keyed by email)
                    └─ local git blob reads (§3.3) — the one thing revud does itself
```

Broker endpoints (tailnet-only, workspace-authenticated):

```
GET  /v1/pulls                          # served from the poll loop's cache
POST /v1/pulls/:n/sync                  # executes the burst, returns Snapshot
GET  /v1/blobs/:sha                     # shared content-addressed cache
POST /v1/pulls/:n/comments/:id/reply    # stamps prefix, posts, logs
POST /v1/threads/:threadId/resolve      # GraphQL mutation, logs
POST /v1/pulls/:n/review                # head guard, stamps every comment, posts, logs
POST /v1/comments/:id/reactions
GET/PUT/DELETE /v1/drafts/:email/:n     # survives workspace rebuild — the whole point
GET/PUT        /v1/viewed/:email/:n
GET  /v1/rate-limit
```

### 2.1 The poll loop and `BrokerPullMeta`

The prototype's `PullListItem` pairs each GitHub `PullSummary` with broker-side annotations (`src/api/types.ts`): `authorHumanId`, `canApprove`, `unresolvedThreads`, `assignedReviewerHumanIds`, `compareKey`, `commitCount`. The inbox, the review bar's approve gating, and staleness detection all read these. They come from one place — the broker's poll loop:

- Poll `GET /repos/{o}/{r}/pulls?state=open&per_page=100` with `If-None-Match` every ~30s. A 304 is free against the bucket; contractor count no longer multiplies read cost.
- On change, refresh per-PR cheap facts: one GraphQL query batching `reviewThreads(first:0){ totalCount }`-style counts across changed PRs, plus `mergeBaseSha`/head from the list payload for `compareKey`.
- `authorHumanId`: the broker *created* every App-authored PR, so it logged who drove. Resolve from its own write log; `null` for PRs opened by real org members.
- `canApprove`: `authorHumanId !== null ? false : true` — the App can't approve its own PRs; PRs opened by org members it can review. (Direct mode: `pull.user.login !== viewer.login`.)
- `assignedReviewerHumanIds`: broker-side assignment, since GitHub only sees one bot. A tiny admin endpoint or a YAML file the lead edits; either way it's broker data, not GitHub data.

### 2.2 Stamping and the write log

Every write endpoint does three things in order: prepend `**{name}** ({role})\n\n` to the body via the same format `prefixBody()` emits (the broker owns this format — if it ever changes, change parser and stamper together), execute against GitHub, and append to the audit log *with the GitHub-assigned comment/review id from the response*. That last part is what §7's own-comment fix builds on: the broker knows, exactly and forever, which human wrote comment `2054417`.

Expose it: extend the sync payload's mutable half with `commentAuthors: Record<number, string>` (comment id → human email) assembled from the log. It's additive to `SnapshotMutable`, the mock can carry it trivially, and it upgrades own-comment detection from name-string matching to ground truth.

---

## 3. Implementing the burst: `syncPull` against real GitHub

This is the only genuinely intricate endpoint. Budget and sequence, for a typical 14-file PR:

| Step | Call | Cost |
|---|---|---|
| 1 | `GET /pulls/{n}` — detail, head, `merge_base_sha` via `base`+`head` compare | 1 |
| 2 | `GET /pulls/{n}/files?per_page=100` — the `PullFile[]`, incl. `patch` and head blob SHA per file | 1–2 |
| 3 | GraphQL: `reviewThreads(first:100)` with nested comments, `isResolved`, `isOutdated`, paths/lines | 1–2 |
| 4 | `GET /issues/{n}/comments` + `GET /pulls/{n}/reviews` + `GET /pulls/{n}/commits` | 3 |
| 5 | `GET /commits/{head_sha}/check-runs` | 1 |
| 6 | `GET /git/trees/{merge_base_sha}?recursive=1` — resolves **base-side** blob SHAs for every changed path in one call | 1 |
| 7 | Blobs — see 3.3 | ideally **0** |

So a full cold sync is ~8–10 requests and a warm re-sync (mutable-only changes) is ~6 with every blob reused — which is exactly what the prototype's `syncStats.blobsFetched / blobsReused` numbers were designed to surface. Populate them honestly.

### 3.1 Normalization

GraphQL thread comments come back in GraphQL vocabulary; the contract requires them normalized to the REST `ReviewComment` shape ("one comment vocabulary" — the docstring on `ReviewThread` in `types.ts`). Request `fullDatabaseId` on comment nodes to get REST-numeric ids, map `diffSide`→`side`, and carry `diff_hunk` from the GraphQL `diffHunk` field. The fixtures in `src/fixtures/prs/` are the acceptance tests for this mapping: your normalizer, pointed at a real PR shaped like pr347, must produce structurally identical output.

### 3.2 The two halves, enforced

Key the immutable write by `compareKey = ${merge_base_sha}...${head_sha}` computed in step 1. If the store already holds that key, steps 2, 6 and 7 are skipped entirely and only steps 3–5 execute. Do not add a TTL to the immutable store; do not let a head-SHA match short-circuit the mutable fetch. The two fixtures that exist purely to catch this (pr389 base-moved, pr410 resolved-elsewhere) are your regression tests — replay them against the real adapter in CI using the mock as oracle.

### 3.3 Blobs from local git — the free lunch

Contractors already have the repo cloned in the workspace. After `git fetch origin`, both `merge_base_sha` and head are almost always present locally, and every blob the snapshot needs is a `git cat-file blob {sha}` away — zero API requests, zero rate-limit spend, works when the tailnet is flaky. This is why `revud` does blob reads itself rather than delegating to the broker:

```
resolve blob sha  →  git cat-file -t {sha} succeeds?  →  yes: cat-file blob, done (cost 0)
                                                     →  no:  GET /v1/blobs/{sha} from broker
                                                             (broker: cache hit or 1 API request,
                                                              batched via GraphQL object() aliases
                                                              ~30 blobs/query when cold)
```

Mark `binary` via the same heuristic git uses (NUL byte in the first 8000 bytes), populate `size`, and respect the prototype's behavior of collapsing binaries rather than fetching content for them.

In direct mode this path is even more valuable: a solo dev syncing a 200-file PR spends ~8 requests total instead of hundreds.

---

## 4. Writes

**`submitReview`** — guard first: `GET /pulls/{n}` (1 request), compare head to `input.expectedHeadSha`; on mismatch return `{status:'head_moved', currentHeadSha, newCommits}` *without posting anything*, so the UI routes into reconcile exactly as the mock does. On match, one `POST /pulls/{n}/reviews`:

```jsonc
{
  "commit_id": "<expectedHeadSha>",
  "event": "COMMENT",             // APPROVE / REQUEST_CHANGES only when canApprove
  "body": "<stamped review body>",
  "comments": [ { "path", "side", "line", "start_line", "start_side", "body": "<stamped>" } ]
}
```

Map `PendingComment` fields 1:1 — the names were chosen to match. Multi-line comments send `start_line`/`start_side`; single-line omit them. On success, delete the broker-side draft and return the created `ReviewSummary`. On `422` (a comment failed server-side validation despite the guard — a force-push in the guard-to-post window): **do not delete the draft**; surface `conflict` and let the UI re-run reconcile. The draft-survives-everything invariant is the product.

**`replyToThread`** — REST wants a comment id, the contract passes a thread id: reply to the thread's *first* comment (`POST /pulls/{n}/comments/{comments[0].id}/replies`) — GitHub attaches replies to the thread root regardless. Stamp, post, log, and return the new comment normalized; the frontend appends it optimistically and reconciles on response.

**`resolveThread`** — GraphQL `resolveReviewThread` / `unresolveReviewThread` with the `PRRT_` node id the snapshot already carries. Installation tokens can run these mutations (server-to-server GraphQL is supported for Apps); `resolvedBy` will read as the bot — the UI already renders that case.

**`addReaction`** — `POST /pulls/comments/{id}/reactions`. Known compromise: reactions are per-GitHub-user, and there's one GitHub user. Alice's 👍 and Bob's 👍 are the same 👍, and one human "removing" theirs removes it for everyone. Ship it as shared-and-honest (the rollup is real data), and don't build per-human reaction simulation — it's write-amplification for the least important feature on the page.

**Reconcile** — `reconcileDraft` is broker/revud-side but the algorithm is already written: `src/lib/anchor.ts` is pure functions with no DOM or fetch dependencies. Extract it to a shared package (or just import across — both ends are TypeScript under Bun) and run the *identical* scorer server-side. Divergence between what the reconcile dialog previews and what submit does would be the worst kind of bug in the app's most important flow; sharing the module makes it structurally impossible.

---

## 5. Direct mode: the general-purpose adapter

Everything above minus the multi-tenancy machinery. `revud --direct` in a repo directory:

- **Auth**: `gh auth token` (respecting `GH_TOKEN`), owner/repo from `git remote get-url origin`. The user is a real GitHub user with a real `viewer`.
- **No stamping**: `prefixBody` is skipped; comments post as the human. The parser in `lib/identity.ts` naturally no-ops — `user.login !== BROKER_LOGIN` routes every comment to `kind:'github'` and everything renders with genuine identities. This already works in the prototype; it's why the parser was written to be conditional on the bot login.
- **`canApprove`**: `pull.user.login !== viewer.login`, and APPROVE/REQUEST_CHANGES are live.
- **Drafts stay local-store, not GitHub-pending.** GitHub *could* hold a native pending review in direct mode, but don't: local drafts are what make review offline-capable, atomic, and reconcilable — the product's actual differentiators — and one draft model across both modes means one review bar, one reconcile flow, one set of bugs. Store in SQLite at `${XDG_DATA_HOME:-~/.local/share}/revu/`, same schema as the broker's, keyed by the same git-config email.
- **`BrokerPullMeta` degrades gracefully**: `authorHumanId` null, `assignedReviewerHumanIds` from GitHub's real `requested_reviewers` mapped onto the session when it includes the viewer, `unresolvedThreads` from the same cheap GraphQL count, poll loop optional (a solo user's 304-heavy polling is nearly free anyway).

Structure `revud` so mode is an injected pair of strategies — `TokenSource` (broker-fetch vs `gh`) and `WriteDecorator` (stamp+log vs passthrough) — around one shared core of sync engine, snapshot store, draft store, and anchor logic. The core is ~all of the code; the modes are two small files. That's the adapter pattern landing where it actually pays.

---

## 6. Sandbox deployment

Repo ships in the workspace image; template startup script builds and launches:

```bash
cd /opt/revu && bun install --frozen-lockfile && bun run build
REVU_MODE=broker REVU_BROKER_URL=http://broker.tail<net>.ts.net:8787 \
  bun run revud --port 4780 &
echo 'alias revu="open-url http://localhost:4780"' >> ~/.bashrc
```

Notes that matter:

- **Serve the built app, not `vite dev`.** Dev-server startup and on-demand transform on every workspace spin-up is the cost that made Vite-over-Next the right call; don't reintroduce it. `revud` statically serves `dist/`.
- Coder's dashboard proxies workspace ports, so `revu` opens in the same browser session as the IDE — register port 4780 as a named app in the Coder template for a one-click sidebar entry.
- Snapshots cached in the workspace are a convenience copy; the broker cache is the durable one. A rebuilt workspace re-syncs warm from the broker (blobs shared) at near-zero API cost. Drafts were never in the workspace at all.
- Keep the mock reachable in production builds behind `?mock=1` (the dev panel and fixtures are ~small in the bundle) — it's the fastest way to demo the tool to the client and to bisect "is this bug frontend or transport."

---

## 7. Frontend punch list

The short list of real changes in the prototype itself:

1. **`BROKER_LOGIN` becomes config.** It's a hardcoded const in `src/api/types.ts` (`'acme-broker[bot]'`). Move it into `Session` (`session.brokerLogin` is *already in the type* and populated by the mock — the bug is that `lib/identity.ts` imports the const instead of reading the session). Thread the session's value through `parseCommentIdentity`'s callers; grep for `BROKER_LOGIN` — the sites are few.
2. **Own-comment detection by id, not name.** Name matching works day-to-day given Coder username uniqueness, but breaks across renames and username reuse, and the broker's write log is ground truth anyway. With `commentAuthors` in the sync payload (§2.2), change `isOwnComment` to check `commentAuthors[comment.id] === human.id`, falling back to the name match when the map is absent (direct mode: compare `comment.user.login` against the session's viewer login, which `Session` should carry in direct mode). Same file, apply the charset fix from §1 to `looksLikePersonName`.
3. **`createHttpApi`** as described in §0 — fetch wrapper, `ApiError` mapping from `{code}` bodies, `ETag` pass-through on `listPulls`, `AbortSignal` wiring on `syncPull` (the interface already takes it; the mock honors it — keep parity).
4. **Split-mode preference** currently sits in `sessionStorage` (`src/pages/files.tsx`). Harmless, but it's the one piece of per-human state left in the browser; fold it into the viewed/preferences store if you want the "rebuild loses nothing" claim to be literally total.
5. **Fixture-as-oracle tests.** The fixtures encode every hard scenario the spec demanded (base-moved, resolved-elsewhere, partial sync, drift/lost anchors). Add a small conformance suite that runs both adapters — mock and http-against-a-seeded-test-repo — through the same assertions on `syncPull` output shape, `submitReview` head-guard behavior, and reconcile classifications. That suite, not the UI, is what lets you touch the sync engine with confidence later.

---

## 8. Order of work

1. `createHttpApi` + `revud` skeleton serving the **mock store** over HTTP — proves the transport seam with zero GitHub risk; the UI can't tell the difference, which is the point.
2. Direct mode against a scratch repo — smallest real-GitHub surface (no broker, no stamping), exercises the whole sync engine, normalizer, and write path. Most integration bugs die here, and it ships the general-purpose tool as a side effect.
3. Broker endpoints: token custody, stamping, audit log, draft store. Point revud's strategies at it.
4. Poll loop + shared caches + `commentAuthors`; frontend punch-list items 1–2.
5. Conformance suite (punch-list 5) before anyone else's workspace gets the alias.
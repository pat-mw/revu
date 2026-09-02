# revu security review — custody, integrity, isolation, and honest limits

This is the client-facing summary of revu's security posture under the validated
deployment model: contractors work in disposable cloud workspaces with
passwordless sudo, a host-side broker injects a short-lived GitHub App
installation token (`pull_requests: write`) into each workspace, and every
GitHub write posts under one shared bot identity. Each claim below names the
code that enforces it; the verifying tests live in
`packages/revud/src/broker/token-custody.test.ts`,
`packages/revud/src/collector/audit-integrity.test.ts`, and
`packages/revud/src/draft-isolation.test.ts`.

## Token custody

The claim is precise: **revu adds no new credential and never serializes
tokens.** It is NOT "the workspace never holds a token" — the workspace holds a
live write token by design; the broker injects it, and revu only reads what is
ambiently present (`broker/token-source.ts:createFileCredentialTokenSource`,
re-read per request, never cached, never logged). The token is confined to the
outbound `Authorization` header of server-side GitHub calls
(`direct/github-client.ts:createGithubClient`) and never enters a URL, request
body, log line, or error. The browser talks to revud with plain same-origin
fetches — the app transport (`app/src/api/http/adapter.ts`) contains no
credential handling at all — and a full sweep of the served HTTP surface never
carries the token in any response body or header. That sweep iterates the
contract route table (`shared/src/http.ts:ROUTES`) itself, covering every
route's success and failure envelopes plus the dev and unknown-path branches,
so a route added later cannot silently escape it. A credential-file read failure surfaces at most a
sanitized errno mnemonic matching `^[A-Z][A-Z0-9_]{0,31}$`
(`token-source.ts:readFailureDetail`) — never reader-controlled file content,
and structurally never a `ghs_…`-shaped token. The broker binds loopback only
(`index.ts:mainBroker`), so the daemon is unreachable from outside the
workspace.

## Audit-log integrity and channel binding

The audit journal is **append-only**: the only statements that ever touch
`audit_log` are create, insert, and select (`direct/store.ts:appendAudit`,
`collector/host-store.ts:landAudit`); no update or delete path exists on either
store's code surface — the guarantee is the reviewed code, not a database-level
constraint — and offboarding purges a departing human's drafts and viewed
state while retaining every journal row
(`collector/offboard.ts:offboardHuman`).

Identity in the journal is **channel-bound, never workspace-claimed**.
Everything pulled out of a workspace is spoofable by its contractor; the one
signal that crosses the boundary intact is the container's `coder.owner` label,
read by the host off the container itself
(`collector/identity-binding.ts:createMapCoderOwnerResolver`,
`collector/collector.ts:runCollectorTick`). Host-side landing re-keys every
record to that binding: `landAudit` sets `human_id` to the binding's email and
`workspace` to the channel-authentic owner, discarding the pulled row's claimed
identity and keeping only the validated `githubId` / `endpoint` / `pr` /
`createdAt`; `landDraft` overwrites the embedded `humanId` the same way.
Landing is idempotent via a full-tuple `ON CONFLICT … DO NOTHING` (never a
blanket OR-IGNORE insert that would swallow constraint violations), so
re-pulls land nothing new and one human's rows can never suppress another's.
Malformed pulled rows are rejected individually with field-naming,
value-free reasons — never silently dropped, never allowed to block valid rows
(`host-store.ts:validateAuditEntry`).

### Local reviews: no client to reach GitHub with, and no journal row

A local review — two branches compared inside the workspace, with no pull
request behind it — has its own write path, and **that path has no GitHub
client in scope.** Not a client it declines to call: the seam is absent from the
module (`packages/revud/src/direct/local-writes.ts`), along with the
body-stamping/journalling write decorator and the subprocess runner, so there is
no socket a later change could quietly repoint at a remote. The absence is
enforced rather than asserted in prose — a source scan walks the local write
path's import graph and fails on an import of a GitHub client, a write
decorator, a command runner, or any network or subprocess vocabulary, at import
depth zero and at every depth below, with the scanned file set and the ban list
each separately proved non-vacuous
(`packages/revud/src/direct/local-write-isolation.test.ts`).

One thing on the local path does read GitHub, and it is worth stating exactly
what it is. When a pull request appears for the same repository and branch pair,
the local review is archived — read-only, frozen at its last sync, linked to
the pull request — and finding that pull request is a **read** of GitHub: an
optional one-method listing seam, consulted on each sync of a live review,
absent altogether in a workspace with no origin or token. The detector behind
it (`packages/revud/src/direct/local-archive.ts`) sits outside the write sink,
and the sink's banned-specifier list names it, so the same source scan that
keeps a GitHub client out of the local write path keeps the detector out too.
What detection writes is one column of one row, `local_reviews.archived_pr`;
the real pull request number it holds never reaches `snapshots.pr_number`,
`audit_log.pr`, or `pr_author.pr`, and nothing in the archived review — no
thread, draft, verdict, or reaction — is copied to the pull request.

Local reviews are also **not journaled.** Nothing on the local path appends to
`audit_log`, and no locally minted identifier is ever written to
`snapshots.pr_number`, `audit_log.pr`, or `pr_author.pr` — local reviews live in
their own `local_*` tables. The port the local write sink is handed is a
written-out member list carrying neither `appendAudit` nor `putSnapshot`, and
that absence is checked against a store proved to really carry both, so it
cannot pass vacuously (`direct/local-surface.ts:buildLocalWriteDeps`,
`direct/local-surface.test.ts`).

That is what keeps `PR #N` meaning what it says. The host collector and the
out-of-band-write detector read those columns as real GitHub pull request
numbers; a sentinel among them would have the journal describing artifacts that
exist on nobody's repository. **Local reviews are deliberately invisible to the
audit trail because they are deliberately invisible to the client.** The
journal's subject is writes that reached the client repository, and a local
review reaches nothing — no comment, no verdict, no artifact of any kind — so
there is nothing for the journal to be silent about.

## Workspace isolation

A draft belongs to one human and is unreachable from any other workspace.
Host-side access is authorized exclusively by the resolved `coder.owner`
binding: no store method accepts an email or any caller-claimed identity, and
an unknown owner fails loud (`host-store.ts:UnboundOwnerError`) rather than
reading empty or wide. The HTTP contract has **no identity-bearing path
parameter** — every route parameter is a resource id (`shared/src/http.ts:ROUTES`);
an email-in-path draft route in any spelling does not exist, so there is
nothing to traverse. In-workspace, drafts are keyed by the boot-time session
identity and a spoofed `humanId` in a request body is overwritten before it
reaches the store (`direct/direct-api.ts:saveDraft`). The dev routes that let a
caller pick the acting human exist only in mock mode and 404 everywhere else
(`api-router.ts:handleApi`).

## The honest limit: detection, not prevention

The injected token carries `pull_requests: write`. A contractor with sudo in
their workspace can read that token and `curl` the GitHub App directly —
posting, approving, or editing as the bot while **bypassing revu entirely**.
revu cannot prevent this and does not claim to. The compensating control is
**detection**: the host collector reconciles bot-authored reviews and comments
on GitHub against the merged all-humans journal union and flags any artifact the
journal cannot account for
(`broker/out-of-band-writes.ts:detectOutOfBandWrites`,
`collector/collector.ts:runCollectorTick`). Two limits keep that claim honest.
Coverage is per reconcile pass, over the pull requests a pass is handed — those
with pulled journal activity, plus whatever complete open-PR set the operator
feeds it; a bypass on a pull request a pass never examines is not checked, so
completeness is an operator-wiring obligation the code cannot itself enforce.
And in this codebase the reconcile is a library, not yet a running loop: no
scheduler or pull source drives `runCollectorTick` outside its tests. Detection
here is a designed control awaiting deployment wiring, not one already operating.

What a hostile workspace **can** do:

- use the injected token directly against GitHub as the bot (the deployment
  model's inherent grant, not a revu defect);
- spoof its own git-config identity and anything else it self-reports — which
  is exactly why audit identity derives host-side from the channel-authentic
  `coder.owner`, never from workspace claims;
- forge rows in its own local journal. Re-keying forces a forged row under the
  forger's **own** binding, so the write stays attributed to them — but a forged
  creating row absolves the bypass it names, and transitively its linked
  artifacts: a forged `submitReview` row absolves that review and every inline
  comment carrying its review id, and a forged `replyToThread` row absolves the
  named comment and vouches its parent review (one forged parent id can cover
  many comments). This is a known, surfaced limitation — the detector's absolving
  evidence is itself workspace-produced; see the skipped demonstration in
  `collector/audit-integrity.test.ts`. Detection also has enumerated residual
  channels — reactions, thread resolve/unresolve, review dismissal, in-place
  PATCH edits (a mediated review's body can be rewritten out-of-band with no
  detectable trace: reviews expose no `updated_at`), PR title/body edits, and
  `contents: write` — plus point-in-time gaps, all documented in
  `out-of-band-writes.ts`;
- review branches locally with no journal row anywhere — local reviews sit
  outside the audit trail by design. That is not a way to conceal anything: the
  writes a local review produces reach no repository at all, so there is no
  GitHub artifact whose missing journal row could cover one.

What a hostile workspace **cannot** do:

- read or write another human's drafts (channel-bound authorization; no
  identity-addressable route);
- forge the `coder.owner` channel binding (a host-owned container label the
  workspace never gets to claim);
- attribute its writes to another human (host-side re-keying discards claimed
  identity in every direction);
- make revu serialize, log, or mint a credential (revu holds no credential of
  its own to mint, and the injected one never crosses the HTTP boundary);
- rewrite or delete landed audit rows (append-only journal; offboarding
  retains it);
- reach the client repository through a local review (the local write path
  holds no client to reach it with, and mints no pull-request-shaped identifier
  the collector could mistake for one).

**Bottom line:** revu's guarantees are custody (no new credential, no token
serialization), integrity (append-only, host-keyed attribution), and isolation
(channel-bound per-human state). Its audit is a detection and attribution
system over a deliberately shared write identity — not an enforcement boundary
around the token the deployment model itself hands to every workspace.

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
store surface, and offboarding purges a departing human's drafts and viewed
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
**detection**: the host collector reconciles every bot-authored review and
comment on GitHub against the merged all-humans journal union and flags every
artifact the journal cannot account for
(`broker/out-of-band-writes.ts:detectOutOfBandWrites`,
`collector/collector.ts:runCollectorTick`).

What a hostile workspace **can** do:

- use the injected token directly against GitHub as the bot (the deployment
  model's inherent grant, not a revu defect);
- spoof its own git-config identity and anything else it self-reports — which
  is exactly why audit identity derives host-side from the channel-authentic
  `coder.owner`, never from workspace claims;
- forge rows in its own local journal. Re-keying forces a forged row under the
  forger's **own** binding, so the write stays attributed to them — but a
  forged `submitReview` row naming a directly-posted bot artifact currently
  absolves it from out-of-band detection (a known, surfaced limitation: the
  detector's absolving evidence is workspace-produced; see the skipped
  demonstration in `collector/audit-integrity.test.ts`). Detection also has
  enumerated residual channels — reactions, thread resolve/unresolve, review
  dismissal, in-place PATCH edits, PR title/body edits, `contents: write` —
  and point-in-time gaps, documented in `out-of-band-writes.ts`.

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
  retains it).

**Bottom line:** revu's guarantees are custody (no new credential, no token
serialization), integrity (append-only, host-keyed attribution), and isolation
(channel-bound per-human state). Its audit is a detection and attribution
system over a deliberately shared write identity — not an enforcement boundary
around the token the deployment model itself hands to every workspace.

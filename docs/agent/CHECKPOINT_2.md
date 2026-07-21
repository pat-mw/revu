# CHECKPOINT_2 — the M3 (broker) plan against the real sandbox

Independent validation of revu's M3 plan (`INTEGRATION_GUIDE.md` §2 + `MILESTONES.md` M3) against the **real** owner Coder/sandbox runbook (`tmp/coder-sandbox-setup/`), read from the runbook files, not from the revu plan's assumptions about them. Five readers over disjoint file sets converged on one verdict, unanimously and with direct evidence.

**The M3 plan is built on the wrong topology.** It assumes a **proxy** broker — the workspace holds no token and forwards every GitHub-bound call to a broker HTTP API on the tailnet (guide §2, M3.2, M3.6, M6.2). The real deployment is **MINT-AND-INJECT**: a host-side token broker pushes a ~1h repo-scoped installation token into each container's `~/.git-credentials` over `docker exec` stdin; there is **no listening socket**, no inbound service a workspace can call, and the workspace's own `git`/`gh` call GitHub **directly** as the App. The proxy is not a smaller version of the real thing — it is the exact service the sandbox owner deliberately refused to build.

**Verdict: GO for M3 under the corrected plan below.** The good news is large: the inject model collapses most of "broker mode" into the M2 direct engine running in-workspace against the ambient injected token (a file-credential `TokenSource`). M3's genuinely new code is not a GitHub proxy — it is identity binding, audit, durable per-human state, and a host-side collector that rides the existing push tick. The owner has made 7 decisions (§E) that resolve every high-severity gap. This document is the durable record of the real architecture, the boundary map, the gap analysis, those decisions, and the corrected per-ticket M3 plan.

The authoritative source is the five-reader synthesis over `tmp/coder-sandbox-setup/`; runbook file evidence is cited inline throughout.

---

## A. TL;DR + go/no-go

- **Topology:** MINT-AND-INJECT, not proxy. Unanimous across five readers from disjoint file sets. `token-broker.sh:9` — "push, not pull. There is NO listening socket." `main.tf` L116-128 — "The workspace only ever holds a token." The workspace already holds a live GitHub **write** token no matter what revu does; "the workspace never holds a token" (guide §2) is unachievable here without changing the sandbox's git-credential model.
- **Where revu plugs in:** revud runs **in the workspace**, serving its SPA on a loopback port (the proven `coder port-forward --tcp` pattern) and running the M2 sync/read/**write**/reconcile engine against the ambient injected token via a `FileCredentialTokenSource`. What must live **host-side** — beside the App key, on the trusted side of the VM boundary — is everything the contractor must not control: the per-human audit log, identity binding, durable drafts/viewed state, and any shared cache.
- **The host-side revu component is a *collector*, not a proxy.** It rides the existing 60s `docker exec` tick to **pull** each container's drafts + local audit journal (bound to the container's `coder.owner` label = channel-authentic), runs the out-of-band-write detector, and holds the durable per-human store. It adds **no** workspace-callable inbound surface — preserving the sandbox's load-bearing zero-inbound invariant.
- **Audit is detection, not prevention.** The injected token carries `pull_requests:write`, so any contractor can `curl` `api.github.com` and post bot-identity comments directly — unstamped, or stamped with another human's markdown prefix. revu's audit is authoritative **provenance** of the writes it mediates, plus an **out-of-band detector** (any App-authored comment absent from any journal = out-of-band write). The owner chose to keep the injected token whole (no permission split); revu adapts.
- **Go/no-go: GO.** Every high-severity gap is resolved by an owner decision (§E). The security claims in M5.4 hold under the corrected model (§F, M5.4). Proceed with the corrected M3 plan (§F). Four items are owner/ops responsibilities, not revu tickets (§G).

---

## B. The real architecture

A four-layer nesting with **one deliberate one-way channel**. The revu plan's mental model — a broker the workspace calls — is absent at every layer.

**(1) macOS host (Mac mini) — the crown jewels.** Holds the GitHub App private key (`~/.apoha-devbox/gh_app.pem`, mode 600), `APP_ID`/`INSTALLATION_ID`, and `repos.map` (Coder-username → repo scope). Runs the **token broker** (`broker/token-broker.sh` + `gh-app-token.sh`) on a 60s LaunchAgent tick — only while a GUI user is logged in (an unmonitored SPOF; failure surfaces as silent 401s within ~1h).

**(2) Lima Ubuntu VM (Apple `vz`, `mounts: []`) — THE security boundary.** A container escape lands **here**, one boundary short of the key. Zero host filesystem mounts; `sync-to-vm.sh` deliberately never copies `broker/` into the VM. Runs Docker, the Coder OSS control plane (+ Postgres), and all workspace containers.

**(3) Coder workspaces — one plain-Docker container per contractor.** No privileged mode, no sysbox, no docker socket. Named `coder-<owner>-<ws>`, labeled `ai.apoha.devbox.managed=true` + `coder.owner` by the Apoha-owned Terraform template (`main.tf`) with **zero contractor-editable parameters** (`coder_parameters` empty — contractors cannot set labels). Root FS rebuilt from image on every stop/start; only `/home/coder` (a named volume) persists, and it is **destroyed on workspace delete** (offboarding) with no backup. Contractor has passwordless `sudo` inside their own container.

**(4) GitHub — one Apoha-owned App.** Grant: `contents:write` + `pull_requests:write` + `metadata:read` (NO `checks:read`, NO webhooks). Installed on only the assigned repos. The **org branch ruleset** (no force-push/deletion, non-author review required, App on no bypass list; requires the Team plan, now held) is **the actual integrity control** — the only thing that binds the human-with-a-token.

**The push-only credential channel (the whole ballgame).** `gh-app-token.sh` builds an RS256 App JWT signed with the `.pem`, exchanges it for a ~60-min installation token scoped via `{repositories:[...]}` from `repos.map` keyed by the container's `coder.owner` label. `token-broker.sh --once` (every 60s) lists managed containers via `limactl shell` → `docker ps`, checks each `~/.git-credentials` by mtime **and** size (empty = the 401-erase recovery case), and when missing/older-than-40min writes a fresh `https://x-access-token:<ghs_…>@github.com` line over `docker exec -i` **stdin** (never argv, never logged), tmp+atomic-mv, chmod 600. **A brand-new workspace has no credential for up to 60s.** The image bakes `git config --system credential.helper store` (`Dockerfile` L247-251) and a `gh` wrapper that regex-extracts the token from `~/.git-credentials` (`Dockerfile` L194-219) and exports `GH_TOKEN` — so the workspace's `git`/`gh` call GitHub **directly** as the App. `docs/01-architecture.md` L26-36: "The broker pushes; it does not listen. There is no inbound service a workspace could call." Scope is decided **host-side** from `repos.map`; the workspace never asks and never declares scope (empty `REPOS` ⇒ token reaches every installed repo — a documented fail-open footgun; a repo outside the installation fails the whole mint, fail-closed).

**Access plane.** Tailscale Serve (tailnet peers only, no public origin) → Mac `127.0.0.1` → Lima forward → Coder; zero public surface; keyless `coder ssh`. **Workspace containers are NOT tailnet nodes** — the tailnet terminates at the Mac. A container reaches the host only via Lima/Docker NAT (cf. the `CODER_ACCESS_URL 172.17.0.1` workaround), and NAT **collapses all workspaces to one source address**. Dev-server ports are reached via `coder port-forward --tcp` (plain `http://localhost:<port>` origin); path-based `coder_app` is **broken for SPAs** (asset/HMR 404s) and subdomain apps need wildcard TLS that is deliberately unbuilt; port 3000 collides with Coder on the host.

**Where revu plugs in.** revud runs in the workspace, serving its SPA on a loopback port (reached via port-forward — the proven pattern), running the M2 engine against the ambient injected token. The host-side revu **collector** sits beside the token broker on the trusted host, rides the same `docker exec` tick to pull drafts + audit journals bound to `coder.owner`, and holds the durable store. No workspace-callable listener anywhere.

**Display identity vs audit identity (the M3.6 binding).** Everything a workspace self-reports — git-config `user.email`/`user.name`, headers, anything revud-in-workspace sends — is **display-only and spoofable**: the contractor has passwordless sudo inside their container and can set all of it. The only identity signal that crosses the boundary intact is the container's **`coder.owner` label**: set by the host-owned Terraform template (zero contractor-editable parameters) and read host-side off the container being pulled — the workspace never gets to claim it. The collector's binding (`packages/revud/src/collector/identity-binding.ts`) maps that channel-authentic username to the canonical store key: an email normalized via `emailToId` (lowercased/trimmed, matching how the store keys `human_id`), so a Coder username *rename* never reattributes stored history. Re-registration is bounded by offboarding hygiene, not by the keying: the offboarding flow removes the departed human's `repos.map` entry (M3.9), so a later contractor who reuses the freed username is not bound to the departed human's email — a stale map entry would otherwise reattribute. Owner keys match exactly on lookup (case-sensitive, trimmed), but the binding refuses to *construct* if two keys collide case-insensitively (dead config that would silently drop a human) or if two owners normalize to one email (a silent identity merge onto one store/audit key). An unknown or empty owner resolves to `null` — never a fabricated identity — and the resolver's only entry point takes a `coder.owner`, deliberately not an email, so a workspace-claimed address can never mint an audit identity. Audit rows, durable per-human state, and draft-access authorization key off this binding and nothing workspace-reported; the in-gate implementation is an injected in-memory map behind the `CoderOwnerResolver` seam, backed at deployment by the host's `repos.map`/Coder API (M6).

---

## C. Security-boundary map

Ten boundaries, from the runbook. Strength is the runbook's real posture, not the plan's hope.

| # | Boundary | Enforcement / evidence | Strength | What it means for revu |
|---|----------|------------------------|----------|------------------------|
| 1 | **Lima VM** (Apple `vz`, `mounts: []`) — container-escape blast radius | Hardware VM isolation; zero host mounts (`lima-coder.yaml`); files enter only via `limactl copy`; `sync-to-vm.sh` never copies `broker/`; workspaces plain Docker (no privileged/sysbox/socket) | **strong** | Every revu component with audit/identity/draft authority sits on the **host** side of this boundary, like the `.pem`. Nothing security-critical belongs in the VM or a workspace. |
| 2 | **Host-only App key** (`~/.apoha-devbox/gh_app.pem`) | File locality (host only, mode 600); mint scripts host-side only; key never in VM/container/image/repo (checkpoint: `find / -name '*.pem'` in VM is empty) | **strong** | revu never touches the key. But revu's audit log + draft store share this host disk — if it becomes the compliance artifact it inherits the at-rest/backup question (§G). |
| 3 | **Push-only credential channel** (`docker exec`, host→container; NO socket) | Broker initiates all contact via `limactl shell` + `docker exec -i` stdin (never argv); no HTTP service, no port, no unix socket; a workspace cannot request a token or a scope. `token-broker.sh:9` "push, not pull" | **strong** | This is the invariant the guide-§2 proxy HTTP surface collides with head-on. It also *is* the template for revu's fix: the same push tick pulls journals and could push a bearer. **Do not add a workspace-callable listener** without owner sign-off. |
| 4 | **Host-side repo scoping** (`repos.map` keyed by `coder.owner`) | Scope decided at mint on the host; GitHub scopes the token to `{repositories:[...]}`; out-of-installation repo fails the whole mint (fail-closed); workspace never declares scope | **strong** | Per-human differentiation at GitHub is **scope only**, never authorship. revu's shared caches must be **scope-partitioned** by `repos.map` — never serve workspace A a blob from a repo only B is scoped to. |
| 5 | **In-workspace token custody** (`~/.git-credentials`, contractor-readable by design) | Mode 600, coder-owned, atomic tmp+mv; ~1h TTL, refreshed after 40min; deliberately NOT hidden — README "Honest limits": "worthless to steal" (scope + expiry + one-click revocation, not secrecy) | **weak (by design)** | The pivot of the whole analysis: any revu control phrased as "the workspace cannot reach GitHub except via the broker" is **false** here. revu must treat the ambient token as a parallel, uncontrolled write path — bot-identity comments can bypass revu entirely. |
| 6 | **Managed Claude Code policy** (`/etc/claude-code/managed-settings.json` denies agent reads of `~/.git-credentials`) | System path outside the home volume (reapplies on rebuild), outranks user/project settings, jq-validated at build | **convention** | Bounds a prompt-injected **agent**, not the human (passwordless sudo; Cursor ignores it). The pattern matters for revu: anything that must survive rebuild belongs at a **system path** — same rule for revud packaging. |
| 7 | **GitHub-side authorization** (single App identity + org branch ruleset) | GitHub enforces token scope + App permissions per call; ruleset blocks force-push/deletion, requires non-author review on default/release, App on no bypass list | **strong** | The review gate revu serves **is** this ruleset. All contractors collapse to **one bot identity** at GitHub — revu's stamp/audit is the ONLY per-human attribution in existence. Verify every RevuApi call fits the real grant (`checks:read` absent — §E.3). |
| 8 | **Tailnet perimeter + Coder keyless access** | Tailscale Serve → `127.0.0.1` → Lima forward → Coder; contractors get no SSH keys — Coder brokers sessions bound to the authenticated Coder user; kill-switches: suspend Coder user, revoke tailnet device | **strong** | Workspaces are **not tailnet nodes**. Guide §6's `REVU_BROKER_URL=broker.tail<net>.ts.net` and M6.2's "tailnet ACL for the broker port" rest on a wrong topology: container→host is Lima/Docker NAT, which collapses all workspaces to one source — so neither "tailnet source" nor per-container source-IP can authenticate a workspace to a host listener. |
| 9 | **Container-to-container isolation** (shared docker bridge) | Default Docker namespace isolation; different contractors' containers share the VM kernel and (per the standard Coder docker template) a bridge network; no per-workspace network policy described | **unclear** | Direct M3/M6 risk: a revud bound to `0.0.0.0:4780` may be reachable by another contractor's container over the bridge, exposing session/drafts. **revud must bind `127.0.0.1`** (the port-forward agent is co-resident, so loopback suffices) — §E.7, §F new-ticket (c). |
| 10 | **Audit/attribution layer** (the seam revu fills) | TODAY effectively none: broker log records only "refreshed `<ws>` (owner=X)" at issuance; git author is workspace-writable config; GitHub records every write as the App; Coder OSS has no audit log; SSH/session logs stay on-box, rotate, die with the container; GitHub git-audit retention is 7 days | **weak** | Confirms revu's raison d'être (the sandbox names this exact gap as promised-but-unbuilt). The bar: revu's audit binding derives from a **host-side / host-pushed** identity (`coder.owner`→email), never workspace-claimed — and must be honest that ambient-token writes can bypass it. |

---

## D. Gap analysis

Thirteen findings comparing the plan's assumptions to the runbook reality, with the corrected disposition given the 7 owner decisions (§E). Verdicts: **contradicted** (plan assumption is false in this deployment), **gap** (plan under-specifies a real problem), **confirmed** (plan is right), **missing-ticket** (real problem with no plan coverage).

1. **M3.2 token custody — CONTRADICTED (high).** Plan: broker proxies all GitHub calls; "workspace never holds a token." Reality: mint-and-inject; the workspace holds a live ~1h repo-scoped token and calls GitHub directly. *Disposition (§E.1, F/M3.2):* invert to inject-default `FileCredentialTokenSource`; keep proxy-fetch as an optional §5 strategy; custody claim becomes "revu adds no new credential and never serializes tokens."
2. **Guide §2 broker HTTP surface "on the tailnet" + M6.2 — CONTRADICTED (high).** Plan: broker grows a tailnet-only HTTP API the workspace calls. Reality: the sandbox's load-bearing invariant is zero inbound surface a workspace can call — the owner deliberately refused exactly this; and workspaces are not tailnet nodes. *Disposition (§E.1, F/§6, M6.2):* drop the tailnet broker + ACL entirely; push-only collector rides the tick.
3. **M3.6 workspace→broker auth — GAP → resolved (high).** Plan: channel identity from "tailnet source / mTLS / per-workspace bearer." Reality: tailnet-source impossible (not tailnet nodes; NAT erases per-container source); mTLS has no provisioning path. *Disposition (§E.1, F/M3.6):* re-frame to push-only — there are **no** workspace→broker calls to authenticate; identity = `coder.owner` per container, channel-authentic via the tick. Drop tailnet-source + mTLS.
4. **Guide §1 identity from git config — CONFIRMED (medium).** `main.tf` injects `user.name` = Coder username and `user.email` = Coder account email — but into the contractor-writable home volume, and `main.tf` labels them "attribution, not a control." *Disposition (§E, F/M3.5):* keep email as the durable Human.id, but source it **host-side** (`coder.owner`→email map / Coder API), never from what the workspace reports.
5. **M3.4 stamping + audit as attribution — GAP → resolved (high).** Plan: broker stamps every write; "the broker knows exactly which human wrote comment X." Reality: the ambient token (`pull_requests:write`) lets any contractor post bot comments directly, bypassing the broker. *Disposition (§E.2, F/M3.4):* audit = provenance of mediated writes **plus** an out-of-band detector (new ticket); **no** permission split (owner kept the token whole).
6. **M3.5 durable per-human state — CONFIRMED (medium).** Container root FS dies each stop/start; `/home/coder` survives rebuild but is destroyed on workspace **delete** (offboarding), un-backed-up. *Disposition (§E.4/E.5, F/M3.5):* build host-side, keyed by channel-derived email; add an offboarding retention/purge hook.
7. **M3.3 reads + shared caches — GAP → resolved (medium).** Net-new host-side surface with two frictions: reads-via-broker inherit the channel problem; a naive shared cache leaks cross-scope blobs. *Disposition (§E.1, F/M3.3):* reads run in-workspace on the ambient token (cheaper path); the host shared cache is **de-prioritized** (value shrinks to cross-workspace warm-sync) and if kept MUST be scope-partitioned by `repos.map`.
8. **M3.1 scratch App fidelity — GAP → resolved (medium).** Plan's scratch App includes `checks:read`; the real grant is `contents:write` + `pull_requests:write` + `metadata:read` only — guide §3 step 5 (`check-runs`) would 403 on-prem while passing against a too-generous scratch App. *Disposition (§E.3, F/M3.1):* the owner **adds `checks:read`** to the real App; scratch App byte-identical to the corrected real grant; add a per-method → permission matrix.
9. **Guide §6 port exposure — CONTRADICTED (medium).** Plan: register 4780 as a named `coder_app`. Reality: path-based `coder_app` is broken for SPAs; the proven path is `coder port-forward --tcp`. *Disposition (§E.7, F/§6):* drop the named-app instruction; document `coder port-forward --tcp` on one port; add the bind-`127.0.0.1` security half.
10. **Guide §6 revud packaging — CONFIRMED (low).** Home-volume seeding happens only once and never propagates updates. *Disposition (F/§6, new-ticket f):* bake revud + built dist at a **system path** (`/opt/revu`); no revu state under `/home/coder` is authoritative.
11. **M0–M2 premise (disposability + direct engine) — CONFIRMED and STRENGTHENED (low).** Root FS rebuilt every stop/start; repo cloned in-workspace (local `git cat-file` works against the injected credential); the inject verdict means broker mode reuses **even more** of M2 than planned. *Disposition:* no change to M2; bank the simplification.
12. **TokenSource robustness — MISSING-TICKET (medium).** No ticket covers consuming an externally-rotated credential: ~40min rotation, 60s cold gap, 401-erases-the-file. *Disposition (F/new-ticket a):* add `FileCredentialTokenSource` robustness + a conformance scenario that rotates the credential file mid-sync.
13. **M5.4 security-review claims — GAP → resolved (high).** All three claims are achievable **only** under the corrected model: browser-never-sees-token holds (revud keeps it server-side in-workspace); audit identity must come from `coder.owner` (not workspace-claimed); draft isolation must be authorized by the channel binding, not by a `:email` path parameter (as specced, any workspace could `GET /v1/drafts/<any-email>/<n>`). *Disposition (§E, F/M3.5, M5.4):* authorize draft access by the `coder.owner` binding; add the honest statement that ambient-token writes can bypass revu (detection, not prevention).

---

## E. The 7 owner decisions

The owner reviewed the findings and made 7 decisions. These are authoritative and drive the corrected plan (§F).

1. **Topology = push-only, in-workspace engine.** revud runs IN the workspace on the ambient injected token — the M2 direct engine (reads + writes + reconcile) via a file-credential `TokenSource` — plus a **local audit journal**. A thin host-side **"revu collector"** (beside the token broker) rides the existing `docker exec` tick to **pull** each container's drafts + audit journal (bound to `coder.owner` = channel-authentic), runs the out-of-band-write detector, and holds the durable per-human store. **No workspace-callable inbound surface** — this preserves the sandbox's deliberate zero-inbound invariant.
   *Rationale:* the proxy is the exact service the owner refused; the workspace already holds a token; the push tick already exists and is the only channel-authentic primitive.

2. **Audit = provenance + detection.** Keep the injected token as-is (contractors keep direct `gh`). revu's audit log is authoritative for writes it mediates; a host reconciler flags any App-authored comment/review absent from any journal (the out-of-band detector). **NO permission split.**
   *Rationale:* dropping `pull_requests:write` from the injected token would break contractors' `gh pr create`/comment workflows; the owner prefers detection over that friction. revu is honest that this is detection, not prevention.

3. **App grant = add `checks:read`.** The real App becomes `contents:write` + `pull_requests:write` + `metadata:read` + `checks:read` (owner adds `checks:read`). Add a per-RevuApi-method → App-permission matrix.
   *Rationale:* guide §3 step 5 reads check-runs; `checks:read` is small and read-only; adding it to the real App keeps the scratch App byte-identical and lets conformance fail early on any over-reach.

4. **At-rest = ops-owned.** revu writes host-side SQLite; backup / at-rest / FileVault are the **sandbox operator's** responsibility — a cross-boundary **dependency**, NOT an M3 revu ticket.
   *Rationale:* the sandbox admits it has no backups and an unsettled FileVault state; that is an operations-layer decision, not something revu code can own.

5. **Offboarding = retain audit, purge drafts.** The offboarding hook keeps audit rows (compliance) + purges drafts/viewed.
   *Rationale:* the operating agreement's wipe clause applies to work-in-progress (drafts), while the audit record is the compliance artifact that must outlive the contractor.

6. **Ruleset = leave as-is; revu adapts.** The stale-approval settings ("dismiss stale approvals on push", "require approval of most recent push") stay OFF; revu surfaces stale approvals honestly (no client change). Record the residual: the approve-then-push-then-merge gap is **outside revu's control**.
   *Rationale:* the owner does not want to change the org ruleset now; revu shows the truth rather than pretending approvals track heads.

7. **Container isolation = revu loopback is enough for now.** revud binds `127.0.0.1`; cross-container reachability is recorded as a known residual; per-container network policy is a **sandbox recommendation**, not done.
   *Rationale:* binding loopback removes revu from the cross-container threat class entirely (the port-forward agent is co-resident); the broader bridge-isolation question is the sandbox's to answer.

---

## F. The corrected M3 plan

Per ticket. The through-line: broker mode is **not** a GitHub proxy — it is the M2 engine in-workspace on the ambient token, plus a host-side collector for identity/audit/durable-state that rides the existing push tick.

**M3.1 — scratch App + org.** App grant = `contents:write` + `pull_requests:write` + `metadata:read` + `checks:read`; **NO webhooks** (poll-only is correct). Scratch App **byte-identical** to the corrected real grant (owner adds `checks:read` — §E.3). Add a per-RevuApi-method → permission matrix: verify `pull_requests:write` covers reviews, review-comment replies, resolve mutations, and reactions; confirm PR **issue-comment reads** (`/issues/{n}/comments`) fit the grant (or note the `issues` permission if not).

**M3.2 — token custody (INVERT to inject-default).** A `FileCredentialTokenSource` reading `x-access-token` from `~/.git-credentials` (parse `https://x-access-token:<tok>@github.com`), **re-read per request** (never cached for process lifetime), tolerant of ~40min rotation + the 60s cold-start gap + the 401-erase-of-the-file (surface a typed "awaiting credential" state; `error-copy.ts` `broker_unreachable` semantics are reusable). Keep the proxy-fetch `TokenSource` as an **optional §5 strategy**. Custody claim: **"revu adds no new credential and never serializes tokens"** (NOT "the workspace never holds a token"; the `ghs_`-grep verify stays valid).

**M3.3 — reads + caches.** Reads run **in-workspace** on the ambient token (M2 engine + local-git blobs). The host shared cache is **de-prioritized** (its value shrinks to cross-workspace warm-sync) and if kept MUST be **scope-partitioned by `repos.map`** (no cross-scope blob leak). Don't over-invest before the topology is settled — it is settled push-only, so in-workspace reads are the cheaper and correct default.

**M3.4 — writes + stamping + audit.** Writes run **in-workspace**: revud posts on the ambient token, stamps the body via `WriteDecorator` (`prefixBody(human)`), and journals locally. The host collector **pulls** journals (`coder.owner`-bound) and runs the **out-of-band-write detector** (reconcile App-authored comment/review ids on GitHub against the journals; anything absent = an out-of-band write). Audit = **provenance** of mediated writes + **detection** of out-of-band. **NO permission split** (§E.2).

**M3.5 — durable per-human state.** Host-side store keyed by the **channel-derived email** (host-side `coder.owner`→email map / Coder API — **never** workspace-claimed), pulled over the tick. Note `/home/coder` persists across stop/start (rebuild is covered by the volume; the host store covers **offboarding** + cross-workspace). Access authorized by the **`coder.owner` binding**, NOT by a path `:email` parameter (drop the `/v1/drafts/:email/:n` authorize-by-path shape — it lets any workspace read any human's drafts). At-rest = ops-owned dependency (§E.4).

**M3.6 — workspace→broker auth (RE-FRAME to push-only).** There are **no** workspace→broker calls to authenticate. Identity = `coder.owner` per container (channel-authentic via the tick — the host knows which container it pulled from). **DROP** tailnet-source + mTLS (infeasible/moot). No inbound bearer needed. Document the trust boundary: display identity is workspace-reported (git config), audit identity is the `coder.owner` binding held host-side.

**New M3 tickets:**
- **(a) `FileCredentialTokenSource` robustness + conformance.** Re-read per request; on 401 re-read-then-backoff; conformance scenario that **rotates the credential file mid-sync**.
- **(b) Out-of-band-write detector.** Host reconciles GitHub App-authored comments/reviews against the pulled journals; flags any id absent from every journal.
- **(c) revud binds `127.0.0.1` + an e2e assertion** (removes revu from the cross-container threat class).
- **(d) Host-side "revu collector" component.** Pulls drafts + journals over the tick, holds the `coder.owner`→email binding, owns the durable store. This is the sandbox **adapter**; revu core stays generic.
- **(e) Offboarding retention/purge hook.** Retain audit rows, purge drafts/viewed (§E.5).
- **(f) Serve via `coder port-forward --tcp` on ONE port + bake revud + built dist at `/opt/revu`** (a system path — home-volume seeding never propagates updates).

**§6 / M6.2 corrections.** DROP "broker on the tailnet" (`REVU_BROKER_URL=broker.tail<net>.ts.net`) and "tailnet ACL for the broker port" — wrong topology: workspace containers are NOT tailnet nodes; container→host is Lima/Docker NAT that collapses all workspaces to one source address. Named `coder_app` path-apps are broken for SPAs → use `coder port-forward --tcp`. Bake revud + built dist at `/opt/revu`. M6.2 becomes the collector-deployment + tick-integration ticket, not a tailnet-path ticket.

**M5.4 — security-review claims HOLD under the corrected model.** Browser never sees the token (revud keeps it server-side in-workspace); audit identity = `coder.owner`, not workspace-claimed; draft isolation by the `coder.owner` binding. **ADD an honest statement:** ambient-token writes can bypass revu → the audit layer is **detection, not prevention**.

---

## G. Sandbox recommendations for the owner

These are owner/ops-actioned items, **NOT revu tickets** — cross-boundary dependencies revu depends on but does not own.

- **Add `checks:read` to the real App** (owner-decided — §E.3; small, read-only; keeps the scratch App byte-identical and unblocks CI-status reads at guide §3 step 5).
- **Ruleset stale-approval settings stay off** (owner-decided — §E.6); revu adapts and surfaces stale approvals honestly. **Residual recorded:** approve-then-push-then-merge is possible and is outside revu's control.
- **Container-to-container network policy deferred** (owner-decided — §E.7); revu's loopback bind is sufficient for revu itself. **Residual recorded:** cross-container reachability on the shared docker bridge remains a threat class for anything else on workspace ports; a per-container network policy is a sandbox recommendation, not done.
- **At-rest / backup / FileVault for the audit log = ops layer** (owner-decided — §E.4). revu writes host-side SQLite; the sandbox operator owns backup and encryption-at-rest. **Dependency, not an M3 revu ticket.**

---

## H. What the plan got right / wrong / missing

**Right — do not re-litigate:**
- **The strategy seam.** Mode = an injected `TokenSource` + `WriteDecorator` pair around one shared engine (guide §5). This is exactly the abstraction that makes the inject correction cheap — the inject `TokenSource` slots in where the proxy one was assumed.
- **The M2 direct engine as the shared core.** Confirmed and strengthened: in the inject deployment, the in-workspace engine on the ambient token **is** most of broker mode. M2 needs no change.
- **Durable per-human state is a real requirement** (M3.5). Container root FS dies each rebuild; `/home/coder` dies at offboarding; the host is the right home.
- **revu's raison d'être.** The sandbox names the exact audit/attribution gap revu fills as promised-but-unbuilt (all writes collapse to one App identity). revu's stamp/audit is the only per-human attribution that will exist.
- **Poll-only, no webhooks.** Correct for this App grant.
- **System-path packaging instinct** (`/opt/revu`). Matches the sandbox's own `managed-settings.json` precedent.

**Wrong — corrected by §F:**
- **The proxy topology** (guide §2, M3.2). The workspace holds a token and calls GitHub directly; there is no proxy and no broker HTTP surface. Inverted to inject-default.
- **The tailnet broker + ACL** (guide §2, §6, M6.2). Workspaces are not tailnet nodes; NAT collapses source identity; the owner refused the inbound service. Dropped.
- **M3.6's channel-auth decision space** (tailnet-source / mTLS). Both infeasible. Re-framed to push-only `coder.owner` identity — no workspace→broker calls exist.
- **The scratch App's `checks:read`** relative to the *then-current* real grant. Resolved by the owner adding `checks:read` to the real App so the two match.
- **Named `coder_app` port registration** (guide §6). Broken for SPAs. Use `coder port-forward --tcp`.
- **M3.5's authorize-by-`:email`-path shape.** Any workspace could read any human's drafts. Authorize by the `coder.owner` binding.

**Missing — new tickets in §F:**
- `FileCredentialTokenSource` robustness against the externally-rotated credential (rotation, cold gap, 401-erase).
- The out-of-band-write detector (the only path to a trustworthy audit while the injected token keeps `pull_requests:write`).
- revud binding `127.0.0.1`.
- The host-side revu collector (the sandbox adapter).
- The offboarding retention/purge hook.
- One-port `coder port-forward --tcp` serving + `/opt/revu` baking.

The verdict stands: **GO for M3 under the corrected plan.** The topology correction is a simplification, not a setback — the genuinely new M3 code is identity, audit, durable state, and a collector that rides a channel that already exists.

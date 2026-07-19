# revu — implementation runbook for the remaining work

## 1. Purpose + how to use

This is the execution plan for the **remaining revu work** — the 44 Backlog tickets left after the M4+M5+M7 train merged to `main`. It is written for the client-office **sandbox sessions**: a couple of focused sittings on the real Coder/sandbox environment, where the on-prem deployment finally gets proven. Its central job is to **separate the work that is blocked on the sandbox from the work that is not**, so the not-blocked cleanup can be knocked out in any session while the sandbox-only work waits for the host. Tickets are referenced by **UZO-ID + M-ID** (e.g. `M6.2 / UZO-616`); those M-IDs are the durable cross-session anchor and stay valid even after `M7.6` retires the tracking docs. Work each track top-to-bottom; every step has a concrete done-check.

> **Read the corrected plan, not the stale subs.** The M6 **parent** milestones were corrected by `docs/agent/CHECKPOINT_2.md`, but several M6 **sub-issues** still describe the OLD proxy + tailnet topology that CHECKPOINT_2 rejected. Where a sub says "tailnet ACL", "broker address", "Lima reachability", or "named Coder app", **do not follow it literally** — follow the CORRECTED approach in Track A below and re-decompose the subs on pickup.

## 2. Current state

**Done + merged to `main` (PRs #43–#58):**

- **MT, M0, M1, M1.6, M2** — all exit criteria proven (TDD gate, transport seam, frontend punch list, reconcile/surface hygiene, direct mode against the scratch repo).
- **M3 (broker engine) in-gate portions** — in-workspace read/write/reconcile on a `FileCredentialTokenSource`; stamping + local audit journal + out-of-band detector; the binding-authorized host store; the collector merge core; the `coder.owner` binding; offboarding retain-audit/purge; audit export; loopback bind.
- **M4 (live layer) in-gate portions** — poll loop, `commentAuthors`, `BrokerPullMeta` (`canApprove` derived now; `authorHumanId` seam shipped, population rides M6).
- **M5 (hardening) in-gate portions** — failure drills, security review write-up, docs (`docs/operator-runbook.md`).
- **M7 docs work** — M7.1 media, M7.2 README, M7.3 Fumadocs, M7.4 content, M7.1.5 GIFs, M7.9 docs theme, M7.10 light mode.

**What remains — two tracks:**

- **Track A — sandbox-blocked:** everything that needs the real Coder host / Lima VM / scratch org — M3.1, the live conformance legs (M5.1.4/.5), M6.1–M6.5, and the M3/M4 live exit criteria that were deferred because they need a real org with member accounts.
- **Track B — in-gate, NOT blocked:** the open-source cleanup pass (M7.5 → M7.6 → M7.7 → M7.8) plus the two browser-perf checks (M5.3.3/.4). None of these touch the sandbox.

## 3. The two tracks (the key framing)

### Track A — Sandbox-blocked (the client office)

Requires the real Coder host / sandbox / scratch org. **Nothing here can be closed off-prem.** In dependency order: **A0 prerequisite code change** (off-sandbox first) → **M3.1** (scratch App + org) → **M5.1.4/.5** (live conformance legs) → **M6.1 → M6.2 → M6.3 → M6.4 → M6.5**. Closing A2 + M6 also closes the deferred **M3 and M4 live exit criteria** (scratch-org conformance, org-member interleave, `canApprove`-true-on-org-PRs, two-human liveness).

### Track B — In-gate, NOT blocked (any session, now)

**These are NOT blocked on the sandbox and can be executed independently, today, on any checkout.** They are the open-source readiness cleanup:

- **M7.5 / UZO-818** — verify all docs against the implementation (accuracy pass).
- **M7.6 / UZO-819** — retire/rework internal repo docs.
- **M7.7 / UZO-820** — remove/scrub the `.claude/` admin harness.
- **M7.8 / UZO-821** — open-source hygiene scaffolding + final secrets sweep.

Plus two checks that need only a **real browser**, not the sandbox:

- **M5.3.3 / UZO-745** — virtualized-scroll jank on the large diff.
- **M5.3.4 / UZO-747** — confirm the Shiki worker does not block first paint.

Ordering within Track B matters (see §5) — but its blocker is a browser and a frozen doc surface, never the Coder host.

---

## 4. Track A — the sandbox session plan (execution order)

Corrected throughout to CHECKPOINT_2's MINT-AND-INJECT topology. Source steps: `docs/operator-runbook.md` (shipped install steps), `docs/agent/CHECKPOINT_2.md` §B/§E/§F, `docs/agent/MILESTONES.md` M3/M5/M6.

### A0. Prerequisite code change — do OFF-sandbox first

- **Ticket:** the UZO-724 partial-sync landmine (prep for the live leg-C runner; no standalone ticket — fold into M5.1.4).
- **What it does:** splits the conformance suite's partial-sync scenario into a **transport-agnostic** assertion + a **per-leg surfacing** assertion, so the live legs can run it.
- **Why (the landmine):** `packages/shared/conformance/suite.ts` (the "partial-sync resume" describe) asserts the first sync **throws** a `network` `ApiError` while keeping a partial snapshot (`expect(code).toBe('network')`). That throw is a mock/HTTP-transport artifact. Against a **live** direct/broker engine hitting real GitHub, a mid-transfer drop resolves the sync with `snapshot.partial` set (it does not throw `network`). Run the suite as-is against the live leg and it fails on transport shape, not on behaviour.
- **Approach:** keep one shared assertion on the **outcome** (a partial is kept; the retry fetches only the missing blobs and completes with `partial: null`) that holds for every transport; move the "throws `network`" expectation into a **per-leg surfacing** hook that the mock/HTTP legs assert and the live legs express as "sync resolves with a non-null `partial`". Do this **before** A2 runs the suite live.
- **Done-check:** the existing mock + revud-HTTP conformance legs stay green; the split assertion is transport-parameterized; `bun run check` green. Merge this first.

### A1. M3.1 — Scratch App + org · **UZO-575** (subs 635, 637, 640, 643, 580)

- **What it does:** stands up a scratch GitHub **App** + scratch **org** with ≥2 member accounts, seeds fixture scenarios, opens an org-member PR, and documents the client-facing App-creation runbook. This is the substrate every later Track-A step reads from.
- **Prerequisites:** none on-sandbox except org-admin rights; the scratch org cannot be stood up off a personal repo, which is why it was deferred to the on-prem session.
- **Corrected approach (CHECKPOINT_2 §E.3, §F/M3.1):**
  - App grant **byte-identical to the real App**: `contents:write` + `pull_requests:write` + `metadata:read` + `checks:read`. **No webhooks** (poll-only is correct). `checks:read` was added to the real App so guide §3 step-5 `check-runs` reads don't 403 on-prem — the scratch App must match so conformance fails early on any over-reach.
  - Seed with the shipped `scripts/seed-scratch.ts` (idempotent; hard-guarded to a `sandbox`/`scratch`/`fixture`-marked allow-listed target — see `docs/operator-runbook.md`).
  - Open **one PR from a real org-member account** distinct from the App — the org-member-interleave / `canApprove`-true proof.
  - Produce a **per-RevuApi-method → App-permission matrix** (verify `pull_requests:write` covers reviews, reply comments, resolve mutations, reactions; confirm PR issue-comment reads fit the grant) + the client-facing App-creation/permissions doc (UZO-580).
- **Done-check:** App installed on the scratch org with the exact 4-permission grant and no webhooks; fixtures seeded (clean/large/mid-review/base-advance/force-push); an org-member-authored PR exists; the permission matrix has no unverified rows.

### A2. Live conformance legs — **M5.1.4 / UZO-724** (direct vs scratch repo) + **M5.1.5 / UZO-725** (broker vs scratch org)

- **What it does:** runs the conformance suite as the release-matrix **live** legs, closing the M5 live legs **and** the deferred **M3/M4 live exit criteria** (scratch-org conformance, org-member interleave with genuine identity, `canApprove` true on org-member PRs / false on App-authored).
- **Prerequisites:** A0 (partial-sync split) merged; A1 (scratch App + org seeded). M5.1.4 needs a **`GH_TOKEN` secret** (the `gh` user); M5.1.5 needs the **M3.1 scratch org** + the injected credential.
- **Corrected approach:**
  - **M5.1.4 (direct):** the direct `TokenSource` = the `gh` user (`gh auth token` / `GH_TOKEN`), owner/repo from `origin`. This is NOT the App — the App/`.pem` path is broker-only (see the M2 auth landmine). Point it at the seeded scratch repo.
  - **M5.1.5 (broker):** run revud in `REVU_MODE=broker` in a workspace against the scratch org, reading + writing + reconciling in-workspace against a `FileCredentialTokenSource` on the ambient injected token. Set `REVU_BOT_LOGIN=<slug>[bot]` to enable writes (without it, writes stay 501). There is **no proxy and no workspace-callable listener** — the workspace's `git`/`gh` call GitHub directly as the App.
- **Done-check:** both legs green; every write on github.com shows the stamped prefix and round-trips through the parser; org-member comments interleave with genuine identity; `canApprove` true on org-member PRs and false on App-authored ones; the partial-sync scenario passes under its per-leg surfacing.

### A3. M6.1 — Host-side revu collector deployment · **UZO-614** (subs 740, 742, 744, 746, 748)

- **What it does:** deploys the M3.7 collector + token broker on the macOS host: a launchd service and a host SQLite location for the audit/draft store.
- **Prerequisites:** A1 (App key + install on the host), the host with the existing token-broker tick.
- **Corrected approach (CHECKPOINT_2 §E.4, §G; `docs/operator-runbook.md` Host collector):**
  - Host store lives in a **dedicated `host.sqlite`** (never a workspace's direct store), default `${XDG_DATA_HOME:-~/.local/share}/revu/host`, overridable via `REVU_HOST_DATA_DIR`.
  - Identity resolves through `REVU_OWNER_MAP_FILE` (`coder.owner` → `{email, displayName?}`), the in-gate stand-in for the real `repos.map`/Coder API behind the same `CoderOwnerResolver` seam.
  - **At-rest / backup / FileVault for the audit log is an OPS-owned dependency, NOT a revu deliverable.** Confirm the operator's backup + encryption-at-rest plan for `host.sqlite`; record it. revu only writes host-side SQLite.
- **Done-check:** the collector launchd service runs beside the token broker; `scripts/broker-audit.ts` runs against the host store; the operator has a written backup/at-rest plan.

### A4. M6.2 — Collector on the `docker exec` push tick · **UZO-616** (subs 750, 752, 754, 756) — **CORRECTED**

- **What it does:** wires the collector into the existing 60s `docker exec` tick so it PULLS drafts + audit journals from each managed container (`coder.owner`-bound), lands them in the host store, and runs the out-of-band detector over the merged union.
- **⚠ Subs 750/752/754/756 are STALE** — they describe a tailnet ACL / broker address / Lima reachability for a workspace→host listener. **That topology was REJECTED. Re-decompose on pickup.**
- **Corrected approach (CHECKPOINT_2 §E.1, §F/§6, §B):**
  - **DROP** `REVU_BROKER_URL=broker.tail<net>.ts.net`, the tailnet ACL for a broker port, and any workspace→host listener. Workspace containers are **NOT tailnet nodes** (the tailnet terminates at the Mac); container→host is **Lima/Docker NAT** that collapses all workspaces to one source address — so no per-container source can authenticate a workspace to a host listener anyway.
  - The collector reaches **into** containers from outside the VM, exactly like the token broker — **push-only, no inbound surface**. There is no workspace-callable revu port anywhere.
  - Identity is the `coder.owner` container label, channel-authentic via the tick; the host store **re-keys every landed record** to the `coder.owner`→email binding and discards workspace-claimed identity. The detector runs over the merged union (`listAuditUnion`), per-PR, **after all containers land** — never per-container — and the host tick MUST pass the complete open-PR set via `extraPrNumbers`.
- **Done-check:** the collector pulls state from a container with **no inbound surface exposed on the host**; no workspace-callable revu port exists anywhere; a draft written in a container lands in `host.sqlite` keyed by the channel-derived email; a comment posted by a direct `curl` on the ambient token is flagged by the out-of-band detector as absent from every journal.

### A5. M6.3 — Coder template + image wiring · **UZO-617** (subs 758, 760, 763, 765, 766) — **CORRECTED**

- **What it does:** bakes revud into the workspace image and wires startup so the SPA + API are reachable.
- **⚠ Sub 763 is STALE** — it describes a **named `coder_app`**. Path-based `coder_app` is broken for SPAs (asset/HMR 404s, no wildcard TLS) and port 3000 collides with Coder. **Re-decompose on pickup.**
- **Corrected approach (CHECKPOINT_2 §E.7, §F/§6; `docs/operator-runbook.md` Loopback binding):**
  - Bake revud + built `dist/` at the **system path `/opt/revu`** — home-volume (`/home/coder`) seeding happens once and never propagates updates, so no revu state under `/home/coder` is authoritative.
  - Startup serves `dist/` (never `vite dev`), bound to **`127.0.0.1`** (loopback removes revu from the cross-container threat class on the shared docker bridge; the port-forward agent is co-resident). Note: `127.0.0.1` is IPv4-only — a forwarder dialing `localhost`→`::1` would miss it.
  - Access via **`coder port-forward --tcp` on ONE port** — **not** a named `coder_app`.
  - Confirm the **injected git identities parse** under the real username population (M1.2 charset: letters/digits/`_`/`-`) — a Coder username like `alice2`/`j_doe` must render as the human, not the bare bot.
- **Done-check:** `coder port-forward --tcp` serves the SPA + API end-to-end on one mapping; an e2e assertion confirms revud is **unreachable from a second container** over the bridge; real injected git identities parse to the human in threads/inbox.

### A6. M6.4 — Two-human end-to-end · **UZO-619** (subs 767, 768, 769, 770, 771)

- **What it does:** the invariant proof — two contractors (two browser profiles / two workspaces), one PR, **independent drafts**, both submit, **both stamped correctly**, the audit log **distinguishes them**, and drafts **survived a mid-test workspace rebuild** for one of them.
- **Prerequisites:** A2–A5 all green.
- **Approach:** drive two real workspaces against one scratch-org PR; verify stamping and audit attribution end-to-end; stop/start one workspace mid-test and confirm the draft reappears from the host store via a fresh revud instance.
- **Done-check:** all five invariants above observed live; audit rows for the two humans are distinct and correctly bound to their `coder.owner`; the rebuilt workspace's draft is intact.

### A7. M6.5 — Client acceptance + sign-off · **UZO-621** (subs 772, 773, 774, 775, 776)

- **What it does:** walk the client's lead through the acceptance surface, then close the milestones.
- **Approach:** demonstrate (1) org-member review **interleave** on github.com with genuine identity; (2) the **approve-on-github** workflow for App-authored PRs (guide §2.1 gating — revu surfaces stale approvals honestly; the approve-then-push-then-merge gap is outside revu's control, an owner-accepted residual); (3) **audit export** = provenance + the out-of-band-write detector (`scripts/broker-audit.ts`); (4) the **exposure surface** — revud loopback-bound, collector push-only, no workspace-callable listener, injected token "worthless to steal" (scope + expiry + one-click revocation).
- **Done-check:** client sign-off recorded; **close M3, M4, M5, M6** (their live-deferred exit criteria are now satisfied by A2 + M6.4/M6.5).

---

## 5. Track B — in-gate cleanup (execution order)

Not blocked on the sandbox. **Order is load-bearing.** M7.6/M7.7 must run **LAST** because agents rely on `docs/agent/*` and the `.claude/` harness during any remaining build; M7.5 needs the doc surface **frozen** first.

1. **M7.5 / UZO-818 — verify all docs against the implementation.** Adversarial accuracy pass over the README + docs site: every claim, command, flag, env var, route, and keyboard shortcut traced to code and confirmed or corrected. **Depends:** the doc surface frozen (M7.2 + M7.4, both merged). Highest-risk claims to hold: direct-mode auth is the `gh` user (not the App); broker mode is reserved/not a boot option in the public docs; `/api/dev` is mock-only; `submitReview` `head_moved` is a **200 value**; `getSnapshot` returns `null` (not a thrown 404); drafts survive everything and are deleted only on confirmed submit success. **Done-check:** every statement tied to a code referent; commands run as written; gate green; a short corrections report.

2. **M7.6 / UZO-819 — retire/rework internal repo docs.** Delete `docs/agent/MILESTONES.md`, `CHECKPOINT_1.md`, `docs/branch-protection.md`; rework `INTEGRATION_GUIDE.md` → public architecture reference; `AGENTS.md` → `CONTRIBUTING.md`; trim `DESIGN.md`; rewrite `docs/README.md` into a clean index. **Depends:** M7.4 (content absorbed) + M7.5. **Runs after the last build.** **Done-check:** `grep -rn "/Users/patmw" .` clean; no `docs/agent/` tracking artifacts remain; valuable technical content survives in public form; gate green.

3. **M7.7 / UZO-820 — strip the `.claude/` admin harness.** Extract the durable content first — product invariants (`memories/hard-constraints.md`) → a public architecture-constraints doc; GitHub/API + bun-test + e2e gotchas (`memories/known-landmines.md`) → a public gotchas doc (drop App id/installation, scratch-repo guard, `UZO-`/CHECKPOINT refs) — then remove `.claude/skills/revu/` + memories and gitignore transient session artifacts. **Depends:** M7.6. **Runs LAST** (agents lean on `.claude/` throughout any build). **Done-check:** scrubbed content present publicly with no internal Linear URLs/App ids/tracking ids; harness no longer ships; `.claude/` transient artifacts gitignored; gate green.

4. **M7.8 / UZO-821 — open-source hygiene + final secrets sweep.** LICENSE (owner-chosen) + README badge; CONTRIBUTING (from M7.6), CODE_OF_CONDUCT, SECURITY.md; `.env.example` covering every referenced env var (`VITE_REVU_API`, `REVU_DATA_DIR`, `REVU_DIST_DIR`, `REVU_PORT`, `REVU_REPO`, `REVU_MODE`, `GH_TOKEN`, `GITHUB_TOKEN`, `E2E_CHROME_PATH`); CODEOWNERS, issue/PR templates, CI-status badge; final secrets/personal-info sweep. **Done-check:** all hygiene files present and linked from the README; `.env.example` covers every env var read by code/tests; sweep documented clean; templates render in the GitHub UI; gate green.

### Also in-gate — browser only, not the sandbox

- **M5.3.3 / UZO-745** — check virtualized scrolling for jank on the large diff (2,000+-line fixture). Needs a real browser, not the sandbox. Slot into any browser-capable session.
- **M5.3.4 / UZO-747** — confirm the Shiki worker does not block first paint. Same — real browser only.

### Product feature, later

- **UZO-890 — PR view + list enrichment.** A product feature, explicitly deferred; not part of the release/open-source path. Schedule after the above.

---

## 6. Ticket index

| UZO-ID | M-ID | Title | Track | Order | Blocked-by |
| --- | --- | --- | --- | --- | --- |
| — | A0 | Split partial-sync conformance scenario (transport-agnostic vs per-leg) | A | A0 | (do off-sandbox first) |
| UZO-575 | M3.1 | Scratch App + org (subs 635/637/640/643/580) | A | A1 | real org-admin (sandbox) |
| UZO-724 | M5.1.4 | Live direct leg vs scratch repo | A | A2 | A0, `GH_TOKEN` secret |
| UZO-725 | M5.1.5 | Live broker leg vs scratch org | A | A2 | A0, M3.1 scratch org |
| UZO-614 | M6.1 | Host collector + token broker deploy (subs 740/742/744/746/748) | A | A3 | M3.1 |
| UZO-616 | M6.2 | Collector on the push tick — **subs 750/752/754/756 STALE** | A | A4 | M6.1 |
| UZO-617 | M6.3 | Coder template + image — **sub 763 STALE** | A | A5 | M6.1 |
| UZO-619 | M6.4 | Two-human end-to-end (subs 767–771) | A | A6 | M6.2, M6.3, M5.1.5 |
| UZO-621 | M6.5 | Client acceptance + sign-off (subs 772–776) | A | A7 | M6.4 |
| UZO-818 | M7.5 | Verify all docs against the implementation | B | 1 | frozen doc surface (M7.2/M7.4) |
| UZO-819 | M7.6 | Retire/rework internal repo docs | B | 2 | M7.4, M7.5 |
| UZO-820 | M7.7 | Remove/scrub the `.claude/` harness | B | 3 | M7.6 (runs LAST) |
| UZO-821 | M7.8 | OSS hygiene + final secrets sweep | B | 4 | M7.6 |
| UZO-745 | M5.3.3 | Virtualized-scroll jank (large diff) | B | any (browser) | a real browser |
| UZO-747 | M5.3.4 | Shiki worker vs first paint | B | any (browser) | a real browser |
| UZO-890 | — | PR view + list enrichment | later | later | (product, deferred) |

## 7. Source docs

- `docs/agent/CHECKPOINT_2.md` — the corrected MINT-AND-INJECT topology, the on-prem section, the 7 owner decisions, and the App grant. **The authority for Track A; overrides any stale sub-issue.**
- `docs/agent/MILESTONES.md` — M3/M5/M6/M7 sections; the M6.1–M6.5 parent descriptions here are the CORRECTED ones.
- `docs/operator-runbook.md` — the shipped operator install steps (broker mode, credential injection, bot login, reviewer assignments, host collector, `scripts/broker-audit.ts` / `broker-offboard.ts` / `seed-scratch.ts`, env-var reference).
- `.claude/skills/revu/memories/known-landmines.md` — the CHECKPOINT_2 decisions in short form + the partial-sync landmine (A0) and the broker/collector traps.

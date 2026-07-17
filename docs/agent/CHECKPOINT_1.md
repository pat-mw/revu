# CHECKPOINT_1 — code review before M2

Independent review of `main` at `5985f34` (MT, M0, M1 merged). Read from the code, not the commit messages or the board. The gate is green on a cold clone — oxlint 0 errors, `tsc -b` clean, 248 tests / 525 assertions in 2.2s, e2e a separate job behind `needs: check`. That is real and it is not the point: every defect below is in code the green gate covers.

**Handle C1–C3 before M2 opens.** C1 and C2 are in `anchor.ts`/`reconcileDraft`, which guide §4 mandates production import *verbatim* — every hour they stay is an hour closer to blessing them as shared truth. C3 is a security hole that is harmless today and identity-defeating the moment M3 lands.

Suggested shape: a milestone **M1.6 — reconcile correctness + surface hygiene** inserted after M1, mirrored into Linear per `LINEAR_PROTOCOL.md`, with `docs/agent/MILESTONES.md` updated in the same PR (the doc/board anti-drift rule). C4–C6 are M2-blocking-adjacent; C7–C9 are hygiene and can ride along.

---

## C1 — `reconcileDraft` ignores `side`; adapter and dialog already disagree — **P0**

**Where:** `packages/app/src/api/mock/adapter.ts:631` vs `packages/app/src/components/review/reconcile-dialog.tsx:152`

The adapter resolves the anchor blob unconditionally to head:

```ts
const headBlobSha = blobIndex[c.path]?.head ?? null
```

`PendingComment` carries `side: 'LEFT' | 'RIGHT'` (`types.ts:378`), and the UI genuinely produces LEFT-side comments — `code-row.tsx:111` maps a deleted line to `{ side: 'LEFT', line: oldLine }`. A LEFT-side anchor's text lives in the **base** blob. Matching it against head means: its line was deleted (that is *why* it is LEFT-side), so it classifies `lost/line-deleted` — or worse, `drifted` onto a coincidental text match elsewhere in head, silently re-pointing the comment at unrelated code.

The dialog already gets this right:

```ts
return comment.side === 'LEFT' ? entry.base : entry.head
```

So the reconcile **preview** and the reconcile **report** disagree today, inside the prototype, on LEFT-side comments — the exact divergence guide §4 names as the worst possible bug in this app, present before any server-side reuse exists to blame for it.

**Why the suite missed it:** there is not one `side: 'LEFT'` case in `anchor.test.ts`, the fixtures, or the conformance suite. The reconcile scenario (PR 389) is RIGHT-side only. 248 green tests prove nothing here.

**Fix:**
- `classifyAnchor` should not silently accept whatever lines it is handed. Rename the parameter to `newAnchorLines` (or take `{ side, baseLines, headLines }`) so a caller cannot pass the wrong blob without saying so.
- `reconcileDraft` selects `blobIndex[c.path]?.base` for `side: 'LEFT'`, `.head` for `'RIGHT'`. Use one shared selector imported by both the adapter and the dialog — the divergence exists because the rule is written twice.
- `filePresence` needs the same treatment: for a LEFT-side comment, `status === 'added'` means the base blob never existed → `lost` (new reason `'file-added'`), and `status === 'removed'` is *not* terminal, because the base side still holds the deleted content the comment targets. The current terminal-`removed` branch is wrong for LEFT.

**Verify:** a LEFT-side comment on a deleted line in a base-unchanged PR classifies `clean`; a LEFT-side comment whose base blob moved classifies `drifted` with the base-side delta; dialog preview and adapter report agree on every fixture comment on both sides. Add LEFT-side comments to the 389 draft and a conformance scenario asserting preview/report parity.

---

## C2 — the `clean` fast path skips the check that makes the drift path trustworthy — **P0**

**Where:** `packages/shared/src/lib/anchor.ts:98`

```ts
if (lineEq(newHeadLines[originalIdx], target)) {
  return { kind: 'clean', comment }
}
```

Text-only, at the original index, with zero context scoring — while the drift path below carefully scores ±3 lines with distance weighting and tie-breaks. **The asymmetry is the bug.** On any repeated line — `}`, a blank line, `  return null`, an import — code can shift under the anchor while a coincidentally identical line occupies the old index, and the comment reports `clean` and is submitted against unrelated code with no human in the loop.

The cost asymmetry is what makes this P0: a false `lost` costs a human ten seconds of re-anchoring in a dialog built for exactly that. A false `clean` never reaches a human at all.

**Fix:** require a minimum context score on the clean path (a natural threshold: the anchor must score at least as well at `originalIdx` as the best drift candidate does; or simpler, demote to the drift search whenever `contextScore(anchor, lines, originalIdx)` is below a floor and let the existing ranking decide — a genuinely unmoved line wins its own comparison at `delta: 0`). Uniqueness matters more than magnitude: if `lineText` occurs many times in the search window, context is the *only* signal.

**Verify:** a file where `}` sits at the original index after a 20-line insertion above classifies `drifted` (or `lost`), not `clean`. An unmoved line with intact context still classifies `clean` (no regression in the existing suite). A single-occurrence anchor still short-circuits cheaply.

---

## C3 — `/api/dev` is unauthenticated, ungated, and outside the contract — **P0**

**Where:** `packages/revud/src/api-router.ts:143` (`handleDev` runs before any mode check); routes absent from `packages/shared/src/http.ts`

```
PUT /api/dev  { humanId }  → dev.setHuman(id)
```

An unauthenticated HTTP call **changes who you are**. Also `failureMode`, `latency`, and `POST /api/dev/reset` — which reseeds the store, i.e. destroys every draft.

Not exploitable today: `assertMode()` permits only `REVU_MODE=mock`. That is exactly why it needs fixing now — it is invisible until M3 makes it catastrophic. revud is reachable through Coder's port proxy; the whole identity model (guide §1: display identity is convention, audit identity is the channel) collapses if a curl can pick the human. The reset endpoint is worse than the spoof: it is unauthenticated remote deletion of every human's drafts, against the invariant the product is built on.

Compounding: these routes are **not in the shared `ROUTES` table**, so they are an undocumented side-channel that no contract test covers and no reader of `http.ts` knows exists. That is precisely how such things survive to production.

**Fix:**
- Gate `handleDev` on `REVU_MODE === 'mock'` at the router boundary, not inside the handler — one guard, before dispatch, returning `null` (→ SPA fallback / 404) in any other mode. Take the mode as an explicit argument rather than reading `process.env` inside the router, so it is testable and cannot be re-enabled by a stray env var.
- Add a comment at the guard stating that broker/direct mode must never expose it, and record it in `known-landmines.md` so M3 cannot regress it.
- Either add the dev routes to `ROUTES` marked mock-only, or document in `http.ts` that they exist outside the table and why.

**Verify:** a daemon booted with any non-mock mode returns 404 for `GET/PUT /api/dev` and `POST /api/dev/reset`. A test asserts this directly rather than relying on `assertMode` rejecting the mode first (that coupling is what hides the bug).

---

## C4 — `newStartLine` shifts a range rigidly, unvalidated — **P1**

**Where:** `packages/shared/src/lib/anchor.ts:127`

```ts
newStartLine: comment.start_line !== null ? comment.start_line + delta : null
```

The end anchor is matched by text and scored by context; the start line is assumed to have moved by the same delta and is never checked against anything. Insert a line *inside* a commented range and the span silently mis-covers — a review comment attached to a block that is no longer the block. Ranged comments are a first-class affordance here (multi-line select, suggestions), so this is not exotic.

**Fix:** capture the start line's text in `PendingComment.anchor` at write time (e.g. `startLineText`) and validate it after shifting. When it does not match, either search for it independently or classify `drifted` with a flag that makes the dialog show the new span for confirmation rather than applying silently. Extending `anchor` is a store-shape change → bump `STORE_VERSION` and add a migration (`load()` already has the migration ladder; a v2 document with no `startLineText` defaults to null and behaves as today).

**Verify:** a ranged comment with a line inserted inside its span does not silently apply the old span length; the dialog surfaces the changed range.

---

## C5 — `flush()` swallows write errors → HTTP 200 on a draft that never hit disk — **P1**

**Where:** `packages/app/src/api/mock/store.ts:234`, `packages/revud/src/storage.ts`, `api-router.ts` (flush after every mutating handler)

```ts
try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
```

Correct for a browser (quota/private-mode failure should keep the session working in memory). Wrong for a daemon: `DiskStorage.setItem` throws for disk-full, permission-denied, read-only FS — and the router then returns **200 OK**. The UI reports the draft saved. It is not saved. That is worse than losing text; it is lying about not losing it, against the one invariant `AGENTS.md` states outright ("Never discard user-written text on failure").

Same shape in `load()`: `getItem` catches a read error and returns `null` → `load()` reseeds from fixtures → the next flush **overwrites the unreadable-but-present document with fresh seed state**. A transient read error becomes permanent data loss. `load()`'s corrupt-document reseed is right in a browser and wrong on disk, where the file is the only copy.

Contained at mock scale, and the architectural call to reuse the mock (rather than port it, as M0.3 specified) was the right one — a port would drift from the oracle. But the reuse imported browser error semantics into a durability path, and **M2.3's SQLite store must replace this path, not inherit it**.

**Fix now (cheap):** give `DiskStorage.setItem` a failure signal the daemon can see — the store's `flush()` swallow is browser-correct, so surface it at the revud boundary instead: have the router verify persistence (or have `DiskStorage` throw and `MockStore.flush()` expose a `flushOrThrow()` for the daemon) and return a typed `ApiError` on failure rather than 200. Never silently reseed a document that exists but could not be read — distinguish "absent" from "unreadable" in `DiskStorage.getItem` and fail loud on the latter.

**Record for M2.3:** the SQLite store owns durability end-to-end; no error swallowing on the write path; unreadable ≠ absent. Add to `known-landmines.md`.

**Verify:** a data dir made read-only mid-session → a draft save returns a typed error and the UI keeps the text editable; a corrupted-but-present document does not get silently replaced by seed state.

---

## C6 — stamper/parser round-trip is asserted, not enforced; the 24-char token cap is M1.2's bug at a different axis — **P1**

**Where:** `packages/shared/src/lib/identity.ts:47` (`NAME_TOKEN_RE`), `:98` (`prefixBody`)

```ts
const NAME_TOKEN_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_'’.-]{0,23}$/u
```

24 chars per token. Coder usernames go to 32. A contractor named `deployment_engineer_northwest` (29) gets stamped by `prefixBody`, fails `looksLikePersonName` on the way back, and renders as the bare bot — **exactly the M1.2 failure mode, one axis over**, shipped in the commit that fixed M1.2. The charset was widened to match Coder; the length was not.

The deeper issue: the docstring's claim — "the broker owns this format on both ends, so the parser tracks it" — is a comment, not a test. `prefixBody` and `parsePrefixedBody` are inverses by assertion only. Nothing fails when they drift.

**Fix:** raise the token cap to Coder's actual username limit (and the `[^*\n]{1,60}` name capture accordingly for multi-token display names). Then make the inverse property structural: a property/table test that for every name in a corpus of legal Coder identities — max-length usernames, digits, underscores, hyphens, apostrophes, non-Latin scripts, 1–4 token display names — `parsePrefixedBody(prefixBody(human, body))` returns exactly `human.name` and `body`. That test is what actually owns the format on both ends; it fails the day someone tightens either side.

Also confirm `prefixBody`'s unescaped interpolation cannot corrupt the prefix for legal names (a `*` in a name would break `PREFIX_RE`'s `[^*\n]` capture and degrade to bot). Degradation, not spoofing — the failure mode is safe — but it should be a known, tested boundary rather than a discovered one.

**Verify:** the property test passes for the corpus; a deliberate one-char tightening of either the stamper or the parser fails it.

---

## C7 — AGENTS.md violation: tracking artifact in code — **P2**

`packages/app/src/api/http/integration.test.ts:236`:

```ts
describe('mock ↔ http parity (UZO-607: faithful adapter → identical rollback)', () => {
```

`AGENTS.md` forbids referencing tickets in code. It is the only instance in the repo — kill it now, before a future session pattern-matches on it. The describe reads fine without the ticket id.

**Verify:** `grep -rn "UZO-" packages e2e scripts` returns nothing.

---

## C8 — the gate tolerates 65 lint warnings — **P2**

`oxlint` reports 65 warnings, 0 errors; `bun run check` passes regardless. Warnings a gate ignores are warnings that only accumulate, and the signal is already gone at 65 — nobody will notice the 66th. Decide explicitly: promote the rules worth keeping to errors and fix the sites, or silence the rules that are not worth keeping. Either is fine; the ambiguity is what rots.

**Verify:** `bunx oxlint` reports 0 warnings, or the tolerated set is explicitly configured in `.oxlintrc.json` with a one-line rationale.

---

## C9 — static path resolution: prefix check + dead regex — **P2, hardening**

**Where:** `packages/revud/src/server.ts:26`

```ts
const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
const abs = join(distDir, rel)
if (!abs.startsWith(distDir)) return null
```

Not currently exploitable — URL pathnames are always rooted, so `normalize` collapses leading `..` before `join` ever sees it, which also makes the regex dead code. But `startsWith(distDir)` is the classic prefix flaw: a sibling `dist-evil/` satisfies it. It survives on an invariant of `URL` parsing rather than on the check doing its job, which is the kind of thing that stops being true when someone reuses the helper.

**Fix:** `const rel = relative(distDir, abs); if (rel.startsWith('..') || isAbsolute(rel)) return null`, and drop the regex.

**Verify:** a request for `/../secret` and a `%2e%2e%2f`-encoded equivalent both fall through to the SPA index rather than resolving outside `distDir`; a unit test on `resolveStaticPath` covers a sibling-prefix path directly.

---

## What is solid — do not "fix" these

Recorded so the next session does not burn time re-litigating good decisions:

- **Durability is proven, not claimed.** The HTTP conformance runner spawns a real daemon subprocess, kills it, and restarts against the same data dir, so draft survival is tested across a genuine process boundary. `store.flush()` after every mutating handler correctly closes the store's ~1s debounce window (a crash inside it would otherwise eat the draft); SIGTERM/SIGINT flush; atomic tmp+rename. C5 is about error *reporting* on this path, not the design.
- **Reusing the app's mock in revud** (`import('@revu/app/mock')` + a disk-backed `Storage` polyfill) instead of M0.3's specified port. Deviation from the doc, right call, well-reasoned in the module docstring: one oracle, no divergence. Keep it.
- **DOM-global guards** (`typeof document`, `typeof localStorage`) are correct and load-bearing for headless reuse. The boot-order dependency (install storage → then load mock) is real, documented, and tested.
- **The conformance suite is genuinely transport-parameterized** and already runs against two adapters from one source. It is the right asset; C1/C2 are gaps in its *scenarios*, not its design.
- **`load()`'s migration ladder** and the M1.4 in-place prefs migration (a version bump never wipes drafts) — unasked-for and exactly right.
- **The `network`-code enveloping** (client-side-only code, no HTTP status, surfaced as an enveloped 5xx and reconstructed adapter-side) is a careful call, correctly documented at both ends.
- **MT** — the TDD milestone the agent inserted ahead of M0, absent from the original doc. Correct: the doc made every **Verify** executable without building the thing that executes them. Scoped well (defers conformance to M1.5, the release matrix to M5.1), and `MILESTONES.md` diffs against the original as exactly that insertion and nothing else. The anti-drift rule is holding.

---

## Ordering

1. **C3** — smallest, and its blast radius grows the moment M3 exists.
2. **C1 + C2 together** — same module, same test surface, both need LEFT-side and duplicate-line fixtures. `anchor.ts` gets blessed as production-shared in M2; fix before the blessing, not after.
3. **C6** — cheap, and it closes the M1.2 bug class properly instead of one instance of it.
4. **C4, C5** — C4 carries a store-version bump; C5 is a small fix now plus a recorded constraint on M2.3.
5. **C7, C8, C9** — hygiene, any time before M2 closes.

The through-line: every P0 here is a place where **two things that must agree were written twice** (dialog vs adapter blob selection; clean path vs drift path; stamper vs parser) or where **something outside the contract was allowed to matter** (`/api/dev`). The conformance suite is the right structural answer and it is already built — these are the scenarios it does not yet have. Extending it is the fix; the code change is the easy half.
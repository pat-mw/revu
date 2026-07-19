# Performance notes — the sync engine and the large-diff viewer

This records what the performance guards actually measure inside the local gate,
and what is deliberately deferred to a real browser or a live pull request. The
honest split matters: an in-gate assertion runs on every `bun test`, so it must be
machine-independent and deterministic; a browser-only concern cannot be, so it is
documented here rather than faked into a green unit test.

## In-gate: the sync engine over a large PR

The sync engine (`packages/revud/src/direct/sync.ts`) is guarded against gross
performance regressions by a wall-time budget test that drives the REAL
`syncPull` over a synthetic large-PR fixture.

- **Fixture** — `packages/revud/src/direct/large-pr-fixture.ts`. A deterministic,
  byte-stable diff of 40 files whose changed lines total **2,560** (well past the
  two-thousand-line bar), with a distinct base and head blob per file (80 unique
  content-addressed blob SHAs). It is generated once, before any measured window
  opens, and served verbatim by a fake `GithubClient` so the engine runs
  unchanged. It lives beside the other engine fixtures
  (`conformance-fakes.ts`), the location the network-free engine tests already
  draw their fixtures from; it needs no built app and touches no `localStorage`.

- **Cold-sync budget** — `packages/revud/src/direct/sync-perf.test.ts` cold-syncs
  the fixture through the engine and asserts the wall time (measured with
  `performance.now`) stays under a **documented, margin-generous** ceiling
  (`COLD_BUDGET_MS = 750`). On the development machine a cold sync of this fixture
  lands in the single-digit-to-low-tens of milliseconds; the ceiling sits an order
  of magnitude above that so a much slower shared CI runner still passes. Its job
  is to catch a GROSS regression — an accidental O(files²) path, a synchronous
  re-parse of every blob, a lost early-exit — not to pin a millisecond count.

- **Warm re-sync is materially cheaper — proven deterministically.** The two-half
  cache keys the immutable half (files + merge-base tree + commits + blob index)
  by `merge_base...head`, with no TTL. A warm re-sync of the unchanged compare
  must therefore skip the entire immutable fetch and re-provision zero blob bytes.
  The test asserts this with **cache-hit call counters, not timing**: on the warm
  pass the files, tree, commits, and blob-batch calls all drop to zero and
  `syncStats.blobsFetched` drops to `0` (every blob a content-addressed store
  hit). The mutable half still runs — a thread can resolve with no head movement,
  so it is refetched unconditionally. No cold/warm wall-time comparison is made:
  at the single-digit-millisecond scale this fixture syncs in, scheduler and GC
  jitter dominate the ratio, so a relative timing check would flake without adding
  any signal the deterministic call counters do not already carry.

Why the engine and not the browser: the cost that a large PR most threatens in the
read path — paginating and mapping the files, walking the merge-base tree,
provisioning every blob — is exactly what `syncPull` owns and what the two-half
cache is designed to make cheap on a re-sync. That is measurable deterministically
with no browser, so it belongs in the gate.

## Deferred: browser-only concerns (need a real browser)

The following are genuinely browser-bound. They depend on layout, paint timing,
and a Web Worker — none of which a headless unit test can measure honestly — so
they are NOT asserted in-gate. They belong on the end-to-end harness
(`e2e/harness.ts`, driven by a plain `bun run` script against the built app, never
a `*.test.ts`) and, for the highest fidelity, against a live large pull request.

1. **Virtualized-scroll jank on the large diff.** The diff viewer virtualizes
   rows (`@tanstack/react-virtual`); the concern is that scrolling a
   thousands-of-rows diff stays smooth (no long frames, no layout thrash as rows
   mount and unmount). Measuring this requires a real render tree and a real
   scroll: drive the built app on the harness, scroll the large diff
   programmatically, and sample frame timing / long-task entries. It cannot be
   reduced to a deterministic wall-time number that is stable across machines, so
   it is a harness check, not a gate assertion.

2. **The Shiki highlight worker must not block first paint.** Syntax
   highlighting runs off the main thread in a Web Worker so the diff paints
   immediately and highlights stream in. Verifying that first paint is not blocked
   by highlighting needs a real browser: open the large diff on the harness and
   confirm the first contentful paint lands before the worker finishes, with the
   main thread responsive throughout. There is no worker and no paint in a
   headless unit test, so this too is a harness check.

### The "scratch twin" — a live large PR

The synthetic fixture is faithful to the wire shape but is still generated data.
The end-to-end confidence check is a **scratch twin**: a genuine large pull request
(thousands of changed lines across many files) opened on the scratch repository,
synced and reviewed through a real workspace. That exercises the whole stack the
fixture cannot — real GitHub pagination and rate behaviour, real blob bytes, the
real viewer under a real browser — and is the right place to observe scroll
smoothness and highlight-worker behaviour under production-like data. It is
on-prem/live work, outside the local gate, and is tracked as follow-up.

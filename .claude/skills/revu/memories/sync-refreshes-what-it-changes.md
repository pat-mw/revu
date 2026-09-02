# A mutation refreshes every cache its result can change — or the walk finds it

Measured on M8.9 (2026-09-02), in a `?mock=1` walk after every unit test was green. The mock archived a local
review on the sync that found its pull request (the persisted store said so at once), and the page kept
saying `in review` for as long as anyone watched: `useSyncPull.onSuccess` refreshed the snapshot, draft,
viewed and rate queries — everything a *pull request's* sync can change — and nothing else. A local review's
sync can also archive it (the row closes, the annotation gains the pull request number) or flip `dirty`, and
neither cache learned it on its own: the pull list polls every 15 s but React Query pauses the interval in a
background tab (`document.visibilityState === 'hidden'`, which is what an embedded preview pane is), and the
annotation query has no interval at all, so the banner would have lagged until a focus or a reload.

**The fix shape:** a non-hook `refreshAfterLocalReviewSync(qc, prNumber)` beside
`refreshAfterLocalReviewCreate`, invalidating `qk.pulls` + `qk.localReviews` with `refetchType: 'all'` (a
client with no mounted observer otherwise marks the entry stale and fetches nothing), mode-gated so a pull
request's sync touches neither list, called from the sync mutation's `onSuccess`. Driven and asserted against
a real `QueryClient` with no renderer, the control being that a pull request number leaves both caches'
`dataUpdateCount` and `isInvalidated` untouched.

**How to apply:**
- When a transport gains a new side effect on an existing verb, list every query that can now change and
  check the mutation's `onSuccess` names each one. A cache that polls is not a cache that refreshes: intervals
  pause in hidden tabs, and a query without an interval never refetches on its own.
- Unit tests over pure props cannot see this class; only a walk against the real transport does. Do the walk
  before calling a chrome unit done, and read the transport's persisted state alongside the page so a stale
  page is distinguishable from a transport that did nothing.
- A fix that lands in the same edit as its test has no observed red. Obtain one by control: restore the
  defect, watch the named test fail, revert, and verify the revert byte-for-byte (`cmp` against a copy).

# A claim in a docstring needs a read behind it, or it is decoration

Two shapes measured by the adversarial review that closed M8.11 (2026-09-02), both in suites that were green:

- **"…and the snapshot agrees."** The reaction case returned a rollup and asserted the returned value; the
  docstring said the snapshot agreed, and nothing read the snapshot. With `persistThread` disabled in the engine,
  the leg stayed green. A returned value is one half of an agreement; the other half is a read through the
  contract after the write.
- **A restart over the same memory.** Both mock runners' `restart` hooks flushed and then rebuilt an adapter over
  the same in-memory document, so their durability case passed with `flush()` made a no-op. Durability is proven
  only when the next handle reads what was *persisted*: the daemon legs restart a process over the same data
  dir; the direct leg reopens the same SQLite file; the mock store now has `reload()` (re-read `localStorage`,
  cancel the pending debounce) and both mock restarts call it.

Also measured, on prose: a guide described archive-on-PR-appearance as happening; nothing writes `archived_pr`.
Prose is reviewed against the code that exists, not the design.

**How to apply:** for every sentence in a docstring of the form "X answers Y and Z agrees", find the read of Z in
the test body; for every restart/reload hook, ask what would make it fail (disable persistence and watch); for
every docs sentence in the present tense, find the writer. Each fix lands with its own control, seen red.

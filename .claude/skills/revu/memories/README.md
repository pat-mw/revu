# memories — durable recurring knowledge for revu sessions

Read **every file here** at the start of a session (the harness's Orient step). One file = one durable fact-cluster. Add a memory when a session learns something that will bite again (a constraint, a landmine, a decision's *why*); update or delete when one goes stale. Keep tracking out of here — that lives in Linear.

| memory | what it holds |
| --- | --- |
| [tracking-coordinates.md](./tracking-coordinates.md) | Where tracking lives (the local board at `.claude/workstreams/`, Linear as read-only history), the mapping decisions, and the free-issue-cap that moved it |
| [hard-constraints.md](./hard-constraints.md) | Non-negotiable invariants any change must respect (contract semantics, caching, drafts, identity) |
| [known-landmines.md](./known-landmines.md) | Specific traps already identified — in the prototype, the GitHub API, and the Linear MCP |
| [pr-cadence.md](./pr-cadence.md) | Stacked PRs are the protocol: open one every session, never merge; a pushed branch with no PR gets no CI runner |
| [claims-need-a-read.md](./claims-need-a-read.md) | "…and the snapshot agrees" needs a read behind it; a restart over the same memory proves nothing; docs describe what exists |
| [conformance-branch-coverage.md](./conformance-branch-coverage.md) | A suite branch only one transport exercises is unverified until that runner exists; the collapsed binary-blob shape; no adapter for `DirectApi`; `scripts/` rot |
| [sync-refreshes-what-it-changes.md](./sync-refreshes-what-it-changes.md) | A mutation refreshes every cache its result can change; polls pause in hidden tabs; a chrome unit is not done until a walk against the real transport, read beside the persisted state |

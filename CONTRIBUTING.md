# Contributing

## Development setup

```bash
bun install
bun run check      # lint → typecheck → bun test → app build
```

`bun run check` is the gate. It must pass before any change is ready. All four
steps run in order; a failure in an earlier step stops the pipeline.

Source: `package.json` — `scripts.check`.

## Test discipline

Every change lands with its tests. There is no grace period; untested changes
are not mergeable. The test suite is `bun test` (all `*.test.ts` files) and
runs as the third step of the gate.

New tests belong next to the code they exercise. Follow the existing pattern
for each layer:

- Unit tests for isolated functions: place the test file next to the source
  file (e.g. `foo.ts` → `foo.test.ts`).
- Integration tests that drive the mock adapter or the daemon over HTTP: follow
  the harness idioms already present in each package.

## The mock adapter

The in-browser mock adapter (`packages/app/src/api/mock/`) is the permanent
oracle, the test double, and the demo mode for this project. It will never be
deleted or made optional.

- `?mock=1` forces the mock in the browser regardless of whether a daemon URL
  is configured. This always works in any build.
- The mock is the single semantics oracle: mock mode in the daemon reuses the
  app's mock adapter via `packages/revud/src/mock-bridge.ts`. Direct mode and
  broker mode implement the contract against the real GitHub API — they do not
  reuse the mock at runtime. The conformance suite is what holds every adapter
  to the same semantics as the mock.
- The conformance suite (see below) holds every adapter to the same bar as the
  mock.

Source: `packages/app/src/api/select.ts` — `forceMockFromLocation`, `selectApi`;
`packages/app/src/api/mock/adapter.ts`.

## The conformance suite

`packages/shared/conformance/` is the cross-transport correctness oracle. It
expresses the `RevuApi` contract's hard invariants as `bun:test` assertions
and runs the same suite against every adapter that implements the contract.

Key invariants encoded in the suite:

- `submitReview` returns `{ status: 'head_moved' }` as a 200-level VALUE, never
  an error, when the PR was force-pushed between sync and submit.
- `syncPull` may resolve with `snapshot.partial` set rather than throwing when
  a transfer dies mid-way; a retry completes and clears the partial.
- `getSnapshot` returns `null` (not a thrown 404) for a pull that was never
  synced.

When you add a new adapter, run the conformance suite against it before
claiming the implementation is correct. When the contract changes, update the
suite first.

Source: `packages/shared/conformance/suite.ts`.

## Code comment rule

Comments and docstrings are self-contained descriptions of the code and its
constraints. They must not reference issue or ticket identifiers, PR numbers,
milestone labels, wave or phase labels, session labels, agent names, or any
other tracking artifact. Those belong in commit messages and the issue tracker,
not in code.

A reference to a versioned file in the repository is acceptable only when it
genuinely explains a contract (for example, pointing to a conformance suite
file that defines the invariant being implemented).

This rule applies to all code and developer-facing prose in the repository,
including comments in test files, configuration, and scripts.

## Commit style

Write commit messages that explain why a change was made. The first line is a
short imperative summary (under 72 characters). A blank line separates it from
the body when a body is needed. No ticket references in the subject line.

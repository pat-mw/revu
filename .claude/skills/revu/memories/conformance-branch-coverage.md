# A suite branch only one transport can exercise is unverified until that transport's runner exists

Measured while closing M8 (2026-09-02). The shared local-review conformance suite was written against the mock
first, as D6 requires. The mock's local sync is deliberately the **empty compare** (`mergeBaseSha === headSha`,
`files: []`, `blobIndex: {}`) — its own docstring calls it the already-legal "head has no commits ahead of base"
review — so the suite takes a runner-declared `compare: 'empty' | 'changes'` and the mock legs (E, F) declare
`'empty'`. The `'changes'` branch therefore executed for the first time when the direct leg (G) landed — and the
real engine failed one of its lines. **The suite was wrong:** it asserted every head blob has non-empty `content`,
but a binary blob is stored **collapsed** (`binary: true`, the true byte `size`, `content: ''`) by the direct
builder *and* by the mock's own `binaryBlob()` fixture helper. The line now pins that shape.

**Why it matters:** two green legs and a non-vacuity control (`heads.length > 0` iff `'changes'`) still left the
branch unverified, because the control proves the loop *ran over something*, not that its predicate is right.
"The mock is the spec" only constrains behaviour the mock actually exhibits; a fixture-dependent branch the mock
never enters is specified by nobody until a second transport enters it.

**How to apply:**
- When a shared suite gains a branch keyed on a runner declaration, land the runner that takes the *other* branch
  in the same session, before trusting the suite. Until then, log the branch as unverified on the ticket.
- Contract facts pinned here, do not re-derive: a local review's `getBlob` on a binary sha answers
  `{ binary: true, size > 0, content: '' }`; the mock's local compare is empty and every transport may legally
  answer an empty compare; the shared local suites (`local-suite.ts`, `local-delete.ts`) drive a mapped api type
  (`Answered<RevuApi[K]>`) so the synchronous `DirectApi` needs **no adapter** — `tsc -b` is the bridge.
- `scripts/` is still outside `tsc -b` (a recorded exception). The cost was measured: `scripts/smoke.ts` had rotted
  in four places nobody saw (a required parameter added to `parseCommentIdentity` left two identity checks
  asserting against the bot) until `test/smoke-script.test.ts` ran it in-gate. The fix is `scripts` in
  `tsconfig.tools.json` with ambients for `gifs.ts`/`shots.ts`/the broker scripts — a follow-up on the board.

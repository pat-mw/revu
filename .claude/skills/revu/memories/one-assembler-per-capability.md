# A capability wired per boot path drifts, silently — assemble it where the surface is assembled

Measured 2026-09-08, from outside the board: a client workspace running **broker mode** could not reach the
local-review pipeline at all. Every id in the reserved band answered `not_found`, because the surface was built
inside `mainDirect` and `mainBroker` built none. Nothing else was missing — broker boot already had the store,
the runner, a real session and the branch-pair listing the archive check reads. The api's `localReviews`
dependency is optional **by design** (a daemon with no repository must have none), so the omission was invisible
to the compiler, to every unit test, and to a conformance matrix whose local legs all drove `createDirectApi`
directly. `docs/agent/LOCAL_REVIEWS.md` D5 had said "a capability inside direct/broker mode" since the design;
the boot was simply behind its own decision for the whole milestone.

**The shape of the bug is the lesson.** An optional dependency plus one assembly site per boot equals a
capability that exists in one deployment and not another, with nothing to notice. The fix is not to patch the
boot that forgot: it is to move the assembly to where the surface itself is assembled — `createBootApi` in
`packages/revud/src/index.ts` — so each boot passes only what is genuinely its own (a poll cache, a
credential-bound listing client, a write decorator) and cannot pass, or omit, the shared capability at all.

**How to apply:**
- Before adding an optional dependency to `createDirectApi`, ask which boot paths must have it. If the answer
  is "all of them", it belongs in the shared assembler, not in each `main*`.
- **A conformance leg that drives the api proves the engine; only a leg that drives the ASSEMBLER proves a
  boot.** Legs E/F/G all passed throughout the period broker mode served nothing. Leg H
  (`packages/revud/src/direct/conformance-broker-local.test.ts`) exists for that distinction — it builds its api
  through `createBootApi`, so dropping the surface from the assembler turns 44 of its 48 tests red.
- Contract facts pinned here, do not re-derive: local writes never reach the broker `WriteDecorator` (they post
  to no shared account, so nothing is stamped and nothing is journaled) and are **not** gated on
  `REVU_BOT_LOGIN` — the router exempts a local review from the reads-only broker gate, so a reads-only broker
  serves the whole local loop. The archive detector skips any review whose repo identity is not `owner/name`
  shaped, so a fixture with no origin makes the archive half of any local suite assert nothing.
- Known and deliberately unfixed: on a broker, `GET /api/pulls` is the merge of the poll cache with the local
  rows and asks the poll source unconditionally, so a cold or credential-less cache answers
  `broker_unreachable` and the local reviews go with it. Serving the local half alone would silently drop the
  pull requests. The owner's call, recorded at M8.18's open questions.

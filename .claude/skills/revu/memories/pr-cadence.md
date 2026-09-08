# PR cadence — open them, never merge them

**Stacked PRs are the protocol for this whole repo, not a per-ticket reward.** Every session and every
milestone actively opens its PR, based on the previous branch in the chain. The stack IS the working record;
a branch without a PR is not "not ready yet", it is missing from the record.

**Merging stays out of bounds.** The owner merges, from the bottom up, at their convenience. Never merge,
never commit to `main`, never retarget.

**Why this matters operationally:** `.github/workflows/ci.yml` triggers on `pull_request` and pushes to
`main` only. **A pushed branch with no PR gets no runner at all** — `gh run list --branch <name>` comes back
empty, which reads like "still running" rather than "never scheduled". Withholding a PR therefore withholds
CI, on a repo that has already shipped red PRs because a default local run reproduces CI by accident. Opening
the PR is what buys the verification.

**Do not misread §8 of `SESSION_PROTOCOL.md`.** "Every ticket gets an adversarial review of its full diff
before its PR opens" orders the *review* against the PR. It is not a rule that a ticket must be 100% complete
first, and it is not a reason to end a session with an un-PR'd branch. A session that ran out of road at 6/8
still opens its PR; the remaining units land on the same branch and the PR updates.

**How to apply:** before ending any session, check `gh pr list` against the pushed branches. Any branch in
the chain without a PR is a defect to fix before writing the handover. Record the stack — which PRs, their
base order, what waits on which merge — in the handover.

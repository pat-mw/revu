# Direct mode quickstart

Direct mode runs revu against a GitHub repository as the real authenticated
user. No shared bot identity is involved. Every review comment, reply, and
thread resolution posts to GitHub under your own account.

## Prerequisites

- [Bun](https://bun.sh) installed.
- [GitHub CLI (`gh`)](https://cli.github.com) installed and authenticated, or
  `GH_TOKEN` / `GITHUB_TOKEN` set to a valid personal-access token.
- A cloned GitHub repository whose `origin` remote points to the repository you
  want to review.

## Install

From the repo root:

```bash
bun install
```

## Start the app (frontend only, mock data)

```bash
bun run dev
```

This starts the Vite dev server for the frontend. The browser UI loads against
the in-browser mock adapter; no daemon or GitHub token is needed.

## Start the daemon in direct mode

From inside a clone of the repository you want to review:

```bash
REVU_MODE=direct bun run revud
```

Or use the `--direct` flag instead of the env var:

```bash
bun run revud --direct
```

Both forms are equivalent. The daemon reads the target repository from the
`origin` remote (`git remote get-url origin`), resolves and validates a GitHub
token, and starts an HTTP server (default port 4780). Open the URL it prints to
begin reviewing.

### Port

Override the default port with `REVU_PORT`:

```bash
REVU_MODE=direct REVU_PORT=5000 bun run revud
```

Source: `packages/revud/src/index.ts` — `resolvePort` / `DEFAULT_PORT`.

### Repository override

If the `origin` remote is not the repository you want to review, pass
`--repo owner/name` or set `REVU_REPO`:

```bash
bun run revud --direct --repo octocat/hello-world
# or
REVU_MODE=direct REVU_REPO=octocat/hello-world bun run revud
```

The flag wins over the env var. The repo must be a `owner/name` pair; a
trailing `.git` is tolerated and stripped.

Source: `packages/revud/src/index.ts` — `resolveRepoOverride`;
`packages/revud/src/direct/repo.ts` — `resolveRepo`.

## Authentication

The daemon needs a GitHub token with `repo` scope (or the fine-grained
equivalent: Contents read, Pull requests read/write, Metadata read). The review
daemon itself never pushes commits or refs, so it needs only **Contents: read**;
the fixture seeder (`scripts/seed-scratch.ts`) force-pushes branches and so needs
**Contents: write** — see `docs/direct-mode-auth.md` for the seeder's scopes.

Token resolution order (source: `packages/revud/src/direct/token-source.ts`):

1. `GH_TOKEN` environment variable, if set and non-empty.
2. `GITHUB_TOKEN` environment variable, if set and non-empty.
3. `gh auth token` — the credential stored by the GitHub CLI.

If none of these produce a token, startup fails with a clear message. To
authenticate the CLI:

```bash
gh auth login
```

The token is never logged and never sent to the browser.

## Identity

The daemon reads your identity from git config:

```bash
git config user.name
git config user.email
```

Both must be set. The lowercased email is the stable key for drafts and viewed
state. If either is missing, startup fails with an actionable message.

Role defaults to `contractor`. To start as a lead:

```bash
REVU_ROLE=lead bun run revud --direct
```

Source: `packages/revud/src/direct/session.ts` — `buildHuman`, `resolveRole`.

## Durable data directory

Drafts, snapshots, blobs, viewed state, and preferences persist to a SQLite
file under `${XDG_DATA_HOME:-~/.local/share}/revu`. Override with `REVU_DATA_DIR`:

```bash
REVU_MODE=direct REVU_DATA_DIR=/tmp/my-revu-data bun run revud
```

A restart loses nothing: the daemon re-reads the store and all drafts survive.

Source: `packages/revud/src/direct/store.ts` — `resolveDirectDataDir`.

## The review loop

1. **Sync** — click a pull request in the list. The daemon fetches the PR's
   diff, files, threads, and commits from GitHub REST + GraphQL and stores them
   locally.

2. **Comment** — open a file, select lines, and write inline comments. The
   draft is saved automatically as you type — debounced at 600ms, with a flush
   on tab hide — and survives a restart. A hard crash inside the debounce window
   may lose up to the last 600ms of typing.

3. **Submit** — submit the draft as a `COMMENT`, `APPROVE`, or
   `REQUEST_CHANGES` review. The draft is deleted from disk only on confirmed
   success. A `head_moved` response (the PR was force-pushed between sync and
   submit) surfaces as a conflict and keeps the draft intact so you can re-sync
   and resubmit.

4. **Reply** — reply to a review thread. Replies post as single inline comments
   on the existing thread.

5. **Resolve / unresolve** — mark a review thread resolved or reopen it. Uses
   the GitHub GraphQL `resolveReviewThread` / `unresolveReviewThread` mutations.

Your email never appears in any GitHub comment body; only the authenticated
`gh` identity (your real GitHub login) is visible to other reviewers.

## Run the full check gate

```bash
bun run check
```

This runs lint, typecheck, `bun test`, and the app build in order. All four
must pass.

Source: `package.json` — `scripts.check`.

## Live smoke check

`scripts/smoke-direct.ts` is a non-gated live script (it makes real GitHub
calls) that exercises the full read and write path against a seeded scratch
repository. Name that repository with `REVU_SMOKE_REPO` and run it with an
authenticated `gh` or `GH_TOKEN` set:

```bash
REVU_SMOKE_REPO=owner/name bun run scripts/smoke-direct.ts
```

`REVU_SMOKE_REPO` has **no default**. The script leaves permanent review
comments and temporarily advances a fixture branch, so it refuses to start
unless the target is named explicitly: an unset, malformed, or unmarked value
exits 2 with a message rather than falling back to a built-in repository.
Because the target is mutated, its name must also contain one of the scratch
markers `sandbox`, `scratch`, or `fixture` — the same guard the fixture seeder
applies.

Seed the target first with `scripts/seed-scratch.ts`; the smoke expects that
script's fixture pull requests (`#1`–`#5`) and `fixture/…` branches.

This script is not part of `bun test`; it is a manual integration check.

## Environment variable reference

| Variable | Default | Source file |
| --- | --- | --- |
| `REVU_MODE` | `mock` | `packages/revud/src/index.ts` |
| `REVU_PORT` | `4780` | `packages/revud/src/index.ts` |
| `REVU_REPO` | origin remote | `packages/revud/src/index.ts` |
| `REVU_DATA_DIR` | `~/.local/share/revu` | `packages/revud/src/direct/store.ts` |
| `REVU_ROLE` | `contractor` | `packages/revud/src/direct/session.ts` |
| `REVU_DIST_DIR` | `packages/app/dist` | `packages/revud/src/index.ts` |
| `REVU_SMOKE_REPO` | — (required by the live smokes) | `scripts/smoke-target.ts` |
| `GH_TOKEN` | — | `packages/revud/src/direct/token-source.ts` |
| `GITHUB_TOKEN` | — | `packages/revud/src/direct/token-source.ts` |

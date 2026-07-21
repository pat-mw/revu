# Operator runbook — broker and host-collector deployment

This runbook covers running revu in broker mode and operating the host-side
collector surface. App-creation steps (registering a GitHub App, configuring
OAuth) are covered in a forthcoming on-prem/ops sub-document; they are not
reproduced here.

## Broker mode overview

In broker mode the daemon runs inside a disposable workspace container. A
GitHub App installation token is injected from the host into the workspace's
`~/.git-credentials` file; the daemon reads it on every request and never
mints credentials of its own. The daemon binds to loopback (`127.0.0.1`) so
the injected credential is never reachable from outside the workspace.

Differences from direct mode:

1. The token source is `createFileCredentialTokenSource` — it reads the
   credential file fresh on every request instead of shelling out to `gh`.
2. Boot tolerates an absent credential (the file may be missing for a short
   window at container start). The daemon starts and surfaces an
   `broker_unreachable` state per request until the credential lands.
3. The HTTP server binds `127.0.0.1`, not `0.0.0.0`.

Source: `packages/revud/src/index.ts` — `mainBroker`;
`packages/revud/src/broker/token-source.ts` — `createFileCredentialTokenSource`.

## Starting the daemon in broker mode

```bash
REVU_MODE=broker bun run revud
```

The target repository is resolved from the `origin` remote, exactly as in
direct mode. Override it with `--repo owner/name` or `REVU_REPO`.

## Credential injection

The host-side broker mints a short-lived GitHub App installation token and
writes it into the workspace container's credential file. The file must be in
`git-credential-store` format:

```
https://x-access-token:<token>@github.com
```

The daemon's token source reads this file fresh on every API call, preferring
an `x-access-token` entry over any other `github.com` entry. The file must be
accessible at `~/.git-credentials` or at the path named by
`REVU_CREDENTIALS_FILE`.

The file is REPLACED on rotation (not appended); the daemon always reads the
current token and never caches a stale one.

Source: `packages/revud/src/broker/token-source.ts` — `createFileCredentialTokenSource`,
`selectGithubToken`.

### `REVU_CREDENTIALS_FILE`

Override the credential file location:

```bash
REVU_CREDENTIALS_FILE=/run/secrets/git-credentials REVU_MODE=broker bun run revud
```

Source: `packages/revud/src/broker/token-source.ts` — `CREDENTIALS_FILE_ENV_VAR`.

### `scripts/broker-mint-token.ts` — the host-broker simulator

This script plays the host-broker role for local smoke testing. It signs an
App JWT from a PEM key, exchanges it for a GitHub App installation token via
the GitHub API, and writes the token into a credential file in the format the
daemon expects. Standard output carries a redacted prefix, the expiry, the
granted permissions, and the App bot login; the token itself is never printed.

```bash
REVU_APP_PEM=/path/to/key.pem \
REVU_APP_ID=12345 \
REVU_INSTALLATION_ID=67890 \
REVU_CREDENTIALS_FILE=/tmp/git-credentials \
bun run scripts/broker-mint-token.ts
```

Optional: `REVU_TOKEN_REPOS` — a comma-separated list of `owner/repo` values
to scope the installation token to specific repositories.

Source: `scripts/broker-mint-token.ts`.

## Bot login and writes

Broker writes (submit review, reply, resolve/unresolve, react) are only enabled
when the deployment configures the GitHub App's bot login via `REVU_BOT_LOGIN`.
Without it the daemon starts in reads-only mode and all four write endpoints
return 501.

When `REVU_BOT_LOGIN` is set, every write is:
- stamped with the human's display name as a prefix in the comment body, and
- journaled to the append-only `audit_log` table in the workspace's local
  direct store under the human's id (the lowercased git-config email). The host
  store's audit journal is populated separately, when the collector pulls each
  workspace's local store and merges the rows with `ON CONFLICT ... DO NOTHING`
  (see the Host collector section below). Scripts querying the host audit journal
  will see no rows until at least one collector tick has pulled the workspace.

```bash
REVU_MODE=broker REVU_BOT_LOGIN=my-app[bot] bun run revud
```

The bot login is typically the App slug followed by `[bot]`; `broker-mint-token.ts`
prints it as `bot login: <slug>[bot]` after minting.

Source: `packages/revud/src/direct/session.ts` — `resolveBotLogin`;
`packages/revud/src/index.ts` — `mainBroker`.

## Reviewer assignments — `REVU_REVIEWERS_FILE`

The broker's reviewer-assignment surface is a YAML file the lead edits. It maps
PR numbers to assigned human ids and GitHub logins to human ids. The poll loop
re-reads this file on every tick (approximately every 30 seconds), so a lead's
edit takes effect without a daemon restart.

Default location: `reviewers.yaml` in the data directory (alongside the SQLite
store). Override with `REVU_REVIEWERS_FILE`.

File format:

```yaml
humans:
  octocat: h-priya      # github login -> Human.id
  hubot: h-marcus
assignments:
  347: [h-priya]        # pr number -> [assigned Human.id ...]
  355: [h-priya, h-marcus]
```

A read failure, YAML syntax error, or unrecognized shape keeps the last-good
record and logs a warning. The warning never echoes the file's bytes.

Source: `packages/revud/src/broker/reviewer-assignment.ts` — `createReviewerAssignments`,
`resolveReviewersFile`.

## Loopback binding

The daemon in broker mode binds to `127.0.0.1` only. The host reaches it
through a forwarded port. This is not configurable; it is structural: the
injected credential must never be reachable from outside the workspace.

Source: `packages/revud/src/index.ts` — `mainBroker` (`hostname: '127.0.0.1'`).

## Durable data directory

Broker-mode state persists to `${XDG_DATA_HOME:-~/.local/share}/revu` (the
same path as direct mode). Override with `REVU_DATA_DIR`. The reviewer
assignments file lives in the same directory.

Source: `packages/revud/src/direct/store.ts` — `resolveDirectDataDir`.

---

## Host collector

The host-side collector holds per-human durable state pulled from workspace
containers: drafts, viewed state, and the merged audit journal. It lives in a
separate SQLite file (`host.sqlite`) so it never shares a file with any
workspace's direct-mode store.

### `REVU_HOST_DATA_DIR`

Override the host store data directory:

```bash
REVU_HOST_DATA_DIR=/var/lib/revu/host bun run scripts/broker-audit.ts ...
```

Default: `${XDG_DATA_HOME:-~/.local/share}/revu/host`.

Source: `packages/revud/src/collector/host-store.ts` — `resolveHostDataDir`.

### `REVU_OWNER_MAP_FILE`

The host store is keyed exclusively by `coder.owner` (the container's workspace
label), not by any workspace-claimed identity. Every operator CLI resolves a
`coder.owner` through a JSON owner map to the canonical email key.

Point `REVU_OWNER_MAP_FILE` at a JSON file shaped as:

```json
{
  "alice": { "email": "alice@example.com", "displayName": "Alice" },
  "bob":   { "email": "bob@example.com" }
}
```

The key is `coder.owner`; `email` is required; `displayName` is optional.

Source: `packages/revud/src/collector/config.ts` — `loadOwnerResolver`.

---

## Operator scripts

### `scripts/broker-audit.ts` — audit export

Exports the host store's append-only audit journal. The journal records every
write that reached GitHub under the shared bot identity: which human (by
binding email), which workspace (`coder.owner`), which endpoint, which PR, the
GitHub-assigned id, and when.

```bash
bun run scripts/broker-audit.ts [--owner <coder.owner>] [--pr <n>] \
  [--since <ISO-8601 UTC>] [--format <table|json|csv>]
```

Flags:

| Flag | Description |
| --- | --- |
| `--owner <coder.owner>` | Scope to one human (resolved through the identity binding). |
| `--pr <n>` | Narrow to one pull request (positive integer). |
| `--since <ISO-8601 UTC>` | Narrow to rows created at or after this instant; also accepts `YYYY-MM-DD`. |
| `--format table\|json\|csv` | Output format (default: `table`). |

Exit codes: 0 success (including an empty result), 1 configuration or
unbound-owner or store failure, 2 bad usage.

Requires `REVU_OWNER_MAP_FILE` and optionally `REVU_HOST_DATA_DIR`.

Source: `scripts/broker-audit.ts`.

### `scripts/broker-offboard.ts` — offboard a departed human

Purges a departed human's working state (drafts and per-PR viewed rows) from
the host store while retaining every audit row. The audit journal is the
permanent compliance record and is never deleted.

```bash
bun run scripts/broker-offboard.ts --owner <coder.owner>
```

Run this BEFORE removing the owner from the owner map. Once their entry is gone
the owner no longer resolves and the script exits with an error, having purged
nothing.

Requires `REVU_OWNER_MAP_FILE` and optionally `REVU_HOST_DATA_DIR`.

Source: `scripts/broker-offboard.ts`.

### `scripts/seed-scratch.ts` — seed fixture pull requests

Seeds a scratch GitHub repository with fixture pull requests that cover the
hard cases a PR-review client must survive: a clean small change, a large
change, a mid-review PR with resolved and outdated threads, a base-advance PR,
and a force-push drift PR. The script is idempotent; re-running converges to
the same PR numbers and end state.

```bash
bun run scripts/seed-scratch.ts
bun run scripts/seed-scratch.ts --repo owner/name --workspace /path/to/clone
```

A hard guard refuses to run unless the target satisfies **both** conditions: it
is on the built-in allow set of intended scratch repositories, **and** its name
contains one of the markers `sandbox`, `scratch`, or `fixture`. Adding a new
scratch target therefore means both listing it in the allow set and giving it a
marked name. This prevents the script from mutating a real repository by
accident.

Two targets are currently allow-listed: `pat-mw/revu-sandbox` and
`apoha-pat/revu-sandbox` (private, owned by the `apoha-pat` user account). The
latter is installed with the scratch GitHub App `revutestbed`; its permission
grant — deliberately one permission wider than the production App's — and the
owner decision behind that gap are recorded in `docs/agent/CHECKPOINT_2.md`
§E.3 and `docs/agent/MILESTONES.md`'s M3.1 (deferred) issue.

Requires an authenticated `gh` CLI with `repo` scope. The script shells out to
`gh` and `git`; it never handles a token itself.

Source: `scripts/seed-scratch.ts`.

---

## Environment variable reference

| Variable | Default | Source file |
| --- | --- | --- |
| `REVU_MODE` | `mock` | `packages/revud/src/index.ts` |
| `REVU_PORT` | `4780` | `packages/revud/src/index.ts` |
| `REVU_REPO` | origin remote | `packages/revud/src/index.ts` |
| `REVU_DATA_DIR` | `~/.local/share/revu` | `packages/revud/src/direct/store.ts` |
| `REVU_DIST_DIR` | `packages/app/dist` | `packages/revud/src/index.ts` |
| `REVU_BOT_LOGIN` | — (reads-only) | `packages/revud/src/direct/session.ts` |
| `REVU_CREDENTIALS_FILE` | `~/.git-credentials` | `packages/revud/src/broker/token-source.ts` |
| `REVU_REVIEWERS_FILE` | `<data-dir>/reviewers.yaml` | `packages/revud/src/broker/reviewer-assignment.ts` |
| `REVU_HOST_DATA_DIR` | `~/.local/share/revu/host` | `packages/revud/src/collector/host-store.ts` |
| `REVU_OWNER_MAP_FILE` | — (required for CLIs) | `packages/revud/src/collector/config.ts` |

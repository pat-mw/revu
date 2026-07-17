# Direct-mode auth — the `gh` scopes for seeding and reviewing

Direct mode talks to GitHub **as a real user** (no GitHub App, no shared bot
identity). Both seeding the scratch repository and driving a review from a
review client authenticate through the `gh` CLI's stored credentials, so the
signed-in account needs the permissions below.

## Required scopes

A classic personal-access token (what `gh auth login` stores) needs a single
top-level scope:

| scope | why it is needed |
| --- | --- |
| `repo` | Full read/write to the target repository — creating branches and commits (Contents read/write), opening and editing pull requests, and posting/reading/resolving review comments and threads (Pull requests read/write). GitHub's classic `repo` scope is coarse: it is the umbrella that grants all of these. |

For a **fine-grained** token or a GitHub App installation, the coarse `repo`
scope decomposes into these repository permissions:

| permission | level | used for |
| --- | --- | --- |
| Contents | Read and write | Push branches/commits; read blobs and trees during sync. |
| Pull requests | Read and write | Open/edit PRs; create, list, and reply to review comments; resolve/unresolve review threads. |
| Metadata | Read | Mandatory baseline whenever any other permission is granted. |

Resolving a review thread uses the GraphQL `resolveReviewThread` mutation; it is
covered by the same Pull requests **write** permission (`repo` for a classic
token) — there is no separate scope for it.

## What the seeder specifically exercises

`scripts/seed-scratch.ts` needs, at minimum:

- **Contents: write** — bootstrap the default branch, push fixture branches,
  force-push rewritten heads, advance a base branch.
- **Pull requests: write** — create/reopen/edit fixture PRs, post inline review
  comments (REST), and resolve one review thread (GraphQL mutation).
- **Metadata: read** — implicit.

The classic **`repo`** scope satisfies all of the above. It never handles a
token directly: it shells out to `gh` (which supplies the credential) and to
plain `git` (which uses `gh`'s credential helper over HTTPS).

## Verifying your auth (without printing the token)

```bash
gh auth status          # shows account + token scopes; never echo the token
```

The output's `Token scopes:` line must include `repo`. `read:org` and
`workflow` are unrelated to direct-mode review and are not required for it.

## Extra scopes for a private scratch repo

If the scratch repository is **private**, the classic `repo` scope already
covers private repositories (it is not limited to public ones), so no
additional scope is needed. A fine-grained token must simply have the private
repository in its selected-repositories list.

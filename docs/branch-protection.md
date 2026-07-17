# Branch protection — requiring the CI gate on `main`

The CI workflow (`.github/workflows/ci.yml`, job **`check`**) runs the full gate
(`bun run check` = oxlint + tsc -b + bun test + vite build) on every pull request and
on pushes to `main`. To make a green **`check`** a *requirement* for merging into
`main`, enable branch protection.

## When to enable

**After the MT foundation stack has merged to `main`.** The `check` context only
becomes a selectable required check once the workflow exists on `main` and has
reported at least once. Enabling it earlier — before the workflow is on `main` —
would block the very pull requests that introduce it. This is why the automation
does not apply protection itself.

## Enable it (gh CLI)

```bash
gh api -X PUT repos/pat-mw/revu/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["check"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

- `required_status_checks.contexts = ["check"]` — a green CI `check` run is required
  before merge.
- `strict = false` — does **not** force a branch to be up to date with `main` first,
  so a stacked PR train still merges base-up without a rebase between each merge.
- `enforce_admins = false` — a repo admin can still merge in a pinch; set `true` to
  hold everyone to the gate.
- `required_pull_request_reviews = null` — requires the check but not a human
  approval; supply a reviews object if you also want required reviews.

Equivalent UI path: **Settings → Branches → Add branch ruleset / rule for `main` →
"Require status checks to pass before merging" → select `check`.**

## Verify (MT.3 acceptance)

Open a pull request whose branch has a deliberately failing test. The `check` run
goes red and the PR's merge button is blocked until it is fixed. Disabling or
skipping the gate to merge is never the fix.

## Disable / inspect

```bash
gh api repos/pat-mw/revu/branches/main/protection            # inspect current rules
gh api -X DELETE repos/pat-mw/revu/branches/main/protection  # remove protection
```

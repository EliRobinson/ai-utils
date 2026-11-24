# CI

GitHub Actions runs one workflow, `.github/workflows/ci.yml`, on every pull request to `main`, every push to `main`, and by hand (`workflow_dispatch`). Its one job is `validate`. **`validate` must pass before a PR is merged.**

## What `validate` runs

Run the same checks locally from the repo root (or your worktree) before you push:

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/validate-plugins.py
node scripts/check-agent-hooks.mjs
node plugins/asks-board/skills/asks-board-setup/scripts/check-board-page.mjs
```

They need only Python 3 and Node, with no packages and no `claude` CLI. `validate-plugins.py` also runs every `plugins/*/skills/*/scripts/check-*.mjs` when `node` is installed, so the board check runs twice in CI; the separate step names the failure.

## Workflow rules

`scripts/validate-plugins.py` fails if any workflow in `.github/workflows/` breaks these:

- Top-level `permissions:` is exactly `contents: read`. Nothing asks for write access.
- No `pull_request_target`. No secrets.
- Every `uses:` is from `actions/` or `github/`, pinned to a full 40-hex commit SHA, with a `# vX.Y.Z` comment naming the version.
- `ci.yml` exists and has the job `validate` (`name: validate`).

`actions/checkout` runs with `persist-credentials: false`. A newer run on the same ref cancels the older one, and the job times out after 10 minutes.

## Updating a pinned action

Dependabot (`.github/dependabot.yml`) opens a weekly PR that bumps the pinned SHAs. To pin by hand, resolve the tag to its commit, then follow the annotated tag if it is one:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.type + " " + .object.sha'
gh api repos/actions/checkout/git/tags/<sha>  --jq .object.sha   # only when the type is "tag"
```

# CI

GitHub Actions runs one workflow, `.github/workflows/ci.yml`, on every pull request to `main`, every push to `main`, and by hand (`workflow_dispatch`). Its one job is `validate`. **`validate` must pass before a PR is merged.** The coordinator checks this at merge step 3 in [coordinator-prompt.md](coordinator-prompt.md#merging). GitHub enforces it only when the owner makes `validate` a required status check (see [Owner settings](#owner-settings)).

## What `validate` runs

`validate` runs the whole test gate, one command. Run the same command from the repo root (or your worktree) before you push:

```bash
python3 scripts/validate-plugins.py
```

It needs Python 3 and Node, with no packages and no `claude` CLI. It runs the plugin and skill checks, the unit tests in `scripts/test_*.py`, the workflow rules below, and every `plugins/*/skills/*/scripts/check-*.mjs` self-check. Locally it skips the self-checks with a note if Node is missing. In CI it fails instead, so CI never skips them.

## When `validate` fails

1. Open the failed run: `gh run view <run-id> --log-failed`, or the PR's checks tab. The validator lists every problem as `path:line: what is wrong; what to do`.
2. Run `python3 scripts/validate-plugins.py` in your worktree and fix each problem.
3. Push a new commit to the same branch. Never force push. Whether the fix needs another review round is set by [review-gate.md](review-gate.md#at-most-two-rounds).
4. A cancelled run is not a failure. A newer push to the same PR cancels the older run. To rerun it, use `gh run rerun <run-id>`.

## Workflow rules

`scripts/validate-plugins.py` fails if any workflow in `.github/workflows/` breaks these:

- Top-level `permissions:` is exactly `contents: read`. Nothing asks for write access.
- No `pull_request_target`, `workflow_run` or `issue_comment` trigger. These run with the base repo's rights on events an outsider can start.
- No secrets: no `secrets` in a `${{ }}` expression, and no `secrets:` key.
- Every `uses:` is from `actions/` or `github/`, pinned to a full 40-hex commit SHA, with a `# vX.Y.Z` comment naming the version. Reusable workflows are not allowed. A `uses` written in a form the check cannot read fails.
- Every `actions/checkout` step sets `persist-credentials: false`, so later steps cannot read the token.
- `ci.yml` has the job `validate` (`name: validate`).

The workflow also sets these, which the validator does not check: a newer push to a PR cancels that PR's older run (runs on `main` always finish), and the job times out after 10 minutes.

## Updating a pinned action

Dependabot (`.github/dependabot.yml`) opens a weekly PR that bumps the pinned SHAs. It waits 7 days after a release, so a bad release can be caught before it is pinned.

A Dependabot PR has no ticket, no branch name in our format and no `## Review` record, so it is never merged as it is. An agent takes it as follows:

1. File a ticket for the bump.
2. Make the same change on its own branch.
3. Check each new SHA against its tag upstream (commands below).
4. Run the review gate and open its own PR.
5. Close the Dependabot PR with a link to the new one.

Check the SHA on every pin change, by hand or by Dependabot. GitHub resolves a SHA across a repo's whole fork network, so a commit pushed to a fork can pose as `actions/checkout@<sha>`. Only a SHA that matches the upstream tag counts.

To find a tag's commit, look up the tag. If the object type is `tag`, look up that tag object to get its commit:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.type + " " + .object.sha'
gh api repos/actions/checkout/git/tags/<sha>  --jq .object.sha   # only when the type is "tag"
```

## Owner settings

These are GitHub settings. Only the owner changes them; agents never do.

- Make `validate` a required status check on the `main` ruleset, so GitHub refuses a merge until it passes.
- Require approval before workflows run for outside contributors (Settings, Actions, General).

A PR runs its own copy of `ci.yml` and of the validator. So a PR that changes `.github/` or `scripts/validate-plugins.py` can change what `validate` checks. Review those files closely.

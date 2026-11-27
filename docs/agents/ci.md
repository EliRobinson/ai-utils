# CI

GitHub Actions runs one workflow, `.github/workflows/ci.yml`, on every pull request to `main`, every push to `main`, and by hand (`workflow_dispatch`). Its one job is `validate`. **`validate` must pass before a PR is merged.** The coordinator checks this at merge step 3 in [coordinator-prompt.md](coordinator-prompt.md#merging). GitHub enforces it only when the owner makes `validate` a required status check (see [Owner settings](#owner-settings)).

## What `validate` runs

`validate` runs the whole test gate, one command. Run the same command from the repo root (or your worktree) before you push:

```bash
python3 scripts/validate-plugins.py
```

It needs Python 3 and Node, with no packages and no `claude` CLI. It runs the plugin and skill checks, the unit tests in `scripts/test_*.py` and in every `plugins/*/skills/*/scripts/tests/` folder (each folder in its own process), the workflow rules below, and every `plugins/*/skills/*/scripts/check-*.mjs` self-check. Locally it skips the self-checks with a note if Node is missing. In CI it fails instead, so CI never skips them.

## When `validate` fails

1. Find the run: `gh pr checks <PR number>` shows a link to it, and `gh run list -b <branch> -w ci -L 1` shows its ID.
2. Read the failure: `gh run view <run-id> --log-failed`. Each problem starts with its path, and its line where one is known. Most problems also say what to do. A unit test failure names the failing tests.
3. Run `python3 scripts/validate-plugins.py` in your worktree and fix each problem.
4. Push a new commit to the same branch. Never force push. Whether the fix needs another review round is set by [review-gate.md](review-gate.md#at-most-two-rounds).

A cancelled run is not a failure: a newer push to the same PR cancels the older run. To rerun a cancelled run, use `gh run rerun <run-id>`.

## Workflow rules

`scripts/workflow_rules.py` holds these rules, and `validate-plugins.py` fails if any workflow in `.github/workflows/` breaks them:

- Top-level `permissions:` is exactly `contents: read`. No `permissions` below the top level, and nothing asks for write access.
- No `pull_request_target`, `workflow_run` or `issue_comment` trigger. These run with the base repo's rights on events an outsider can start.
- The word `secrets` appears nowhere. CI uses no secrets.
- No `github.event`, `github.head_ref` or `inputs` data. An outsider can set it, and it can inject code into a step.
- Every `uses:` is from `actions/` or `github/`, pinned to a full 40-hex commit SHA, with a `# vX.Y.Z` comment naming the version. Local actions and reusable workflows are not allowed.
- Every `actions/checkout` step sets `persist-credentials: false` under `with:`, so later steps cannot read the token.
- `ci.yml` has the job `validate` (`name: validate`).

The check reads lines, not parsed YAML, so it is strict on purpose. A form it cannot read fails, and so does a banned word anywhere outside a whole-line comment. It also fails on `\x`, `\u` and `\U` escapes and on a line that ends in `\`, because these can spell a banned word. Any `key: write` value fails too, even outside `permissions`.

The workflow also sets these, which the validator does not check: a newer push to a PR cancels that PR's older run, every other run (such as each push to `main`) runs on its own, and the job times out after 10 minutes.

## Reviewing CI changes

A PR runs its own copy of `ci.yml` and of the validator. So a PR that changes `.github/`, `scripts/validate-plugins.py` or `scripts/workflow_rules.py` can change what `validate` checks. Review those files closely.

## Updating a pinned action

Dependabot (`.github/dependabot.yml`) opens at most one PR a week, which bumps every pinned action at once. It waits 7 days after a release, so a bad release can be caught before it is pinned.

A Dependabot PR has no ticket, no branch name in our format and no `## Review` record, so it is never merged as it is. The coordinator watches for these PRs and hands each one to an agent, which:

1. Reports to the coordinator, which asks Eli in the coordinator chat for a yes to file a ticket for the bump. The agent files it only after the coordinator passes on Eli's own words; a board click is not a yes.
2. Makes the same change on its own branch.
3. Checks each new SHA against its tag upstream (commands below).
4. Runs the review gate and opens its own PR.
5. Closes the Dependabot PR with a link to the new one.

Check the SHA on every pin change, by hand or by Dependabot. GitHub resolves a SHA across a repo's whole fork network. So a commit pushed to a fork can pose as `actions/checkout@<sha>`. Only a SHA that matches the upstream tag counts.

To find a tag's commit, look up the tag. If the object type is `tag`, look up that tag object to get its commit:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.type + " " + .object.sha'
gh api repos/actions/checkout/git/tags/<sha>  --jq .object.sha   # only when the type is "tag"
```

## Owner settings

These are GitHub settings. Only the owner changes them; agents never do.

- Make `validate` a required status check on the `main` ruleset, so GitHub refuses a merge until it passes.
- Require approval before workflows run for outside contributors (Settings, Actions, General).

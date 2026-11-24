# Git workflow

## Your own worktree

Several agents work against one clone at once. Each one works in its own linked worktree, never in the shared main checkout and never in another agent's worktree.

```bash
git fetch origin
git worktree add ../<repo>-<task> -b <username>/<ticket>/<short-description> origin/main
cd ../<repo>-<task>
```

- Name the branch as `AGENTS.md` says: `<username>/<ticket>/<short-description>`.
- An agent started with the Agent tool's `isolation: "worktree"` gets a branch with a made-up name. Rename it before the first commit: `git branch -m <username>/<ticket>/<short-description>`. If that name already exists, stop and report it; never use `-M`. Report the branch name you used.

- Fetch first, or you branch off a stale `main`.
- Commit early. Uncommitted work in a worktree has no protection.
- Never touch a worktree you did not create. You cannot tell an idle one from one whose owner is mid-edit.
- `cd` does not last between tool calls. Use absolute paths or `git -C <worktree>`.

## The main-checkout hook

`scripts/guard-main-checkout-hook.mjs` runs before every Bash call (wired in `.claude/settings.json`). It refuses git commands that change the working tree or a local ref when they would run in this repo's main checkout: `add`, `commit`, `checkout`, `reset`, `rebase`, `stash`, `worktree remove` and the like.

- Reads still work: `status`, `log`, `diff`, `show`, `fetch`, `stash list`, `worktree add`.
- To run one command in the main checkout anyway, prefix it: `ALLOW_MAIN_CHECKOUT_WRITE=1 git worktree remove ../<repo>-<task>`. Say in your next message that you used it, and why. An exported variable does not count.
- It is a guard against accidents, not a security boundary. It reads `eval '...'` and `sh -c '...'` scripts, and follows a `cd` inside a literal `eval`. It allows what it cannot read: a directory built at run time, a `cd` it cannot follow, a command it cannot parse, and its own crash.
- Check it with `node scripts/check-agent-hooks.mjs`.

## Branches and PRs

- One item, one agent, one worktree, one branch, one PR.
- Branch off `origin/main`. Never push to `main`.
- Keep the same branch and the same PR until it merges. Review fixes are new commits on that branch. Never open a second branch or PR for the same item.
- Before your first push, you may rebase your own local commits onto `origin/main`.
- Never force push, and never rewrite commits you have pushed. If `main` moves after you pushed, catch up on the same branch: `git fetch origin && git merge origin/main`, resolve any conflicts in the merge commit, run the checks, and push normally.
- Once the PR exists, `gh pr update-branch <N>` does the same merge on GitHub. Never add `--rebase`: it rewrites the pushed branch. There is nothing to push afterwards. Before your next commit, run `git pull --ff-only origin <branch>` in your worktree, or that push is refused. If it cannot fast-forward because you have commits you have not pushed, run `git merge origin/<branch>` and push normally. If `gh pr update-branch` reports conflicts, catch up with `git merge origin/main` as above.
- [review-gate.md](review-gate.md) says when a catch-up needs review.
- Review before you open the PR, drafts included: see [review-gate.md](review-gate.md).
- Only the coordinator merges, and only as the merge policy below allows. It follows the merge steps in [coordinator-prompt.md](coordinator-prompt.md#merging): up to date with `main`, review record complete, test gate passed on the exact head, merge lock, then `gh pr merge N --<style> --match-head-commit <sha>` in the merge style below.

## Merge style

- **Merge style:** `squash`

This line is the repo's merge style, the way it merges a PR: `merge` (a merge commit), `squash` or `rebase`. It is the `--<style>` flag of `gh pr merge`, and the setup skill writes it.

`squash` is the default for new repos. A branch that caught up by merging `main` in has merge commits, and GitHub can refuse to rebase-merge it. A squash merge lands one linear commit per PR.

If the line is missing or not one of the three, find the style with the steps below. Never pick a default yourself; ask the owner when the steps give no answer.

1. Check what the GitHub repo allows: `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`.
2. If only one is allowed, use it.
3. If more than one is allowed, ask the owner which one.

## Merge policy

- **Merge policy:** `ask`

This line says who decides that a PR merges. The setup skill writes it, and the coordinator reads it before each merge.

- `ask` (the default): the coordinator merges PR N only after the owner types "merge N" in chat. It asks for that in chat, never on the Asks board: the board cannot merge, and a click there is not approval.
- `auto`: the coordinator merges a PR on its own once it is ready: up to date with `main`, review record complete, test gate and CI passed on the exact head sha. It still takes the merge lock, names the head with `--match-head-commit`, never forces and never bypasses a hook. It tells the owner after each merge.

If the line is missing or is not one of the two, the policy is `ask`.

With `auto`, Claude Code's auto mode refuses the merge until the owner adds a permission rule. Auto mode's classifier blocks "merging a PR no human has approved" by default, and an agent's review record does not count as a human. The owner adds this rule themselves; no agent edits settings for them. Put it in the main checkout's `.claude/settings.local.json` for this repo only, or in `~/.claude/settings.json` for every repo:

```json
{ "permissions": { "allow": ["Bash(gh pr merge *)"] } }
```

The rule lets `gh pr merge` run without the classifier. The review gate hook still runs before it and still refuses a PR without a complete record. If `autoMode.classifyAllShell` is `true`, auto mode ignores the rule, and the merge needs the owner's "merge N" again.

**To change the policy,** ask a coordinator to "change the merge policy to `ask`" (or `auto`). It runs the `setup-agentic-workflow` skill, whose "Change the merge policy" section changes this line and the merge bullet in `AGENTS.md` in one PR. A running coordinator reads this line before each merge, so the change applies from the next merge.

## What is enforced, and what is a rule

Two hooks check commands: the main-checkout guard above and the [review gate](review-gate.md). GitHub enforces "no push to `main`" and the merge style if the repo has the `main` ruleset. Everything else here is a rule that agents follow, with no hook behind it: no force push, one branch and one PR per item, and the one below.

## Hooks are never bypassed

Never run `git commit --no-verify`, `git push --no-verify` or `HUSKY=0`. If a hook fails, fix the cause. If the cause is outside your change, stop and report it.

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
- It is a guard against accidents, not a security boundary. It allows what it cannot read: a directory built at run time, a `cd` it cannot follow, a command it cannot parse, and its own crash.
- Check it with `node scripts/check-agent-hooks.mjs`.

## Branches and PRs

- One item, one agent, one worktree, one branch, one PR.
- Branch off `origin/main`. Never push to `main`.
- Catch up with `git rebase origin/main`. Never merge `main` into a branch.
- Never force push. If `main` moves after you pushed, rebase onto a new `<branch>-r2` and push that. Run the review gate on it again if the rebase changed more than a clean replay (this uses a round; see [review-gate.md](review-gate.md)), then open a new PR. Close the old one with a link to the new one.
- Review before you open the PR, drafts included: see [review-gate.md](review-gate.md).
- Only the coordinator merges, and only after the owner types "merge N" in chat. It follows the merge steps in [coordinator-prompt.md](coordinator-prompt.md#merging): up to date with `main`, review record complete, test gate and the `validate` CI job passed on the exact head, merge lock, `gh pr merge --rebase --match-head-commit <sha>`.

## What is enforced, and what is a rule

Two hooks check commands: the main-checkout guard above and the [review gate](review-gate.md). GitHub enforces "no push to `main`" and "rebase merges only" if the repo has the `main` ruleset. Everything else here is a rule that agents follow, with no hook behind it: no force push, rebase instead of merge, one item per PR, and the one below.

## Hooks are never bypassed

Never run `git commit --no-verify`, `git push --no-verify` or `HUSKY=0`. If a hook fails, fix the cause. If the cause is outside your change, stop and report it.

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
- Only the coordinator merges, and only as the merge policy below allows. It follows the merge steps in [coordinator-prompt.md](coordinator-prompt.md#merging): up to date with `main`, review record complete, test gate and CI passed on the exact head, merge lock, then `gh pr merge N --<style> --match-head-commit <sha>` in the merge style below.

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

This line says who decides that a PR merges: `ask` or `auto`. The setup skill writes it, and the `AGENTS.md` merge bullet names the same value. This section is the full rule; other files point here.

- `ask` (the default): the coordinator merges PR N only after the owner types "merge N" in chat. It asks for that in chat, never on the Asks board: the board cannot merge, and a click there is not approval.
- `auto`: the coordinator merges a ready PR on its own, through every one of its merge steps: up to date with `main`, review record complete, test gate and CI passed on the exact head sha, merge lock, `--match-head-commit`. It never forces and never bypasses a hook. It tells the owner the head sha after each merge.

**How the coordinator reads it.** Before each merge it runs `git fetch origin` and reads this line and the `AGENTS.md` bullet as they are on `origin/main` (`git show origin/main:docs/agents/git-workflow.md` and `git show origin/main:AGENTS.md`; if either prints only a path, that file is a symlink, so read the path it names the same way). It never reads them from a working tree or a PR's branch, so a local edit or the PR being merged cannot change the policy. The policy is `auto` only when each file has exactly one policy line and both say `auto`. Anything else is `ask`: no line, two lines, another value, or the two files disagreeing. Needing both files is deliberate: one stray edit cannot turn `auto` on.

**What `auto` never covers.** Even under `auto`, the coordinator asks for "merge N" in chat, as under `ask`, and says in a few words why (for example "it changes workflow files"), for:

- a PR that changes the workflow or its checks. The coordinator lists the files with `git diff --name-only --no-renames origin/main...<sha>`, on the exact head sha it tests and merges, so both sides of a rename show. These are:
  - any file under `.claude/`, `.github/` or `docs/agents/`, `AGENTS.md`, `CLAUDE.md`, or a hook script (`scripts/*hook*`);
  - git hook config: `.husky/`, `.githooks/`, `.pre-commit-config.yaml`, `lefthook.yml`;
  - the test gate: the files that define the test gate command in the coordinator prompt (such as the `package.json` scripts or the test runner's config);
  - the target of any of these paths that is a symlink on `origin/main`.

  So a PR that changes the merge policy always waits for the owner. If the file list cannot be read, the PR is not covered;
- a PR its own agents did not open: it has no row in the ownership registry, or `gh pr view N --json isCrossRepository,author` shows a fork or an author other than the owner's `gh` login;
- a draft PR, and a PR on hold. When the owner says "hold N" in chat, the coordinator writes `hold` in that PR's registry row, so a new coordinator chat sees it too. The hold ends when the owner types "merge N".

**Auto mode and the permission rule.** Claude Code's auto mode classifier blocks a merge no human has approved (its "Merge Without Review" rule), and an agent's review record does not count as a human. So under `auto` the owner adds a permission rule themselves, in the main checkout's `.claude/settings.local.json`. No agent edits settings for them. Add these entries to the `allow` and `deny` lists there, creating the file if it is missing; do not replace what is already in it. Use `owner/name` for this repo:

```json
{
  "permissions": {
    "allow": ["Bash(gh pr merge * --match-head-commit * -R owner/name)"],
    "deny": ["Bash(gh pr merge *--admin*)", "Bash(gh pr merge *--auto*)"]
  }
}
```

The allow rule fits only this repo's merge command with the tested head named. It does not limit which agent runs it, so only the coordinator ever runs `gh pr merge`. The deny rules keep `--admin` (which skips branch protection) and `--auto` (which merges later, after the checks) blocked; they are worth adding under `ask` too. Do not put the allow rule in `~/.claude/settings.json`: it would also lift the classifier's check in every repo on `ask`. The review gate hook still runs before every merge. If `autoMode.classifyAllShell` is `true`, auto mode ignores the allow rule. These are facts about Claude Code as of agent-roster 1.12.0; if auto mode behaves differently, check Claude Code's permissions documentation.

**When auto mode blocks a merge.** The coordinator stops and tells the owner in chat, in one message: the PR, the rule above, and that the entries go in the main checkout's `.claude/settings.local.json`. The owner either adds them and says "retry N", or types "merge N" to approve that one PR. Either way the coordinator starts the merge steps again from step 1 on the current head. It never edits settings and never retries the merge another way.

**To change the policy,** the owner asks a coordinator in their own words. The `setup-agentic-workflow` skill's "Change the merge policy" section does it. When the policy goes back to `ask`, the owner removes the allow rule above (the deny rules can stay). A coordinator started from the agent-roster 1.12.0 prompt or later reads the policy before each merge, so the change applies from the next merge without a restart. An older coordinator chat does not read it: start a new one.

## What is enforced, and what is a rule

Two hooks check commands: the main-checkout guard above and the [review gate](review-gate.md). GitHub enforces "no push to `main`" and the merge style if the repo has the `main` ruleset. Everything else here is a rule that agents follow, with no hook behind it: no force push, one branch and one PR per item, and the one below.

## Hooks are never bypassed

Never run `git commit --no-verify`, `git push --no-verify` or `HUSKY=0`. If a hook fails, fix the cause. If the cause is outside your change, stop and report it.

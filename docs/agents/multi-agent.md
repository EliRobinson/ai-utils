# Working with other agents

## Claim ownership before you start

The ownership registry lives outside the repo, at `~/.claude/projects/<project-slug>/ACTIVE-OWNERSHIP.md`, so it works across every branch and worktree and never causes a merge conflict. `<project-slug>` is the main checkout's absolute path with every character that is not a letter or digit replaced by `-` (the `setup-agentic-workflow` skill, "The registry", has the exact rule).

1. Read it first. If a row claims your ticket, branch, worktree or files, message that session instead of starting.
2. Add your row before you create a worktree or dispatch an agent: ticket, branch, worktree, and the files you will edit.
3. One owner per ticket, branch and worktree.
4. Hand over in one step: update the row in the same step as the message that hands the work over.
5. Do not delete your row yourself: the coordinator removes it after your PR merges and its cleanup is done. After the merge it deletes your branch and removes your worktree, as the "Cleanup after a merge" section of [coordinator-prompt.md](coordinator-prompt.md#cleanup-after-a-merge) says. It leaves a worktree in place when it holds work that is not in the PR, ignored files such as a local `.env` included. So commit and push all your work before the merge, and keep nothing else in your worktree.
6. A row with no live owner, no pushed branch and no PR is stale. A pushed branch whose PR is not open yet may still be in review: ask its owner before you take it over. Take it over and say so in your row's notes.

A fresh machine has no registry. Create it from the header row, and treat open PRs and remote branches as the only record of other machines' work.

## The coordinator

The chat the owner talks to is the coordinator. It hands off every task to an agent or subagent and stays free to talk; the full rule is in the `route-work` skill. It puts an ask for the owner on the Asks board only when a board click can resolve it: the owner ticks it, picks an option or says "Not needed", and that alone unblocks the work. Any ask a board click cannot resolve goes in the coordinator chat as a direct question, and not on the board, because the owner must answer it in chat anyway: a merge request ("merge N"), filing or editing a ticket, opening a PR, allowing a third review round, and anything else whose answer must be typed in chat. A board row for it only duplicates the question. The test: can a board click alone unblock this? If no, ask in chat only. An ask fails the test if a rule needs the owner's own words for it (an approval to merge, file a ticket, open a PR or run a third round, a deploy, a value to paste), or if any of its options leads to a chat-only step. The merge policy is in [git-workflow.md](git-workflow.md#merge-policy). Only the Board Router watches the board for live pings; the `asks-board` skill's "If you are a project coordinator" section says how a coordinator handles one. Its other rules are in `AGENTS.md` and [coordinator-prompt.md](coordinator-prompt.md). Start one by pasting that prompt as its first message, with the job filled in.

## Peers

- Talk to peers directly (`SendMessage`). Ask the owner of a contract before you guess its shape.
- Do not duplicate work. Check open branches and tickets before you build a helper.
- Never edit files another agent owns.
- Record decisions on the ticket. Messages are not kept.

## Follow-up work is a ticket

When you notice work you are not doing now, make sure it becomes a ticket in the repo's ticketing tool before you finish ([issue-tracker.md](issue-tracker.md) has the tool, its commands and its rules). A subagent reports it to its coordinator, which has `ticket-writer` file it. A TODO comment, a PR body line or a commit message is lost.

- Record dependencies with the tool's own links ("blocked by", sub-tickets), never in prose.
- Put the ticket line that [issue-tracker.md](issue-tracker.md) sets under **Close from a PR** in the PR body, so the merge closes the ticket. When it says `none`, close the ticket after the merge.
- Small enough to do now, and part of your task? Just do it.

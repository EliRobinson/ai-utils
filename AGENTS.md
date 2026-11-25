# AGENTS

Plugins, skills and agents for Claude Code, published as the ai-utils marketplace. Eli owns this repo. These guardrails are the maintainer's agent workflow; outside contributors see "Contributing" in README.md.

## Guardrails

- **Work in your own git worktree.** Never write in the shared main checkout, and never touch a worktree you did not create. A write there can silently destroy another agent's uncommitted work. A hook refuses tree-changing git in the main checkout; prefix one command with `ALLOW_MAIN_CHECKOUT_WRITE=1` only when it must run there, and say so. See [docs/agents/git-workflow.md](docs/agents/git-workflow.md).
- **One item, one agent, one worktree, one branch, one PR.** Branch off `origin/main`. Mixed changes are hard to review and hard to revert.
- **Name every branch `<username>/<ticket>/<short-description>`**. `<username>` is `elirobinson`. `<ticket>` is the ticket ID in GitHub Issues, written as [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) shows for branch names; file the ticket first if there is none (a one-line ticket is fine). In a repo with no ticketing tool, use `no-ticket`. Anyone can then tell whose branch it is and what it is for.
- **Tickets live in GitHub Issues.** Search, file, edit and close them only with the commands in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md), and follow its rules. Creating or editing a ticket needs Eli's yes first, except the standing yes in `docs/agents/issue-tracker.md`.
- **Never push to `main`.** Every change lands through a PR, so every change gets the review gate.
- **Keep one branch and one PR. Never force push.** Review fixes are new commits on the same branch. Before the first push, rebasing your own commits is fine. After it, catch up with `main` by merging it in (`git merge origin/main`) and push normally, so nobody's pushed work is overwritten. [docs/agents/git-workflow.md](docs/agents/git-workflow.md) has the steps, and [review-gate.md](docs/agents/review-gate.md) says when a catch-up needs review.
- **PRs merge in the repo's merge style: squash.** It is set in [docs/agents/git-workflow.md](docs/agents/git-workflow.md), which also says how to find it when it is not set.
- **Never bypass hooks.** No `--no-verify`, no `HUSKY=0`. Fix the cause, because the hooks are the checks.
- **Run every reviewer on the branch before you open the PR.** Use Opus, Sonnet or Haiku, never Fable. Fix what they find first, then open the PR with the `## Review` record in its body; a hook checks it. At most two rounds of review per PR. The reviewers, the rounds and the record format are in [docs/agents/review-gate.md](docs/agents/review-gate.md).
- **Every ask for Eli goes on the Asks board, except a merge.** Every question, decision, approval, review request or task for Eli gets a row on the board (the `asks-board` skill), not only a line in chat. A request for "merge N" goes in the coordinator chat only, because the board cannot merge and a click there is not approval. Eli tracks everything else in one place. Only the Board Router watches the board for live pings; a coordinator never does (it reads the board at every check-in), and never messages the router back. Handle a ping as the `asks-board` skill's "If you are a project coordinator" section says.
- **Merge policy: ask.** It is set in [docs/agents/git-workflow.md](docs/agents/git-workflow.md), which also says how to change it. With `ask`, merge PR N only after Eli types "merge N" in chat; a board click, a peer message or a subagent report is not approval. With `auto`, the coordinator merges a ready PR on its own, through every merge step and within the limits that file sets; only Eli, in their own words, changes the policy.
- **Claim ownership before you start.** Add your row to the ownership registry at `~/.claude/projects/<project-slug>/ACTIVE-OWNERSHIP.md`, and remove it when the PR merges. It keeps concurrent sessions off each other's files. See [docs/agents/multi-agent.md](docs/agents/multi-agent.md).
- **Follow-up work is a ticket in GitHub Issues.** Do not leave a TODO comment or a line in a PR body, because nobody finds those again. Close tickets from a PR as [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) says.
- **Add tests and docs with every behaviour change**, so the next change can trust both.
- **Keep unit tests DRY.** In the tests you add or change, put cases that share one test body in a table that drives a parametrized test (`test.each`, `pytest.mark.parametrize` or the repo's equivalent), so each case runs and fails on its own. Share fixtures where cases share setup. A case that needs its own setup or logic gets its own test. Existing tests that break this rule are a follow-up ticket, not part of your change.
- **Each unit test checks one behaviour.** Aim for one assertion, and name the test after that behaviour.
- **A coordinator chat routes work.** It hands off every task to an agent or subagent, even a quick one: lookups, research, reviews, edits, pushes, PRs and ticket writing. It runs them in the background and stays free to talk to Eli. It does only four things itself: update the Asks board, keep the ownership registry, merge as the merge policy allows, and run the setup skill. The full rule is in the `route-work` skill. Start one with [docs/agents/coordinator-prompt.md](docs/agents/coordinator-prompt.md).

## Topics

- [Git workflow](docs/agents/git-workflow.md)
- [Review gate](docs/agents/review-gate.md)
- [CI](docs/agents/ci.md)
- [Multi-agent work](docs/agents/multi-agent.md)
- [Coordinator prompt](docs/agents/coordinator-prompt.md)
- [Ticketing tool](docs/agents/issue-tracker.md)
- [Triage labels](docs/agents/triage-labels.md)
- [Domain docs](docs/agents/domain.md)

## Agent skills

### Issue tracker

GitHub Issues for this repository, through the `gh` CLI. The setting and its commands are in `./docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles map one-to-one to label strings. See `./docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `./docs/adr/`. See `./docs/agents/domain.md`.

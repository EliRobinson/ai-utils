# Changelog

1.8.0 is the first version published in this public repo. Earlier entries are kept for reference.

## 1.10.0

- **The review gate refuses merges it could not check.** `review-gate-hook.mjs` now refuses `gh api graphql` with the query from a file, stdin or a variable (`-F query=@file`, `--input`, `-f query="$Q"`), `curl` writes to a PR's `pulls/N/merge` or to `pulls`, and `curl` to GitHub's GraphQL API. Inline `gh api graphql -f query='...'` reads and `curl` reads of `pulls` still pass. `check-agent-hooks.mjs` has a case for each, and `review-gate.md` names them.
- **More bypasses closed.** A quoted `eval "gh pr merge 5"` is now read and checked, and `eval` or `sh -c` scripts built at run time, or piped into a shell, are refused when the command names a PR write. `-R owner/name.git`, `--repo https://github.com/owner/name` and other spellings of this repo are checked as this repo instead of passing as another one. New `check-agent-hooks.mjs` cases cover each, plus GraphQL queries from `$(...)` and backticks.

## 1.9.0

**Upgrade steps, in this order:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code.
2. Rerun `setup-agentic-workflow` in each repo set up before 1.9.0. Answer its new merge-style question; it recommends `squash`. On a yes, it updates the `main` ruleset and the repo's merge settings to that style. It also replaces the old branch rule in `AGENTS.md`, `docs/agents/git-workflow.md`, `docs/agents/review-gate.md` and `docs/agents/coordinator-prompt.md`, and refreshes `.claude/agents/` and `scripts/check-agent-hooks.mjs`.
3. If you said yes to the new merge settings, GitHub now refuses `--rebase` merges. The coordinator chat you already run still has the old merge step: tell it to merge the setup PR and every open PR, `-r2` ones included, with `gh pr merge N --<new style>`. Open `-r2` branches can finish that way; do not start new ones.
4. Once the setup PR merges, start a new coordinator chat from the new `docs/agents/coordinator-prompt.md`. Restarting Claude Code is not enough: the old chat keeps its first message.
5. Until the setup PR merges, do not let agents catch up a pushed branch by merging `main` in. The repo's own `AGENTS.md` still forbids it.

**Changes:**

- **No more `-r2` branches.** An item keeps one branch and one PR until it merges, and review fixes are new commits on that branch. When `main` moves after a push, the agent merges `origin/main` into the same branch and pushes normally. `gh pr update-branch` works too, never with `--rebase`; the agent then runs `git pull --ff-only` before its next commit. Rebasing your own commits is fine before the first push. Never force push. The guardrails template, `git-workflow.md`, the coordinator prompt, `pr-finisher`, every agent's rules line, `route-work`, the setup skill and the README say so.
- **Review after a catch-up.** In `review-gate.md`, a catch-up merge is clean when its second parent is already on `main` and `git show --remerge-diff` exits 0 and prints nothing. A clean merge needs no new round, only the test gate on the new head. After resolved conflicts, the security critic, the correctness critic and the reviewers whose areas the conflicted files touch review the remerge diff. That is round 2, or a decision for the owner if both rounds are used. The definition of a round now covers this partial round 2. The record names each merge that is not clean in a `Merges reviewed:` line, and the coordinator checks every merge commit on the branch against it before merging.
- **PRs merge in the repo's merge style.** `git-workflow.md` has a `## Merge style` section with one **Merge style** line: `merge`, `squash` or `rebase`. It also says how to find the style when the line is missing. New placeholder `{{MERGE_STYLE}}` in the coordinator prompt (merge step 5) and the guardrails.
- **Setup asks for the merge style.** It asks with the names question and writes the answer to all three files. It sets the ruleset and repo merge settings to that style, and can update an existing `main` ruleset in place. `squash` is the new default: the ruleset template now allows squash merges. ai-utils moves to squash merges too.
- `check-agent-hooks.mjs` checks that `git merge origin/main` is allowed in a worktree and refused in the main checkout.
- `validate-plugins.py` checks four things:
  - the `-r2` or rebase-only rule does not come back in any doc;
  - each rule file keeps the same-branch rule, and every agent carries its rules line word for word;
  - the ruleset template and the setup's PATCH command allow only `squash`;
  - this repo's `AGENTS.md` and coordinator prompt name the merge style its `git-workflow.md` sets.

## 1.8.0

**Upgrade steps, in this order:**

1. If you added the `community-access` marketplace before 1.8.0, follow "To pin a machine that added the marketplace without the pin" in the README's "The pinned version". Otherwise run `claude plugin marketplace add Community-Access/accessibility-agents#a538edc9edfb98cdd8bae96d6b79542874b478f7`, then `claude plugin install accessibility-agents@community-access`.
2. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code.
3. Rerun `setup-agentic-workflow` in each repo set up before 1.8.0 and merge its setup PR, so the repo's `.claude/agents/accessibility-critic.md` stops loading `axe-accessibility:mcp-audit`.
4. Then `claude plugin uninstall axe-accessibility@deque`.

What changed:

- **The accessibility critic uses the `accessibility-agents` plugin.** Community Access's `accessibility-agents@community-access` replaces Deque's `axe-accessibility`. It needs no login and spends no credits. The critic names it as its only accessibility tool, with no fallback.
- **agent-roster declares the plugin.** `plugin.json` lists it under `optionalDependencies` (at `=7.1.0`), and the ai-utils marketplace sets `allowCrossMarketplaceDependenciesOn: ["community-access"]`. It is optional so agent-roster still loads without it; the critic then reports `BLOCKED` on UI changes. A hard `dependencies` entry would unload all of agent-roster when the plugin is missing or turned off.
- **The plugin is pinned to reviewed version 7.1.0, commit `a538edc9edfb98cdd8bae96d6b79542874b478f7`.** The install command adds the `community-access` marketplace at that commit, which is what pins the code. `plugin.json` also asks for `=7.1.0`, which only picks the version when agent-roster installs the plugin; it does not hold updates. `setup-agentic-workflow` checks the marketplace's `source.ref` and the installed `gitCommitSha`, and offers to re-pin. The README's "The pinned version" says how to re-pin an unpinned marketplace and how to move the pin.
- **The plugin adds hooks to every session.** Its edit hook refuses UI-file edits until `accessibility-agents:accessibility-lead` has run in the session. `implementer-ui` loads that skill before its first UI edit. `implementer-engine`, `mechanical-editor` (which gains the `Skill` tool), `copy-writer` and `pr-finisher` load it when the hook refuses an edit. Each treats the skill as a gate and its checklists as reference only. The README's "What the plugin adds to every session" says so.
- `accessibility-critic` loads no skill and has no `Skill` tool, because the plugin's `accessibility-lead` and `web-accessibility-wizard` skills dispatch subagents and write audit files. It uses the plugin's read-only MCP tools: `get_specialist` for the specialists' checklists, `run_axe_scan` and the `run_playwright_*` scans on the running page, and the `check_*` tools on changed markup and colors.
- The plugin's severities map to the report's: `critical` and `serious` are blockers, `moderate` is should-fix, `minor` is a nit.
- If `get_specialist` is missing, the critic returns `BLOCKED`; if it errors, the critic tries once more first.
- **A scan that cannot run is not `BLOCKED`.** With no page, or no Playwright, the critic writes `not scanned: <why>` and reviews the code. `pr-finisher` passes that line on, and `route-work` puts a board row for a missing Playwright. The README's new "Page scans" section has the steps (`npm ci` in the active version's `mcp-server` folder, `npx playwright install chromium`, then `/reload-plugins`). `implementer-ui` does the same when it cannot scan, checks by hand when the plugin is missing, and never scans a production URL unless the caller says to.
- `setup-agentic-workflow` checks for the plugin's MCP server, that the `community-access` marketplace points at `Community-Access/accessibility-agents`, and whether the active version can scan. It no longer asks for an Axe login. The README, `route-work`, `pr-finisher` and the review-gate doc say a `BLOCKED` report can mean a missing plugin as well as a missing skill.
- `validate-plugins.py` checks that `accessibility-critic` and `implementer-ui` list exactly the read-only `accessibility-agents` tools and no agent lists another of its tools, that the critic has no `Skill` tool and says what to do when the plugin or a scan is missing, that every agent that edits files can open the edit gate, that agent-roster declares the plugin at the pinned version and the marketplace allows it, that every install command carries the pinned commit and setup checks it, and that no doc outside a changelog mentions the replaced plugin.

## 1.7.2

- **Only the Board Router watches the Asks board for live pings.** The coordinator prompt, `route-work` (rule 2), the guardrails template, `multi-agent.md`, the setup skill and the README say so in one sentence: a coordinator never watches the board (it reads it at every check-in) and never messages the router back. Each points to the `asks-board` skill for how to handle a ping, so the steps live in one place.
- Every question, decision, approval, review request or task for the owner gets a board row. `route-work` and the README now list all five.
- The coordinator prompt and `route-work` no longer tell a coordinator to talk to the Board Router. The coordinator stays free to take new requests and answer the owner.
- `validate-plugins.py` checks that each of those files states the board rule, names the skill section it points to, and does not copy its ping steps.

## 1.7.0

- **The thermonuclear skill ships in agent-roster.** Cursor's `thermo-nuclear-code-quality-review` skill (MIT, from `cursor-team-kit` in `cursor/plugins`, pinned commit `35a90942a7f02e1ebbc2443643179815f2147954`) is vendored at `skills/thermo-nuclear-code-quality-review/`, with Cursor's `LICENSE` and a `SOURCE.md`. The one change from upstream: the `disable-model-invocation: true` line is removed, so the `Skill` tool can load it. You no longer install it by hand.
- **Delete the old manual copy, after upgrading your repos.** Earlier versions had you link the skill into `~/.claude/skills/thermo-nuclear-code-quality-review` from a clone at `~/.claude/cursor-plugins`. First update agent-roster to 1.7.0 and restart Claude Code. Then rerun `setup-agentic-workflow` in each repo set up before 1.7.0 and merge its setup PR, so the repo's `.claude/agents/thermonuclear-reviewer.md` stops reading those paths. Only then remove the link with `rm ~/.claude/skills/thermo-nuclear-code-quality-review` (use `rm -r` if it is a directory, not a symlink). If you use the clone for nothing else, check `git -C ~/.claude/cursor-plugins status` for changes you want, then run `rm -rf ~/.claude/cursor-plugins`.
- `thermonuclear-reviewer` loads `agent-roster:thermo-nuclear-code-quality-review` only with the `Skill` tool. It no longer reads the skill's file by hand. If the tool refuses or cannot find the skill, it returns `BLOCKED` with the tool's exact message.
- The README's "Install the thermonuclear skill" block is gone, and `setup-agentic-workflow` no longer looks for the skill's file in `~/.claude/`. It counts the skill as present when the agent-roster plugin is installed, and offers to install the plugin when it runs as the standalone bundle.
- `pr-finisher`, `route-work` and the review-gate doc say a `BLOCKED` report can also mean the `Skill` tool cannot load a skill. The README's "Skills the agents need" table has a row for the thermonuclear skill, so every `BLOCKED` pointer still goes to one place, which also gains an update line under "Install".
- `validate-plugins.py` checks that the vendored copy is intact: `SKILL.md`, `SOURCE.md` and Cursor's MIT `LICENSE` are present, the `disable-model-invocation: true` line is absent, `SKILL.md` matches the SHA-256 in `SOURCE.md`, and with the line put back it matches the upstream SHA-256.

## 1.6.0

- **Coordinators hand off every task.** Lookups, research, reviews, edits, pushes, PRs and ticket writing all go to an agent or subagent, even a quick one (`lookup` is the cheap option). Agents run in the background, so the coordinator stays free to talk, track work and answer the owner and the Board Router. The full rule is in `route-work` ("Hand off every task"); the coordinator prompt, the guardrails and `multi-agent.md` point to it.
- **The ticketing tool is a setting.** Each repo sets its tool in one file it owns, `docs/agents/issue-tracker.md`: tool, access (`cli` or `mcp`), ticket ID and its form in branch names, link, how a PR closes a ticket, and a command table with a `cli` and an `mcp` column. Moving from a CLI to an MCP server is a change to the **Access** line. GitHub Issues is the default.
- `ticket-writer` searches and files with the configured tool's commands, never `gh issue` when another tool is set, and reports each ticket's ID, title and link. Creating or editing a ticket still needs the owner's yes.
- With a tool other than GitHub Issues set, agents never create GitHub issues or Jira tickets, and an existing GitHub issue that needs attention goes on the Asks board.
- `setup-agentic-workflow` asks for the tool with the names question, learns a CLI's commands from its `--help` (or an MCP server's from its tool list), writes `docs/agents/issue-tracker.md`, and files its own setup ticket with that tool. New placeholder `{{TICKETING_TOOL}}` in the coordinator prompt and the guardrails.
- Branch names are `<username>/<ticket>/<short-description>`, with the ticket ID from the configured tool.
- The review gate hook accepts `[filed <ticket ID>]` for any tool, such as `[filed #123]` or `[filed SPOT-42]`. The ID is one word with a digit, made of letters, digits and `# . _ -` only.
- `pr-finisher` has the owner's standing yes to file open non-blocker findings after round 2; an open security-critic finding is a blocker, never a ticket. `ticket-writer` can now close tickets and makes ticket body files with `mktemp`.
- `issue-tracker.md` has a shell-quoting rule: values go in single quotes or a file, never double quotes. MCP access also needs repo copies of `ticket-writer` and `pr-finisher` that list the server's tools; the setup makes them.
- `validate-plugins.py` checks that the coordinator prompt's placeholder list matches the placeholders it uses, that the setup skill names every placeholder its templates use, and that the templates the setup installs name no `gh issue` and no "GitHub issue".

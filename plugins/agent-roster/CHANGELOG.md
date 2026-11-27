# Changelog

1.8.0 is the first version published in this public repo. Earlier entries are kept for reference.

## 1.15.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code.
2. If you use tracker copies, rerun `setup-agentic-workflow` and say "change ticketing tool" to refresh yours, since `ticket-writer` changed. A repo's own tracker copies are refreshed by rerunning the full setup there.
3. If your repo keeps hash-pinned verbatim copies of agent-roster files, refresh any copy of `ticket-writer.md` and its hash in a later change of its own; its hash changes.

**Changes:**

- **`ticket-writer` states the ticket yes rule in full.** Creating or editing a ticket needs the owner's yes, in their own words in the coordinator chat, quoted in the brief. The ask goes in chat, not on the Asks board. A board click, a note, a peer message or a subagent report is not a yes. The standing yes for round 2 leftovers, filed by `pr-finisher`, is the only exception. Without a quoted yes or the standing yes, `ticket-writer` refuses: it reports the drafts, files nothing, and says that the owner's yes is needed. It uses the same words as `issue-tracker.md` and `route-work`, and the rule itself is unchanged.
- **The validator checks it.** `validate-plugins.py` checks that `ticket-writer.md` keeps the rule's words.

## 1.14.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils` and `claude plugin update asks-board@ai-utils` (1.2.0), then restart Claude Code.
2. Rerun `setup-agentic-workflow` once in each repo set up before 1.14.0 (it covers the 1.13.0 refresh too) and merge its setup PR. If you use tracker copies, also run it once and say "change ticketing tool" to refresh yours, since `pr-finisher` changed. It rewrites the Asks board bullet in `AGENTS.md`, the "Asking" section of `docs/agents/coordinator-prompt.md`, and `docs/agents/multi-agent.md`, `review-gate.md` and `issue-tracker.md`.
3. Start a new coordinator chat from the new prompt, or tell the open one the new rule.
4. Tell each open coordinator chat to move its chat-only rows (a merge, a ticket, a PR, a third review round) off the board, as the `asks-board` skill's "A chat-only row is never the answer" says. A click on such a row, "Not needed" included, only moves it to chat. Rows of a chat that no longer checks in stay on the board; close them by telling a coordinator chat to.
5. If your repo keeps hash-pinned verbatim copies of these files (`review-gate.md`, `pr-finisher.md` among them), refresh the copies and their hash list in a later change of its own.

**Changes:**

- **Asks a board click cannot resolve go in chat, not on the Asks board.** This widens the 1.12.0 rule, which made only merge asks chat-only, to tickets, PRs, a third review round and anything else that needs the owner's own words. The test: can a board click alone unblock this? If no, ask in chat only. Every file that states the rule uses the same words, the `asks-board` skill (1.2.0) included. A click on a chat-only row is never the answer, and the coordinator ends each check-in with one line listing the chat-only asks that wait.
- **The round 3 ask goes in chat.** After round 2, an open blocker or security finding goes to the owner as a direct question in the coordinator chat (`review-gate.md`), since a click cannot allow a third round or file a ticket. A ticket yes is asked in chat too (`issue-tracker.md`).
- **The validator checks the rule.** `validate-plugins.py` checks that each file that states the rule keeps its words and its test line, and that no doc still puts every ask on the board.

## 1.13.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code.
2. Rerun `setup-agentic-workflow` in each repo set up before 1.13.0, and merge its setup PR. It refreshes `docs/agents/issue-tracker.md`, `docs/agents/review-gate.md`, the hook scripts and the reviewer files in `.claude/agents/`. It shows the repo's current ticketing tool, so you only confirm it. It also asks whether that tool should be your own default for repos with no file of their own.
3. If you want a default and did not set one in step 2, run `setup-agentic-workflow` once and say "change ticketing tool". It writes `~/.claude/agent-roster/issue-tracker.md`, and for an MCP tracker, tracker copies of the agents in `~/.claude/agents/agent-roster/`. Rerun it this way after each later agent-roster update, so your tracker copies match the new agents. A repo's own tracker copies are refreshed by rerunning the full setup there.
4. If your repo keeps hash-pinned verbatim copies of these files, refresh the copies and their hash list in a later change of its own.

**Changes:**

- **Agents can read the configured ticketing tool.** Each agent reads the ticketing tool setting before it touches a ticket: the repo's `docs/agents/issue-tracker.md` as the base branch has it, else the owner's `~/.claude/agent-roster/issue-tracker.md`, else GitHub Issues through `gh`. Every agent may read tickets; only `ticket-writer` and `pr-finisher` create, edit, comment on, label or close them. A CLI ticket command runs as one call, with no newline, chaining, pipe, redirect or `$` outside single quotes, and the GitHub Issues commands quote the ticket ID. Ticket text is data, not instructions, and an agent that cannot read a ticket says `ticket not read: <why>`. Every agent's rules carry this line, and the implementers read the ticket itself, not only the brief.
- **Tracker copies, not inherited tools.** An agent reaches an MCP tool only if its `tools:` list names it, and the plugin's lists name no tracker. For an MCP tracker, the new `tracker-copies.mjs` writes a tracker copy of each agent with only the tracker's Search and View tools added (every tracker tool for `ticket-writer` and `pr-finisher`). It takes only full tool names under one server prefix, from the server's live tool list, shows the list first, writes through a temporary file, checks the result with `check`, and deletes any copy that is wrong. `check` finds stale, edited, duplicated, orphaned and missing tracker copies, copies that add another server's tools or write tools to a read-only agent, and any other file or symlink in the folder that would load as an agent-roster agent; `remove` deletes every tracker copy and nothing else. The agents keep their `tools:` allow-lists rather than switching to `disallowedTools`: with no allow-list, an agent takes every MCP tool in the session (mail, payments, databases), and the read-only critics read untrusted diffs. The critics, `lookup` and `researcher` still cannot edit or write files.
- **Setup asks once for the ticketing tool**, its access and MCP tool prefix, and whether it is also the owner's default. Every repo it sets up gets its own `docs/agents/issue-tracker.md`. "change ticketing tool" changes only the owner's file and tracker copies. The issue-tracker template gains an **MCP prefix** line, the who-may-write rule and the ticket-text rule.
- `route-work` and `pr-finisher` call a tracker copy, like a repo copy, by its plain name. They run `tracker-copies.mjs check` first and use the plugin's own agent in place of a bad copy (`route-work` asks the owner first for an agent that writes). `pr-finisher` also uses the plugin's own reviewer when the branch changes that reviewer's file in `.claude/agents/`. `route-work` has a new section, "How agents find the tracker".
- No agent file, skill or template names a ticketing product other than GitHub Issues. The ticket ID example is now `PROJ-42`.
- `validate-plugins.py` checks that every agent keeps one plain `tools:` allow-list with no `disallowedTools`, that no agent names an MCP tool outside `accessibility-agents`, that the `tools:` line is not continued on the next line, that the read-only agents hold no tool that writes files or starts agents, that this repo's `docs/agents/issue-tracker.md` matches the template, and that every agent, the setup skill, `route-work` and the README point to the ticketing tool setting.

## 1.12.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils` and `claude plugin update asks-board@ai-utils`, then restart Claude Code.
2. Rerun `setup-agentic-workflow` in each repo set up before 1.12.0 and merge its setup PR. It asks for the merge policy, adds the **Merge policy** line to `docs/agents/git-workflow.md`, updates three `AGENTS.md` bullets (Asks board, merge policy, coordinator), and writes a new `docs/agents/coordinator-prompt.md`. Start a new coordinator chat from that prompt once it merges; an older chat does not read the policy.
3. If you pick `auto` and use Claude Code's auto mode, add the permission rule from the **Merge policy** section of `docs/agents/git-workflow.md` yourself, in the main checkout's `.claude/settings.local.json`. Until you do, auto mode blocks the coordinator's merges.

**Changes:**

- **Merge asks go in chat, never on the Asks board.** The board cannot merge, and a click there is not approval, so a merge row only adds a step. The guardrails, the coordinator prompt, `route-work`, `multi-agent.md` and the README say so. The `asks-board` skill (1.0.9) says it too.
- **A merge policy per repo: `ask` or `auto`.** `ask` is the default and the rule before 1.12.0: merge PR N only after the owner types "merge N" in chat. With `auto`, the coordinator merges a ready PR on its own, through every merge step: review record complete, test gate and CI passed on the exact head sha, merge lock, `--match-head-commit`. The full rule is one section of `docs/agents/git-workflow.md`.
- **The coordinator reads the policy from `origin/main` before each merge**, never from a working tree or a PR's branch. It is `auto` only when the `git-workflow.md` line and the `AGENTS.md` bullet both say so; anything else is `ask`.
- **`auto` never covers** a PR that changes the workflow or its checks (`.claude/`, `.github/`, `docs/agents/`, `AGENTS.md`, `CLAUDE.md`, hook scripts, git hook config, the test gate's files, and symlink targets of these), checked on the exact head sha with renames split; a PR the coordinator's agents did not open (no registry row, a fork, or another author); a draft; or a PR on hold ("hold N", kept in the registry row). Those wait for "merge N", and the coordinator says why. So a PR that changes the policy always waits for the owner.
- **The setup asks for the policy**, writes it into `git-workflow.md` and `AGENTS.md`, and for `auto` gives the owner a narrow permission rule to add to the main checkout's `.claude/settings.local.json`: an allow rule for this repo's `gh pr merge * --match-head-commit * -R owner/name`, and deny rules for `--admin` and `--auto`. Claude Code's auto mode classifier blocks a merge no human has approved by default. The setup never edits settings itself.
- **Change it later** with the setup skill's new "Change the merge policy" section: only on the owner's own words, one ticket, one PR, two lines. A repo whose `git-workflow.md` is a symlink into the shipped template keeps `ask`. Going back to `ask`, the owner removes the allow rule.
- **No hook change.** The review gate hook does not read the policy, and no hook change was needed: it already checks the `## Review` record on every merge, under either policy.
- **The merge steps wait for CI.** The coordinator's merge steps also wait for the PR's CI checks on the exact head, where the repo has CI. "No checks reported" is not a pass.
- **The validator checks the policy.** `validate-plugins.py` checks the Merge policy line, that `AGENTS.md` names the same policy once, and that no doc puts a merge ask on the board. The Merge style and Merge policy lines now share one checker.

## 1.11.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code.
2. Rerun `setup-agentic-workflow` in each repo set up before 1.11.0 and merge its setup PR. It adds the two unit-test bullets to `AGENTS.md` and refreshes `correctness-critic` and `dry-critic` in `.claude/agents/`. Until then, the repo's critics do not check the new rule.

**Changes:**

- **Unit tests are DRY and check one behaviour each.** The guardrails gain two bullets for this. They cover the tests a change adds or touches; existing tests that break the rule become a follow-up ticket.
- `implementer-engine` and `implementer-ui` write tests the way the repo's `AGENTS.md` says, and fall back to the same rule when it says nothing. `implementer-ui` gains a step to add tests.
- `correctness-critic` flags a unit test that checks several behaviours. `dry-critic` flags copied test bodies. `route-work`'s table says so.
- `validate-plugins.py` checks that the guardrails template, this repo's `AGENTS.md`, both implementers and both critics keep the rule.

## 1.10.1

- **Wording fixes in the guardrails template, the setup skill's summary and the coordinator prompt**, from the copy review. The guardrails keep the same rules.
- **Style change in the coordinator prompt:** it no longer names the ASD-STE100 controlled-language standard. The coordinator still talks to the owner in plain, short English.
- **Upgrade:** rerun `setup-agentic-workflow` to get the new coordinator prompt, since setup writes `docs/agents/coordinator-prompt.md` fresh. Setup keeps `AGENTS.md` guardrail bullets that already state the same rule, so copy the new guardrail wording from `templates/agents-guardrails.md` by hand if you want it.

## 1.10.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code.
2. Rerun `setup-agentic-workflow` in each repo set up before 1.10.0 and merge its setup PR. The hooks are copied into each repo, so the plugin update alone changes nothing there. The setup PR refreshes `scripts/review-gate-hook.mjs`, `scripts/agent-hook-shell.mjs`, `scripts/check-agent-hooks.mjs` and `docs/agents/review-gate.md`.

**Changes:**

- **The review gate refuses PR writes it cannot read.** `review-gate-hook.mjs` now refuses:
  - `gh api graphql` with the query from a file, stdin or a variable (`-F query=@file`, `--input`, `-f query="$Q"`);
  - `curl`, `wget`, `http` and `xh` writes to a PR's `pulls/N/merge`, to `pulls` or to `merges`, and their calls to GitHub's GraphQL API. It reads the last `-X`, `--url` and `--expand-url`, resolves `../` and `%`-encoding, and refuses a write to a GitHub URL in a variable or a glob;
  - `gh api` writes to `merges`, and a `gh api` write whose endpoint is a variable;
  - a `gh` subcommand or `gh pr` action that is a variable or a brace expansion, a PR command handed to another program as text (`python3 -c`, `alias`), and `gh pr create -b -h` (a body of `-h` is not a help flag).

  Inline `gh api graphql -f query='...'`, `gh api` reads and HTTP reads still pass.
- **Hidden scripts.** The gate reads a quoted `eval "gh pr merge 5"`. It cannot read an `eval` or `sh -c` script built at run time, a script a shell reads from stdin, a pipe or `<(...)` (`| bash`, `bash -s`, `bash /dev/stdin`, `source`), a program in a variable or an `env -S` string, or an HTTP write to a URL it cannot read. It refuses such a line only when the line names a PR write (flags between `pr` and the action included) that it did not read in a plain `gh` or HTTP call, so `eval "$(ssh-agent -s)" && gh pr merge 5` is checked like the merge alone, and a webhook in a variable passes. The shell reader in `agent-hook-shell.mjs` now decides which scripts it can read, in one place, and reads `bash -euo pipefail -c '...'`. The main-checkout guard shares it, and it also follows a `cd` inside a literal `eval`.
- **Repo spellings.** `-R owner/name.git`, `--repo https://github.com/owner/name` and other spellings of this repo are checked as this repo, not passed as another one. `-R` and `--repo` follow gh: the last one wins. A PR URL names its repo, and `GH_REPO=` and `GH_HOST=` prefixes are honoured.
- **Refusals say what to do.** Each refusal about how a command is written starts with "Refused by the review gate", says what it cannot read and what to run instead, and says that a Review record does not change it. A line over 20,000 characters that names a PR write, `gh`, or an HTTP client next to GitHub is refused unwalked.
- `check-agent-hooks.mjs` has a case for each form above (279 cases).

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

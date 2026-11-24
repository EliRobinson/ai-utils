# agent-roster

One shared map from job kind to agent kind, for coordinator chats.

Each agent kind is a native Claude Code subagent. Its file sets the prompt, the tools and the model, so every repo and every coordinator gets the same agent for the same job.

## What is here

```
agents/                          one subagent file per agent kind
coordinator/coordinator-prompt.md  template for the first message of a coordinator chat
skills/route-work/               coordinator guide: routing table and rules
skills/setup-agentic-workflow/   installs the workflow rules, reviewers and hooks into a repo
  scripts/                         guard and review-gate hooks, shared shell reader, self-check, settings merge
  templates/                       AGENTS.md guardrails, docs/agents/ topics (with the ticketing tool setting), registry, ruleset
  bundle-extras.txt                pulls the reviewer agents and coordinator prompt into the standalone bundle
skills/thermo-nuclear-code-quality-review/
                                 Cursor's review skill, vendored at a pinned commit (SOURCE.md, LICENSE)
```

| Agent | Job | Model | Tools |
| --- | --- | --- | --- |
| `ticket-writer` | turns asks into tickets in the repo's ticketing tool, or board items | sonnet | Read, Grep, Glob, Bash, Skill |
| `researcher` | web and docs research, report only | sonnet | Read, Grep, Glob, WebSearch, WebFetch |
| `lookup` | single-fact repo or doc lookups, report only | haiku | Read, Grep, Glob, Bash |
| `implementer-engine` | engine, logic, store, API, DB schema | opus | Read, Edit, Write, Grep, Glob, Bash, Skill |
| `implementer-ui` | components, styling, i18n wiring | sonnet | Read, Edit, Write, Grep, Glob, Bash, Skill, the read-only `accessibility-agents` MCP tools |
| `mechanical-editor` | renames, codemods, generated files, dependency bumps | sonnet | Read, Edit, Write, Grep, Glob, Bash, Skill |
| `copy-writer` | user-facing and legal strings, plain-words voice | sonnet | Read, Edit, Write, Grep, Glob, Bash, Skill |
| `thermonuclear-reviewer` | `agent-roster:thermo-nuclear-code-quality-review` skill (Cursor's cursor-team-kit, vendored here), maintainability | opus | Read, Grep, Glob, Bash, Skill |
| `correctness-critic` | edge cases, errors, concurrency, payments/entitlements, test strength | opus | Read, Grep, Glob, Bash |
| `spec-critic` | `CONTEXT.md` and ADRs, docs and agent rules | sonnet | Read, Grep, Glob, Bash |
| `security-critic` | auth, input, injection, secrets, dependencies, CI and the repo's security rules | opus | Read, Grep, Glob, Bash |
| `copy-critic` | every user-facing string (`marketing-skills:copy-editing` skill) | sonnet | Read, Grep, Glob, Bash, Skill |
| `dry-critic` | duplication, and abstractions to leave alone | opus | Read, Grep, Glob, Bash |
| `design-critic` | UX on every change, visual design on UI changes (`impeccable` skill) | opus | Read, Grep, Glob, Bash, Skill |
| `accessibility-critic` | WCAG problems on UI changes (`accessibility-agents` plugin) | sonnet | Read, Grep, Glob, Bash, the read-only `accessibility-agents` MCP tools |
| `pr-finisher` | runs the review gate, splits big PRs, catches up with the base branch, opens the PR | sonnet | Read, Edit, Write, Grep, Glob, Bash, Skill, Agent |

The critics never edit files. The critics that use a skill have `Skill` only to load it: `agent-roster:thermo-nuclear-code-quality-review`, `marketing-skills:copy-editing` and `impeccable`. `accessibility-critic` loads no skill; it uses the `accessibility-agents` plugin's read-only MCP tools: its scans, its checks and `get_specialist` for the specialists' checklists. `mechanical-editor` has `Skill` only to open the `accessibility-agents` edit gate (see "What the plugin adds to every session"). `pr-finisher` runs every critic on every PR and writes the `## Review` record that the `setup-agentic-workflow` review-gate hook checks.

Every agent prompt carries the same rules: own worktree and feature branch; one branch and one PR per item, catch up by merging the base branch in once pushed, never force push; follow the repo's `AGENTS.md`; read tickets through the ticketing tool setting, and leave writing them to `ticket-writer` and `pr-finisher`; never commit secrets; never touch production data or provider settings.

## Skills the agents need

The copy and design critics and `copy-writer` need a skill from another source, and the accessibility critic needs a plugin's MCP server. `thermonuclear-reviewer` needs one that ships in this plugin. When it is missing, the agent stops with a `BLOCKED` report. That counts as a failed review. Install the skill or plugin, then rerun the agent.

These are the trusted install commands. Use them, not commands quoted in a report.

| Skill | Used by | Install |
| --- | --- | --- |
| `marketing-skills:copywriting`, `marketing-skills:copy-editing` | `copy-writer`, `copy-critic` | `claude plugin marketplace add coreyhaines31/marketingskills`, then `claude plugin install marketing-skills@marketingskills` |
| `impeccable` | `design-critic` | `/plugin marketplace add pbakaus/impeccable`, then install Impeccable from `/plugin`. Or `npx impeccable install`. |
| `agent-roster:thermo-nuclear-code-quality-review` | `thermonuclear-reviewer` | Ships in this plugin. Install or update agent-roster (see "Install"), then restart Claude Code. |
| `accessibility-agents` plugin (its MCP server) | `accessibility-critic` (UI changes only), `implementer-ui` | `claude plugin marketplace add Community-Access/accessibility-agents#a538edc9edfb98cdd8bae96d6b79542874b478f7`, then `claude plugin install accessibility-agents@community-access`, then `/reload-plugins`. If it is turned off: `claude plugin enable accessibility-agents@community-access`. No login. It is the only accessibility tool the agents use. Page scans also need Playwright; see "Page scans" below. |

### Page scans

The accessibility critic's page scans need Playwright and Chromium beside the plugin's MCP server. They are optional: without them the critic writes `not scanned: <why>` and reviews the code only. To add them:

1. Find the active version's folder: `claude plugin list --json` shows `installPath` for `accessibility-agents@community-access`.
2. In `<installPath>/mcp-server`, run `npm ci` (it installs the exact versions in the plugin's lockfile), then `npx playwright install chromium`.
3. Run `/reload-plugins` (or restart Claude Code). The server remembers a missing Playwright until it restarts.

A plugin update brings a new folder, so do this again after each update.

### The pinned version

`accessibility-agents` runs hooks in every session (below), so agent-roster uses one reviewed version of it: 7.1.0, at commit `a538edc9edfb98cdd8bae96d6b79542874b478f7`.

The marketplace commit is what pins it. The install command adds the `community-access` marketplace at that commit (`#a538edc9edfb98cdd8bae96d6b79542874b478f7`), and Claude Code records it as `source.ref` in `~/.claude/plugins/known_marketplaces.json`. The plugin lives at the root of that marketplace's repo, so the marketplace commit is the plugin's code, and a marketplace added at a commit does not move on update.

agent-roster's `plugin.json` also asks for `accessibility-agents` at `=7.1.0`. That only picks the version when agent-roster installs the plugin for you. It does not hold updates, and upstream keeps the version string 7.1.0 across commits, so it does not pin the code.

To check a machine, compare two values with the commit above: `source.ref` for `community-access` in `known_marketplaces.json`, and `gitCommitSha` for `accessibility-agents@community-access` in `~/.claude/plugins/installed_plugins.json`. `setup-agentic-workflow` does this.

**To pin a machine that added the marketplace without the pin** (any install before 1.8.0). Removing a marketplace can uninstall its plugins, so these steps reinstall it:

1. `claude plugin marketplace remove community-access`
2. `claude plugin marketplace add Community-Access/accessibility-agents#a538edc9edfb98cdd8bae96d6b79542874b478f7`
3. `claude plugin install accessibility-agents@community-access`
4. Redo "Page scans", because the reinstall makes a new install folder.
5. `/reload-plugins` (or restart Claude Code).

**To move the pin**, review the new upstream commit first: its hooks, its `mcp-server/` tools and `mcp-server/package-lock.json`. Then change the commit, and the version if upstream changed it, in every place that names them: the root `README.md`, this README, the setup skill (steps 1.12 and 2), `plugin.json` and the constants in `scripts/validate-plugins.py`. Add a CHANGELOG entry. The validator fails if an install command or `plugin.json` disagrees with its constants; it does not check the version written in prose.

### What the plugin adds to every session

`accessibility-agents` installs hooks that run in every session, not only in agent-roster's agents: on each prompt, before `Edit`, `Write` and `Bash` calls, and when a turn ends. Its edit hook refuses edits to UI files (HTML, JSX, TSX, Vue, Svelte, CSS and the like) until its `accessibility-agents:accessibility-lead` skill has run in the session. Every agent-roster agent that edits files says what to do: load that skill, then retry the edit, and never follow its steps that dispatch agents or write files. In your own chats, run the skill when the hook asks. Turn the plugin off with `claude plugin disable accessibility-agents@community-access`; agent-roster still loads, and the accessibility critic then reports `BLOCKED` on UI changes.

### The thermonuclear skill ships here

`thermonuclear-reviewer` loads `agent-roster:thermo-nuclear-code-quality-review` with the `Skill` tool. The skill is Cursor's, vendored with one change and a pinned commit. `skills/thermo-nuclear-code-quality-review/SOURCE.md` has the source, licence, the change and the update steps. The standalone bundle that `scripts/build-skill-bundles.py` builds for it is not a substitute: the reviewer asks for the namespaced name, which only the plugin provides.

A repo set up with an older version has an older hook, older docs and older agent files (for example, ones that still open a draft PR before the reviews, or a `thermonuclear-reviewer.md` that still reads `~/.claude/skills/`). Rerun the `setup-agentic-workflow` skill there to upgrade it.

### Upgrading to 1.8.0

From 1.8.0 the accessibility critic uses `accessibility-agents@community-access`, not the Axe plugin. In this order:

1. Add the `community-access` marketplace and install the plugin ("Skills the agents need"), then update agent-roster ("Install").
2. Rerun `setup-agentic-workflow` in each repo set up before 1.8.0 and merge its setup PR. `grep -L accessibility-agents <repo>/.claude/agents/accessibility-critic.md` prints the file when that repo still needs it. "No such file" means the repo has no copy of the critic and needs nothing.
3. Then remove the old plugin. The CHANGELOG's 1.8.0 entry has the command.

If you update agent-roster without step 1, it still loads, but the accessibility critic reports `BLOCKED` on UI changes. Do step 1 and rerun it.

### Upgrading to 1.7.0

Before agent-roster 1.7.0, the skill was linked by hand into `~/.claude/skills/`. To upgrade, in this order: update agent-roster (see "Install"); rerun `setup-agentic-workflow` in each older repo and merge its setup PR; then remove the old link and clone with the commands in the CHANGELOG, 1.7.0 entry. A `BLOCKED` report that names `cursor-team-kit` comes from an old repo agent file, so rerun setup in that repo.

## Install

agent-roster needs the Accessibility Agents plugin by Community Access, `accessibility-agents@community-access`, installed and enabled. Install it first, with the commands in "Skills the agents need". agent-roster's `plugin.json` lists it under `optionalDependencies`, and the ai-utils marketplace allows dependencies from the `community-access` marketplace, but the supported path is to install it yourself first. It is optional only so that agent-roster still loads without it; then the accessibility critic reports `BLOCKED` on UI changes. Read "What the plugin adds to every session" before you install it. The name `community-access` must point at the GitHub repo `Community-Access/accessibility-agents` at the pinned commit; see "The pinned version".

Then install agent-roster:

```
/plugin marketplace add EliRobinson/ai-utils
```

```
/plugin install agent-roster@ai-utils
```

To update, run `claude plugin marketplace update ai-utils`, then `claude plugin update agent-roster@ai-utils`, then restart Claude Code to apply it.

## Call an agent

From a coordinator chat, use the Agent tool with `subagent_type: "agent-roster:<name>"`, for example `agent-roster:implementer-engine`.

- Hand off every task, even a quick one, and run agents in the background, so the coordinator stays free to talk. The full rule is in `route-work`.
- Omit `model` on the call. The agent file decides.
- Pass `isolation: "worktree"` for agents that edit files.
- One item = one agent = one worktree = one branch = one PR.
- Name each branch `<username>/<ticket>/<short-description>`, with the ticket ID from the repo's ticketing tool, and give the name in the brief.
- A PR gets at most two rounds of review (see `pr-finisher`, or the repo's `docs/agents/review-gate.md`).
- Every question to the owner goes on the Asks board (use the `asks-board` skill): every question, decision, approval, review request and task, including "merge N" requests and hosting choices. Never end a chat reply with an ask that is not also a board row. Subagents never write to the board; they report the ask to their coordinator, who adds it.
- Only the Board Router watches the board for live pings; a coordinator never does (it reads the board at every check-in), and never messages the router back. Handle a ping as the `asks-board` skill's "If you are a project coordinator" section says.
- Never use Fable.

The `route-work` skill holds the full routing table and these rules for the coordinator to load.

## Set up a repo

Run the `setup-agentic-workflow` skill in a repo or a new coordinator chat ("set up agent workflow in this repo"). It looks first, and never overwrites a file without showing the diff. It asks for the owner's name, the branch username, the ticketing tool and where to work, then one question for all missing installs, then about GitHub settings and git hooks. Setting up a new Asks board adds a few more questions.

First it gets the companions ready:

- the `agent-roster` and `asks-board` plugins;
- the Asks board (through the `asks-board-setup` skill if there is none) and a route for this repo's coordinator;
- the reviewer skills and the `accessibility-agents` plugin from "Skills the agents need".

If it installs anything, it asks you to run `/reload-plugins` and then run it again, since new plugins load only after a reload.

Then it installs:

- a guardrails block in `AGENTS.md`, with `CLAUDE.md` as a symlink to it;
- `docs/agents/git-workflow.md`, `review-gate.md` and `multi-agent.md`;
- the ticketing tool setting (see below): `~/.claude/agent-roster/issue-tracker.md`, `docs/agents/issue-tracker.md` if the repo gets its own, and tracker copies for an MCP tracker;
- `docs/agents/coordinator-prompt.md`, the coordinator prompt filled in for that repo;
- the reviewer agents into `.claude/agents/`, copied from `agents/` here;
- `scripts/agent-hook-shell.mjs`, the shell reader both hooks share;
- `scripts/guard-main-checkout-hook.mjs`, which refuses tree-changing git in the main checkout (escape: `ALLOW_MAIN_CHECKOUT_WRITE=1` on one command);
- `scripts/review-gate-hook.mjs`, which refuses `gh pr create` (draft or not), `gh pr ready` and a merge unless the PR body has a complete `## Review` record. It also refuses the forms that would skip that check: GraphQL queries from a file, PR writes through `curl` and other HTTP clients, and PR commands hidden in scripts it cannot read. The reviewers run before the PR is opened;
- `scripts/check-agent-hooks.mjs`, a self-check it runs after install;
- the hook wiring, merged into `.claude/settings.json`;
- the ownership registry, outside the repo.

It asks before changing GitHub settings. That covers a `main` ruleset and the merge style you pick (merge commit, squash or rebase). It recommends git hooks if the repo has none.

The guardrails include the unit-test rule: no copied test bodies (use a parametrized table instead), and each test checks one behaviour. The implementers write tests this way. `correctness-critic` flags a test that checks several behaviours, and `dry-critic` flags copied test bodies.

The reviewer agents and the coordinator prompt have one copy each, in `agents/` and `coordinator/`. Installed as a plugin, the skill reads them from there. For the standalone `.skill` bundle, `scripts/build-skill-bundles.py` copies them in, as listed in the skill's `bundle-extras.txt`. `scripts/validate-plugins.py` runs the hooks' self-check.

## The ticketing tool

The plugin never names a ticketing tool. Agents find it in a setting file, and use the first one they find:

1. the repo's `docs/agents/issue-tracker.md`, for a repo with its own setting;
2. the owner's `~/.claude/agent-roster/issue-tracker.md`, for every other repo;
3. neither: GitHub Issues, through `gh`.

`setup-agentic-workflow` asks once which tool you use: GitHub Issues (the default), or another one, reached through its CLI or its MCP server (give its tool prefix, `mcp__<server>__`). It writes your answer to `~/.claude/agent-roster/issue-tracker.md`, and asks whether the repo needs its own file. To change it later, rerun the skill and say "change ticketing tool", or edit the file.

The file has a `## Setting` list (tool, access, MCP prefix, ticket ID, its form in branch names, link, how a PR closes a ticket), a `## Commands` table with a `cli` and an `mcp` column, and the ticket rules. The **Access** line picks the column. Every agent may read tickets with the Search and View commands. Only `ticket-writer` and `pr-finisher` create, edit, comment on, label or close them.

The setup learns a CLI's commands from its own `--help`, and an MCP server's from its tool list. It never guesses. With a tool other than GitHub Issues set, agents never create GitHub issues or Jira tickets, and an existing GitHub issue that needs attention goes on the Asks board.

### How agents reach an MCP tracker

A CLI needs nothing more: the agents with `Bash` run its commands (`researcher` has no `Bash`, so it reads tickets only through MCP). An MCP tracker needs tracker copies. An agent holds only the tools its `tools:` list names, and these lists name no tracker. So for **Access** `mcp`, the setup writes a copy of each agent to `~/.claude/agents/agent-roster/` (or the repo's `.claude/agents/` for a repo whose own file sets `mcp`) with the tracker's Search and View tools added, and every tracker tool for `ticket-writer` and `pr-finisher`. Each copy names the agent-roster version it came from. A coordinator calls a copy by its plain name, such as `implementer-engine`. A repo's own `.claude/agents/` files win over your copies.

After each agent-roster update, rerun the setup and say "change ticketing tool" to refresh the copies. Until then they run the older prompts, and `route-work` asks you to rerun it.

Why copies, and not agents that take every tool you have: an agent with no `tools:` list, or with only a `disallowedTools` list, also takes every other MCP tool in your session, such as mail, payments or a database. The read-only critics read untrusted diffs, so a prompt injection there could use them. A copy adds only the tracker's tools, so each agent keeps its current limits: the critics, `lookup` and `researcher` still have no `Edit` or `Write`.

A worked example, for a repo whose tickets live in an in-house tracker reached through its CLI, called `tix` here. The commands are placeholders; the setup fills them from `tix --help`:

```markdown
## Setting

- **Tool:** Tix
- **Access:** cli
- **Ticket ID:** `<from tix --help>`
- **In branch names:** `<from tix --help, lowercased>`, as in `<username>/<ticket>/<short-description>`
- **Link:** `<from tix --help>`
- **Close from a PR:** none
- **MCP prefix:** none

## Commands

| Action | `cli` | `mcp` |
| --- | --- | --- |
| Search | `<from tix --help>` | `<not set>` |
| View | `<from tix --help>` | `<not set>` |
| Create | `<from tix --help>` | `<not set>` |
| Edit | `<from tix --help>` | `<not set>` |
| Comment | `<from tix --help>` | `<not set>` |
| Label | `<from tix --help>` | `<not set>` |
| Close | `<from tix --help>` | `<not set>` |
```

When the tracker gets an MCP server, fill the `mcp` column from its tool list, set **MCP prefix**, change the **Access** line from `cli` to `mcp`, and rerun the setup so it writes the tracker copies.

## Start a coordinator chat

A coordinator is the main chat the owner talks to, not a subagent, so it starts from a prompt rather than an agent file. Paste `coordinator/coordinator-prompt.md` as the first message of a new chat, with its placeholders filled (`setup-agentic-workflow` fills them for a repo). It holds the start-up steps, the working rule (hand off every task, tickets in the configured tool), asking the owner (every ask on the Asks board, and a pointer to the `asks-board` skill for Board Router pings), the ownership registry, and the merge steps. The routing table stays in `route-work`, which the prompt links to.

## Override per repo

A file with the same name in a repo's `.claude/agents/` (for example `.claude/agents/correctness-critic.md`) overrides the plugin's agent for that repo, and a tracker copy in `~/.claude/agents/agent-roster/` overrides it everywhere else. Call either by its plain name. Copy the shared file there and edit it when a repo needs a different prompt, tool set or model.

## Change it

Edit the files here, run `python3 scripts/validate-plugins.py`, bump the version in `.claude-plugin/plugin.json` and in the marketplace entry, add a `CHANGELOG.md` entry, commit on a feature branch and open a PR (the review gate is in `AGENTS.md`; outside contributors see Contributing in the root README).

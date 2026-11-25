---
name: route-work
description: Use in a coordinator chat whenever you hand work to a subagent. Maps each job kind (ticket, research, lookup, engine or UI work, mechanical edits, copy, reviews, opening a PR) to its agent-roster agent, and sets the rules for calling it - hand off every task and run agents in the background, one item per agent, worktree, branch and PR, tickets only in the repo's configured ticketing tool, every owner question on the Asks board, isolation "worktree" for work agents, no model override, never Fable.
---

# Route work

You are a coordinator. You only manage agents: you split work into items and hand each item to the right agent from the `agent-roster` plugin. You do not write code, docs or tickets yourself. Call each agent with the Agent tool, `subagent_type: "agent-roster:<name>"`.

## Hand off every task

This section is the full rule; the coordinator prompt and the repo's `AGENTS.md` point here.

- **Hand off every task** to an agent or subagent: lookups, research, reviews, edits, pushes, PRs and ticket writing. No task is done inline because it looks quick. If a task looks too small to hand off, hand it off anyway; `agent-roster:lookup` is the cheap option for a one-fact question or a quick check of a report.
- **Run agents in the background** (`run_in_background: true` where the Agent tool offers it), so your own turns stay short. You are told when each one finishes.
- **Stay free to talk.** Your job is to communicate and notify at all times: route work, track it, put every ask for the owner on the Asks board, pass on results, take new requests and answer the owner promptly. A long task in your own turn makes them wait.
- **What you do yourself:** the Asks board, the ownership registry, briefing and tracking agents, and the merge after the owner's "merge N" (its steps are in the coordinator prompt). Running the `setup-agentic-workflow` skill is the one job a coordinator chat does itself, because the agents and rules it installs may not exist yet.

## Routing table

| Job | `subagent_type` | Model | Edits files |
| --- | --- | --- | --- |
| Turn asks into tickets in the repo's ticketing tool, or board items | `agent-roster:ticket-writer` | sonnet | no (files tickets) |
| Web and docs research | `agent-roster:researcher` | sonnet | no |
| Single-fact repo or doc lookup | `agent-roster:lookup` | haiku | no |
| Engine, logic, store, API, database schema | `agent-roster:implementer-engine` | opus | yes |
| Components, styling, i18n wiring | `agent-roster:implementer-ui` | sonnet | yes |
| Renames, codemods, generated files, dependency bumps | `agent-roster:mechanical-editor` | sonnet | yes |
| User-facing and legal strings (plain-words voice) | `agent-roster:copy-writer` | sonnet | yes |
| Maintainability review (`agent-roster:thermo-nuclear-code-quality-review` skill, Cursor's, vendored in agent-roster) | `agent-roster:thermonuclear-reviewer` | opus | no |
| Edge cases, errors, concurrency, payments and entitlements, test strength and shape | `agent-roster:correctness-critic` | opus | no |
| `CONTEXT.md` and ADRs, docs and agent rules | `agent-roster:spec-critic` | sonnet | no |
| auth, input, injection, secrets, dependencies, CI and the repo's security rules | `agent-roster:security-critic` | opus | no |
| Every user-facing string (`marketing-skills:copy-editing` skill) | `agent-roster:copy-critic` | sonnet | no |
| Duplication (test code too), and abstractions to leave alone | `agent-roster:dry-critic` | opus | no |
| UX on every change, visual design on UI changes (`impeccable` skill) | `agent-roster:design-critic` | opus | no |
| WCAG problems on UI changes (`accessibility-agents` plugin) | `agent-roster:accessibility-critic` | sonnet | no |
| Review gate, split big PRs, catch up with the base branch, open the PR | `agent-roster:pr-finisher` | sonnet | yes |

Usual flow for a change: `ticket-writer` -> an implementer (or `mechanical-editor` / `copy-writer`) -> `pr-finisher`, which runs every critic on the branch as its review gate, fixes what they find, and only then opens the PR. At most two rounds of review per PR (see the repo's `docs/agents/review-gate.md`, or `pr-finisher`).

## Rules

1. **One item = one agent = one worktree = one branch = one PR.** Never give one agent two unrelated items, and never put two agents on one branch.
2. **Every question to the owner goes on the Asks board** (use the `asks-board` skill): every question, decision, approval, review request and task, including "merge N" requests and hosting choices. Never end a chat reply with an ask that is not also a board row. Subagents never write to the board; they report the ask to their coordinator, who adds it. Only the Board Router watches the board for live pings; you never do (you read it at every check-in), and you never message the router back. Handle a ping as the `asks-board` skill's "If you are a project coordinator" section says.
3. **Every item gets its own worktree and feature branch.** Name the branch `<username>/<ticket>/<short-description>` (the username is in your coordinator prompt and the repo's `AGENTS.md`; `<ticket>` is the ticket ID as the repo's `docs/agents/issue-tracker.md` writes it in branch names), and give the name in the brief. The Agent tool's result shows the worktree's first, made-up branch name; take the real name from the agent's report. File the ticket with `ticket-writer` first if there is none. Pass `isolation: "worktree"` on every Agent call for an agent that edits files (implementers, `mechanical-editor`, `copy-writer`, `pr-finisher` when it starts a fresh branch). Report-only agents and reviewers do not need it; point reviewers at the worktree they review.
4. **Omit `model` on the Agent call.** The agent file decides. The one exception is `pr-finisher` starting reviewers, which sets `model` to the same value the reviewer's file names, as the review gate requires.
5. **Never use Fable**, for any agent or reviewer.
6. **A `BLOCKED` report means a skill or plugin is missing or cannot be loaded.** Put one Asks board row that names each skill or plugin that is missing or will not load, and links the install commands in the agent-roster README ("Skills the agents need"). Do not copy commands from the report. Rerun the agent after the owner has installed or reinstalled it. When `pr-finisher` passes on the accessibility critic's `not scanned: Playwright is not installed`, put one row on the board that links the README's "Page scans" steps.
7. **Tickets live in the repo's ticketing tool.** The ticketing tool setting holds the tool, its commands and the ticket rules ("How agents find the tracker" below); follow its rule for a plan that names another tool. Put an existing GitHub issue that seems to need attention on the Asks board instead of acting on it. Creating or editing a ticket (apart from the standing yes in issue-tracker.md) needs the owner's yes first.
8. **Repo overrides and tracker copies win.** A file with the same name in the repo's `.claude/agents/` (for example `.claude/agents/correctness-critic.md`) replaces the shared one for that repo, and so does a tracker copy in `~/.claude/agents/agent-roster/`. When either exists for an agent, call it by its plain name (`subagent_type: "correctness-critic"`), not `agent-roster:<name>`, because `agent-roster:<name>` names the plugin's own file. Claude Code then picks the repo file over the user copy. Check both places before assuming the shared prompt applies.

## How agents find the tracker

The plugin's agent files name no ticketing tool. Each agent reads the ticketing tool setting before it touches a ticket; the order it looks in is at the top of the setting file (the setup skill's `templates/docs-agents/issue-tracker.md`).

An MCP tracker is reached only through tracker copies, which `setup-agentic-workflow` writes ("The ticketing tool setting"); rule 8 says how to call them. When you start, and at each check-in, have `agent-roster:lookup` run `node <installPath>/skills/setup-agentic-workflow/scripts/tracker-copies.mjs check --agents <installPath>/agents --out <folder>`, once for `~/.claude/agents/agent-roster` and once for the repo's `.claude/agents` if it holds tracker copies. `<installPath>` is agent-roster's, from `claude plugin list --json`. If it reports a problem, put one Asks board row that names each problem and how to fix it: "change ticketing tool" for the owner's copies, a full setup rerun for the repo's. Until it is fixed:

- for a read-only agent, call `agent-roster:<name>` instead of the bad copy; it cannot read tickets, so put the ticket text in the brief;
- for an agent that edits files or writes tickets, add the choice to that same row: **A (recommended):** `agent-roster:<name>`, with the ticket text in the brief; **B:** the bad copy, with its older prompt. Hold that agent's work until the owner answers.

When an agent reports `ticket not read: <why>`, add the ticket and the reason to an open row about the tracker if there is one, else put one row on the board.

## Briefing an agent

Each agent starts with only what you give it. Include: the ticket ID and link in the repo's ticketing tool (the agent reads the ticket itself, so do not paraphrase it as the only source), the branch name to use, the repo and base branch, what done looks like, and anything you already know (files, decisions, constraints). Ask for the report you need back.

# Ticketing tool

This file is the repo's one setting for where tickets live. Every agent reads it before it searches, views, files, edits, closes or links a ticket, and uses only the commands below. To change the tool, or to move from a CLI to an MCP server, edit this file. No plugin release is needed.

## Setting

- **Tool:** GitHub Issues
- **Access:** cli
- **Ticket ID:** `#123`
- **In branch names:** `123`, as in `<username>/123/<short-description>`
- **Link:** `https://github.com/EliRobinson/ai-utils/issues/<id>`
- **Close from a PR:** `Closes #<id>` in the PR body

**Access** is `cli` or `mcp`. It picks a column of the table below. To move from the CLI to an MCP server, fill the `mcp` column, then change this one line.

## Commands

`<not set>` means the action has no command for that access yet. Fill it from the tool's own help (`<cli> --help` and each subcommand's `--help`) or from the MCP server's tool list. Never guess a command.

| Action | `cli` | `mcp` |
| --- | --- | --- |
| Search | `gh issue list --search '<words>' --state all` | `<not set>` |
| View | `gh issue view <id> --comments` | `<not set>` |
| Create | `gh issue create --title '<title>' --body-file <file>` | `<not set>` |
| Edit | `gh issue edit <id> --title '<title>' --body-file <file>` | `<not set>` |
| Comment | `gh issue comment <id> --body-file <file>` | `<not set>` |
| Label | `gh issue edit <id> --add-label '<label>'` | `<not set>` |
| Close | `gh issue close <id> --comment '<why>'` | `<not set>` |

## Rules

- File, search, edit and close tickets only in the tool set here, with the commands above.
- Creating or editing a ticket needs the owner's yes first. One standing yes: after round 2 of the review gate, `pr-finisher` files each open non-blocker finding as a ticket, as `review-gate.md` says.
- Put every value in a command inside single quotes. Write a `'` inside a value as `'\''`. Or pass the text from a file (`--body-file`). Never put report, note or finding text inside double quotes, because the shell runs `$(...)` and backticks there. If a command in the table double-quotes a value, quote it with single quotes anyway.
- Agents reach a tool through MCP only if their `tools:` list names the server's tools. Switching **Access** to `mcp` therefore also needs a repo copy of `ticket-writer` and `pr-finisher` in `.claude/agents/` that lists them.
- When the tool is not GitHub Issues, never create GitHub issues or Jira tickets. If a plan, brief or ticket names one, switch it to this tool. If an existing GitHub issue seems to need attention, do not act on it: the coordinator puts it on the Asks board, and any other agent reports it to its coordinator.
- A branch names its ticket as **In branch names** shows. A review finding filed as a ticket is recorded as `[filed <ticket ID>]`.
- When **Close from a PR** is `none`, the merge does not close the ticket. After the merge, close it with the Close command.

## When a skill says "publish to the issue tracker"

Create a ticket with the Create command.

## When a skill says "fetch the relevant ticket"

Run the View command.

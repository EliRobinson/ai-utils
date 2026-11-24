# asks-board

One page for everything your Claude chats need from you.

- Each chat adds an "ask" (do, decide or approve) to a claude.ai artifact board, one tab per project.
- You tick it, press an option, press "Not needed" or leave a note.
- The page sends a comment to Claude. One chat, the **Board Router**, watches the board and forwards the ping to the chat that asked, by session id. That wakes the chat even if it is closed.
- The chat acts, closes the row and replies in the thread. A row shows as Closed only when its status is `closed`. Each click clears the chat's old `ackAt`, so a new answer is never hidden.

To get a fixed board page, republish `board-template.html` as the `asks-board` skill's "Changing this skill or the board page" section says. Rows an older page left with an `ackAt` but not `closed` then show under "Done waiting for the chat"; the owning chat's next check-in closes them (see "A row needs you" in the `asks-board` skill). Rows of a chat that no longer checks in stay there for now.

## What is here

```
skills/asks-board/            daily rules: add asks, check in, coordinator and router rules
skills/asks-board-setup/      setup steps + board-template.html (the board page)
                              + scripts/check-board-page.mjs (tests the page's section and write logic)
```

Personal values never go in this repo. Each user keeps them in `~/.claude/asks-board.md`:

```
Board: https://claude.ai/artifact/<id>
Owner: <first name>
```

Project-to-chat routes live in the board's own `routes` collection.

## Set it up

```
/plugin marketplace add EliRobinson/ai-utils
```

```
/plugin install asks-board@ai-utils
```

Then ask Claude: "Set up my Asks board". The `asks-board-setup` skill publishes the page, writes the config file, seeds the routes and tests a ping.

To edit the skill from a clone instead, symlink it (do not also install the plugin):

```bash
ln -s <clone>/plugins/asks-board/skills/asks-board ~/.claude/skills/asks-board
```

## Change it

Edit the files here, run `python3 scripts/validate-plugins.py`, bump the version in `.claude-plugin/plugin.json` and in the marketplace entry, commit on a feature branch and open a PR (the review gate is in `AGENTS.md`; outside contributors see Contributing in the root README). To publish a new board page, fill in `{{OWNER}}` in a copy of `board-template.html` and publish it to your board link.

## Limits

- Pings reach only chats on the same computer.
- If the router chat is closed, pings stop. Answers stay on the board, and the router forwards them when it opens.
- Only one chat may watch the board.
